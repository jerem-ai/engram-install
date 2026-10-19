import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEngramEnv } from '../install-config.js';

/**
 * The provenance block engram_explain returns: which session a fact came from, the
 * quoted passages, the support check, and where the original log is now. One call
 * goes from a fact to its log instead of fact -> note -> frontmatter -> archive.
 *
 * Transcript lookup order: this machine's live transcript stores, then an install's
 * local archive (extraction/archive_local.py, engram.env ENGRAM_ARCHIVE_DIR), then
 * the NAS archive index written by extraction/archive-transcripts.sh, then an
 * explicit `log_missing` with a reason. The status is never blank.
 */

export type TranscriptStatus = 'local' | 'archive' | 'log_missing';

export interface TranscriptLocation {
  status: TranscriptStatus;
  /** Absolute path on this machine (status `local`). */
  path?: string;
  /** Archive copy (status `archive`): host and root of the archive, path under it, storage form. */
  archive?: { host: string; root: string; logicalPath: string; storage: string };
  /** Why the log could not be found (status `log_missing`). */
  reason?: string;
  /** When the archive index was written; absent when no index exists. */
  indexGeneratedAt?: string;
}

export interface Provenance {
  sourceSession: string | null;
  /** source_session without its runtime prefix, as transcript files are named. */
  sessionKey: string | null;
  runtime: string | null;
  /** Quoted passages for this assertion, or the note's passages when the assertion has none. */
  passages: string[];
  passagesScope: 'assertion' | 'note' | 'none';
  support: { verdict: string | null; check: string | null };
  transcript: TranscriptLocation;
}

export interface ProvenanceOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** `redacted` drops paths and archive locations, for remote read-only surfaces. */
  detail?: 'full' | 'redacted';
}

interface AssertionTriple { subject: string; predicate: string; object: string }

type Json = Record<string, unknown>;

const RUNTIME_PREFIX = /^(codex|claude|claude-code|hermes|openclaw):/;
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

export function transcriptIndexPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.ENGRAM_TRANSCRIPT_INDEX ?? join(home, '.local/share/engram/transcript-index.tsv');
}

/** An install's local archive index, or null when the archive is unset or off. */
export function localArchiveIndexPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const dir = env.ENGRAM_ARCHIVE_DIR ?? readEngramEnv(home).ENGRAM_ARCHIVE_DIR;
  return dir && dir !== 'off' ? join(dir, 'index.tsv') : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== 'null' ? trimmed : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

export function sessionKeyOf(sourceSession: string | null): { key: string | null; reason?: string } {
  if (!sourceSession) return { key: null, reason: 'source note records no source_session' };
  if (sourceSession.startsWith('openclaw:curated:')) {
    return { key: null, reason: 'source is a curated OpenClaw memory file, not a session transcript' };
  }
  const key = sourceSession.replace(RUNTIME_PREFIX, '');
  if (!SAFE_KEY.test(key)) return { key: null, reason: `source_session ${JSON.stringify(sourceSession)} is not a transcript id` };
  return { key };
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Live transcript on this machine, if the host has not expired it yet. */
export function findLocalTranscript(key: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const rollout = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(key);
  if (rollout) {
    const codexHome = env.CODEX_HOME ?? join(home, '.codex');
    for (const dir of [join(codexHome, 'sessions', rollout[1], rollout[2], rollout[3]), join(codexHome, 'archived_sessions')]) {
      const path = join(dir, `${key}.jsonl`);
      if (isFile(path)) return path;
    }
    return null;
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const roots = [join(claudeDir, 'projects')];
  const openclawAgents = join(home, '.openclaw/agents');
  try {
    for (const agent of readdirSync(openclawAgents)) roots.push(join(openclawAgents, agent, 'sessions'));
  } catch {}
  for (const root of roots) {
    if (isFile(join(root, `${key}.jsonl`))) return join(root, `${key}.jsonl`);
    let dirs: string[] = [];
    try { dirs = readdirSync(root); } catch { continue; }
    for (const dir of dirs) {
      const path = join(root, dir, `${key}.jsonl`);
      if (isFile(path)) return path;
    }
  }
  return null;
}

interface IndexHit { host: string; root: string; logicalPath: string; storage: string; generatedAt?: string }

/**
 * Archive index lookup. The file is the reader's `--inventory` output with a
 * `# engram.transcript-index.v1 dest=<host>:<root> generated=<iso>` header line.
 * Rows: archive_key, storage_kind, stored_bytes, mtime_epoch, logical_path.
 */
export function findArchivedTranscript(key: string, indexPath: string): { hit: IndexHit | null; generatedAt?: string; exists: boolean } {
  if (!existsSync(indexPath)) return { hit: null, exists: false };
  const text = readFileSync(indexPath, 'utf8');
  const header = /^# engram\.transcript-index\.v1 dest=([^:\s]+):(\S+) generated=(\S+)/m.exec(text);
  const generatedAt = header?.[3];
  const host = header?.[1] ?? 'unknown';
  const root = header?.[2] ?? 'unknown';
  const needle = `\n${key}\t`;
  let at = text.indexOf(needle);
  let best: IndexHit | null = null;
  let bestMtime = -1;
  while (at !== -1) {
    const end = text.indexOf('\n', at + 1);
    const cols = text.slice(at + 1, end === -1 ? undefined : end).split('\t');
    if (cols.length >= 5) {
      const mtime = Number(cols[3]);
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = { host, root, logicalPath: cols[4], storage: cols[1], generatedAt };
      }
    }
    at = text.indexOf(needle, at + 1);
  }
  return { hit: best, generatedAt, exists: true };
}

export function locateTranscript(key: string | null, keyReason: string | undefined, opts: ProvenanceOptions = {}): TranscriptLocation {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  if (!key) return { status: 'log_missing', reason: keyReason ?? 'no transcript id' };
  const local = findLocalTranscript(key, env, home);
  if (local) return { status: 'local', path: local };
  const localIndex = localArchiveIndexPath(env, home);
  if (localIndex) {
    const { hit, generatedAt } = findArchivedTranscript(key, localIndex);
    if (hit) {
      return { status: 'archive', archive: { host: hit.host, root: hit.root, logicalPath: hit.logicalPath, storage: hit.storage },
        ...(generatedAt ? { indexGeneratedAt: generatedAt } : {}) };
    }
  }
  const indexPath = transcriptIndexPath(env, home);
  const { hit, generatedAt, exists } = findArchivedTranscript(key, indexPath);
  if (hit) {
    return { status: 'archive', archive: { host: hit.host, root: hit.root, logicalPath: hit.logicalPath, storage: hit.storage },
      ...(generatedAt ? { indexGeneratedAt: generatedAt } : {}) };
  }
  return {
    status: 'log_missing',
    reason: exists
      ? `transcript ${key} is not on this machine and not in the archive index`
      : `transcript ${key} is not on this machine and no archive index exists at ${indexPath}`,
    ...(generatedAt ? { indexGeneratedAt: generatedAt } : {}),
  };
}

export function parseFrontmatter(raw: string | null | undefined): Json {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Json : {};
  } catch { return {}; }
}

export function buildProvenance(frontmatter: Json, assertion: AssertionTriple, opts: ProvenanceOptions = {}): Provenance {
  const metadata = (frontmatter.metadata && typeof frontmatter.metadata === 'object' ? frontmatter.metadata : {}) as Json;
  const sourceSession = str(metadata.source_session) ?? str(frontmatter.source_session)
    ?? str(frontmatter.session_id) ?? str(metadata.session_id);
  const runtime = str(metadata.runtime) ?? (sourceSession && RUNTIME_PREFIX.test(sourceSession)
    ? sourceSession.split(':')[0] : null);

  const match = (Array.isArray(metadata.assertions) ? metadata.assertions : [])
    .filter((a): a is Json => !!a && typeof a === 'object')
    .find(a => norm(a.subject) === norm(assertion.subject) && norm(a.predicate) === norm(assertion.predicate)
      && norm(a.object) === norm(assertion.object));
  const own = strings(match?.passages);
  const notePassages = strings(metadata.passages);
  const passages = own.length ? own : notePassages;
  const passagesScope = own.length ? 'assertion' : notePassages.length ? 'note' : 'none';

  const { key, reason } = sessionKeyOf(sourceSession);
  let transcript = locateTranscript(key, reason, opts);
  if (opts.detail === 'redacted') {
    transcript = { status: transcript.status, ...(transcript.status === 'log_missing' ? { reason: 'original log not found' } : {}) };
  }
  return {
    sourceSession,
    sessionKey: key,
    runtime,
    passages,
    passagesScope,
    support: { verdict: str(metadata.support), check: str(metadata.support_check) },
    transcript,
  };
}
