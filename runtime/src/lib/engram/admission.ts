import { createHash, createHmac, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VaultWriter } from '../writer.js';
import { insertAssertion, type EngramAssertion } from './assertions.js';
import { normalizeTemporalInstant } from './temporal.js';
import { claimUnsupported, fileClaimVerdicts, type ClaimVerdictLookup } from './claim-verdicts.js';
import { NOTE_CLAIMS_PREFIX, fileNoteClaims, findNoteClaim, type NoteClaimsLookup } from './note-claims.js';
import type { ToolAuthorizer } from '../../security/authorization.js';
import type { VerifiedRequestIdentity } from '../../security/request-identity.js';

export const MEMORY_AUTHORITY = 'informational_only' as const;
export const MEMORY_ADMISSION_POLICY_VERSION = 'engram-security-v1';
/**
 * Agents admit their own facts (decided by Jeremy, 2026-10-04: nobody reviews a
 * queue by hand). A quarantined agent-written candidate becomes recallable when
 * automatic checks pass; anything that fails stays quarantined, and a later
 * sweep retries it.
 */
export const SELF_ADMISSION_POLICY_VERSION = 'engram-self-admission-v1';
export const SELF_ADMISSION_REASON = 'self_admitted';

export type MemoryOrigin = 'user_authored' | 'tool_derived' | 'model_derived' | 'imported';
export type MemoryTrustState = 'quarantined' | 'promoted' | 'rejected';
export type MemorySensitivity = 'private' | 'security_sensitive' | 'credential';

export interface MemoryCandidate {
  tenant_id: string;
  owner_principal_id: string;
  id: string;
  origin: MemoryOrigin;
  trust_state: MemoryTrustState;
  sensitivity: MemorySensitivity;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  confidence: number;
  source_node_id: string | null;
  source_hash: string;
  policy_version: string;
  created_at: string;
  updated_at: string;
  reviewed_by_principal_id: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  assertion_id: string | null;
}

export interface MemorySourceAdmission {
  tenant_id: string;
  owner_principal_id: string;
  source_node_id: string;
  candidate_id: string;
  origin: MemoryOrigin;
  trust_state: 'promoted';
  sensitivity: Exclude<MemorySensitivity, 'credential'>;
  authority: typeof MEMORY_AUTHORITY;
  policy_version: string;
  promoted_at: string;
  reviewed_by_principal_id: string;
  source_digest: string;
}

export const MEMORY_ADMISSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS records_engram_memory_candidates (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK (origin IN ('user_authored','tool_derived','model_derived','imported')),
    trust_state TEXT NOT NULL CHECK (trust_state IN ('quarantined','promoted','rejected')),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('private','security_sensitive','credential')),
    subject TEXT,
    predicate TEXT,
    object TEXT,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source_node_id TEXT,
    source_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_by_principal_id TEXT,
    reviewed_at TEXT,
    review_reason TEXT,
    assertion_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_engram_memory_candidates_state
    ON records_engram_memory_candidates(tenant_id, trust_state, created_at);

  CREATE TABLE IF NOT EXISTS records_engram_memory_sources (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    source_node_id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('user_authored','tool_derived','model_derived','imported')),
    trust_state TEXT NOT NULL CHECK (trust_state = 'promoted'),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('private','security_sensitive')),
    authority TEXT NOT NULL CHECK (authority = 'informational_only'),
    policy_version TEXT NOT NULL,
    promoted_at TEXT NOT NULL,
    reviewed_by_principal_id TEXT NOT NULL,
    source_digest TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_engram_memory_sources_state
    ON records_engram_memory_sources(tenant_id, trust_state, source_node_id);

  CREATE TABLE IF NOT EXISTS records_engram_memory_rejections (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    reason TEXT NOT NULL,
    content_alias TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records_engram_memory_reviews (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('promoted','rejected')),
    reason_code TEXT NOT NULL,
    candidate_alias TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    reviewed_by_principal_id TEXT NOT NULL
  );

  CREATE VIEW IF NOT EXISTS engram_memory_candidates AS
    SELECT * FROM records_engram_memory_candidates
    WHERE tenant_id = current_tenant_id();

  CREATE VIEW IF NOT EXISTS engram_memory_sources AS
    SELECT * FROM records_engram_memory_sources
    WHERE tenant_id = current_tenant_id();
`;

export function ensureMemoryAdmissionTables(db: Database.Database): void {
  db.exec(MEMORY_ADMISSION_SCHEMA);
}

export interface MemoryAdmissionServiceOptions {
  receiptKey: Uint8Array;
  authorizer?: ToolAuthorizer;
  now?: () => number;
  /** Admit agent-written facts automatically on submission and indexing. The production factory turns this on. */
  selfAdmission?: boolean;
  /** Per-claim review verdicts (claim-verdicts.ts). Default: the sidecar file; only qualified verdicts count. */
  claimVerdicts?: ClaimVerdictLookup;
  /** Typed claims for vault notes (note-claims.ts). Default: the sidecar file. */
  noteClaims?: NoteClaimsLookup;
}

export interface CandidateInput {
  origin: MemoryOrigin;
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  sourceNodeId?: string;
  sourceHash: string;
}

export type SelfAdmissionHold =
  | 'not_found' | 'not_quarantined' | 'not_agent_derived' | 'source_unbound' | 'source_missing'
  | 'invalid_validity' | 'future_validity' | 'needs_writer' | 'source_unsupported' | 'claim_unsupported';

export type SelfAdmission =
  | { status: 'admitted'; candidateId: string; mode: 'in_place' | 'note'; assertionId: string;
      sourceNodeId: string; receiptId: string }
  | { status: 'held'; candidateId: string; reason: SelfAdmissionHold };

type CandidateEvidence = NonNullable<ReturnType<typeof getMemoryCandidateEvidence>>;

interface AdmissionWrite {
  now: string;
  validFrom: string;
  validTo: string | null;
  status: 'current' | 'historical';
  evidence: CandidateEvidence | null;
  principalId: string;
  reasonCode: string;
  policyVersion: string;
  receiptId: string;
  /** `note` writes a reviewed source note and a promoted-source row; `in_place` binds the assertion to the candidate's own source. */
  mode: 'note' | 'in_place';
  writer?: VaultWriter;
  /** Reviewed dates must agree with an existing current claim of the same triple. */
  checkExistingValidity: boolean;
}

export type CandidateSubmission =
  | { status: 'quarantined'; candidate: MemoryCandidate }
  | { status: 'rejected'; reason: 'credential_detected'; receiptId: string };

export class MemoryAdmissionService {
  private readonly now: () => number;
  private readonly claimVerdicts: ClaimVerdictLookup;
  readonly noteClaims: NoteClaimsLookup;

  constructor(private readonly options: MemoryAdmissionServiceOptions) {
    if (options.receiptKey.byteLength < 32) {
      throw new Error('Memory admission receipt key must be at least 32 bytes');
    }
    this.now = options.now ?? Date.now;
    this.claimVerdicts = options.claimVerdicts ?? fileClaimVerdicts();
    this.noteClaims = options.noteClaims ?? fileNoteClaims();
  }

  get selfAdmission(): boolean {
    return this.options.selfAdmission === true;
  }

  submit(db: Database.Database, input: CandidateInput): CandidateSubmission {
    const origin = validateOrigin(input.origin);
    const subject = boundedText('subject', input.subject);
    const predicate = boundedText('predicate', input.predicate);
    const object = boundedText('object', input.object);
    const confidence = boundedConfidence(input.confidence);
    const sourceHash = opaqueText('sourceHash', input.sourceHash);
    const sourceNodeId = input.sourceNodeId ? boundedText('sourceNodeId', input.sourceNodeId) : null;
    const material = `${subject}\u001f${predicate}\u001f${object}`;
    const credentialMaterial = `${material}\u001f${sourceNodeId ?? ''}`;
    const contentAlias = this.alias('content', credentialMaterial);
    const now = new Date(this.now()).toISOString();

    if (containsCredential(credentialMaterial)) {
      const id = this.alias('credential-rejection', `${origin}\u001f${contentAlias}\u001f${sourceHash}`);
      db.prepare(`
        INSERT OR IGNORE INTO records_engram_memory_rejections
          (tenant_id, owner_principal_id, id, origin, reason, content_alias, policy_version, created_at)
        VALUES (current_tenant_id(), current_principal_id(), ?, ?, 'credential_detected', ?, ?, ?)
      `).run(id, origin, contentAlias, MEMORY_ADMISSION_POLICY_VERSION, now);
      return { status: 'rejected', reason: 'credential_detected', receiptId: id };
    }

    const sensitivity = classifySensitivity(material);
    const id = this.alias('candidate', `${origin}\u001f${material}\u001f${confidence}\u001f${sourceHash}`);
    db.prepare(`
      INSERT INTO records_engram_memory_candidates
        (tenant_id, owner_principal_id, id, origin, trust_state, sensitivity,
         subject, predicate, object, confidence, source_node_id, source_hash, policy_version,
         created_at, updated_at)
      VALUES (current_tenant_id(), current_principal_id(), ?, ?, 'quarantined', ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(
      id, origin, sensitivity, subject, predicate, object, confidence, sourceNodeId,
      sourceHash, MEMORY_ADMISSION_POLICY_VERSION, now, now,
    );
    return { status: 'quarantined', candidate: getMemoryCandidate(db, id)! };
  }

  promote(
    db: Database.Database,
    candidateId: string,
    review: { identity: VerifiedRequestIdentity; reviewReason: string; writer: VaultWriter;
      useSourceValidity?: boolean; validFrom?: string; validTo?: string },
  ): { status: 'promoted'; candidateId: string; assertion: EngramAssertion; sourceNodeId: string; receiptId: string } {
    const candidate = requireReviewableCandidate(db, candidateId);
    this.requireMatchingContext(db, review.identity);
    if (!this.options.authorizer) throw new Error('Memory review authorizer is not configured');
    const now = new Date(this.now()).toISOString();
    const evidence = getMemoryCandidateEvidence(db, candidate);
    if (review.useSourceValidity && (review.validFrom !== undefined || review.validTo !== undefined)) {
      throw new Error('Choose source validity or explicit reviewed dates');
    }
    if (review.useSourceValidity && !evidence) throw new Error('No fully bound source validity; supply reviewed dates explicitly');
    if (evidence && (evidence.valid_from !== null || evidence.valid_to !== null) && !review.useSourceValidity
        && review.validFrom === undefined && review.validTo === undefined) {
      throw new Error('Dated claim requires source validity review or explicit reviewed dates');
    }
    const validFrom = normalizeTemporalInstant(review.useSourceValidity
      ? evidence!.valid_from ?? evidence!.source_created : review.validFrom ?? now);
    const end = review.useSourceValidity ? evidence!.valid_to : review.validTo;
    const validTo = end == null ? null : normalizeTemporalInstant(end);
    if (validTo && validTo < validFrom) throw new Error('valid_to must not be earlier than valid_from');
    if (validFrom > now) throw new Error('Future validity remains quarantined until its start');
    const status = validTo && validTo <= now ? 'historical' : 'current';
    const decision = this.options.authorizer.authorize(review.identity, 'engram_memory_promote');
    if (!decision.allowed) throw new Error(`Memory promotion authorization denied: ${decision.reason}`);
    boundedText('reviewReason', review.reviewReason);
    const receiptId = this.alias('promotion', `${candidate.id}\u001f${review.identity.tokenId}\u001f${now}`);

    const promoted = this.writeAdmission(db, candidate, {
      now, validFrom, validTo, status, evidence,
      principalId: review.identity.accessContext.principalId,
      reasonCode: 'review_approved', policyVersion: MEMORY_ADMISSION_POLICY_VERSION, receiptId,
      mode: 'note', writer: review.writer,
      checkExistingValidity: !!(review.useSourceValidity || review.validFrom !== undefined || review.validTo !== undefined),
    });

    return {
      status: 'promoted', candidateId: candidate.id, assertion: promoted.assertion,
      sourceNodeId: promoted.sourceNodeId, receiptId,
    };
  }

  /**
   * Admit an agent-written candidate without a human reviewer when every check
   * passes. Extracted claims (bound to the memory file they came from) are
   * admitted in place, so recall does not gain a duplicate note per fact. Other
   * agent facts (engram_remember) get a reviewed note, as a promotion would.
   */
  selfAdmit(db: Database.Database, candidateId: string, opts: { writer?: VaultWriter } = {}): SelfAdmission {
    const held = (reason: SelfAdmissionHold): SelfAdmission => ({ status: 'held', candidateId, reason });
    const candidate = db.prepare(`
      SELECT * FROM records_engram_memory_candidates
      WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id() AND id = ?
    `).get(candidateId) as MemoryCandidate | undefined;
    if (!candidate) return held('not_found');
    if (candidate.trust_state !== 'quarantined' || !candidate.subject || !candidate.predicate || !candidate.object) {
      return held('not_quarantined');
    }
    if (candidate.origin !== 'model_derived') return held('not_agent_derived');
    const extracted = candidate.source_hash.startsWith('extracted-v1:');
    // A vault note's claim from the note-claims sidecar is admitted in place the same way.
    const noteClaim = candidate.source_hash.startsWith(NOTE_CLAIMS_PREFIX);
    let evidence: CandidateEvidence | null = null;
    if (extracted || noteClaim) {
      try {
        evidence = extracted ? getMemoryCandidateEvidence(db, candidate) : getNoteClaimEvidence(db, candidate, this.noteClaims);
      } catch { return held('source_unbound'); }
      if (!evidence) return held('source_unbound');
      // Phase 5: the write-time support judge found the memory's cited passages do not back it
      // (extraction/support_check.py). Its claims stay quarantined; `unchecked` is not a verdict.
      if (memorySupportVerdict(db, candidate.source_node_id) === 'unsupported') return held('source_unsupported');
      // Per-claim review: a qualified reviewer found this claim's own passages do not back it.
      if (claimUnsupported(this.claimVerdicts, evidence.source_node_id, candidate as { subject: string; predicate: string; object: string },
        evidence.passages)) return held('claim_unsupported');
    } else {
      // The candidate note Engram writes for a submission (EngramCandidates/) is
      // not evidence; before 2026-10-04 every source-less fact cited one and passed.
      const source = resolveSourceNode(db, candidate.source_node_id);
      if (!source || source.startsWith('EngramCandidates/')) return held('source_missing');
    }
    const mode = extracted || noteClaim ? 'in_place' as const : 'note' as const;
    if (mode === 'note' && !opts.writer) return held('needs_writer');

    const now = new Date(this.now()).toISOString();
    let validFrom: string;
    let validTo: string | null;
    try {
      validFrom = normalizeTemporalInstant(evidence ? evidence.valid_from ?? evidence.source_created ?? now : now);
      validTo = evidence?.valid_to == null ? null : normalizeTemporalInstant(evidence.valid_to);
    } catch { return held('invalid_validity'); }
    if (validTo && validTo < validFrom) return held('invalid_validity');
    if (validFrom > now) return held('future_validity');
    const status = validTo && validTo <= now ? 'historical' as const : 'current' as const;
    // No contradiction hold: a shared subject and predicate is not a conflict
    // ("Jeremy prefers X" and "Jeremy prefers Y"). Holding on it kept 207 of
    // 2,991 real preferences and rules out of recall in the October 4 trial.
    const principalId = (db.prepare('SELECT current_principal_id() AS p').get() as { p: string }).p;
    const receiptId = this.alias('self-admission', `${candidate.id}\u001f${now}`);
    const admitted = this.writeAdmission(db, candidate, {
      now, validFrom, validTo, status, evidence, principalId, reasonCode: SELF_ADMISSION_REASON,
      policyVersion: SELF_ADMISSION_POLICY_VERSION, receiptId, mode, writer: opts.writer, checkExistingValidity: false,
    });
    return { status: 'admitted', candidateId: candidate.id, mode, assertionId: admitted.assertion.id,
      sourceNodeId: admitted.sourceNodeId, receiptId };
  }

  /** Admit every quarantined agent-written candidate that passes; body-free counts. */
  selfAdmitAll(db: Database.Database, opts: { writer?: VaultWriter; limit?: number } = {}): {
    candidates: number; admitted: { in_place: number; note: number }; held: Partial<Record<SelfAdmissionHold, number>>;
  } {
    const ids = (db.prepare(`
      SELECT id FROM engram_memory_candidates
      WHERE trust_state = 'quarantined' AND origin = 'model_derived' ORDER BY created_at, id
    `).all() as Array<{ id: string }>).map(r => r.id).slice(0, opts.limit ?? Infinity);
    const out = { candidates: ids.length, admitted: { in_place: 0, note: 0 }, held: {} as Partial<Record<SelfAdmissionHold, number>> };
    for (const id of ids) {
      const r = this.selfAdmit(db, id, { writer: opts.writer });
      if (r.status === 'admitted') out.admitted[r.mode] += 1;
      else out.held[r.reason] = (out.held[r.reason] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Undo self-admission: candidates return to quarantine, their assertions and
   * reviewed notes go away. Assertions merged into an older row from another
   * source are left alone. Returns the reviewed-note paths for the caller to delete.
   */
  revertSelfAdmissions(db: Database.Database): { reverted: number; assertions_deleted: number; note_paths: string[] } {
    return db.transaction(() => {
      const rows = db.prepare(`
        SELECT id, assertion_id, source_node_id FROM records_engram_memory_candidates
        WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id()
          AND trust_state = 'promoted' AND review_reason = ?
      `).all(SELF_ADMISSION_REASON) as Array<{ id: string; assertion_id: string | null; source_node_id: string | null }>;
      let deleted = 0;
      const notes: string[] = [];
      for (const row of rows) {
        const note = db.prepare(`
          SELECT source_node_id FROM records_engram_memory_sources
          WHERE tenant_id = current_tenant_id() AND candidate_id = ? AND policy_version = ?
        `).get(row.id, SELF_ADMISSION_POLICY_VERSION) as { source_node_id: string } | undefined;
        const assertionSource = note?.source_node_id ?? row.source_node_id;
        if (row.assertion_id && assertionSource) {
          deleted += db.prepare(`
            DELETE FROM records_engram_assertions
            WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id()
              AND id = ? AND source_node_id = ?
          `).run(row.assertion_id, assertionSource).changes;
        }
        if (note) {
          db.prepare(`DELETE FROM records_engram_memory_sources WHERE tenant_id = current_tenant_id() AND source_node_id = ?`)
            .run(note.source_node_id);
          notes.push(note.source_node_id);
        }
        db.prepare(`
          UPDATE records_engram_memory_candidates SET trust_state = 'quarantined', reviewed_by_principal_id = NULL,
            reviewed_at = NULL, review_reason = NULL, assertion_id = NULL
          WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id() AND id = ?
        `).run(row.id);
        db.prepare(`DELETE FROM records_engram_memory_reviews WHERE tenant_id = current_tenant_id() AND candidate_id = ? AND reason_code = ?`)
          .run(row.id, SELF_ADMISSION_REASON);
      }
      return { reverted: rows.length, assertions_deleted: deleted, note_paths: notes };
    })();
  }

  /** The one write path for promotion and self-admission, so both leave the same records behind. */
  private writeAdmission(
    db: Database.Database,
    candidate: MemoryCandidate,
    w: AdmissionWrite,
  ): { assertion: EngramAssertion; sourceNodeId: string } {
    return db.transaction(() => {
      if (w.evidence && candidate.source_hash !== `${bindingPrefix(candidate.source_hash)}${computeMemorySourceDigest(db, candidate.source_node_id!)}`) {
        throw new Error('Candidate source changed during review');
      }
      if (w.checkExistingValidity && w.status === 'current') {
        const existing = db.prepare(`SELECT valid_from, valid_to FROM engram_assertions
          WHERE owner_principal_id=current_principal_id() AND subject=? AND predicate=? AND object=? AND status='current'`)
          .get(candidate.subject, candidate.predicate, candidate.object) as { valid_from: string; valid_to: string | null } | undefined;
        if (existing && (existing.valid_from !== w.validFrom || existing.valid_to !== w.validTo)) {
          throw new Error('Existing current claim has different validity; resolve that interval before promotion');
        }
      }
      const claim = db.prepare(`
        UPDATE records_engram_memory_candidates SET
          trust_state = 'promoted', updated_at = ?, reviewed_by_principal_id = ?,
          reviewed_at = ?, review_reason = ?
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND id = ? AND trust_state = 'quarantined'
      `).run(w.now, w.principalId, w.now, w.reasonCode, candidate.id);
      if (claim.changes !== 1) throw new Error('Memory candidate is not reviewable');

      let sourceNodeId: string;
      if (w.mode === 'in_place') {
        sourceNodeId = candidate.source_node_id!;
      } else {
        if (!w.writer) throw new Error('A reviewed note needs a vault writer');
        const sourceAssertion = {
          subject: candidate.subject!, predicate: candidate.predicate!, object: candidate.object!,
          confidence: candidate.confidence, status: w.status, valid_from: w.validFrom, valid_to: w.validTo,
          ...(w.evidence ? { passages: w.evidence.passages } : {}),
        };
        // Never promote an existing source node: review covers this exact triple,
        // not unrelated prose or frontmatter that may share its provenance file.
        sourceNodeId = w.writer.createNode({
          title: `reviewed_${randomUUID()}`,
          directory: 'Memory/Engram/Reviewed',
          frontmatter: {
            type: 'engram_reviewed_assertion',
            assertions: [sourceAssertion],
            valid_from: w.validFrom,
            ...(w.validTo ? { valid_to: w.validTo } : {}),
            ...(w.evidence ? {
              reviewed_evidence: w.evidence,
              // The offline history linker consumes these standard provenance
              // fields. Promotion retains quotes; it does not certify support.
              metadata: { source_session: w.evidence.source_session, passages: w.evidence.passages },
            } : {}),
            created: w.now,
          },
          content: `${candidate.subject} ${candidate.predicate} ${candidate.object}`,
        });
      }
      const inserted = insertAssertion(db, {
        subject: candidate.subject!,
        predicate: candidate.predicate!,
        object: candidate.object!,
        confidence: candidate.confidence,
        status: w.status,
        source_node_id: sourceNodeId,
        valid_from: w.validFrom,
        valid_to: w.validTo,
      });
      if (w.mode === 'note') {
        const sourceDigest = computeMemorySourceDigest(db, sourceNodeId);
        db.prepare(`
          INSERT INTO records_engram_memory_sources
            (tenant_id, owner_principal_id, source_node_id, candidate_id, origin,
             trust_state, sensitivity, authority, policy_version, promoted_at,
             reviewed_by_principal_id, source_digest)
          VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, 'promoted', ?,
            'informational_only', ?, ?, ?, ?)
          ON CONFLICT(source_node_id) DO UPDATE SET
            candidate_id = excluded.candidate_id,
            origin = excluded.origin,
            trust_state = excluded.trust_state,
            sensitivity = excluded.sensitivity,
            authority = excluded.authority,
            policy_version = excluded.policy_version,
            promoted_at = excluded.promoted_at,
            reviewed_by_principal_id = excluded.reviewed_by_principal_id,
            source_digest = excluded.source_digest
        `).run(
          sourceNodeId, candidate.id, candidate.origin, candidate.sensitivity,
          w.policyVersion, w.now, w.principalId, sourceDigest,
        );
      }
      db.prepare(`
        UPDATE records_engram_memory_candidates SET assertion_id = ?
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND id = ? AND trust_state = 'promoted'
      `).run(inserted.id, candidate.id);
      this.insertReviewReceipt(db, w.receiptId, candidate.id, 'promoted', w.principalId, w.reasonCode, w.policyVersion, w.now);
      return { assertion: inserted, sourceNodeId };
    })();
  }

  reject(
    db: Database.Database,
    candidateId: string,
    review: { identity: VerifiedRequestIdentity; reviewReason: string },
  ): { status: 'rejected'; candidateId: string; receiptId: string } {
    const candidate = requireReviewableCandidate(db, candidateId);
    this.requireMatchingContext(db, review.identity);
    if (!this.options.authorizer) throw new Error('Memory review authorizer is not configured');
    const decision = this.options.authorizer.authorize(review.identity, 'engram_memory_reject');
    if (!decision.allowed) throw new Error(`Memory rejection authorization denied: ${decision.reason}`);
    boundedText('reviewReason', review.reviewReason);
    const now = new Date(this.now()).toISOString();
    const receiptId = this.alias('rejection', `${candidate.id}\u001f${review.identity.tokenId}\u001f${now}`);
    db.transaction(() => {
      const claim = db.prepare(`
        UPDATE records_engram_memory_candidates SET
          trust_state = 'rejected', subject = NULL, predicate = NULL, object = NULL,
          updated_at = ?, reviewed_by_principal_id = ?, reviewed_at = ?, review_reason = ?
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND id = ? AND trust_state = 'quarantined'
      `).run(now, review.identity.accessContext.principalId, now, 'review_rejected', candidate.id);
      if (claim.changes !== 1) throw new Error('Memory candidate is not reviewable');
      this.insertReviewReceipt(db, receiptId, candidate.id, 'rejected', review.identity.accessContext.principalId,
        'review_rejected', MEMORY_ADMISSION_POLICY_VERSION, now);
    })();
    return { status: 'rejected', candidateId: candidate.id, receiptId };
  }

  private insertReviewReceipt(
    db: Database.Database,
    id: string,
    candidateId: string,
    outcome: 'promoted' | 'rejected',
    principalId: string,
    reasonCode: string,
    policyVersion: string,
    reviewedAt: string,
  ): void {
    db.prepare(`
      INSERT INTO records_engram_memory_reviews
        (tenant_id, owner_principal_id, id, candidate_id, outcome, reason_code,
         candidate_alias, policy_version, reviewed_at, reviewed_by_principal_id)
      VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, candidateId, outcome, reasonCode,
      this.alias('review-candidate', candidateId), policyVersion,
      reviewedAt, principalId,
    );
  }

  private requireMatchingContext(db: Database.Database, identity: VerifiedRequestIdentity): void {
    const context = db.prepare(`
      SELECT current_tenant_id() AS tenant_id, current_principal_id() AS principal_id
    `).get() as { tenant_id: string; principal_id: string };
    if (identity.accessContext.tenantId !== context.tenant_id) {
      throw new Error('Reviewer tenant does not match database context');
    }
    if (identity.accessContext.principalId !== context.principal_id) {
      throw new Error('Reviewer principal does not match database context');
    }
  }

  private alias(label: string, value: string): string {
    return createHmac('sha256', this.options.receiptKey)
      .update(label).update('\0').update(value).digest('hex');
  }
}

export function getMemoryCandidate(db: Database.Database, id: string): MemoryCandidate | undefined {
  return db.prepare('SELECT * FROM engram_memory_candidates WHERE id = ?').get(id) as MemoryCandidate | undefined;
}

export function listMemoryCandidates(db: Database.Database, state?: MemoryTrustState): MemoryCandidate[] {
  if (state) {
    return db.prepare('SELECT * FROM engram_memory_candidates WHERE trust_state = ? ORDER BY created_at')
      .all(state) as MemoryCandidate[];
  }
  return db.prepare('SELECT * FROM engram_memory_candidates ORDER BY created_at').all() as MemoryCandidate[];
}

export function getMemorySourceAdmission(
  db: Database.Database,
  sourceNodeId: string,
): MemorySourceAdmission | undefined {
  return db.prepare('SELECT * FROM engram_memory_sources WHERE source_node_id = ?')
    .get(sourceNodeId) as MemorySourceAdmission | undefined;
}

/**
 * The indexed node an agent's cited source names. Agents often cite an absolute
 * or repo-prefixed path (`/Users/.../vault/Sessions/x.md`) where
 * the node id is vault-relative (`Sessions/x.md`); 8 of 11 facts held as
 * source_missing on 2026-10-04 did that. Tries the path as given, then each
 * shorter suffix at a `/` boundary.
 */
export function resolveSourceNode(db: Database.Database, sourceNodeId: string | null): string | null {
  if (!sourceNodeId) return null;
  const parts = sourceNodeId.split('/');
  for (let i = 0; i < parts.length; i++) {
    const id = parts.slice(i).join('/');
    if (id && db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id)) return id;
  }
  return null;
}

export function isPromotedMemorySource(db: Database.Database, sourceNodeId: string): boolean {
  const admission = db.prepare(`
    SELECT source_digest FROM engram_memory_sources
    WHERE source_node_id = ? AND trust_state = 'promoted' AND authority = 'informational_only'
  `).get(sourceNodeId) as { source_digest: string } | undefined;
  return !!admission && admission.source_digest === computeMemorySourceDigest(db, sourceNodeId);
}

/**
 * Which memory sources a read may cite. `legacy` cites any memory note.
 * `promoted_only` cites reviewed sources (engram_remember notes); OpenClaw stays
 * on it. `admitted` also cites a memory file whose extracted claims were
 * self-admitted in place, while the file still matches what was admitted: those
 * admissions write no source row, so `promoted_only` never saw them.
 */
export type MemoryAdmissionMode = 'legacy' | 'promoted_only' | 'admitted';

/** A per-read source check for `mode`, or null when every source is allowed. */
export function memorySourceGate(
  db: Database.Database,
  mode: MemoryAdmissionMode | undefined,
): ((sourceNodeId: string | null | undefined) => boolean) | null {
  if (mode !== 'promoted_only' && mode !== 'admitted') return null;
  let inPlace: Map<string, Set<string>> | null = null;
  const seen = new Map<string, boolean>();
  return (sourceNodeId) => {
    if (!sourceNodeId) return false;
    const cached = seen.get(sourceNodeId);
    if (cached !== undefined) return cached;
    let ok = isPromotedMemorySource(db, sourceNodeId);
    if (!ok && mode === 'admitted') {
      inPlace ??= inPlaceAdmittedHashes(db);
      const hashes = inPlace.get(sourceNodeId);
      const digest = computeMemorySourceDigest(db, sourceNodeId);
      ok = !!hashes && (hashes.has(`extracted-v1:${digest}`) || hashes.has(`${NOTE_CLAIMS_PREFIX}${digest}`));
    }
    seen.set(sourceNodeId, ok);
    return ok;
  };
}

/** SQL for "this note is a promoted source, or holds a claim admitted in place"; bind no parameters. */
export function admittedSourceSql(column: string, mode: 'promoted_only' | 'admitted'): string {
  const promoted = `EXISTS (SELECT 1 FROM engram_memory_sources ms WHERE ms.source_node_id = ${column}
    AND ms.trust_state = 'promoted' AND ms.authority = 'informational_only')`;
  if (mode === 'promoted_only') return promoted;
  return `(${promoted} OR EXISTS (SELECT 1 FROM engram_memory_candidates mc WHERE mc.source_node_id = ${column}
    AND mc.trust_state = 'promoted' AND (mc.source_hash LIKE 'extracted-v1:%' OR mc.source_hash LIKE '${NOTE_CLAIMS_PREFIX}%')))`;
}

function inPlaceAdmittedHashes(db: Database.Database): Map<string, Set<string>> {
  const rows = db.prepare(`
    SELECT source_node_id, source_hash FROM engram_memory_candidates
    WHERE trust_state = 'promoted' AND (source_hash LIKE 'extracted-v1:%' OR source_hash LIKE '${NOTE_CLAIMS_PREFIX}%')
      AND source_node_id IS NOT NULL
  `).all() as Array<{ source_node_id: string; source_hash: string }>;
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.source_node_id)) out.set(r.source_node_id, new Set());
    out.get(r.source_node_id)!.add(r.source_hash);
  }
  return out;
}

export function computeMemorySourceDigest(db: Database.Database, sourceNodeId: string): string {
  const source = db.prepare(`
    SELECT id, title, content, frontmatter FROM nodes WHERE id = ?
  `).get(sourceNodeId) as {
    id: string; title: string; content: string | null; frontmatter: string;
  } | undefined;
  if (!source) return '';
  return createHash('sha256')
    .update(source.id).update('\0')
    .update(source.title).update('\0')
    .update(source.content ?? '').update('\0')
    .update(source.frontmatter)
    .digest('hex');
}

/** The binding prefix of an in-place candidate's source hash. */
function bindingPrefix(sourceHash: string): string {
  return sourceHash.startsWith(NOTE_CLAIMS_PREFIX) ? NOTE_CLAIMS_PREFIX : 'extracted-v1:';
}

/**
 * Evidence for a vault note's claim from the note-claims sidecar: bound to the note's
 * current digest, and only while every quoted passage is still in the note.
 */
export function getNoteClaimEvidence(db: Database.Database, candidate: MemoryCandidate, lookup: NoteClaimsLookup) {
  if (!candidate.source_hash.startsWith(NOTE_CLAIMS_PREFIX)) return null;
  return db.transaction(() => {
    if (!candidate.source_node_id || candidate.source_hash !== `${NOTE_CLAIMS_PREFIX}${computeMemorySourceDigest(db, candidate.source_node_id)}`) {
      throw new Error('Candidate source changed or disappeared; review a newly submitted candidate');
    }
    const node = db.prepare('SELECT frontmatter, content FROM nodes WHERE id=?').get(candidate.source_node_id) as
      { frontmatter: string; content: string | null };
    const claim = findNoteClaim(lookup, candidate.source_node_id,
      { subject: candidate.subject!, predicate: candidate.predicate!, object: candidate.object! }, node.content ?? '');
    if (!claim) throw new Error('The note no longer holds every passage this claim quotes');
    const fm = JSON.parse(node.frontmatter);
    const rec = lookup(candidate.source_node_id);
    const evidence = { source_node_id: candidate.source_node_id, source_hash: candidate.source_hash,
      source_session: typeof fm.session_id === 'string' ? fm.session_id : rec?.session_id ?? null,
      source_created: fm.created ?? fm.date ?? null,
      valid_from: claim.valid_from ?? null, valid_to: claim.valid_to ?? null,
      passages: claim.passages, authority: MEMORY_AUTHORITY };
    if (containsCredential(JSON.stringify(evidence))) throw new Error('Credential-shaped source evidence cannot be promoted');
    return evidence;
  })();
}

/** Full-source evidence for new extracted claims. Legacy prefix hashes cannot certify it. */
export function getMemoryCandidateEvidence(db: Database.Database, candidate: MemoryCandidate) {
  if (!candidate.source_hash.startsWith('extracted-v1:')) return null;
  return db.transaction(() => {
    if (!candidate.source_node_id || candidate.source_hash !== `extracted-v1:${computeMemorySourceDigest(db, candidate.source_node_id)}`) {
      throw new Error('Candidate source changed or disappeared; review a newly submitted candidate');
    }
    const source = db.prepare('SELECT frontmatter FROM nodes WHERE id=?').get(candidate.source_node_id) as { frontmatter: string };
    const fm = JSON.parse(source.frontmatter);
    const blocks = candidate.origin === 'model_derived' ? fm.metadata?.assertions : fm.assertions;
    const claims = Array.isArray(blocks) ? blocks : [];
    const matches = claims.filter((a: Record<string, unknown>) => a
      && typeof a.subject === 'string' && a.subject.trim() === candidate.subject
      && typeof a.predicate === 'string' && a.predicate.trim() === candidate.predicate
      && typeof a.object === 'string' && a.object.trim() === candidate.object);
    if (matches.length !== 1) throw new Error('Candidate must identify one source assertion');
    const claim = matches[0];
    if (!Array.isArray(claim.passages) || !claim.passages.length
        || claim.passages.some((p: unknown) => typeof p !== 'string' || !p.trim())) {
      throw new Error('Source assertion has no complete supporting passages');
    }
    const evidence = { source_node_id: candidate.source_node_id, source_hash: candidate.source_hash,
      source_session: typeof fm.metadata?.source_session === 'string' ? fm.metadata.source_session
        : typeof fm.reviewed_evidence?.source_session === 'string' ? fm.reviewed_evidence.source_session : null,
      source_created: fm.created ?? fm.metadata?.created ?? null,
      valid_from: claim.valid_from ?? null, valid_to: claim.valid_to ?? null,
      passages: claim.passages as string[], authority: MEMORY_AUTHORITY };
    if (containsCredential(JSON.stringify(evidence))) throw new Error('Credential-shaped source evidence cannot be promoted');
    return evidence;
  })();
}

function requireReviewableCandidate(db: Database.Database, candidateId: string): MemoryCandidate {
  const candidate = db.prepare(`
    SELECT * FROM records_engram_memory_candidates
    WHERE tenant_id = current_tenant_id()
      AND owner_principal_id = current_principal_id()
      AND id = ?
  `).get(opaqueText('candidateId', candidateId)) as MemoryCandidate | undefined;
  if (!candidate) throw new Error('Memory candidate not found');
  if (candidate.trust_state !== 'quarantined' || !candidate.subject || !candidate.predicate || !candidate.object) {
    throw new Error('Memory candidate is not reviewable');
  }
  return candidate;
}

function validateOrigin(value: MemoryOrigin): MemoryOrigin {
  if (!['user_authored', 'tool_derived', 'model_derived', 'imported'].includes(value)) {
    throw new Error('Memory origin is invalid');
  }
  return value;
}

function boundedText(label: string, value: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const normalized = value.trim();
  const hasControl = [...normalized].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
  });
  if (!normalized || normalized.length > 4096 || hasControl) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function opaqueText(label: string, value: string): string {
  const normalized = boundedText(label, value);
  if (/\s/.test(normalized) || normalized.length > 512) throw new Error(`${label} must be opaque text`);
  return normalized;
}

function classifySensitivity(material: string): Exclude<MemorySensitivity, 'credential'> {
  return /\b(security|authentication|authorization|privacy|incident|vulnerability|threat)\b/i.test(material)
    ? 'security_sensitive'
    : 'private';
}

function boundedConfidence(value: number | undefined): number {
  const confidence = value ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  return confidence;
}

export function containsCredential(material: string): boolean {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
    /\bhf_[A-Za-z0-9]{20,}\b/,
    /\bya29\.[A-Za-z0-9_-]{20,}\b/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    /\bSK[0-9a-fA-F]{32}\b/,
    /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]{20,}\b/,
    /\bdop_v1_[A-Fa-f0-9]{32,}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b(?:bearer|authorization)\s*[:=]\s*[A-Za-z0-9._~+/-]{20,}\b/i,
    /\b(?:password|passwd|api[_ -]?key|client[_ -]?secret)\s*[:=]\s*\S{8,}/i,
  ];
  return patterns.some(pattern => pattern.test(material));
}

function memorySupportVerdict(db: Database.Database, nodeId: string | null): string | null {
  if (!nodeId) return null;
  const row = db.prepare('SELECT frontmatter FROM nodes WHERE id = ?').get(nodeId) as { frontmatter: string } | undefined;
  try {
    const metadata = (JSON.parse(row?.frontmatter ?? '{}') as { metadata?: { support?: unknown } }).metadata;
    return typeof metadata?.support === 'string' ? metadata.support : null;
  } catch { return null; }
}
