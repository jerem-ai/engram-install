import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { ParsedNode, ParsedEdge, SearchResult } from './types.js';
import { ensureEpisodesTable } from './engram/episodes.js';
import { ensureAssertionTables } from './engram/assertions.js';
import { ensureMemoryAdmissionTables } from './engram/admission.js';
import {
  ensureErasureTables,
  sourceErasureAlias,
  sourceStemErasureAlias,
} from './engram/erasure.js';
import {
  SECURITY_POLICY_VERSION,
  SECURITY_SCHEMA_VERSION,
  validateAccessContext,
  type AccessContext,
} from './access-context.js';

export class LegacyUnscopedDatabaseError extends Error {
  constructor() {
    super('Legacy unscoped database refused; run the reviewed tenant migration into a new destination');
    this.name = 'LegacyUnscopedDatabaseError';
  }
}

export class TenantBindingMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Tenant binding mismatch: database belongs to ${actual}, not ${expected}`);
    this.name = 'TenantBindingMismatchError';
  }
}

export class SecurityPolicyMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Security policy mismatch: database=${actual}, runtime=${expected}`);
    this.name = 'SecurityPolicyMismatchError';
  }
}

export class ErasedSourceError extends Error {
  constructor() {
    super('Source is suppressed by a durable erasure tombstone');
    this.name = 'ErasedSourceError';
  }
}

export interface StoreOptions {
  /**
   * Open the database read-only. Skips the WAL pragma, schema creation and
   * migrations, so the file on disk is never touched. The tenant binding and
   * schema/policy version checks still run. Use for benchmarks and probes
   * against a replica that must stay byte-identical.
   */
  readonly?: boolean;
}

export class Store {
  db: Database.Database;
  readonly accessContext: AccessContext;
  readonly readonly: boolean;

  constructor(dbPath: string, accessContext: AccessContext, options: StoreOptions = {}) {
    this.accessContext = validateAccessContext(accessContext);
    this.readonly = options.readonly === true;
    this.db = this.readonly
      ? new Database(dbPath, { readonly: true, fileMustExist: true })
      : new Database(dbPath);
    try {
      this.db.function('current_tenant_id', () => this.accessContext.tenantId);
      this.db.function('current_principal_id', () => this.accessContext.principalId);
      this.db.function('source_erasure_alias', (sourceNodeId: unknown) => {
        if (typeof sourceNodeId !== 'string') return null;
        return sourceErasureAlias(this.accessContext.tenantId, sourceNodeId);
      });
      this.assertCompatibleDatabaseBeforeWrite();
      if (!this.readonly) this.db.pragma('journal_mode = WAL');
      sqliteVec.load(this.db);
      if (!this.readonly) {
        this.createSchema();
        this.runMigrations();
      }
    } catch (error) {
      if (this.db.open) this.db.close();
      throw error;
    }
  }

  private assertCompatibleDatabaseBeforeWrite(): void {
    const metadataExists = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'security_metadata'"
    ).get();
    if (!metadataExists) {
      const legacy = this.db.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE name IN ('nodes', 'edges', 'communities', 'sync', 'engram_episodes',
          'engram_assertions', 'engram_contradiction_cases', 'records_nodes',
          'records_edges', 'records_communities', 'records_sync',
          'records_engram_episodes', 'records_engram_assertions',
          'records_engram_contradiction_cases',
          'records_engram_memory_candidates', 'records_engram_memory_sources',
          'records_engram_memory_rejections', 'records_engram_memory_reviews',
          'records_engram_erasure_tombstones', 'records_engram_erasure_requests')
        LIMIT 1
      `).get();
      if (legacy) {
        this.db.close();
        throw new LegacyUnscopedDatabaseError();
      }
      return;
    }

    const metadata = this.db.prepare(`
      SELECT tenant_id, schema_version, policy_version
      FROM security_metadata WHERE singleton = 1
    `).get() as { tenant_id: string; schema_version: number; policy_version: string } | undefined;
    if (!metadata) {
      this.db.close();
      throw new Error('Security metadata is missing its singleton tenant binding');
    }
    if (metadata.tenant_id !== this.accessContext.tenantId) {
      this.db.close();
      throw new TenantBindingMismatchError(this.accessContext.tenantId, metadata.tenant_id);
    }
    if (metadata.schema_version !== SECURITY_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`Security schema migration required: database=${metadata.schema_version}, runtime=${SECURITY_SCHEMA_VERSION}`);
    }
    if (metadata.policy_version !== SECURITY_POLICY_VERSION) {
      this.db.close();
      throw new SecurityPolicyMismatchError(SECURITY_POLICY_VERSION, metadata.policy_version);
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        tenant_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        created_by_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records_nodes (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        pruned INTEGER NOT NULL DEFAULT 0,
        created TEXT,
        started_at TEXT,
        ended_at TEXT,
        source TEXT NOT NULL DEFAULT 'vault'
      );

      CREATE TABLE IF NOT EXISTS records_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        relation_type TEXT NOT NULL DEFAULT 'relates_to',
        confidence REAL NOT NULL DEFAULT 1.0,
        since TEXT,
        metadata TEXT,
        confidence_last_updated TEXT,
        low_confidence_streak INTEGER NOT NULL DEFAULT 0,
        pruned INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_records_edges_tenant_source
        ON records_edges(tenant_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_records_edges_tenant_target
        ON records_edges(tenant_id, target_id);

      CREATE TABLE IF NOT EXISTS records_communities (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        node_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS records_sync (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
        USING fts5(title, content, content='records_nodes', content_rowid='rowid');

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec
        USING vec0(embedding float[384]);

      CREATE VIEW IF NOT EXISTS nodes AS
        SELECT rowid AS rowid, tenant_id, owner_principal_id, id, title, content,
               frontmatter, pruned, created, started_at, ended_at, source
        FROM records_nodes WHERE tenant_id = current_tenant_id();

      CREATE VIEW IF NOT EXISTS edges AS
        SELECT id, tenant_id, owner_principal_id, source_id, target_id, context,
               relation_type, confidence, since, metadata, confidence_last_updated,
               low_confidence_streak, pruned
        FROM records_edges WHERE tenant_id = current_tenant_id();

      CREATE VIEW IF NOT EXISTS communities AS
        SELECT id, tenant_id, owner_principal_id, label, summary, node_ids
        FROM records_communities WHERE tenant_id = current_tenant_id();

      CREATE VIEW IF NOT EXISTS sync AS
        SELECT tenant_id, owner_principal_id, path, mtime, indexed_at
        FROM records_sync WHERE tenant_id = current_tenant_id();
    `);

    this.db.prepare(`
      INSERT OR IGNORE INTO security_metadata
        (singleton, tenant_id, schema_version, policy_version, created_by_principal_id, created_at)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      this.accessContext.tenantId,
      SECURITY_SCHEMA_VERSION,
      SECURITY_POLICY_VERSION,
      this.accessContext.principalId,
      new Date().toISOString(),
    );
  }

  private runMigrations(): void {
    const edgeCols = new Set(
      (this.db.prepare("SELECT name FROM pragma_table_info('records_edges')").all() as { name: string }[])
        .map(r => r.name)
    );

    if (!edgeCols.has('relation_type')) {
      this.db.prepare("ALTER TABLE records_edges ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'relates_to'").run();
    }
    if (!edgeCols.has('confidence')) {
      this.db.prepare('ALTER TABLE records_edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0').run();
    }
    if (!edgeCols.has('since')) {
      this.db.prepare('ALTER TABLE records_edges ADD COLUMN since TEXT').run();
    }
    if (!edgeCols.has('metadata')) {
      this.db.prepare('ALTER TABLE records_edges ADD COLUMN metadata TEXT').run();
    }
    if (!edgeCols.has('confidence_last_updated')) {
      this.db.prepare('ALTER TABLE records_edges ADD COLUMN confidence_last_updated TEXT').run();
    }
    if (!edgeCols.has('low_confidence_streak')) {
      this.db.prepare('ALTER TABLE records_edges ADD COLUMN low_confidence_streak INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!edgeCols.has('pruned')) {
      this.db.prepare('ALTER TABLE records_edges ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0').run();
    }

    const nodeCols = new Set(
      (this.db.prepare("SELECT name FROM pragma_table_info('records_nodes')").all() as { name: string }[])
        .map(r => r.name)
    );
    if (!nodeCols.has('pruned')) {
      this.db.prepare('ALTER TABLE records_nodes ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!nodeCols.has('created')) {
      this.db.prepare('ALTER TABLE records_nodes ADD COLUMN created TEXT').run();
    }
    if (!nodeCols.has('started_at')) {
      this.db.prepare('ALTER TABLE records_nodes ADD COLUMN started_at TEXT').run();
    }
    if (!nodeCols.has('ended_at')) {
      this.db.prepare('ALTER TABLE records_nodes ADD COLUMN ended_at TEXT').run();
    }
    if (!nodeCols.has('source')) {
      this.db.prepare("ALTER TABLE records_nodes ADD COLUMN source TEXT NOT NULL DEFAULT 'vault'").run();
    }

    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_records_edges_relation_type ON records_edges(tenant_id, relation_type)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_records_edges_pruned ON records_edges(tenant_id, pruned)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_records_nodes_created ON records_nodes(tenant_id, created)').run();

    // Engram schema
    ensureEpisodesTable(this.db);
    ensureAssertionTables(this.db);
    ensureMemoryAdmissionTables(this.db);
    ensureErasureTables(this.db);
    this.createScopeTriggers();
    this.createErasureSuppressionTriggers();
  }

  private createScopeTriggers(): void {
    for (const table of [
      'records_nodes',
      'records_edges',
      'records_communities',
      'records_sync',
      'records_engram_episodes',
      'records_engram_assertions',
      'records_engram_contradiction_cases',
      'records_engram_memory_candidates',
      'records_engram_memory_sources',
      'records_engram_memory_rejections',
      'records_engram_memory_reviews',
      'records_engram_erasure_tombstones',
      'records_engram_erasure_requests',
    ]) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS ${table}_scope_insert;
        DROP TRIGGER IF EXISTS ${table}_scope_update;
        DROP TRIGGER IF EXISTS ${table}_scope_delete;

        CREATE TRIGGER ${table}_scope_insert
        BEFORE INSERT ON ${table}
        WHEN NEW.tenant_id != current_tenant_id()
          OR NEW.owner_principal_id != current_principal_id()
        BEGIN
          SELECT RAISE(ABORT, 'access context mismatch');
        END;

        CREATE TRIGGER ${table}_scope_update
        BEFORE UPDATE ON ${table}
        WHEN OLD.tenant_id != current_tenant_id()
          OR OLD.owner_principal_id != current_principal_id()
          OR NEW.tenant_id != OLD.tenant_id
          OR NEW.owner_principal_id != OLD.owner_principal_id
        BEGIN
          SELECT RAISE(ABORT, 'access context mismatch');
        END;

        CREATE TRIGGER ${table}_scope_delete
        BEFORE DELETE ON ${table}
        WHEN OLD.tenant_id != current_tenant_id()
          OR OLD.owner_principal_id != current_principal_id()
        BEGIN
          SELECT RAISE(ABORT, 'access context mismatch');
        END;
      `);
    }
  }

  private createErasureSuppressionTriggers(): void {
    const sourceColumns: ReadonlyArray<{ table: string; columns: string[] }> = [
      { table: 'records_nodes', columns: ['id'] },
      { table: 'records_sync', columns: ['path'] },
      { table: 'records_edges', columns: ['source_id', 'target_id'] },
      { table: 'records_engram_episodes', columns: ['source_node_id'] },
      { table: 'records_engram_assertions', columns: ['source_node_id'] },
      { table: 'records_engram_contradiction_cases', columns: ['source_node_id'] },
      { table: 'records_engram_memory_candidates', columns: ['source_node_id'] },
      { table: 'records_engram_memory_sources', columns: ['source_node_id'] },
    ];
    for (const { table, columns } of sourceColumns) {
      const erased = columns.map(column => `EXISTS (
        SELECT 1 FROM records_engram_erasure_tombstones t
        WHERE t.tenant_id = current_tenant_id()
          AND t.owner_principal_id = current_principal_id()
          AND NEW.${column} IS NOT NULL
          AND t.source_alias = source_erasure_alias(NEW.${column})
      )`).join(' OR ');
      for (const operation of ['insert', 'update']) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS ${table}_erasure_${operation};
          CREATE TRIGGER ${table}_erasure_${operation}
          BEFORE ${operation.toUpperCase()} ON ${table}
          WHEN ${erased}
          BEGIN
            SELECT RAISE(ABORT, 'erased source');
          END;
        `);
      }
    }

    for (const operation of ['insert', 'update']) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS records_communities_erasure_${operation};
        CREATE TRIGGER records_communities_erasure_${operation}
        BEFORE ${operation.toUpperCase()} ON records_communities
        WHEN EXISTS (
          SELECT 1 FROM json_each(NEW.node_ids) j
          JOIN records_engram_erasure_tombstones t
            ON t.tenant_id = current_tenant_id()
           AND t.owner_principal_id = current_principal_id()
           AND typeof(j.value) = 'text'
           AND t.source_alias = source_erasure_alias(j.value)
        )
        BEGIN
          SELECT RAISE(ABORT, 'erased source');
        END;
      `);
    }
  }

  upsertNode(node: ParsedNode): void {
    this.assertSourceNotErased(node.id);
    // FTS5 content-sync tables require manual delete-before-reinsert.
    // We must fetch the ACTUAL old values for the FTS5 delete command.
    // DEPLOY CRITICAL: run `kg index --force` IMMEDIATELY after deploying this
    // code. Any incremental index run between deploy and the force-rebuild will
    // use the new ftsText() (with aliases) for inserts but the OLD stored text
    // for deletes — mismatching the FTS5 external-content invariant, causing
    // double-indexed aliases and phantom search results for previously-indexed
    // aliased nodes.
    const existing = this.db.prepare(`
      SELECT rowid, title, content, frontmatter
      FROM records_nodes
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND id = ?
    `).get(node.id) as { rowid: number; title: string; content: string; frontmatter: string } | undefined;

    if (!existing && this.db.prepare(`
      SELECT 1 FROM records_nodes
      WHERE tenant_id = current_tenant_id() AND id = ?
    `).get(node.id)) {
      throw new Error('access context mismatch');
    }

    if (existing) {
      const existingFm = parseFrontmatter(existing.frontmatter);
      this.db.prepare(
        "INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
      ).run(existing.rowid, existing.title, ftsText(existing.content, existingFm));
    }

    const fm = node.frontmatter;
    const created = typeof fm.created === 'string' ? fm.created : null;
    const startedAt = typeof fm.started_at === 'string' ? fm.started_at : null;
    const endedAt = typeof fm.ended_at === 'string' ? fm.ended_at : null;

    this.db.prepare(`
      INSERT INTO records_nodes
        (tenant_id, owner_principal_id, id, title, content, frontmatter,
         created, started_at, ended_at, source)
      VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        frontmatter = excluded.frontmatter,
        created = excluded.created,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        source = excluded.source
    `).run(
      node.id,
      node.title,
      node.content,
      JSON.stringify(node.frontmatter),
      created,
      startedAt,
      endedAt,
      node.source ?? 'vault',
    );

    const row = this.db.prepare(
      'SELECT rowid FROM nodes WHERE id = ?'
    ).get(node.id) as { rowid: number };

    this.db.prepare(
      'INSERT INTO nodes_fts(rowid, title, content) VALUES(?, ?, ?)'
    ).run(row.rowid, node.title, ftsText(node.content, node.frontmatter));
  }

  getNode(id: string): (ParsedNode & { rowid: number }) | undefined {
    const row = this.db.prepare(
      'SELECT rowid, id, title, content, frontmatter FROM nodes WHERE id = ?'
    ).get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      frontmatter: JSON.parse(row.frontmatter),
      rowid: row.rowid,
    };
  }

  isSourceErased(sourceNodeId: string): boolean {
    const alias = sourceErasureAlias(this.accessContext.tenantId, sourceNodeId);
    return !!this.db.prepare(`
      SELECT 1 FROM records_engram_erasure_tombstones
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND source_alias = ?
    `).get(alias);
  }

  isUnresolvedLinkTargetErased(linkTarget: string): boolean {
    const withMd = linkTarget.endsWith('.md') ? linkTarget : `${linkTarget}.md`;
    if (this.isSourceErased(withMd)) return true;
    const stemAlias = sourceStemErasureAlias(this.accessContext.tenantId, withMd);
    return !!this.db.prepare(`
      SELECT 1 FROM records_engram_erasure_tombstones
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND source_stem_alias = ?
    `).get(stemAlias);
  }

  assertSourceNotErased(sourceNodeId: string): void {
    if (this.isSourceErased(sourceNodeId)) throw new ErasedSourceError();
  }

  getNodesByDateRange(
    start: string,
    end: string,
  ): Array<{ id: string; title: string; created: string }> {
    return this.db.prepare(`
      SELECT id, title, created
      FROM nodes
      WHERE created IS NOT NULL
        AND created >= ?
        AND created <= ?
      ORDER BY created ASC
    `).all(start, end).map((r: any) => ({
      id: r.id,
      title: r.title,
      created: r.created,
    }));
  }

  countNodes(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number };
    return row.cnt;
  }

  // Episodic layer: session-log nodes with a started_at timestamp, filtered to a
  // date range (YYYY-MM-DD, inclusive on the date portion so TZ offsets don't
  // clip boundary days). Automated sessions (briefings/health-crons/digests,
  // tagged `automated: true` in frontmatter) are excluded unless requested.
  getSessionsByTimeRange(
    start: string,
    end: string,
    includeAutomated = false,
  ): Array<{ id: string; title: string; startedAt: string; content: string; automated: boolean }> {
    const rows = this.db.prepare(`
      SELECT id, title, started_at, content,
             json_extract(frontmatter, '$.automated') AS automated
      FROM nodes
      WHERE started_at IS NOT NULL
        AND id LIKE 'Sessions/%'
        AND substr(started_at, 1, 10) >= ?
        AND substr(started_at, 1, 10) <= ?
      ORDER BY started_at DESC
    `).all(start, end) as any[];
    return rows
      .filter(r => includeAutomated || !r.automated)
      .map(r => ({
        id: r.id,
        title: r.title,
        startedAt: r.started_at,
        content: r.content ?? '',
        automated: !!r.automated,
      }));
  }

  allNodeIds(): string[] {
    return this.db.prepare('SELECT id FROM nodes').all().map((r: any) => r.id);
  }

  insertEdge(edge: ParsedEdge): void {
    this.assertSourceNotErased(edge.sourceId);
    this.assertSourceNotErased(edge.targetId);
    this.db.prepare(
      `INSERT INTO records_edges
        (tenant_id, owner_principal_id, source_id, target_id, context,
         relation_type, confidence, since, metadata)
       VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      edge.sourceId,
      edge.targetId,
      edge.context,
      edge.relationType ?? 'relates_to',
      edge.confidence ?? 1.0,
      edge.since ?? null,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    );
  }

  getEdgesFrom(nodeId: string): Array<ParsedEdge & { id: number }> {
    return this.db.prepare(
      'SELECT id, source_id, target_id, context, relation_type, confidence, since, metadata FROM edges WHERE source_id = ?'
    ).all(nodeId).map((r: any) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      context: r.context,
      relationType: r.relation_type,
      confidence: r.confidence,
      since: r.since ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  getEdgesTo(nodeId: string): Array<ParsedEdge & { id: number }> {
    return this.db.prepare(
      'SELECT id, source_id, target_id, context, relation_type, confidence, since, metadata FROM edges WHERE target_id = ?'
    ).all(nodeId).map((r: any) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      context: r.context,
      relationType: r.relation_type,
      confidence: r.confidence,
      since: r.since ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  getEdgesFromByRelationType(nodeId: string, relationType: string): Array<ParsedEdge & { id: number }> {
    return this.db.prepare(
      'SELECT id, source_id, target_id, context, relation_type, confidence, since, metadata FROM edges WHERE source_id = ? AND relation_type = ?'
    ).all(nodeId, relationType).map((r: any) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      context: r.context,
      relationType: r.relation_type,
      confidence: r.confidence,
      since: r.since ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  countEdgesFrom(nodeId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?'
    ).get(nodeId) as { cnt: number };
    return row.cnt;
  }

  countEdgesTo(nodeId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?'
    ).get(nodeId) as { cnt: number };
    return row.cnt;
  }

  getEdgeSummariesFrom(nodeId: string): Array<{ nodeId: string; title: string; relationType: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.target_id, n.title, e.relation_type
      FROM edges e
      LEFT JOIN nodes n ON n.id = e.target_id
      WHERE e.source_id = ?
    `).all(nodeId).map((r: any) => ({
      nodeId: r.target_id,
      title: r.title ?? r.target_id,
      relationType: r.relation_type,
    }));
  }

  getEdgeSummariesTo(nodeId: string): Array<{ nodeId: string; title: string; relationType: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.source_id, n.title, e.relation_type
      FROM edges e
      LEFT JOIN nodes n ON n.id = e.source_id
      WHERE e.target_id = ?
    `).all(nodeId).map((r: any) => ({
      nodeId: r.source_id,
      title: r.title ?? r.source_id,
      relationType: r.relation_type,
    }));
  }

  deleteNode(id: string): void {
    // FTS5 delete requires actual old values, not empty strings.
    // Must select frontmatter and use ftsText() identically to upsertNode —
    // passing raw content without aliases would corrupt the external-content index.
    const row = this.db.prepare(`
      SELECT rowid, title, content, frontmatter
      FROM records_nodes
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND id = ?
    `).get(id) as { rowid: number; title: string; content: string; frontmatter: string } | undefined;

    if (!row && this.db.prepare(`
      SELECT 1 FROM records_nodes
      WHERE tenant_id = current_tenant_id() AND id = ?
    `).get(id)) {
      throw new Error('access context mismatch');
    }

    if (row) {
      const rowFm = parseFrontmatter(row.frontmatter);
      this.db.prepare(
        "INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
      ).run(row.rowid, row.title, ftsText(row.content, rowFm));
      // sqlite-vec requires BigInt rowids via better-sqlite3
      this.db.prepare('DELETE FROM nodes_vec WHERE rowid = ?').run(BigInt(row.rowid));
    }

    this.db.prepare(`
      DELETE FROM records_nodes
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND id = ?
    `).run(id);
    this.db.prepare(`
      DELETE FROM records_edges
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND (source_id = ? OR target_id = ?)
    `).run(id, id);
    this.db.prepare(`
      DELETE FROM records_sync
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND path = ?
    `).run(id);
  }

  deleteAllEdgesFrom(nodeId: string): void {
    this.db.prepare(`
      DELETE FROM records_edges
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND source_id = ?
    `).run(nodeId);
  }

  searchFullText(query: string): SearchResult[] {
    return this.db.prepare(`
      SELECT n.id, n.title, n.frontmatter, rank,
        snippet(nodes_fts, 1, '>>>', '<<<', '...', 40) as excerpt
      FROM nodes_fts f
      JOIN nodes n ON n.rowid = f.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `).all(query).map((r: any) => ({
      nodeId: r.id,
      title: r.title,
      score: -r.rank,
      excerpt: r.excerpt ?? '',
      frontmatter: parseFrontmatter(r.frontmatter),
    }));
  }

  getNodeEmbedding(nodeId: string): Float32Array | null {
    const node = this.getNode(nodeId);
    if (!node) return null;
    try {
      const row = this.db.prepare(
        'SELECT embedding FROM nodes_vec WHERE rowid = ?'
      ).get(BigInt(node.rowid)) as { embedding: Buffer } | undefined;
      if (!row?.embedding) return null;
      const buf = row.embedding;
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    } catch {
      return null;
    }
  }

  upsertEmbedding(nodeId: string, embedding: Float32Array): void {
    this.assertSourceNotErased(nodeId);
    const node = this.db.prepare(`
      SELECT rowid FROM records_nodes
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND id = ?
    `).get(nodeId) as { rowid: number } | undefined;
    if (!node) {
      if (this.db.prepare(`
        SELECT 1 FROM records_nodes
        WHERE tenant_id = current_tenant_id() AND id = ?
      `).get(nodeId)) throw new Error('access context mismatch');
      return;
    }
    // sqlite-vec requires BigInt rowids via better-sqlite3
    this.db.prepare('DELETE FROM nodes_vec WHERE rowid = ?').run(BigInt(node.rowid));
    this.db.prepare(
      'INSERT INTO nodes_vec(rowid, embedding) VALUES (?, ?)'
    ).run(BigInt(node.rowid), Buffer.from(embedding.buffer));
  }

  searchVector(embedding: Float32Array, limit = 20): SearchResult[] {
    return this.db.prepare(`
      SELECT v.rowid, v.distance, n.id, n.title, n.content, n.frontmatter
      FROM nodes_vec v
      JOIN nodes n ON n.rowid = v.rowid
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(Buffer.from(embedding.buffer), limit).map((r: any) => ({
      nodeId: r.id,
      title: r.title,
      score: 1 - r.distance,
      excerpt: firstParagraph(r.content ?? '', 200),
      frontmatter: parseFrontmatter(r.frontmatter),
    }));
  }

  searchVectorBySource(embedding: Float32Array, source: string, limit = 10): SearchResult[] {
    // sqlite-vec's ANN query cannot filter on joined node metadata. Applying a
    // global k and filtering afterward can starve a smaller source partition,
    // so scoped retrieval deliberately uses the exact scalar distance function.
    const candidates = this.db.prepare(`
      SELECT v.rowid, vec_distance_L2(v.embedding, ?) AS distance,
             n.id, n.title, n.content, n.source, n.frontmatter
      FROM nodes_vec v
      JOIN nodes n ON n.rowid = v.rowid
      WHERE n.source = ?
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(embedding.buffer), source, limit) as any[];

    return candidates
      .map(r => ({
        nodeId: r.id,
        title: r.title,
        score: 1 - r.distance,
        excerpt: firstParagraph(r.content ?? '', 200),
        frontmatter: parseFrontmatter(r.frontmatter),
      }));
  }

  // Semantic search scoped to MEMORY nodes. Memory lives as vault nodes under the
  // `Memory/` path (the KG_MEMORY_BASE/source='memory' path was retired in favor of
  // the vault mirror), so kg_memory_search must scope here, not on source='memory'.
  searchMemory(embedding: Float32Array, limit = 10): SearchResult[] {
    const candidates = this.db.prepare(`
      SELECT vec_distance_L2(v.embedding, ?) AS distance,
             n.id, n.title, n.content, n.source, n.frontmatter
      FROM nodes_vec v
      JOIN nodes n ON n.rowid = v.rowid
      WHERE n.source = 'vault' AND n.id LIKE 'Memory/%'
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(embedding.buffer), limit) as any[];

    return candidates
      .map(r => ({
        nodeId: r.id,
        title: r.title,
        score: 1 - r.distance,
        // Embeddings are unit vectors: squared L2 distance = 2 - 2*cosine.
        cosine: Math.max(-1, Math.min(1, 1 - r.distance * r.distance / 2)),
        excerpt: firstParagraph(r.content ?? '', 200),
        frontmatter: parseFrontmatter(r.frontmatter),
      }));
  }

  upsertSync(path: string, mtime: number): void {
    this.assertSourceNotErased(path);
    this.db.prepare(`
      INSERT INTO records_sync
        (tenant_id, owner_principal_id, path, mtime, indexed_at)
      VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, indexed_at = excluded.indexed_at
    `).run(path, mtime, Date.now());
  }

  getSyncMtime(path: string): number | undefined {
    const row = this.db.prepare(`
      SELECT mtime FROM records_sync
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
        AND path = ?
    `).get(path) as { mtime: number } | undefined;
    return row?.mtime;
  }

  getAllSyncPaths(): Set<string> {
    return new Set(
      this.db.prepare(`
        SELECT path FROM records_sync
        WHERE tenant_id = current_tenant_id()
          AND owner_principal_id = current_principal_id()
      `).all().map((r: any) => r.path)
    );
  }

  clearSync(): void {
    this.db.prepare(`
      DELETE FROM records_sync
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
    `).run();
  }

  upsertCommunity(community: { id: number; label: string; summary: string; nodeIds: string[] }): void {
    for (const nodeId of community.nodeIds) this.assertSourceNotErased(nodeId);
    this.db.prepare(`
      INSERT INTO records_communities
        (tenant_id, owner_principal_id, id, label, summary, node_ids)
      VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        summary = excluded.summary,
        node_ids = excluded.node_ids
    `).run(community.id, community.label, community.summary, JSON.stringify(community.nodeIds));
  }

  clearCommunities(): void {
    this.db.prepare(`
      DELETE FROM records_communities
      WHERE tenant_id = current_tenant_id()
        AND owner_principal_id = current_principal_id()
    `).run();
  }

  getAllCommunities(): Array<{ id: number; label: string; summary: string; nodeIds: string[] }> {
    return this.db.prepare('SELECT * FROM communities').all().map((r: any) => ({
      id: r.id,
      label: r.label,
      summary: r.summary,
      nodeIds: JSON.parse(r.node_ids),
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Derive the FTS5-indexed content string from a node's content and frontmatter.
 * Aliases (when present and a non-empty string array) are appended after a
 * newline so they are discoverable via full-text search.
 *
 * CRITICAL INVARIANT (FTS5 external-content): this function MUST be called
 * identically for both the 'delete' and the new-insert FTS5 statements, with
 * the EXISTING row's data for deletes and the INCOMING node's data for inserts.
 * Any mismatch silently corrupts the FTS index.
 *
 * DEPLOY CRITICAL: run `kg index --force` IMMEDIATELY after deploying this
 * code. Any incremental index run between deploy and the force-rebuild will
 * mismatch the FTS5 delete text for previously-indexed aliased nodes and
 * double-index them (phantom search hits on old alias terms).
 */
export function ftsText(
  content: string | null | undefined,
  frontmatter: Record<string, unknown>,
): string {
  const base = content ?? '';
  const aliases = frontmatter.aliases;
  if (
    Array.isArray(aliases) &&
    aliases.length > 0 &&
    aliases.every(a => typeof a === 'string')
  ) {
    return base + '\n' + (aliases as string[]).join(' ');
  }
  return base;
}

function parseFrontmatter(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const fm = JSON.parse(raw);
    return fm && typeof fm === 'object' ? (fm as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstParagraph(content: string, maxLen: number): string {
  const para = content.split(/\n\n+/).find(p => p.trim().length > 0 && !p.startsWith('#'));
  if (!para) return '';
  const trimmed = para.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '...' : trimmed;
}
