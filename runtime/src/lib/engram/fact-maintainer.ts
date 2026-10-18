import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { SELF_ADMISSION_POLICY_VERSION, SELF_ADMISSION_REASON } from './admission.js';

/**
 * The fact maintainer keeps the self-admitted assertion layer honest without a
 * human queue (Jeremy, 2026-10-04). Every change it makes is a status change
 * on an existing row, never a delete, and every run that changes anything
 * leaves a body-free receipt that `revertMaintenanceRun` undoes.
 *
 * Deterministic rules (kg-index, every run):
 * - source-follow: a current self-admitted fact whose memory file no longer
 *   states it, or is gone, becomes historical (valid_to = now). If the file
 *   states it again later, the same rule restores it.
 * - retire stale candidates: a quarantined extracted claim whose memory file
 *   already has the same claim admitted (an "admitted twin"), or no longer
 *   states it at all, is retired as rejected with the triple kept for revert.
 *
 * The Kipp judge (fact-judge.ts) writes `judge_supersede` actions through the
 * same receipts and revert.
 */
export const FACT_MAINTAINER_POLICY_VERSION = 'engram-fact-maintainer-v1';
export const MAINTENANCE_RECEIPT_SCHEMA = 'engram.fact-maintainer.receipt.v1';
export const RETIRED_TWIN = 'retired_admitted_twin';
export const RETIRED_DROPPED = 'retired_source_dropped';

export function factMaintainerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGRAM_FACT_MAINTAINER_DIR ?? join(homedir(), '.local/share/engram/fact-maintainer');
}

export interface AssertionState {
  status: string;
  valid_to: string | null;
  superseded_by: string | null;
  updated_at: string;
}

export interface CandidateState {
  trust_state: string;
  review_reason: string | null;
  reviewed_at: string | null;
  reviewed_by_principal_id: string | null;
  updated_at: string;
}

export type MaintenanceAction =
  | { kind: 'source_follow'; assertion_id: string; reason: 'source_gone' | 'claim_dropped';
      candidate_ids: string[]; prior: AssertionState; after: AssertionState }
  | { kind: 'source_restore'; assertion_id: string; candidate_ids: string[]; prior: AssertionState; after: AssertionState }
  | { kind: 'retire_candidate'; candidate_id: string; reason: typeof RETIRED_TWIN | typeof RETIRED_DROPPED;
      twin_id: string | null; prior: CandidateState; after: CandidateState }
  | { kind: 'judge_supersede'; assertion_id: string; winner_id: string; verdict: 'conflict' | 'duplicate';
      group: string; prior: AssertionState; after: AssertionState };

export interface MaintenanceReceipt {
  schema: typeof MAINTENANCE_RECEIPT_SCHEMA;
  run_id: string;
  kind: 'deterministic' | 'judge';
  policy_version: string;
  started_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
  actions: MaintenanceAction[];
  /** Body-free run detail (the judge records model, timings and per-group verdicts here). */
  meta?: Record<string, unknown>;
}

type Triple = { subject: string; predicate: string; object: string };
type SourceKind = 'extracted' | 'note';
type Support = 'present' | 'dropped' | 'gone';

/** Does the source still state this exact claim? Same trimmed comparison admission uses. */
export function sourceSupport(db: Database.Database, nodeId: string, kind: SourceKind, t: Triple): Support {
  const node = db.prepare('SELECT frontmatter FROM nodes WHERE id = ?').get(nodeId) as { frontmatter: string } | undefined;
  if (!node) return 'gone';
  let fm: Record<string, unknown>;
  try { fm = JSON.parse(node.frontmatter); } catch { return 'dropped'; }
  const blocks = kind === 'extracted'
    ? (fm.metadata as Record<string, unknown> | undefined)?.assertions
    : fm.assertions;
  const claims = Array.isArray(blocks) ? blocks : [];
  const stated = claims.some((a: Record<string, unknown>) => a
    && typeof a.subject === 'string' && a.subject.trim() === t.subject
    && typeof a.predicate === 'string' && a.predicate.trim() === t.predicate
    && typeof a.object === 'string' && a.object.trim() === t.object
    && !(typeof a.valid_to === 'string' && a.valid_to.trim()));
  return stated ? 'present' : 'dropped';
}

interface SupportRow {
  id: string; subject: string; predicate: string; object: string; status: string; valid_from: string | null;
  valid_to: string | null; superseded_by: string | null; updated_at: string; source_node_id: string | null;
  cid: string; csrc: string | null; chash: string; creason: string | null; note: string | null;
}

/** Self-admitted assertions with every promoted candidate that supports them. */
function supportedAssertions(db: Database.Database, statuses: string[]): Map<string, SupportRow[]> {
  const rows = db.prepare(`
    SELECT a.id, a.subject, a.predicate, a.object, a.status, a.valid_from, a.valid_to, a.superseded_by,
           a.updated_at, a.source_node_id,
           c.id AS cid, c.source_node_id AS csrc, c.source_hash AS chash, c.review_reason AS creason,
           s.source_node_id AS note
    FROM engram_assertions a
    JOIN records_engram_memory_candidates c
      ON c.tenant_id = a.tenant_id AND c.assertion_id = a.id AND c.trust_state = 'promoted'
    LEFT JOIN records_engram_memory_sources s
      ON s.tenant_id = c.tenant_id AND s.candidate_id = c.id AND s.policy_version = ?
    WHERE a.owner_principal_id = current_principal_id()
      AND c.owner_principal_id = current_principal_id()
      AND a.status IN (${statuses.map(() => '?').join(',')})
  `).all(SELF_ADMISSION_POLICY_VERSION, ...statuses) as SupportRow[];
  const out = new Map<string, SupportRow[]>();
  for (const r of rows) (out.get(r.id) ?? out.set(r.id, []).get(r.id)!).push(r);
  return out;
}

/** The source each candidate binds to: its own memory file in place, or its reviewed note. */
function candidateSource(r: SupportRow): { node: string; kind: SourceKind } | null {
  if (r.note) return { node: r.note, kind: 'note' };
  if (r.chash.startsWith('extracted-v1:') && r.csrc) return { node: r.csrc, kind: 'extracted' };
  return null;
}

/**
 * Overall support for one assertion, or null when the rule must leave it
 * alone: a human-reviewed candidate backs it, or the row is owned by a source
 * no self-admitted candidate binds (a legacy row the claim coalesced into).
 */
function assertionSupport(db: Database.Database, rows: SupportRow[]): Support | null {
  if (rows.some(r => r.creason !== SELF_ADMISSION_REASON)) return null;
  const sources = rows.map(candidateSource);
  if (sources.some(s => s === null)) return null;
  const owner = rows[0].source_node_id;
  if (!sources.some(s => s!.node === owner)) return null;
  const seen = new Set<string>();
  let gone = true;
  for (const s of sources as Array<{ node: string; kind: SourceKind }>) {
    if (seen.has(`${s.kind}\u001f${s.node}`)) continue;
    seen.add(`${s.kind}\u001f${s.node}`);
    const support = sourceSupport(db, s.node, s.kind, rows[0]);
    if (support === 'present') return 'present';
    if (support === 'dropped') gone = false;
  }
  return gone ? 'gone' : 'dropped';
}

function stateOf(r: { status: string; valid_to: string | null; superseded_by: string | null; updated_at: string }): AssertionState {
  return { status: r.status, valid_to: r.valid_to, superseded_by: r.superseded_by, updated_at: r.updated_at };
}

/** valid_to = now, but never before the fact started. */
function endAt(now: string, validFrom: string | null): string {
  return validFrom && validFrom > now ? validFrom : now;
}

/**
 * Plan source-follow. `retired` maps assertion ids this rule retired in an
 * unreverted run to the state it left them in; only those are restored.
 */
export function planSourceFollow(db: Database.Database, now: string, retired: Map<string, AssertionState>): MaintenanceAction[] {
  const actions: MaintenanceAction[] = [];
  for (const [id, rows] of supportedAssertions(db, ['current'])) {
    const support = assertionSupport(db, rows);
    if (support === null || support === 'present') continue;
    const prior = stateOf(rows[0]);
    actions.push({
      kind: 'source_follow', assertion_id: id, reason: support === 'gone' ? 'source_gone' : 'claim_dropped',
      candidate_ids: rows.map(r => r.cid).sort(), prior,
      after: { status: 'historical', valid_to: endAt(now, rows[0].valid_from), superseded_by: prior.superseded_by, updated_at: now },
    });
  }
  if (retired.size) {
    for (const [id, rows] of supportedAssertions(db, ['historical'])) {
      const left = retired.get(id);
      const prior = stateOf(rows[0]);
      // Re-indexing the file touches updated_at on the retired row; status and end must still be ours.
      if (!left || left.status !== prior.status || left.valid_to !== prior.valid_to || left.superseded_by !== prior.superseded_by) continue;
      if (assertionSupport(db, rows) !== 'present') continue;
      // Another source may hold this claim as current now; one current row per triple.
      const taken = db.prepare(`SELECT 1 FROM engram_assertions WHERE owner_principal_id = current_principal_id()
        AND subject = ? AND predicate = ? AND object = ? AND status = 'current' AND id != ?`)
        .get(rows[0].subject, rows[0].predicate, rows[0].object, id);
      if (taken) continue;
      actions.push({ kind: 'source_restore', assertion_id: id, candidate_ids: rows.map(r => r.cid).sort(), prior,
        after: { status: 'current', valid_to: null, superseded_by: prior.superseded_by, updated_at: now } });
    }
  }
  return actions;
}

/** Plan retirement of quarantined extracted claims that can never be admitted. */
export function planCandidateRetirement(db: Database.Database, now: string): MaintenanceAction[] {
  const principal = (db.prepare('SELECT current_principal_id() AS p').get() as { p: string }).p;
  const rows = db.prepare(`
    SELECT q.id, q.subject, q.predicate, q.object, q.source_node_id, q.trust_state, q.review_reason,
           q.reviewed_at, q.reviewed_by_principal_id, q.updated_at,
           (SELECT t.id FROM records_engram_memory_candidates t
             WHERE t.tenant_id = q.tenant_id AND t.owner_principal_id = q.owner_principal_id
               AND t.trust_state = 'promoted' AND t.source_node_id = q.source_node_id
               AND t.subject = q.subject AND t.predicate = q.predicate AND t.object = q.object
             ORDER BY t.id LIMIT 1) AS twin_id
    FROM records_engram_memory_candidates q
    WHERE q.tenant_id = current_tenant_id() AND q.owner_principal_id = current_principal_id()
      AND q.trust_state = 'quarantined' AND q.origin = 'model_derived'
      AND q.source_hash LIKE 'extracted-v1:%' AND q.source_node_id IS NOT NULL
      AND q.subject IS NOT NULL AND q.predicate IS NOT NULL AND q.object IS NOT NULL
    ORDER BY q.id
  `).all() as Array<CandidateState & Triple & { id: string; source_node_id: string; twin_id: string | null }>;
  const actions: MaintenanceAction[] = [];
  for (const r of rows) {
    let reason: typeof RETIRED_TWIN | typeof RETIRED_DROPPED;
    if (r.twin_id) reason = RETIRED_TWIN;
    else if (sourceSupport(db, r.source_node_id, 'extracted', r) !== 'present') reason = RETIRED_DROPPED;
    else continue;
    const prior: CandidateState = { trust_state: r.trust_state, review_reason: r.review_reason, reviewed_at: r.reviewed_at,
      reviewed_by_principal_id: r.reviewed_by_principal_id, updated_at: r.updated_at };
    actions.push({ kind: 'retire_candidate', candidate_id: r.id, reason, twin_id: r.twin_id, prior,
      after: { trust_state: 'rejected', review_reason: reason, reviewed_at: now, reviewed_by_principal_id: principal, updated_at: now } });
  }
  return actions;
}

/** Compare-and-set one assertion. False when the row moved on since the action was planned. */
function casAssertion(db: Database.Database, id: string, from: AssertionState, to: AssertionState): boolean {
  try {
    return db.prepare(`
      UPDATE records_engram_assertions SET status = ?, valid_to = ?, superseded_by = ?, updated_at = ?
      WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id() AND id = ?
        AND status = ? AND valid_to IS ? AND superseded_by IS ? AND updated_at = ?
    `).run(to.status, to.valid_to, to.superseded_by, to.updated_at, id,
      from.status, from.valid_to, from.superseded_by, from.updated_at).changes === 1;
  } catch (error) {
    // Restoring a current row whose triple is current elsewhere trips the one-current-row index.
    if (String(error).includes('UNIQUE')) return false;
    throw error;
  }
}

function casCandidate(db: Database.Database, id: string, from: CandidateState, to: CandidateState): boolean {
  return db.prepare(`
    UPDATE records_engram_memory_candidates
    SET trust_state = ?, review_reason = ?, reviewed_at = ?, reviewed_by_principal_id = ?, updated_at = ?
    WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id() AND id = ?
      AND trust_state = ? AND review_reason IS ? AND reviewed_at IS ? AND reviewed_by_principal_id IS ? AND updated_at = ?
  `).run(to.trust_state, to.review_reason, to.reviewed_at, to.reviewed_by_principal_id, to.updated_at, id,
    from.trust_state, from.review_reason, from.reviewed_at, from.reviewed_by_principal_id, from.updated_at).changes === 1;
}

/** Apply one planned action forward (or, with `reverse`, back). False when the row moved on. */
export function applyAction(db: Database.Database, a: MaintenanceAction, reverse = false): boolean {
  if (a.kind === 'retire_candidate') {
    return reverse ? casCandidate(db, a.candidate_id, a.after, a.prior) : casCandidate(db, a.candidate_id, a.prior, a.after);
  }
  if (a.kind === 'judge_supersede' && !reverse) {
    const winner = db.prepare(`SELECT status FROM engram_assertions WHERE owner_principal_id = current_principal_id() AND id = ?`)
      .get(a.winner_id) as { status: string } | undefined;
    if (winner?.status !== 'current') return false;
  }
  return reverse ? casAssertion(db, a.assertion_id, a.after, a.prior) : casAssertion(db, a.assertion_id, a.prior, a.after);
}

export function countActions(actions: MaintenanceAction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of actions) {
    const key = a.kind === 'source_follow' ? `source_follow.${a.reason}`
      : a.kind === 'retire_candidate' ? `retire_candidate.${a.reason}`
      : a.kind === 'judge_supersede' ? `judge_supersede.${a.verdict}` : a.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function runId(kind: 'det' | 'judge', at: string): string {
  return `${kind}-${at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

function receiptsDir(dir: string): string {
  return join(dir, 'receipts');
}

/** Atomic owner-only write. */
export function writeJsonFile(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeReceipt(dir: string, receipt: MaintenanceReceipt): string {
  mkdirSync(receiptsDir(dir), { recursive: true, mode: 0o700 });
  const path = join(receiptsDir(dir), `${receipt.run_id}.json`);
  writeJsonFile(path, receipt);
  return path;
}

export function readReceipt(dir: string, id: string): MaintenanceReceipt {
  if (!/^(det|judge)-[0-9TZ]+$/.test(id)) throw new Error('Run id is invalid');
  return JSON.parse(readFileSync(join(receiptsDir(dir), `${id}.json`), 'utf8')) as MaintenanceReceipt;
}

export function isReverted(dir: string, id: string): boolean {
  return existsSync(join(receiptsDir(dir), `${id}.reverted.json`));
}

/** Every unreverted receipt, oldest first. */
export function listReceipts(dir: string): MaintenanceReceipt[] {
  if (!existsSync(receiptsDir(dir))) return [];
  return readdirSync(receiptsDir(dir))
    .filter(f => /^(det|judge)-[0-9TZ]+\.json$/.test(f))
    .map(f => f.replace(/\.json$/, ''))
    .filter(id => !isReverted(dir, id))
    .sort((a, b) => a.replace(/^\w+-/, '').localeCompare(b.replace(/^\w+-/, '')))
    .map(id => readReceipt(dir, id));
}

/** Assertions source-follow retired and nothing has restored or reverted since, with the state it left. */
export function retiredBySourceFollow(dir: string): Map<string, AssertionState> {
  const out = new Map<string, AssertionState>();
  for (const r of listReceipts(dir)) {
    for (const a of r.actions) {
      if (a.kind === 'source_follow') out.set(a.assertion_id, a.after);
      else if (a.kind === 'source_restore') out.delete(a.assertion_id);
    }
  }
  return out;
}

export interface DeterministicRunResult {
  run_id: string;
  dry_run: boolean;
  counts: Record<string, number>;
  applied: number;
  skipped: number;
  receipt: string | null;
}

/**
 * One deterministic pass. Planning reads; applying runs in one transaction,
 * and the receipt is written inside it, so a failed write rolls the run back.
 */
export function runDeterministicMaintenance(
  db: Database.Database,
  opts: { dir?: string; now?: string; dryRun?: boolean } = {},
): DeterministicRunResult {
  const dir = opts.dir ?? factMaintainerDir();
  const now = opts.now ?? new Date().toISOString();
  const id = runId('det', now);
  const planned = [...planSourceFollow(db, now, retiredBySourceFollow(dir)), ...planCandidateRetirement(db, now)];
  if (opts.dryRun) return { run_id: id, dry_run: true, counts: countActions(planned), applied: 0, skipped: 0, receipt: null };
  const result = db.transaction(() => {
    const applied = planned.filter(a => applyAction(db, a));
    const counts = countActions(applied);
    let receipt: string | null = null;
    if (applied.length) {
      receipt = writeReceipt(dir, { schema: MAINTENANCE_RECEIPT_SCHEMA, run_id: id, kind: 'deterministic',
        policy_version: FACT_MAINTAINER_POLICY_VERSION, started_at: now, finished_at: new Date().toISOString(),
        counts, actions: applied });
    }
    return { run_id: id, dry_run: false, counts, applied: applied.length, skipped: planned.length - applied.length, receipt };
  })();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ run_id: id, at: now, kind: 'deterministic',
    applied: result.applied, skipped: result.skipped, counts: result.counts }) + '\n', { mode: 0o600 });
  return result;
}

/** Undo one run. Rows that moved on since the run are left alone and counted as skipped. */
export function revertMaintenanceRun(db: Database.Database, dir: string, id: string): { run_id: string; reverted: number; skipped: number } {
  if (isReverted(dir, id)) throw new Error(`Run ${id} is already reverted`);
  const receipt = readReceipt(dir, id);
  const result = db.transaction(() => {
    let reverted = 0;
    for (const a of [...receipt.actions].reverse()) if (applyAction(db, a, true)) reverted += 1;
    const out = { run_id: id, reverted, skipped: receipt.actions.length - reverted };
    writeJsonFile(join(receiptsDir(dir), `${id}.reverted.json`), { ...out, reverted_at: new Date().toISOString() });
    return out;
  })();
  return result;
}

/** Judge runs started on one UTC date, so one command reverts a night. */
export function judgeRunsOn(dir: string, date: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD');
  return listReceipts(dir).filter(r => r.kind === 'judge' && r.started_at.startsWith(date)).map(r => r.run_id);
}
