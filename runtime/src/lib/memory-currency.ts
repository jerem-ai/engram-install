import type { SearchResult } from './types.js';
import { normalizeTemporalInstant } from './engram/temporal.js';

/**
 * Return true when a node's frontmatter marks it as stale (superseded by a
 * newer same-entity fact — the Engram supersession vocabulary, shared contract
 * with the Graphify drift detector). Same coercion + top-level-or-metadata
 * lookup rules as isCanonical.
 *
 * These marks qualify:
 *   - `stale: true`, the hand-curated flag (live since the L01 lesson).
 *   - `superseded_by: <file>`, written by the extraction pipeline's Loop A
 *     when a newer memory replaces this one (PLAN_TRUTH_MAINTENANCE
 *     2026-08-19). Promoted from inert to live on 2026-09-11 at Jeremy's
 *     instruction, ahead of the G-A1/G-A2 gates. Only a non-empty string
 *     counts; the NEW side's `supersedes` key never excludes anything.
 *   - `valid_to` at or before the current instant. Invalid dates are not proof
 *     of expiration. Age alone never marks a memory stale.
 * KG_INCLUDE_STALE=1 re-includes them for audit.
 */
export function isStale(fm: Record<string, unknown> | undefined, now = Date.now()): boolean {
  if (!fm) return false;
  const coerce = (v: unknown): boolean =>
    v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
  const superseded = (v: unknown): boolean =>
    typeof v === 'string' && v.trim().length > 0;
  const expired = (v: unknown): boolean => {
    if (!v) return false;
    try { return Date.parse(normalizeTemporalInstant(v)) <= now; }
    catch { return false; }
  };
  if (coerce(fm.stale) || superseded(fm.superseded_by) || expired(fm.valid_to)) return true;
  const meta = fm.metadata && typeof fm.metadata === 'object'
    ? (fm.metadata as Record<string, unknown>)
    : null;
  if (meta && (coerce(meta.stale) || superseded(meta.superseded_by) || expired(meta.valid_to))) return true;
  return false;
}

export function memoryAge(fm: Record<string, unknown> | undefined, now = Date.now()): SearchResult['currency'] {
  const meta = fm?.metadata as Record<string, unknown> | undefined;
  const type = fm?.type ?? meta?.type;
  if (type !== 'project' && type !== 'reference') return undefined;
  try {
    const createdAt = normalizeTemporalInstant(fm?.created ?? meta?.created);
    return { createdAt, ageDays: Math.max(0, Math.floor((now - Date.parse(createdAt)) / 86_400_000)) };
  } catch { return undefined; }
}
