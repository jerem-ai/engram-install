import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Store } from '../lib/store.js';
import { VaultWriter } from '../lib/writer.js';
import type { AccessContext } from '../lib/access-context.js';
import { retireSource } from '../lib/engram/source-retirement.js';
import { getMemoryCandidate, type MemoryAdmissionService } from '../lib/engram/admission.js';
import {
  submitCodexMemoryCandidate,
  type CandidateSourceWriter,
  type CandidateSubmitter,
} from '../lib/engram/candidate-submission.js';
import { engramRecall, engramExplain } from '../lib/engram/recall.js';
import { engramProfile } from '../lib/engram/verbs.js';
import { connectionReceipt, engramStatus } from '../lib/engram/status.js';
import type { ToolAuthorizer } from '../security/authorization.js';
import type { VerifiedRequestIdentity } from '../security/request-identity.js';

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const candidateWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface CodexEngramServerOptions {
  /** Fixed by the entry point. Clients cannot set or override it. */
  submitter: CandidateSubmitter;
  accessContext: AccessContext;
  dbPath: string;
  vaultPath: string;
  memoryAdmission: MemoryAdmissionService;
  authorizer: ToolAuthorizer;
  identityFactory: () => VerifiedRequestIdentity;
  candidateWriter?: CandidateSourceWriter;
  instanceId?: string;
  /**
   * Which memory sources the reads may cite. 'promoted_only' (the default, and what
   * Jeremy's servers run) cites only sources promoted through review. A local
   * install sets 'legacy' in engram.env (ENGRAM_MCP_ADMISSION), the posture the
   * operator's own stdio and HTTP surfaces already use (see local-admission.ts), so
   * its own extracted memories are recallable. Memory stays informational only.
   */
  readAdmission?: 'legacy' | 'promoted_only';
}

/**
 * Least-privilege Engram server for trusted agent stdio sessions (Codex and
 * Claude Code). Each entry point fixes its own `submitter` attribution.
 *
 * This factory intentionally registers only promoted-only Engram reads and
 * candidate submission. A submitted fact self-admits when automatic checks
 * pass (MemoryAdmissionService.selfAdmit). It has no promotion, rejection, graph mutation,
 * indexing, retention, export, backup, consent, or destructive tools.
 */
export function createCodexEngramServer(options: CodexEngramServerOptions): McpServer {
  const store = new Store(options.dbPath, options.accessContext);
  const writer = options.candidateWriter ?? new VaultWriter(options.vaultPath, store);
  const server = new McpServer({ name: 'engram', version: '1.0.0' });
  const admission = options.readAdmission ?? 'promoted_only';
  server.server.onclose = () => {
    if (store.db.open) store.close();
  };

  const readResult = (result: unknown) => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        result,
        connection: connectionReceipt(engramStatus(store.db, {
          access: 'candidate_submit',
          instanceId: options.instanceId,
        })),
      }, null, 2),
    }],
  });

  server.registerTool('engram_recall', {
    title: 'Recall Engram Memory',
    description: 'Search promoted Engram assertions for cited evidence. Quarantined candidates are excluded.',
    inputSchema: z.object({
      query: z.string().trim().min(1).describe('Natural-language memory query'),
      min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence (default 0.5)'),
      mode: z.enum(['current', 'historical', 'audit']).optional().describe('Recall mode (default current)'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum evidence items (default 10)'),
    }).strict(),
    annotations: readAnnotations,
  }, async ({ query, min_confidence, mode, limit }) => readResult(engramRecall(store.db, {
    query,
    minConfidence: min_confidence ?? 0.5,
    mode: mode ?? 'current',
    maxResults: limit ?? 10,
    admission,
  })));

  server.registerTool('engram_explain', {
    title: 'Explain Engram Evidence',
    description: 'Explain the provenance and confidence of one promoted assertion.',
    inputSchema: z.object({
      assertion_id: z.string().trim().min(1).describe('Assertion ID returned by engram_recall'),
    }).strict(),
    annotations: readAnnotations,
  }, async ({ assertion_id }) => readResult(engramExplain(store.db, assertion_id, {
    admission,
  })));

  server.registerTool('engram_profile', {
    title: 'Read Engram Profile',
    description: 'Read the promoted preferences, constraints, environment, and active-project profile.',
    inputSchema: z.object({}).strict(),
    annotations: readAnnotations,
  }, async () => readResult(engramProfile(store.db, { admission })));

  server.registerTool('engram_status', {
    title: 'Check Engram Connection',
    description: 'Verify the Engram instance, tenant-bound connection, corpus revision, and database health.',
    inputSchema: z.object({}).strict(),
    annotations: readAnnotations,
  }, async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        ...engramStatus(store.db, {
          access: 'candidate_submit',
          instanceId: options.instanceId,
        }),
        identity: {
          tenant_id: options.accessContext.tenantId,
          principal_id: options.accessContext.principalId,
        },
      }, null, 2),
    }],
  }));

  server.registerTool('engram_remember', {
    title: 'Submit Engram Memory Candidate',
    description: 'Submit one fact you learned. It is admitted to recall at once when automatic checks pass: no credential-shaped text, and source_node_id names an indexed vault note. Without a source the fact stays quarantined; a held fact is retried after each index. To correct a wrong fact, submit the corrected fact and name the old memory note in supersedes.',
    inputSchema: z.object({
      subject: z.string().trim().min(1).max(4096),
      predicate: z.string().trim().min(1).max(4096),
      object: z.string().trim().min(1).max(4096),
      source_node_id: z.string().trim().min(1).max(4096).optional()
        .describe('Vault-relative path of the indexed note that supports the fact, such as Sessions/2026-10-04-alfred-topic-laptop.md. Required for admission. It does not grant trust.'),
      supersedes: z.string().trim().min(1).max(4096).optional()
        .describe('Vault-relative path of a Memory/ note this fact corrects. Once the fact is admitted, that note leaves memory search and the recall hook, and engram_recall treats its facts as historical. The note file is not edited.'),
      confidence: z.number().min(0).max(1).optional(),
    }).strict(),
    annotations: candidateWriteAnnotations,
  }, async ({ subject, predicate, object, source_node_id, supersedes, confidence }) => {
    const identity = options.identityFactory();
    if (identity.accessContext.tenantId !== options.accessContext.tenantId) {
      throw new Error('Candidate submitter tenant does not match database context');
    }
    if (identity.accessContext.principalId !== options.accessContext.principalId) {
      throw new Error('Candidate submitter principal does not match database context');
    }
    const decision = options.authorizer.authorize(identity, 'engram_remember');
    if (!decision.allowed) {
      throw new Error(`Memory candidate authorization denied: ${decision.reason}`);
    }

    const result = submitCodexMemoryCandidate(
      store.db,
      options.accessContext,
      options.memoryAdmission,
      writer,
      { submitter: options.submitter, subject, predicate, object, sourceNodeId: source_node_id, confidence },
    );
    // Agents admit their own facts (2026-10-04); a held fact stays quarantined for the index sweep.
    let admitted: Record<string, unknown> = {};
    if (result.status === 'quarantined' && options.memoryAdmission.selfAdmission) {
      const vaultWriter = typeof (writer as Partial<VaultWriter>).createNode === 'function' ? writer as VaultWriter : undefined;
      const a = options.memoryAdmission.selfAdmit(store.db, result.candidate_id, { writer: vaultWriter });
      const already = a.status === 'held' && a.reason === 'not_quarantined'
        && getMemoryCandidate(store.db, result.candidate_id)?.trust_state === 'promoted';
      admitted = a.status === 'admitted'
        ? { status: 'admitted', recallable: true, authority: 'informational_only', admitted_source_node_id: a.sourceNodeId,
            assertion_id: a.assertionId, admission_receipt_id: a.receiptId }
        : already ? { status: 'admitted', recallable: true, authority: 'informational_only' }
          : { admission_hold: a.reason };
      if (supersedes) {
        // A resubmitted fact that is already admitted can still retire the note it corrects.
        const prior = already ? getMemoryCandidate(store.db, result.candidate_id) : undefined;
        const correction = a.status === 'admitted' ? { assertionId: a.assertionId, sourceNodeId: a.sourceNodeId }
          : prior?.assertion_id ? { assertionId: prior.assertion_id, sourceNodeId: prior.source_node_id ?? undefined } : null;
        admitted.supersedes = correction
          ? (vaultWriter
            ? retireSource(store.db, vaultWriter, { sourceNodeId: supersedes, retiredBy: correction.assertionId,
                reason: 'superseded_by_admitted_correction', correctionSourceNodeId: correction.sourceNodeId })
            : { status: 'held', source_node_id: supersedes, reason: 'needs_writer' })
          : { status: 'held', source_node_id: supersedes, reason: 'correction_not_admitted' };
      }
    }
    const status = engramStatus(store.db, {
      access: 'candidate_submit',
      instanceId: options.instanceId,
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...result,
          ...admitted,
          instance_id: status.instance_id,
          connection: connectionReceipt(status),
        }, null, 2),
      }],
    };
  });

  return server;
}
