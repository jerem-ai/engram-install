import { existsSync } from 'node:fs';
import {
  recallFederatedEvidence,
  type FederatedEvidence,
  type FederatedRecallResult,
} from './federated-corpus.js';
import { createGenericCorpusAdapter } from './corpus-adapter.js';
import {
  activeVersionFromText,
  fuseHybridCandidates,
  type HybridCandidate,
  type SemanticHybridCandidate,
} from './corpus-hybrid.js';
import {
  queryCorpusSemanticIndex,
  type CorpusEmbeddingProvider,
} from './corpus-semantic-index.js';

const MAX_FUSION_CANDIDATES = 12;

export interface HybridCorpusRecallInput {
  collectionId: string;
  domain: string;
  databasePath: string;
  sourceDatabaseSha256: string;
  semanticIndexPath: string;
  provider: CorpusEmbeddingProvider;
  query: string;
  limit: number;
  semanticMinSimilarity: number;
}

export interface HybridCorpusRecallExecution {
  mode: 'hybrid' | 'lexical_degraded';
  semanticError?: 'semantic_index_unavailable' | 'semantic_index_invalid';
  result: FederatedRecallResult;
}

export async function recallHybridCorpus(
  input: HybridCorpusRecallInput,
): Promise<HybridCorpusRecallExecution> {
  const cleanQuery = input.query.trim();
  const limit = normalizeLimit(input.limit);
  const lexicalResult = recallFederatedEvidence(
    createGenericCorpusAdapter(input.collectionId, input.domain),
    input.databasePath,
    cleanQuery,
    MAX_FUSION_CANDIDATES,
  );
  if (lexicalResult.status === 'source_unavailable') {
    return { mode: 'lexical_degraded', result: lexicalResult };
  }

  const lexicalEvidence = new Map(
    lexicalResult.evidence.map(item => [item.segment_id, item]),
  );
  const lexical = lexicalResult.evidence.map(candidateFromEvidence);
  let mode: HybridCorpusRecallExecution['mode'] = 'hybrid';
  let semanticError: HybridCorpusRecallExecution['semanticError'];
  let semantic: SemanticHybridCandidate[] = [];

  if (!existsSync(input.semanticIndexPath)) {
    mode = 'lexical_degraded';
    semanticError = 'semantic_index_unavailable';
  } else {
    try {
      const queryEmbedding = await input.provider.embed(cleanQuery);
      semantic = queryCorpusSemanticIndex(input.semanticIndexPath, queryEmbedding, {
        expectedCollectionId: input.collectionId,
        expectedSourceDatabaseSha256: input.sourceDatabaseSha256,
        limit: MAX_FUSION_CANDIDATES,
      });
    } catch {
      mode = 'lexical_degraded';
      semanticError = 'semantic_index_invalid';
    }
  }

  const fused = fuseHybridCandidates({
    query: cleanQuery,
    lexical,
    semantic,
    limit,
    semanticMinSimilarity: input.semanticMinSimilarity,
  });
  const evidence = fused.map(item => {
    const original = lexicalEvidence.get(item.segmentId);
    if (original) {
      return { ...original, rank: roundedRank(item.fusedScore) };
    }
    return {
      segment_id: item.segmentId,
      source_kind: sourceKind(item.citation),
      source_id: item.sourceId,
      title: item.title,
      published_at: null,
      timestamp_seconds: timestampSeconds(item.citation),
      timestamp_url: item.citation,
      excerpt: item.excerpt,
      source_scope: 'included' as const,
      rank: roundedRank(item.fusedScore),
      claims: [],
    };
  });

  const result: FederatedRecallResult = evidence.length === 0
    ? {
        status: 'no_reliable_evidence',
        authority: 'informational_only',
        domain: input.domain,
        query: cleanQuery,
        source: lexicalResult.source,
        answer_contract: {
          action: 'do_not_answer_from_this_source',
          note: `No included ${input.domain} evidence cleared the hybrid retrieval threshold.`,
        },
        evidence: [],
      }
    : {
        status: 'evidence_found',
        authority: 'informational_only',
        domain: input.domain,
        query: cleanQuery,
        source: lexicalResult.source,
        answer_contract: {
          action: 'synthesize_with_citations',
          note: 'Cite the returned evidence. Check collection freshness before using time-sensitive observations.',
        },
        evidence,
      };

  return { mode, ...(semanticError ? { semanticError } : {}), result };
}

function candidateFromEvidence(item: FederatedEvidence): HybridCandidate {
  return {
    segmentId: item.segment_id,
    documentId: item.segment_id,
    sourceId: item.source_id,
    title: item.title,
    citation: item.timestamp_url,
    excerpt: item.excerpt,
    scope: 'included',
    activeVersion: activeVersionFromText(item.excerpt),
    updatedAt: item.published_at,
  };
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error('Hybrid result limit must be an integer from 1 to 12');
  }
  return value;
}

function sourceKind(citation: string): string {
  if (/[?&]t=\d+s(?:&|$)/.test(citation)) return 'video';
  if (/#post-\d+$/.test(citation)) return 'forum_post';
  return 'document';
}

function timestampSeconds(citation: string): number | null {
  const match = citation.match(/[?&]t=(\d+)s(?:&|$)/);
  return match ? Number(match[1]) : null;
}

function roundedRank(score: number): number {
  return Number((-score).toFixed(12));
}
