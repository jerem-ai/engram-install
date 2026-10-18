import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readEngramEnv, type EngramEnv } from '../lib/install-config.js';
import { runEngramHealthChecks, type IndexerStats } from '../lib/engram/health.js';

/**
 * `kg status`: one screen that says whether an install is working, in plain words,
 * with a fix line for every red item. It reads only local files, the kg.db (read
 * only), kg-http's /health and the CLI's own login status; it never calls a model.
 * Paths come from ~/.config/engram/engram.env (written by scripts/install-local.sh).
 */
export type Light = 'ok' | 'warn' | 'fail';
export interface StatusItem { id: string; status: Light; detail: string; fix?: string }
export interface StatusReport { status: Light; items: StatusItem[]; generatedAt: string }

const DAY = 86_400_000;

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function tailLines(path: string, bytes = 64 * 1024): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.slice(-bytes).split('\n').filter(Boolean);
}

export interface StatusOptions {
  home?: string;
  env?: EngramEnv;
  now?: Date;
  /** Injected for tests: run a CLI login check, return its exit code and stdout. */
  run?: (cmd: string, args: string[]) => { code: number; stdout: string };
  /** Injected for tests: GET a URL, return the HTTP status or null. */
  get?: (url: string) => Promise<number | null>;
}

const defaultRun = (cmd: string, args: string[]) => {
  // ENGRAM_CLI_HOME: the home whose CLI logins extraction uses, when it is not HOME.
  const cliHome = process.env.ENGRAM_CLI_HOME;
  const env = { ...process.env };
  if (cliHome) { delete env.CLAUDE_CONFIG_DIR; env.HOME = cliHome; env.CODEX_HOME = join(cliHome, '.codex'); }
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, env });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
};

const defaultGet = async (url: string) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try { return (await fetch(url, { signal: ctl.signal })).status; } catch { return null; } finally { clearTimeout(t); }
};

export async function engramStatusReport(opts: StatusOptions = {}): Promise<StatusReport> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? readEngramEnv(home);
  const now = opts.now ?? new Date();
  const run = opts.run ?? defaultRun;
  const get = opts.get ?? defaultGet;
  const engramHome = env.ENGRAM_HOME ?? join(home, 'Engram');
  const logs = join(engramHome, 'logs');
  const prefix = env.ENGRAM_LABEL_PREFIX ?? 'com.engram.local';
  const kick = (name: string) => `launchctl kickstart -k gui/$(id -u)/${prefix}.${name}`;
  const items: StatusItem[] = [];

  // 1. The extraction model: the user's own login.
  const driver = env.ENGRAM_CLI_DRIVER;
  if (env.ENGRAM_EXTRACT_BACKEND === 'cli' && (driver === 'claude' || driver === 'codex')) {
    const r = driver === 'claude' ? run('claude', ['auth', 'status']) : run('codex', ['login', 'status']);
    const ok = r.code === 0 && (driver === 'codex' || /"loggedIn":\s*true/.test(r.stdout));
    items.push(ok
      ? { id: 'backend', status: 'ok', detail: `extraction uses your ${driver} login` }
      : { id: 'backend', status: 'fail', detail: `${driver} is not logged in, so nothing new is learned`,
          fix: driver === 'claude' ? 'run `claude`, then type /login' : 'run `codex login`' });
  } else {
    items.push({ id: 'backend', status: 'warn', detail: `extraction backend is ${env.ENGRAM_EXTRACT_BACKEND ?? 'not set'}`,
      fix: 'rerun scripts/install-local.sh' });
  }

  // 2. Last extraction run.
  const marker = join(env.ENGRAM_STATE_DIR ?? join(home, '.local/share/memory-extraction'), 'last-success');
  const runLines = tailLines(join(logs, 'extraction.log'));
  const lastSummary = [...runLines].reverse().find(l => /^(\[dry-run\] )?sessions=\d+/.test(l));
  const lastFailure = [...runLines].reverse().find(l => /preflight failed|FATAL|ERROR: /.test(l));
  if (!existsSync(marker)) {
    items.push({ id: 'extraction', status: lastFailure ? 'fail' : 'warn',
      detail: lastFailure ? `extraction has not succeeded yet: ${lastFailure.slice(0, 160)}` : 'extraction has not run yet',
      fix: kick('extraction') });
  } else {
    const age = now.getTime() - statSync(marker).mtimeMs;
    const failedSince = lastFailure && runLines.lastIndexOf(lastFailure) > runLines.lastIndexOf(lastSummary ?? '');
    items.push({ id: 'extraction', status: failedSince || age > 26 * 3600_000 ? 'fail' : 'ok',
      detail: `last good run ${ago(age)}${lastSummary ? ` (${lastSummary.replace('[dry-run] ', '')})` : ''}`
        + (failedSince ? `; the latest run failed: ${lastFailure!.slice(0, 120)}` : ''),
      ...(failedSince || age > 26 * 3600_000 ? { fix: kick('extraction') } : {}) });
  }

  // 3. Memories written in the last 7 days.
  const root = env.ENGRAM_MEMORY_ROOT ?? join(home, '.claude/projects');
  let recent = 0, extracted = 0;
  if (existsSync(root)) {
    for (const proj of readdirSync(root)) {
      const dir = join(root, proj, 'memory');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        const text = readFileSync(join(dir, f), 'utf8');
        if (!/^\s+extractor_model: /m.test(text)) continue;
        extracted += 1;
        if (now.getTime() - statSync(join(dir, f)).mtimeMs < 7 * DAY) recent += 1;
      }
    }
  }
  items.push({ id: 'memories', status: recent > 0 || extracted > 0 ? 'ok' : 'warn',
    detail: `${recent} memories learned in the last 7 days (${extracted} in all)`,
    ...(extracted === 0 ? { fix: 'use Claude Code or Codex for a while; the hourly job learns from finished sessions' } : {}) });

  // 4. Mirror into the vault, and the index.
  const vault = env.KG_VAULT_PATH ?? join(home, 'claude-vault/vault');
  const mirrored = existsSync(join(vault, 'Memory'))
    ? readdirSync(join(vault, 'Memory'), { recursive: true }).filter(p => String(p).endsWith('.md')).length : 0;
  items.push({ id: 'mirror', status: extracted > 0 && mirrored === 0 ? 'fail' : 'ok',
    detail: `${mirrored} notes in ${join(vault, 'Memory')}`, ...(extracted > 0 && mirrored === 0 ? { fix: kick('mirror') } : {}) });

  const dataDir = env.KG_DATA_DIR ?? join(home, '.local/share/knowledge-graph');
  const dbPath = join(dataDir, 'kg.db');
  if (!existsSync(dbPath)) {
    items.push({ id: 'index', status: 'fail', detail: 'no index yet', fix: kick('index') });
  } else {
    const indexLog = join(logs, 'index.log');
    const stats = readIndexerStats(indexLog);
    const age = now.getTime() - statSync(dbPath).mtimeMs;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // The tenant views call current_tenant_id(); a read-only reader registers it from
      // the DB's own binding, read once (a query inside the function would deadlock).
      const tenant = (db.prepare('SELECT tenant_id FROM security_metadata').get() as { tenant_id: string } | undefined)?.tenant_id ?? '';
      db.function('current_tenant_id', () => tenant);
      const health = runEngramHealthChecks({ db, now, indexerStats: stats });
      const bad = health.checks.filter(c => c.status === 'fail');
      const nodes = (db.prepare("SELECT count(*) AS n FROM nodes WHERE id LIKE 'Memory/%'").get() as { n: number }).n;
      items.push({ id: 'index', status: bad.length ? 'fail' : age > 2 * 3600_000 ? 'warn' : 'ok',
        detail: `${nodes} memory notes indexed, last write ${ago(age)}` + (bad.length ? `; ${bad.map(c => c.detail).join('; ')}` : ''),
        ...(bad.length || age > 2 * 3600_000 ? { fix: kick('index') } : {}) });
    } finally {
      db.close();
    }
  }

  // 5. The resident search server the hooks use first.
  const base = (env.ENGRAM_HTTP_URL ?? 'http://127.0.0.1:3737').replace(/\/+$/, '');
  const code = await get(`${base}/health`);
  items.push(code === 200
    ? { id: 'kg_http', status: 'ok', detail: `search server answering at ${base}` }
    : { id: 'kg_http', status: 'warn', detail: `search server not answering at ${base}; recall falls back to a slower path`, fix: kick('kg-http') });

  // 6. The recall hooks.
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const codexDir = env.CODEX_HOME ?? join(home, '.codex');
  for (const [id, settings, receipts] of [
    ['hook_claude', join(claudeDir, 'settings.json'), join(claudeDir, 'logs/engram-recall-events.jsonl')],
    ['hook_codex', join(codexDir, 'hooks.json'), join(codexDir, 'logs/engram-recall-events.jsonl')],
  ] as const) {
    if (!existsSync(settings) || !readFileSync(settings, 'utf8').includes('engram-recall')) {
      if (existsSync(id === 'hook_claude' ? claudeDir : codexDir)) {
        items.push({ id, status: 'warn', detail: `${id === 'hook_claude' ? 'Claude Code' : 'Codex'} recall hook is not registered`,
          fix: 'rerun scripts/install-local.sh' });
      }
      continue;
    }
    const lines = tailLines(receipts, 256 * 1024);
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    const lastHit = [...lines].reverse().map(l => JSON.parse(l)).find(r => r.injected);
    items.push({ id, status: 'ok',
      detail: !last ? 'registered; no prompts seen yet'
        : `last prompt ${ago(now.getTime() - Date.parse(last.timestamp))}; last recall injected ${lastHit ? ago(now.getTime() - Date.parse(lastHit.timestamp)) : 'never yet'}` });
  }

  // 7. Alerts the jobs raised and have not resolved.
  const open = new Map<string, string>();
  for (const line of tailLines(join(logs, 'alerts.log'))) {
    const [when, kind, title, msg] = line.split('\t');
    if (kind === 'resolved') open.delete(title);
    else open.set(title, `${when}: ${title}${msg ? ` (${msg})` : ''}`);
  }
  if (open.size) items.push({ id: 'alerts', status: 'fail', detail: [...open.values()].join('; '), fix: `see ${logs}` });

  const status: Light = items.some(i => i.status === 'fail') ? 'fail' : items.some(i => i.status === 'warn') ? 'warn' : 'ok';
  return { status, items, generatedAt: now.toISOString() };
}

function readIndexerStats(path: string): IndexerStats | null {
  if (!existsSync(path)) return null;
  const blocks = [...readFileSync(path, 'utf8').matchAll(/"engram":\s*\{([^}]*)\}/g)];
  if (!blocks.length) return null;
  const fields = Object.fromEntries([...blocks[blocks.length - 1][1].matchAll(/"(\w+)":\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
  if (['episodes', 'assertions', 'candidates', 'skipped', 'assertionsSeen', 'rejected'].some(k => typeof fields[k] !== 'number')) return null;
  return fields as unknown as IndexerStats;
}

export function formatStatus(report: StatusReport): string {
  const mark: Record<Light, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FIX ' };
  const lines = [`Engram: ${report.status === 'ok' ? 'all green' : report.status === 'warn' ? 'working, with notes' : 'needs attention'}`];
  for (const i of report.items) {
    lines.push(`${mark[i.status]}  ${i.id.padEnd(11)} ${i.detail}`);
    if (i.fix && i.status !== 'ok') lines.push(`      ${''.padEnd(11)} fix: ${i.fix}`);
  }
  return lines.join('\n');
}
