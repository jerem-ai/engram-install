import { memoryVectorResult, type Store } from './store.js';
import type { SearchResult } from './types.js';
import { admittedSourceSql, memorySourceGate, type MemoryAdmissionMode } from './engram/admission.js';
import { retiredSources } from './engram/source-retirement.js';
import { normalizeTemporalInstant } from './engram/temporal.js';
import { isStale } from './memory-currency.js';
import { memoryReadVersion, retainCurrentRead } from './read-consistency.js';

interface Eligibility {
  checkedAt: number;
  expiresAt: number;
  rowids: string;
  ids: Set<string>;
}
const snapshots = new WeakMap<Store, { version: string; entries: Map<string, Eligibility> }>();

export interface FilteredVectorDiagnostic {
  path: 'knn' | 'scan_tie' | 'scan_limit' | 'empty' | 'withheld';
  eligible_count: number;
  eligibility_cache_hit: boolean;
}

/** Offline candidate until G3. Cached row IDs carry evidence, never authority. */
export function searchEligibleMemoryVectors(
  store: Store, embedding: Float32Array, limit: number,
  options: { admission?: MemoryAdmissionMode; excludeStale?: boolean } = {},
): { results: SearchResult[]; diagnostic: FilteredVectorDiagnostic } {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Vector limit must be a nonnegative safe integer');
  const version = memoryReadVersion(store);
  const now = Date.now();
  const key = `${options.admission ?? 'legacy'}:${options.excludeStale === true}`;
  let state = snapshots.get(store);
  if (state?.version !== version) {
    state = { version, entries: new Map() };
    snapshots.set(store, state);
  }
  let eligibility = state.entries.get(key);
  const hit = !!eligibility && now >= eligibility.checkedAt && now < eligibility.expiresAt;
  if (!hit) {
    const gate = memorySourceGate(store.db, options.admission);
    const retired = options.excludeStale ? retiredSources(store.db) : new Set<string>();
    const prefilter = options.admission === 'admitted' || options.admission === 'promoted_only'
      ? `AND ${admittedSourceSql('n.id', options.admission)}` : '';
    const rows = store.db.prepare(`SELECT n.rowid, n.id, n.frontmatter FROM nodes n
      WHERE n.source = 'vault' AND n.id LIKE 'Memory/%' ${prefilter}`)
      .all() as Array<{ rowid: number; id: string; frontmatter: string }>;
    const ids = new Set<string>();
    const rowids: number[] = [];
    let expiresAt = Infinity;
    for (const row of rows) {
      if (gate && !gate(row.id)) continue;
      let fm: Record<string, unknown> = {};
      try { const value = JSON.parse(row.frontmatter); if (value && typeof value === 'object') fm = value; } catch { /* Same empty metadata as Store. */ }
      if (options.excludeStale && (retired.has(row.id) || isStale(fm, now))) continue;
      if (options.excludeStale) {
        const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata as Record<string, unknown> : {};
        for (const end of [fm.valid_to, meta.valid_to]) {
          try { expiresAt = Math.min(expiresAt, Date.parse(normalizeTemporalInstant(end))); } catch { /* Invalid dates do not prove expiry. */ }
        }
      }
      if (!Number.isSafeInteger(row.rowid)) throw new RangeError('Unsafe vector row ID');
      ids.add(row.id); rowids.push(row.rowid);
    }
    eligibility = { checkedAt: now, expiresAt, ids, rowids: JSON.stringify(rowids) };
    // Never publish an eligibility cache built across a source/policy change.
    if (memoryReadVersion(store) !== version) return { results: [], diagnostic: {
      path: 'withheld', eligible_count: 0, eligibility_cache_hit: false,
    } };
    state.entries.set(key, eligibility);
  }
  const bound = eligibility!;
  let path: FilteredVectorDiagnostic['path'] = 'empty';
  let results: SearchResult[] = [];
  if (limit > 0 && bound.ids.size > 0) {
    // sqlite-vec caps k at 4096. Reserve one row to detect a boundary tie.
    if (limit < 4096) {
      const rows = store.db.prepare(`SELECT v.distance, n.id, n.title, n.content, n.frontmatter
        FROM nodes_vec v JOIN nodes n ON n.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
          AND v.rowid IN (SELECT value FROM json_each(?))
        ORDER BY v.distance`).all(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), limit + 1, bound.rowids) as Array<{
          distance: number; id: string; title: string; content: string | null; frontmatter: string | null;
        }>;
      const tie = rows.some((row, i) => !Number.isFinite(row.distance) || (i > 0 && row.distance === rows[i - 1].distance));
      if (!tie) { path = 'knn'; results = rows.slice(0, limit).map(memoryVectorResult); }
      else path = 'scan_tie';
    } else path = 'scan_limit';
    if (path === 'scan_tie' || path === 'scan_limit') {
      // Keep the original scalar query and tie order. Grow its prefix until it
      // contains enough eligible rows, avoiding full-body materialization when
      // a short prefix already proves the requested result.
      const maximum = store.countNodes();
      let depth = Math.min(limit, maximum);
      while (depth > 0) {
        const prefix = store.searchMemory(embedding, depth);
        results = prefix.filter(row => bound.ids.has(row.nodeId)).slice(0, limit);
        if (results.length >= limit || prefix.length < depth || depth === maximum) break;
        depth = Math.min(maximum, depth * 2);
      }
    }
  }
  // Eligibility may expire while the synchronous SQL is running, without a write.
  const completedAt = Date.now();
  if (options.excludeStale && (completedAt < bound.checkedAt || completedAt >= bound.expiresAt)) {
    state.entries.delete(key); results = []; path = 'withheld';
  }
  const retained = retainCurrentRead(store, version, results);
  if (retained !== results) path = 'withheld';
  return { results: retained, diagnostic: { path, eligible_count: bound.ids.size, eligibility_cache_hit: hit } };
}
