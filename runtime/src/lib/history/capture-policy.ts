import Database from 'better-sqlite3';
import { basename, isAbsolute, resolve } from 'node:path';
import { captureArtifactAllowed, captureDecision, capturePathAllowed, captureSourceValid,
  canonicalCapturePath, readCapturePolicy, validCapturePath, type CaptureSource } from '../capture-policy.js';
import { readCaptureIdentityConfig } from '../capture-context.js';
import { observeRepository, resolveProjectIdentity, type ProjectIdentity } from '../project-identity.js';
import type { HistorySource } from './index.js';

export class HistoryCaptureBlocked extends Error {
  constructor() { super('capture_policy_deferred'); }
}
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'read_file', 'write_file', 'edit_file']);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const namespace = (provider: string): string => provider === 'claude' ? 'claude-code' : provider;

/** An archive inventory has no native cwd or revision binding. Do not fetch its body to find out. */
export function requireUnboundHistoryAllowed(paths: string[] = []): void {
  const snapshot = readCapturePolicy();
  if (!captureDecision(snapshot, null).allowed || paths.some(path => !capturePathAllowed(snapshot, path))) {
    throw new HistoryCaptureBlocked();
  }
}

export function preflightHistorySource(source: HistorySource, dbPath: string): void {
  const snapshot = readCapturePolicy();
  const paths = [source.path, dbPath];
  if (source.receiptPath && isAbsolute(source.receiptPath)) paths.push(source.receiptPath);
  const prefix = namespace(source.provider) + ':';
  const ids = [prefix + basename(source.path, '.jsonl')];
  if (source.expectedSessionId) ids.push(prefix + source.expectedSessionId);
  if (snapshot.state === 'invalid' || paths.some(path => !capturePathAllowed(snapshot, path))
    || ids.some(id => snapshot.policy?.exclude_sources.includes(id))) throw new HistoryCaptureBlocked();
  if (source.sourceKind === 'nas_archive') requireUnboundHistoryAllowed(paths);
}

/** First-pass metadata only. Message projection begins after all dependencies pass. */
export class HistoryCaptureCollector {
  private paths = new Set<string>();
  private ids = new Set<string>();
  private nativeIds = new Set<string>();
  private identities = new Map<string, ProjectIdentity>();
  private config = readCaptureIdentityConfig();
  private cwd: string | undefined;
  private complete = true;

  constructor(private source: HistorySource, dbPath: string) {
    preflightHistorySource(source, dbPath);
    this.addPath(source.path); this.addPath(dbPath);
    if (source.receiptPath && isAbsolute(source.receiptPath)) this.addPath(source.receiptPath);
    this.addId(basename(source.path, '.jsonl'));
  }

  private addPath(path: string): void {
    if (!validCapturePath(path)) { this.complete = false; return; }
    this.paths.add(canonicalCapturePath(path));
    if (this.paths.size > 4096) throw new HistoryCaptureBlocked();
  }

  private addId(id: string): void {
    this.ids.add(namespace(this.source.provider) + ':' + id);
    if (this.ids.size > 32) throw new HistoryCaptureBlocked();
  }

  visit(row: Record<string, unknown>): void {
    const payload = object(row.payload);
    let cwd = row.cwd ?? row.workspaceDir;
    if (row.type === 'session_meta' || row.type === 'turn_context') cwd = payload?.cwd ?? cwd;
    if (typeof cwd === 'string') {
      this.addPath(cwd);
      if (validCapturePath(cwd)) {
        this.cwd = canonicalCapturePath(cwd);
        if (!this.identities.has(this.cwd)) {
          if (this.identities.size >= 32) throw new HistoryCaptureBlocked();
          this.identities.set(this.cwd, resolveProjectIdentity(observeRepository(this.cwd), this.config));
        }
      }
    }
    if (this.source.provider === 'codex' && row.type === 'session_meta') {
      const id = payload?.id ?? payload?.session_id;
      if (typeof id === 'string' && id) {
        this.nativeIds.add(id);
        if (this.nativeIds.size > 1) throw new HistoryCaptureBlocked();
        this.addId(id);
      }
    }
    if (this.source.provider === 'claude') {
      if (typeof row.sessionId === 'string' && row.sessionId) this.addId(row.sessionId);
      if (row.isSidechain === true && typeof row.agentId === 'string' && row.agentId) this.addId(row.agentId);
    }
    const content = object(row.message)?.content;
    const blocks = Array.isArray(content) ? [...content] : [];
    if (row.type === 'response_item' && payload) blocks.push(payload);
    for (const value of blocks) {
      const block = object(value);
      if (!block || typeof block.name !== 'string') continue;
      let args = block.input ?? block.arguments;
      if (FILE_TOOLS.has(block.name) && typeof args === 'string') {
        try { args = JSON.parse(args); } catch { this.complete = false; continue; }
      }
      let values: string[] = [];
      const fields = object(args);
      if (FILE_TOOLS.has(block.name) && fields) {
        values = ['file_path', 'path', 'notebook_path'].flatMap(key => typeof fields[key] === 'string' ? [fields[key] as string] : []);
      } else if (block.name === 'apply_patch' && typeof args === 'string') {
        values = [...args.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]);
      }
      for (const path of values) {
        if (isAbsolute(path)) this.addPath(path);
        else if (this.cwd) this.addPath(resolve(this.cwd, path));
        else this.complete = false;
      }
    }
    // No source content reaches a projection, ledger or warning on denial.
    const snapshot = readCapturePolicy();
    if (this.ids.size && this.identities.size) this.requireAllowed('0'.repeat(64));
    else if (snapshot.state === 'invalid' || [...this.ids].some(id => snapshot.policy?.exclude_sources.includes(id))
      || [...this.paths].some(path => !capturePathAllowed(snapshot, path))) throw new HistoryCaptureBlocked();
  }

  bindings(revision: string): CaptureSource[] {
    const identities = [...this.identities.values()];
    const identity = identities[0];
    const complete = this.complete && identities.length > 0 && this.source.sourceKind !== 'nas_archive'
      && identities.every(item => item.status === 'verified' && item.project_id === identity.project_id
        && item.worktree_id === identity.worktree_id);
    return [...this.ids].sort().map(source_id => ({ source_id, revision,
      project_id: identity?.project_id ?? null, worktree_id: identity?.worktree_id ?? null,
      identity_fingerprint: identity?.config_fingerprint,
      paths: [...this.paths].sort(), complete }));
  }

  requireAllowed(revision: string): CaptureSource[] {
    const sources = this.bindings(revision);
    requireHistoryBindingsAllowed(sources);
    return sources;
  }
}

export function requireHistoryBindingsAllowed(sources: CaptureSource[], artifact?: unknown): void {
  const snapshot = readCapturePolicy();
  if (!sources.length || !sources.every(captureSourceValid)
    || !captureArtifactAllowed(snapshot, artifact ?? { capture_sources: sources })) throw new HistoryCaptureBlocked();
}

export function readHistoryBinding(db: Database.Database, id: string): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT value FROM main.history_meta WHERE key = ?").get('capture_binding:' + id) as { value: string } | undefined;
  try { return row ? object(JSON.parse(row.value)) : undefined; } catch { return undefined; }
}

/** Existing history_meta carries provenance; no schema or source-ID migration. */
export function writeHistoryBinding(db: Database.Database, id: string, sources: CaptureSource[], existed: boolean): void {
  const old = readHistoryBinding(db, id);
  const previous = old?.capture_sources;
  const known = Array.isArray(previous) && previous.length > 0 && previous.every(captureSourceValid);
  let incomplete = (existed && !known) || old?.capture_incomplete === true || sources.some(source => !source.complete);
  const union = new Map<string, CaptureSource>();
  for (const source of [...(known ? previous : []), ...sources]) union.set(JSON.stringify(source), source);
  if (union.size > 1024 || Buffer.byteLength(JSON.stringify([...union.values()])) > 1024 * 1024) {
    union.clear(); incomplete = true;
  }
  const binding = { capture_sources: [...union.values()], capture_incomplete: incomplete,
    capture_policy: readCapturePolicy().fingerprint };
  requireHistoryBindingsAllowed(sources, binding);
  db.prepare('INSERT OR REPLACE INTO main.history_meta (key,value) VALUES (?,?)')
    .run('capture_binding:' + id, JSON.stringify(binding));
}

/** Connection-local filters apply to old databases and to already-prepared queries. */
export function installHistoryCaptureViews(db: Database.Database): void {
  const path = db.name;
  db.function('history_capture_policy', { deterministic: true }, () => {
    const snapshot = readCapturePolicy();
    return JSON.stringify(capturePathAllowed(snapshot, path) ? snapshot : { state: 'invalid' });
  });
  db.function('history_capture_allowed', { deterministic: true }, (encoded: unknown, raw: unknown) => {
    try { return captureArtifactAllowed(JSON.parse(String(encoded)), raw === null ? undefined : JSON.parse(String(raw))) ? 1 : 0; }
    catch { return 0; }
  });
  const exists = (name: string): boolean => !!db.prepare('SELECT 1 FROM main.sqlite_master WHERE name=?').get(name);
  if (!exists('history_meta') || !exists('history_transcripts')) {
    for (const name of ['history_transcripts', 'history_events', 'history_captures', 'history_source_ledger', 'history_tombstones', 'history_runs']) {
      if (exists(name)) db.exec(`CREATE TEMP VIEW ${name} AS SELECT * FROM main.${name}
        WHERE history_capture_allowed(history_capture_policy(), NULL) = 1`);
    }
    return;
  }
  db.exec(`
    CREATE TEMP VIEW history_transcripts AS SELECT t.* FROM main.history_transcripts t
      LEFT JOIN main.history_meta m ON m.key = 'capture_binding:' || t.transcript_id
      WHERE history_capture_allowed(history_capture_policy(), m.value) = 1;
    CREATE TEMP VIEW history_events AS SELECT * FROM main.history_events
      WHERE transcript_id IN (SELECT transcript_id FROM temp.history_transcripts);
    CREATE TEMP VIEW history_captures AS SELECT * FROM main.history_captures
      WHERE history_capture_allowed(history_capture_policy(), NULL) = 1
        OR transcript_id IN (SELECT transcript_id FROM temp.history_transcripts);
    CREATE TEMP VIEW history_source_ledger AS SELECT l.* FROM main.history_source_ledger l
      WHERE history_capture_allowed(history_capture_policy(), NULL) = 1
        OR EXISTS (SELECT 1 FROM temp.history_captures c WHERE c.source_path = l.source_path);
    CREATE TEMP VIEW history_tombstones AS SELECT * FROM main.history_tombstones
      WHERE history_capture_allowed(history_capture_policy(), NULL) = 1
        OR transcript_id IN (SELECT transcript_id FROM temp.history_transcripts);
    CREATE TEMP VIEW history_runs AS SELECT * FROM main.history_runs
      WHERE history_capture_allowed(history_capture_policy(), NULL) = 1;
  `);
}

export function openHistoryReadDb(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { installHistoryCaptureViews(db); return db; } catch (error) { db.close(); throw error; }
}
