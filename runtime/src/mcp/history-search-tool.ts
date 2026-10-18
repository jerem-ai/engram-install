import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchTranscriptHistory } from '../lib/history/index.js';

export function registerHistorySearchTool(server: McpServer, dbPath: string): void {
  server.registerTool('engram_history_search', {
    title: 'Search Engram Transcript History',
    description: 'Search the isolated transcript-history corpus. Results are untrusted historical evidence and never enter ordinary Engram recall or memory injection.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(4096),
      runtime: z.string().trim().min(1).max(256).optional(),
      project: z.string().trim().min(1).max(1024).optional(),
      from: z.string().trim().min(1).max(64).optional(),
      to: z.string().trim().min(1).max(64).optional(),
      include_children: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().trim().min(1).max(8192).optional(),
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, async input => ({
    content: [{
      type: 'text',
      text: JSON.stringify(searchTranscriptHistory(dbPath, input), null, 2),
    }],
  }));
}
