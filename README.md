# claude-plan-runner

Run a written, phased plan to completion with Claude Code agents — unattended,
across usage-limit resets, until the backlog is dry.

Two parts:

| part | where it runs | what it does |
|---|---|---|
| `workflows/execute-phased-plan.js` | inside Claude Code (the `Workflow` tool) | one **unit of work**: implementer agents in isolated git worktrees, an adversarial reviewer per phase, one merge-and-verify agent at a time onto `main`, optional docs phase and completeness critic. Crash-only: agents commit and write `handoff/phase-<id>.md` at milestones; when agents start dying it stops spawning and returns `continueWith` — the args for the next launch. |
| `bin/agent-supervisor.mjs` | outside Claude, under tmux | the **loop**: probe usage → run one unit via headless `claude -p` → persist `continueWith` → repeat. When no phases remain it runs a *groom* unit that turns flags and critic notes into new plan phases or declares the backlog dry. Sleeps to the exact `resetsAt` when a usage window is ≥ 90 % or a unit is killed by the limit. |

## Install into a project

```bash
git clone <this repo> ~/Code/claude-plan-runner
~/Code/claude-plan-runner/install.sh /path/to/project        # symlinks the workflow, writes .claude/agent-supervisor.json
$EDITOR /path/to/project/.claude/agent-supervisor.json       # planFile, tests, devServer, visualUrl
```

The harness resolves named workflows from the project's `.claude/workflows/`
only (not from `~/.claude`), hence the per-project link. A symlink means every
project picks up toolkit updates; use `install.sh <project> --copy` to pin.

## Run

```bash
tmux new -s agent "node ~/Code/claude-plan-runner/bin/agent-supervisor.mjs --repo /path/to/project"
tail -f /path/to/project/handoff/supervisor.log
touch /path/to/project/handoff/STOP     # graceful stop after the current unit
```

State lives in `<handoffDir>/STATE.json` (progress, continuation, history).
Delete it to start over from a groom.

## What the plan file must look like

Markdown with `## Phase <id> — <title>` sections, each containing what to
implement, how to verify it (commands, numbers, screenshots), and what not to
do; plus an evidence section the agents can cite (file:line into specs, source,
measurements). The groomer appends phases in the same format.

## Policy

No approval gates. Agents use their judgment, record deviations in the plan's
"Done" blocks and in handoffs, and keep going; every merge is a commit, so
anything can be reverted. The supervisor stops only for `STOP`, a dry backlog,
or a hard blocker (repeated unreadable units; a conflicted/unbuildable `main`
that one repair unit could not fix). Items needing a human go on a
"Backlog — needs a human" list in the plan.

## Requirements

- Claude Code CLI with the `Workflow` tool (`claude -p` with
  `--dangerously-skip-permissions`; the supervisor passes it).
- `git`, `node` ≥ 20, `tmux`.
- If the project's tests need a dev server, `devServer.command` starts it on
  `devServer.port`; worktree agents start their own on `phases[id].port`.
- Per-project secrets the dev server needs (e.g. `.env.local`) are copied into
  each worktree by the agents; keep them gitignored.

## Lessons baked in (2026-09-03)

- Never resume a Workflow with `resumeFromRunId` to skip finished agents —
  parallel branches reorder calls and everything re-runs. Continue from files.
- Worktrees may be cut from a stale HEAD; agents merge current `main` first.
- Suites passing is not enough for UI work — the mandatory end-of-phase visual
  check exists because goldens passed while glyphs were clipped on the real page.
- `claude -p` streams `rate_limit_event` with per-window utilisation and reset
  epochs; use it, don't regex error text (kept only as fallback).
