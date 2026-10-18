import type {
  CorpusCaseResult,
  CorpusRecallSuite,
} from './corpus-recall-suite-lib.js';

const RRF_K = 60;
const SEMANTIC_WEIGHT = 1.1;
const EXACT_TITLE_BOOST = 1.25;
const RETRIEVAL_PATH_ORDER = { lexical: 0, semantic: 1 } as const;

export interface HybridCandidate {
  segmentId: number;
  documentId: number;
  sourceId: string;
  title: string;
  citation: string;
  excerpt: string;
  scope: 'included' | 'excluded';
  activeVersion: boolean | null;
  updatedAt: string | null;
}

export interface SemanticHybridCandidate extends HybridCandidate {
  semanticSimilarity: number;
}

export interface FusedHybridCandidate extends HybridCandidate {
  normalizedTitle: string;
  fusedScore: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  semanticSimilarity: number | null;
  retrievalPaths: Array<'lexical' | 'semantic'>;
}

export interface FuseHybridInput {
  query: string;
  lexical: HybridCandidate[];
  semantic: SemanticHybridCandidate[];
  limit: number;
  semanticMinSimilarity: number;
}

export interface HybridComparison {
  passed: boolean;
  hardBaselineMrr: number;
  hardHybridMrr: number;
  hardMrrRelativeGain: number;
  exactBaselineRecall: number;
  exactHybridRecall: number;
  exactRecallLoss: number;
  duplicateRate: number;
  citationValidityRate: number;
  unsupportedAnswerRate: number;
  p95Ms: number;
  reasons: string[];
}

interface FusionEntry {
  candidate: HybridCandidate;
  fusedScore: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  semanticSimilarity: number | null;
  retrievalPaths: Set<'lexical' | 'semantic'>;
}

export function fuseHybridCandidates(input: FuseHybridInput): FusedHybridCandidate[] {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error('Hybrid result limit must be a positive integer');
  }
  if (!(input.semanticMinSimilarity >= -1 && input.semanticMinSimilarity <= 1)) {
    throw new Error('Semantic similarity threshold must be between -1 and 1');
  }

  const bySegment = new Map<number, FusionEntry>();
  input.lexical.forEach((candidate, index) => {
    if (candidate.scope !== 'included') return;
    const entry = entryFor(bySegment, candidate);
    entry.lexicalRank = index + 1;
    entry.fusedScore += 1 / (RRF_K + index + 1);
    entry.retrievalPaths.add('lexical');
  });
  input.semantic.forEach((candidate, index) => {
    if (candidate.scope !== 'included' || candidate.semanticSimilarity < input.semanticMinSimilarity) return;
    const entry = entryFor(bySegment, candidate);
    entry.semanticRank = index + 1;
    entry.semanticSimilarity = candidate.semanticSimilarity;
    entry.fusedScore += SEMANTIC_WEIGHT / (RRF_K + index + 1);
    entry.retrievalPaths.add('semantic');
  });

  const scored = [...bySegment.values()].map(entry => {
    if (titleMatchesQuery(entry.candidate.title, input.query)) {
      entry.fusedScore *= EXACT_TITLE_BOOST;
    }
    return entry;
  });

  const bySource = selectBest(scored, entry => entry.candidate.sourceId);
  const byTitle = new Map<string, FusionEntry[]>();
  for (const entry of bySource) {
    const title = normalizeCorpusTitle(entry.candidate.title);
    const group = byTitle.get(title) ?? [];
    group.push(entry);
    byTitle.set(title, group);
  }

  const collapsed: FusionEntry[] = [];
  for (const group of byTitle.values()) {
    const active = group.filter(entry => entry.candidate.activeVersion === true);
    collapsed.push(bestEntry(active.length > 0 ? active : group));
  }

  return collapsed
    .sort(compareEntries)
    .slice(0, input.limit)
    .map(entry => ({
      ...entry.candidate,
      normalizedTitle: normalizeCorpusTitle(entry.candidate.title),
      fusedScore: entry.fusedScore,
      lexicalRank: entry.lexicalRank,
      semanticRank: entry.semanticRank,
      semanticSimilarity: entry.semanticSimilarity,
      retrievalPaths: [...entry.retrievalPaths]
        .sort((left, right) => RETRIEVAL_PATH_ORDER[left] - RETRIEVAL_PATH_ORDER[right]),
    }));
}

export function activeVersionFromText(text: string): boolean | null {
  const match = text.match(/["']active["']\s*:\s*(true|false|1|0)/i);
  if (!match) return null;
  return match[1].toLocaleLowerCase() === 'true' || match[1] === '1';
}

export function normalizeCorpusTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function compareHybridResults(
  suite: CorpusRecallSuite,
  baseline: CorpusCaseResult[],
  hybrid: CorpusCaseResult[],
): HybridComparison {
  const hardIds = new Set(suite.cases
    .filter(item => item.kind === 'positive' && item.hard)
    .map(item => item.id));
  const exactIds = new Set(suite.cases
    .filter(item => item.kind === 'positive' && !item.hard)
    .map(item => item.id));
  const baselineById = new Map(baseline.map(item => [item.id, item]));
  const hybridById = new Map(hybrid.map(item => [item.id, item]));
  const hardBaselineMrr = mean([...hardIds].map(id => baselineById.get(id)?.reciprocalRank ?? 0));
  const hardHybridMrr = mean([...hardIds].map(id => hybridById.get(id)?.reciprocalRank ?? 0));
  const hardMrrRelativeGain = hardBaselineMrr === 0
    ? (hardHybridMrr > 0 ? 1 : 0)
    : round((hardHybridMrr - hardBaselineMrr) / hardBaselineMrr);
  const exactBaselineRecall = recall([...exactIds].map(id => baselineById.get(id)));
  const exactHybridRecall = recall([...exactIds].map(id => hybridById.get(id)));
  const exactRecallLoss = round(Math.max(0, exactBaselineRecall - exactHybridRecall));
  const duplicateRate = Math.max(0, ...hybrid.map(item => item.duplicateRate));
  const citationValidityRate = hybrid.length === 0
    ? 0
    : hybrid.filter(item => item.citationsValid).length / hybrid.length;
  const noAnswer = suite.cases.filter(item => item.kind === 'no_answer');
  const unsupportedAnswers = noAnswer.filter(item => !hybridById.get(item.id)?.passed).length;
  const unsupportedAnswerRate = noAnswer.length === 0 ? 0 : unsupportedAnswers / noAnswer.length;
  const latencies = hybrid.flatMap(item => item.elapsedMs).sort((a, b) => a - b);
  const p95Ms = percentile(latencies, 0.95);
  const reasons: string[] = [];
  if (hardIds.size === 0 || hardMrrRelativeGain < 0.15) reasons.push('hard_mrr_gain_below_15_percent');
  if (exactRecallLoss > 0.05) reasons.push('exact_recall_loss_above_5_percent');
  if (duplicateRate >= 0.1) reasons.push('duplicate_rate_at_or_above_10_percent');
  if (citationValidityRate < 1) reasons.push('invalid_citations');
  if (unsupportedAnswerRate > 0) reasons.push('unsupported_answer');
  if (p95Ms > suite.thresholds.maxP95Ms) reasons.push('p95_latency_above_budget');
  if (hybrid.some(item => !item.deterministic)) reasons.push('nondeterministic_ranking');

  return {
    passed: reasons.length === 0,
    hardBaselineMrr,
    hardHybridMrr,
    hardMrrRelativeGain,
    exactBaselineRecall,
    exactHybridRecall,
    exactRecallLoss,
    duplicateRate,
    citationValidityRate,
    unsupportedAnswerRate,
    p95Ms,
    reasons,
  };
}

function entryFor(bySegment: Map<number, FusionEntry>, candidate: HybridCandidate): FusionEntry {
  let entry = bySegment.get(candidate.segmentId);
  if (!entry) {
    entry = {
      candidate,
      fusedScore: 0,
      lexicalRank: null,
      semanticRank: null,
      semanticSimilarity: null,
      retrievalPaths: new Set(),
    };
    bySegment.set(candidate.segmentId, entry);
  }
  return entry;
}

function selectBest(entries: FusionEntry[], key: (entry: FusionEntry) => string): FusionEntry[] {
  const groups = new Map<string, FusionEntry[]>();
  for (const entry of entries) {
    const value = key(entry);
    const group = groups.get(value) ?? [];
    group.push(entry);
    groups.set(value, group);
  }
  return [...groups.values()].map(bestEntry);
}

function bestEntry(entries: FusionEntry[]): FusionEntry {
  return [...entries].sort(compareEntries)[0];
}

function compareEntries(left: FusionEntry, right: FusionEntry): number {
  return right.fusedScore - left.fusedScore
    || activePriority(right.candidate.activeVersion) - activePriority(left.candidate.activeVersion)
    || (right.candidate.updatedAt ?? '').localeCompare(left.candidate.updatedAt ?? '')
    || left.candidate.sourceId.localeCompare(right.candidate.sourceId)
    || left.candidate.segmentId - right.candidate.segmentId;
}

function activePriority(value: boolean | null): number {
  return value === true ? 2 : value === null ? 1 : 0;
}

function titleMatchesQuery(title: string, query: string): boolean {
  const normalizedTitle = normalizeComparable(title);
  const normalizedQuery = normalizeComparable(query);
  return normalizedQuery.length > 0
    && (normalizedTitle === normalizedQuery || normalizedTitle.endsWith(` ${normalizedQuery}`));
}

function normalizeComparable(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recall(results: Array<CorpusCaseResult | undefined>): number {
  return results.length === 0 ? 0 : results.filter(item => item?.hit).length / results.length;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

function round(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}
