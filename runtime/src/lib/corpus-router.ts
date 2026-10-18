import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  recallFederatedEvidence,
  type FederatedRecallResult,
} from './federated-corpus.js';
import { createGenericCorpusAdapter } from './corpus-adapter.js';
import { recallHybridCorpus } from './corpus-hybrid-recall.js';
import { loadCorpusRegistry } from './corpus-registry.js';
import type { CorpusEmbeddingProvider } from './corpus-semantic-index.js';

export type CorpusRetrievalPolicy = 'lexical' | 'hybrid' | 'shadow';
export type CorpusIndexPolicy = 'none' | 'digest_bound_optional';
export type CorpusTemporalBehavior = 'current' | 'historical' | 'mixed';

export interface CorpusRoutingCollection {
  collectionId: string;
  domain: string;
  queryTypes: string[];
  temporalBehavior: CorpusTemporalBehavior;
  evidenceClasses: string[];
  retrievalPolicy: CorpusRetrievalPolicy;
  indexPolicy: CorpusIndexPolicy;
  routingTerms: string[];
  maxQueryMs: number;
}

export interface CorpusRoutingPolicy {
  schema: 'corpus-routing-policy.v1';
  defaults: {
    maxCollections: number;
    autoRoutingEnabled: boolean;
  };
  collections: CorpusRoutingCollection[];
}

export interface CorpusRouteCandidate {
  collectionId: string;
  score: number;
  matchedTerms: string[];
}

export interface CorpusRoutePlan {
  selectionMode: 'automatic' | 'explicit' | 'disabled';
  selectedCollectionIds: string[];
  candidates: CorpusRouteCandidate[];
  uncoveredNeed: boolean;
  reason: 'no_matching_collection' | 'automatic_routing_disabled' | null;
}

export interface PlanCorpusRouteInput {
  query: string;
  explicitCollectionIds?: string[];
  autoRoutingEnabled?: boolean;
  maxCollections?: number;
}

export interface ExecuteCorpusRouteInput extends PlanCorpusRouteInput {
  registryPath: string;
  policy: CorpusRoutingPolicy;
  semanticIndexPaths: Record<string, string | undefined>;
  sourceDatabaseSha256?: Record<string, string | undefined>;
  provider: CorpusEmbeddingProvider;
  limit: number;
  semanticMinSimilarity?: number;
  forceLexical?: boolean;
}

export interface CorpusRouteExecution {
  query: string;
  route: CorpusRoutePlan;
  collections: CorpusCollectionExecution[];
  synthesis: {
    status: 'consumer_required';
    collectionResultsRemainSeparate: true;
  };
}

export interface TimedCorpusResult {
  elapsedMs: number;
  result: FederatedRecallResult;
}

export interface CorpusCollectionExecution {
  collectionId: string;
  domain: string;
  requestedPolicy: CorpusRetrievalPolicy;
  servedPolicy: 'lexical' | 'hybrid';
  fallbackReason: 'forced_lexical' | 'semantic_index_unavailable' | 'semantic_index_invalid' | null;
  maxQueryMs: number | null;
  served: TimedCorpusResult;
  shadow?: TimedCorpusResult & {
    mode: 'hybrid' | 'lexical_degraded';
    rankingChanged: boolean;
  };
}

type JsonObject = Record<string, unknown>;

export function loadCorpusRoutingPolicy(text: string): CorpusRoutingPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Invalid corpus routing policy JSON');
  }
  if (!isObject(raw)
    || raw.schema !== 'corpus-routing-policy.v1'
    || !isObject(raw.defaults)
    || !Array.isArray(raw.collections)
    || raw.collections.length === 0) {
    throw new Error('Unsupported corpus routing policy');
  }
  const defaults = {
    maxCollections: integerField(raw.defaults, 'max_collections', 1, 8),
    autoRoutingEnabled: booleanField(raw.defaults, 'auto_routing_enabled'),
  };
  const seen = new Set<string>();
  const collections = raw.collections.map(value => parseCollection(value, seen));
  return { schema: 'corpus-routing-policy.v1', defaults, collections };
}

export function planCorpusRoute(
  policy: CorpusRoutingPolicy,
  registeredCollectionIds: string[],
  input: PlanCorpusRouteInput,
): CorpusRoutePlan {
  const registered = new Set(registeredCollectionIds);
  const maxCollections = input.maxCollections ?? policy.defaults.maxCollections;
  if (!Number.isInteger(maxCollections) || maxCollections < 1 || maxCollections > 8) {
    throw new Error('Route collection limit must be an integer from 1 to 8');
  }
  if (maxCollections > policy.defaults.maxCollections) {
    throw new Error('Route request exceeds the configured collection limit');
  }

  if (input.explicitCollectionIds !== undefined) {
    const selected = [...new Set(input.explicitCollectionIds)];
    if (selected.length === 0 || selected.length > maxCollections) {
      throw new Error('Explicit corpus selection exceeds the collection limit');
    }
    const unknown = selected.filter(id => !registered.has(id));
    if (unknown.length > 0) throw new Error(`Unknown corpus collection: ${unknown.join(', ')}`);
    return {
      selectionMode: 'explicit',
      selectedCollectionIds: selected,
      candidates: selected.map(collectionId => ({ collectionId, score: 0, matchedTerms: [] })),
      uncoveredNeed: false,
      reason: null,
    };
  }

  const autoRoutingEnabled = input.autoRoutingEnabled ?? policy.defaults.autoRoutingEnabled;
  if (!autoRoutingEnabled) {
    return {
      selectionMode: 'disabled',
      selectedCollectionIds: [],
      candidates: [],
      uncoveredNeed: true,
      reason: 'automatic_routing_disabled',
    };
  }

  const query = normalize(input.query);
  const candidates = policy.collections
    .filter(collection => registered.has(collection.collectionId))
    .map(collection => candidateFor(collection, query))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || left.collectionId.localeCompare(right.collectionId));
  const selectedCollectionIds = candidates.slice(0, maxCollections).map(item => item.collectionId);
  return {
    selectionMode: 'automatic',
    selectedCollectionIds,
    candidates,
    uncoveredNeed: selectedCollectionIds.length === 0,
    reason: selectedCollectionIds.length === 0 ? 'no_matching_collection' : null,
  };
}

export async function executeCorpusRoute(
  input: ExecuteCorpusRouteInput,
): Promise<CorpusRouteExecution> {
  const registry = loadCorpusRegistry(input.registryPath).filter(item => item.enabled);
  const route = planCorpusRoute(input.policy, registry.map(item => item.id), input);
  const policyById = new Map(input.policy.collections.map(item => [item.collectionId, item]));
  const collections: CorpusCollectionExecution[] = [];

  for (const collectionId of route.selectedCollectionIds) {
    const registration = registry.find(item => item.id === collectionId)!;
    const collectionPolicy = policyById.get(collectionId);
    const requestedPolicy = collectionPolicy?.retrievalPolicy ?? 'lexical';
    const adapter = createGenericCorpusAdapter(collectionId, registration.name);
    const lexicalStarted = performance.now();
    const lexicalResult = recallFederatedEvidence(
      adapter,
      registration.database_path,
      input.query,
      input.limit,
    );
    const lexical = {
      elapsedMs: roundMilliseconds(performance.now() - lexicalStarted),
      result: lexicalResult,
    };

    if (input.forceLexical || requestedPolicy === 'lexical') {
      collections.push({
        collectionId,
        domain: collectionPolicy?.domain ?? registration.name,
        requestedPolicy,
        servedPolicy: 'lexical',
        fallbackReason: input.forceLexical && requestedPolicy !== 'lexical' ? 'forced_lexical' : null,
        maxQueryMs: collectionPolicy?.maxQueryMs ?? null,
        served: lexical,
      });
      continue;
    }

    const sourceDatabaseSha256 = input.sourceDatabaseSha256?.[collectionId]
      ?? await sha256File(registration.database_path);
    const hybridStarted = performance.now();
    const hybrid = await recallHybridCorpus({
      collectionId,
      domain: registration.name,
      databasePath: registration.database_path,
      sourceDatabaseSha256,
      semanticIndexPath: input.semanticIndexPaths[collectionId]
        ?? `/__corpus_semantic_index_unavailable__/${collectionId}`,
      provider: input.provider,
      query: input.query,
      limit: input.limit,
      semanticMinSimilarity: input.semanticMinSimilarity ?? 0.3,
    });
    const hybridTimed = {
      elapsedMs: roundMilliseconds(performance.now() - hybridStarted),
      result: hybrid.result,
    };

    if (requestedPolicy === 'shadow') {
      collections.push({
        collectionId,
        domain: collectionPolicy?.domain ?? registration.name,
        requestedPolicy,
        servedPolicy: 'lexical',
        fallbackReason: hybrid.semanticError ?? null,
        maxQueryMs: collectionPolicy?.maxQueryMs ?? null,
        served: lexical,
        shadow: {
          ...hybridTimed,
          mode: hybrid.mode,
          rankingChanged: rankingSignature(lexicalResult) !== rankingSignature(hybrid.result),
        },
      });
      continue;
    }

    const hybridAvailable = hybrid.mode === 'hybrid';
    collections.push({
      collectionId,
      domain: collectionPolicy?.domain ?? registration.name,
      requestedPolicy,
      servedPolicy: hybridAvailable ? 'hybrid' : 'lexical',
      fallbackReason: hybrid.semanticError ?? null,
      maxQueryMs: collectionPolicy?.maxQueryMs ?? null,
      served: hybridAvailable ? hybridTimed : lexical,
    });
  }

  return {
    query: input.query.trim(),
    route,
    collections,
    synthesis: { status: 'consumer_required', collectionResultsRemainSeparate: true },
  };
}

function parseCollection(value: unknown, seen: Set<string>): CorpusRoutingCollection {
  if (!isObject(value)) throw new Error('Invalid corpus routing collection');
  try {
    const collectionId = textField(value, 'collection_id', /^[a-z][a-z0-9_-]{0,63}$/);
    if (seen.has(collectionId)) throw new Error(`Duplicate corpus routing collection: ${collectionId}`);
    seen.add(collectionId);
    const temporalBehavior = enumField(
      value,
      'temporal_behavior',
      ['current', 'historical', 'mixed'] as const,
    );
    const retrievalPolicy = enumField(
      value,
      'retrieval_policy',
      ['lexical', 'hybrid', 'shadow'] as const,
    );
    const indexPolicy = enumField(
      value,
      'index_policy',
      ['none', 'digest_bound_optional'] as const,
    );
    return {
      collectionId,
      domain: textField(value, 'domain'),
      queryTypes: textArray(value, 'query_types'),
      temporalBehavior,
      evidenceClasses: textArray(value, 'evidence_classes'),
      retrievalPolicy,
      indexPolicy,
      routingTerms: textArray(value, 'routing_terms', 128),
      maxQueryMs: integerField(value, 'max_query_ms', 1, 300_000),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Duplicate corpus routing collection:')) {
      throw error;
    }
    throw new Error('Invalid corpus routing collection', { cause: error });
  }
}

function candidateFor(
  collection: CorpusRoutingCollection,
  normalizedQuery: string,
): CorpusRouteCandidate {
  const matchedTerms = collection.routingTerms.filter(term => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length > 0 && containsTerm(normalizedQuery, normalizedTerm);
  });
  const score = matchedTerms.reduce((sum, term) => (
    sum + Math.max(1, normalize(term).split(' ').length * 2)
  ), 0);
  return { collectionId: collection.collectionId, score, matchedTerms };
}

function containsTerm(query: string, term: string): boolean {
  return ` ${query} `.includes(` ${term} `);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)?.join(' ') ?? '';
}

function rankingSignature(result: FederatedRecallResult): string {
  return JSON.stringify(result.evidence.map(item => [item.segment_id, item.source_id]));
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(value: JsonObject, key: string, pattern?: RegExp): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim() || field.length > 500) {
    throw new Error(`Invalid ${key}`);
  }
  const trimmed = field.trim();
  if (pattern && !pattern.test(trimmed)) throw new Error(`Invalid ${key}`);
  return trimmed;
}

function textArray(value: JsonObject, key: string, maxItems = 32): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.length === 0 || field.length > maxItems) {
    throw new Error(`Invalid ${key}`);
  }
  const values = field.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > 200) {
      throw new Error(`Invalid ${key}`);
    }
    return item.trim();
  });
  if (new Set(values.map(normalize)).size !== values.length) throw new Error(`Duplicate ${key}`);
  return values;
}

function integerField(value: JsonObject, key: string, min: number, max: number): number {
  const field = value[key];
  if (!Number.isInteger(field) || (field as number) < min || (field as number) > max) {
    throw new Error(`Invalid ${key}`);
  }
  return field as number;
}

function booleanField(value: JsonObject, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') throw new Error(`Invalid ${key}`);
  return field;
}

function enumField<const Values extends readonly string[]>(
  value: JsonObject,
  key: string,
  allowed: Values,
): Values[number] {
  const field = value[key];
  if (typeof field !== 'string' || !allowed.includes(field)) throw new Error(`Invalid ${key}`);
  return field as Values[number];
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
