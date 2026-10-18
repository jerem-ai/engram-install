import type { FederatedRecallResult } from './federated-corpus.js';

export interface CorpusRecallThresholds {
  minPositiveRecallAtK: number;
  maxDuplicateRate: number;
  maxP95Ms: number;
}

interface CorpusCaseBase {
  id: string;
  collectionId: string;
  query: string;
  k: number;
  why: string;
}

export interface CorpusPositiveCase extends CorpusCaseBase {
  kind: 'positive';
  expectedSourceIds: string[];
  hard: boolean;
}

export interface CorpusNoAnswerCase extends CorpusCaseBase {
  kind: 'no_answer';
}

export interface CorpusDiversityCase extends CorpusCaseBase {
  kind: 'diversity';
  maxPerNormalizedTitle: number;
}

export type CorpusRecallCase = CorpusPositiveCase | CorpusNoAnswerCase | CorpusDiversityCase;

export interface CorpusRecallSuite {
  schema: 'corpus-recall-suite.v1';
  defaults: { k: number; repeat: number };
  thresholds: CorpusRecallThresholds;
  cases: CorpusRecallCase[];
}

export interface CorpusCaseHit {
  segmentId: number;
  sourceId: string;
  title: string;
  citation: string;
  rank: number;
}

export interface CorpusCaseResult {
  id: string;
  kind: CorpusRecallCase['kind'];
  collectionId: string;
  query: string;
  k: number;
  passed: boolean;
  hit?: boolean;
  rank?: number | null;
  reciprocalRank?: number;
  citationsValid: boolean;
  deterministic: boolean;
  duplicateCount: number;
  duplicateRate: number;
  maxObservedPerNormalizedTitle: number;
  resultCount: number;
  elapsedMs: number[];
  top: CorpusCaseHit[];
  reasons: string[];
}

export interface CorpusSuiteSummary {
  positives: number;
  positiveHits: number;
  positiveRecallAtK: number;
  meanReciprocalRank: number;
  noAnswerCases: number;
  noAnswerPasses: number;
  unsupportedAnswerRate: number;
  diversityCases: number;
  uniqueSourceCount: number;
  uniqueSourceRate: number;
  duplicateCount: number;
  resultCount: number;
  duplicateRate: number;
  citations: number;
  validCitations: number;
  citationValidityRate: number;
  p50Ms: number;
  p95Ms: number;
  failedCaseIds: string[];
  invalidCitationCaseIds: string[];
  nondeterministicCaseIds: string[];
  thresholds: CorpusRecallThresholds;
}

type JsonObject = Record<string, unknown>;

export function loadCorpusSuite(text: string): CorpusRecallSuite {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Invalid corpus recall suite JSON');
  }
  if (!isObject(raw) || raw.schema !== 'corpus-recall-suite.v1') {
    throw new Error('Unsupported corpus recall suite');
  }
  const defaults = objectField(raw, 'defaults');
  const thresholds = objectField(raw, 'thresholds');
  const k = integerField(defaults, 'k', 1, 12);
  const repeat = integerField(defaults, 'repeat', 1, 5);
  const parsedThresholds: CorpusRecallThresholds = {
    minPositiveRecallAtK: numberField(thresholds, 'min_positive_recall_at_k', 0, 1),
    maxDuplicateRate: numberField(thresholds, 'max_duplicate_rate', 0, 1),
    maxP95Ms: numberField(thresholds, 'max_p95_ms', 1, 300_000),
  };
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error('Corpus recall suite cases must be a non-empty array');
  }
  const seen = new Set<string>();
  const cases = raw.cases.map((item, index) => parseCase(item, index, k, seen));
  if (!cases.some(item => item.kind === 'positive')) {
    throw new Error('Corpus recall suite requires a positive case');
  }
  if (!cases.some(item => item.kind === 'no_answer')) {
    throw new Error('Corpus recall suite requires a no-answer case');
  }
  return {
    schema: 'corpus-recall-suite.v1',
    defaults: { k, repeat },
    thresholds: parsedThresholds,
    cases,
  };
}

export function scoreCorpusCase(
  corpusCase: CorpusRecallCase,
  runs: FederatedRecallResult[],
  elapsedMs: number[],
): CorpusCaseResult {
  if (runs.length === 0 || runs.length !== elapsedMs.length) {
    throw new Error('Each corpus case requires matching result and latency runs');
  }
  const first = runs[0];
  const top = first.evidence.slice(0, corpusCase.k).map(item => ({
    segmentId: item.segment_id,
    sourceId: item.source_id,
    title: item.title,
    citation: item.timestamp_url,
    rank: item.rank,
  }));
  const citationsValid = runs.every(run => run.evidence.every(item => safeCitation(item.timestamp_url)));
  const signatures = runs.map(run => resultSignature(run, corpusCase.k));
  const deterministic = signatures.every(value => value === signatures[0]);
  const titleCounts = new Map<string, number>();
  for (const item of top) {
    const key = normalizeTitle(item.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const duplicateCount = [...titleCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const resultCount = top.length;
  const duplicateRate = resultCount === 0 ? 0 : duplicateCount / resultCount;
  const maxObservedPerNormalizedTitle = Math.max(0, ...titleCounts.values());
  const reasons: string[] = [];
  let passed = citationsValid && deterministic;
  let hit: boolean | undefined;
  let rank: number | null | undefined;
  let reciprocalRank: number | undefined;

  if (!citationsValid) reasons.push('invalid_citation');
  if (!deterministic) reasons.push('nondeterministic_ranking');

  if (corpusCase.kind === 'positive') {
    const wanted = new Set(corpusCase.expectedSourceIds);
    const index = top.findIndex(item => wanted.has(item.sourceId));
    rank = index < 0 ? null : index + 1;
    hit = rank !== null && first.status === 'evidence_found';
    reciprocalRank = rank === null ? 0 : 1 / rank;
    if (!hit) reasons.push('expected_source_missing');
    passed = passed && hit;
  } else if (corpusCase.kind === 'no_answer') {
    const refused = runs.every(run => run.status === 'no_reliable_evidence' && run.evidence.length === 0);
    if (!refused) reasons.push('unexpected_evidence');
    passed = passed && refused;
  } else {
    const diverse = maxObservedPerNormalizedTitle <= corpusCase.maxPerNormalizedTitle;
    if (!diverse) reasons.push('duplicate_title_limit_exceeded');
    passed = passed && diverse;
  }

  return {
    id: corpusCase.id,
    kind: corpusCase.kind,
    collectionId: corpusCase.collectionId,
    query: corpusCase.query,
    k: corpusCase.k,
    passed,
    hit,
    rank,
    reciprocalRank,
    citationsValid,
    deterministic,
    duplicateCount,
    duplicateRate,
    maxObservedPerNormalizedTitle,
    resultCount,
    elapsedMs,
    top,
    reasons,
  };
}

export function summarizeCorpusResults(
  results: CorpusCaseResult[],
  thresholds: CorpusRecallThresholds,
): CorpusSuiteSummary {
  const positives = results.filter(item => item.kind === 'positive');
  const noAnswers = results.filter(item => item.kind === 'no_answer');
  const diversity = results.filter(item => item.kind === 'diversity');
  const positiveHits = positives.filter(item => item.hit).length;
  const duplicateCount = results.reduce((sum, item) => sum + item.duplicateCount, 0);
  const resultCount = results.reduce((sum, item) => sum + item.resultCount, 0);
  const uniqueSourceCount = results.reduce((sum, item) => (
    sum + new Set(item.top.map(hit => hit.sourceId)).size
  ), 0);
  const citations = results.reduce((sum, item) => sum + item.top.length, 0);
  const validCitations = results.reduce((sum, item) => (
    sum + item.top.filter(hit => safeCitation(hit.citation)).length
  ), 0);
  const latencies = results.flatMap(item => item.elapsedMs).sort((a, b) => a - b);
  return {
    positives: positives.length,
    positiveHits,
    positiveRecallAtK: positives.length === 0 ? 0 : positiveHits / positives.length,
    meanReciprocalRank: positives.length === 0
      ? 0
      : positives.reduce((sum, item) => sum + (item.reciprocalRank ?? 0), 0) / positives.length,
    noAnswerCases: noAnswers.length,
    noAnswerPasses: noAnswers.filter(item => item.passed).length,
    unsupportedAnswerRate: noAnswers.length === 0
      ? 0
      : noAnswers.filter(item => !item.passed).length / noAnswers.length,
    diversityCases: diversity.length,
    uniqueSourceCount,
    uniqueSourceRate: resultCount === 0 ? 1 : uniqueSourceCount / resultCount,
    duplicateCount,
    resultCount,
    duplicateRate: resultCount === 0 ? 0 : duplicateCount / resultCount,
    citations,
    validCitations,
    citationValidityRate: citations === 0 ? 1 : validCitations / citations,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    failedCaseIds: results.filter(item => !item.passed).map(item => item.id),
    invalidCitationCaseIds: results.filter(item => !item.citationsValid).map(item => item.id),
    nondeterministicCaseIds: results.filter(item => !item.deterministic).map(item => item.id),
    thresholds,
  };
}

export function corpusGatePasses(summary: CorpusSuiteSummary): boolean {
  return summary.positives > 0
    && summary.noAnswerCases > 0
    && summary.failedCaseIds.length === 0
    && summary.positiveRecallAtK >= summary.thresholds.minPositiveRecallAtK
    && summary.duplicateRate <= summary.thresholds.maxDuplicateRate
    && summary.p95Ms <= summary.thresholds.maxP95Ms;
}

function parseCase(value: unknown, index: number, defaultK: number, seen: Set<string>): CorpusRecallCase {
  if (!isObject(value)) throw new Error(`Invalid corpus recall case at index ${index}`);
  const id = textField(value, 'id', /^[a-z][a-z0-9_-]{0,63}$/);
  if (seen.has(id)) throw new Error(`Duplicate corpus recall case ID: ${id}`);
  seen.add(id);
  const collectionId = textField(value, 'collection_id', /^[a-z][a-z0-9_-]{0,63}$/);
  const query = textField(value, 'query');
  if (query.length > 1000) throw new Error(`Corpus recall query exceeds 1000 characters: ${id}`);
  const why = textField(value, 'why');
  const k = value.k === undefined ? defaultK : integerField(value, 'k', 1, 12);
  const base = { id, collectionId, query, k, why };
  if (value.kind === 'positive') {
    if (!Array.isArray(value.expected_source_ids) || value.expected_source_ids.length === 0
      || !value.expected_source_ids.every(item => typeof item === 'string' && item.length > 0)) {
      throw new Error(`Positive corpus recall case requires expected_source_ids: ${id}`);
    }
    return {
      ...base,
      kind: 'positive',
      expectedSourceIds: [...new Set(value.expected_source_ids as string[])],
      hard: value.hard === true,
    };
  }
  if (value.kind === 'no_answer') return { ...base, kind: 'no_answer' };
  if (value.kind === 'diversity') {
    return {
      ...base,
      kind: 'diversity',
      maxPerNormalizedTitle: integerField(value, 'max_per_normalized_title', 1, k),
    };
  }
  throw new Error(`Unsupported corpus recall case kind: ${id}`);
}

function resultSignature(result: FederatedRecallResult, k: number): string {
  return JSON.stringify({
    status: result.status,
    evidence: result.evidence.slice(0, k).map(item => [
      item.segment_id, item.source_id, item.title, item.timestamp_url, item.rank,
    ]),
  });
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function safeCitation(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectField(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  if (!isObject(field)) throw new Error(`Corpus recall suite ${key} must be an object`);
  return field;
}

function textField(value: JsonObject, key: string, pattern?: RegExp): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim() || (pattern && !pattern.test(field))) {
    throw new Error(`Invalid corpus recall suite ${key}`);
  }
  return field.trim();
}

function integerField(value: JsonObject, key: string, min: number, max: number): number {
  const field = value[key];
  if (!Number.isInteger(field) || (field as number) < min || (field as number) > max) {
    throw new Error(`Invalid corpus recall suite ${key}`);
  }
  return field as number;
}

function numberField(value: JsonObject, key: string, min: number, max: number): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < min || field > max) {
    throw new Error(`Invalid corpus recall suite ${key}`);
  }
  return field;
}
