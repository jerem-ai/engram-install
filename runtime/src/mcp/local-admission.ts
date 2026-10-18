// Admission mode for every memory read on the local trusted surface: the stdio
// server (./server.ts, used by Claude Code and OpenClaw), the HTTP MCP wrapper
// (./http.ts), and the REST search endpoint (./http-app.ts). All of them run as
// the operator's own user against the operator's own kg.db, so they serve
// legacy memory the same way the CLI `memory-search` and `engram-recall`
// defaults do. The promoted-only gate returns nothing until sources are
// promoted through review, and records_engram_memory_sources has no rows in
// production, so promoted_only here meant every recall came back empty. The
// external read server (./engram-read-server.ts) keeps 'promoted_only' and
// stays fail-closed for outside clients.
//
// Lives in its own side-effect-free module so ./http-app.ts can import it
// without pulling in ./server.ts, which opens the store at import time.
export const LOCAL_MEMORY_ADMISSION = 'legacy' as const;
