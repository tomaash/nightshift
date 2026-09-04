# claude-plan-runner

Run a written, phased plan to completion with Claude Code agents — **unattended,
across usage-limit resets, until the backlog is dry.**

You write the plan. It runs implementer agents in isolated git worktrees, has an
adversarial reviewer try to break each phase, merges one phase at a time onto
`main` with the full test suite and a visual check, then grooms its own backlog
from the flags it raised — and sleeps through your 5-hour usage window instead
of dying in the middle of it.

```
plan ──▶ [supervisor loop, outside Claude, under tmux]
           │  probe usage → sleep to reset if ≥ 90 %
           │  one unit of work = one headless `claude -p` running the workflow:
           │     implement (worktree) → refute → fix → merge+verify → docs → critic
           │  persist continueWith → repeat
           │  no phases left → groom: flags + critic → new phases, or "dry"
           └─ stop: STOP file · backlog dry · hard blocker
```

## Install — two ways

Prerequisites: [Claude Code](https://code.claude.com) CLI signed in, `git`,
Node ≥ 20, `tmux` (recommended). Your project must be a git repo.

### A. As a Claude Code plugin (recommended — one command, stays updated)

Inside Claude Code:

```
/plugin marketplace add tomaash/claude-plan-runner
/plugin install claude-plan-runner@tomaash
/plan-runner
```

The plugin provides the workflow (`claude-plan-runner:execute-phased-plan`) and
the `/plan-runner` skill, which writes your project's config, checks your plan,
runs the doctor and hands you the tmux command to start the supervisor. Same
thing non-interactively:

```bash
claude plugin marketplace add tomaash/claude-plan-runner
claude plugin install claude-plan-runner@tomaash
```

### B. As an npm-style CLI (no plugin; the workflow is copied into your repo)

```bash
cd your-project
npx github:tomaash/claude-plan-runner init          # copies the workflow + writes .claude/agent-supervisor.json
npx github:tomaash/claude-plan-runner doctor        # checks claude, Workflow tool, usage signal, config
$EDITOR .claude/agent-supervisor.json               # planFile, tests, devServer, visualUrl
tmux new -s agent "npx github:tomaash/claude-plan-runner run"
```

Prefer a pinned install: `npm i -D github:tomaash/claude-plan-runner`, then
`npx claude-plan-runner …`. Re-run `init` after upgrading (it copies).

### Run, watch, stop

```bash
tail -f handoff/supervisor.log
npx claude-plan-runner status
npx claude-plan-runner stop        # graceful: finishes the current unit
```

With the plugin installed the same CLI lives at
`node ~/.claude/plugins/<…>/claude-plan-runner/bin/cli.mjs` — `/plan-runner`
prints the exact path for your machine.

## What you write: the plan

A Markdown file (default `PLAN.md`) with one section per phase:

```markdown
## Phase 3a — Wrapping mode
**Implement** … concrete steps, the files/functions to touch, what to copy from where.
**Verification** … commands to run, numbers to hit, what to screenshot.
**Do not** … anti-patterns for this phase.
```

plus an evidence section the agents can cite (specs, source file:line,
measurements). The more the plan states *what correct looks like*, the less the
agents guess. See [`docs/PLAN-FORMAT.md`](docs/PLAN-FORMAT.md) for the full
contract and a worked example.

## What you configure: `.claude/agent-supervisor.json`

| key | meaning |
|---|---|
| `planFile`, `contextFiles` | the plan and any files every agent must read first |
| `devServer.command` / `.port` | how to start your dev server; the supervisor keeps it up on `main` for the merge agent; worktree agents start their own on `portBase+` |
| `tests`, `testsTakeBase` | the suites the merge agent runs on `main`; `--base http://localhost:<port>` is appended when `testsTakeBase` |
| `buildCommand` | used to detect an unbuildable `main` (triggers a repair unit) |
| `visualUrl` | the page every phase must look at before it is done |
| `docs` | an optional docs phase run on `main` after each batch |
| `model`, `maxUtil`, `groomBatch`, `maxUnreadable` | Opus by default; sleep threshold; phases per groom; hard-blocker threshold |

## How a unit of work runs (the workflow)

`execute-phased-plan` (installed at `.claude/workflows/`) takes a phase map and:

1. **Implements** each phase in a fresh git worktree on its own branch (parallel
   phases concurrently, serial phases one after another). Agents merge current
   `main` first, symlink `node_modules`, copy `.env.local`, start their own dev
   server, run the suites against it, do the visual check, commit at every
   milestone and write `handoff/phase-<id>.md`.
2. **Refutes**: an adversarial reviewer reads the diff and the handoff and tries
   to disprove it against the plan's evidence. Fail → one fix pass → re-review.
3. **Merges** one branch at a time onto `main`, runs the full suite there plus
   the visual check, resolves conflicts, removes the worktree.
4. **Docs + critic**: optional docs phase, then a completeness critic that lists
   what is unverified, which flags are real, and what a human should look at.

Crash-only: if agents start dying (usage limit), the workflow stops spawning and
returns `continueWith` — the args for the next launch. The supervisor persists
it. Never resume with `resumeFromRunId`; relaunch with `continueWith`.

## Budget awareness

Every headless `claude -p` stream carries `rate_limit_event` records with
per-window utilisation and reset time (`five_hour`, `seven_day`). Before each
unit the supervisor probes (one cheap haiku call) and, if a window is at or
above `maxUtil`, sleeps until its `resetsAt` + 3 min. A unit killed by the limit
anyway sleeps to the reset reported in its own stream. Nothing is lost either
way: work is committed at milestones.

## Policy: it does not ask

No approval gates. Agents use their judgment, record deviations in the plan's
"Done" blocks and handoffs, and keep going — every merge is a commit, so
anything can be reverted. The supervisor stops only for:

- `handoff/STOP` (or `… stop`),
- the groomer declaring the backlog dry,
- a hard blocker: `maxUnreadable` units in a row without a readable result, or
  a conflicted/unbuildable `main` that one repair unit could not fix.

Items that need a human — product decisions, dead URLs, credentials, hardware —
go on a **"Backlog — needs a human"** list in the plan and the run moves on.

## Files it creates

| path | what |
|---|---|
| `.claude/workflows/execute-phased-plan.js` | the workflow (commit it) |
| `.claude/agent-supervisor.json` | config (commit it) |
| `handoff/phase-<id>.md` | per-phase handoffs written by agents (commit them — they are the project memory) |
| `handoff/STATE.json`, `supervisor.log`, `STOP` | runtime state (gitignored) |

## Lessons baked in

- **Resume caching is unreliable** across parallel branches — continue from
  files, never from a replayed run.
- **Worktrees may be cut from a stale HEAD** — agents merge `main` first.
- **Suites passing is not enough for UI** — the mandatory visual check exists
  because pixel goldens passed while glyphs were clipped on the real page.
- **Reviewers catch what implementers believe** — the refute stage found false
  "verified" claims in a third of phases on the first real run.
- **Kill the spawn, not the work** — two dead agents in a row means the account
  limit; stop spawning, return the continuation, let the outer loop sleep.

## Also usable without the supervisor

Inside an interactive Claude Code session, say "use a workflow" and:

```
Workflow({ name: 'claude-plan-runner:execute-phased-plan',   // or 'execute-phased-plan' after `init`
           args: { repo: '/abs/path', planFile: 'PLAN.md', serial: ['1','2'], parallel: ['3'], phases: {...}, tests: [...], mainBase: 'http://localhost:5200' } })
```

The full `args` contract is documented at the top of the workflow file.

## Repository layout

```
.claude-plugin/plugin.json, marketplace.json   # Claude Code plugin + single-plugin marketplace
workflows/execute-phased-plan.js               # the Workflow-tool script (plugin: claude-plan-runner:execute-phased-plan)
skills/plan-runner/SKILL.md                    # /plan-runner onboarding skill
bin/cli.mjs, bin/agent-supervisor.mjs          # init/run/stop/status/doctor; the outer loop
templates/agent-supervisor.json                # per-project config template
docs/PLAN-FORMAT.md                            # how to write a plan agents can execute
```

## License

MIT. Built on 2026-09-03 while porting a display renderer to parity with two
incumbent players — ten phases, 40 agents, one overnight run.
