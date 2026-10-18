import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, normalize as normalizePath } from 'node:path';
import type Database from 'better-sqlite3';
import type { Store } from '../store.js';
import type { ToolAuthorizer } from '../../security/authorization.js';
import type { VerifiedRequestIdentity } from '../../security/request-identity.js';

export const ERASURE_POLICY_VERSION = 'engram-erasure-v1';

export type ErasureReason =
  | 'user_request'
  | 'consent_withdrawn'
  | 'retention_expired'
  | 'test_cleanup';

export type ErasureStatus =
  | 'pending'
  | 'source_cleanup_pending'
  | 'database_cleanup_pending'
  | 'local_complete';

export interface ErasureSourceWriter {
  deleteSource(nodeId: string): 'deleted' | 'missing';
}

export interface TombstoneLedgerWriter {
  append(input: {
    accessContext: { tenantId: string; principalId: string };
    sourceAlias: string;
    sourceStemAlias: string;
    requestId: string;
    reasonCode: ErasureReason;
    policyVersion: string;
    createdAt: string;
  }): unknown;
}

export interface ErasureReceipt {
  requestId: string;
  status: ErasureStatus;
  sourceAlias: string;
  sourceState: 'pending' | 'deleted' | 'missing';
  backupState: 'pending_expiry';
  exportState: 'pending_rebuild';
  remoteState: 'deferred';
  deleted: {
    nodes: number;
    edges: number;
    communities: number;
    episodes: number;
    assertions: number;
    contradictions: number;
    candidates: number;
    admissions: number;
    reviews: number;
  };
  requestedAt: string;
  completedAt: string | null;
}

export const ERASURE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS records_engram_erasure_tombstones (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    source_alias TEXT PRIMARY KEY,
    source_stem_alias TEXT NOT NULL,
    request_id TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code IN
      ('user_request','consent_withdrawn','retention_expired','test_cleanup')),
    policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_engram_erasure_tombstones_created
    ON records_engram_erasure_tombstones(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS records_engram_erasure_requests (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    source_alias TEXT NOT NULL,
    source_node_id TEXT,
    status TEXT NOT NULL CHECK (status IN
      ('pending','source_cleanup_pending','database_cleanup_pending','local_complete')),
    reason_code TEXT NOT NULL CHECK (reason_code IN
      ('user_request','consent_withdrawn','retention_expired','test_cleanup')),
    source_state TEXT NOT NULL CHECK (source_state IN ('pending','deleted','missing')),
    backup_state TEXT NOT NULL CHECK (backup_state = 'pending_expiry'),
    export_state TEXT NOT NULL CHECK (export_state = 'pending_rebuild'),
    remote_state TEXT NOT NULL CHECK (remote_state = 'deferred'),
    deleted_nodes INTEGER NOT NULL DEFAULT 0 CHECK (deleted_nodes >= 0),
    deleted_edges INTEGER NOT NULL DEFAULT 0 CHECK (deleted_edges >= 0),
    deleted_communities INTEGER NOT NULL DEFAULT 0 CHECK (deleted_communities >= 0),
    deleted_episodes INTEGER NOT NULL DEFAULT 0 CHECK (deleted_episodes >= 0),
    deleted_assertions INTEGER NOT NULL DEFAULT 0 CHECK (deleted_assertions >= 0),
    deleted_contradictions INTEGER NOT NULL DEFAULT 0 CHECK (deleted_contradictions >= 0),
    deleted_candidates INTEGER NOT NULL DEFAULT 0 CHECK (deleted_candidates >= 0),
    deleted_admissions INTEGER NOT NULL DEFAULT 0 CHECK (deleted_admissions >= 0),
    deleted_reviews INTEGER NOT NULL DEFAULT 0 CHECK (deleted_reviews >= 0),
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    receipt_mac TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_engram_erasure_requests_status
    ON records_engram_erasure_requests(tenant_id, status, requested_at);

  CREATE VIEW IF NOT EXISTS engram_erasure_tombstones AS
    SELECT * FROM records_engram_erasure_tombstones
    WHERE tenant_id = current_tenant_id();

  CREATE VIEW IF NOT EXISTS engram_erasure_requests AS
    SELECT * FROM records_engram_erasure_requests
    WHERE tenant_id = current_tenant_id();
`;

interface ErasureRow {
  tenant_id: string;
  owner_principal_id: string;
  id: string;
  source_alias: string;
  source_node_id: string | null;
  status: ErasureStatus;
  reason_code: ErasureReason;
  source_state: ErasureReceipt['sourceState'];
  backup_state: ErasureReceipt['backupState'];
  export_state: ErasureReceipt['exportState'];
  remote_state: ErasureReceipt['remoteState'];
  deleted_nodes: number;
  deleted_edges: number;
  deleted_communities: number;
  deleted_episodes: number;
  deleted_assertions: number;
  deleted_contradictions: number;
  deleted_candidates: number;
  deleted_admissions: number;
  deleted_reviews: number;
  requested_at: string;
  completed_at: string | null;
  receipt_mac: string;
}

interface DeletionCounts {
  nodes: number;
  edges: number;
  communities: number;
  episodes: number;
  assertions: number;
  contradictions: number;
  candidates: number;
  admissions: number;
  reviews: number;
}

export interface ErasureServiceOptions {
  receiptKey: Uint8Array;
  ledger: TombstoneLedgerWriter;
  authorizer?: ToolAuthorizer;
  now?: () => number;
}

export function ensureErasureTables(db: Database.Database): void {
  db.exec(ERASURE_SCHEMA);
}

/**
 * Stable pseudonymous suppression key. It intentionally preserves no source
 * path or content, but remains deterministic across a verified rebuild.
 */
export function sourceErasureAlias(tenantId: string, sourceNodeId: string): string {
  const canonicalSourceNodeId = erasureIdentity(sourceNodeId);
  return createHash('sha256')
    .update('engram-erasure-source-v1')
    .update('\0')
    .update(tenantId)
    .update('\0')
    .update(canonicalSourceNodeId)
    .digest('hex');
}

/**
 * Pseudonymous lookup key for unresolved wiki-link stems. This lets an index
 * rebuild suppress links to a deleted source without retaining its raw path.
 */
export function sourceStemErasureAlias(tenantId: string, sourceNodeId: string): string {
  const canonicalSourceNodeId = erasureIdentity(sourceNodeId);
  const stem = basename(canonicalSourceNodeId, '.md');
  return createHash('sha256')
    .update('engram-erasure-source-stem-v1')
    .update('\0')
    .update(tenantId)
    .update('\0')
    .update(stem)
    .digest('hex');
}

function erasureIdentity(sourceNodeId: string): string {
  // The laptop vault boundary is case-insensitive and Unicode-normalizing.
  // Tombstones must therefore collapse filesystem-equivalent spellings even
  // after the original file has been deleted and can no longer be realpathed.
  return canonicalSourceId(sourceNodeId)
    .normalize('NFD')
    .toLocaleUpperCase('en-US')
    .toLocaleLowerCase('en-US')
    .normalize('NFD');
}

export function canonicalSourceId(sourceNodeId: string): string {
  if (typeof sourceNodeId !== 'string'
    || sourceNodeId.length < 1
    || sourceNodeId.length > 4096
    || /[\0\r\n]/.test(sourceNodeId)
    || normalizePath(sourceNodeId) !== sourceNodeId) {
    throw new Error('Source identifier is not canonical');
  }
  return sourceNodeId;
}

export class MemoryErasureService {
  private readonly now: () => number;

  constructor(private readonly options: ErasureServiceOptions) {
    if (options.receiptKey.byteLength < 32) {
      throw new Error('Erasure receipt HMAC key must be at least 32 bytes');
    }
    if (!options.ledger || typeof options.ledger.append !== 'function') {
      throw new Error('External tombstone ledger is required');
    }
    this.now = options.now ?? Date.now;
  }

  eraseAssertion(
    store: Store,
    input: {
      assertionId: string;
      reason: ErasureReason;
      identity: VerifiedRequestIdentity;
      writer: ErasureSourceWriter;
    },
  ): ErasureReceipt {
    validateReason(input.reason);
    boundedId('assertionId', input.assertionId);
    this.authorize(store.db, input.identity);

    const assertion = store.db.prepare(`
      SELECT a.id, a.source_node_id
      FROM engram_assertions a
      JOIN records_nodes n
        ON n.tenant_id = current_tenant_id() AND n.id = a.source_node_id
      WHERE a.id = ?
        AND a.owner_principal_id = current_principal_id()
        AND n.owner_principal_id = current_principal_id()
    `).get(input.assertionId) as { id: string; source_node_id: string | null } | undefined;
    if (!assertion) throw new Error('Erasure target not found');
    if (!assertion.source_node_id) throw new Error('Erasure target has no source');

    const context = currentContext(store.db);
    const sourceAlias = sourceErasureAlias(context.tenantId, assertion.source_node_id);
    const sourceStemAlias = sourceStemErasureAlias(context.tenantId, assertion.source_node_id);
    const requestedAt = new Date(this.now()).toISOString();
    const requestId = randomUUID();
    const pending = pendingRow({
      id: requestId,
      tenantId: context.tenantId,
      principalId: context.principalId,
      sourceAlias,
      sourceNodeId: assertion.source_node_id,
      reason: input.reason,
      requestedAt,
    });
    pending.receipt_mac = this.mac(pending);

    // The external ledger is write-ahead. Once a destructive request is
    // authorized, a database backup can no longer discard its tombstone. A
    // later local failure remains incomplete and retryable, but rebuilds fail
    // closed against the durable ledger entry.
    this.options.ledger.append({
      accessContext: context,
      sourceAlias,
      sourceStemAlias,
      requestId,
      reasonCode: input.reason,
      policyVersion: ERASURE_POLICY_VERSION,
      createdAt: requestedAt,
    });

    store.db.transaction(() => {
      store.db.prepare(`
        INSERT INTO records_engram_erasure_requests
          (tenant_id, owner_principal_id, id, source_alias, source_node_id,
           status, reason_code, source_state, backup_state, export_state,
           remote_state, requested_at, receipt_mac)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, 'pending', 'pending_expiry',
          'pending_rebuild', 'deferred', ?, ?)
      `).run(
        context.tenantId,
        context.principalId,
        requestId,
        sourceAlias,
        assertion.source_node_id,
        input.reason,
        requestedAt,
        pending.receipt_mac,
      );
      store.db.prepare(`
        INSERT OR IGNORE INTO records_engram_erasure_tombstones
          (tenant_id, owner_principal_id, source_alias, source_stem_alias,
           request_id, reason_code, policy_version, created_at)
        VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, ?)
      `).run(
        sourceAlias,
        sourceStemAlias,
        requestId,
        input.reason,
        ERASURE_POLICY_VERSION,
        requestedAt,
      );
      const counts = MemoryErasureService.purgeSourceReplicas(store, assertion.source_node_id!);
      this.updateRequest(store.db, requestId, {
        status: 'source_cleanup_pending',
        sourceState: 'pending',
        counts,
        completedAt: null,
        clearSource: false,
      });
    })();

    return this.process(store, requestId, input.writer);
  }

  resume(
    store: Store,
    input: {
      requestId: string;
      identity: VerifiedRequestIdentity;
      writer: ErasureSourceWriter;
    },
  ): ErasureReceipt {
    boundedId('requestId', input.requestId);
    this.authorize(store.db, input.identity);
    const row = this.requireOwnedRow(store.db, input.requestId);
    if (row.status === 'local_complete') return this.receipt(row);
    return this.process(store, input.requestId, input.writer);
  }

  getReceipt(
    db: Database.Database,
    requestId: string,
    identity: VerifiedRequestIdentity,
  ): ErasureReceipt {
    boundedId('requestId', requestId);
    this.requireMatchingContext(db, identity);
    return this.receipt(this.requireOwnedRow(db, requestId));
  }

  private process(store: Store, requestId: string, writer: ErasureSourceWriter): ErasureReceipt {
    const row = this.requireOwnedRow(store.db, requestId);
    this.receipt(row);
    if (!row.source_node_id) throw new Error('Pending erasure request is missing its source');

    let sourceState: ErasureReceipt['sourceState'];
    try {
      sourceState = writer.deleteSource(row.source_node_id);
    } catch {
      sourceState = 'pending';
    }

    let counts: DeletionCounts;
    try {
      counts = MemoryErasureService.purgeSourceReplicas(store, row.source_node_id);
    } catch {
      return this.updateRequest(store.db, requestId, {
        status: 'database_cleanup_pending',
        sourceState,
        counts: zeroCounts(),
        completedAt: null,
        clearSource: false,
      });
    }

    const complete = sourceState !== 'pending';
    return this.updateRequest(store.db, requestId, {
      status: complete ? 'local_complete' : 'source_cleanup_pending',
      sourceState,
      counts,
      completedAt: complete ? new Date(this.now()).toISOString() : null,
      clearSource: complete,
    });
  }

  static purgeSourceReplicas(store: Store, sourceNodeId: string): DeletionCounts {
    return store.db.transaction(() => {
      const derivedStubRows = store.db.prepare(`
        SELECT DISTINCT n.id
        FROM records_edges e
        JOIN records_nodes n
          ON n.tenant_id = current_tenant_id()
          AND n.owner_principal_id = current_principal_id()
          AND n.id = e.target_id
        WHERE e.tenant_id = current_tenant_id()
          AND e.owner_principal_id = current_principal_id()
          AND e.source_id = ?
          AND substr(n.id, 1, 6) = '_stub/'
          AND json_extract(n.frontmatter, '$._stub') = 1
      `).all(sourceNodeId) as Array<{ id: string }>;
      const assertionRows = store.db.prepare(`
        SELECT id FROM records_engram_assertions
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND source_node_id = ?
      `).all(sourceNodeId) as Array<{ id: string }>;
      const assertionIds = assertionRows.map(row => row.id);
      const candidateRows = assertionIds.length > 0
        ? store.db.prepare(`
            SELECT id FROM records_engram_memory_candidates
            WHERE tenant_id = current_tenant_id()
              AND owner_principal_id = current_principal_id()
              AND (source_node_id = ? OR assertion_id IN (${placeholders(assertionIds.length)}))
          `).all(sourceNodeId, ...assertionIds) as Array<{ id: string }>
        : store.db.prepare(`
            SELECT id FROM records_engram_memory_candidates
            WHERE tenant_id = current_tenant_id()
              AND owner_principal_id = current_principal_id()
              AND source_node_id = ?
          `).all(sourceNodeId) as Array<{ id: string }>;
      const candidateIds = candidateRows.map(row => row.id);

      const contradictions = assertionIds.length > 0
        ? store.db.prepare(`
            DELETE FROM records_engram_contradiction_cases
            WHERE tenant_id = current_tenant_id()
              AND owner_principal_id = current_principal_id()
              AND (source_node_id = ? OR assertion_a_id IN (${placeholders(assertionIds.length)})
                OR assertion_b_id IN (${placeholders(assertionIds.length)}))
          `).run(sourceNodeId, ...assertionIds, ...assertionIds).changes
        : store.db.prepare(`
            DELETE FROM records_engram_contradiction_cases
            WHERE tenant_id = current_tenant_id()
              AND owner_principal_id = current_principal_id()
              AND source_node_id = ?
          `).run(sourceNodeId).changes;

      const reviews = candidateIds.length > 0
        ? store.db.prepare(`
            DELETE FROM records_engram_memory_reviews
            WHERE tenant_id = current_tenant_id()
              AND owner_principal_id = current_principal_id()
              AND candidate_id IN (${placeholders(candidateIds.length)})
          `).run(...candidateIds).changes
        : 0;
      const admissions = store.db.prepare(`
        DELETE FROM records_engram_memory_sources
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND source_node_id = ?
      `).run(sourceNodeId).changes;
      const candidates = candidateIds.length > 0
        ? store.db.prepare(`
            DELETE FROM records_engram_memory_candidates
            WHERE tenant_id = current_tenant_id()
              AND owner_principal_id = current_principal_id()
              AND id IN (${placeholders(candidateIds.length)})
          `).run(...candidateIds).changes
        : 0;
      if (assertionIds.length > 0) {
        store.db.prepare(`
          UPDATE records_engram_assertions SET superseded_by = NULL
          WHERE tenant_id = current_tenant_id()
            AND owner_principal_id = current_principal_id()
            AND superseded_by IN (${placeholders(assertionIds.length)})
        `).run(...assertionIds);
      }
      const assertions = store.db.prepare(`
        DELETE FROM records_engram_assertions
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND source_node_id = ?
      `).run(sourceNodeId).changes;
      const episodes = store.db.prepare(`
        DELETE FROM records_engram_episodes
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND source_node_id = ?
      `).run(sourceNodeId).changes;
      const communities = store.db.prepare(`
        DELETE FROM records_communities
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND EXISTS (
            SELECT 1 FROM json_each(records_communities.node_ids)
            WHERE typeof(value) = 'text' AND value = ?
          )
      `).run(sourceNodeId).changes;
      const edges = store.db.prepare(`
        SELECT COUNT(*) AS count FROM records_edges
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND (source_id = ? OR target_id = ?)
      `).get(sourceNodeId, sourceNodeId) as { count: number };
      const node = store.db.prepare(`
        SELECT 1 FROM records_nodes
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
          AND id = ?
      `).get(sourceNodeId);
      if (node) store.deleteNode(sourceNodeId);
      let derivedStubs = 0;
      for (const { id } of derivedStubRows) {
        const incident = store.db.prepare(`
          SELECT 1 FROM records_edges
          WHERE tenant_id = current_tenant_id()
            AND (source_id = ? OR target_id = ?)
          LIMIT 1
        `).get(id, id);
        if (!incident) {
          store.deleteNode(id);
          derivedStubs++;
        }
      }

      return {
        nodes: (node ? 1 : 0) + derivedStubs,
        edges: edges.count,
        communities,
        episodes,
        assertions,
        contradictions,
        candidates,
        admissions,
        reviews,
      };
    })();
  }

  private updateRequest(
    db: Database.Database,
    requestId: string,
    update: {
      status: ErasureStatus;
      sourceState: ErasureReceipt['sourceState'];
      counts: DeletionCounts;
      completedAt: string | null;
      clearSource: boolean;
    },
  ): ErasureReceipt {
    const current = this.requireOwnedRow(db, requestId);
    const next: ErasureRow = {
      ...current,
      source_node_id: update.clearSource ? null : current.source_node_id,
      status: update.status,
      source_state: update.sourceState,
      deleted_nodes: current.deleted_nodes + update.counts.nodes,
      deleted_edges: current.deleted_edges + update.counts.edges,
      deleted_communities: current.deleted_communities + update.counts.communities,
      deleted_episodes: current.deleted_episodes + update.counts.episodes,
      deleted_assertions: current.deleted_assertions + update.counts.assertions,
      deleted_contradictions: current.deleted_contradictions + update.counts.contradictions,
      deleted_candidates: current.deleted_candidates + update.counts.candidates,
      deleted_admissions: current.deleted_admissions + update.counts.admissions,
      deleted_reviews: current.deleted_reviews + update.counts.reviews,
      completed_at: update.completedAt,
      receipt_mac: '',
    };
    next.receipt_mac = this.mac(next);
    db.prepare(`
      UPDATE records_engram_erasure_requests SET
        source_node_id = ?, status = ?, source_state = ?,
        deleted_nodes = ?, deleted_edges = ?, deleted_communities = ?,
        deleted_episodes = ?, deleted_assertions = ?, deleted_contradictions = ?,
        deleted_candidates = ?, deleted_admissions = ?, deleted_reviews = ?,
        completed_at = ?, receipt_mac = ?
      WHERE tenant_id = current_tenant_id() AND owner_principal_id = current_principal_id()
        AND id = ?
    `).run(
      next.source_node_id,
      next.status,
      next.source_state,
      next.deleted_nodes,
      next.deleted_edges,
      next.deleted_communities,
      next.deleted_episodes,
      next.deleted_assertions,
      next.deleted_contradictions,
      next.deleted_candidates,
      next.deleted_admissions,
      next.deleted_reviews,
      next.completed_at,
      next.receipt_mac,
      requestId,
    );
    return this.receipt(next);
  }

  private authorize(db: Database.Database, identity: VerifiedRequestIdentity): void {
    this.requireMatchingContext(db, identity);
    if (!this.options.authorizer) throw new Error('Erasure authorizer is not configured');
    const decision = this.options.authorizer.authorize(identity, 'engram_erase');
    if (!decision.allowed) throw new Error(`Erasure authorization denied: ${decision.reason}`);
  }

  private requireMatchingContext(db: Database.Database, identity: VerifiedRequestIdentity): void {
    const context = currentContext(db);
    if (identity.accessContext.tenantId !== context.tenantId) {
      throw new Error('Erasure tenant does not match database context');
    }
    if (identity.accessContext.principalId !== context.principalId) {
      throw new Error('Erasure principal does not match database context');
    }
  }

  private requireOwnedRow(db: Database.Database, requestId: string): ErasureRow {
    const row = db.prepare(`
      SELECT * FROM engram_erasure_requests
      WHERE id = ? AND owner_principal_id = current_principal_id()
    `).get(requestId) as ErasureRow | undefined;
    if (!row) throw new Error('Erasure request not found');
    return row;
  }

  private receipt(row: ErasureRow): ErasureReceipt {
    const expected = Buffer.from(this.mac({ ...row, receipt_mac: '' }), 'hex');
    const actual = Buffer.from(row.receipt_mac, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('Erasure receipt integrity check failed');
    }
    return {
      requestId: row.id,
      status: row.status,
      sourceAlias: row.source_alias,
      sourceState: row.source_state,
      backupState: row.backup_state,
      exportState: row.export_state,
      remoteState: row.remote_state,
      deleted: {
        nodes: row.deleted_nodes,
        edges: row.deleted_edges,
        communities: row.deleted_communities,
        episodes: row.deleted_episodes,
        assertions: row.deleted_assertions,
        contradictions: row.deleted_contradictions,
        candidates: row.deleted_candidates,
        admissions: row.deleted_admissions,
        reviews: row.deleted_reviews,
      },
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
    };
  }

  private mac(row: ErasureRow): string {
    return createHmac('sha256', this.options.receiptKey)
      .update(JSON.stringify([
        row.tenant_id,
        row.owner_principal_id,
        row.id,
        row.source_alias,
        row.source_node_id,
        row.status,
        row.reason_code,
        row.source_state,
        row.backup_state,
        row.export_state,
        row.remote_state,
        row.deleted_nodes,
        row.deleted_edges,
        row.deleted_communities,
        row.deleted_episodes,
        row.deleted_assertions,
        row.deleted_contradictions,
        row.deleted_candidates,
        row.deleted_admissions,
        row.deleted_reviews,
        row.requested_at,
        row.completed_at,
        ERASURE_POLICY_VERSION,
      ]))
      .digest('hex');
  }
}

function pendingRow(input: {
  id: string;
  tenantId: string;
  principalId: string;
  sourceAlias: string;
  sourceNodeId: string;
  reason: ErasureReason;
  requestedAt: string;
}): ErasureRow {
  return {
    tenant_id: input.tenantId,
    owner_principal_id: input.principalId,
    id: input.id,
    source_alias: input.sourceAlias,
    source_node_id: input.sourceNodeId,
    status: 'pending',
    reason_code: input.reason,
    source_state: 'pending',
    backup_state: 'pending_expiry',
    export_state: 'pending_rebuild',
    remote_state: 'deferred',
    deleted_nodes: 0,
    deleted_edges: 0,
    deleted_communities: 0,
    deleted_episodes: 0,
    deleted_assertions: 0,
    deleted_contradictions: 0,
    deleted_candidates: 0,
    deleted_admissions: 0,
    deleted_reviews: 0,
    requested_at: input.requestedAt,
    completed_at: null,
    receipt_mac: '',
  };
}

function currentContext(db: Database.Database): { tenantId: string; principalId: string } {
  const row = db.prepare(`
    SELECT current_tenant_id() AS tenant_id, current_principal_id() AS principal_id
  `).get() as { tenant_id: string; principal_id: string };
  return { tenantId: row.tenant_id, principalId: row.principal_id };
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

function zeroCounts(): DeletionCounts {
  return {
    nodes: 0,
    edges: 0,
    communities: 0,
    episodes: 0,
    assertions: 0,
    contradictions: 0,
    candidates: 0,
    admissions: 0,
    reviews: 0,
  };
}

function boundedId(field: string, value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function validateReason(value: string): asserts value is ErasureReason {
  if (!['user_request', 'consent_withdrawn', 'retention_expired', 'test_cleanup'].includes(value)) {
    throw new Error('Erasure reason is invalid');
  }
}
