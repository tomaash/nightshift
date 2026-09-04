#!/usr/bin/env node
/**
 * nightshift — hand Claude Code a written plan and go to sleep.
 *
 *   nightshift install [dir]   configure this project: config, plan detection, workflow, prerequisite checks
 *   nightshift run             start the supervisor in a tmux session named "nightshift" (--fg: in this terminal)
 *   nightshift stop            graceful: finishes the current shift, then exits
 *   nightshift status          what is queued, what happened last
 *
 *   flags: --repo <dir>   --plugin (the workflow comes from the Claude Code plugin; copy nothing)
 *          --link (developing nightshift itself: symlink the workflow instead of copying)
 */
import { existsSync, mkdirSync, copyFileSync, symlinkSync, unlinkSync, lstatSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (f) => argv.includes(f)
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const repo = resolve(opt('--repo', cmd === 'install' && argv[1] && !argv[1].startsWith('--') ? argv[1] : process.cwd()))
const CFG = join(repo, '.claude/nightshift.json')
const WORKFLOW_FILE = 'shift.js'
const die = (m) => { console.error(m); process.exit(1) }
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0

const readConfig = () => {
  if (!existsSync(CFG)) die(`no ${CFG} — run: nightshift install`)
  return JSON.parse(readFileSync(CFG, 'utf8'))
}
const handoffOf = (c) => join(repo, c.handoffDir || 'handoff')

// --- install --------------------------------------------------------------------------------

const detectPlan = () => {
  const md = readdirSync(repo).filter((f) => /^[^.].*\.md$/i.test(f))
  if (md.includes('PLAN.md')) return 'PLAN.md'
  const cands = md.filter((f) => /PLAN/i.test(f))
  return cands.length === 1 ? cands[0] : null
}

const install = () => {
  if (!existsSync(join(repo, '.git'))) die(`${repo} is not a git repository (nightshift works on branches and merges)`)
  const plugin = flag('--plugin')
  const out = (k, v) => console.log(`${k.padEnd(11)}${v}`)

  // 1. workflow
  if (plugin) out('workflow', 'from the nightshift plugin (nightshift:shift) — nothing copied')
  else {
    const wfDir = join(repo, '.claude/workflows'); mkdirSync(wfDir, { recursive: true })
    const src = join(HERE, 'workflows', WORKFLOW_FILE), dst = join(wfDir, WORKFLOW_FILE)
    try { lstatSync(dst); unlinkSync(dst) } catch {}
    // Copy by default: under npx the toolkit lives in a cache that may be pruned, so a symlink would dangle.
    if (flag('--link')) { symlinkSync(src, dst); out('workflow', `linked ${dst} -> ${src}`) }
    else { copyFileSync(src, dst); out('workflow', `copied to ${dst} (re-run install after upgrading nightshift)`) }
  }

  // 2. config + plan
  let cfg
  mkdirSync(dirname(CFG), { recursive: true })
  if (existsSync(CFG)) { cfg = JSON.parse(readFileSync(CFG, 'utf8')); out('config', `kept ${CFG}`) }
  else {
    cfg = JSON.parse(readFileSync(join(HERE, 'templates/nightshift.json'), 'utf8'))
    if (plugin) cfg.workflowName = 'nightshift:shift'
    const plan = detectPlan()
    if (plan) cfg.planFile = plan
    writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n')
    out('config', `wrote ${CFG} — check tests, devServer, visualUrl`)
  }
  const planPath = join(repo, cfg.planFile)
  out('plan', existsSync(planPath) ? `${cfg.planFile}` : `${cfg.planFile} NOT FOUND — write it, or set planFile in ${CFG}`)
  if (existsSync(planPath) && !/^## Phase \S+ [—-] /m.test(readFileSync(planPath, 'utf8'))) out('plan', `WARN ${cfg.planFile} has no "## Phase <id> — <title>" sections (see docs/PLAN-FORMAT.md)`)

  // 3. gitignore runtime files
  const handoff = cfg.handoffDir || 'handoff'
  const gi = join(repo, '.gitignore')
  const have = existsSync(gi) ? readFileSync(gi, 'utf8').split('\n') : []
  const add = [`${handoff}/STATE.json`, `${handoff}/STOP`, `${handoff}/nightshift.log`].filter((l) => !have.includes(l))
  if (add.length) { appendFileSync(gi, (have.length && have.at(-1) !== '' ? '\n' : '') + '# nightshift runtime state\n' + add.join('\n') + '\n'); out('gitignore', add.join(', ')) }

  // 4. prerequisites
  console.log()
  const check = (name, ok, hint) => console.log(`${ok ? 'ok  ' : 'MISS'} ${name}${ok ? '' : ` — ${hint}`}`)
  check('claude CLI', has('claude'), 'install Claude Code: https://code.claude.com')
  check('git', has('git'), 'install git')
  check('tmux', has('tmux'), 'brew install tmux — without it `nightshift run` stays in the foreground')
  check('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, `you have ${process.version}`)
  if (has('claude')) {
    const probe = spawnSync('claude', ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { encoding: 'utf8', cwd: repo })
    const lines = (probe.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const sys = lines.find((l) => l.type === 'system' && l.subtype === 'init')
    check('Workflow tool available headless', !!sys && (sys.tools || []).includes('Workflow'), 'your Claude Code build has no Workflow tool')
    const rl = lines.find((l) => l.type === 'rate_limit_event')
    check('usage signal (rate_limit_event)', !!rl, 'nightshift will fall back to parsing error text')
    if (rl) console.log('     usage now:', Object.entries(rl.rate_limit_info.unifiedWindows || {}).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(', '))
  }
  console.log(`\nnext: ${plugin ? '/nightshift run' : `nightshift run${repo !== process.cwd() ? ` --repo ${repo}` : ''}`}`)
}

// --- run ------------------------------------------------------------------------------------

const run = () => {
  const c = readConfig()
  const inline = () => {
    const child = spawn(process.execPath, [join(HERE, 'bin/supervisor.mjs'), '--repo', repo], { stdio: 'inherit' })
    child.on('close', (code) => process.exit(code ?? 0))
  }
  if (flag('--fg') || process.env.TMUX || !has('tmux')) {
    if (!flag('--fg') && !process.env.TMUX) console.error('tmux not found — running in the foreground; keep this terminal open')
    return inline()
  }
  const session = 'nightshift'
  if (spawnSync('tmux', ['has-session', '-t', session]).status === 0) die(`a tmux session "${session}" already exists — tmux attach -t ${session}, or nightshift stop`)
  const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'bin/cli.mjs'))} run --fg --repo ${JSON.stringify(repo)}`
  const t = spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', repo, inner], { stdio: 'inherit' })
  if (t.status !== 0) die('could not start tmux session')
  console.log(`nightshift is running in tmux session "${session}".\n  watch:  tail -f ${join(handoffOf(c), 'nightshift.log')}\n  attach: tmux attach -t ${session}\n  stop:   nightshift stop`)
}

// --- dispatch ----------------------------------------------------------------------------------

if (cmd === 'install' || cmd === 'init' || cmd === 'doctor') install()
else if (cmd === 'run') run()
else if (cmd === 'stop') {
  const p = join(handoffOf(readConfig()), 'STOP')
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, new Date().toISOString())
  console.log(`wrote ${p} — nightshift stops after its current shift`)
}
else if (cmd === 'status') {
  const p = join(handoffOf(readConfig()), 'STATE.json')
  if (!existsSync(p)) { console.log('no STATE.json yet — the first shift will be a groom'); process.exit(0) }
  const s = JSON.parse(readFileSync(p, 'utf8'))
  const rem = s.continueWith ? [...(s.continueWith.serial || []), ...(s.continueWith.parallel || [])] : []
  const live = has('tmux') && spawnSync('tmux', ['has-session', '-t', 'nightshift']).status === 0
  console.log(`${live ? 'running (tmux: nightshift)' : 'not running'}  shifts: ${s.units}  done: ${s.done}  ${s.reason || ''}\nremaining phases: ${rem.join(', ') || 'none'}\nlast: ${JSON.stringify(s.history.at(-1) || {})}`)
}
else console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 11).join('\n').replace(/^ \*\s?/gm, ''))
