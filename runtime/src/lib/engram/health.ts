import type Database from 'better-sqlite3';

/**
 * Data-level health checks for Engram.
 *
 * These exist because the existing alerting is exit-code based, and the failure
 * that ran from 2026-08-01 to 2026-08-21 was success-shaped: kg-index exited 0
 * on every one of 925 runs while discarding 5,160 admission candidates. A check
 * that only asks "did the process fail" cannot see that. Every check here asserts
 * on the contents of the database or on what the indexer said it did.
 *
 * As of 2026-08-24, `deriveEngram` no longer submits `fm.relations` to the
 * admission queue (relations are graph topology, already materialized as edges
 * via parseVault; the queue is for memory claims per ENGRAM.md:369). That drives
 * `candidates` to 0 on almost every run, so `admissionQueueFlowing` keys on
 * `assertionsSeen` (well-formed `fm.assertions` entries) rather than on `skipped`.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface EngramCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  value?: number | string | null;
}

export interface IndexerStats {
  episodes: number;
  assertions: number;
  candidates: number;
  skipped: number;
  /** Well-formed fm.assertions entries encountered. Drives admissionQueueFlowing. */
  assertionsSeen: number;
  /** Candidates the admission service explicitly rejected (rejection is admission working). */
  rejected: number;
}

export interface EngramHealthState {
  nullValidFrom: number;
  nodes: number;
  assertions: number;
  candidates: number;
}

/** What engram-history-refresh wrote to its status file (schema engram-history-refresh-status.v1). */
export interface HistoryRefreshStatus {
  result: 'ok' | 'failed';
  ended_at: string;
  last_success_at: string | null;
  deferred_sources: number;
  stage?: string | null;
  error?: string | null;
}

/**
 * Present only where the nightly history refresh runs (the mini sets
 * ENGRAM_HISTORY_REFRESH_STATUS). `status` is null when the file is missing and
 * `error` is set when it cannot be read.
 */
export interface HistoryRefreshInput {
  path: string;
  status: HistoryRefreshStatus | null;
  error?: string;
}

export interface EngramHealthInput {
  db: Database.Database;
  now: Date;
  previous?: EngramHealthState | null;
  indexerStats?: IndexerStats | null;
  historyRefresh?: HistoryRefreshInput | null;
  recallUsage?: { source: string; alarm: string; alarm_day?: string; review_queue_size?: number }[];
  driftReview?: unknown;
}

export interface EngramHealthResult {
  status: CheckStatus;
  checks: EngramCheck[];
  state: EngramHealthState;
  generatedAt: string;
}

const NODE_COLLAPSE_RATIO = 0.9;
// A nightly job that last succeeded more than 36 hours ago has missed a night.
export const HISTORY_REFRESH_STALE_MS = 36 * 3600 * 1000;
// A few live sessions are normal at 02:15. More than this means sources are not settling.
export const HISTORY_REFRESH_MAX_DEFERRED = 25;

export function runEngramHealthChecks(input: EngramHealthInput): EngramHealthResult {
  const { db, now, previous = null, indexerStats = null } = input;
  const state = readState(db);
  const checks: EngramCheck[] = [
    admissionQueueFlowing(indexerStats),
    validFromRegression(state, previous),
    nodeCountCollapse(state, previous),
    dbIntegrity(db),
    ...(input.historyRefresh ? [historyRefreshCurrent(input.historyRefresh, now)] : []),
    ...(input.recallUsage ?? []).map(recallUsageHealth),
    ...(input.driftReview !== undefined ? [driftReviewHealth(input.driftReview, now)] : []),
  ];
  return {
    status: worst(checks.map(c => c.status)),
    checks,
    state,
    generatedAt: now.toISOString(),
  };
}

/**
 * The 2026-08 outage signature. The indexer finds authored assertion blocks,
 * then drops every one because no admission service is wired, and still exits 0.
 * A run that touched no assertion blocks (the ordinary case since Phase 1 stopped
 * submitting relations) legitimately produces zero candidates and is healthy, so
 * the check keys on `assertionsSeen` rather than on `skipped` or `candidates` alone.
 */
function admissionQueueFlowing(stats: IndexerStats | null): EngramCheck {
  if (!stats) {
    return {
      id: 'admission_queue_flowing',
      status: 'warn',
      detail: 'no indexer stats available; cannot tell whether candidates are being quarantined',
      value: null,
    };
  }
  if (stats.assertionsSeen > 0 && stats.candidates === 0 && stats.rejected === 0) {
    return {
      id: 'admission_queue_flowing',
      status: 'fail',
      detail: `indexer saw ${stats.assertionsSeen} assertions and admitted none (0 candidates, 0 rejected); admission service is probably unwired`,
      value: stats.assertionsSeen,
    };
  }
  return {
    id: 'admission_queue_flowing',
    status: 'ok',
    detail: `assertionsSeen ${stats.assertionsSeen}, quarantined ${stats.candidates}, rejected ${stats.rejected}`,
    value: stats.candidates,
  };
}

/** Null valid_from may fall through a backfill or fixed frontmatter. It must never climb. */
function validFromRegression(state: EngramHealthState, previous: EngramHealthState | null): EngramCheck {
  if (!previous) {
    return {
      id: 'valid_from_regression',
      status: 'ok',
      detail: `no previous run to compare; recording ${state.nullValidFrom} null valid_from`,
      value: state.nullValidFrom,
    };
  }
  if (state.nullValidFrom > previous.nullValidFrom) {
    return {
      id: 'valid_from_regression',
      status: 'fail',
      detail: `null valid_from rose from ${previous.nullValidFrom} to ${state.nullValidFrom}; a writer bypassed the temporal guard`,
      value: state.nullValidFrom,
    };
  }
  return {
    id: 'valid_from_regression',
    status: 'ok',
    detail: `null valid_from ${state.nullValidFrom}, was ${previous.nullValidFrom}`,
    value: state.nullValidFrom,
  };
}

function nodeCountCollapse(state: EngramHealthState, previous: EngramHealthState | null): EngramCheck {
  if (!previous) {
    return { id: 'node_count_collapse', status: 'ok', detail: `no previous run; ${state.nodes} nodes`, value: state.nodes };
  }
  const floor = Math.floor(previous.nodes * NODE_COLLAPSE_RATIO);
  if (state.nodes < floor) {
    return {
      id: 'node_count_collapse',
      status: 'fail',
      detail: `nodes fell from ${previous.nodes} to ${state.nodes}, below the ${floor} floor`,
      value: state.nodes,
    };
  }
  return { id: 'node_count_collapse', status: 'ok', detail: `${state.nodes} nodes, was ${previous.nodes}`, value: state.nodes };
}

function dbIntegrity(db: Database.Database): EngramCheck {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
  return {
    id: 'db_integrity',
    status: ok ? 'ok' : 'fail',
    detail: ok ? 'integrity_check ok' : `integrity_check reported ${rows.map(r => r.integrity_check).join('; ')}`,
    value: ok ? 'ok' : 'failed',
  };
}

/**
 * The transcript-history database is a snapshot that only a nightly refresh keeps current.
 * A refresh that stops running exits nothing and pages nothing, so this reads its status file:
 * missing, unreadable, failed, stale, and deferred-heavy all fail.
 */
function historyRefreshCurrent(input: HistoryRefreshInput, now: Date): EngramCheck {
  const fail = (detail: string, value: string | number | null = null): EngramCheck => ({
    id: 'history_refresh_current', status: 'fail', detail, value,
  });
  if (input.error) return fail(`cannot read ${input.path}: ${input.error}`);
  const status = input.status;
  if (!status) return fail(`no refresh status at ${input.path}; the refresh has never run here`);
  if (status.result !== 'ok') {
    return fail(`last refresh (${status.ended_at}) failed at ${status.stage ?? 'unknown stage'}: ${status.error ?? 'no detail'}`, status.ended_at);
  }
  const lastSuccess = Date.parse(status.last_success_at ?? '');
  if (!Number.isFinite(lastSuccess)) return fail(`status has no valid last_success_at`);
  const ageHours = (now.getTime() - lastSuccess) / 3600_000;
  if (now.getTime() - lastSuccess > HISTORY_REFRESH_STALE_MS) {
    return fail(`last successful refresh ${status.last_success_at} is ${ageHours.toFixed(1)} h old (limit 36 h)`, status.last_success_at);
  }
  if (status.deferred_sources > HISTORY_REFRESH_MAX_DEFERRED) {
    return fail(`${status.deferred_sources} sources deferred as live (limit ${HISTORY_REFRESH_MAX_DEFERRED})`, status.deferred_sources);
  }
  return {
    id: 'history_refresh_current',
    status: 'ok',
    detail: `refreshed ${ageHours.toFixed(1)} h ago, ${status.deferred_sources} deferred`,
    value: status.last_success_at,
  };
}

function readState(db: Database.Database): EngramHealthState {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n ?? 0;
  return {
    nullValidFrom: one('SELECT COALESCE(SUM(valid_from IS NULL), 0) n FROM records_engram_assertions'),
    nodes: one('SELECT COUNT(*) n FROM records_nodes'),
    assertions: one('SELECT COUNT(*) n FROM records_engram_assertions'),
    candidates: one('SELECT COUNT(*) n FROM records_engram_memory_candidates'),
  };
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}


/** A sparse day is inconclusive; it must never claim a measured pass. */
export function recallUsageHealth(report: { source: string; alarm: string; alarm_day?: string; review_queue_size?: number }): EngramCheck {
  const status = report.alarm === 'low-injection-rate' || report.alarm === 'error' || (report.review_queue_size ?? 0) > 50 ? 'fail' : 'ok';
  return { id: `recall_usage_${report.source}`, status,
    detail: `${report.alarm_day ?? 'unknown day'}: ${report.alarm}; ${report.review_queue_size ?? 0} contradictions awaiting review (limit 50)`, value: report.alarm };
}

// Marks need no reviewer, so only first flags have a small limit. The mark ceiling is a
// heartbeat: at five a night it takes weeks of flags with no promotion to reach it.
export const DRIFT_WATCH_LIMIT = 25;
export const DRIFT_MARK_LIMIT = 200;

export function driftReviewHealth(report: unknown, now: Date): EngramCheck {
  const fail = (detail: string): EngramCheck => ({ id: 'memory_drift_review', status: 'fail', detail });
  if (!report || typeof report !== 'object') return fail('drift review state missing or unreadable');
  const r = report as { schema?: string; last_run?: { status?: string; ended_at?: string; started_at?: string }; pending?: number; watching?: number; marked?: number };
  const marked = r.marked ?? 0;
  if (r.schema !== 'engram.memory-drift.v1' || !Number.isSafeInteger(r.pending) || !Number.isSafeInteger(r.watching)
    || !Number.isSafeInteger(marked) || r.pending! < 0 || r.watching! < 0 || marked < 0) return fail('invalid drift review summary');
  const last = r.last_run;
  const stamp = Date.parse(last?.status === 'running' ? last.started_at ?? '' : last?.ended_at ?? '');
  const age = now.getTime() - stamp;
  if (!Number.isFinite(age) || age < 0 || age > (last?.status === 'running' ? 30 * 60_000 : HISTORY_REFRESH_STALE_MS)) return fail('drift review is stale or has an invalid clock');
  if (!['ok', 'running'].includes(last?.status ?? '')) return fail('last drift review failed');
  if (r.pending! + r.watching! > DRIFT_WATCH_LIMIT) return fail(`${r.watching} first flags and ${r.pending} unmigrated; limit ${DRIFT_WATCH_LIMIT}`);
  if (marked > DRIFT_MARK_LIMIT) return fail(`${marked} drift marks; limit ${DRIFT_MARK_LIMIT}, promotion is not keeping up`);
  return { id: 'memory_drift_review', status: 'ok', value: marked,
    detail: `${marked} inert drift marks; ${r.watching} first flags; last run ${last!.status}. Marks change no memory.` };
}
