---
name: nightshift
description: Hand this project's written plan to nightshift and let it run unattended — implementer agents in worktrees, adversarial review, one merge at a time onto main, sleeping through usage-limit resets until the backlog is dry. Two verbs — `/nightshift install` (configure this project) and `/nightshift run` (start the supervisor in tmux). Use when the user asks to "run the plan", "run the plan overnight", "execute the plan unattended", "set up nightshift", or wants agents to work through a backlog without firing phases by hand.
---

# nightshift

`$ARGUMENTS` is the verb: `install`, `run`, `stop`, `status`. No verb → `install`
if `.claude/nightshift.json` is missing, otherwise `run`.

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs <verb> --plugin --repo $PWD`.
Report each step in one line. Never ask for approvals nightshift's policy does not
need: it runs until the backlog is dry and every merge is a commit.

## install

1. Run the CLI `install --plugin`. It writes `.claude/nightshift.json` from the
   template (plugin mode: `workflowName` = `nightshift:shift`, nothing is copied),
   detects the plan (`PLAN.md`, or the single `*PLAN*.md` at the root),
   gitignores the runtime files and checks prerequisites (claude, git, tmux,
   Workflow tool headless, usage signal).
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
4. Relay any `MISS` lines from the checks with their hints. End with: "Ready.
   `/nightshift run` starts it."

## run

Run the CLI `run`. It detaches into a tmux session named `nightshift` (the
supervisor must live outside this Claude session — it survives the usage limit,
this session does not) and prints how to watch it. Confirm with `tmux ls` and
tell the user:

- watch: `tail -f <handoffDir>/nightshift.log` or `tmux attach -t nightshift`
- stop: `/nightshift stop` (graceful, after the current shift)
- status: `/nightshift status`

The first shift is a **groom** when no phases are queued: it reads the plan,
handoffs and critic notes and writes the next batch of phases.

## stop / status

Pass through to the CLI and relay the output.
