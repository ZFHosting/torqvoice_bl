#!/usr/bin/env bash
# Stop hook for /autopilot: refuses to let Claude stop while docs/fork/PROGRESS.md still has
# milestones marked `todo` or `in_progress`.
#
# Safety valves (any one lets Claude stop):
#   - no PROGRESS.md, or no unfinished rows
#   - a file named .claude/STOP exists (touch it to end the run gracefully)
#   - three stop attempts in a row with no progress at all (same ledger, same HEAD, same working tree),
#     so a stuck run can't loop forever
set -u

cat >/dev/null # hook input on stdin isn't needed

dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ledger="$dir/docs/fork/PROGRESS.md"
gitdir=$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null || echo "${TMPDIR:-/tmp}")
state="$gitdir/keep-going-state" # outside the working tree, so writing it is not "progress"
max_stalls=3

[ -f "$dir/.claude/STOP" ] && exit 0
[ -f "$ledger" ] || exit 0

# Rows of the Milestones table look like: | M3 | in_progress | fork/M3-extract | notes |
remaining=$(awk -F'|' '
  /^## Milestones/ { in_table = 1; next }
  /^## / && in_table { exit }
  in_table && NF > 3 {
    id = $2; status = $3
    gsub(/[[:space:]]/, "", id); gsub(/[[:space:]]/, "", status)
    if (id ~ /^[MA][0-9]+$/ && (status == "todo" || status == "in_progress")) printf "%s ", id
  }' "$ledger")
remaining="${remaining% }"

if [ -z "$remaining" ]; then
  rm -f "$state"
  exit 0
fi

# Has anything changed since the last time this hook blocked?
fingerprint=$(
  {
    cat "$ledger"
    git -C "$dir" rev-parse HEAD 2>/dev/null
    git -C "$dir" status --porcelain 2>/dev/null
  } | cksum | awk '{print $1}'
)
last=""; stalls=0
[ -f "$state" ] && read -r last stalls <"$state"
if [ "$fingerprint" = "$last" ]; then stalls=$((stalls + 1)); else stalls=0; fi

if [ "$stalls" -ge "$max_stalls" ]; then
  rm -f "$state"
  echo "keep-going: no progress after $max_stalls stop attempts; letting Claude stop. Unfinished: $remaining" >&2
  exit 0
fi
echo "$fingerprint $stalls" >"$state"

next="${remaining%% *}"
printf '{"decision":"block","reason":"Not finished: %s still todo or in progress in docs/fork/PROGRESS.md. Re-read PROGRESS.md, update Current step, and continue with %s (or the next milestone that is not blocked) following .claude/commands/autopilot.md. If it truly needs a human, mark it blocked in PROGRESS.md with what you need, then move on."}\n' "$remaining" "$next"
exit 0
