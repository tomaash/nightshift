DRY RUN of the shift-loop handoff cycle (nightshift loop, see docs/LOOP.md). Do NOT run any workflow, agent, test or build. Do NOT touch git.

1. Look at the top of your context: was a "handoff.txt (auto-injected)" briefing injected? Say in one line whether it was and quote its first line.
2. If it was injected AND it contains the words "DRY RUN 1": this is the second session of the test — write nothing, print "shift-loop dry run: handoff cycle OK", then run `touch {{HANDOFF}}/STOP {{HANDOFF}}/NEXT_SESSION` and END YOUR TURN (the Stop hook ends this session and the loop exits because STOP exists).
3. Otherwise this is the first session: run the `/handoff` skill to write handoff.txt (keep it to ~15 lines; its first line must contain "DRY RUN 1"; include the current `git log --oneline -1` and the time), then `touch {{HANDOFF}}/NEXT_SESSION` and END YOUR TURN.
