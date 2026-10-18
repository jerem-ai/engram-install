# Reader for ~/.config/engram/engram.env, the per-install settings file. Source it
# from bash or zsh, then call engram_env_load: each setting becomes a shell variable
# ENGRAM_CONF_<KEY>. Nothing is exported and nothing in the file is executed.
#
# Same format and key list as hooks/engram-env.mjs, src/lib/install-config.ts and
# extraction/install_config.py (held equal by test/install-config-parity.test.ts).
# A missing file sets nothing, so every caller keeps its built-in default. Jeremy's
# machines have no engram.env.

ENGRAM_ENV_KEYS="ENGRAM_HOME KG_VAULT_PATH KG_DATA_DIR ENGRAM_RUNTIME_DIR ENGRAM_NODE ENGRAM_HTTP_URL ENGRAM_EXTRACT_BACKEND ENGRAM_CLI_DRIVER ENGRAM_MEMORY_ROOT ENGRAM_LABEL_PREFIX ENGRAM_USER_NAME ENGRAM_PERSONA ENGRAM_MEMORY_PROJECTS ENGRAM_STATE_DIR ENGRAM_NOTIFY ENGRAM_TENANT_ENV_FILE CODEX_HOME ENGRAM_MIN_SCORE ENGRAM_MCP_ADMISSION ENGRAM_SINCE_DAYS"

# engram_env_load [file] [home]
engram_env_load() {
  local file="${1:-$HOME/.config/engram/engram.env}" home="${2:-$HOME}" raw line key value q
  # Settings come from the file only, never from an inherited ENGRAM_CONF_* variable.
  for key in $(printf '%s\n' "$ENGRAM_ENV_KEYS" | tr ' ' '\n'); do unset "ENGRAM_CONF_$key"; done
  [ -r "$file" ] || return 0
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw#"${raw%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue
    case "$key" in ''|*[!A-Z0-9_]*) continue ;; esac
    case " $ENGRAM_ENV_KEYS " in *" $key "*) ;; *) continue ;; esac
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [ "${#value}" -ge 2 ]; then
      q="${value%"${value#?}"}"
      if { [ "$q" = '"' ] || [ "$q" = "'" ]; } && [ "${value#"${value%?}"}" = "$q" ]; then
        value="${value#?}"; value="${value%?}"
      fi
    fi
    case "$value" in
      '~'|'$HOME') value="$home" ;;
      '~/'*) value="$home/${value#'~/'}" ;;
      '$HOME/'*) value="$home/${value#'$HOME/'}" ;;
    esac
    [ -n "$value" ] || continue
    eval "ENGRAM_CONF_$key=\$value"
  done < "$file"
}

# Parity test entry: print every loaded setting as sorted KEY=VALUE lines.
engram_env_dump() {
  local key
  for key in $(printf '%s\n' "$ENGRAM_ENV_KEYS" | tr ' ' '\n' | sort); do
    eval "[ -n \"\${ENGRAM_CONF_$key+x}\" ] && printf '%s=%s\n' \"\$key\" \"\$ENGRAM_CONF_$key\""
  done
  return 0
}
