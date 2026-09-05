#!/bin/sh
# nightshift loop — Stop hook. When the session has finished a shift (it touched
# <handoffDir>/NEXT_SESSION), end the interactive claude process so shift-loop.sh
# can start a fresh one. Any other turn: do nothing, exit 0.
# Registered in <project>/.claude/settings.json by `nightshift install`.
REPO="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CFG="$REPO/.claude/nightshift.json"
HANDOFF=$(sed -n 's/.*"handoffDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" 2>/dev/null | head -n 1)
: "${HANDOFF:=handoff}"
MARK="$REPO/$HANDOFF/NEXT_SESSION"
[ -f "$MARK" ] || exit 0
rm -f "$MARK"
# Walk up from this hook to the claude process that owns the session.
p=$PPID
while [ "$p" -gt 1 ]; do
  cmd=$(ps -o command= -p "$p" 2>/dev/null)
  case "$cmd" in
    claude\ *|claude|*/claude\ *|*/claude) echo "shift-stop-hook: ending session pid $p" >&2; kill -TERM "$p"; exit 0 ;;
  esac
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  [ -n "$p" ] || break
done
echo "shift-stop-hook: no claude process found above pid $PPID" >&2
exit 0
