import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CorpusRoutingRuntime } from '../lib/corpus-routing-runtime.js';

export function registerCorpusRoutingTool(
  server: McpServer,
  runtime: CorpusRoutingRuntime,
): void {
  server.registerTool('engram_corpus_route', {
    title: 'Route and Search Shared Collections',
    description: 'Select a bounded set of relevant registered collections and return each collection’s cited evidence separately. Reports uncovered needs and supports explicit collection and lexical rollback controls.',
    inputSchema: {
      query: z.string().trim().min(1).max(1000),
      collection_ids: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(8).optional(),
      automatic_routing: z.boolean().optional(),
      force_lexical: z.boolean().optional(),
      limit: z.number().int().min(1).max(12).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ query, collection_ids, automatic_routing, force_lexical, limit }) => {
    const result = await runtime.route({
      query,
      collectionIds: collection_ids,
      autoRoutingEnabled: automatic_routing,
      forceLexical: force_lexical,
      limit: limit ?? 6,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
