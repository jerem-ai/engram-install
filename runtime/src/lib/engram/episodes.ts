import type Database from 'better-sqlite3';
import { normalizeTemporalInstant } from './temporal.js';

/**
 * Engram Episodes: first-class provenance records for vault sources.
 *
 * An episode is a deterministic reference to a vault-backed source node
 * (session note, Memory note, Decision, Conversation, etc.) that establishes
 * the provenance context for assertions derived from that source.
 *
 * Episode ID is a deterministic hash of the source node ID, so reindexing
 * never produces duplicates. Non-destructive: kg_timeline_search unchanged.
 */

export interface EngramEpisode {
  tenant_id: string;
  owner_principal_id: string;
  id: string;               // deterministic hash of source_node_id
  source_node_id: string;   // vault file path
  episode_type: string;     // session | memory | decision | conversation | manual
  title: string;
  observed_at: string;      // ISO timestamp from source frontmatter or file mtime
  created_at: string;       // ISO timestamp of when this episode was indexed
  source_hash: string;      // SHA256 of source content at index time
  provenance: string;       // JSON blob: runtime, persona, model, session_id
}

export const EPISODE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS records_engram_episodes (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL,
    episode_type TEXT NOT NULL DEFAULT 'manual',
    title TEXT NOT NULL DEFAULT '',
    observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    source_hash TEXT NOT NULL DEFAULT '',
    provenance TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_engram_episodes_source
    ON records_engram_episodes(tenant_id, source_node_id);
  CREATE INDEX IF NOT EXISTS idx_engram_episodes_type
    ON records_engram_episodes(tenant_id, episode_type);
  CREATE INDEX IF NOT EXISTS idx_engram_episodes_observed
    ON records_engram_episodes(tenant_id, observed_at);

  CREATE VIEW IF NOT EXISTS engram_episodes AS
    SELECT tenant_id, owner_principal_id, id, source_node_id, episode_type,
           title, observed_at, created_at, source_hash, provenance
    FROM records_engram_episodes
    WHERE tenant_id = current_tenant_id();
`;

export function episodeId(sourceNodeId: string): string {
  // Deterministic hash — same source always produces same episode ID.
  // Simple FNV-1a style hash for reproducibility across reindexes.
  let hash = 2166136261;
  for (let i = 0; i < sourceNodeId.length; i++) {
    hash ^= sourceNodeId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ep_${Math.abs(hash).toString(36)}`;
}

export function ensureEpisodesTable(db: Database.Database): void {
  db.exec(EPISODE_SCHEMA);
}

export function insertEpisode(
  db: Database.Database,
  episode: Omit<EngramEpisode, 'tenant_id' | 'owner_principal_id' | 'id' | 'created_at'>
): EngramEpisode {
  const id = episodeId(episode.source_node_id);
  const now = new Date().toISOString();
  const observedAt = normalizeTemporalInstant(episode.observed_at);
  db.prepare(`
    INSERT INTO records_engram_episodes
      (tenant_id, owner_principal_id, id, source_node_id, episode_type, title,
       observed_at, created_at, source_hash, provenance)
    VALUES (current_tenant_id(), current_principal_id(), ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      source_hash = excluded.source_hash,
      provenance = excluded.provenance
  `).run(
    id,
    episode.source_node_id,
    episode.episode_type,
    episode.title,
    observedAt,
    now,
    episode.source_hash ?? '',
    episode.provenance ?? '{}',
  );
  return {
    tenant_id: currentContextValue(db, 'current_tenant_id'),
    owner_principal_id: currentContextValue(db, 'current_principal_id'),
    id,
    ...episode,
    observed_at: observedAt,
    created_at: now,
  };
}

function currentContextValue(db: Database.Database, fn: string): string {
  return (db.prepare(`SELECT ${fn}() AS value`).get() as { value: string }).value;
}

export function getEpisode(
  db: Database.Database,
  episodeId: string
): EngramEpisode | undefined {
  return db.prepare('SELECT * FROM engram_episodes WHERE id = ?').get(episodeId) as
    EngramEpisode | undefined;
}

export function getEpisodeBySourceNode(
  db: Database.Database,
  sourceNodeId: string
): EngramEpisode | undefined {
  return db.prepare(
    'SELECT * FROM engram_episodes WHERE source_node_id = ?'
  ).get(sourceNodeId) as EngramEpisode | undefined;
}

export function queryEpisodes(
  db: Database.Database,
  opts: {
    episodeType?: string;
    sourceNodeId?: string;
    limit?: number;
    offset?: number;
  } = {}
): EngramEpisode[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.episodeType) {
    conditions.push('episode_type = ?');
    params.push(opts.episodeType);
  }
  if (opts.sourceNodeId) {
    conditions.push('source_node_id = ?');
    params.push(opts.sourceNodeId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return db.prepare(
    `SELECT * FROM engram_episodes ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as EngramEpisode[];
}

export function countEpisodes(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM engram_episodes').get() as { c: number };
  return row.c;
}
