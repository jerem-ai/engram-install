import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  DesiredRegistry,
  EndpointDefinition,
  HostDefinition,
  ObservationInput,
  ProjectDefinition,
  ServiceDefinition,
  StoredObservation,
} from './types.js';

const SCHEMA_VERSION = 1;

export interface RegistryStoreOptions {
  readonly?: boolean;
}

export class InfraRegistryStore {
  readonly db: Database.Database;
  readonly readonly: boolean;

  constructor(path: string, options: RegistryStoreOptions = {}) {
    this.readonly = options.readonly ?? false;
    if (!this.readonly && path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.db = new Database(path, this.readonly ? { readonly: true, fileMustExist: true } : undefined);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (!this.readonly) {
      this.db.pragma('journal_mode = WAL');
      this.createSchema();
      secureDatabaseFiles(path);
    }
    this.verifySchema();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  integrityCheck(): string[] {
    return (this.db.pragma('integrity_check') as { integrity_check: string }[]).map(row => row.integrity_check);
  }

  importDesired(registry: DesiredRegistry, revision: string, sourcePath: string): void {
    this.assertWritable();
    const importAll = this.db.transaction(() => {
      this.db.prepare('DELETE FROM desired_endpoints').run();
      this.db.prepare('DELETE FROM desired_services').run();
      this.db.prepare('DELETE FROM desired_projects').run();
      this.db.prepare('DELETE FROM desired_hosts').run();

      const hostStmt = this.db.prepare('INSERT INTO desired_hosts (id, name, data_json) VALUES (?, ?, ?)');
      const projectStmt = this.db.prepare('INSERT INTO desired_projects (id, name, host_id, data_json) VALUES (?, ?, ?, ?)');
      const serviceStmt = this.db.prepare('INSERT INTO desired_services (id, name, host_id, data_json) VALUES (?, ?, ?, ?)');
      const endpointStmt = this.db.prepare('INSERT INTO desired_endpoints (id, name, data_json) VALUES (?, ?, ?)');
      for (const item of registry.hosts) hostStmt.run(item.id, item.name, stableJson(item));
      for (const item of registry.projects) projectStmt.run(item.id, item.name, item.host_id, stableJson(item));
      for (const item of registry.services) serviceStmt.run(item.id, item.name, item.host_id, stableJson(item));
      for (const item of registry.endpoints) endpointStmt.run(item.id, item.name, stableJson(item));

      this.setMetadata('config_revision', revision);
      this.setMetadata('config_source', sourcePath);
      this.setMetadata('config_imported_at', new Date().toISOString());
    });
    importAll();
  }

  beginRun(collectorId: string, collectorType: string): string {
    this.assertWritable();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO collector_runs (id, collector_id, collector_type, started_at, status)
      VALUES (?, ?, ?, ?, 'running')
    `).run(id, collectorId, collectorType, new Date().toISOString());
    return id;
  }

  finishRun(runId: string, status: 'ok' | 'partial' | 'error', count: number, error?: string): void {
    this.assertWritable();
    this.db.prepare(`
      UPDATE collector_runs
      SET finished_at = ?, status = ?, observation_count = ?, error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), status, count, error ?? null, runId);
  }

  recordObservation(runId: string, collectorId: string, input: ObservationInput): void {
    this.assertWritable();
    const observedAt = input.observedAt ?? new Date().toISOString();
    const ttlSeconds = input.ttlSeconds ?? 1800;
    const expiresAt = new Date(Date.parse(observedAt) + ttlSeconds * 1000).toISOString();
    const dataJson = stableJson(input.data ?? {});
    const evidence = createHash('sha256')
      .update([input.entityType, input.entityId, input.facet, input.state, dataJson, input.error ?? ''].join('\0'))
      .digest('hex');
    this.db.prepare(`
      INSERT INTO observations (
        run_id, collector_id, entity_type, entity_id, facet, state, host_id,
        observed_at, expires_at, data_json, evidence_sha256, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      collectorId,
      input.entityType,
      input.entityId,
      input.facet,
      input.state,
      input.hostId ?? null,
      observedAt,
      expiresAt,
      dataJson,
      evidence,
      input.error ?? null,
    );
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM registry_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  getHosts(): HostDefinition[] {
    return this.readDesiredTable<HostDefinition>('desired_hosts');
  }

  getProjects(): ProjectDefinition[] {
    return this.readDesiredTable<ProjectDefinition>('desired_projects');
  }

  getServices(): ServiceDefinition[] {
    return this.readDesiredTable<ServiceDefinition>('desired_services');
  }

  getEndpoints(): EndpointDefinition[] {
    return this.readDesiredTable<EndpointDefinition>('desired_endpoints');
  }

  latestObservations(): StoredObservation[] {
    const rows = this.db.prepare(`
      SELECT id, run_id, collector_id, entity_type, entity_id, facet, state, host_id,
             observed_at, expires_at, data_json, evidence_sha256, error
      FROM (
        SELECT observations.*,
          ROW_NUMBER() OVER (
            PARTITION BY entity_type, entity_id, facet, collector_id
            ORDER BY observed_at DESC, id DESC
          ) AS rank
        FROM observations
      )
      WHERE rank = 1
      ORDER BY entity_type, entity_id, facet, collector_id
    `).all() as Array<Omit<StoredObservation, 'data'> & { data_json: string }>;
    return rows.map(row => ({
      id: row.id,
      run_id: row.run_id,
      collector_id: row.collector_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      facet: row.facet,
      state: row.state,
      host_id: row.host_id,
      observed_at: row.observed_at,
      expires_at: row.expires_at,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      evidence_sha256: row.evidence_sha256,
      error: row.error,
    }));
  }

  collectorRuns(limit = 50): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT id, collector_id, collector_type, started_at, finished_at, status,
             observation_count, error
      FROM collector_runs ORDER BY started_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
  }

  pruneObservations(retainDays = 30): number {
    this.assertWritable();
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM observations
      WHERE observed_at < ? AND id NOT IN (
        SELECT MAX(id) FROM observations GROUP BY entity_type, entity_id, facet, collector_id
      )
    `).run(cutoff);
    return result.changes;
  }

  private readDesiredTable<T>(table: string): T[] {
    const allowed = new Set(['desired_hosts', 'desired_projects', 'desired_services', 'desired_endpoints']);
    if (!allowed.has(table)) throw new Error(`Invalid desired table: ${table}`);
    const rows = this.db.prepare(`SELECT data_json FROM ${table} ORDER BY id`).all() as { data_json: string }[];
    return rows.map(row => JSON.parse(row.data_json) as T);
  }

  private setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO registry_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private assertWritable(): void {
    if (this.readonly) throw new Error('Infrastructure registry is open read-only');
  }

  private verifySchema(): void {
    const row = this.db.prepare('SELECT value FROM registry_metadata WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (!row) throw new Error('Infrastructure registry schema metadata is missing');
    if (Number(row.value) !== SCHEMA_VERSION) {
      throw new Error(`Infrastructure registry schema mismatch: database=${row.value}, runtime=${SCHEMA_VERSION}`);
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registry_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO registry_metadata (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');

      CREATE TABLE IF NOT EXISTS desired_hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desired_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES desired_hosts(id),
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desired_services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES desired_hosts(id),
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desired_endpoints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collector_runs (
        id TEXT PRIMARY KEY,
        collector_id TEXT NOT NULL,
        collector_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'error')),
        observation_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_collector_runs_collector_started
        ON collector_runs(collector_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES collector_runs(id),
        collector_id TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('host', 'project', 'service', 'endpoint')),
        entity_id TEXT NOT NULL,
        facet TEXT NOT NULL CHECK (facet IN ('reachability', 'inventory', 'runtime', 'route', 'probe', 'listener')),
        state TEXT NOT NULL CHECK (state IN ('healthy', 'running', 'loaded', 'stopped', 'failed', 'missing', 'unknown')),
        host_id TEXT,
        observed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        evidence_sha256 TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_observations_entity_latest
        ON observations(entity_type, entity_id, facet, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_run ON observations(run_id);
    `);
  }
}

function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortObject(item)]));
  }
  return value;
}
