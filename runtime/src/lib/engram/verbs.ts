import type Database from 'better-sqlite3';
import { insertAssertion, updateAssertionStatus, updateAssertionConfidence } from './assertions.js';
import type { EngramAssertion } from './assertions.js';
import type {
  AssertionSourceFrontmatter,
  AssertionSourceResult,
} from '../writer.js';
import { isPromotedMemorySource, MEMORY_AUTHORITY } from './admission.js';
import { deriveAssertionValidFrom } from './temporal.js';

/**
 * Engram Memory Verbs: agent-facing write operations for durable facts.
 *
 * All write verbs follow the constraints from ENGRAM.md:
 * - `engram_remember`: vault write + synchronous assertion insert
 * - `engram_forget`: soft retract by default, hard delete with --force
 * - `engram_improve`: update confidence + add evidence
 * - `engram_profile`: generate cited static + dynamic agent runtime profile
 */

// --- engram_remember ---

export interface RememberOptions {
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId?: string;
  confidence?: number;
  episodeId?: string;
}

export interface RememberSourceWriter {
  resolveExistingNodeId(nodeId: string): string | undefined;
  upsertAssertionSource(
    nodeId: string,
    assertion: AssertionSourceFrontmatter,
  ): AssertionSourceResult;
  createOrUpdateAssertionSource(
    title: string,
    directory: string,
    assertion: AssertionSourceFrontmatter,
  ): AssertionSourceResult;
}

export interface ForgetSourceWriter {
  updateAssertionStatus(
    nodeId: string,
    assertion: Pick<AssertionSourceFrontmatter, 'subject' | 'predicate' | 'object'>,
    status: string,
  ): boolean;
}

export interface RememberResult {
  assertion: EngramAssertion;
  sourceNodeId: string;
  vaultWritten: true;
  sourceDisposition: 'created' | 'updated' | 'reused';
}

const ASSERTION_SOURCE_DIR = 'Memory/Engram/Assertions';

/**
 * Legacy local/operator primitive retained for vault rebuild compatibility.
 * Network and agent-facing servers must use MemoryAdmissionService instead.
 */
export function engramRemember(
  db: Database.Database,
  opts: RememberOptions,
  writer: RememberSourceWriter,
): RememberResult {
  validateRememberOptions(opts);
  const validFrom = resolveRememberValidFrom(db, opts.episodeId);
  const sourceAssertion: AssertionSourceFrontmatter = {
    subject: opts.subject.trim(),
    predicate: opts.predicate.trim(),
    object: opts.object.trim(),
    confidence: opts.confidence ?? 1.0,
    status: 'current',
    valid_from: validFrom,
  };

  const source = resolveOrCreateSource(opts, sourceAssertion, writer);
  const assertion = insertAssertion(db, {
    subject: sourceAssertion.subject,
    predicate: sourceAssertion.predicate,
    object: sourceAssertion.object,
    confidence: opts.confidence ?? 1.0,
    status: 'current',
    source_node_id: source.sourceNodeId,
    episode_id: opts.episodeId ?? null,
    valid_from: validFrom,
  });
  return {
    assertion,
    sourceNodeId: source.sourceNodeId,
    vaultWritten: true,
    sourceDisposition: source.disposition,
  };
}

function resolveRememberValidFrom(db: Database.Database, episodeId?: string): string {
  if (!episodeId) return new Date().toISOString();
  const row = db.prepare(`
    SELECT e.observed_at, e.provenance, n.frontmatter
    FROM engram_episodes e
    JOIN nodes n ON n.id = e.source_node_id
    WHERE e.owner_principal_id = current_principal_id() AND e.id = ?
  `).get(episodeId) as { observed_at: string | null; provenance: string; frontmatter: string } | undefined;
  if (!row?.observed_at) {
    throw new Error(`Episode has no temporal provenance: ${episodeId}`);
  }
  const frontmatter = tryParseFrontmatter(row.frontmatter);
  const temporal = deriveAssertionValidFrom({
    episode: { observedAt: row.observed_at, provenance: row.provenance },
    sourceFrontmatter: frontmatter,
  });
  if (temporal.classification !== 'derived' || !temporal.valid_from) {
    throw new Error(`Episode temporal provenance is ${temporal.classification}: ${episodeId}`);
  }
  return temporal.valid_from;
}

function tryParseFrontmatter(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validateRememberOptions(opts: RememberOptions): void {
  for (const field of ['subject', 'predicate', 'object'] as const) {
    if (!opts[field].trim()) {
      throw new Error(`${field} must not be empty`);
    }
  }
  if (opts.confidence !== undefined && (!Number.isFinite(opts.confidence) || opts.confidence < 0 || opts.confidence > 1)) {
    throw new Error('confidence must be between 0 and 1');
  }
}

function resolveOrCreateSource(
  opts: RememberOptions,
  assertion: AssertionSourceFrontmatter,
  writer: RememberSourceWriter,
): AssertionSourceResult {
  const requestedSource = opts.sourceNodeId?.trim();
  if (requestedSource) {
    const resolved = writer.resolveExistingNodeId(requestedSource);
    if (!resolved) {
      throw new Error(`Source node not found: ${requestedSource}`);
    }
    return writer.upsertAssertionSource(resolved, assertion);
  }

  return writer.createOrUpdateAssertionSource(
    assertionSourceTitle(opts),
    ASSERTION_SOURCE_DIR,
    assertion,
  );
}

function assertionSourceTitle(opts: Pick<RememberOptions, 'subject' | 'predicate' | 'object'>): string {
  const key = [opts.subject, opts.predicate, opts.object]
    .map(part => part.trim().toLowerCase())
    .join('\u001f');
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `assert_${Math.abs(hash).toString(36)}`;
}

// --- engram_forget ---

export interface ForgetOptions {
  assertionId: string;
  reason: string;
  hard?: boolean;
}

export function engramForget(
  db: Database.Database,
  opts: ForgetOptions,
  writer?: ForgetSourceWriter,
): { status: string; assertion_id: string; detail: string } {
  if (opts.hard) {
    // Hard delete — removes from DB entirely
    const existing = db.prepare(`
      SELECT id FROM records_engram_assertions
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND id = ?
    `).get(opts.assertionId);
    if (!existing) {
      return { status: 'error', assertion_id: opts.assertionId, detail: 'Assertion not found' };
    }
    db.prepare(
      'DELETE FROM records_engram_assertions WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id() AND id = ?'
    ).run(opts.assertionId);
    // Also delete any contradiction cases referencing this assertion
    db.prepare(
      `UPDATE records_engram_contradiction_cases SET status = ?
       WHERE tenant_id = current_tenant_id()
         AND owner_principal_id = current_principal_id()
         AND (assertion_a_id = ? OR assertion_b_id = ?) AND status = ?`
    ).run('dismissed', opts.assertionId, opts.assertionId, 'open');
    return { status: 'deleted', assertion_id: opts.assertionId, detail: opts.reason };
  }

  // Soft retract — set status to retracted, set valid_to
  const existing = db.prepare(`
    SELECT subject, predicate, object, source_node_id, status
    FROM records_engram_assertions
    WHERE tenant_id = current_tenant_id()
      AND owner_principal_id = current_principal_id()
      AND id = ?
  `).get(opts.assertionId) as {
    subject: string;
    predicate: string;
    object: string;
    source_node_id: string | null;
    status: string;
  } | undefined;
  if (!existing) {
    return { status: 'error', assertion_id: opts.assertionId, detail: 'Assertion not found' };
  }
  if (writer && existing.source_node_id) {
    writer.updateAssertionStatus(existing.source_node_id, {
      subject: existing.subject,
      predicate: existing.predicate,
      object: existing.object,
    }, 'retracted');
  }
  updateAssertionStatus(db, opts.assertionId, 'retracted');
  return { status: 'retracted', assertion_id: opts.assertionId, detail: opts.reason };
}

// --- engram_improve ---

export interface ImproveOptions {
  assertionId: string;
  newConfidence: number;
  evidenceText?: string;
}

export function engramImprove(
  db: Database.Database,
  opts: ImproveOptions,
): { status: string; assertion_id: string; new_confidence: number } {
  const existing = db.prepare(`
    SELECT id FROM records_engram_assertions
    WHERE tenant_id = current_tenant_id()
      AND owner_principal_id = current_principal_id()
      AND id = ?
  `).get(opts.assertionId);
  if (!existing) {
    return { status: 'error', assertion_id: opts.assertionId, new_confidence: opts.newConfidence };
  }
  updateAssertionConfidence(db, opts.assertionId, opts.newConfidence, opts.evidenceText);
  return { status: 'updated', assertion_id: opts.assertionId, new_confidence: opts.newConfidence };
}

// --- engram_profile ---

export interface AgentProfile {
  authority: typeof MEMORY_AUTHORITY;
  generatedAt: string;
  static: {
    preferences: EngramAssertion[];
    identity: EngramAssertion[];
    constraints: EngramAssertion[];
    environment: EngramAssertion[];
  };
  dynamic: {
    activeProjects: EngramAssertion[];
    recentContext: EngramAssertion[];
    openContradictions: Array<{
      id: string;
      subject: string;
      predicate: string;
      assertion_a: string;
      assertion_b: string;
    }>;
  };
}

export function engramProfile(
  db: Database.Database,
  opts: { admission?: 'legacy' | 'promoted_only' } = {},
): AgentProfile {
  const promotedOnly = opts.admission === 'promoted_only'
    ? `AND EXISTS (
        SELECT 1 FROM engram_memory_sources ms
        WHERE ms.source_node_id = engram_assertions.source_node_id
          AND ms.trust_state = 'promoted'
          AND ms.authority = 'informational_only'
      )`
    : '';
  const admitted = (rows: EngramAssertion[]): EngramAssertion[] =>
    opts.admission === 'promoted_only'
      ? rows.filter(row => isPromotedMemorySource(db, row.source_node_id))
      : rows;
  // Static profile: durable high-confidence assertions about user preferences, identity, constraints
  const preferences = db.prepare(`
    SELECT * FROM engram_assertions
    WHERE status = 'current' AND confidence >= 0.8
      AND predicate IN ('prefers', 'likes', 'wants', 'chooses', 'uses', 'dislikes', 'avoids', 'rejects')
      ${promotedOnly}
    ORDER BY confidence DESC LIMIT 20
  `).all() as EngramAssertion[];

  const identity = db.prepare(`
    SELECT * FROM engram_assertions
    WHERE status = 'current' AND confidence >= 0.9
      AND predicate IN ('is', 'works_as', 'lives_in', 'owns', 'drives')
      ${promotedOnly}
    ORDER BY confidence DESC LIMIT 10
  `).all() as EngramAssertion[];

  const constraints = db.prepare(`
    SELECT * FROM engram_assertions
    WHERE status = 'current' AND confidence >= 0.7
      AND predicate IN ('requires', 'needs', 'must', 'cannot', 'should', 'should_not')
      ${promotedOnly}
    ORDER BY confidence DESC LIMIT 15
  `).all() as EngramAssertion[];

  const environment = db.prepare(`
    SELECT * FROM engram_assertions
    WHERE status = 'current' AND confidence >= 0.7
      AND (subject = 'Mac Mini' OR subject = 'UM790' OR subject = 'system'
           OR predicate IN ('runs_on', 'deployed_to', 'hosts', 'uses_infra'))
      ${promotedOnly}
    ORDER BY confidence DESC LIMIT 10
  `).all() as EngramAssertion[];

  // Dynamic profile: recent assertions about active projects / context
  const activeProjects = db.prepare(`
    SELECT * FROM engram_assertions
    WHERE status = 'current'
      AND (predicate = 'project' OR predicate = 'working_on' OR predicate = 'developing'
           OR subject IN ('Engram', 'Hermes', 'Maestro', 'Alfred', 'PrintOS'))
      ${promotedOnly}
    ORDER BY created_at DESC LIMIT 15
  `).all() as EngramAssertion[];

  const recentContext = db.prepare(`
    SELECT * FROM engram_assertions
    WHERE status = 'current' AND created_at > datetime('now', '-7 days')
      ${promotedOnly}
    ORDER BY created_at DESC LIMIT 20
  `).all() as EngramAssertion[];

  const openCtr = db.prepare(`
    SELECT c.id, c.subject, c.predicate, c.assertion_a_id, c.assertion_b_id,
           a.source_node_id AS source_a, b.source_node_id AS source_b
    FROM engram_contradiction_cases c
    JOIN engram_assertions a ON a.id = c.assertion_a_id
    JOIN engram_assertions b ON b.id = c.assertion_b_id
    WHERE c.status = 'open'
  `).all() as Array<{
    id: string; subject: string; predicate: string;
    assertion_a_id: string; assertion_b_id: string;
    source_a: string; source_b: string;
  }>;
  const admittedContradictions = opts.admission === 'promoted_only'
    ? openCtr.filter(c => isPromotedMemorySource(db, c.source_a)
      && isPromotedMemorySource(db, c.source_b))
    : openCtr;

  return {
    authority: MEMORY_AUTHORITY,
    generatedAt: new Date().toISOString(),
    static: {
      preferences: admitted(preferences),
      identity: admitted(identity),
      constraints: admitted(constraints),
      environment: admitted(environment),
    },
    dynamic: {
      activeProjects: admitted(activeProjects),
      recentContext: admitted(recentContext),
      openContradictions: admittedContradictions.map(c => ({
      id: c.id,
      subject: c.subject,
      predicate: c.predicate,
      assertion_a: c.assertion_a_id,
      assertion_b: c.assertion_b_id,
    })),
    },
  };
}
