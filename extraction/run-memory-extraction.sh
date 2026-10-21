#!/bin/bash
ENGRAM_RUN_LOCK_FILE=""
# Per-install settings (~/.config/engram/engram.env, read by the runtime's helper)
# fill gaps; with no file (Jeremy's machines) every default below is unchanged.
ENGRAM_ENV_HELPER="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../runtime/scripts/engram-env.sh"
# shellcheck source=../runtime/scripts/engram-env.sh
[ -r "$ENGRAM_ENV_HELPER" ] && . "$ENGRAM_ENV_HELPER" && engram_env_load
ENGRAM_NOTIFY_CMD=${ENGRAM_CONF_ENGRAM_NOTIFY:-$HOME/bin/engram-notify.sh}
cleanup_run_lock() {
  if declare -F engram_release_run_lock >/dev/null; then
    engram_release_run_lock
  fi
  return 0
}
trap 'rc=$?; cleanup_run_lock; if [ "$rc" -ne 0 ]; then "$ENGRAM_NOTIFY_CMD" "Engram: run-memory-extraction.sh FAILED" "exit $rc on $(hostname -s) — check logs" high || true; else "$ENGRAM_NOTIFY_CMD" --resolve "Engram: run-memory-extraction.sh FAILED" || true; fi; exit "$rc"' EXIT  # engram-alert
# Recurring memory extraction — processes new/grown sessions only (state-gated,
# idempotent). New memories land in project memory dirs, then the mirror job
# projects them into vault/Memory for Obsidian Sync + the KG.
#
# BACKEND. ENGRAM_BACKEND (or ENGRAM_EXTRACT_BACKEND in engram.env) picks it: cli
# (the user's own logged-in claude or codex), api, ollama, or openai, the operator
# lane in operator-lane.sh and the default when nothing is set.
#
# Why the swap: on the 2026-08-07/08 bakeoff, measured with a certified semantic
# judge, qwen3.6:27b scored 0.673 durable-claim coverage on the three-product
# prompt and 0.150 on the prompt this job actually ships, with 50% and 0%
# final-decision-after-reversal accuracy. GPT-5.5 scored 0.985 coverage, 126/126
# precision, and 6/6 on reversals, but its shared Codex quota repeatedly stopped
# the production job. Receipts under the engram workspace at
# .context/spikes/judge_rescore_20260808.json and judge_precision_20260808.json.
#
# There is deliberately no provider fallback. A silent model change can write
# bad durable memories that nobody notices. If Claude is unreachable, this job
# fails loudly and the EXIT trap above notifies. To use ollama deliberately,
# set ENGRAM_BACKEND=ollama.
#
# SCHEDULING (changed 2026-08-01). This used to be StartCalendarInterval 03:30 on
# the laptop, which silently missed whole days whenever the laptop was asleep or
# off at that moment: 07-25, 07-26, 07-30 never ran at all, and 07-27/28/29 fired
# around 12:30 on wake instead. The plist now ticks HOURLY and this gate decides
# whether there is anything to do, so a missed night is picked up on the next wake
# rather than skipped until someone notices.
#   - inside the off-hours window  -> run (normal case)
#   - stale beyond MAX_STALE_HOURS -> run regardless of clock (catch-up)
#   - otherwise                    -> exit 0 quietly
# Off-hours originally mattered because ollama SERIALIZES per model and a daytime
# run would block interactive work on jarvis. That reason is gone with the
# subscription lane, but the window is kept: subscription rate limits under a
# full nightly batch are UNMEASURED, so running while nobody is using the
# subscription interactively is still the safer default.
set -euo pipefail

# Runs from its own directory: a release under ~/Services/engram-pipeline or a
# dev checkout, never a hard-coded path. ENGRAM_PY overrides the interpreter.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

BACKEND="${ENGRAM_BACKEND:-${ENGRAM_CONF_ENGRAM_EXTRACT_BACKEND:-openai}}"   # openai | ollama | cli | api
# The operator lane: an OpenAI-compatible gateway reached over ssh, and the operator's
# ollama host. A public install does not carry operator-lane.sh and never selects it.
if [ "$BACKEND" != "cli" ] && [ "$BACKEND" != "api" ] && [ -r "$SCRIPT_DIR/operator-lane.sh" ]; then
  # shellcheck source=operator-lane.sh
  . "$SCRIPT_DIR/operator-lane.sh"
elif [ "$BACKEND" = "openai" ]; then
  echo "[$(date '+%F %T')] ERROR: backend openai needs operator-lane.sh, which this install does not carry; set ENGRAM_EXTRACT_BACKEND=cli" >&2
  exit 64
fi
OLLAMA_URL="${ENGRAM_OLLAMA_URL:-${OPERATOR_OLLAMA_URL:-http://127.0.0.1:11434}}"
NUM_CTX="${ENGRAM_NUM_CTX:-131072}"   # 32768 silently drops the system prompt on ~20% of sessions
# All four PRODUCT_SPEC adapters (2026-08-12). Adapters whose source dirs are
# absent on this machine no-op, so one value serves laptop and mini.
RUNTIMES="${ENGRAM_RUNTIMES:-claude-code,codex,hermes,openclaw}"
# Only sessions written in the last N days. Installs set 7 so the first run does not mine
# a month of history on the user's subscription in one hour; empty means every session.
SINCE_DAYS="${ENGRAM_SINCE_DAYS:-${ENGRAM_CONF_ENGRAM_SINCE_DAYS:-}}"
case "$SINCE_DAYS" in
  ""|*[!0-9]*) [ -z "$SINCE_DAYS" ] || { echo "[$(date '+%F %T')] ERROR: ENGRAM_SINCE_DAYS must be a whole number of days, got: $SINCE_DAYS" >&2; exit 64; } ;;
esac
if [ "$BACKEND" = "ollama" ]; then
  MODEL="${ENGRAM_MODEL:-qwen3.6:27b}"
elif [ "$BACKEND" = "cli" ] || [ "$BACKEND" = "api" ]; then
  MODEL="${ENGRAM_MODEL:-}"   # empty: the CLI's own default, or the extractor's API default
else
  MODEL="${ENGRAM_MODEL:-$OPERATOR_LANE_MODEL}"
fi
# Local transcript archive (installs only): engram.env ENGRAM_ARCHIVE_DIR, `off` to
# disable. Runs every hour, before the off-hours gate, so the copy never waits on
# extraction. Unset on Jeremy's machines, whose transcripts go to the NAS instead.
ARCHIVE_DIR="${ENGRAM_ARCHIVE_DIR:-${ENGRAM_CONF_ENGRAM_ARCHIVE_DIR:-}}"
if [ -n "$ARCHIVE_DIR" ] && [ "$ARCHIVE_DIR" != off ]; then
  "${ENGRAM_PY:-$SCRIPT_DIR/venv/bin/python}" "$SCRIPT_DIR/archive_local.py" --archive "$ARCHIVE_DIR"
fi

OFF_HOURS_START=${ENGRAM_OFF_START:-3}
OFF_HOURS_END=${ENGRAM_OFF_END:-6}    # exclusive; 3..5 inclusive
MAX_STALE_HOURS=${ENGRAM_MAX_STALE:-26}

STATE_DIR="${ENGRAM_STATE_DIR:-${ENGRAM_CONF_ENGRAM_STATE_DIR:-$HOME/.local/share/memory-extraction}}"
MARKER="$STATE_DIR/last-success"
mkdir -p "$STATE_DIR"

hour=$(date +%-H)
in_window=0
[ "$hour" -ge "$OFF_HOURS_START" ] && [ "$hour" -lt "$OFF_HOURS_END" ] && in_window=1

stale=1
if [ -e "$MARKER" ]; then
  age_h=$(( ( $(date +%s) - $(stat -f %m "$MARKER") ) / 3600 ))
  [ "$age_h" -lt "$MAX_STALE_HOURS" ] && stale=0
fi

if [ "$in_window" -eq 0 ] && [ "$stale" -eq 0 ]; then
  exit 0   # not off-hours and not overdue — nothing to do, stay quiet
fi

# Deliberate snooze (2026-08-17): an epoch in this file pauses runs without
# unloading launchd jobs. The heartbeat reads the same file and reports
# "SNOOZED" instead of staleness. Used when the lane is knowingly down
# (auth revoked, deadline crunch) so hourly failures don't page anyone.
SNOOZE_FILE="$HOME/.config/engram/extraction-snooze-until"
if [ -r "$SNOOZE_FILE" ]; then
  snooze_until=$(tr -cd '0-9' < "$SNOOZE_FILE")
  if [ -n "$snooze_until" ] && [ "$(date +%s)" -lt "$snooze_until" ] 2>/dev/null; then
    exit 0   # snoozed — quiet, no preflight, no alert
  fi
fi

# The hourly catch-up job can fire while a manually started recovery is still
# running. On 2026-08-19, three mini runs overlapped and raced the extraction and
# digest state files. Hold one host-local lock across preflight, extraction,
# digests, and the last-success write. An active owner is a healthy no-op; a dead
# owner's stale lock is reclaimed by the helper.
# shellcheck source=run-lock.sh
source "$SCRIPT_DIR/run-lock.sh"
if engram_acquire_run_lock "$STATE_DIR/run.lock"; then
  :
else
  lock_rc=$?
  if [ "$lock_rc" -eq 75 ]; then
    echo "[$(date '+%F %T')] memory-extraction already running; skipping overlapping invocation"
    exit 0
  fi
  exit "$lock_rc"
fi
if [ "$in_window" -eq 0 ]; then
  if [ -n "${age_h:-}" ]; then
    last_success="${age_h}h ago"
  else
    last_success="never"
  fi
  echo "[$(date '+%F %T')] CATCH-UP run (last success: $last_success, outside off-hours)"
fi

PY="${ENGRAM_PY:-$SCRIPT_DIR/venv/bin/python}"
EXTRACT="$SCRIPT_DIR/extract-memories.py"

# A bounded cutover can request a source-bound runtime receipt. The normal
# scheduled job leaves ENGRAM_RUNTIME_RECEIPT_PATH unset and follows its prior
# behavior. When requested, every binding is mandatory and byte verification
# completes before the route preflight or extractor can run.
if [ -n "${ENGRAM_RUNTIME_RECEIPT_PATH:-}" ]; then
  required_runtime_bindings=(
    ENGRAM_RUNTIME_REVISION
    ENGRAM_RUNTIME_REPOSITORY_SLUG
    ENGRAM_RUNTIME_TARGET_ID
    ENGRAM_RUNTIME_WORKSPACE_ID
    ENGRAM_RUNTIME_SESSION_ID
    ENGRAM_RUNTIME_MARKER_ID
    ENGRAM_RUNTIME_RUNNER_SHA256
    ENGRAM_RUNTIME_EXTRACTOR_SHA256
  )
  for runtime_binding in "${required_runtime_bindings[@]}"; do
    if [ -z "${!runtime_binding:-}" ]; then
      echo "[$(date '+%F %T')] ERROR: $runtime_binding is required for a runtime receipt" >&2
      exit 64
    fi
  done
  "$PY" "$SCRIPT_DIR/runtime_receipt.py" \
    --revision "$ENGRAM_RUNTIME_REVISION" \
    --repository-slug "$ENGRAM_RUNTIME_REPOSITORY_SLUG" \
    --target-id "$ENGRAM_RUNTIME_TARGET_ID" \
    --workspace-id "$ENGRAM_RUNTIME_WORKSPACE_ID" \
    --session-id "$ENGRAM_RUNTIME_SESSION_ID" \
    --marker-id "$ENGRAM_RUNTIME_MARKER_ID" \
    --runner "$0" \
    --runner-sha256 "$ENGRAM_RUNTIME_RUNNER_SHA256" \
    --extractor "$EXTRACT" \
    --extractor-sha256 "$ENGRAM_RUNTIME_EXTRACTOR_SHA256" \
    --output "$ENGRAM_RUNTIME_RECEIPT_PATH"
  echo "[$(date '+%F %T')] runtime receipt: $ENGRAM_RUNTIME_RECEIPT_PATH"
fi

if [ "$BACKEND" = "ollama" ]; then
  echo "[$(date '+%F %T')] memory-extraction start (backend=ollama model=$MODEL num_ctx=$NUM_CTX)"
  "$PY" "$EXTRACT" --backend ollama --ollama-url "$OLLAMA_URL" --model "$MODEL" --num-ctx "$NUM_CTX" --runtimes "$RUNTIMES" ${SINCE_DAYS:+--since-days "$SINCE_DAYS"}
elif [ "$BACKEND" = "cli" ] || [ "$BACKEND" = "api" ]; then
  # The user's own subscription (cli: their logged-in claude or codex, chosen by
  # ENGRAM_CLI_DRIVER) or their Anthropic key (api). The extractor preflights the cli
  # driver and exits 5 before any write when it cannot answer. No fallback.
  echo "[$(date '+%F %T')] memory-extraction start (backend=$BACKEND${MODEL:+ model=$MODEL})"
  "$PY" "$EXTRACT" --backend "$BACKEND" ${MODEL:+--model "$MODEL"} --runtimes "$RUNTIMES" ${SINCE_DAYS:+--since-days "$SINCE_DAYS"}
else
  operator_lane_extract
fi
touch "$MARKER"   # only reached when the python above exited 0

# Claim backfill (October 20, OBSERVE.md 15e): typed claims for memory notes written
# before the extractor wrote claims, or by an agent's own memory tool. Runs on the
# operator lane, or anywhere ENGRAM_CLAIM_BACKFILL=on; `off` disables it. Capped at
# ENGRAM_CLAIM_BACKFILL_CALLS model calls a run; a failure never fails extraction.
# The public install export does not carry backfill_claims.py, so it never runs there.
CLAIM_BACKFILL="${ENGRAM_CLAIM_BACKFILL:-}"
if [ -r "$SCRIPT_DIR/backfill_claims.py" ] \
    && { [ "$CLAIM_BACKFILL" = on ] || { [ -z "$CLAIM_BACKFILL" ] && [ "$BACKEND" = openai ]; }; }; then
  "$PY" "$SCRIPT_DIR/backfill_claims.py" --limit "${ENGRAM_CLAIM_BACKFILL_CALLS:-60}" \
    || echo "[$(date '+%F %T')] WARN: claim backfill exited $?"
fi
# Note claims (October 20, OBSERVE.md 15g): typed claims for session logs, topics, ideas and
# conversations, kept in note-claims.jsonl because those notes take appended footers only.
# Same lanes as the backfill; ENGRAM_NOTE_CLAIMS_RUN=off disables it. Runs before the review
# so tonight's claims are judged tonight. A failure never fails extraction.
NOTE_CLAIMS_RUN="${ENGRAM_NOTE_CLAIMS_RUN:-}"
if [ -r "$SCRIPT_DIR/note_claims.py" ] \
    && { [ "$NOTE_CLAIMS_RUN" = on ] || { [ -z "$NOTE_CLAIMS_RUN" ] && [ "$BACKEND" = openai ]; }; }; then
  "$PY" "$SCRIPT_DIR/note_claims.py" --limit "${ENGRAM_NOTE_CLAIMS_CALLS:-40}" \
    || echo "[$(date '+%F %T')] WARN: note claims exited $?"
fi
# Per-claim review (October 20, OBSERVE.md 15f): a verdict for each typed claim, judged on
# its own passages, appended to claim-verdicts.jsonl (the hourly archive job copies it to
# the mini). Same lanes as the backfill; ENGRAM_CLAIM_REVIEW=off disables it. Capped at
# ENGRAM_CLAIM_REVIEW_CALLS model calls a run; a failure never fails extraction.
CLAIM_REVIEW="${ENGRAM_CLAIM_REVIEW:-}"
if [ -r "$SCRIPT_DIR/review_claims.py" ] \
    && { [ "$CLAIM_REVIEW" = on ] || { [ -z "$CLAIM_REVIEW" ] && [ "$BACKEND" = openai ]; }; }; then
  "$PY" "$SCRIPT_DIR/review_claims.py" --limit "${ENGRAM_CLAIM_REVIEW_CALLS:-120}" \
    || echo "[$(date '+%F %T')] WARN: claim review exited $?"
fi
echo "[$(date '+%F %T')] memory-extraction done"
