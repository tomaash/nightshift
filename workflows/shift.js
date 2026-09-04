export const meta = {
  name: 'shift',
  description: 'One nightshift shift: execute a batch of phases from a written plan with isolated implementer agents, adversarial review, and one-at-a-time merge+verify onto main; crash-only — every phase checkpoints to disk, the run halts cleanly when agents start dying, and the return value is the continuation',
  whenToUse: 'A plan file exists with numbered phase sections (each with Implement / Verification / Do-not) and the user has asked to run it without firing phases by hand. Pass the phase map via args — see the ARGS block below.',
  phases: [
    { title: 'Serial track', detail: 'phases that touch the same files, one after another' },
    { title: 'Parallel branch', detail: 'independent phases, each in its own worktree' },
    { title: 'Merge + verify', detail: 'one merge at a time onto main; full suite; visual check' },
    { title: 'Docs + critic', detail: 'optional docs phase on main, then a completeness critic' },
  ],
}

/*
ARGS (all paths absolute; pass real JSON, not a string):
{
  repo: '/abs/path/to/repo',
  planFile: 'PARITY-PLAN.md',              // relative to repo; must have "## Phase <id> — <title>" sections
  contextFiles: ['PARITY.md'],             // extra files every agent reads first (relative to repo)
  handoffDir: 'handoff',                   // relative to repo; agents write <handoffDir>/phase-<id>.md
  mainBase: 'http://localhost:5200',       // a dev server already serving main (used by merge/docs agents only)
  serial:   ['3a', '3b', '5'],             // run one after another, each merged before the next starts
  parallel: ['4', '6', '7'],               // run concurrently in worktrees, merged as they finish
  phases: {                                // one entry per id above
    '3a': { title: 'Wrapping', port: 5301, brief: 'phase-specific facts, fixture ids, prior findings…' },
  },
  tests: ['node test/golden/run.mjs', 'node test/marquee-parity.mjs'],  // each gets " --base <url>" appended when testsTakeBase (default true)
  testsTakeBase: true,
  visualUrl: '/?uid=poc',                  // page for the mandatory end-of-phase look (on the agent's own server)
  docs: { id: '10', brief: '…' } | null,   // optional docs phase run on main after all merges
  critic: true,
  model: 'opus',                            // implementer/reviewer/merge model
  maxFixPasses: 1,
  resetAt: '16:00 Europe/Prague',           // optional; copied into the paused report so the continuation can be scheduled
  previousRun: 'free text: what is already merged, which branches exist'  // optional, for continuations
}

CRASH-ONLY CONTRACT: nothing here relies on the run finishing. Every agent commits on its branch and
writes its handoff at milestones; the script stops spawning after two consecutive dead agents and RETURNS
a `paused` object whose `continueWith` is a ready-to-pass args value for the next invocation of this same
workflow. Never resume with resumeFromRunId — relaunch with continueWith.
*/

const A = args || {}
const REPO = A.repo
const PLAN = `${REPO}/${A.planFile}`
const HANDOFF = A.handoffDir || 'handoff'
const MODEL = A.model || 'opus'
const MAX_FIX = A.maxFixPasses ?? 1
const TESTS = A.tests || []
const TAKE_BASE = A.testsTakeBase !== false
const withBase = (cmd, base) => (TAKE_BASE ? `${cmd} --base ${base}` : cmd)
const PHASES = A.phases || {}
const SERIAL = A.serial || []
const PARALLEL = A.parallel || []
if (!REPO || !A.planFile) throw new Error('args.repo and args.planFile are required')

// --- circuit breaker: stop spawning once the platform starts killing agents ---------------

let halted = false
let consecutiveDead = 0
const state = { merged: [], implemented: [], reviewed: [], failed: [], skipped: [] }

const spawn = async (prompt, opts) => {
  if (halted) return null
  const r = await agent(prompt, opts)
  if (r === null) {
    consecutiveDead++
    if (consecutiveDead >= 2 && !halted) {
      halted = true
      log('two consecutive agents died — halting new spawns; in-flight work finishes, then the run returns a paused report')
    }
  } else {
    consecutiveDead = 0
  }
  return r
}

// --- shared agent contract -------------------------------------------------------

const CONTEXT_FILES = [A.planFile, ...(A.contextFiles || [])].map((f) => `${REPO}/${f}`)

const COMMON = `
You are one agent in a multi-agent run executing a written plan in ${REPO}. Read before touching anything:
1. ${CONTEXT_FILES.join(', ')} — the plan's decisions and evidence sections in full, then YOUR phase section in full.
2. ${REPO}/${HANDOFF}/*.md — what earlier phases changed (line numbers in the plan drift; handoffs carry the current anchors).
${A.previousRun ? `3. State from a previous run: ${A.previousRun}` : ''}

Ground rules:
- Never log in anywhere or type credentials. If a reference site shows a login form, skip that measurement and flag it.
- Browser (if the plan needs it): load Chrome MCP tools via ToolSearch ("select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_close_mcp"). Create your own tab, close it when done, never navigate a tab you did not create. Click the page once after load.
- Worktree setup (the harness cuts worktrees bare and possibly from a stale base): first run git log --oneline -3 main && git merge main (or rebase) so you build on CURRENT main; ln -s ${REPO}/node_modules <worktree>/node_modules; cp ${REPO}/.env.local <worktree>/ if it exists (gitignored secrets the dev server needs). Never run package installs or patch-package in a worktree.
- Tests: never use ${A.mainBase || 'the main dev server'} from a worktree — it serves main. Start your own dev server in the worktree on <YOUR_PORT> (the project's dev command, e.g. npx vite --port <YOUR_PORT> --strictPort &)${TAKE_BASE ? ' and append --base http://localhost:<YOUR_PORT>' : ''} to each of: ${TESTS.join(' ; ') || '(the tests named in your phase section)'}. Kill your server before returning.
- Mandatory end-of-phase visual check: open ${A.visualUrl || '/'} on YOUR server, click, wait 4 s, screenshot, zoom on the area your phase touches; record what you saw in the handoff. Suites passing while the real page is broken has happened.
- Goldens/snapshots: update only when every differing case is your phase's own fixture, or the diff is explained by a measurement recorded in the handoff. Otherwise leave failing and flag.
- CRASH-ONLY CONTRACT: you may be killed at any tool call. Write ${HANDOFF}/phase-<id>.md at every milestone (understood → implemented → tests → visual → done) with: what changed (files/functions), what was verified with numbers, what is flagged, what the next phase must know — and COMMIT on your branch at each milestone ("Phase <id> [milestone]: …"). A reader must be able to continue from the file alone. Also add a "**Done <date>**" block under your phase in the plan recording deliberate deviations from its letter.
- Do not push. Do not touch main.
- You run unattended. Do not stop to ask for approval or a review — every merge is a commit and can be reverted. Report 'blocked' ONLY for a hard blocker: the work cannot proceed without a credential or resource that is absent, or the repository is in a state you cannot repair. Judgment calls (an ambiguous spec, a golden that moved for a reason you can explain) are yours to make and record in the handoff, not reasons to stop.
- Return ONLY the structured result. 'done' = every item of your phase section implemented and verified; 'partial' lists what is missing in flags; 'blocked' says why.
`

const RESULT = {
  type: 'object',
  required: ['status', 'branch', 'worktreePath', 'summary', 'changedFiles', 'goldensUpdated', 'flags', 'handoffPath', 'tokensApprox'],
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    branch: { type: 'string' }, worktreePath: { type: 'string' }, summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    goldensUpdated: { type: 'array', items: { type: 'string' } },
    flags: { type: 'array', items: { type: 'string' } },
    handoffPath: { type: 'string' }, tokensApprox: { type: 'number' },
  },
}
const REVIEW = { type: 'object', required: ['verdict', 'issues'], properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, issues: { type: 'array', items: { type: 'string' } } } }
const MERGE = { type: 'object', required: ['merged', 'tests', 'flags', 'summary'], properties: { merged: { type: 'boolean' }, tests: { type: 'object' }, flags: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } }

const implPrompt = (id) => `${COMMON}
YOUR PHASE: ${id} — ${PHASES[id].title}. Your dev-server port: ${PHASES[id].port}.
${PHASES[id].brief || ''}
You are in a fresh git worktree on your own branch. Report branch and worktree path.`

const fixPrompt = (id, r, review) => `${COMMON}
YOUR PHASE: ${id} — ${PHASES[id].title}, FIX PASS. Your dev-server port: ${PHASES[id].port}.
A previous agent implemented this phase in worktree ${r.worktreePath} (branch ${r.branch}); work THERE. Its handoff: ${r.handoffPath}. Its flags: ${JSON.stringify(r.flags)}.
An adversarial reviewer failed it — fix every issue, re-verify (including the visual check), update handoff and plan, commit on the same branch:
${review.issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}`

const reviewPrompt = (id, r) => `You are an adversarial reviewer. Phase ${id} (${PHASES[id].title}) of ${PLAN} was implemented on branch ${r.branch} in worktree ${r.worktreePath}. Read the phase section and the plan's evidence sections, the handoff ${r.handoffPath}, and the diff (cd ${r.worktreePath} && git diff main...HEAD). Try to REFUTE it:
- Does the code match the spec the plan cites (file:line), or did it follow a convenient source the plan says loses?
- Any anti-pattern the plan lists?
- Snapshots/goldens updated outside this phase's own fixture without a recorded measurement?
- Any handoff claim without a number, test run or screenshot? Was the mandatory visual check actually done?
- Dev server left running, main edited, required test set not run?
To run tests yourself start your own server on port ${(PHASES[id].port || 5400) + 50} in the worktree and pass --base; never use ${A.mainBase || 'the main server'}. Be concrete, cite file:line; 'fail' only for real defects or unverified claims. Do not modify files.`

const mergePrompt = (id, r) => `You are the merge-and-verify agent for ${REPO} (on main; nobody else edits main while you run). Merge branch ${r.branch} (Phase ${id}: ${PHASES[id].title}; worktree ${r.worktreePath}, handoff ${r.handoffPath}), then verify main.
1. git merge --no-ff ${r.branch} -m "Merge Phase ${id}: ${PHASES[id].title}". Resolve conflicts by reading both sides and the plan; never drop the other side's work.
2. ${A.mainBase ? `The dev server ${A.mainBase} serves main (HMR) — do not start another on its port. Run each of: ${TESTS.map((t) => withBase(t, A.mainBase)).join(' ; ') || '(the plan\'s test list)'}.` : 'Run the plan\'s test list against main.'}
3. Failures: update snapshots only for this phase's own fixture when the handoff explains the diff; otherwise flag, do not update.
4. Visual check on ${A.mainBase || 'main'}${A.visualUrl || ''} (own tab; click; wait 4 s; screenshot; zoom the touched area). Anything clipped or shifted is a flag.
5. git worktree remove --force ${r.worktreePath}; git branch -d ${r.branch} (keep it if not merged).
Return the structured result; tests fields are one-line outcomes per suite.`

// --- serialized merge queue -----------------------------------------------------------------

let mergeChain = Promise.resolve()
const mergeSerially = (id, r) => {
  const job = mergeChain.then(() => spawn(mergePrompt(id, r), { label: `merge:${id}`, phase: 'Merge + verify', schema: MERGE, model: MODEL, effort: 'medium' }))
  mergeChain = job.catch(() => null)
  return job
}

// --- one phase --------------------------------------------------------------------------------------

const runPhase = async (id, group) => {
  if (halted) { state.skipped.push(id); return { id, status: 'skipped' } }
  if (!PHASES[id]) return { id, status: 'no-such-phase' }
  let r = await spawn(implPrompt(id), { label: `impl:${id}`, phase: group, schema: RESULT, model: MODEL, effort: 'high', isolation: 'worktree' })
  if (!r) { state.failed.push(id); return { id, status: 'agent-died' } }
  state.implemented.push({ id, branch: r.branch, worktreePath: r.worktreePath, handoffPath: r.handoffPath })
  log(`Phase ${id}: ${r.status} — ${(r.summary || '').slice(0, 160)}`)
  if (r.status === 'blocked') return { id, status: 'blocked', flags: r.flags, summary: r.summary }
  let review = await spawn(reviewPrompt(id, r), { label: `refute:${id}`, phase: group, schema: REVIEW, model: MODEL, effort: 'medium' })
  let pass = 0
  while (review && review.verdict === 'fail' && pass < MAX_FIX && !halted) {
    pass++
    log(`Phase ${id}: review failed (${review.issues.length}) — fix pass ${pass}`)
    const fixed = await spawn(fixPrompt(id, r, review), { label: `fix${pass}:${id}`, phase: group, schema: RESULT, model: MODEL, effort: 'high' })
    if (fixed) r = { ...fixed, worktreePath: r.worktreePath, branch: r.branch }
    review = await spawn(reviewPrompt(id, r), { label: `refute${pass + 1}:${id}`, phase: group, schema: REVIEW, model: MODEL, effort: 'medium' })
  }
  state.reviewed.push({ id, verdict: review ? review.verdict : 'unknown' })
  const flags = [...(r.flags || [])]
  if (review && review.verdict === 'fail') flags.push(...review.issues.map((i) => `review: ${i}`))
  if (halted) return { id, status: r.status, merged: false, flags: [...flags, 'not merged: run halted'], branch: r.branch, worktreePath: r.worktreePath }
  const merge = await mergeSerially(id, r)
  if (merge && merge.merged) state.merged.push(id)
  return { id, status: r.status, merged: merge ? merge.merged : false, tests: merge ? merge.tests : null, flags: [...flags, ...(merge ? merge.flags : ['merge agent died'])], goldensUpdated: r.goldensUpdated, summary: r.summary, branch: r.branch, worktreePath: r.worktreePath }
}

// --- run -------------------------------------------------------------------------------------------------

const serial = (async () => {
  const out = []
  for (const id of SERIAL) {
    const res = await runPhase(id, 'Serial track')
    out.push(res)
    if (['blocked', 'agent-died', 'skipped'].includes(res.status)) { log(`serial track stops at ${id}: ${res.status}`); break }
  }
  return out
})()
const branch = parallel(PARALLEL.map((id) => () => runPhase(id, 'Parallel branch')))
const [serialResults, branchResults] = await Promise.all([serial, branch])
const results = [...serialResults, ...branchResults.filter(Boolean)]

// --- paused report: the continuation IS the return value -------------------------------------------

const remaining = [...SERIAL, ...PARALLEL].filter((id) => !state.merged.includes(id))
const continueWith = {
  ...A,
  serial: SERIAL.filter((id) => remaining.includes(id)),
  parallel: PARALLEL.filter((id) => remaining.includes(id)),
  previousRun:
    `Merged on main: ${state.merged.join(', ') || 'none'}. ` +
    `Implemented but not merged (reuse the branch — cherry-pick or merge it into a fresh worktree from current main, then re-review): ` +
    (state.implemented.filter((s) => !state.merged.includes(s.id)).map((s) => `${s.id} → ${s.branch} at ${s.worktreePath} (handoff ${s.handoffPath})`).join('; ') || 'none') +
    `. Never started: ${state.skipped.concat(state.failed).join(', ') || 'none'}.`,
}

if (halted || remaining.length > 0 && results.some((r) => r.status === 'agent-died')) {
  return {
    paused: true,
    reason: 'agents were being killed by the platform (spend limit or terminal API errors); spawning was halted to avoid nondeterministic partial work',
    resetAt: A.resetAt || null,
    merged: state.merged,
    results,
    continueWith,
    howToContinue: `After the limit resets${A.resetAt ? ` (${A.resetAt})` : ''}: Workflow({ name: 'shift' /* or 'nightshift:shift' */, args: <continueWith> }). Do NOT use resumeFromRunId.`,
  }
}

phase('Docs + critic')
let docs = null
if (A.docs && !halted) {
  docs = await spawn(`${COMMON}
YOUR PHASE: ${A.docs.id} — docs + final verification. Work directly in ${REPO} on main (no worktree; nobody else edits main now; tests against ${A.mainBase || 'main'}). Results of the phases this run, as JSON:
${JSON.stringify(results, null, 1)}
Read every ${HANDOFF}/*.md and git log for the full picture. ${A.docs.brief || ''}
Append a "Run" section to ${PLAN}: per phase merged?, tests, flags; then every open item with a one-line disposition. Commit on main. Return branch "main" and worktreePath "${REPO}".`,
    { label: `docs:${A.docs.id}`, phase: 'Docs + critic', schema: RESULT, model: MODEL, effort: 'medium' })
}

let critic = null
if (A.critic !== false && !halted) {
  critic = await spawn(`You are the completeness critic for a multi-agent run that executed phases ${[...SERIAL, ...PARALLEL].join(', ')} of ${PLAN}. Read the plan (every "Done" block and the "Run" section), every ${REPO}/${HANDOFF}/*.md, and git log --oneline -60. Answer briefly, as a prioritised list for the human: (1) plan items NOT implemented or NOT verified with a number/test/screenshot; (2) flags that are real defects vs noise — the 3–5 things to look at first; (3) snapshots updated without justification; (4) handoffs showing lost or confused context (contradictions, repeated work, retracted claims); (5) whether the docs tell the truth about what shipped. Do not modify files. Under 600 words.`,
    { label: 'critic', phase: 'Docs + critic', effort: 'high' })
}

return { paused: false, merged: state.merged, results, docs, critic, continueWith: remaining.length ? continueWith : null }
