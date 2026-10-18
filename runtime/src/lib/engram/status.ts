import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';

export interface EngramStatusOptions {
  access?: 'internal' | 'read_only' | 'candidate_submit';
  instanceId?: string;
}

export interface EngramConnectionReceipt {
  server: 'engram';
  instance_id: string;
  corpus_revision: string;
  access: 'internal' | 'read_only' | 'candidate_submit';
  generated_at: string;
}

export interface EngramStatus {
  status: 'ok' | 'maintenance_recommended';
  server: 'engram';
  version: '1';
  instance_id: string;
  corpus_revision: string;
  access: 'internal' | 'read_only' | 'candidate_submit';
  generated_at: string;
  index_updated_at: string | null;
  corpus: {
    nodes: number;
    assertions: Record<string, number>;
    open_contradictions: number;
  };
  database: {
    logical_bytes: number;
    file_bytes: number;
    reclaimable_bytes: number;
    free_page_ratio: number;
    maintenance_recommended: boolean;
  };
}

export function engramStatus(
  db: Database.Database,
  options: EngramStatusOptions = {},
): EngramStatus {
  const generatedAt = new Date().toISOString();
  const instanceId = options.instanceId ?? process.env.ENGRAM_INSTANCE_ID ?? hostname();
  const access = options.access ?? 'internal';
  const pageSize = pragmaNumber(db, 'page_size');
  const pageCount = pragmaNumber(db, 'page_count');
  const freePages = pragmaNumber(db, 'freelist_count');
  const fileBytes = pageSize * pageCount;
  const reclaimableBytes = pageSize * freePages;
  const logicalBytes = Math.max(0, fileBytes - reclaimableBytes);
  const freePageRatio = pageCount === 0 ? 0 : freePages / pageCount;
  const maintenanceRecommended = reclaimableBytes >= 128 * 1024 * 1024 && freePageRatio >= 0.3;

  const nodes = scalar(db, 'SELECT COUNT(*) FROM nodes');
  const assertionRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM engram_assertions
    GROUP BY status
    ORDER BY status
  `).all() as Array<{ status: string; count: number }>;
  const assertions = Object.fromEntries(assertionRows.map(row => [row.status, row.count]));
  const openContradictions = scalar(
    db,
    "SELECT COUNT(*) FROM engram_contradiction_cases WHERE status = 'open'",
  );
  const indexUpdatedRaw = nullableScalar(db, 'SELECT MAX(indexed_at) FROM sync');
  const assertionUpdatedAt = nullableText(
    db,
    'SELECT MAX(updated_at) FROM engram_assertions',
  );
  const indexUpdatedAt = toIsoTimestamp(indexUpdatedRaw);
  const assertionTotal = Object.values(assertions).reduce((sum, count) => sum + count, 0);
  const revisionInput = JSON.stringify({
    nodes,
    assertions,
    assertionTotal,
    assertionUpdatedAt,
    indexUpdatedRaw,
    openContradictions,
  });
  const corpusRevision = createHash('sha256').update(revisionInput).digest('hex').slice(0, 16);

  return {
    status: maintenanceRecommended ? 'maintenance_recommended' : 'ok',
    server: 'engram',
    version: '1',
    instance_id: instanceId,
    corpus_revision: corpusRevision,
    access,
    generated_at: generatedAt,
    index_updated_at: indexUpdatedAt,
    corpus: {
      nodes,
      assertions,
      open_contradictions: openContradictions,
    },
    database: {
      logical_bytes: logicalBytes,
      file_bytes: fileBytes,
      reclaimable_bytes: reclaimableBytes,
      free_page_ratio: Number(freePageRatio.toFixed(4)),
      maintenance_recommended: maintenanceRecommended,
    },
  };
}

export function connectionReceipt(status: EngramStatus): EngramConnectionReceipt {
  return {
    server: status.server,
    instance_id: status.instance_id,
    corpus_revision: status.corpus_revision,
    access: status.access,
    generated_at: status.generated_at,
  };
}

function pragmaNumber(db: Database.Database, name: string): number {
  const row = db.pragma(name, { simple: true });
  return Number(row ?? 0);
}

function scalar(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number>;
  return Number(Object.values(row)[0] ?? 0);
}

function nullableScalar(db: Database.Database, sql: string): number | null {
  const row = db.prepare(sql).get() as Record<string, number | null>;
  const value = Object.values(row)[0];
  return value === null || value === undefined ? null : Number(value);
}

function nullableText(db: Database.Database, sql: string): string | null {
  const row = db.prepare(sql).get() as Record<string, string | null>;
  return Object.values(row)[0] ?? null;
}

function toIsoTimestamp(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(millis).toISOString();
}
