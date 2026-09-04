---
name: plan-runner
description: Set up and start claude-plan-runner in the current project — run a phased plan unattended with implementer/reviewer/merge agents until the backlog is dry, surviving usage-limit resets. Use when the user asks to "run the plan", "execute the plan unattended", "set up plan-runner", or wants agents to work through a backlog without firing phases by hand.
---

# plan-runner

You are onboarding this project onto claude-plan-runner. Do the steps in order,
report each result in one line, and never ask for approvals the tool's policy
does not need (it runs until the backlog is dry; every merge is a commit).

1. **Config.** If `.claude/agent-supervisor.json` is missing, create it from
   this plugin's `templates/agent-supervisor.json` (`${CLAUDE_PLUGIN_ROOT}/templates/agent-supervisor.json`),
   set `workflowName` to `claude-plan-runner:execute-phased-plan` (the plugin
   provides the workflow; nothing to copy), and fill in from the repo:
   `planFile` (the plan the user names, or the newest `*PLAN*.md`), `tests`
   (from `package.json` scripts / the plan's verification sections),
   `devServer.command`+`port` and `buildCommand` (from `package.json`),
   `visualUrl` (the page the plan tells agents to look at). Show the result.
2. **Plan check.** Open the plan file. It must have `## Phase <id> — <title>`
   sections with Implement / Verification / Do-not content and an evidence
   section. If it does not, say what is missing and offer to draft it from
   `${CLAUDE_PLUGIN_ROOT}/docs/PLAN-FORMAT.md` — do not start a run on a plan
   without verification steps.
3. **Doctor.** Run `node ${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs doctor` and relay any
   MISS lines with their hints.
4. **Gitignore.** Ensure `<handoffDir>/STATE.json`, `STOP`, `supervisor.log`
   are gitignored (the CLI's `init --plugin` does this).
5. **Start.** The supervisor must run OUTSIDE this session (it survives the
   usage limit; this session does not). Give the user the exact command:

   ```bash
   tmux new -s agent "node ${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs run --repo $PWD"
   ```

   and the two others: `… stop` (graceful) and `… status`. If the user asks you
   to start it from here, run the tmux command with Bash and confirm the
   session exists (`tmux ls`).

The first unit is a **groom** when no phases are queued: it reads the plan,
handoffs and any critic notes and writes the next batch of phases. Point the
user at `tail -f <handoffDir>/supervisor.log`.
