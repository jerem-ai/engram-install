import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  executeCorpusRoute,
  loadCorpusRoutingPolicy,
  type CorpusRouteExecution,
} from './corpus-router.js';
import type { CorpusEmbeddingProvider } from './corpus-semantic-index.js';

export interface CorpusRoutingRuntimeOptions {
  registryPath: string;
  policyPath: string;
  semanticIndexDirectory: string;
  receiptPath: string;
  provider: CorpusEmbeddingProvider;
  autoRoutingEnabled?: boolean;
  forceLexical?: boolean;
  semanticMinSimilarity?: number;
  now?: () => Date;
}

export interface CorpusRoutingRequest {
  query: string;
  collectionIds?: string[];
  autoRoutingEnabled?: boolean;
  maxCollections?: number;
  limit: number;
  forceLexical?: boolean;
}

export interface CorpusRoutingRuntime {
  route(input: CorpusRoutingRequest): Promise<CorpusRouteExecution>;
}

interface CorpusRouteReceipt {
  schema: 'corpus-route-receipt.v1';
  generated_at: string;
  query_sha256: string;
  elapsed_ms: number;
  route: {
    selection_mode: CorpusRouteExecution['route']['selectionMode'];
    selected_collection_ids: string[];
    uncovered_need: boolean;
    reason: CorpusRouteExecution['route']['reason'];
  };
  collections: Array<{
    collection_id: string;
    requested_policy: string;
    served_policy: string;
    fallback_reason: string | null;
    served_status: string;
    served_evidence_count: number;
    served_elapsed_ms: number;
    shadow_mode: string | null;
    shadow_status: string | null;
    shadow_evidence_count: number;
    shadow_elapsed_ms: number | null;
    ranking_changed: boolean | null;
    budget_ms: number | null;
    budget_passed: boolean | null;
  }>;
}

export function createCorpusRoutingRuntime(
  options: CorpusRoutingRuntimeOptions,
): CorpusRoutingRuntime {
  const runtimeAutoRouting = options.autoRoutingEnabled ?? true;
  const runtimeForceLexical = options.forceLexical ?? false;
  return {
    async route(input): Promise<CorpusRouteExecution> {
      const started = performance.now();
      const policy = loadCorpusRoutingPolicy(readFileSync(options.policyPath, 'utf8'));
      const semanticIndexPaths = Object.fromEntries(policy.collections.map(collection => [
        collection.collectionId,
        join(options.semanticIndexDirectory, `${collection.collectionId}.sqlite3`),
      ]));
      const execution = await executeCorpusRoute({
        query: input.query,
        explicitCollectionIds: input.collectionIds,
        autoRoutingEnabled: runtimeAutoRouting
          && policy.defaults.autoRoutingEnabled
          && input.autoRoutingEnabled !== false,
        maxCollections: input.maxCollections,
        registryPath: options.registryPath,
        policy,
        semanticIndexPaths,
        provider: options.provider,
        limit: input.limit,
        semanticMinSimilarity: options.semanticMinSimilarity,
        forceLexical: runtimeForceLexical || input.forceLexical === true,
      });
      appendReceipt(
        options.receiptPath,
        receiptFor(execution, performance.now() - started, options.now?.() ?? new Date()),
      );
      return execution;
    },
  };
}

export function defaultCorpusRoutingPaths(): {
  policyPath: string;
  semanticIndexDirectory: string;
  receiptPath: string;
} {
  return {
    policyPath: process.env.CORPUS_ROUTING_POLICY_FILE
      ?? join(process.cwd(), 'benchmark', 'corpus-routing-policy.json'),
    semanticIndexDirectory: process.env.CORPUS_ROUTING_INDEX_DIR
      ?? join(homedir(), '.local', 'share', 'corpus-service', 'indexes'),
    receiptPath: process.env.CORPUS_ROUTING_RECEIPT_FILE
      ?? join(homedir(), '.local', 'share', 'knowledge-graph', 'corpus-routing.jsonl'),
  };
}

export function corpusRoutingFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be 0 or 1`);
}

function receiptFor(
  execution: CorpusRouteExecution,
  elapsedMs: number,
  now: Date,
): CorpusRouteReceipt {
  return {
    schema: 'corpus-route-receipt.v1',
    generated_at: now.toISOString(),
    query_sha256: createHash('sha256').update(execution.query).digest('hex'),
    elapsed_ms: roundMilliseconds(elapsedMs),
    route: {
      selection_mode: execution.route.selectionMode,
      selected_collection_ids: execution.route.selectedCollectionIds,
      uncovered_need: execution.route.uncoveredNeed,
      reason: execution.route.reason,
    },
    collections: execution.collections.map(collection => ({
      collection_id: collection.collectionId,
      requested_policy: collection.requestedPolicy,
      served_policy: collection.servedPolicy,
      fallback_reason: collection.fallbackReason,
      served_status: collection.served.result.status,
      served_evidence_count: collection.served.result.evidence.length,
      served_elapsed_ms: collection.served.elapsedMs,
      shadow_mode: collection.shadow?.mode ?? null,
      shadow_status: collection.shadow?.result.status ?? null,
      shadow_evidence_count: collection.shadow?.result.evidence.length ?? 0,
      shadow_elapsed_ms: collection.shadow?.elapsedMs ?? null,
      ranking_changed: collection.shadow?.rankingChanged ?? null,
      budget_ms: collection.maxQueryMs,
      budget_passed: collection.maxQueryMs === null
        ? null
        : (collection.served.elapsedMs + (collection.shadow?.elapsedMs ?? 0)) <= collection.maxQueryMs,
    })),
  };
}

function appendReceipt(path: string, receipt: CorpusRouteReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
