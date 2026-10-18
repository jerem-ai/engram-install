import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Kipp is the house's slow, large-model judge (jerem-ai/alfred
 * deploy/homelab/compute/kipp/ROUTING.md). Requests go over `ssh kipp` to its
 * local Ollama, one at a time. Before the first prompt a job must clear CI:
 * load the model (admission then drains kipp-ci), wait for admission to report
 * `draining` with `inference_active`, then wait until the Maestro host shows no
 * queued or running run on kipp-ci. A CI job overlapping decode cut it from 4.4
 * to 0.66 tok/s (BENCHMARKS.md e14). Missed deadlines log and carry on: the
 * job is only slower. This is a port of make_room() in
 * scripts/kipp_second_opinion.py.
 */
export const KIPP_ADMISSION = '/var/lib/maestro-ci-admission/admission.json';
export const KIPP_CI_NODE = 'kipp-ci';
const DRAIN_WAIT_S = 240;
const CI_WAIT_S = 2_700;

export interface KippChatRequest {
  model: string;
  system: string;
  user: string;
  format?: unknown;
  maxOutputTokens: number;
  timeoutS: number;
}

export interface KippChatReply {
  content: string;
  prompt_tokens: number | null;
  output_tokens: number | null;
  seconds: number;
}

export interface KippTransport {
  chat(request: KippChatRequest): KippChatReply;
  preload(model: string): void;
  admissionDraining(): boolean;
  ciRuns(): string[];
}

function ssh(host: string, command: string, opts: { input?: string; timeoutS: number }): string {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, command],
    { input: opts.input, encoding: 'utf8', timeout: opts.timeoutS * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`ssh ${host} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ssh ${host} failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout;
}

export function sshKippTransport(host = 'kipp', env: NodeJS.ProcessEnv = process.env): KippTransport {
  const node = env.ENGRAM_KIPP_NODE ?? join(homedir(), '.local/bin/node');
  const maestroCi = env.ENGRAM_KIPP_MAESTRO_CI ?? join(homedir(), '.maestro/current/scripts/maestro-ci.mjs');
  return {
    chat(req) {
      const body = {
        model: req.model, think: false, stream: false, keep_alive: '30m',
        options: { num_predict: req.maxOutputTokens, temperature: 0 },
        ...(req.format ? { format: req.format } : {}),
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      };
      const out = ssh(host, `curl -sS --fail-with-body --max-time ${req.timeoutS} http://127.0.0.1:11434/api/chat -d @-`,
        { input: JSON.stringify(body), timeoutS: req.timeoutS + 60 });
      const reply = JSON.parse(out) as { error?: string; message?: { content?: string };
        prompt_eval_count?: number; eval_count?: number; total_duration?: number };
      if (reply.error) throw new Error(`ollama error: ${reply.error}`);
      const content = (reply.message?.content ?? '').trim();
      if (!content) throw new Error('empty reply');
      return { content, prompt_tokens: reply.prompt_eval_count ?? null, output_tokens: reply.eval_count ?? null,
        seconds: Math.round((reply.total_duration ?? 0) / 1e9) };
    },
    preload(model) {
      ssh(host, 'curl -sS --fail-with-body --max-time 600 http://127.0.0.1:11434/api/generate -d @-',
        { input: JSON.stringify({ model, keep_alive: '60m' }), timeoutS: 660 });
    },
    admissionDraining() {
      const a = JSON.parse(ssh(host, `cat ${KIPP_ADMISSION}`, { timeoutS: 60 })) as { state?: string; reasons?: string[] };
      return a.state === 'draining' && (a.reasons ?? []).includes('inference_active');
    },
    ciRuns() {
      const r = spawnSync(node, [maestroCi, 'list'], { encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`maestro-ci list failed (${r.status})`);
      const runs = (JSON.parse(r.stdout) as { runs: Array<{ id: string; nodeId?: string; status?: string }> }).runs;
      return runs.filter(x => x.nodeId === KIPP_CI_NODE && (x.status === 'queued' || x.status === 'running')).map(x => x.id);
    },
  };
}

export interface Clock {
  now(): number;
  sleep(ms: number): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

function waitUntil(check: () => boolean, deadlineS: number, pollS: number, clock: Clock): boolean {
  const end = clock.now() + deadlineS * 1000;
  for (;;) {
    if (check()) return true;
    if (clock.now() >= end) return false;
    clock.sleep(pollS * 1000);
  }
}

/**
 * Load the model so kipp-ci takes no new work, then wait out CI already there.
 * True when Kipp is clear; false when a wait ran out or a probe failed (the
 * caller proceeds anyway, more slowly).
 */
export function makeRoom(t: KippTransport, model: string, log: (line: string) => void, clock: Clock = realClock): boolean {
  try {
    t.preload(model);
    if (!waitUntil(() => t.admissionDraining(), DRAIN_WAIT_S, 10, clock)) {
      log(`WARN admission did not drain ${KIPP_CI_NODE} within ${DRAIN_WAIT_S} s`);
      return false;
    }
    const seen = new Set<string>();
    let busy: string[] = [];
    const idle = () => {
      busy = t.ciRuns();
      const fresh = busy.filter(id => !seen.has(id));
      if (fresh.length) { log(`waiting for CI on ${KIPP_CI_NODE}: ${busy.join(', ')}`); fresh.forEach(id => seen.add(id)); }
      return busy.length === 0;
    };
    if (!waitUntil(idle, CI_WAIT_S, 30, clock)) {
      log(`WARN ${KIPP_CI_NODE} still busy after ${CI_WAIT_S} s (${busy.join(', ')}); judging anyway, slowly`);
      return false;
    }
    return true;
  } catch (error) {
    log(`WARN could not clear Kipp for inference: ${(error as Error).message}`);
    return false;
  }
}
