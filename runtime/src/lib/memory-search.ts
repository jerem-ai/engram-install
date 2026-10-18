import type { Store } from './store.js';
import type { Embedder } from './embedder.js';
import type { SearchResult } from './types.js';
import { getMemorySourceAdmission, isPromotedMemorySource } from './engram/admission.js';
import { memoryEvidence } from './memory-evidence.js';
import { isStale, memoryAge } from './memory-currency.js';
import { retiredSources } from './engram/source-retirement.js';
import { mergePassageCandidates, passageVectorsFor, resolvePassageOpts } from './passage-rescore.js';
import { answerScorer, answerVerifyEnabled, type AnswerScorer } from './answer-verify.js';
export { isStale, memoryAge } from './memory-currency.js';

const RRF_K = 60;

/**
 * Cosine similarity between two normalized vectors.
 * Vectors produced by Xenova/all-MiniLM-L6-v2 are already L2-normalized,
 * so dot product equals cosine similarity — no division needed.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Provenance filter for memory/search results. Matches runtime/persona/model against
 * frontmatter (top-level or nested under `metadata`). Empty filter = pass-through.
 * Exported so future MCP callers can reuse without duplicating logic.
 */
export function matchesProvenance(
  fm: Record<string, unknown> | undefined,
  filt: { runtime?: string; persona?: string; model?: string },
): boolean {
  const want = Object.entries(filt).filter(([, v]) => !!v);
  if (want.length === 0) return true;
  const meta = (fm?.metadata && typeof fm.metadata === 'object' ? fm.metadata : {}) as Record<string, unknown>;
  const get = (k: string) => String(meta[k] ?? fm?.[k] ?? '').toLowerCase();
  return want.every(([k, v]) => get(k) === String(v).toLowerCase());
}

/**
 * Return true when a node's frontmatter marks it as canonical.
 * Checks top-level `canonical` and nested `metadata.canonical` (mirroring
 * matchesProvenance's top-level-or-metadata pattern). Accepts boolean true or
 * the string "true".
 */
export function isCanonical(fm: Record<string, unknown> | undefined): boolean {
  if (!fm) return false;
  const component = fm.component_of ?? (fm.metadata as Record<string, unknown> | undefined)?.component_of;
  // A reviewed aggregate can itself become a component of a later topic.
  // Keep its facts searchable, but only boost the current aggregate.
  if (typeof component === 'string' && component.trim()) return false;
  // Accepts boolean true or case-insensitive string "true" / "True" / "TRUE".
  // Numeric 1 is intentionally NOT accepted — YAML booleans are always parsed
  // to actual booleans by the time they reach frontmatter; accepting 1 would
  // silently match unintended integer values.
  const coerce = (v: unknown): boolean =>
    v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
  if (coerce(fm.canonical)) return true;
  const meta = fm.metadata && typeof fm.metadata === 'object'
    ? (fm.metadata as Record<string, unknown>)
    : null;
  if (meta && coerce(meta.canonical)) return true;
  return false;
}

/**
 * Stale nodes are excluded from memory-search results by default: a superseded
 * fact in an injected context is a recompute/parrot hazard even when demoted
 * (the L01 lesson). KG_INCLUDE_STALE=1 re-includes them for audit.
 */
export function includeStaleResults(): boolean {
  const env = process.env.KG_INCLUDE_STALE;
  return env === '1' || (typeof env === 'string' && env.toLowerCase() === 'true');
}

/** Resolve effective canonical-boost factor.
 * Reads KG_CANONICAL_BOOST env var (parseFloat); default 1.5.
 * Ships enabled by default — no opt-in required.
 *
 * Guard rules:
 *   - NaN (garbage input) → default 1.5
 *   - <= 0 → return 1.0  (0/negative would zero canonical scores; 1.0 disables
 *     the boost; set KG_CANONICAL_BOOST=1 to disable cleanly)
 */
export function resolveCanonicalBoost(): number {
  const env = process.env.KG_CANONICAL_BOOST;
  if (env !== undefined) {
    const parsed = parseFloat(env);
    if (isNaN(parsed)) return 1.5;
    if (parsed <= 0) return 1.0;
    return parsed;
  }
  return 1.5;
}

/**
 * Apply canonical boost in-place to an iterable of RRF entries.
 * Mutates entry.rrf for canonical nodes (isCanonical returns true).
 * Exported as a pure helper so tests can construct entry objects directly
 * and assert on mutated rrf values and resulting sort order.
 */
export function applyCanonicalBoost(
  entries: Iterable<{ rrf: number; result: { frontmatter?: Record<string, unknown> } }>,
  boost: number,
): void {
  for (const entry of entries) {
    if (isCanonical(entry.result.frontmatter)) {
      entry.rrf *= boost;
    }
  }
}

/** Diversity cap options for the greedy sub-selection pass. */
export interface DiversityOpts {
  /**
   * Enable diversity cap (default: KG_DIVERSITY_ENABLED env var, fallback true).
   * Set to false to reproduce pre-diversity behaviour byte-for-byte.
   */
  enabled?: boolean;
  /**
   * Maximum number of already-selected results that may be similar to a
   * candidate before the candidate is skipped (default: KG_DIVERSITY_MAX_SIMILAR
   * env var, fallback 2).
   */
  maxSimilar?: number;
  /**
   * Cosine-similarity threshold above which two results are "similar"
   * (default: KG_DIVERSITY_THRESHOLD env var, fallback 0.46).
   * Corpus-calibrated: cross-topic max on the production vault is ~0.41;
   * 0.46 = cross-topic max + 0.05, placing the threshold just above where
   * distinct-topic siblings can reach.
   * Vectors are already L2-normalised, so this is a dot-product threshold.
   */
  threshold?: number;
}

export interface MemorySearchOpts {
  /** Number of results to return (default 10). */
  k?: number;
  /** Filter by persona frontmatter field. */
  persona?: string;
  /** Filter by runtime frontmatter field. */
  runtime?: string;
  /** Filter by model frontmatter field. */
  model?: string;
  /** Minimum RRF fused score to include (default 0 — rank-gated by k only). */
  minScore?: number;
  /** Query-time diversity cap. See DiversityOpts for defaults. */
  diversity?: DiversityOpts;
  /** Require a private server-side promoted-source record. */
  admission?: 'legacy' | 'promoted_only';
  /** Offline evaluation only: receives each list's order and the fused ranking. */
  trace?: (trace: FusionTrace) => void;
  /** Fusion overrides for offline evaluation; production uses the defaults. */
  fusion?: Partial<FusionOpts>;
  /** Answer scorer override (tests); defaults to the shared cross-encoder. */
  answerScorer?: AnswerScorer;
}

/**
 * Full-text anchoring. The vector list is cut at 4 x the requested limit, so a
 * note full text ranks first but the note embedding ranks 13th or lower never
 * scores from both lists at the injectors' limit of 3. An anchored note is a
 * full-text candidate at rank <= anchorFtsRank whose note or best passage
 * cosine is at least anchorMinCosine; it joins the vector list at the rank its
 * cosine earns among all memory notes instead of being cut. 0 turns it off.
 */
export interface FusionOpts {
  anchorFtsRank: number;
  anchorMinCosine: number;
  /**
   * Answer verification: full-text candidates at rank <= verifyFtsRank whose
   * best passage the cross-encoder (answer-verify.ts) scores at least
   * verifyMinLogit form a third list, best logit first, fused like the other
   * two. 0 turns it off.
   */
  verifyFtsRank: number;
  verifyMinLogit: number;
  /**
   * Verify only question-shaped queries (isQuestionQuery). The cross-encoder
   * was trained to judge whether a passage answers a search question; many
   * hook prompts are instructions, where that judgement is undefined.
   */
  verifyQuestionsOnly: boolean;
  /**
   * The other direction: a scored candidate whose best passage logit is below
   * demoteMaxLogit (the cross-encoder says it does not answer) loses its
   * full-text vote. -Infinity turns it off.
   */
  demoteMaxLogit: number;
  /**
   * Final rerank (question-shaped queries when verifyQuestionsOnly is set):
   * candidates are gathered as if the caller had asked for rerankPoolK results,
   * then the first rerankDepth at or above rerankFloor are reordered by their
   * best passage logit, and any scoring below rerankDropBelow are removed.
   * 0 depth turns it off.
   */
  rerankDepth: number;
  rerankPoolK: number;
  rerankFloor: number;
  rerankDropBelow: number;
  /**
   * Rank each list among eligible notes only: stale and retired notes are
   * dropped from the vector and full-text lists before their ranks are fused,
   * instead of after. Each list is over-fetched to keep its depth. false keeps
   * the post-fusion exclusion alone. KG_INCLUDE_STALE=1 disables both.
   */
  eligibleArms: boolean;
  /**
   * Drop full-text query words found in more than this share of memory notes
   * (counted per query on the index); they match thousands of notes and carry
   * little evidence. At least one word is always kept. 1 turns it off.
   */
  ftsMaxDf: number;
  /**
   * No-answer filter (question-shaped queries when verifyQuestionsOnly is
   * set): every result search would return is read by the answer model, and
   * one whose best passage logit is below answerMinLogit is removed. Nothing
   * moves up to take its place. -Infinity turns it off.
   */
  answerMinLogit: number;
  /**
   * Leave requests addressed to the agent ("can you…", "should we…",
   * isAgentRequest) out of the no-answer filter. They are question-shaped
   * but ask for work, not a fact, so "does this passage answer it" is not
   * the right test for the memories they want.
   */
  answerSkipRequests: boolean;
  /**
   * Query-level no-answer filter: the answer model reads the first
   * ANSWER_HEAD results, and when none reaches answerQueryMinLogit the search
   * returns nothing. A memory that is not itself an answer survives whenever
   * another result in the head is one. Same query shapes as answerMinLogit.
   * -Infinity turns it off.
   */
  answerQueryMinLogit: number;
}

/**
 * Production fusion: answer verification and demotion on question-shaped
 * queries, anchoring off. Passed its frozen gate on October 7 as C5
 * (docs/RECALL_MISS_GROUPS_2026-10-07.md). The no-answer floor at -8 (F2)
 * passed its frozen usefulness gate on October 9
 * (docs/RECALL_USEFULNESS_F2_2026-10-09.md). KG_ANSWER_VERIFY=0 restores
 * two-list fusion with no answer model at all.
 */
export const FUSION_DEFAULTS: FusionOpts = {
  anchorFtsRank: 0, anchorMinCosine: 1,
  verifyFtsRank: 3, verifyMinLogit: 2, verifyQuestionsOnly: true, demoteMaxLogit: -5,
  rerankDepth: 0, rerankPoolK: 20, rerankFloor: 0.024, rerankDropBelow: -Infinity,
  eligibleArms: false, ftsMaxDf: 1, answerMinLogit: -8, answerSkipRequests: false,
  answerQueryMinLogit: -Infinity,
};

/** Results the query-level no-answer filter reads: the hooks' limit. */
export const ANSWER_HEAD = 3;

const QUESTION_START = /^\s*(what|why|how|when|where|which|who|whose|whom|is|are|was|were|does|do|did|can|could|should|would|will|has|have|had|may|might|shall)\b/i;

/** A query that asks something: it contains a question mark or opens with a question word. */
export function isQuestionQuery(query: string): boolean {
  return query.includes('?') || QUESTION_START.test(query);
}
const AGENT_REQUEST = /^\s*(can|could|would|will|should|shall|do|did|does|may|might|is|are)\s+(you|we|i|u)\b/i;

/** A question addressed to the agent or the team: "can you…", "should we…", "do I…". */
export function isAgentRequest(query: string): boolean {
  return AGENT_REQUEST.test(query);
}
let verifyWarned = false;
function warnVerifyUnavailable(error: unknown): void {
  if (verifyWarned) return;
  verifyWarned = true;
  console.error(`[memory-search] answer verification unavailable, fusing two lists: ${error instanceof Error ? error.message : String(error)}`);
}

/** Notes scanned to place an anchored note at its natural vector rank. */
const ANCHOR_SCAN = 1000;

/** What one search fused, for offline diagnosis (recall-miss-diagnose.ts). */
export interface FusionTrace {
  ftsQuery: string;
  /** Vector arm after passage merge, best first. */
  vec: string[];
  /** Full-text arm, best first. */
  fts: string[];
  /** Every fused candidate with its score, before stale, floor and provenance filters. */
  ranked: Array<[string, number]>;
  /** Anchored notes and the vector rank each joined at. */
  anchored: Array<[string, number]>;
  /** Verified notes and their cross-encoder logit, best first. */
  verified: Array<[string, number]>;
  /** Notes that lost their full-text vote. */
  demoted: string[];
  /** Reranked head, in final order, with logits (dropped notes are absent). */
  reranked: Array<[string, number]>;
  /** Results the no-answer filter removed, with their logits (answerMinLogit). */
  unanswered: Array<[string, number]>;
}

const STOPWORDS = new Set([
  'the','and','for','are','was','were','with','this','that','have','from',
  'they','will','what','when','how','who','which','been','does','had','has',
  'its','our','you','your','can','all','but','not','one','get','did','his',
  'her','him','she','its','let','any','its','got','use','two','may','per',
  'put','set','way','own','off','via','see','say','now','old','new','just',
]);

/** Term shares change slowly; a counted share is reused for this long. */
const TERM_SHARE_TTL_MS = 10 * 60 * 1000;
const termShares = new WeakMap<object, { at: number; memories: number; shares: Map<string, number> }>();

/**
 * Share of memory notes whose full text contains the term (ftsMaxDf). Counted
 * on the index and cached per database for TERM_SHARE_TTL_MS.
 */
export function memoryTermShare(store: Store, term: string, now = Date.now()): number {
  let cache = termShares.get(store.db);
  if (!cache || now - cache.at > TERM_SHARE_TTL_MS) {
    const memories = (store.db.prepare(`SELECT count(*) AS n FROM nodes WHERE id LIKE 'Memory/%'`).get() as { n: number }).n;
    cache = { at: now, memories, shares: new Map() };
    termShares.set(store.db, cache);
  }
  const key = term.toLowerCase();
  let share = cache.shares.get(key);
  if (share === undefined) {
    try {
      const n = (store.db.prepare(`SELECT count(*) AS n FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ? AND n.id LIKE 'Memory/%'`).get(`"${key}"`) as { n: number }).n;
      share = n / Math.max(1, cache.memories);
    } catch {
      share = 0;
    }
    cache.shares.set(key, share);
  }
  return share;
}

/** The query's full-text terms: punctuation stripped, words over two letters, no stopwords. */
export function ftsTerms(query: string): string[] {
  return query
    .replace(/[^\w\s]/g, ' ')  // strip punctuation / special chars
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t.toLowerCase()));
}

/** Resolve effective diversity settings, merging caller opts → env vars → hardcoded defaults. */
export function resolveDiversityOpts(opts?: DiversityOpts): Required<DiversityOpts> {
  const envEnabled = process.env.KG_DIVERSITY_ENABLED;
  const envThreshold = process.env.KG_DIVERSITY_THRESHOLD;
  const envMaxSimilar = process.env.KG_DIVERSITY_MAX_SIMILAR;

  return {
    // Default OFF: empirically a no-op for the S05/L01 target cases on the real corpus
    // (2026-06-10 verification) — opt in via KG_DIVERSITY_ENABLED=1 or the diversity option.
    enabled: opts?.enabled ?? (envEnabled !== undefined ? envEnabled !== '0' && envEnabled !== 'false' : false),
    threshold: opts?.threshold ?? (envThreshold !== undefined ? parseFloat(envThreshold) : 0.46),
    maxSimilar: opts?.maxSimilar ?? (envMaxSimilar !== undefined ? parseInt(envMaxSimilar, 10) : 2),
  };
}

/**
 * Greedy diversity sub-selection.
 *
 * Walks the RRF-ordered candidate list and admits a candidate only when fewer
 * than `maxSimilar` already-selected results have cosine similarity ≥ threshold
 * with it.  RRF order is preserved for admitted results; no re-ranking occurs.
 *
 * A null embedding (getNodeEmbedding returns null) is always admitted — we
 * cannot prove similarity without an embedding.
 *
 * Embeddings are fetched at most once per candidate (cached in `embCache`).
 */
export function greedyDiverseSelect(
  candidates: Array<{ nodeId: string; rrf: number; result: SearchResult }>,
  k: number,
  store: Store,
  divOpts: Required<DiversityOpts>,
): Array<{ nodeId: string; rrf: number; result: SearchResult }> {
  const { maxSimilar, threshold } = divOpts;
  const selected: Array<{ nodeId: string; emb: Float32Array | null }> = [];
  const result: Array<{ nodeId: string; rrf: number; result: SearchResult }> = [];
  const embCache = new Map<string, Float32Array | null>();

  const getEmb = (nodeId: string): Float32Array | null => {
    if (!embCache.has(nodeId)) embCache.set(nodeId, store.getNodeEmbedding(nodeId));
    return embCache.get(nodeId)!;
  };

  for (const candidate of candidates) {
    if (result.length >= k) break;

    const candEmb = getEmb(candidate.nodeId);

    // No embedding → always accept (can't prove similarity).
    if (candEmb === null) {
      selected.push({ nodeId: candidate.nodeId, emb: null });
      result.push(candidate);
      continue;
    }

    // Count how many already-selected results are "similar" to this candidate.
    let similarCount = 0;
    for (const sel of selected) {
      if (sel.emb !== null && cosineSimilarity(candEmb, sel.emb) >= threshold) {
        similarCount++;
        if (similarCount >= maxSimilar) break;
      }
    }

    if (similarCount < maxSimilar) {
      selected.push({ nodeId: candidate.nodeId, emb: candEmb });
      result.push(candidate);
    }
  }

  return result;
}

/**
 * Hybrid memory search: fuses vector ANN and full-text search results over Memory/
 * nodes via reciprocal-rank fusion (RRF, constant 60), applies provenance filtering,
 * and returns top-k results sorted by fused score descending.
 *
 * Designed so a future MCP caller can import and use this directly.
 */
export async function searchMemoryHybrid(
  store: Store,
  embedder: Embedder,
  query: string,
  opts: MemorySearchOpts = {},
): Promise<SearchResult[]> {
  const k = opts.k ?? 10;
  const minScore = opts.minScore ?? 0;
  const provFilter = { persona: opts.persona, runtime: opts.runtime, model: opts.model };
  const promotedOnly = opts.admission === 'promoted_only';

  const fusion = { ...FUSION_DEFAULTS, ...(answerVerifyEnabled() ? {} : { verifyFtsRank: 0, rerankDepth: 0 }), ...opts.fusion };
  const questionOk = !fusion.verifyQuestionsOnly || isQuestionQuery(query);
  const rerank = fusion.rerankDepth > 0 && questionOk;
  // Candidate depth: the reranker sees the pool a rerankPoolK-result search would fuse.
  const poolK = rerank ? Math.max(k, fusion.rerankPoolK) : k;

  // Stale exclusion runs after fusion; with eligibleArms it also runs on each
  // list before ranking. A note retired by an admitted correction counts as
  // stale (source-retirement.ts). KG_INCLUDE_STALE=1 re-includes both.
  const includeStale = includeStaleResults();
  const retired = includeStale ? new Set<string>() : retiredSources(store.db);
  const eligible = (r: SearchResult) => includeStale || (!isStale(r.frontmatter) && !retired.has(r.nodeId));
  const overfetch = fusion.eligibleArms && !includeStale ? 2 : 1;

  // Embed query and run both retrieval paths concurrently.
  const embedding = await embedder.embed(query);

  // Vector: searchMemory already filters to Memory/ nodes.
  const vecResults = store.searchMemory(embedding, promotedOnly ? store.countNodes() : poolK * 4 * overfetch)
    .filter(result => !promotedOnly || isPromotedMemorySource(store.db, result.nodeId))
    .filter(result => !fusion.eligibleArms || eligible(result))
    .slice(0, poolK * 4);

  // FTS: query FTS5 directly on store.db, pre-filtering to Memory/ nodes.
  // We bypass store.searchFullText because:
  //   1. It passes raw queries to FTS5 (breaks on natural language punctuation).
  //   2. Its LIMIT 20 is over the full vault — Memory nodes can fall below rank 20
  //      even when they're the best match within Memory/.
  // Strategy: sanitize query → OR of meaningful (non-stopword) tokens, then query
  // FTS with a JOIN filter on id LIKE 'Memory/%', falling back to empty on any error.
  let terms = ftsTerms(query);
  if (fusion.ftsMaxDf < 1 && terms.length > 1) {
    const share = new Map(terms.map(t => [t, memoryTermShare(store, t)]));
    const kept = terms.filter(t => share.get(t)! <= fusion.ftsMaxDf);
    terms = kept.length > 0 ? kept : [terms.reduce((a, b) => (share.get(a)! <= share.get(b)! ? a : b))];
  }
  const sanitizedQuery = terms.join(' OR ');

  let ftsResults: import('./types.js').SearchResult[] = [];
  if (sanitizedQuery.length > 0) {
    try {
      const ftsRows = store.db.prepare(`
        SELECT n.id, n.title, n.frontmatter, f.rank,
          snippet(nodes_fts, 1, '>>>', '<<<', '...', 40) as excerpt
        FROM nodes_fts f
        JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ? AND n.id LIKE 'Memory/%'
          ${promotedOnly ? `AND EXISTS (
            SELECT 1 FROM engram_memory_sources ms
            WHERE ms.source_node_id = n.id
              AND ms.trust_state = 'promoted'
              AND ms.authority = 'informational_only'
          )` : ''}
        ORDER BY rank
        LIMIT ${40 * overfetch}
      `).all(sanitizedQuery) as Array<{
        id: string; title: string; frontmatter: string;
        rank: number; excerpt: string;
      }>;
      ftsResults = ftsRows.map(r => ({
        nodeId: r.id,
        title: r.title,
        score: r.rank,  // RRF uses position; retain the raw SQLite BM25 signal.
        bm25: r.rank,
        excerpt: r.excerpt ?? '',
        frontmatter: (() => {
          try { return JSON.parse(r.frontmatter) as Record<string, unknown>; } catch { return {}; }
        })(),
      })).filter(result => !promotedOnly || isPromotedMemorySource(store.db, result.nodeId))
        .filter(result => !fusion.eligibleArms || eligible(result))
        .slice(0, 40);
    } catch {
      // FTS5 syntax error on edge-case queries — vector-only is still valid
    }
  }

  // Passage rescoring: full-text candidates whose best passage matches the
  // query join the vector arm (see passage-rescore.ts). Same for every caller.
  let vecArm = vecResults;
  let best = new Map<string, number>();
  const passageOpts = resolvePassageOpts();
  if (passageOpts.enabled && ftsResults.length > 0) {
    const ids = ftsResults.map(r => r.nodeId);
    const rows = store.db.prepare(
      `SELECT id, title, content FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as Array<{ id: string; title: string | null; content: string | null }>;
    best = await passageVectorsFor(embedder).best(
      embedding,
      rows.map(r => ({ id: r.id, title: r.title ?? '', content: r.content ?? '' })),
    );
    vecArm = mergePassageCandidates(vecResults, ftsResults, best, passageOpts.minCosine, poolK * 4);
  }

  // Build an index of all results by nodeId for score bookkeeping.
  const byId = new Map<string, { nodeId: string; rrf: number; result: SearchResult }>();

  const fuse = (results: SearchResult[]) => {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      if (!byId.has(r.nodeId)) {
        byId.set(r.nodeId, { nodeId: r.nodeId, rrf: 0, result: r });
      }
      const fused = byId.get(r.nodeId)!;
      if (r.cosine !== undefined) fused.result.cosine = r.cosine;
      if (r.bm25 !== undefined) fused.result.bm25 = r.bm25;
      if (r.passageCosine !== undefined) fused.result.passageCosine = r.passageCosine;
      byId.get(r.nodeId)!.rrf += 1.0 / (RRF_K + rank + 1);
    }
  };

  fuse(vecArm);
  fuse(ftsResults);

  const anchored: Array<[string, number]> = [];
  if (fusion.anchorFtsRank > 0) {
    const inArm = new Set(vecArm.map(r => r.nodeId));
    const candidates = ftsResults.slice(0, fusion.anchorFtsRank).filter(r => !inArm.has(r.nodeId));
    if (candidates.length > 0) {
      const deep = store.searchMemory(embedding, ANCHOR_SCAN)
        .filter(r => !promotedOnly || isPromotedMemorySource(store.db, r.nodeId));
      const noteCos = new Map(deep.map(r => [r.nodeId, r.cosine ?? -1]));
      for (const r of candidates) {
        const own = store.getNodeEmbedding(r.nodeId);
        const cos = Math.max(noteCos.get(r.nodeId) ?? (own ? cosineSimilarity(embedding, own) : -1), best.get(r.nodeId) ?? -1);
        if (cos < fusion.anchorMinCosine) continue;
        const rank = 1 + deep.filter(d => d.nodeId !== r.nodeId && (d.cosine ?? -1) > cos).length;
        anchored.push([r.nodeId, rank]);
        byId.get(r.nodeId)!.rrf += 1.0 / (RRF_K + rank);
      }
    }
  }

  const verified: Array<[string, number]> = [];
  const demoted: string[] = [];
  // Every logit this search computed, so the no-answer filter reads each note once.
  const known = new Map<string, number>();
  if (fusion.verifyFtsRank > 0 && ftsResults.length > 0 && questionOk) {
    const ids = ftsResults.slice(0, fusion.verifyFtsRank).map(r => r.nodeId);
    const rows = store.db.prepare(
      `SELECT id, title, content FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as Array<{ id: string; title: string | null; content: string | null }>;
    let logits = new Map<string, number>();
    try {
      logits = await (opts.answerScorer ?? answerScorer()).best(
        query, rows.map(r => ({ id: r.id, title: r.title ?? '', content: r.content ?? '' })));
    } catch (error) {
      // No verifier (model missing offline, load failure): search falls back to two lists.
      warnVerifyUnavailable(error);
    }
    for (const [id, logit] of logits) known.set(id, logit);
    for (const [ftsRank, id] of ids.entries()) {
      const logit = logits.get(id);
      if (logit === undefined) continue;
      if (logit >= fusion.verifyMinLogit) verified.push([id, logit]);
      if (logit < fusion.demoteMaxLogit) {
        byId.get(id)!.rrf -= 1.0 / (RRF_K + ftsRank + 1);
        demoted.push(id);
      }
    }
    verified.sort((a, b) => b[1] - a[1]);
    verified.forEach(([id], rank) => { byId.get(id)!.rrf += 1.0 / (RRF_K + rank + 1); });
  }

  // Canonical boost: multiply rrf by the boost factor for canonical nodes.
  // Placement: applied BEFORE minScore / provenance / diversity by design.
  //   - Canonical nodes are meant to be more likely to clear minScore; minScore
  //     is therefore a threshold on boosted scores for canonical nodes.
  //   - Diversity and provenance run after, so they can still trim canonical
  //     results that are redundant or don't match the caller's filter.
  const canonicalBoost = resolveCanonicalBoost();
  applyCanonicalBoost(byId.values(), canonicalBoost);

  // Sort by RRF score descending, apply stale exclusion, provenance filter and
  // minScore floor. Stale exclusion runs before the k-slice so superseded facts
  // free their slot for the next candidate (KG_INCLUDE_STALE=1 re-includes).
  let filtered = Array.from(byId.values())
    .sort((a, b) => b.rrf - a.rrf)
    .filter(e => eligible(e.result))
    .filter(e => e.rrf >= minScore)
    .filter(e => matchesProvenance(e.result.frontmatter, provFilter));

  const reranked: Array<[string, number]> = [];
  if (rerank) {
    const head = filtered.filter(e => e.rrf >= fusion.rerankFloor).slice(0, fusion.rerankDepth);
    if (head.length > 1 || (head.length === 1 && fusion.rerankDropBelow > -Infinity)) {
      const ids = head.map(e => e.nodeId);
      const rows = store.db.prepare(
        `SELECT id, title, content FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as Array<{ id: string; title: string | null; content: string | null }>;
      let logits: Map<string, number> | undefined;
      try {
        logits = await (opts.answerScorer ?? answerScorer()).best(
          query, rows.map(r => ({ id: r.id, title: r.title ?? '', content: r.content ?? '' })));
      } catch (error) {
        warnVerifyUnavailable(error);
      }
      if (logits) {
        const scored = head.map(e => ({ e, logit: logits!.get(e.nodeId) ?? -Infinity }));
        const kept = scored.filter(x => x.logit >= fusion.rerankDropBelow).sort((a, b) => b.logit - a.logit);
        kept.forEach(x => reranked.push([x.e.nodeId, x.logit]));
        const headIds = new Set(ids);
        filtered = [...kept.map(x => x.e), ...filtered.filter(e => !headIds.has(e.nodeId))];
      }
    }
  }

  // Diversity cap: greedy sub-selection so that no result joins the final set
  // if `maxSimilar` already-selected results are cosine-similar to it at >= threshold.
  // Runs AFTER minScore + provenance filtering, BEFORE .slice(0, k).
  // When disabled, falls through to a plain slice — byte-identical to pre-change behaviour.
  const divOpts = resolveDiversityOpts(opts.diversity);
  let candidates = divOpts.enabled
    ? greedyDiverseSelect(filtered, k, store, divOpts)
    : filtered.slice(0, k);

  // No-answer filters: drop returned results the answer model reads as clear
  // non-answers (answerMinLogit), or all of them when no head result answers
  // (answerQueryMinLogit). Runs on the final list so every caller's limit sees
  // it; a scorer failure keeps the list unchanged.
  const unanswered: Array<[string, number]> = [];
  const perResult = fusion.answerMinLogit > -Infinity, perQuery = fusion.answerQueryMinLogit > -Infinity;
  const answerFilter = (perResult || perQuery) && questionOk && answerVerifyEnabled()
    && !(fusion.answerSkipRequests && isAgentRequest(query));
  if (answerFilter && candidates.length > 0) {
    const judged = perResult ? candidates : candidates.slice(0, ANSWER_HEAD);
    const missing = judged.filter(e => !known.has(e.nodeId)).map(e => e.nodeId);
    let ok = true;
    if (missing.length > 0) {
      const rows = store.db.prepare(
        `SELECT id, title, content FROM nodes WHERE id IN (${missing.map(() => '?').join(',')})`,
      ).all(...missing) as Array<{ id: string; title: string | null; content: string | null }>;
      try {
        const logits = await (opts.answerScorer ?? answerScorer()).best(
          query, rows.map(r => ({ id: r.id, title: r.title ?? '', content: r.content ?? '' })));
        for (const [id, logit] of logits) known.set(id, logit);
      } catch (error) {
        warnVerifyUnavailable(error);
        ok = false;
      }
    }
    const head = candidates.slice(0, ANSWER_HEAD).map(e => known.get(e.nodeId)).filter((l): l is number => l !== undefined);
    if (ok && perQuery && head.length > 0 && Math.max(...head) < fusion.answerQueryMinLogit) {
      for (const e of candidates) unanswered.push([e.nodeId, known.get(e.nodeId) ?? NaN]);
      candidates = [];
    }
    if (ok && perResult) {
      candidates = candidates.filter(e => {
        const logit = known.get(e.nodeId);
        if (logit === undefined || logit >= fusion.answerMinLogit) return true;
        unanswered.push([e.nodeId, logit]);
        return false;
      });
    }
  }

  opts.trace?.({
    ftsQuery: sanitizedQuery,
    vec: vecArm.map(r => r.nodeId),
    fts: ftsResults.map(r => r.nodeId),
    ranked: Array.from(byId.values()).sort((a, b) => b.rrf - a.rrf).map(e => [e.nodeId, e.rrf]),
    anchored,
    verified,
    demoted,
    reranked,
    unanswered,
  });

  return candidates.map(e => {
    const admission = getMemorySourceAdmission(store.db, e.nodeId);
    return {
      ...e.result,
      score: e.rrf,
      currency: memoryAge(e.result.frontmatter),
      evidence: memoryEvidence(store.getNode(e.nodeId)),
      memoryAdmission: admission ? {
        origin: admission.origin,
        trust_state: admission.trust_state,
        sensitivity: admission.sensitivity,
        authority: admission.authority,
      } : undefined,
    };
  });
}
