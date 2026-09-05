#!/bin/sh
# nightshift loop — one fresh, VISIBLE Claude Code session per shift, forever.
#
#   .claude/nightshift/shift-loop.sh [seed.md]                 # in the tmux pane you want to watch
#   .claude/nightshift/shift-loop.sh .claude/nightshift/shift-seed-dryrun.md   # handoff-cycle test, no workflow
#
# Each iteration starts an interactive `claude` with the seed prompt
# (shift-seed.md). The session runs one shift workflow, writes handoff.txt (the
# SessionStart hook injects it into the next session and deletes it), touches
# <handoffDir>/NEXT_SESSION and ends its turn; the Stop hook (shift-stop-hook.sh)
# then terminates the session and this loop starts the next one. `nightshift stop`
# (touch <handoffDir>/STOP) or Ctrl-C twice ends the loop. A usage limit just
# pauses the session until the harness resumes it.
#
# Installed by `nightshift install` into <project>/.claude/nightshift/.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO="${CLAUDE_PROJECT_DIR:-$(cd "$HERE/../.." && pwd)}"
cd "$REPO" || exit 1
CFG="$REPO/.claude/nightshift.json"
HANDOFF=$(sed -n 's/.*"handoffDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" 2>/dev/null | head -n 1)
: "${HANDOFF:=handoff}"
HANDOFF="$REPO/$HANDOFF"
SEED="${1:-$HERE/shift-seed.md}"
[ -f "$SEED" ] || { echo "shift-loop: seed not found: $SEED" >&2; exit 1; }
mkdir -p "$HANDOFF"
LOG="$HANDOFF/shift-loop.log"
say() { line="shift-loop: $(date '+%F %T') $*"; echo "$line"; echo "$line" >> "$LOG"; }
say "loop started in $REPO (seed $(basename "$SEED"), log $LOG)"
while :; do
  if [ -f "$HANDOFF/STOP" ]; then say "$HANDOFF/STOP present — not starting another session"; exit 0; fi
  rm -f "$HANDOFF/NEXT_SESSION"
  say "starting a session"
  claude --dangerously-skip-permissions "$(cat "$SEED")"
  say "session ended (exit $?) — next one in 10 s"
  sleep 10
done
