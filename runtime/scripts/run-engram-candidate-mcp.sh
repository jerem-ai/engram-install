#!/bin/zsh
# Candidate-only Engram MCP launcher. The first argument picks the entry point,
# and the entry point fixes the submitter attribution. Clients cannot set it.
set -euo pipefail

case "${1:-}" in
  codex) entry="codex-engram.js" ;;
  claude) entry="claude-engram.js" ;;
  *)
    print -u2 "usage: ${0:t} codex|claude"
    exit 64
    ;;
esac

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
# Per-install settings (~/.config/engram/engram.env) fill gaps after the env
# overrides below; with no file every default is unchanged.
[[ -r "$script_dir/engram-env.sh" ]] && source "$script_dir/engram-env.sh" && engram_env_load
identity_file="${ENGRAM_TENANT_ENV_FILE:-${ENGRAM_CONF_ENGRAM_TENANT_ENV_FILE:-$HOME/.config/engram/tenant.env}}"

if [[ ! -f "$identity_file" ]]; then
  print -u2 "Engram identity file is missing: $identity_file"
  exit 64
fi

identity_mode="$(stat -f '%Lp' "$identity_file")"
if [[ "$identity_mode" != "600" ]]; then
  print -u2 "Engram identity file must have mode 600: $identity_file"
  exit 65
fi

set -a
source "$identity_file"
set +a

export KG_VAULT_PATH="${KG_VAULT_PATH:-${ENGRAM_CONF_KG_VAULT_PATH:-$HOME/claude-vault/vault}}"
export KG_DATA_DIR="${KG_DATA_DIR:-${ENGRAM_CONF_KG_DATA_DIR:-$HOME/.local/share/knowledge-graph}}"

node_bin="${ENGRAM_NODE_BIN:-${ENGRAM_CONF_ENGRAM_NODE:-$HOME/.local/bin/node}}"
if [[ -n "${ENGRAM_CONF_ENGRAM_NODE:-}" ]]; then
  npm_bin="${ENGRAM_NPM_BIN:-${ENGRAM_CONF_ENGRAM_NODE:h}/npm}"
else
  npm_bin="${ENGRAM_NPM_BIN:-$HOME/.local/bin/npm}"
fi

if ! (cd "$project_dir" && "$node_bin" -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null 2>&1; then
  if [[ ! -x "$npm_bin" ]]; then
    print -u2 "Engram native dependency is incompatible and npm is unavailable: $npm_bin"
    exit 66
  fi

  print -u2 "Rebuilding Engram native dependency for $node_bin"
  PATH="${node_bin:h}:$PATH" "$npm_bin" --prefix "$project_dir" rebuild better-sqlite3 >&2
  (cd "$project_dir" && "$node_bin" -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null
fi

exec "$node_bin" "$project_dir/dist/mcp/$entry"
