#!/bin/bash
# install-local.sh: install Engram for one macOS user (PLAN_ENGRAM_OUT_OF_BOX_2026-10-17.md, Phase 4).
#
#   scripts/install-local.sh [--dry-run] [--driver claude|codex] [--port N] [--no-launchd]
#   scripts/install-local.sh --uninstall [--dry-run]
#   scripts/install-local.sh --purge [--dry-run]
#
# Install builds a release of this checkout under ~/Engram/releases/<commit>, points
# ~/Engram/current at it, writes ~/.config/engram/engram.env and tenant.env, writes
# four launch agents (index and mirror every 15 minutes, extraction hourly on the
# user's own claude or codex login, and a resident kg-http on 127.0.0.1), registers
# the Engram MCP server with Claude Code and Codex, and installs both recall hooks.
# Run it again to upgrade; it is idempotent.
#
# Every path comes from HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and
# ENGRAM_LAUNCH_AGENTS_DIR, so a throwaway HOME isolates a test install completely.
# Launch agents are only loaded when HOME is the account's real home directory.
# --uninstall reverses every step and keeps the vault, data and config. --purge also
# removes those, the memories the extractor wrote, and any Claude or Codex config
# directory the install itself created. --dry-run prints each action and writes
# nothing. The installer never installs node or python; it prints the brew line.
#
# Exit codes: 0 ok, 2 usage, 3 missing prerequisite, 4 a step failed.
set -euo pipefail

MODE=install
DRY=0
DRIVER=""
PORT="${ENGRAM_HTTP_PORT:-3741}"
LAUNCHD=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --uninstall) MODE=uninstall ;;
    --purge) MODE=purge ;;
    --driver) DRIVER="${2:-}"; shift ;;
    --port) PORT="${2:-}"; shift ;;
    --no-launchd) LAUNCHD=no ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "install-local: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

SRC=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENGRAM_HOME="$HOME/Engram"
VAULT="$ENGRAM_HOME/vault"
DATA="$ENGRAM_HOME/data"
LOGS="$ENGRAM_HOME/logs"
STATE="$ENGRAM_HOME/state/extraction"
RELEASES="$ENGRAM_HOME/releases"
CURRENT="$ENGRAM_HOME/current"
CONF="$HOME/.config/engram"
MANIFEST="$CONF/install-manifest.json"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
LA="${ENGRAM_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PREFIX="com.engram.local"
AGENTS="index mirror extraction kg-http"
MCP_NAME="engram"

say() { printf '%s\n' "$*"; }
die() { printf 'install-local: %s\n' "$2" >&2; exit "$1"; }
# Every change goes through act; in a dry run it only prints.
act() {
  if [ "$DRY" -eq 1 ]; then say "[dry-run] $*"; else say "+ $*"; "$@"; fi
}
write_file() {  # path mode: content on stdin, written atomically
  local path=$1 mode=$2 tmp
  if [ "$DRY" -eq 1 ]; then cat > /dev/null; say "[dry-run] write $path (mode $mode)"; return 0; fi
  mkdir -p "$(dirname "$path")"
  tmp="$path.tmp-$$"
  cat > "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
  say "+ wrote $path"
}
remove() {  # remove a path the install created, if present
  [ -e "$1" ] || [ -L "$1" ] || return 0
  if [ "$DRY" -eq 1 ]; then say "[dry-run] remove $1"; else rm -rf -- "$1"; say "- removed $1"; fi
}

real_home() { dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}'; }
use_launchd() {
  [ "$LAUNCHD" = no ] && return 1
  [ "${ENGRAM_SKIP_LAUNCHD:-0}" = 1 ] && return 1
  [ "$LA" = "$HOME/Library/LaunchAgents" ] || return 1
  [ "$(real_home)" = "$HOME" ]
}

# --- prerequisites --------------------------------------------------------------

[ "$(uname -s)" = Darwin ] || die 3 "macOS only for now."
NODE="${ENGRAM_NODE:-$(command -v node || true)}"
PY312="$(command -v python3.12 || true)"
[ -n "$PY312" ] || { [ -x /opt/homebrew/bin/python3.12 ] && PY312=/opt/homebrew/bin/python3.12; } || true
CLAUDE_BIN="$(command -v claude || true)"
CODEX_BIN="$(command -v codex || true)"

if [ "$MODE" = install ]; then
  case "$("$NODE" --version 2>/dev/null || true)" in
    v22.*) ;;
    *) die 3 "Node 22 is required (found: ${NODE:-none}). Install it with: brew install node@22 && brew link --overwrite node@22" ;;
  esac
  [ -n "$PY312" ] || die 3 "Python 3.12 is required. Install it with: brew install python@3.12"
  command -v git >/dev/null || die 3 "git is required. Install it with: xcode-select --install"
  claude_ok=0; codex_ok=0
  # ENGRAM_CLI_HOME names the home whose CLI logins to use (the extractor honors it
  # too); a test install under a throwaway HOME points it at the real one.
  cli_env=()
  [ -n "${ENGRAM_CLI_HOME:-}" ] && cli_env=(env -u CLAUDE_CONFIG_DIR HOME="$ENGRAM_CLI_HOME" CODEX_HOME="$ENGRAM_CLI_HOME/.codex")
  if [ -n "$CLAUDE_BIN" ] && ${cli_env[@]+"${cli_env[@]}"} "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then claude_ok=1; fi
  if [ -n "$CODEX_BIN" ] && ${cli_env[@]+"${cli_env[@]}"} "$CODEX_BIN" login status >/dev/null 2>&1; then codex_ok=1; fi
  if [ -z "$DRIVER" ]; then
    if [ "$claude_ok" -eq 1 ]; then DRIVER=claude; elif [ "$codex_ok" -eq 1 ]; then DRIVER=codex; fi
  fi
  case "$DRIVER" in
    claude) [ "$claude_ok" -eq 1 ] || die 3 "Claude Code is not logged in. Run: claude, then /login" ;;
    codex) [ "$codex_ok" -eq 1 ] || die 3 "Codex is not logged in. Run: codex login" ;;
    "") die 3 "Log in to Claude Code (claude, then /login) or Codex (codex login) first." ;;
    *) die 2 "--driver must be claude or codex" ;;
  esac
  case "$PORT" in ''|*[!0-9]*) die 2 "--port must be a number" ;; esac
  # An Engram setup this installer did not make (an operator's own tenant.env, as on
  # Jeremy's machines) would start reading the engram.env this writes. Never take it over.
  if [ -f "$CONF/tenant.env" ] && [ ! -f "$MANIFEST" ]; then
    if [ "$DRY" -eq 1 ]; then
      say "[dry-run] note: a real install would stop here: $CONF/tenant.env exists and this installer did not create it"
    else
      die 3 "$CONF/tenant.env exists and this installer did not create it; an Engram setup is already here. Not touching it."
    fi
  fi
  [ "$DRIVER" = codex ] && say "note: Engram learns less from the codex driver today (docs/OOB_PHASE2_RESULTS_2026-10-17.md); log in to Claude Code to use the claude driver"
fi

# --- install ----------------------------------------------------------------------

manifest_flag() { sed -nE "s/.*\"$1\": *(true|false).*/\1/p" "$MANIFEST" 2>/dev/null | head -1; }

identifier() { printf '%s' "$1" | tr -c 'A-Za-z0-9._:-' '-' | cut -c1-120; }

existed() { [ -e "$1" ] && echo true || echo false; }

build_release() {
  local sha rel
  sha=$(git -C "$SRC" rev-parse HEAD 2>/dev/null) || die 4 "$SRC is not a git checkout"
  rel="$RELEASES/$sha"
  REL="$rel"
  if [ -f "$rel/.engram-ready" ]; then say "release $sha already built"; return 0; fi
  if [ "$DRY" -eq 1 ]; then
    say "[dry-run] build release $rel (git archive, npm ci, npm run build, python venv, model prefetch, better-sqlite3 probe)"
    return 0
  fi
  [ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] \
    || say "note: $SRC has uncommitted changes; the release is built from commit $sha only"
  remove "$rel"
  mkdir -p "$rel"
  git -C "$SRC" archive --format=tar HEAD | tar -x -C "$rel"
  say "+ npm ci and build in $rel/runtime"
  # npm's cache lives under ~/Engram so --purge removes it with everything else.
  (cd "$rel/runtime" && PATH="$(dirname "$NODE"):$PATH" npm_config_cache="$ENGRAM_HOME/cache/npm" \
    npm ci --no-audit --no-fund --loglevel=error >/dev/null \
    && PATH="$(dirname "$NODE"):$PATH" npm_config_cache="$ENGRAM_HOME/cache/npm" npm run build --silent >/dev/null) \
    || die 4 "runtime build failed"
  (cd "$rel/runtime" && "$NODE" -e "new (require('better-sqlite3'))(':memory:').close()") \
    || die 4 "better-sqlite3 does not load under $NODE"
  say "+ python venv in $rel/extraction/venv"
  # A bare PATH: pip probes `rustc --version` for its user agent, and on Homebrew that is a
  # rustup proxy that downloads a whole toolchain into HOME.
  PATH=/usr/bin:/bin "$PY312" -m venv "$rel/extraction/venv" || die 4 "venv failed"
  PATH=/usr/bin:/bin "$rel/extraction/venv/bin/pip" install -q --disable-pip-version-check --no-cache-dir \
    -r "$rel/extraction/requirements-local.txt" || die 4 "pip install failed"
  say "+ prefetch the embedding model"
  (cd "$rel/runtime" && "$NODE" node_modules/tsx/dist/cli.mjs scripts/prefetch-embedding-model.ts >/dev/null) \
    || die 4 "embedding model download failed"
  : > "$rel/.engram-ready"
}

flip_current() {
  local old=""
  [ -L "$CURRENT" ] && old=$(readlink "$CURRENT")
  if [ "$old" = "$REL" ]; then say "current already $REL"; return 0; fi
  [ -n "$old" ] && act ln -sfn "$old" "$ENGRAM_HOME/previous"
  act ln -sfn "$REL" "$CURRENT.tmp"
  act mv -fh "$CURRENT.tmp" "$CURRENT"
}

write_config() {
  local principal name
  principal=$(identifier "$(id -un)")
  name=$(id -F 2>/dev/null || id -un)
  write_file "$CONF/engram.env" 600 <<ENV
# Written by Engram's scripts/install-local.sh. Re-running the installer rewrites it.
ENGRAM_HOME=$ENGRAM_HOME
KG_VAULT_PATH=$VAULT
KG_DATA_DIR=$DATA
ENGRAM_RUNTIME_DIR=$CURRENT/runtime
ENGRAM_NODE=$NODE
ENGRAM_HTTP_URL=http://127.0.0.1:$PORT
ENGRAM_EXTRACT_BACKEND=cli
ENGRAM_CLI_DRIVER=$DRIVER
ENGRAM_MEMORY_ROOT=$CLAUDE_DIR/projects
ENGRAM_STATE_DIR=$STATE
ENGRAM_MEMORY_PROJECTS=$CONF/memory-projects.json
ENGRAM_USER_NAME=$name
ENGRAM_PERSONA=$principal
ENGRAM_NOTIFY=$CURRENT/scripts/engram-notify-local.sh
ENGRAM_LABEL_PREFIX=$PREFIX
ENGRAM_MCP_ADMISSION=legacy
CODEX_HOME=$CODEX_DIR
ENV
  if [ -f "$CONF/tenant.env" ]; then
    say "keep $CONF/tenant.env"
  else
    printf 'ENGRAM_TENANT_ID=local\nENGRAM_PRINCIPAL_ID=%s\n' "$principal" | write_file "$CONF/tenant.env" 600
  fi
  [ -f "$CONF/memory-projects.json" ] \
    || printf '{"schema": 1, "description": "Projects for this install (empty until you add some).", "source_slugs": {}}\n' \
      | write_file "$CONF/memory-projects.json" 644
  act mkdir -p "$VAULT/Memory" "$DATA" "$LOGS" "$STATE"
}

plist() {  # name interval|keepalive program...
  local name=$1 schedule=$2; shift 2
  local label="$PREFIX.$name" args="" a
  for a in "$@"; do args="$args    <string>$a</string>
"; done
  local when
  if [ "$schedule" = keepalive ]; then
    when="  <key>KeepAlive</key><true/>"
  else
    when="  <key>StartInterval</key><integer>$schedule</integer>"
  fi
  local path_dirs
  path_dirs="$(dirname "$NODE"):$(dirname "$PY312")"
  [ -n "$CLAUDE_BIN" ] && path_dirs="$path_dirs:$(dirname "$CLAUDE_BIN")"
  [ -n "$CODEX_BIN" ] && path_dirs="$path_dirs:$(dirname "$CODEX_BIN")"
  local tenant principal
  tenant=$(sed -n 's/^ENGRAM_TENANT_ID=//p' "$CONF/tenant.env" 2>/dev/null || echo local)
  principal=$(sed -n 's/^ENGRAM_PRINCIPAL_ID=//p' "$CONF/tenant.env" 2>/dev/null || identifier "$(id -un)")
  write_file "$LA/$label.plist" 644 <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
$when
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGS/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path_dirs:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ENGRAM_HOME</key><string>$ENGRAM_HOME</string>
    <key>ENGRAM_TENANT_ID</key><string>${tenant:-local}</string>
    <key>ENGRAM_PRINCIPAL_ID</key><string>${principal}</string>
    <key>ENGRAM_ENABLE_EPISODES</key><string>1</string>
    <key>ENGRAM_ENABLE_ASSERTIONS</key><string>1</string>
    <key>ENGRAM_ENABLE_RECALL</key><string>1</string>
    <key>ENGRAM_LOG_DIR</key><string>$LOGS/$name</string>
    <key>ENGRAM_KG_INDEX_LOG</key><string>$LOGS/index.log</string>
    <key>ENGRAM_FACT_MAINTAINER_DIR</key><string>$DATA/fact-maintainer</string>
    <key>npm_config_cache</key><string>$ENGRAM_HOME/cache/npm</string>
    <key>npm_config_update_notifier</key><string>false</string>
    <key>KG_HTTP_PORT</key><string>$PORT</string>
    <key>ENGRAM_OFF_START</key><string>0</string>
    <key>ENGRAM_OFF_END</key><string>24</string>
  </dict>
</dict>
</plist>
PLIST
}

write_agents() {
  plist index 900 /bin/bash "$CURRENT/runtime/run-kg-index.sh"
  plist mirror 900 "$CURRENT/extraction/venv/bin/python" "$CURRENT/extraction/mirror_memory.py"
  plist extraction 3600 /bin/bash "$CURRENT/extraction/run-memory-extraction.sh"
  plist kg-http keepalive /bin/bash "$CURRENT/runtime/run-kg-http.sh"
}

load_agents() {
  local name label uid
  if ! use_launchd; then say "launch agents written, not loaded (HOME is not this account's home, or --no-launchd)"; return 0; fi
  uid=$(id -u)
  for name in $AGENTS; do
    label="$PREFIX.$name"
    [ "$DRY" -eq 1 ] || launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    act launchctl bootstrap "gui/$uid" "$LA/$label.plist"
  done
}

register_clients() {
  if [ -n "$CLAUDE_BIN" ]; then
    [ "$DRY" -eq 1 ] || "$CLAUDE_BIN" mcp remove -s user "$MCP_NAME" >/dev/null 2>&1 || true
    act "$CLAUDE_BIN" mcp add -s user "$MCP_NAME" -- /bin/zsh "$CURRENT/runtime/scripts/run-claude-engram-mcp.sh"
    act "$NODE" "$CURRENT/runtime/scripts/install-claude-recall-hook.mjs" --settings "$CLAUDE_DIR/settings.json" \
      --runtime "$CURRENT/runtime" --node "$NODE"
  fi
  if [ -n "$CODEX_BIN" ]; then
    act mkdir -p "$CODEX_DIR"
    [ "$DRY" -eq 1 ] || "$CODEX_BIN" mcp remove "$MCP_NAME" >/dev/null 2>&1 || true
    act "$CODEX_BIN" mcp add "$MCP_NAME" -- /bin/zsh "$CURRENT/runtime/scripts/run-codex-engram-mcp.sh"
    act "$NODE" "$CURRENT/runtime/scripts/install-codex-recall-hook.mjs" --hooks "$CODEX_DIR/hooks.json" \
      --runtime "$CURRENT/runtime" --node "$NODE" --codex "$CODEX_BIN"
  fi
}

write_manifest() {
  local created_claude=$1 created_codex=$2 created_la=$3
  if [ -f "$MANIFEST" ]; then
    # A reinstall keeps the first install's record of what it created.
    created_claude=$(manifest_flag created_claude_dir); created_claude=${created_claude:-false}
    created_codex=$(manifest_flag created_codex_dir); created_codex=${created_codex:-false}
    created_la=$(manifest_flag created_launch_agents_dir); created_la=${created_la:-false}
  fi
  write_file "$MANIFEST" 600 <<JSON
{
  "schema": 1,
  "release": "$REL",
  "prefix": "$PREFIX",
  "agents": "$AGENTS",
  "mcp_name": "$MCP_NAME",
  "claude_dir": "$CLAUDE_DIR",
  "codex_dir": "$CODEX_DIR",
  "created_claude_dir": $created_claude,
  "created_codex_dir": $created_codex,
  "created_launch_agents_dir": $created_la,
  "created_parents": "${CREATED_PARENTS:-}",
  "driver": "$DRIVER",
  "port": $PORT
}
JSON
}

# HOME-level directories an install can create; purge removes the ones it created, if empty.
PARENTS=".config .local/share .local Library"

install() {
  local c_claude c_codex c_la p created_parents=""
  for p in $PARENTS; do [ -e "$HOME/$p" ] || created_parents="$created_parents $p"; done
  [ -f "$MANIFEST" ] && created_parents=$(sed -nE 's/.*"created_parents": *"([^"]*)".*/\1/p' "$MANIFEST")
  CREATED_PARENTS=$created_parents
  c_claude=$( [ -e "$CLAUDE_DIR" ] && echo false || echo true )
  c_codex=$( [ -e "$CODEX_DIR" ] && echo false || echo true )
  c_la=$( [ -e "$LA" ] && echo false || echo true )
  say "Engram install: HOME=$HOME driver=$DRIVER port=$PORT source=$SRC"
  build_release
  flip_current
  write_config
  write_agents
  register_clients
  write_manifest "$c_claude" "$c_codex" "$c_la"
  load_agents
  say "done. Check it with: $CURRENT/scripts/engram-status.sh"
}

# --- uninstall and purge --------------------------------------------------------------

uninstall() {
  local name label uid node_for
  uid=$(id -u)
  for name in $AGENTS; do
    label="$PREFIX.$name"
    if use_launchd && launchctl print "gui/$uid/$label" >/dev/null 2>&1; then act launchctl bootout "gui/$uid/$label"; fi
    remove "$LA/$label.plist"
  done
  # Hooks are matched by their exact command, which names the node recorded at install.
  node_for=$(sed -n 's/^ENGRAM_NODE=//p' "$CONF/engram.env" 2>/dev/null)
  node_for=${node_for:-${NODE:-node}}
  local runner=${NODE:-$node_for}
  if [ -n "$CLAUDE_BIN" ]; then
    if [ "$DRY" -eq 1 ]; then say "[dry-run] $CLAUDE_BIN mcp remove -s user $MCP_NAME"
    else "$CLAUDE_BIN" mcp remove -s user "$MCP_NAME" >/dev/null 2>&1 && say "- removed Claude MCP server $MCP_NAME" || true; fi
  fi
  if [ -n "$CODEX_BIN" ]; then
    if [ "$DRY" -eq 1 ]; then say "[dry-run] $CODEX_BIN mcp remove $MCP_NAME"
    else "$CODEX_BIN" mcp remove "$MCP_NAME" >/dev/null 2>&1 && say "- removed Codex MCP server $MCP_NAME" || true; fi
  fi
  # The hook scripts come from this checkout, which exists even when ~/Engram/current does not.
  act "$runner" "$SRC/runtime/scripts/install-claude-recall-hook.mjs" --uninstall \
    --settings "$CLAUDE_DIR/settings.json" --runtime "$CURRENT/runtime" --node "$node_for"
  act "$runner" "$SRC/runtime/scripts/install-codex-recall-hook.mjs" --uninstall \
    --hooks "$CODEX_DIR/hooks.json" --runtime "$CURRENT/runtime" --node "$node_for"
  remove "$RELEASES"
  remove "$CURRENT"
  remove "$ENGRAM_HOME/previous"
}

purge() {
  local created_claude created_codex created_la
  created_claude=$(manifest_flag created_claude_dir)
  created_codex=$(manifest_flag created_codex_dir)
  created_la=$(manifest_flag created_launch_agents_dir)
  local parents
  parents=$(sed -nE 's/.*"created_parents": *"([^"]*)".*/\1/p' "$MANIFEST" 2>/dev/null)
  uninstall
  # Memories the extractor wrote carry extractor_model cli/<driver>; Claude Code's own
  # memory files in the same folders are left alone.
  if [ -d "$CLAUDE_DIR/projects" ]; then
    grep -rl --include='*.md' '^  extractor_model: cli/' "$CLAUDE_DIR/projects" 2>/dev/null | while read -r f; do remove "$f"; done
  fi
  remove "$ENGRAM_HOME"
  remove "$CONF"
  [ "$created_claude" = true ] && remove "$CLAUDE_DIR"
  [ "$created_claude" = true ] && [ -z "${CLAUDE_CONFIG_DIR:-}" ] && remove "$HOME/.claude.json"
  [ "$created_codex" = true ] && remove "$CODEX_DIR"
  [ "$created_la" = true ] && remove "$LA"
  local p
  for p in $parents; do
    if [ -d "$HOME/$p" ] && [ -z "$(ls -A "$HOME/$p")" ]; then
      if [ "$DRY" -eq 1 ]; then say "[dry-run] rmdir $HOME/$p"; else rmdir "$HOME/$p" && say "- removed $HOME/$p"; fi
    fi
  done
  return 0
}

case "$MODE" in
  install) install ;;
  uninstall) uninstall; say "uninstalled; kept $VAULT, $DATA and $CONF (use --purge to remove them)" ;;
  purge) purge; say "purged" ;;
esac
