#!/usr/bin/env node
/**
 * nightshift usage — read the account's rate-limit windows and act on them.
 *
 *   node usage.mjs probe                          print {window, utilization, resetsAt} of the fullest window
 *   node usage.mjs wait  --max 0.9 [--control F]  block until every window is below --max (sleeps to resetsAt + 3 min,
 *                                                 then re-probes); clears the windDown flag in --control when it returns
 *   node usage.mjs watch --max 0.9 --handoff DIR [--every 10]
 *                                                 the watchdog: probe every --every minutes; at or above --max write
 *                                                 DIR/CONTROL.json {windDown:true,…} so the running shift winds down
 *                                                 gracefully (see workflows/shift.js and the agent contract). Exits on
 *                                                 SIGTERM. Logs one line per probe to DIR/watchdog.log.
 *
 * The probe is one `claude -p` haiku call ("Reply with exactly: ok"); the stream carries `rate_limit_event` records with
 * per-window utilisation and reset time (five_hour, seven_day). Cost: negligible. A probe that returns no rate info
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
const REPO = opt('--repo', process.cwd())

export const probe = () => new Promise((res) => {
  const child = spawn('claude', ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
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
  child.on('close', () => res({ info, stderr: err.slice(-500) }))
  setTimeout(() => { try { child.kill() } catch {} }, 120000).unref()
})

export const windows = (info) => {
  const w = info && info.unifiedWindows
  if (!w) return []
  return Object.entries(w).map(([name, v]) => ({ name, utilization: Number(v.utilization) || 0, resetsAt: Number(v.resetsAt) * 1000 })).sort((a, b) => b.utilization - a.utilization)
}
export const fullest = (info) => windows(info)[0] || null
const pct = (u) => `${Math.round(u * 100)}%`
const fmt = (w) => w ? `${w.name} ${pct(w.utilization)} (resets ${new Date(w.resetsAt).toLocaleTimeString()})` : 'no rate info'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readControl = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }
const writeControl = (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n') }

const main = async () => {
  if (cmd === 'probe') {
    const { info, stderr } = await probe()
    const w = fullest(info)
    console.log(JSON.stringify(w ? { window: w.name, utilization: w.utilization, resetsAt: new Date(w.resetsAt).toISOString(), all: windows(info) } : { error: 'no rate info', stderr }))
    process.exit(w ? 0 : 2)
  }

  if (cmd === 'wait') {
    const control = opt('--control', null)
    for (let attempt = 0; ; attempt++) {
      const { info } = await probe()
      const w = fullest(info)
      if (!w) { console.log(`usage: no rate info (attempt ${attempt + 1}) — retrying in 5 min`); await sleep(5 * 60 * 1000); continue }
      if (w.utilization < MAX) {
        console.log(`usage: ${fmt(w)} — below ${pct(MAX)}, go`)
        if (control && existsSync(control)) { const c = readControl(control); if (c.windDown) writeControl(control, { ...c, windDown: false, clearedAt: new Date().toISOString() }) }
        process.exit(0)
      }
      const ms = Math.max(60 * 1000, w.resetsAt - Date.now() + 3 * 60 * 1000)
      console.log(`usage: ${fmt(w)} — at or above ${pct(MAX)}; sleeping ${Math.round(ms / 60000)} min to the reset`)
      await sleep(Math.min(ms, 60 * 60 * 1000)) // re-probe at least hourly: the fullest window can change
    }
  }

  if (cmd === 'watch') {
    const handoff = opt('--handoff', null); if (!handoff) { console.error('watch needs --handoff DIR'); process.exit(1) }
    const every = Number(opt('--every', '10')) * 60 * 1000
    const control = join(handoff, 'CONTROL.json')
    const log = (m) => { const line = `watchdog: ${new Date().toISOString()} ${m}`; console.log(line); try { appendFileSync(join(handoff, 'watchdog.log'), line + '\n') } catch {} }
    let stop = false
    process.on('SIGTERM', () => { stop = true; log('SIGTERM — exiting'); process.exit(0) })
    process.on('SIGINT', () => process.exit(0))
    log(`started (max ${pct(MAX)}, every ${every / 60000} min, control ${control})`)
    while (!stop) {
      const { info } = await probe()
      const w = fullest(info)
      if (!w) log('no rate info from the probe — not acting')
      else {
        const c = readControl(control)
        if (w.utilization >= MAX && !c.windDown) {
          writeControl(control, { windDown: true, reason: `usage ${fmt(w)} reached the ${pct(MAX)} wind-down threshold`, window: w.name, utilization: w.utilization, resetsAt: new Date(w.resetsAt).toISOString(), at: new Date().toISOString() })
          log(`WIND DOWN written — ${fmt(w)}`)
        } else log(`${fmt(w)}${c.windDown ? ' (wind-down already set)' : ''}`)
      }
      await sleep(every)
    }
  }

  if (!['probe', 'wait', 'watch'].includes(cmd)) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n').replace(/^ \*\s?/gm, '')); process.exit(1) }
}

main()
