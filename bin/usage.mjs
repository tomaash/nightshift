#!/usr/bin/env node
/**
 * nightshift usage — read the account's rate-limit windows and act on them.
 *
 *   node usage.mjs probe                          print {window, utilization, resetsAt, threshold} of every window
 *   node usage.mjs wait  --max 0.9 [--max-five_hour 0.9] [--max-seven_day 0.98] [--control F]
 *                                                 block until every window is below ITS OWN threshold (a per-window
 *                                                 --max-<name> if given, else the flat --max), sleeping to the worst
 *                                                 offender's resetsAt + 3 min, then re-probes; clears the windDown
 *                                                 flag in --control when it returns
 *   node usage.mjs watch --max 0.9 [--max-five_hour 0.9] [--max-seven_day 0.98] --handoff DIR [--every 10]
 *                                                 the watchdog: probe every --every minutes; the first window at or
 *                                                 above ITS OWN threshold writes DIR/CONTROL.json {windDown:true,…}
 *                                                 so the running shift winds down gracefully (see workflows/shift.js
 *                                                 and the agent contract). Exits on SIGTERM. Logs one line per probe
 *                                                 to DIR/watchdog.log.
 *
 * Thresholds are PER WINDOW, not one number: a five-hour window empties every few hours and stopping work at 90% of
 * it costs little, but a seven-day window resets on its own schedule regardless — winding down a shift at 90% of
 * THAT one throws away real headroom for no reason. `--max-<window name>` overrides `--max` for that window only;
 * `--max` alone (the old, single-threshold behaviour) still works and applies to every window that has no override.
 *
 * The probe is one `claude -p` haiku call ("Nightshift radio check … Reply with exactly: LOUD AND CLEAR" — so it is legible as a READINESS PROBE in a session list, not mistaken for a stray test prompt); the stream carries `rate_limit_event` records with
 * per-window utilisation and reset time (five_hour, seven_day). It runs with `disableAllHooks`: the probe starts in the
 * project, so the project's SessionStart hook would otherwise inject and DELETE handoff.txt (every loop session then
 * started unbriefed), and its Stop hook could consume NEXT_SESSION and end the probe instead of the real session. Cost: negligible. A probe that returns no rate info
 * (offline, CLI change) is reported as such and never treated as "usage is fine".
 *
 * Installed into <project>/.claude/nightshift/ by `nightshift install`; shift-loop.sh calls it.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const MAX = Number(opt('--max', '0.9'))
// Per-window override: `--max-five_hour 0.9 --max-seven_day 0.98`. A window with no override uses MAX.
const thresholdFor = (name) => { const v = opt(`--max-${name}`, null); return v !== null ? Number(v) : MAX }
const REPO = opt('--repo', process.cwd())

// Never hangs: settles exactly once, at most ~135s from the call, no matter what the child process does (spawn
// failure, a wedged CLI that ignores SIGTERM, a 'close' that never fires). A watchdog loop depends on this.
export const probe = () => new Promise((res) => {
  let settled = false
  const done = (v) => { if (settled) return; settled = true; clearTimeout(hardTimer); res(v) }
  let child
  try {
    child = spawn('claude', ['-p', 'Nightshift radio check. Sound off if you read me. Reply with exactly: LOUD AND CLEAR', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--settings', '{"disableAllHooks":true}'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) { return done({ info: null, stderr: `spawn threw: ${e && e.message}` }) }
  let out = '', info = null, err = ''
  child.stdout.on('data', (d) => {
    out += d
    let idx
    while ((idx = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, idx); out = out.slice(idx + 1)
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info) info = ev.rate_limit_info
    }
  })
  child.stderr.on('data', (d) => { err += d })
  child.on('error', (e) => done({ info, stderr: `spawn error: ${e && e.message}` }))
  child.on('close', () => done({ info, stderr: err.slice(-500) }))
  const killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 120000)
  killTimer.unref()
  // Independent of the child's lifecycle entirely: guarantees probe() settles even if 'close' never fires
  // (a wedged process that survives SIGKILL on a hung syscall, or an event we didn't anticipate).
  const hardTimer = setTimeout(() => done({ info, stderr: 'probe timed out (135s) — treating as no rate info' }), 135000)
  hardTimer.unref()
})

export const windows = (info) => {
  const w = info && info.unifiedWindows
  if (!w) return []
  return Object.entries(w)
    .map(([name, v]) => ({ name, utilization: Number(v.utilization) || 0, resetsAt: Number(v.resetsAt) * 1000, threshold: thresholdFor(name) }))
    .sort((a, b) => b.utilization - a.utilization)
}
export const fullest = (info) => windows(info)[0] || null
// The window(s) at or above THEIR OWN threshold, worst (most over) first — never the flat-fullest window, which may
// simply have a looser threshold (seven_day at 91% is fine at a 98% threshold; five_hour at 85% is not at 80%).
export const overThreshold = (info) => {
  const over = windows(info).filter((w) => w.utilization >= w.threshold)
  over.sort((a, b) => (b.utilization - b.threshold) - (a.utilization - a.threshold))
  return over[0] || null
}
const pct = (u) => `${Math.round(u * 100)}%`
const fmt = (w) => w ? `${w.name} ${pct(w.utilization)} of ${pct(w.threshold)} threshold (resets ${new Date(w.resetsAt).toLocaleTimeString()})` : 'no rate info'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readControl = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }
const writeControl = (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n') }

const main = async () => {
  if (cmd === 'probe') {
    const { info, stderr } = await probe()
    const w = fullest(info)
    console.log(JSON.stringify(w ? { window: w.name, utilization: w.utilization, threshold: w.threshold, resetsAt: new Date(w.resetsAt).toISOString(), overThreshold: overThreshold(info), all: windows(info) } : { error: 'no rate info', stderr }))
    process.exit(w ? 0 : 2)
  }

  if (cmd === 'wait') {
    const control = opt('--control', null)
    for (let attempt = 0; ; attempt++) {
      const { info } = await probe()
      const w = fullest(info)
      if (!w) { console.log(`usage: no rate info (attempt ${attempt + 1}) — retrying in 5 min`); await sleep(5 * 60 * 1000); continue }
      const blocker = overThreshold(info)
      if (!blocker) {
        console.log(`usage: ${fmt(w)} — every window below its threshold, go`)
        if (control && existsSync(control)) { const c = readControl(control); if (c.windDown) writeControl(control, { ...c, windDown: false, clearedAt: new Date().toISOString() }) }
        process.exit(0)
      }
      const ms = Math.max(60 * 1000, blocker.resetsAt - Date.now() + 3 * 60 * 1000)
      console.log(`usage: ${fmt(blocker)} — at or above its threshold; sleeping ${Math.round(ms / 60000)} min to the reset`)
      await sleep(Math.min(ms, 60 * 60 * 1000)) // re-probe at least hourly: the worst window can change
    }
  }

  if (cmd === 'watch') {
    const handoff = opt('--handoff', null); if (!handoff) { console.error('watch needs --handoff DIR'); process.exit(1) }
    const every = Number(opt('--every', '10')) * 60 * 1000
    const windowNamesHint = () => ['five_hour', 'seven_day'].map((n) => `${n}=${pct(thresholdFor(n))}`).join(', ')
    const control = join(handoff, 'CONTROL.json')
    const log = (m) => { const line = `watchdog: ${new Date().toISOString()} ${m}`; console.log(line); try { appendFileSync(join(handoff, 'watchdog.log'), line + '\n') } catch {} }
    let stop = false
    process.on('SIGTERM', () => { stop = true; log('SIGTERM — exiting'); process.exit(0) })
    process.on('SIGINT', () => process.exit(0))
    log(`started (default max ${pct(MAX)}, per-window overrides: ${windowNamesHint()}, every ${every / 60000} min, control ${control})`)
    // Every iteration is independently guarded: one bad probe or a write failure must never silently end the
    // watchdog's life for the rest of the loop — the whole point of this process is to keep ticking unattended.
    while (!stop) {
      try {
        const { info } = await probe()
        const ws = windows(info)
        if (ws.length === 0) log('no rate info from the probe — not acting')
        else {
          const c = readControl(control)
          const blocker = overThreshold(info)
          if (blocker && !c.windDown) {
            writeControl(control, { windDown: true, reason: `usage ${fmt(blocker)} reached its wind-down threshold`, window: blocker.name, utilization: blocker.utilization, threshold: blocker.threshold, resetsAt: new Date(blocker.resetsAt).toISOString(), at: new Date().toISOString() })
            log(`WIND DOWN written — ${fmt(blocker)}`)
          } else log(`${ws.map(fmt).join('; ')}${c.windDown ? ' (wind-down already set)' : ''}`)
        }
      } catch (e) { log(`iteration error (continuing): ${e && e.message}`) }
      await sleep(every)
    }
  }

  if (!['probe', 'wait', 'watch'].includes(cmd)) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n').replace(/^ \*\s?/gm, '')); process.exit(1) }
}

main()
