import type { FederatedCorpusAdapter } from './federated-corpus.js';

export function createGenericCorpusAdapter(
  collectionId: string,
  domain: string,
): FederatedCorpusAdapter {
  return {
    corpusId: collectionId,
    domain,
    databaseLabel: 'Collection',
    supportedSchemaVersions: [1, 2],
    synthesisNote: 'Cite the returned evidence. Check collection freshness before using time-sensitive observations.',
    classifySource: row => row.start_ms !== null
      ? 'video'
      : /^post-\d+$/.test(row.locator) ? 'forum_post' : 'document',
    citationUrl: (row, seconds) => seconds !== null
      ? `${row.url}${row.url.includes('?') ? '&' : '?'}t=${seconds}s`
      : /^post-\d+$/.test(row.locator) ? `${row.url.split('#')[0]}#${row.locator}` : row.url,
  };
}
