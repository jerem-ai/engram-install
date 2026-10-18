import {
  recallFederatedEvidence,
  type FederatedCorpusRegistration,
  type FederatedEvidence,
  type FederatedRecallResult,
} from './federated-corpus.js';

const GX460_STOP_WORDS = ['gx', 'gx460', 'lexus', '460'] as const;

export const GX460_CORPUS: FederatedCorpusRegistration<'video' | 'forum_thread'> = {
  adapter: {
    corpusId: 'lexus-gx460-lore',
    domain: 'Lexus GX460 (2010-2023)',
    databaseLabel: 'GX460',
    supportedSchemaVersions: [1, 2],
    stopWords: GX460_STOP_WORDS,
    emptyQueryNote: 'The query did not contain a searchable GX460 topic.',
    noMatchNote: 'No included GX460 evidence matched.',
    unavailableNote: 'The GX460 evidence database could not be opened or did not match the required schema.',
    synthesisNote: 'Use only the returned short excerpts and timestamp links. Distinguish a source demonstration or opinion from a manufacturer specification.',
    classifySource: row => /^post-\d+$/.test(row.locator) ? 'forum_thread' : 'video',
    citationUrl: (row, timestampSeconds) => {
      if (timestampSeconds !== null) {
        return `${row.url}${row.url.includes('?') ? '&' : '?'}t=${timestampSeconds}s`;
      }
      return /^post-\d+$/.test(row.locator)
        ? `${row.url.split('#', 1)[0]}#${row.locator}`
        : row.url;
    },
  },
  tool: {
    name: 'engram_gx460_recall',
    title: 'Recall Lexus GX460 Evidence',
    description: 'Search the GX460 lore evidence database for source-backed, timestamped material. Use this before answering questions about the 2010-2023 Lexus GX460, its maintenance, repairs, systems, parts, or modifications. The results are informational evidence, not promoted personal-memory assertions.',
    queryExample: 'blower motor replacement',
  },
  database: {
    envVar: 'GX460_LORE_DB',
    defaultFilename: 'gx460-lore.sqlite3',
  },
};

export type Gx460EvidenceStatus = Gx460RecallResult['status'];

export interface Gx460Evidence extends FederatedEvidence<'video' | 'forum_thread'> {
  /** @deprecated Use source_id. Retained for existing clients. */
  video_id: string;
  claims: Array<FederatedEvidence['claims'][number] & {
    applicability: {
      model: 'GX460';
      year_start: number | null;
      year_end: number | null;
    } | null;
  }>;
}

export interface Gx460RecallResult
  extends Omit<FederatedRecallResult<'video' | 'forum_thread'>, 'domain' | 'evidence'> {
  domain: 'Lexus GX460 (2010-2023)';
  evidence: Gx460Evidence[];
}

export function recallGx460Evidence(
  databasePath: string,
  query: string,
  requestedLimit = 6,
): Gx460RecallResult {
  const result = recallFederatedEvidence(
    GX460_CORPUS.adapter,
    databasePath,
    query,
    requestedLimit,
  );
  return {
    ...result,
    domain: 'Lexus GX460 (2010-2023)',
    evidence: result.evidence.map(evidence => ({
      ...evidence,
      video_id: evidence.source_id,
      claims: evidence.claims.map(claim => ({
        ...claim,
        applicability: claim.applicability?.model === 'GX460'
          ? { ...claim.applicability, model: 'GX460' as const }
          : null,
      })),
    })),
  };
}
