#!/usr/bin/env bash
# Install claude-plan-runner into a project.
#   ./install.sh /path/to/project [--link]   (copies by default; --link symlinks for toolkit development)
# Copies (or symlinks, with --link) the workflow into <project>/.claude/workflows/ — the
# harness resolves named workflows per project only — writes a config template if the
# project has none, and gitignores the supervisor's runtime files. Prefer `npx claude-plan-runner init`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${1:?usage: install.sh <project-dir> [--link]}"
MODE="${2:-copy}"
PROJECT="$(cd "$PROJECT" && pwd)"

mkdir -p "$PROJECT/.claude/workflows"
for wf in "$HERE"/workflows/*.js; do
  name="$(basename "$wf")"
  target="$PROJECT/.claude/workflows/$name"
  if [ "$MODE" = "--link" ]; then ln -sfn "$wf" "$target"; echo "linked  $target -> $wf"
  else cp "$wf" "$target"; echo "copied  $target"; fi
done

CFG="$PROJECT/.claude/agent-supervisor.json"
if [ ! -f "$CFG" ]; then cp "$HERE/templates/agent-supervisor.json" "$CFG"; echo "wrote   $CFG (edit planFile, tests, devServer)"; else echo "kept    $CFG"; fi

HANDOFF="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CFG','utf8')).handoffDir||'handoff')")"
GI="$PROJECT/.gitignore"
touch "$GI"
for f in "$HANDOFF/STATE.json" "$HANDOFF/STOP" "$HANDOFF/supervisor.log"; do
  grep -qxF "$f" "$GI" || echo "$f" >> "$GI"
done
echo "gitignored $HANDOFF/{STATE.json,STOP,supervisor.log}"
echo
echo "run:  tmux new -s agent \"node $HERE/bin/agent-supervisor.mjs --repo $PROJECT\""
echo "stop: touch $PROJECT/$HANDOFF/STOP"
