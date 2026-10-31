import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  linkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { CorpusReadScope } from './corpus-read-consistency.js';
import { FEDERATED_CORPUS_REQUIRED_TABLES } from './federated-corpus.js';
import {
  activeVersionFromText,
  type SemanticHybridCandidate,
} from './corpus-hybrid.js';

export interface CorpusEmbeddingProvider {
  model: string;
  revision: string;
  dimension: number;
  embed(text: string): Promise<Float32Array>;
}

export interface CorpusIndexSelection {
  order: 'ascending' | 'descending';
  maxSegments: number;
}

export interface BuildCorpusSemanticIndexInput {
  collectionId: string;
  sourceDatabasePath: string;
  indexPath: string;
  selection: CorpusIndexSelection;
  provider: CorpusEmbeddingProvider;
}

export interface CorpusSemanticIndexReceipt {
  schema: 'corpus-semantic-index-receipt.v1';
  generatedAt: string;
  collectionId: string;
  sourceDatabasePath: string;
  sourceDatabaseSha256: string;
  sourceDigestFormat: 'file-sha256' | 'sqlite-base-wal.v1';
  sourceDatabaseSize: number;
  sourceDatabaseChangedDuringBuild: boolean;
  indexPath: string;
  indexSha256: string;
  indexSize: number;
  indexedSegments: number;
  selection: CorpusIndexSelection;
  model: string;
  modelRevision: string;
  dimension: number;
}

export interface QueryCorpusSemanticIndexOptions {
  expectedCollectionId: string;
  expectedSourceDatabaseSha256: string;
  limit: number;
  expectedModel?: string;
  expectedModelRevision?: string;
}

interface SourceSegmentRow {
  segment_id: number;
  document_id: number;
  ordinal: number;
  start_ms: number | null;
  locator: string;
  text: string;
  external_id: string;
  title: string;
  url: string;
  updated_at: string;
}

interface EmbeddedRow extends SourceSegmentRow {
  activeVersion: boolean | null;
  citation: string;
  embedding: Float32Array;
}

export async function buildCorpusSemanticIndex(
  input: BuildCorpusSemanticIndexInput,
): Promise<CorpusSemanticIndexReceipt> {
  validateBuildInput(input);
  if (existsSync(input.indexPath)) throw new Error(`Semantic index already exists: ${input.indexPath}`);
  const scope = new CorpusReadScope();
  try {
    const source = scope.database(input.sourceDatabasePath);
    const before = { size: source.size };
    const sourceDatabaseSha256 = await source.digest();
    const rows = readSourceSegments(source.db, input.selection);
    const profile = JSON.stringify([input.provider.model, input.provider.revision, input.provider.dimension]);
    const check = () => {
      scope.assertCurrent();
      if (profile !== JSON.stringify([input.provider.model, input.provider.revision, input.provider.dimension])) throw new Error('Embedding profile changed during build');
    };
    const embedded: EmbeddedRow[] = [];
    for (const row of rows) {
      check();
      const embedding = await input.provider.embed(`${row.title}\n${row.text}`.slice(0, 8000));
      check();
      validateEmbedding(embedding, input.provider.dimension);
      embedded.push({
        ...row,
        activeVersion: activeVersionFromText(row.text),
        citation: citationFor(row),
        embedding,
      });
    }

    mkdirSync(dirname(input.indexPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    let indexSha256: string;
    try {
      check();
      writeIndex(temporaryPath, input, sourceDatabaseSha256, source.digestFormat, before.size, embedded);
      chmodSync(temporaryPath, 0o600);
      indexSha256 = await sha256File(temporaryPath);
      check();
      // A concurrent publisher keeps its complete file. Never replace it.
      linkSync(temporaryPath, input.indexPath);
      rmSync(temporaryPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }

    const indexStat = statSync(input.indexPath);
    return {
      schema: 'corpus-semantic-index-receipt.v1',
      generatedAt: new Date().toISOString(),
      collectionId: input.collectionId,
      sourceDatabasePath: input.sourceDatabasePath,
      sourceDatabaseSha256,
      sourceDigestFormat: source.digestFormat,
      sourceDatabaseSize: before.size,
      sourceDatabaseChangedDuringBuild: false,
      indexPath: input.indexPath,
      indexSha256,
      indexSize: indexStat.size,
      indexedSegments: embedded.length,
      selection: input.selection,
      model: input.provider.model,
      modelRevision: input.provider.revision,
      dimension: input.provider.dimension,
    };
  } finally { scope.close(); }
}

export function queryCorpusSemanticIndex(
  indexPath: string,
  queryEmbedding: Float32Array,
  options: QueryCorpusSemanticIndexOptions,
): SemanticHybridCandidate[] {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error('Semantic query limit must be an integer from 1 to 1000');
  }
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  sqliteVec.load(db);
  try {
    const metadata = readMetadata(db);
    if (metadata.collection_id !== options.expectedCollectionId) {
      throw new Error('Semantic index collection mismatch');
    }
    if (metadata.source_database_sha256 !== options.expectedSourceDatabaseSha256) {
      throw new Error('Semantic index source database digest mismatch');
    }
    if ((options.expectedModel !== undefined && metadata.model !== options.expectedModel)
      || (options.expectedModelRevision !== undefined && metadata.model_revision !== options.expectedModelRevision)) {
      throw new Error('Semantic index embedding profile mismatch');
    }
    const dimension = Number(metadata.dimension);
    validateEmbedding(queryEmbedding, dimension);
    const rows = db.prepare(`
      SELECT s.segment_id, s.document_id, s.source_id, s.title, s.citation,
             s.excerpt, s.active_version, s.updated_at, v.distance
      FROM segment_vec v
      JOIN indexed_segments s ON s.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance, s.segment_id
    `).all(Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength), options.limit) as Array<{
      segment_id: number;
      document_id: number;
      source_id: string;
      title: string;
      citation: string;
      excerpt: string;
      active_version: number | null;
      updated_at: string | null;
      distance: number;
    }>;
    return rows.map(row => ({
      segmentId: row.segment_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      title: row.title,
      citation: row.citation,
      excerpt: row.excerpt,
      scope: 'included',
      activeVersion: row.active_version === null ? null : row.active_version === 1,
      updatedAt: row.updated_at,
      semanticSimilarity: roundSimilarity(1 - (row.distance * row.distance) / 2),
    }));
  } finally {
    db.close();
  }
}

function validateBuildInput(input: BuildCorpusSemanticIndexInput): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.collectionId)) {
    throw new Error('Invalid corpus collection ID');
  }
  if (!Number.isInteger(input.selection.maxSegments)
    || input.selection.maxSegments < 1
    || input.selection.maxSegments > 100_000) {
    throw new Error('Index maxSegments must be an integer from 1 to 100000');
  }
  if (!['ascending', 'descending'].includes(input.selection.order)) {
    throw new Error('Index selection order is unsupported');
  }
  if (!Number.isInteger(input.provider.dimension)
    || input.provider.dimension < 1
    || input.provider.dimension > 4096) {
    throw new Error('Embedding dimension is invalid');
  }
}

function readSourceSegments(db: Database.Database, selection: CorpusIndexSelection): SourceSegmentRow[] {
    validateSourceSchema(db);
    const direction = selection.order === 'ascending' ? 'ASC' : 'DESC';
    return db.prepare(`
      SELECT s.id segment_id, s.document_id, s.ordinal, s.start_ms, s.locator,
             s.text, d.external_id, d.title, d.url, d.updated_at
      FROM segments s
      JOIN documents d ON d.id = s.document_id
      WHERE d.scope_status = 'included'
      ORDER BY s.id ${direction}
      LIMIT ?
    `).all(selection.maxSegments) as SourceSegmentRow[];
}

function validateSourceSchema(db: Database.Database): void {
  const required = [...FEDERATED_CORPUS_REQUIRED_TABLES];
  const found = new Set((db.prepare(`
    SELECT name FROM sqlite_schema WHERE name IN (${required.map(() => '?').join(',')})
  `).all(...required) as Array<{ name: string }>).map(row => row.name));
  const missing = required.filter(table => !found.has(table));
  if (missing.length > 0) throw new Error(`Corpus schema missing: ${missing.join(', ')}`);
  const version = Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").pluck().get());
  if (![1, 2].includes(version)) throw new Error(`Unsupported corpus schema version: ${version}`);
}

function writeIndex(
  path: string,
  input: BuildCorpusSemanticIndexInput,
  sourceDatabaseSha256: string,
  sourceDigestFormat: string,
  sourceDatabaseSize: number,
  rows: EmbeddedRow[],
): void {
  const db = new Database(path);
  sqliteVec.load(db);
  try {
    db.pragma('journal_mode = DELETE');
    db.exec(`
      CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE indexed_segments (
        id INTEGER PRIMARY KEY,
        segment_id INTEGER NOT NULL UNIQUE,
        document_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        citation TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        active_version INTEGER,
        updated_at TEXT
      );
      CREATE VIRTUAL TABLE segment_vec USING vec0(embedding float[${input.provider.dimension}]);
    `);
    const metadata = {
      schema: 'corpus-semantic-index.v1',
      collection_id: input.collectionId,
      source_database_sha256: sourceDatabaseSha256,
      source_digest_format: sourceDigestFormat,
      source_database_size: String(sourceDatabaseSize),
      model: input.provider.model,
      model_revision: input.provider.revision,
      dimension: String(input.provider.dimension),
      selection: JSON.stringify(input.selection),
      generated_at: new Date().toISOString(),
    };
    const insertMetadata = db.prepare('INSERT INTO index_metadata(key, value) VALUES (?, ?)');
    const insertSegment = db.prepare(`
      INSERT INTO indexed_segments
        (id, segment_id, document_id, source_id, title, citation, excerpt, active_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVector = db.prepare('INSERT INTO segment_vec(rowid, embedding) VALUES (?, ?)');
    db.transaction(() => {
      for (const [key, value] of Object.entries(metadata)) insertMetadata.run(key, value);
      rows.forEach((row, index) => {
        const id = index + 1;
        insertSegment.run(
          id,
          row.segment_id,
          row.document_id,
          row.external_id,
          row.title,
          row.citation,
          row.text.slice(0, 700),
          row.activeVersion === null ? null : row.activeVersion ? 1 : 0,
          row.updated_at,
        );
        insertVector.run(BigInt(id), Buffer.from(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength));
      });
    })();
  } finally {
    db.close();
  }
}

function readMetadata(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM index_metadata').all() as Array<{ key: string; value: string }>;
  const metadata = Object.fromEntries(rows.map(row => [row.key, row.value]));
  if (metadata.schema !== 'corpus-semantic-index.v1') {
    throw new Error('Unsupported corpus semantic index schema');
  }
  return metadata;
}

function citationFor(row: SourceSegmentRow): string {
  if (row.start_ms !== null) {
    const seconds = Math.floor(row.start_ms / 1000);
    return `${row.url}${row.url.includes('?') ? '&' : '?'}t=${seconds}s`;
  }
  return /^post-\d+$/.test(row.locator)
    ? `${row.url.split('#')[0]}#${row.locator}`
    : row.url;
}

function validateEmbedding(value: Float32Array, dimension: number): void {
  if (!(value instanceof Float32Array)
    || value.length !== dimension
    || value.some(item => !Number.isFinite(item))) {
    throw new Error(`Embedding must contain ${dimension} finite float32 values`);
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function roundSimilarity(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * 1e12) / 1e12;
}
