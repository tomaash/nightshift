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
MODEL=$(sed -n 's/.*"model"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" 2>/dev/null | head -n 1)
: "${MODEL:=opus}"
HANDOFF="$REPO/$HANDOFF"
MAXUTIL=$(sed -n 's/.*"maxUtil"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p' "$CFG" 2>/dev/null | head -n 1)
: "${MAXUTIL:=0.9}"
PROBE_MIN=$(sed -n 's/.*"probeMinutes"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$CFG" 2>/dev/null | head -n 1)
: "${PROBE_MIN:=10}"
SEED="${1:-$HERE/shift-seed.md}"
[ -f "$SEED" ] || { echo "shift-loop: seed not found: $SEED" >&2; exit 1; }
mkdir -p "$HANDOFF"
LOG="$HANDOFF/shift-loop.log"
USAGE="$HERE/usage.mjs"
say() { line="shift-loop: $(date '+%F %T') $*"; echo "$line"; echo "$line" >> "$LOG"; }
say "loop started in $REPO (seed $(basename "$SEED"), log $LOG)"

# Usage watchdog: probes every PROBE_MIN minutes; at MAXUTIL it writes $HANDOFF/CONTROL.json {windDown:true} and the
# running shift winds down gracefully (agents commit + hand off at their next milestone, the workflow stops spawning).
WATCHDOG_PID=
if [ -f "$USAGE" ]; then
  node "$USAGE" watch --max "$MAXUTIL" --every "$PROBE_MIN" --handoff "$HANDOFF" --repo "$REPO" >> "$HANDOFF/watchdog.log" 2>&1 &
  WATCHDOG_PID=$!
  say "usage watchdog pid $WATCHDOG_PID (wind down at maxUtil=$MAXUTIL, probe every $PROBE_MIN min, log $HANDOFF/watchdog.log)"
fi
cleanup() { [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null; }
trap 'cleanup; exit 0' INT TERM EXIT

while :; do
  if [ -f "$HANDOFF/STOP" ]; then say "$HANDOFF/STOP present — not starting another session"; exit 0; fi
  # Wait for usage headroom before spending a fresh session on a shift. `usage.mjs wait` sleeps to the fullest
  # window's reset (+3 min), re-probes, and clears the windDown flag in CONTROL.json when it returns.
  if [ -f "$USAGE" ]; then
    say "checking usage before the session"
    node "$USAGE" wait --max "$MAXUTIL" --control "$HANDOFF/CONTROL.json" --repo "$REPO" 2>&1 | while IFS= read -r l; do say "$l"; done
    if [ -f "$HANDOFF/STOP" ]; then say "$HANDOFF/STOP present — not starting another session"; exit 0; fi
  fi
  rm -f "$HANDOFF/NEXT_SESSION"
  say "starting a session (model $MODEL)"
  claude --model "$MODEL" --dangerously-skip-permissions "$(cat "$SEED")"
  say "session ended (exit $?) — next one in 10 s"
  sleep 10
done
