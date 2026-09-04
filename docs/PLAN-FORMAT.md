# The plan file

The plan is the only thing the agents are allowed to believe. Everything they
cannot find in it they will guess, and the adversarial reviewer will fail them
for guessing. Spend the effort here.

## Structure

```markdown
# <Project> — <what this plan achieves>

One paragraph: the goal, what "done" means, what the spec is (a reference
implementation? a document? measurements?).

## Decisions
Numbered, dated. The calls a human already made so agents do not re-litigate
them ("we follow player X where X and Y disagree", "no approval gates").

## Phase 0 — Evidence
Not work: facts with citations the agents cite in their code and handoffs.
- Allowed APIs (file:line into the library you build on), with defaults and traps.
- The spec, quoted with file:line or measured numbers.
- A "X vs Y" table where two references disagree and which one wins.
- Anti-patterns: things that look right and are not.

## Phase <id> — <title>
**Implement**
1. Numbered steps naming files and functions. "Copy the pattern at foo.js:120-140"
   beats "refactor foo". Say what NOT to touch when it belongs to another phase.
**Verification**
Commands to run and the numbers/screenshots that count as proof. If a fixture
is needed, name where it comes from.
**Do not**
Phase-specific anti-patterns.

## Backlog — needs a human
The groomer appends here: product decisions, dead URLs, credentials, hardware.
```

Phase ids are free-form strings (`2`, `3a`, `kerning`). The workflow matches
`## Phase <id> — ` literally, so keep the em-dash-or-hyphen consistent with
what you pass in `phases`.

## What agents add to it

- A `**Done <date>**` block under their phase: what shipped, deliberate
  deviations from the plan's letter and why, numbers measured.
- The docs phase appends a `## Run <date>` section: per phase merged?, tests,
  flags.
- The groomer appends new `## Phase` sections and the "needs a human" list.

Commit the plan; it is the durable memory of the run alongside `handoff/*.md`.

## Serial vs parallel

Put phases that edit the same files in `serial` (each is merged before the next
starts). Everything else goes in `parallel`, each in its own worktree. When in
doubt, serial: a conflict costs a merge agent's time, a bad parallel split costs
a broken merge.

## A worked phase (from the run this tool was built on)

```markdown
## Phase 2 — Vertical layout from real metrics

**Implement**
1. `scripts/make-fonts.mjs`: after `adjustFont`, load the font with opentype.js and
   write `cssMetrics` from `font.tables.hhea` into the atlas JSON; emit the same
   into `src/fonts.js` rows as `lineBox`.
2. `src/main.jsx` `createRenderer(...)`: add `textBaselineMode: 'linebox'`
   (`main-api/Renderer.d.ts:404-420`).
3. `src/App.jsx`: replace the `fontSize * 1.2` block in `alignY` with
   `lineHeightOf(el, fontSize)`; pass `lineHeight` (px) on every `<text>`.

**Verification**
Once, manually, in the logged-in Chrome on `/display/poc`: line box height /
font-size = 1.200 (Neo Sans) and 1.149 (Arial) ± 0.5 px. Then
`node test/golden/run.mjs --base <yours>` — every scene differs (baseline mode);
inspect diffs for shifts only, no clipping; then `--update`. `test/marquee-parity.mjs`
placement `ok`. Look at `/?uid=poc` on your server: no clipped caps.

**Do not**
`lineHeight ≤ 3` (a multiplier of the wrong metrics); `contain`;
`verticalAlign: 'center'` (not a value); keep `alignY` and `verticalAlign` both alive.
```

That phase passed every suite with clipped glyphs on the real page — which is
why the visual check is mandatory and written into every phase.
