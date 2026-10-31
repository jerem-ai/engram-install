import { createHash } from 'node:crypto';
import type { Embedder } from './embedder.js';
import type { SearchResult } from './types.js';
import type { Store } from './store.js';
import { memoryReadVersion } from './read-consistency.js';

/**
 * Passage rescoring for the vector arm of memory search.
 *
 * The stored note embedding covers only the title, tags and first paragraph
 * (Embedder.buildEmbeddingText). A fact deeper in a note, and every line of a
 * multi-topic MEMORY.md index, is invisible to it. Such notes reach the
 * full-text arm but not the vector arm, so reciprocal-rank fusion caps them at
 * 1/61 (0.0164), below the 0.024 recall floor.
 *
 * At query time, each full-text candidate is split into passages, embedded
 * with the same model (cached in process by content hash), and given its best
 * passage cosine. A candidate whose best passage clears `minCosine` joins the
 * vector arm at that cosine. No index or database is written.
 *
 * 2026-10-02 benchmark (docs/RETRIEVAL_PASSAGE_RESCORE_2026-10-02.md): top-20
 * hits 61 -> 66 of 80 with no-answer selections unchanged at 41. No-answer
 * selections stay at baseline for thresholds 0.42-0.50; 0.40 admits one more.
 * The 0.45 default sits inside that band.
 */

export const PASSAGE_MAX_CHARS = 500;
export const PASSAGE_MIN_COSINE_DEFAULT = 0.45;
const CACHE_MAX_NODES = 20_000;

export interface PassageOpts {
  enabled: boolean;
  minCosine: number;
}

/** KG_PASSAGE_RESCORE=0|false disables; KG_PASSAGE_MIN_COSINE overrides the threshold. */
export function resolvePassageOpts(): PassageOpts {
  const flag = process.env.KG_PASSAGE_RESCORE;
  const enabled = flag === undefined || !(flag === '0' || flag.toLowerCase() === 'false');
  const raw = process.env.KG_PASSAGE_MIN_COSINE;
  const parsed = raw === undefined ? NaN : parseFloat(raw);
  const minCosine = Number.isFinite(parsed) ? parsed : PASSAGE_MIN_COSINE_DEFAULT;
  return { enabled, minCosine };
}

/**
 * Split note content into passages of at most ~maxChars, breaking on blank
 * lines, list items and headings, then merging neighbours greedily. Each
 * passage is prefixed with the note title so it keeps its subject.
 */
export function splitPassages(title: string, content: string, maxChars = PASSAGE_MAX_CHARS): string[] {
  const pieces = content.split(/\n\s*\n|\n(?=\s*[-*] )|\n(?=#)/).map(s => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 1 > maxChars) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.map(c => `${title}\n${c}`);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface PassageSource { id: string; title: string; content: string }
export type ReadCurrent = () => boolean;
const alwaysCurrent: ReadCurrent = () => true;

function passageHash(n: PassageSource): string {
  return createHash('sha256').update(n.title).update('\0').update(n.content).digest('hex');
}

/** Process-local passage vectors, keyed by node id and invalidated by content hash. */
export class PassageVectors {
  private cache = new Map<string, { hash: string; vecs: Float32Array[] }>();

  constructor(private embedder: Pick<Embedder, 'embed'>, private maxNodes = CACHE_MAX_NODES) {}

  get size(): number { return this.cache.size; }

  /** Embed and cache passages for nodes that are missing or whose content changed. */
  async ensure(nodes: PassageSource[], current: ReadCurrent = alwaysCurrent): Promise<boolean> {
    for (const n of nodes) {
      if (!current()) { this.cache.clear(); return false; }
      const hash = passageHash(n);
      const hit = this.cache.get(n.id);
      if (hit && hit.hash === hash) {
        this.cache.delete(n.id); this.cache.set(n.id, hit); // refresh LRU position
        continue;
      }
      // One text per call, like the indexer: batching pads sequences and moves
      // vectors by up to ~0.01 cosine, which would make results depend on what
      // else a passage happened to be embedded with.
      const vecs: Float32Array[] = [];
      for (const t of splitPassages(n.title, n.content)) {
        if (!current()) { this.cache.clear(); return false; }
        const vector = await this.embedder.embed(t);
        if (!current()) { this.cache.clear(); return false; }
        vecs.push(vector);
      }
      this.cache.set(n.id, { hash, vecs });
    }
    while (this.cache.size > this.maxNodes) this.cache.delete(this.cache.keys().next().value!);
    if (!current()) { this.cache.clear(); return false; }
    return true;
  }

  /** Best passage cosine per node against a normalized query embedding. */
  async best(query: Float32Array, nodes: PassageSource[], current: ReadCurrent = alwaysCurrent): Promise<Map<string, number>> {
    if (!await this.ensure(nodes, current)) return new Map();
    const out = new Map<string, number>();
    for (const n of nodes) {
      const entry = this.cache.get(n.id);
      if (!entry || entry.hash !== passageHash(n) || entry.vecs.length === 0) continue;
      let best = -1;
      for (const v of entry.vecs) best = Math.max(best, dot(query, v));
      out.set(n.id, best);
    }
    return current() ? out : new Map();
  }
}

/**
 * Rebuild the vector arm: note-level results plus full-text candidates whose
 * best passage cosine clears minCosine, ordered by max(note cosine, passage
 * cosine) and cut to `limit`. Pure; vector-arm order is unchanged when no
 * passage clears the threshold.
 */
export function mergePassageCandidates(
  vec: SearchResult[],
  fts: SearchResult[],
  best: Map<string, number>,
  minCosine: number,
  limit: number,
): SearchResult[] {
  const pool = new Map<string, { r: SearchResult; cos: number }>();
  for (const r of vec) pool.set(r.nodeId, { r, cos: r.cosine ?? -1 });
  for (const r of fts) {
    const c = best.get(r.nodeId);
    if (c === undefined || c < minCosine) continue;
    const have = pool.get(r.nodeId);
    if (have) {
      if (c > have.cos) pool.set(r.nodeId, { r: { ...have.r, passageCosine: c }, cos: c });
    } else {
      const { bm25: _bm25, score: _score, ...rest } = r;
      pool.set(r.nodeId, { r: { ...rest, score: c, passageCosine: c }, cos: c });
    }
  }
  return [...pool.values()].sort((a, b) => b.cos - a.cos).slice(0, limit).map(e => e.r);
}

const shared = new WeakMap<object, WeakMap<object, PassageVectors>>();

/** Share a model's passage cache within one store; keep other stores isolated. */
export function passageVectorsFor(embedder: Pick<Embedder, 'embed'>, scope: object = embedder): PassageVectors {
  let scopes = shared.get(embedder);
  if (!scopes) { scopes = new WeakMap(); shared.set(embedder, scopes); }
  let p = scopes.get(scope);
  if (!p) { p = new PassageVectors(embedder); scopes.set(scope, p); }
  return p;
}

/** Read one eligible body at a time; stop if the corpus or policy changes. */
export async function warmMemoryPassages(store: Store, embedder: Pick<Embedder, 'embed'>): Promise<number> {
  const version = memoryReadVersion(store);
  const current = () => memoryReadVersion(store) === version;
  const ids = store.db.prepare(
    `SELECT id FROM nodes WHERE source = 'vault' AND id LIKE 'Memory/%'`,
  ).all() as Array<{ id: string }>;
  const passages = passageVectorsFor(embedder, store);
  let count = 0;
  for (const { id } of ids) {
    if (!current()) break;
    const node = store.getNode(id);
    if (!node) continue;
    if (!await passages.ensure([{ id, title: node.title, content: node.content ?? '' }], current)) break;
    count++;
    await new Promise(resolve => setImmediate(resolve));
  }
  return count;
}
