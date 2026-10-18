#!/bin/bash
# Long-running launcher for the knowledge-graph MCP HTTP/SSE server.
# launchd keeps this alive (KeepAlive); remote MCP clients (Cowork) connect over
# HTTP instead of spawning a local stdio subprocess. Mirrors run-kg-index.sh for
# env + better-sqlite3 ABI self-healing, then exec's the server in the foreground
# so launchd tracks the node process directly.
# Per-install settings (~/.config/engram/engram.env) fill gaps; with no file
# (Jeremy's machines) every value below is the one this script always used.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/engram-env.sh
[ -r "$SCRIPT_DIR/scripts/engram-env.sh" ] && . "$SCRIPT_DIR/scripts/engram-env.sh" && engram_env_load
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
[ -n "${ENGRAM_CONF_ENGRAM_NODE:-}" ] && PATH="$(dirname "$ENGRAM_CONF_ENGRAM_NODE"):$PATH"
cd "$SCRIPT_DIR" || exit 1

export KG_VAULT_PATH=${ENGRAM_CONF_KG_VAULT_PATH:-$HOME/claude-vault/vault}
export KG_DATA_DIR=${ENGRAM_CONF_KG_DATA_DIR:-$HOME/.local/share/knowledge-graph}
export ENGRAM_ENABLE_EPISODES=1
export ENGRAM_ENABLE_ASSERTIONS=1
export ENGRAM_ENABLE_RECALL=1
: "${ENGRAM_TENANT_ID:?ENGRAM_TENANT_ID must be set by trusted service configuration}"
: "${ENGRAM_PRINCIPAL_ID:?ENGRAM_PRINCIPAL_ID must be set by trusted service configuration}"

# Transport config. Bind to localhost by default; to let a remote machine reach
# this directly, set KG_HTTP_HOST to the tailnet IP and KG_HTTP_ALLOWED_HOSTS to
# the Host header(s) clients will send (e.g. "100.64.0.1:3737").
export KG_HTTP_PORT=${KG_HTTP_PORT:-3737}
export KG_HTTP_HOST=${KG_HTTP_HOST:-127.0.0.1}

# Rotate the error log before it eats the disk.
# The plist writes stdout/stderr to the same log dir, outside the release.
LOG_DIR=${ENGRAM_LOG_DIR:-$HOME/.local/share/engram/logs/kg-http}
mkdir -p "$LOG_DIR"
ERRLOG="$LOG_DIR/kg-http-error.log"
[ -f "$ERRLOG" ] && [ "$(stat -f%z "$ERRLOG" 2>/dev/null || echo 0)" -gt 52428800 ] && : > "$ERRLOG"

# Self-heal better-sqlite3 if a node upgrade broke its native ABI (ERR_DLOPEN).
# Hazard: this server and run-engram-metrics.sh (port 3339) share one
# node_modules — a rebuild here runs under WHATEVER node the PATH above
# resolves first, and that ABI then applies to both services. If you ever
# see ERR_DLOPEN on one after touching the other's PATH/node version, that's
# why — fix the PATH, don't just re-run the rebuild.
# The check must CONSTRUCT a Database — better-sqlite3 loads its native binding
# lazily in the Database constructor, so a bare require() passes even when the
# ABI is broken.
for _ in 1 2; do
  if node -e "new (require('better-sqlite3'))(':memory:')" >/dev/null 2>&1; then
    break
  fi
  echo "[$(date '+%F %T')] better-sqlite3 ABI broken (node $(node -v)) — reinstalling"
  rm -rf node_modules/better-sqlite3/build
  npm rebuild better-sqlite3 >&2
done

exec node node_modules/tsx/dist/cli.mjs src/mcp/http.ts
