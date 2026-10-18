import Database from 'better-sqlite3';
import { statSync } from 'node:fs';

const DEFAULT_RESULTS = 6;
const MAX_RESULTS = 12;
const MAX_EXCERPT_CHARS = 700;

const COMMON_STOP_WORDS = [
  'a', 'an', 'and', 'are', 'about', 'can', 'do', 'does', 'for', 'how', 'i',
  'in', 'is', 'it', 'my', 'of', 'on', 'or', 'the', 'this', 'to', 'what', 'with',
] as const;

export const FEDERATED_CORPUS_REQUIRED_TABLES = [
  'schema_meta',
  'documents',
  'segments',
  'segment_search',
  'entities',
  'applicability',
  'claims',
  'claim_evidence',
] as const;

export type FederatedEvidenceStatus =
  | 'evidence_found'
  | 'no_reliable_evidence'
  | 'source_unavailable';

export interface FederatedCorpusAdapter<SourceKind extends string = string> {
  corpusId: string;
  domain: string;
  databaseLabel: string;
  supportedSchemaVersions: readonly number[];
  stopWords?: readonly string[];
  emptyQueryNote?: string;
  noMatchNote?: string;
  unavailableNote?: string;
  synthesisNote: string;
  classifySource(row: FederatedSourceRow): SourceKind;
  citationUrl(row: FederatedSourceRow, timestampSeconds: number | null): string;
}

export interface FederatedCorpusRegistration<SourceKind extends string = string> {
  adapter: FederatedCorpusAdapter<SourceKind>;
  tool: {
    name: string;
    title: string;
    description: string;
    queryExample: string;
  };
  database: {
    envVar: string;
    defaultFilename: string;
  };
}

export interface FederatedCorpusSource {
  kind: 'federated_evidence_database';
  corpus_id?: string;
  path: string;
  schema_version?: number;
  updated_at?: string;
  documents?: number;
  segments?: number;
}

export interface FederatedClaim {
  subject: string;
  predicate: string;
  object: string;
  claim_type: string;
  status: string;
  confidence: number;
  support_type: string;
  applicability: {
    model: string;
    year_start: number | null;
    year_end: number | null;
  } | null;
}

export interface FederatedEvidence<SourceKind extends string = string> {
  segment_id: number;
  source_kind: SourceKind;
  source_id: string;
  title: string;
  published_at: string | null;
  timestamp_seconds: number | null;
  timestamp_url: string;
  excerpt: string;
  source_scope: 'included';
  rank: number;
  claims: FederatedClaim[];
}

export interface FederatedRecallResult<SourceKind extends string = string> {
  status: FederatedEvidenceStatus;
  authority: 'informational_only';
  domain: string;
  query: string;
  source: FederatedCorpusSource;
  answer_contract: {
    action: 'synthesize_with_citations' | 'do_not_answer_from_this_source';
    note: string;
  };
  evidence: Array<FederatedEvidence<SourceKind>>;
  error?: string;
}

export interface FederatedSourceRow {
  segment_id: number;
  document_id: number;
  ordinal: number;
  start_ms: number | null;
  locator: string;
  title: string;
  url: string;
  external_id: string;
  published_at: string | null;
  rank: number;
}

type ClaimRow = {
  subject: string;
  predicate: string;
  object_value: string | null;
  object_entity: string | null;
  claim_type: string;
  status: string;
  confidence: number;
  support_type: string;
  model: string | null;
  year_start: number | null;
  year_end: number | null;
};

export function recallFederatedEvidence<SourceKind extends string>(
  adapter: FederatedCorpusAdapter<SourceKind>,
  databasePath: string,
  query: string,
  requestedLimit = DEFAULT_RESULTS,
): FederatedRecallResult<SourceKind> {
  const source: FederatedCorpusSource = {
    kind: 'federated_evidence_database',
    corpus_id: adapter.corpusId,
    path: databasePath,
  };
  const cleanQuery = query.trim();
  const terms = searchTerms(cleanQuery, adapter.stopWords ?? []);
  if (terms.length === 0) {
    return noEvidence(
      adapter,
      source,
      cleanQuery,
      adapter.emptyQueryNote ?? `The query did not contain a searchable ${adapter.domain} topic.`,
    );
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const schemaVersion = validateSchema(db, adapter);
    const metadata = databaseMetadata(db, adapter, databasePath, schemaVersion);
    const limit = normalizeLimit(requestedLimit);
    const rows = searchRows(db, terms, limit);
    const evidence = rows.map(row => evidenceForRow(db!, adapter, row));

    if (evidence.length === 0) {
      return noEvidence(
        adapter,
        metadata,
        cleanQuery,
        adapter.noMatchNote ?? `No included ${adapter.domain} evidence matched.`,
      );
    }
    return {
      status: 'evidence_found',
      authority: 'informational_only',
      domain: adapter.domain,
      query: cleanQuery,
      source: metadata,
      answer_contract: {
        action: 'synthesize_with_citations',
        note: adapter.synthesisNote,
      },
      evidence,
    };
  } catch (error) {
    return {
      status: 'source_unavailable',
      authority: 'informational_only',
      domain: adapter.domain,
      query: cleanQuery,
      source,
      answer_contract: {
        action: 'do_not_answer_from_this_source',
        note: adapter.unavailableNote
          ?? `The ${adapter.databaseLabel} evidence database could not be opened or did not match the required schema.`,
      },
      evidence: [],
      error: safeError(adapter.databaseLabel, error),
    };
  } finally {
    db?.close();
  }
}

function searchTerms(query: string, corpusStopWords: readonly string[]): string[] {
  const stopWords = new Set([...COMMON_STOP_WORDS, ...corpusStopWords].map(word => word.toLocaleLowerCase()));
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tokens.filter(token => !stopWords.has(token)))].slice(0, 12);
}

function normalizeLimit(requestedLimit: number): number {
  if (!Number.isFinite(requestedLimit)) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(requestedLimit)));
}

function validateSchema(
  db: Database.Database,
  adapter: FederatedCorpusAdapter,
): number {
  const required = [...FEDERATED_CORPUS_REQUIRED_TABLES];
  const found = new Set((db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE name IN (${required.map(() => '?').join(', ')})
  `).all(...required) as Array<{ name: string }>).map(row => row.name));
  const missing = required.filter(name => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`${adapter.databaseLabel} schema missing: ${missing.join(', ')}`);
  }

  const row = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
    { value: string } | undefined;
  const version = Number(row?.value);
  if (!adapter.supportedSchemaVersions.includes(version)) {
    throw new Error(
      `Unsupported ${adapter.databaseLabel} schema version: ${row?.value ?? 'missing'}`,
    );
  }
  return version;
}

function databaseMetadata(
  db: Database.Database,
  adapter: FederatedCorpusAdapter,
  path: string,
  schemaVersion: number,
): FederatedCorpusSource {
  const row = db.prepare(`
    SELECT
      (SELECT MAX(updated_at) FROM documents) AS updated_at,
      (SELECT COUNT(*) FROM documents WHERE scope_status='included') AS documents,
      (SELECT COUNT(*) FROM segments s JOIN documents d ON d.id=s.document_id
       WHERE d.scope_status='included') AS segments
  `).get() as { updated_at: string | null; documents: number; segments: number };
  const modified = statSync(path).mtime.toISOString();
  return {
    kind: 'federated_evidence_database',
    corpus_id: adapter.corpusId,
    path,
    schema_version: schemaVersion,
    updated_at: row.updated_at ?? modified,
    documents: row.documents,
    segments: row.segments,
  };
}

function searchRows(
  db: Database.Database,
  terms: string[],
  limit: number,
): FederatedSourceRow[] {
  const run = (joiner: ' AND ' | ' OR ') => db.prepare(`
    SELECT s.id AS segment_id, s.document_id, s.ordinal, s.start_ms, s.locator,
           d.title, d.url, d.external_id, d.published_at,
           bm25(segment_search) AS rank
    FROM segment_search
    JOIN segments s ON s.id=segment_search.rowid
    JOIN documents d ON d.id=s.document_id
    WHERE segment_search MATCH ? AND d.scope_status='included'
    ORDER BY rank, d.id, s.ordinal
    LIMIT ?
  `).all(terms.map(term => `"${term}"`).join(joiner), limit) as FederatedSourceRow[];

  const exact = run(' AND ');
  return exact.length > 0 || terms.length === 1 ? exact : run(' OR ');
}

function evidenceForRow<SourceKind extends string>(
  db: Database.Database,
  adapter: FederatedCorpusAdapter<SourceKind>,
  row: FederatedSourceRow,
): FederatedEvidence<SourceKind> {
  const hit = db.prepare('SELECT text FROM segments WHERE id=?').get(row.segment_id) as
    { text: string } | undefined;
  const excerpt = hit?.text.trim().slice(0, MAX_EXCERPT_CHARS) ?? '';
  const claims = db.prepare(`
    SELECT subject.canonical_name AS subject, c.predicate, c.object_value,
           object.canonical_name AS object_entity, c.claim_type, c.status,
           c.confidence, ce.support_type, a.model, a.year_start, a.year_end
    FROM claim_evidence ce
    JOIN claims c ON c.id=ce.claim_id
    JOIN entities subject ON subject.id=c.subject_entity_id
    LEFT JOIN entities object ON object.id=c.object_entity_id
    LEFT JOIN applicability a ON a.id=c.applicability_id
    WHERE ce.segment_id=?
    ORDER BY c.confidence DESC, c.id
  `).all(row.segment_id) as ClaimRow[];
  const timestampSeconds = row.start_ms === null ? null : Math.floor(row.start_ms / 1000);
  return {
    segment_id: row.segment_id,
    source_kind: adapter.classifySource(row),
    source_id: row.external_id,
    title: row.title,
    published_at: row.published_at,
    timestamp_seconds: timestampSeconds,
    timestamp_url: adapter.citationUrl(row, timestampSeconds),
    excerpt,
    source_scope: 'included',
    rank: Number(row.rank.toFixed(6)),
    claims: claims.map(claim => ({
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object_entity ?? claim.object_value ?? '',
      claim_type: claim.claim_type,
      status: claim.status,
      confidence: claim.confidence,
      support_type: claim.support_type,
      applicability: claim.model === null ? null : {
        model: claim.model,
        year_start: claim.year_start,
        year_end: claim.year_end,
      },
    })),
  };
}

function noEvidence<SourceKind extends string>(
  adapter: FederatedCorpusAdapter<SourceKind>,
  source: FederatedCorpusSource,
  query: string,
  note: string,
): FederatedRecallResult<SourceKind> {
  return {
    status: 'no_reliable_evidence',
    authority: 'informational_only',
    domain: adapter.domain,
    query,
    source,
    answer_contract: { action: 'do_not_answer_from_this_source', note },
    evidence: [],
  };
}

function safeError(databaseLabel: string, error: unknown): string {
  if (!(error instanceof Error)) return `Unknown ${databaseLabel} database error`;
  if (error.message.includes('does not exist') || error.message.includes('unable to open')) {
    return `${databaseLabel} evidence database is not installed`;
  }
  return error.message.slice(0, 240);
}
