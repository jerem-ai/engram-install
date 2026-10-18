#!/bin/bash
# engram-status.sh: print `kg status` for this install (add --json for the report).
# Reads ~/.config/engram/engram.env for the node binary and tenant.env for identity.
REL=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../runtime/scripts/engram-env.sh
. "$REL/runtime/scripts/engram-env.sh" && engram_env_load
tenant_file="${ENGRAM_CONF_ENGRAM_TENANT_ENV_FILE:-$HOME/.config/engram/tenant.env}"
if [ -r "$tenant_file" ]; then set -a; . "$tenant_file"; set +a; fi
exec "${ENGRAM_CONF_ENGRAM_NODE:-node}" "$REL/runtime/dist/cli/index.js" status "$@"
