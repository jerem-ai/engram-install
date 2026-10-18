#!/bin/bash
trap 'rc=$?; [ "$rc" -ne 0 ] && "${ENGRAM_NOTIFY_CMD:-$HOME/bin/engram-notify.sh}" "Engram: run-kg-index.sh FAILED" "exit $rc on $(hostname -s) — check logs" high' EXIT  # engram-alert
# Self-healing KG index runner. If a node upgrade breaks better-sqlite3's native
# ABI (ERR_DLOPEN), rebuild it before indexing instead of failing silently.
# Belt to the `brew pin node` suspenders — survives the pin ever being removed.
# Per-install settings (~/.config/engram/engram.env) fill gaps; with no file
# (Jeremy's machines) every value below is the one this script always used.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/engram-env.sh
[ -r "$SCRIPT_DIR/scripts/engram-env.sh" ] && . "$SCRIPT_DIR/scripts/engram-env.sh" && engram_env_load
ENGRAM_NOTIFY_CMD=${ENGRAM_CONF_ENGRAM_NOTIFY:-$HOME/bin/engram-notify.sh}
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
[ -n "${ENGRAM_CONF_ENGRAM_NODE:-}" ] && PATH="$(dirname "$ENGRAM_CONF_ENGRAM_NODE"):$PATH"
cd "$SCRIPT_DIR" || exit 1
export KG_VAULT_PATH=${ENGRAM_CONF_KG_VAULT_PATH:-$HOME/claude-vault/vault}
export KG_DATA_DIR=${ENGRAM_CONF_KG_DATA_DIR:-$HOME/.local/share/knowledge-graph}
export ENGRAM_ENABLE_EPISODES=1
export ENGRAM_ENABLE_ASSERTIONS=1
export ENGRAM_ENABLE_RECALL=1
# Phase R: generated link blocks stay in vault files but out of the index.
export KG_STRIP_MANAGED_BLOCKS=1
: "${ENGRAM_TENANT_ID:?ENGRAM_TENANT_ID must be set by trusted service configuration}"
: "${ENGRAM_PRINCIPAL_ID:?ENGRAM_PRINCIPAL_ID must be set by trusted service configuration}"

# Rotate the error log before it eats the disk (warning spam, not crashes)
# The plist writes stdout/stderr to the same log dir, outside the release.
# scripts/engram-health.ts and serve-inspector.ts read kg-index.log from here.
LOG_DIR=${ENGRAM_LOG_DIR:-$HOME/.local/share/engram/logs/kg-index}
mkdir -p "$LOG_DIR"
ERRLOG="$LOG_DIR/kg-index-error.log"
[ -f "$ERRLOG" ] && [ "$(stat -f%z "$ERRLOG" 2>/dev/null || echo 0)" -gt 52428800 ] && : > "$ERRLOG"

# ABI check must CONSTRUCT a Database — better-sqlite3 loads its native binding
# lazily in the Database constructor, so a bare require() passes even when the
# ABI is broken (this masked a 14h silent indexer outage on 2026-07-08).
# Hazard: this and run-kg-http.sh / run-engram-metrics.sh share one node_modules —
# a rebuild under the wrong Node flips the shared ABI and breaks the siblings.
for _ in 1 2; do
  if node -e "new (require('better-sqlite3'))(':memory:')" >/dev/null 2>&1; then
    break
  fi
  echo "[$(date '+%F %T')] better-sqlite3 ABI broken (node $(node -v)) — reinstalling"
  rm -rf node_modules/better-sqlite3/build
  npm rebuild better-sqlite3 >&2
done

node node_modules/tsx/dist/cli.mjs src/cli/index.ts index

# Agents admit their own facts (2026-10-04). The index admits extracted claims in
# place; this sweep admits engram_remember facts whose source was not indexed yet.
node node_modules/tsx/dist/cli.mjs src/cli/index.ts engram-self-admit || echo "[$(date '+%F %T')] engram-self-admit failed"

# Fact maintainer (2026-10-04): a self-admitted fact follows its memory file, and
# quarantined copies that can never be admitted retire. Receipts and revert: OBSERVE.md.
node node_modules/tsx/dist/cli.mjs src/cli/index.ts engram-maintain || echo "[$(date '+%F %T')] engram-maintain failed"

# Generate Engram agent profile after index completes
bash scripts/generate-engram-profile.sh
