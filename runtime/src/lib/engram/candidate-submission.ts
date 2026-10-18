import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AccessContext } from '../access-context.js';
import type { MemoryAdmissionService, MemoryCandidate } from './admission.js';
import type { CreateNodeOptions, DurableNodeResult } from '../writer.js';

const CANDIDATE_SOURCE_DIR = 'EngramCandidates';

/**
 * Agent runtime that submitted a candidate. The server entry point sets it
 * from its own launcher, never from MCP arguments. It is a label for review,
 * not an authentication boundary: every submitter runs as the same operator.
 */
export type CandidateSubmitter = 'codex' | 'claude-code';

/**
 * Codex submitted candidates before attribution existed. Its source hash omits
 * the submitter so a Codex resubmission keeps the receipt it already has.
 */
const LEGACY_HASH_SUBMITTER: CandidateSubmitter = 'codex';

export interface CodexCandidateInput {
  submitter: CandidateSubmitter;
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId?: string;
  confidence?: number;
}

export interface CandidateSourceWriter {
  createOrReuseNode(options: CreateNodeOptions): DurableNodeResult;
  deleteSource(nodeId: string): 'deleted' | 'missing';
}

export interface CandidateSubmissionReceipt {
  status: 'quarantined';
  candidate_id: string;
  receipt_id: string;
  recallable: false;
  authority: 'none';
  origin: 'model_derived';
  submitter: CandidateSubmitter;
  tenant_id: string;
  principal_id: string;
  source_node_id: string;
  durable_source_node_id: string;
  source_disposition: 'created' | 'reused';
  created_at: string;
  updated_at: string;
}

export type CodexCandidateSubmission = CandidateSubmissionReceipt | {
  status: 'rejected';
  receipt_id: string;
  rejection_reason: 'credential_detected';
  recallable: false;
  authority: 'none';
  submitter: CandidateSubmitter;
  tenant_id: string;
  principal_id: string;
};

/**
 * Submit one model-derived candidate and persist a rebuildable vault record.
 *
 * The database write runs in one SQLite transaction with the writer's index
 * update. The vault file is removed if any later step fails, which prevents a
 * database-only candidate or a vault-only candidate source.
 */
export function submitCodexMemoryCandidate(
  db: Database.Database,
  accessContext: AccessContext,
  admission: MemoryAdmissionService,
  writer: CandidateSourceWriter,
  input: CodexCandidateInput,
): CodexCandidateSubmission {
  const normalized = normalizeInput(input);
  const sourceHash = candidateSourceHash(normalized);
  const sourceTitle = `candidate-${sourceHash}`;
  const durableSourceNodeId = `${CANDIDATE_SOURCE_DIR}/${sourceTitle}.md`;
  const candidateSourceNodeId = normalized.sourceNodeId ?? durableSourceNodeId;
  let createdSourceNodeId: string | undefined;

  try {
    return db.transaction(() => {
      const result = admission.submit(db, {
        origin: 'model_derived',
        subject: normalized.subject,
        predicate: normalized.predicate,
        object: normalized.object,
        confidence: normalized.confidence,
        sourceNodeId: candidateSourceNodeId,
        sourceHash,
      });

      if (result.status === 'rejected') {
        return {
          status: 'rejected' as const,
          receipt_id: result.receiptId,
          rejection_reason: result.reason,
          recallable: false as const,
          authority: 'none' as const,
          submitter: normalized.submitter,
          tenant_id: accessContext.tenantId,
          principal_id: accessContext.principalId,
        };
      }

      const source = writer.createOrReuseNode(candidateDocument(
        sourceTitle,
        result.candidate,
        normalized.sourceNodeId,
        sourceHash,
        normalized.submitter,
      ));
      if (source.disposition === 'created') createdSourceNodeId = source.sourceNodeId;
      if (source.sourceNodeId !== durableSourceNodeId) {
        throw new Error('Candidate source writer returned an unexpected path');
      }

      return {
        status: 'quarantined' as const,
        candidate_id: result.candidate.id,
        receipt_id: result.candidate.id,
        recallable: false as const,
        authority: 'none' as const,
        origin: 'model_derived' as const,
        submitter: normalized.submitter,
        tenant_id: accessContext.tenantId,
        principal_id: accessContext.principalId,
        source_node_id: candidateSourceNodeId,
        durable_source_node_id: source.sourceNodeId,
        source_disposition: source.disposition,
        created_at: result.candidate.created_at,
        updated_at: result.candidate.updated_at,
      };
    })();
  } catch (error) {
    if (createdSourceNodeId) {
      try {
        writer.deleteSource(createdSourceNodeId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Candidate submission failed and source cleanup also failed: ${createdSourceNodeId}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

function normalizeInput(input: CodexCandidateInput): Required<Omit<CodexCandidateInput, 'sourceNodeId'>> & {
  sourceNodeId?: string;
} {
  if (input.submitter !== 'codex' && input.submitter !== 'claude-code') {
    throw new Error('Candidate submitter is invalid');
  }
  return {
    submitter: input.submitter,
    subject: input.subject.trim(),
    predicate: input.predicate.trim(),
    object: input.object.trim(),
    confidence: input.confidence ?? 1,
    ...(input.sourceNodeId?.trim() ? { sourceNodeId: input.sourceNodeId.trim() } : {}),
  };
}

function candidateSourceHash(input: ReturnType<typeof normalizeInput>): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    origin: 'model_derived',
    ...(input.submitter === LEGACY_HASH_SUBMITTER ? {} : { submitter: input.submitter }),
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    confidence: input.confidence,
    source_node_id: input.sourceNodeId ?? null,
  })).digest('hex');
}

function candidateDocument(
  title: string,
  candidate: MemoryCandidate,
  requestedSourceNodeId: string | undefined,
  sourceHash: string,
  submitter: CandidateSubmitter,
): CreateNodeOptions {
  return {
    title,
    directory: CANDIDATE_SOURCE_DIR,
    frontmatter: {
      type: 'engram_memory_candidate',
      created: candidate.created_at,
      engram_candidate: {
        version: 1,
        candidate_id: candidate.id,
        origin: 'model_derived',
        submitter,
        trust_state: 'quarantined',
        subject: candidate.subject,
        predicate: candidate.predicate,
        object: candidate.object,
        confidence: candidate.confidence,
        source_node_id: requestedSourceNodeId ?? null,
        source_hash: sourceHash,
        recallable: false,
        authority: 'none',
      },
    },
    content: 'Quarantined Engram memory candidate. Separate review is required.\n',
  };
}
