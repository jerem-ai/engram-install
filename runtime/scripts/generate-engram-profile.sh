#!/bin/bash
# Engram agent profile generator.
# Called by kg-index cron after indexing completes.
set -euo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

export KG_VAULT_PATH=${KG_VAULT_PATH:-$HOME/claude-vault/vault}
export KG_DATA_DIR=${KG_DATA_DIR:-$HOME/.local/share/knowledge-graph}
export ENGRAM_ENABLE_EPISODES=1
export ENGRAM_ENABLE_ASSERTIONS=1
export ENGRAM_ENABLE_RECALL=1
: "${ENGRAM_TENANT_ID:?ENGRAM_TENANT_ID must be set by trusted service configuration}"
: "${ENGRAM_PRINCIPAL_ID:?ENGRAM_PRINCIPAL_ID must be set by trusted service configuration}"

OUTPUT_FILE="$KG_VAULT_PATH/Memory/Engram/agent-profile.md"
mkdir -p "$(dirname "$OUTPUT_FILE")"

npx tsx scripts/generate-engram-profile.ts "$OUTPUT_FILE" 2>/dev/null && \
  echo "engram-profile: OK" || \
  echo "engram-profile: skipped (no data yet)"
