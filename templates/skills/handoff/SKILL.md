---
name: handoff
description: Write handoff.txt — a curated end-of-session briefing the next session auto-loads (a SessionStart hook injects and deletes the file). Used by the nightshift loop at the end of every shift, and by hand right before /clear. Optional argument slants it toward the next task, e.g. /handoff focus on Phase 3.
---

Write `handoff.txt` in the repo root: a dense, curated briefing for the next
session, written from THIS session's live context. A SessionStart hook will
inject it into the next session and delete the file — nothing else is needed
on the reading side.

If the user passed an argument, treat it as the next session's focus and
slant the NEXT STEPS and reading order toward it.

## What goes in (and what doesn't)

The repo docs are the durable record — do not duplicate them. The plan carries
per-phase state (`**Done` blocks, Run sections, the needs-a-human backlog), the
per-phase handoffs in the handoff dir carry what each agent found, and the
auto-memory files carry the standing traps. The handoff carries only the thin
layer on top:

1. **Header**: repo name + date, one line on what the project is (a reader
   may be a fresh session with zero context).
2. **STATE**: is the tree clean and everything committed? Which docs to read,
   in what order, for the next task. For a nightshift shift: the exact next
   `continueWith` (or "groom next").
3. **WHAT WORKS, VERIFIED**: only claims verified THIS session, with how they
   were verified (test, live render, curl). Include exact ids, URLs, and
   credentials-locations (never secrets themselves).
4. **TRAPS RECORDED**: hard-won non-obvious facts from this session that
   would cost the next session real time to rediscover. One line each.
   Skip anything already in a memory file or repo doc — name it instead.
5. **NEXT STEPS, IN ORDER**: numbered, concrete, with the reason for the
   ordering. Include open questions waiting on other people.
6. **ENVIRONMENT NOTES**: run commands, test commands, ports, URLs, modes —
   only the ones the next task will actually need.

Style: terse, factual, past-verified-tense. No praise, no narrative. Aim for
under ~80 lines.

After writing the file, say it is ready. By hand the ritual is `/clear` now;
inside the nightshift loop the seed prompt continues with `touch
<handoffDir>/NEXT_SESSION` and the Stop hook restarts the session pre-briefed.
