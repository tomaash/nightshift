# nightshift

Hand Claude Code a written plan and go to sleep.

nightshift runs the plan **unattended, across usage-limit resets, until the
backlog is dry**: implementer agents in isolated git worktrees, an adversarial
reviewer that tries to break each phase, one merge at a time onto `main` with
the full test suite and a visual check, then it grooms its own backlog from the
flags it raised. When your 5-hour window fills up it sleeps to the reset and
clocks back in.

```
plan ──▶ [nightshift loop, in tmux: one visible Claude session per shift]
           │  session starts pre-briefed (handoff.txt injected by a SessionStart hook)
           │  one shift = the `shift` workflow, watched live in /workflows:
           │     implement (worktree) → refute → fix → merge+verify → docs → critic
           │  no phases left → groom: flags + critic → new phases, or "dry"
           │  write STATE.json + handoff.txt → touch NEXT_SESSION → Stop hook ends the session
           └─ next session, fresh context · clock out: STOP file · backlog dry · hard blocker
```

Two modes, same workflow and plan: **`loop`** (recommended — watch the agents,
fresh context every shift, usage limits just pause the session) and **`run`**
(headless supervisor: `claude -p` shifts, usage probing, sleeps to the reset).

## Install, run

Prerequisites: [Claude Code](https://code.claude.com) signed in, `git`, Node ≥ 20,
`tmux`. Your project must be a git repo with a plan (see below).

**Inside Claude Code** (plugin — stays updated):

```
/plugin marketplace add tomaash/nightshift
/plugin install nightshift@tomaash
/nightshift install
/nightshift loop --dry-run     # 1-minute handoff-cycle test
/nightshift loop
```

**From a terminal** (no plugin — the workflow is copied into your repo):

```bash
npx github:tomaash/nightshift install
npx github:tomaash/nightshift loop --dry-run
npx github:tomaash/nightshift loop
```

(Not on npm — the GitHub repo is the distribution. `npm i -g github:tomaash/nightshift`
gives you a plain `nightshift` command.)

`install` writes `.claude/nightshift.json`, finds your plan (`PLAN.md`, or the
single `*PLAN*.md` at the root), puts the loop scripts and seed prompts in
`.claude/nightshift/`, registers the SessionStart + Stop hooks in
`.claude/settings.json`, copies the `/handoff` skill, gitignores the runtime
files and checks the prerequisites (claude, git, tmux, jq, Workflow tool,
usage signal, project trusted). Fix any `MISS` line, glance at the config
(tests, dev server, visual URL), then `loop`.

`loop` starts one interactive Claude session per shift, forever, in a tmux
session named `shift-loop`, and returns. Each session runs one shift, writes
`handoff.txt`, touches `handoff/NEXT_SESSION`; the Stop hook ends the session
and the loop starts the next one pre-briefed. `loop --dry-run` runs the
two-session handoff test without a workflow. Details: [`docs/LOOP.md`](docs/LOOP.md).

`run` is the headless fallback: the supervisor in a tmux session named
`nightshift`, `claude -p` shifts, usage probing and sleeping to the reset.

Watch, stop, check (either mode):

```bash
tmux attach -t shift-loop              # loop: the live session   (Ctrl-b d detaches)
tail -f handoff/shift-loop.log         # loop: session starts/ends
tail -f handoff/nightshift.log         # run:  the supervisor log (or tmux attach -t nightshift)
npx github:tomaash/nightshift stop     # graceful — the current shift/session finishes first
npx github:tomaash/nightshift status   # which mode is running, what is queued
```

(`/nightshift stop` and `/nightshift status` do the same from inside Claude Code.)

## What you write: the plan

A Markdown file with one section per phase:

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

## What you configure: `.claude/nightshift.json`

| key | meaning |
|---|---|
| `planFile`, `contextFiles` | the plan and any files every agent must read first |
| `devServer.command` / `.port` | how to start your dev server; nightshift keeps it up on `main` for the merge agent; worktree agents start their own on `portBase+` |
| `tests`, `testsTakeBase` | the suites the merge agent runs on `main`; `--base http://localhost:<port>` is appended when `testsTakeBase` |
| `buildCommand` | used to detect an unbuildable `main` (triggers a repair shift) |
| `visualUrl` | the page every phase must look at before it is done |
| `docs` | an optional docs phase run on `main` after each batch |
| `model`, `maxUtil`, `groomBatch`, `maxUnreadable` | Opus by default; sleep threshold; phases per groom; hard-blocker threshold |
| `workflowName` | `shift` (copied) or `nightshift:shift` (plugin) — `install` sets it and bakes it into the loop's seed prompt |

## One shift (the `shift` workflow)

A shift takes a phase map and:

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
returns `continueWith` — the args for the next shift. The loop session (or the
supervisor) persists it in `handoff/STATE.json`. Never resume with
`resumeFromRunId`; relaunch with `continueWith`.

## Budget awareness

In `loop` mode a usage limit simply pauses the interactive session and Claude
Code resumes it at the reset; nothing to configure. In `run` mode: every headless `claude -p` stream carries `rate_limit_event` records with
per-window utilisation and reset time (`five_hour`, `seven_day`). Before each
shift the supervisor probes (one cheap haiku call) and, if a window is at or
above `maxUtil`, sleeps until its `resetsAt` + 3 min. A shift killed by the
limit anyway sleeps to the reset reported in its own stream. Nothing is lost
either way: work is committed at milestones.

## Policy: it does not ask

No approval gates. Agents use their judgment, record deviations in the plan's
"Done" blocks and handoffs, and keep going — every merge is a commit, so
anything can be reverted. nightshift clocks out only for:

- `handoff/STOP` (`nightshift stop`) — the loop checks it before each session,
- the groomer declaring the backlog dry,
- a hard blocker: `maxUnreadable` shifts in a row without a readable result, or
  a conflicted/unbuildable `main` that one repair shift could not fix.

Items that need a human — product decisions, dead URLs, credentials, hardware —
go on a **"Backlog — needs a human"** list in the plan and the run moves on.

## Files it creates

| path | what |
|---|---|
| `.claude/nightshift.json` | config (commit it) |
| `.claude/workflows/shift.js` | the workflow, CLI install only (commit it) |
| `.claude/nightshift/*.sh`, `*.md` | loop wrapper, Stop hook, seed prompts (commit them) |
| `.claude/settings.json`, `.claude/skills/handoff/SKILL.md` | the two hooks, the `/handoff` skill (commit them) |
| `handoff/phase-<id>.md` | per-phase handoffs written by agents (commit them — they are the project memory) |
| `handoff/STATE.json`, `nightshift.log`, `shift-loop.log`, `STOP`, `NEXT_SESSION`, `handoff.txt` | runtime state (gitignored) |

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
- **One shift per context** — a session that runs one shift and hands off never
  compacts, and a human can read what it did; that is why `loop` is the default.

## One shift by hand

Inside an interactive Claude Code session, say "use a workflow" and:

```
Workflow({ name: 'nightshift:shift',   // or 'shift' after a CLI install
           args: { repo: '/abs/path', planFile: 'PLAN.md', serial: ['1','2'], parallel: ['3'], phases: {...}, tests: [...], mainBase: 'http://localhost:5200' } })
```

The full `args` contract is documented at the top of `workflows/shift.js`.

## Repository layout

```
.claude-plugin/plugin.json, marketplace.json   # Claude Code plugin + single-plugin marketplace "tomaash"
workflows/shift.js                             # the Workflow-tool script (plugin: nightshift:shift)
skills/nightshift/SKILL.md                     # /nightshift install | loop | run | stop | status
bin/cli.mjs, bin/supervisor.mjs                # the CLI; the headless outer loop
templates/nightshift.json                      # per-project config template
templates/shift-loop.sh, shift-stop-hook.sh    # the loop wrapper and Stop hook (installed to .claude/nightshift/)
templates/shift-seed.md, shift-seed-dryrun.md  # seed prompts; hooks.json — the settings.json snippet
templates/skills/handoff/SKILL.md              # the /handoff skill the loop relies on
docs/PLAN-FORMAT.md, docs/LOOP.md              # how to write a plan; how the loop cycles
```

## License

MIT. Built on 2026-09-03 while porting a display renderer to parity with two
incumbent players — ten phases, 40 agents, one night.
