#!/bin/bash
# engram-status.sh: print `kg status` for this install (add --json for the report).
# Reads ~/.config/engram/engram.env for the node binary and tenant.env for identity.
REL=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../runtime/scripts/engram-env.sh
. "$REL/runtime/scripts/engram-env.sh" && engram_env_load
tenant_file="${ENGRAM_CONF_ENGRAM_TENANT_ENV_FILE:-$HOME/.config/engram/tenant.env}"
if [ -r "$tenant_file" ]; then set -a; . "$tenant_file"; set +a; fi
"${ENGRAM_CONF_ENGRAM_NODE:-node}" "$REL/runtime/dist/cli/index.js" status "$@" || exit $?
# One line for the local transcript archive, after the report (text mode only).
case " $* " in *" --json "*) exit 0 ;; esac
archive="${ENGRAM_CONF_ENGRAM_ARCHIVE_DIR:-}"
if [ "$archive" = off ]; then
  echo "Transcript archive: off (ENGRAM_ARCHIVE_DIR=off in ~/.config/engram/engram.env)"
elif [ -n "$archive" ]; then
  "$REL/extraction/venv/bin/python" "$REL/extraction/archive_local.py" --archive "$archive" --size
fi
