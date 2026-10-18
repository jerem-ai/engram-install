#!/bin/bash
# Alert sink for local installs: the job runners call ENGRAM_NOTIFY with
#   <title> <message> [priority]   or   --resolve <title>
# and this appends one line to $ENGRAM_HOME/logs/alerts.log, which `kg status`
# reads. It never pages or sends anything off the machine.
log="${ENGRAM_HOME:-$HOME/Engram}/logs/alerts.log"
mkdir -p "$(dirname "$log")"
if [ "${1:-}" = "--resolve" ]; then
  printf '%s\tresolved\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${2:-}" >> "$log"
else
  printf '%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${3:-default}" "${1:-}" "${2:-}" >> "$log"
fi
exit 0
