#!/usr/bin/env node
/**
 * nightshift — the supervisor. Runs a project's plan until the backlog is dry,
 * surviving usage-limit resets. Lives OUTSIDE any Claude session (`nightshift
 * run` puts it in tmux): the one thing the account limit cannot kill is a plain loop.
 *
 *   node <toolkit>/bin/supervisor.mjs [--repo <project>]   # default: cwd
 *   touch <project>/<handoffDir>/STOP                       # graceful stop
 *
 * Config: <project>/.claude/nightshift.json (see templates/). The `shift`
 * workflow it drives comes from the nightshift plugin (`nightshift:shift`) or
 * is copied into <project>/.claude/workflows/ by `nightshift install`.
 *
 * One iteration = one shift = one headless `claude -p` call:
 *   phases — run the workflow for the phases in <handoffDir>/STATE.json
 *   groom  — no phases left: turn handoff flags + critic notes into new plan
 *            phases (batched), or declare the backlog dry
 *   repair — main is conflicted or does not build: fix or revert, then go on
 *
 * Budget: every `claude -p` stream carries `rate_limit_event` records with
 * rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}.
 * Before each shift a one-line haiku probe reads them; a window at or above
 * maxUtil sleeps to its resetsAt (+3 min). A shift killed by the limit anyway
 * uses the last rate_limit_info from its stream; the error text ("resets 4pm")
 * is the fallback, then 60 min. Nothing is lost: the workflow's agents commit
 * and write handoffs at milestones (crash-only contract).
 *
 * Stops ONLY for: STOP file; backlog dry; a hard blocker (maxUnreadable shifts
 * in a row without a readable state block; a repo the repair shift could not
 * fix). No approval gates — every merge is a commit and commits revert.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import net from 'node:net'

const argv = process.argv.slice(2)
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const REPO = resolve(opt('--repo', process.cwd()))
const CONFIG_FILE = resolve(REPO, '.claude/nightshift.json')
if (!existsSync(CONFIG_FILE)) { console.error(`no ${CONFIG_FILE} — run: nightshift install`); process.exit(2) }
const C = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))

const HANDOFF = resolve(REPO, C.handoffDir || 'handoff')
const STATE_FILE = resolve(HANDOFF, 'STATE.json')
const STOP_FILE = resolve(HANDOFF, 'STOP')
const LOG_FILE = resolve(HANDOFF, 'nightshift.log')
const PLAN = C.planFile
const DEV_PORT = C.devServer?.port || 5200
const DEV_CMD = C.devServer?.command || null
const MAIN_BASE = `http://localhost:${DEV_PORT}`
const MODEL = process.env.SUPERVISOR_MODEL || C.model || 'opus'
const MAX_UTIL = Number(process.env.SUPERVISOR_MAX_UTIL || C.maxUtil || 0.9)
const MAX_UNREADABLE = C.maxUnreadable || 3
const WORKFLOW = C.workflowName || 'shift'
const TESTS = C.tests || []
const TESTS_TAKE_BASE = C.testsTakeBase !== false
const VISUAL = C.visualUrl || '/'
const CONTEXT = C.contextFiles || []
const BATCH = C.groomBatch || 4
const PORT_BASE = C.portBase || 5301

mkdirSync(HANDOFF, { recursive: true })
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); appendFileSync(LOG_FILE, line + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const loadState = () => existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { units: 0, unreadable: 0, history: [], continueWith: null, done: false }
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1))

// --- dev server the merge agents verify against --------------------------------------------

const listening = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
let devServer = null
const ensureDevServer = async () => {
  if (!DEV_CMD || (await listening(DEV_PORT))) return
  log(`starting dev server on :${DEV_PORT}: ${DEV_CMD.join(' ')}`)
  devServer = spawn(DEV_CMD[0], DEV_CMD.slice(1), { cwd: REPO, stdio: 'ignore' })
  for (let i = 0; i < 30 && !(await listening(DEV_PORT)); i++) await sleep(1000)
}

// --- prompts -----------------------------------------------------------------------------------

const POLICY = `
POLICY — you run unattended, until the backlog is dry. Do not ask for approval; do not pause for review. Every merge is a commit and can be reverted later, so prefer finishing to hesitating. Stop early ONLY for a hard blocker: main does not build or its core suites fail after a merge and one repair attempt did not fix it; the repository is in a conflicted state you cannot resolve; or every remaining item needs a credential or resource that is absent. Anything else is a flag in the handoff, not a stop.
When you are done, print — as the LAST thing in your reply — one fenced block tagged \`state\` containing ONLY JSON of the shape {"continueWith": <args for the ${WORKFLOW} workflow, or null>, "done": <true when the backlog is dry>, "reason": "<one line>", "resetAt": "<if the run paused for a limit, the reset time it reported, else null>"}.`

const baseArgs = () => ({
  repo: REPO, planFile: PLAN, contextFiles: CONTEXT, handoffDir: C.handoffDir || 'handoff', mainBase: MAIN_BASE,
  tests: TESTS, testsTakeBase: TESTS_TAKE_BASE, visualUrl: VISUAL, model: MODEL, critic: true,
  docs: C.docs || { id: 'docs', brief: 'update the project docs for what shipped' },
})

const phasesPrompt = (cw) => `use a workflow. In ${REPO}, run the saved workflow: Workflow({ name: '${WORKFLOW}', args: ${JSON.stringify(cw)} }). Wait for it to finish. Then, from its return value, build the state block: continueWith = its continueWith (null if nothing remains), done = false, resetAt = its resetAt if it returned paused. Summarise merged phases and flags in two lines above the block.${POLICY}`

const groomPrompt = (previous) => `You are the backlog groomer for ${REPO}. The phases listed in ${PLAN} have all been merged (see git log, ${C.handoffDir || 'handoff'}/*.md, and any "Run" sections and critic notes in the plan). Decide what work remains:
1. Read every handoff's flags and the latest critic output. Classify each as (a) a real defect or unfinished plan item a coding agent can complete with the evidence in the plan, (b) needs a human/product decision or an external resource (credentials, a dead URL, hardware), (c) noise or a documented decision.
2. For (a): append new phase sections to ${PLAN} in the plan's existing format (Implement / Verification / Do not), each with evidence citations, and build a continueWith object for the ${WORKFLOW} workflow: ${JSON.stringify({ ...baseArgs(), serial: ['ids that touch the same files, in order'], parallel: ['independent ids'], phases: { id: { title: '…', port: PORT_BASE, brief: 'facts, fixture ids, prior findings' } } })}. Ports: ${PORT_BASE} upward, unique per phase. At most ${BATCH} phases per shift.
3. For (b) and (c): record them in a "Backlog — needs a human" list in ${PLAN} with one-line dispositions. Do not invent work; if nothing actionable remains, the backlog is dry.
Commit the plan change on main ("Groom: <n> new phases" or "Groom: backlog dry"). Previous state for context: ${JSON.stringify(previous).slice(0, 4000)}${POLICY}`

const repairPrompt = () => `In ${REPO} on main: the repository is in a broken state after an unattended merge (conflicted files, or the build / core suites failing). Diagnose with git status, git log -5, the build, and the project's test commands${TESTS.length ? ` (${TESTS.join(' ; ')}${TESTS_TAKE_BASE ? `, each with --base ${MAIN_BASE}` : ''})` : ''}. Repair with the smallest change that restores a clean, building, passing main — resolve conflicts by reading both sides, or revert the last merge commit if it cannot be fixed in one pass (note the revert in the plan so the phase is re-queued). Commit. Then print the state block with continueWith = null and done = false.${POLICY}`

// --- one headless claude call ------------------------------------------------------------------

const LIMIT_RE = /spend limit|usage limit|rate.?limit|limit reached/i
const RESET_RE = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i

const runClaude = (prompt, model = MODEL) => new Promise((res) => {
  const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', model], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = '', finalText = '', limitHit = false, resetText = null, rateInfo = null
  child.stdout.on('data', (d) => {
    out += d
    let idx
    while ((idx = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, idx); out = out.slice(idx + 1)
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info) rateInfo = ev.rate_limit_info
      const text = JSON.stringify(ev)
      if (LIMIT_RE.test(text) && (ev.type === 'result' || ev.is_error || ev.error)) { limitHit = true; const m = text.match(RESET_RE); if (m) resetText = m[0] }
      if (ev.type === 'result') finalText = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '')
    }
  })
  child.stderr.on('data', (d) => { err += d })
  child.on('close', (code) => {
    if (LIMIT_RE.test(err)) { limitHit = true; resetText ||= (err.match(RESET_RE) || [null])[0] }
    res({ code, finalText, limitHit, resetText, rateInfo, stderr: err.slice(-2000) })
  })
})

const parseState = (text) => { const m = text.match(/```state\s*([\s\S]*?)```/); if (!m) return null; try { return JSON.parse(m[1]) } catch { return null } }

const fullestWindow = (info) => {
  const w = info && info.unifiedWindows
  if (!w) return null
  return Object.entries(w).map(([name, v]) => ({ name, utilization: Number(v.utilization) || 0, resetsAt: Number(v.resetsAt) * 1000 })).sort((a, b) => b.utilization - a.utilization)[0]
}
const probeUsage = async () => (await runClaude('Reply with exactly: ok', 'haiku')).rateInfo
const msUntilWindowReset = (win) => (win && win.resetsAt > Date.now() ? win.resetsAt - Date.now() + 3 * 60 * 1000 : null)
const msUntilReset = (resetText) => {
  const m = resetText && resetText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return 60 * 60 * 1000
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = (m[3] || '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  const t = new Date(); t.setHours(h, min, 0, 0)
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1)
  return t.getTime() - Date.now() + 3 * 60 * 1000
}

const repoBroken = () => {
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout || ''
  if (/^(UU|AA|DD|AU|UA|DU|UD) /m.test(st)) return 'conflicted files'
  if (C.buildCommand) { const b = spawnSync(C.buildCommand[0], C.buildCommand.slice(1), { cwd: REPO, encoding: 'utf8' }); if (b.status !== 0) return 'build fails' }
  return null
}

// --- the loop ---------------------------------------------------------------------------------------

const main = async () => {
  log(`nightshift start in ${REPO} (plan ${PLAN}, workflow ${WORKFLOW}, model ${MODEL}, maxUtil ${MAX_UTIL})`)
  for (;;) {
    if (existsSync(STOP_FILE)) { log('STOP file present — stopping'); break }
    const state = loadState()
    if (state.done) { log(`backlog dry: ${state.reason || ''} — stopping`); break }

    await ensureDevServer()
    const info = await probeUsage()
    const win = fullestWindow(info)
    if (win && win.utilization >= MAX_UTIL) {
      const wait = msUntilWindowReset(win) ?? 60 * 60 * 1000
      log(`${win.name} window at ${Math.round(win.utilization * 100)}% — sleeping ${Math.round(wait / 60000)} min until its reset`)
      await sleep(wait)
      continue
    }
    if (win) log(`usage: ${Object.entries(info.unifiedWindows).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(', ')}`)

    const broken = repoBroken()
    let kind, prompt
    if (broken) { kind = 'repair'; prompt = repairPrompt(); log(`repo ${broken} — repair shift`) }
    else if (state.continueWith && ((state.continueWith.serial || []).length + (state.continueWith.parallel || []).length) > 0) { kind = 'phases'; prompt = phasesPrompt({ ...baseArgs(), ...state.continueWith }) }
    else { kind = 'groom'; prompt = groomPrompt(state) }

    log(`shift ${state.units + 1} (${kind}) starting`)
    const r = await runClaude(prompt)

    if (r.limitHit) {
      const wait = msUntilWindowReset(fullestWindow(r.rateInfo)) ?? msUntilReset(r.resetText)
      log(`usage limit hit (${r.resetText || 'from rate_limit_info'}) — sleeping ${Math.round(wait / 60000)} min`)
      state.history.push({ unit: state.units + 1, kind, limitHit: true, resetText: r.resetText, at: new Date().toISOString() })
      saveState(state); await sleep(wait); continue
    }

    const next = parseState(r.finalText || '')
    if (!next) {
      state.unreadable++; state.units++
      log(`shift ${state.units} (${kind}) returned no readable state (exit ${r.code}); unreadable=${state.unreadable}`)
      state.history.push({ unit: state.units, kind, unreadable: true, exit: r.code, tail: (r.finalText || r.stderr || '').slice(-500), at: new Date().toISOString() })
      saveState(state)
      if (state.unreadable >= MAX_UNREADABLE) { log('HARD BLOCKER: consecutive shifts without readable state — stopping'); break }
      if (kind === 'repair') { log('HARD BLOCKER: repair shift failed — stopping'); break }
      continue
    }

    state.unreadable = 0; state.units++
    const remaining = next.continueWith ? [...(next.continueWith.serial || []), ...(next.continueWith.parallel || [])] : []
    state.history.push({ unit: state.units, kind, done: !!next.done, reason: next.reason, resetAt: next.resetAt, remaining, at: new Date().toISOString() })
    state.continueWith = next.continueWith || null
    state.done = !!next.done
    state.reason = next.reason || ''
    saveState(state)
    log(`shift ${state.units} (${kind}) done — ${next.reason || ''}; remaining: ${remaining.join(', ') || 'none'}`)
    if (kind === 'repair' && repoBroken()) { log('HARD BLOCKER: repo still broken after repair — stopping'); break }
  }
  if (devServer) devServer.kill()
}

main().catch((e) => { log(`nightshift crashed: ${e.stack || e}`); process.exit(1) })
