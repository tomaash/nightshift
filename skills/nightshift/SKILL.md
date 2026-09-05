---
name: nightshift
description: Hand this project's written plan to nightshift and let it run — implementer agents in worktrees, adversarial review, one merge at a time onto main, until the backlog is dry. Verbs — `/nightshift install` (configure this project), `/nightshift loop` (one visible Claude session per shift in tmux; the default), `/nightshift loop --dry-run` (handoff-cycle test), `/nightshift run` (headless supervisor), `stop`, `status`. Use when the user asks to "run the plan", "run the plan overnight", "execute the plan unattended", "set up nightshift", or wants agents to work through a backlog without firing phases by hand.
---

# nightshift

`$ARGUMENTS` is the verb: `install`, `loop [--dry-run]`, `run`, `stop`, `status`.
No verb → `install` if `.claude/nightshift.json` is missing, otherwise `loop`.
"Run the plan" with no mode named means `loop` — the user is here and can watch;
`run` only when they say headless/unattended-while-away or have no tmux pane to
keep.

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs <verb> --plugin --repo $PWD`.
Report each step in one line. Never ask for approvals nightshift's policy does not
need: it runs until the backlog is dry and every merge is a commit.

## install

1. Run the CLI `install --plugin`. It writes `.claude/nightshift.json` from the
   template (plugin mode: `workflowName` = `nightshift:shift`, nothing is copied),
   detects the plan (`PLAN.md`, or the single `*PLAN*.md` at the root), writes
   the loop scripts + seed prompts to `.claude/nightshift/`, merges the
   SessionStart + Stop hooks into `.claude/settings.json`, copies the `/handoff`
   skill, gitignores the runtime files and checks prerequisites (claude, git,
   tmux, jq, Workflow tool headless, usage signal, project trusted).
2. If the plan was not detected, or the user named one, set `planFile`. Then
   fill in from the repo what the template guesses: `tests` (package.json
   scripts / the plan's Verification sections), `devServer.command` + `port`,
   `buildCommand`, `visualUrl` (the page the plan tells agents to look at),
   `contextFiles` (docs every agent must read first). Show the final config.
3. Open the plan. It must have `## Phase <id> — <title>` sections with
   Implement / Verification / Do-not content and an evidence section. If not, say
   what is missing and offer to draft it from
   `${CLAUDE_PLUGIN_ROOT}/docs/PLAN-FORMAT.md`. Do not run a plan without
   verification steps.
4. If you changed `planFile`, `handoffDir` or `workflowName`, run `install
   --plugin` again: the seed prompts have those baked in.
5. Relay any `MISS` lines from the checks with their hints. End with: "Ready.
   `/nightshift loop --dry-run` tests the handoff cycle (~1 min); `/nightshift
   loop` starts the shifts."

## loop

Run the CLI `loop` (add `--dry-run` when asked for the test). It detaches into a
tmux session named `shift-loop` and prints how to watch it. Each iteration is a
fresh interactive `claude` running one shift from the seed prompt; the session
writes `handoff.txt`, touches `<handoffDir>/NEXT_SESSION`, and the Stop hook
ends it so the next one starts pre-briefed. Confirm with `tmux ls` and tell the
user:

- watch: `tmux attach -t shift-loop` (Ctrl-b d detaches), `/workflows` inside it
- log: `tail -f <handoffDir>/shift-loop.log`
- stop: `/nightshift stop` (the current session finishes its shift first)
- status: `/nightshift status`

`--dry-run`: two sessions, no workflow. The pane must show `shift-loop dry run:
handoff cycle OK` and the loop must exit on STOP within ~2 minutes; if the
session stalls at a trust prompt the project is not trusted yet (see the
`install` check). Report the result in one line.

The first real shift is a **groom** when no phases are queued: it reads the
plan, handoffs and critic notes and writes the next batch of phases.

## run

The headless fallback. Run the CLI `run`. It detaches into a tmux session named
`nightshift` (the supervisor must live outside this Claude session — it
survives the usage limit, this session does not). Tell the user:

- watch: `tail -f <handoffDir>/nightshift.log` or `tmux attach -t nightshift`
- stop / status: `/nightshift stop`, `/nightshift status`

`loop` and `run` refuse to start while the other's tmux session exists.

## stop / status

Pass through to the CLI and relay the output. `stop` writes `<handoffDir>/STOP`;
whatever is running (loop or supervisor) exits after its current shift. Remove
the file before the next `loop`/`run` — both refuse while it exists.
