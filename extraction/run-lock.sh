#!/bin/bash

# Portable, host-local single-run guard for the extraction pipeline. The lock
# file lives beside extraction state, so laptop and mini runs remain independent.

engram_acquire_run_lock() {
  local lock_file="$1"
  local holder=""
  local owner_pid="${BASHPID:-$$}"

  if (set -C; printf '%s\n' "$owner_pid" > "$lock_file") 2>/dev/null; then
    ENGRAM_RUN_LOCK_FILE="$lock_file"
    ENGRAM_RUN_LOCK_PID="$owner_pid"
    return 0
  fi

  holder=$(cat "$lock_file" 2>/dev/null || true)
  case "$holder" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "$holder" 2>/dev/null; then
        return 75
      fi
      ;;
  esac

  # The recorded owner is gone (or the file is malformed). Remove only this
  # exact lock, then race once to replace it atomically. If another process wins,
  # treat that as an active owner rather than disturbing its lock.
  rm -f -- "$lock_file"
  if (set -C; printf '%s\n' "$owner_pid" > "$lock_file") 2>/dev/null; then
    ENGRAM_RUN_LOCK_FILE="$lock_file"
    ENGRAM_RUN_LOCK_PID="$owner_pid"
    return 0
  fi
  return 75
}

engram_release_run_lock() {
  local lock_file="${ENGRAM_RUN_LOCK_FILE:-}"
  local holder=""
  [ -n "$lock_file" ] || return 0
  holder=$(cat "$lock_file" 2>/dev/null || true)
  if [ "$holder" = "${ENGRAM_RUN_LOCK_PID:-${BASHPID:-$$}}" ]; then
    rm -f -- "$lock_file"
  fi
  ENGRAM_RUN_LOCK_FILE=""
  ENGRAM_RUN_LOCK_PID=""
}
