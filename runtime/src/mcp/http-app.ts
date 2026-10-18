// Express app for the read-only knowledge-graph MCP server (Streamable HTTP + legacy SSE).
//
// Split out of ./http.ts so tests can mount the app on an ephemeral port without
// the CLI entry point binding its configured listener at import time. The entry
// point supplies createKgServer(); tests supply a bare McpServer.
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SessionRegistry } from './session-registry.js';
import { LOCAL_MEMORY_ADMISSION } from './local-admission.js';
import type { MemorySearchOpts } from '../lib/memory-search.js';
import type { SearchResult } from '../lib/types.js';

export interface SessionLimits {
  ttlMs: number;
  maxSessions: number;
}

/**
 * Backs GET /memory/search. The entry point passes searchLocalMemory from
 * ./server.ts (shared store + resident embedder); tests pass a closure over an
 * in-memory Store and a stub embedder. Admission is fixed by the route.
 */
export type MemorySearchFn = (query: string, opts: MemorySearchOpts) => Promise<SearchResult[]>;

export interface KgHttpAppOptions {
  host: string;
  allowedHosts?: string[];
  /** Builds a fresh McpServer per session; the entry point passes createKgServer. */
  createServer: () => McpServer;
  streamable: SessionLimits;
  sse: SessionLimits;
  /** When omitted, GET /memory/search answers 503. */
  memorySearch?: MemorySearchFn;
}

export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
export const MEMORY_SEARCH_MAX_LIMIT = 50;

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function clampLimit(raw: string | undefined): number {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return MEMORY_SEARCH_DEFAULT_LIMIT;
  return Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

function parseMinScore(raw: string | undefined): number {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export interface KgHttpApp {
  app: Express;
  streamableSessions: SessionRegistry<StreamableHTTPServerTransport>;
  sseSessions: SessionRegistry<SSEServerTransport>;
}

// Mirrors the SDK's own transport: an unknown session id is 404 / -32001 so the
// client discards its session and re-initializes, while a missing session id on
// a non-initialize request stays 400. Answering 400 for a stale id (after a
// restart or TTL expiry) left Claude Code retrying the dead session forever.
function sessionNotFound(res: Response): void {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  });
}

export function createKgHttpApp(options: KgHttpAppOptions): KgHttpApp {
  const { host, allowedHosts, createServer } = options;
  const app = createMcpExpressApp(
    allowedHosts ? { host, allowedHosts } : { host },
  );

  // --- Streamable HTTP transport (modern) ---
  // One transport per session, keyed by the mcp-session-id header the SDK assigns
  // on the initialize handshake.
  const streamableSessions = new SessionRegistry<StreamableHTTPServerTransport>(options.streamable);
  const sseSessions = new SessionRegistry<SSEServerTransport>(options.sse);

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) {
        sessionNotFound(res);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session for this request' },
          id: null,
        });
        return;
      }
      if (!await streamableSessions.canAccept()) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Server session capacity reached; retry later' },
          id: null,
        });
        return;
      }
      // Fresh session: build a transport + server and wire up cleanup.
      const server = createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { streamableSessions.add(id, transport!, server); },
      });
      transport.onclose = () => {
        if (transport!.sessionId) void streamableSessions.close(transport!.sessionId, 'client');
      };
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET = server→client notification stream; DELETE = explicit session teardown.
  const routeBySession = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const transport = streamableSessions.get(sessionId);
    if (!transport) {
      sessionNotFound(res);
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', routeBySession);
  app.delete('/mcp', routeBySession);

  // --- Legacy SSE transport (deprecated, kept for older clients) ---
  app.get('/sse', async (_req: Request, res: Response) => {
    if (!await sseSessions.canAccept()) {
      res.status(503).send('Server SSE session capacity reached; retry later');
      return;
    }
    const server = createServer();
    const transport = new SSEServerTransport('/messages', res);
    sseSessions.add(transport.sessionId, transport, server);
    transport.onclose = () => { void sseSessions.close(transport.sessionId, 'client'); };
    await server.connect(transport);
  });

  app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).send('Missing sessionId');
      return;
    }
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(404).send('No SSE session found for that sessionId');
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  // --- Plain REST memory search ---
  // One request, no MCP session. The Claude Code recall hook hits this instead
  // of spawning `kg memory-search` per prompt, which paid a fresh model load
  // every call. Response body is the same JSON array the CLI prints. Stale
  // exclusion and KG_INCLUDE_STALE are handled inside searchMemoryHybrid, so
  // this route behaves exactly like the CLI there.
  app.get('/memory/search', async (req: Request, res: Response) => {
    const startedAt = process.hrtime.bigint();
    const q = queryString(req.query.q)?.trim();
    if (!q) {
      res.status(400).json({ error: 'q is required' });
      return;
    }
    if (!options.memorySearch) {
      res.status(503).json({ error: 'memory search is not configured on this server' });
      return;
    }
    const searchOpts: MemorySearchOpts = {
      k: clampLimit(queryString(req.query.limit)),
      minScore: parseMinScore(queryString(req.query.minScore)),
      runtime: queryString(req.query.runtime) || undefined,
      persona: queryString(req.query.persona) || undefined,
      model: queryString(req.query.model) || undefined,
      admission: LOCAL_MEMORY_ADMISSION,
    };
    try {
      const results = await options.memorySearch(q, searchOpts);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      res.setHeader('X-KG-Search-Ms', elapsedMs.toFixed(1));
      res.json(results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kg-http] /memory/search failed: ${message}`);
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  });

  // --- Health check ---
  app.get('/health', (_req: Request, res: Response) => {
    const streamable = streamableSessions.stats();
    const sse = sseSessions.stats();
    res.json({
      status: 'ok',
      server: 'knowledge-graph',
      transports: { streamableHttp: '/mcp', sse: '/sse' },
      sessions: {
        streamable: streamable.active,
        sse: sse.active,
        streamable_details: streamable,
        sse_details: sse,
      },
    });
  });

  return { app, streamableSessions, sseSessions };
}
