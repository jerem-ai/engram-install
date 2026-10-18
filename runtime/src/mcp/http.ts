// HTTP/SSE entry point for the knowledge-graph MCP server.
//
// Exposes the read-only subset of the stdio server (./index.ts) over HTTP so
// remote MCP clients — Cowork in particular — can connect without receiving
// vault or database mutation capability. Two transports are mounted for compatibility:
//
//   • Streamable HTTP (modern spec) at  POST/GET/DELETE  /mcp
//   • Legacy SSE (deprecated spec)  at  GET /sse  +  POST /messages
//
// A plain REST route GET /memory/search (no MCP session) is mounted alongside
// for the Claude Code recall hook; it shares the same store and embedder.
//
// Both build a fresh McpServer per session via createKgServer(); the underlying
// DB + embedder are process-wide singletons (see ./server.ts), so concurrent
// sessions share one index without contention. Route handlers live in
// ./http-app.ts so tests can mount the app without this listener.
//
// Config (env):
//   KG_HTTP_PORT          listen port            (default 3737)
//   KG_HTTP_HOST          bind address           (default 127.0.0.1)
//   KG_HTTP_ALLOWED_HOSTS comma-separated Host-header allowlist for DNS-rebinding
//                         protection. Required when binding to a non-localhost
//                         address (e.g. a tailnet IP) so remote clients aren't
//                         rejected. When unset and host is localhost, localhost
//                         validation is applied automatically.
import { createKgHttpApp } from './http-app.js';
import { createKgServer, searchLocalMemory, warmPassageCache } from './server.js';
import { resolvePassageOpts } from '../lib/passage-rescore.js';
import { FUSION_DEFAULTS } from '../lib/memory-search.js';
import { answerVerifyEnabled, warmAnswerScorer } from '../lib/answer-verify.js';
import { positiveInt } from './session-registry.js';

const PORT = Number(process.env.KG_HTTP_PORT ?? 3737);
const HOST = process.env.KG_HTTP_HOST ?? '127.0.0.1';
const ALLOWED_HOSTS = process.env.KG_HTTP_ALLOWED_HOSTS
  ?.split(',')
  .map(s => s.trim())
  .filter(Boolean);

const { app } = createKgHttpApp({
  host: HOST,
  allowedHosts: ALLOWED_HOSTS,
  createServer: () => createKgServer({ readOnly: true }),
  memorySearch: searchLocalMemory,
  streamable: {
    ttlMs: positiveInt(process.env.KG_HTTP_SESSION_TTL_MS, 30 * 60_000),
    maxSessions: positiveInt(process.env.KG_HTTP_MAX_SESSIONS, 128),
  },
  sse: {
    ttlMs: positiveInt(process.env.KG_HTTP_SSE_SESSION_TTL_MS, 30 * 60_000),
    maxSessions: positiveInt(process.env.KG_HTTP_MAX_SSE_SESSIONS, 32),
  },
});

app.listen(PORT, HOST, () => {
  console.error(`knowledge-graph MCP listening on http://${HOST}:${PORT} (Streamable HTTP: /mcp, SSE: /sse, REST: /memory/search)`);
  if (resolvePassageOpts().enabled) {
    const startedAt = Date.now();
    warmPassageCache().then(
      n => console.error(`[kg-http] passage cache warm: ${n} memory notes in ${Date.now() - startedAt} ms`),
      err => console.error(`[kg-http] passage cache warm failed (queries fill it lazily): ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  if (answerVerifyEnabled() && FUSION_DEFAULTS.verifyFtsRank > 0) {
    warmAnswerScorer().then(
      () => console.error('[kg-http] answer model warm'),
      err => console.error(`[kg-http] answer model warm failed (search fuses two lists until it loads): ${err instanceof Error ? err.message : String(err)}`),
    );
  }
});
