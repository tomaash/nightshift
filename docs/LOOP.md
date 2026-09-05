# The loop — one visible Claude session per shift

`nightshift loop` is the recommended way to run a plan: the same `shift`
workflow, plan and handoffs as the headless supervisor, but every shift runs in
an interactive Claude Code session you can watch (`/workflows`, or just read
along), and every shift starts with a fresh context, pre-briefed by the previous
one. No compaction, no headless `claude -p` stream to decode.

```
nightshift loop              # tmux session "shift-loop"; tmux attach -t shift-loop
nightshift loop --dry-run    # two-session handoff-cycle test, no workflow (~1 min)
nightshift stop              # touch <handoffDir>/STOP: the current session finishes, then the loop exits
nightshift status
```

## The cycle

1. `.claude/nightshift/shift-loop.sh` starts
   `claude --dangerously-skip-permissions "<.claude/nightshift/shift-seed.md>"`.
2. The **SessionStart hook** (in `.claude/settings.json`) finds `handoff.txt`
   in the repo root, injects it as context, and deletes it. The first session
   has no briefing and orients from `git log`, `<handoffDir>/STATE.json` and the
   plan.
3. The session runs **one shift**: `Workflow({ name: '<workflowName>', args:
   continueWith })` with the args from STATE.json, or a groom first (an Agent
   that turns handoff flags and critic notes into the next plan phases). While
   the workflow runs in the background the session does any operator-only steps
   the handoffs ask for.
4. When the workflow completes the session writes STATE.json, memory, a
   summary and — via the `/handoff` skill — `handoff.txt`, then touches
   `<handoffDir>/NEXT_SESSION` and ends its turn.
5. The **Stop hook** (`.claude/nightshift/shift-stop-hook.sh`) sees the marker,
   removes it, and SIGTERMs the `claude` process that owns the session (found by
   walking up from the hook's parent pid). On any other turn it exits 0 and
   does nothing.
6. `shift-loop.sh` sees the session end (exit 143), waits 10 s, checks for
   `<handoffDir>/STOP`, and starts the next session — which is briefed by the
   handoff at step 2.

The loop's own lines go to `<handoffDir>/shift-loop.log`; the session itself is
visible in the tmux pane.

## Stopping

- `nightshift stop` writes `<handoffDir>/STOP`. The loop checks it before each
  session, so the current session finishes its shift first.
- The seed prompt tells the session to touch STOP instead of NEXT_SESSION when
  the groom declares the backlog dry, when `main` is broken after one repair
  attempt, or when a usage limit was not resumed by the harness.
- Ctrl-C twice in the pane ends the session and the loop.

A usage limit pauses the interactive session; Claude Code resumes it at the
reset, so the loop needs no usage probe of its own.

## The dry run

`nightshift loop --dry-run` uses `shift-seed-dryrun.md`: session 1 writes a
17-line `handoff.txt` whose first line contains "DRY RUN 1" and touches
NEXT_SESSION; session 2 sees the injected briefing, prints
`shift-loop dry run: handoff cycle OK`, and touches STOP + NEXT_SESSION. Two
sessions, then the loop exits. Run it once after `install` — it proves the
hooks, the skill and the process handling on your machine without spending a
shift.

## Prerequisites the headless mode does not have

- `jq` (the SessionStart hook uses it).
- The project must already be **trusted** by Claude Code: run `claude` in the
  repo once and accept the trust prompt, or every session exits at that dialog.
  `install` checks this.
- Do not run `loop` and `run` at the same time; both verbs refuse when the other's
  tmux session exists.

## What `install` puts in your repo

| path | what |
|---|---|
| `.claude/nightshift/shift-loop.sh` | the wrapper (POSIX sh) |
| `.claude/nightshift/shift-stop-hook.sh` | the Stop hook |
| `.claude/nightshift/shift-seed.md`, `shift-seed-dryrun.md` | the seed prompts, with plan / handoff dir / workflow name filled in from the config (re-run `install` after changing them) |
| `.claude/settings.json` | SessionStart + Stop hook entries, merged into what is there |
| `.claude/skills/handoff/SKILL.md` | the `/handoff` skill (kept if you have your own) |
| `.gitignore` | `<handoffDir>/NEXT_SESSION`, `<handoffDir>/shift-loop.log`, `handoff.txt` |

Commit the scripts, the seeds, the settings and the skill; they are part of the
project's run configuration.
