#!/usr/bin/env node
/**
 * nightshift — hand Claude Code a written plan and go to sleep.
 *
 *   nightshift install [dir]   configure this project: config, plan detection, workflow, loop scripts + hooks, checks
 *   nightshift loop            one VISIBLE claude session per shift, forever, in tmux "shift-loop" (recommended)
 *                              --dry-run: two-session handoff-cycle test, no workflow   --fg: in this terminal
 *   nightshift run             headless supervisor in tmux "nightshift" (--fg: in this terminal)
 *   nightshift stop            graceful: the current shift/session finishes, then the loop/supervisor exits
 *   nightshift status          what is running, what is queued, what happened last
 *
 *   flags: --repo <dir>   --plugin (the workflow comes from the Claude Code plugin; copy nothing)
 *          --link (developing nightshift itself: symlink the workflow instead of copying)
 */
import { existsSync, mkdirSync, copyFileSync, symlinkSync, unlinkSync, lstatSync, readFileSync, writeFileSync, appendFileSync, readdirSync, chmodSync } from 'node:fs'
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
const LOOP_DIR = join(repo, '.claude/nightshift')
const tmuxHas = (session) => has('tmux') && spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0
// `tmux new-session -d` from inside tmux: drop $TMUX so tmux does not refuse to nest.
const tmuxDetached = (session, cmd) => spawnSync('env', ['-u', 'TMUX', 'tmux', 'new-session', '-d', '-s', session, '-c', repo, cmd], { stdio: 'inherit' })

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

  // 3. loop mode: scripts + seeds into .claude/nightshift/, hooks into .claude/settings.json, the /handoff skill
  const handoff = cfg.handoffDir || 'handoff'
  const wfName = cfg.workflowName || (plugin ? 'nightshift:shift' : 'shift')
  mkdirSync(LOOP_DIR, { recursive: true })
  const fill = (t) => t.replaceAll('{{HANDOFF}}', handoff).replaceAll('{{PLAN}}', cfg.planFile).replaceAll('{{WORKFLOW}}', wfName)
  for (const f of ['shift-loop.sh', 'shift-stop-hook.sh', 'shift-seed.md', 'shift-seed-dryrun.md']) {
    const dst = join(LOOP_DIR, f)
    writeFileSync(dst, fill(readFileSync(join(HERE, 'templates', f), 'utf8')))
    if (f.endsWith('.sh')) chmodSync(dst, 0o755)
  }
  out('loop', `scripts + seeds in ${LOOP_DIR} (workflow ${wfName}; re-run install after editing the config)`)
  const settingsPath = join(repo, '.claude/settings.json')
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
  settings.hooks ||= {}
  const want = JSON.parse(readFileSync(join(HERE, 'templates/hooks.json'), 'utf8')).hooks
  const added = []
  for (const [event, entries] of Object.entries(want)) {
    settings.hooks[event] ||= []
    for (const entry of entries) {
      const cmds = entry.hooks.map((h) => h.command)
      const present = settings.hooks[event].some((e) => (e.hooks || []).some((h) => cmds.includes(h.command)))
      if (!present) { settings.hooks[event].push(entry); added.push(event) }
    }
  }
  if (added.length) { writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n'); out('hooks', `added ${added.join(' + ')} to ${settingsPath}`) }
  else out('hooks', `SessionStart + Stop already in ${settingsPath}`)
  const skillDst = join(repo, '.claude/skills/handoff/SKILL.md')
  if (existsSync(skillDst)) out('skill', `kept ${skillDst}`)
  else { mkdirSync(dirname(skillDst), { recursive: true }); copyFileSync(join(HERE, 'templates/skills/handoff/SKILL.md'), skillDst); out('skill', `/handoff copied to ${skillDst}`) }

  // 4. gitignore runtime files
  const gi = join(repo, '.gitignore')
  const have = existsSync(gi) ? readFileSync(gi, 'utf8').split('\n') : []
  const add = [`${handoff}/STATE.json`, `${handoff}/STOP`, `${handoff}/nightshift.log`, `${handoff}/NEXT_SESSION`, `${handoff}/shift-loop.log`, 'handoff.txt'].filter((l) => !have.includes(l))
  if (add.length) { appendFileSync(gi, (have.length && have.at(-1) !== '' ? '\n' : '') + '# nightshift runtime state\n' + add.join('\n') + '\n'); out('gitignore', add.join(', ')) }

  // 5. prerequisites
  console.log()
  const check = (name, ok, hint) => console.log(`${ok ? 'ok  ' : 'MISS'} ${name}${ok ? '' : ` — ${hint}`}`)
  check('claude CLI', has('claude'), 'install Claude Code: https://code.claude.com')
  check('git', has('git'), 'install git')
  check('tmux', has('tmux'), 'brew install tmux — without it `nightshift loop` / `run` stay in the foreground')
  check('jq (SessionStart hook)', has('jq'), 'brew install jq — the hook that injects handoff.txt needs it')
  check('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, `you have ${process.version}`)
  const trusted = (() => { try { return !!JSON.parse(readFileSync(join(process.env.HOME || '', '.claude.json'), 'utf8')).projects?.[repo]?.hasTrustDialogAccepted } catch { return false } })()
  check('project trusted by Claude Code', trusted, `run \`claude\` once in ${repo} and accept the trust prompt, or the loop's sessions exit at the dialog`)
  if (has('claude')) {
    const probe = spawnSync('claude', ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { encoding: 'utf8', cwd: repo })
    const lines = (probe.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const sys = lines.find((l) => l.type === 'system' && l.subtype === 'init')
    check('Workflow tool available headless', !!sys && (sys.tools || []).includes('Workflow'), 'your Claude Code build has no Workflow tool')
    const rl = lines.find((l) => l.type === 'rate_limit_event')
    check('usage signal (rate_limit_event)', !!rl, 'nightshift will fall back to parsing error text')
    if (rl) console.log('     usage now:', Object.entries(rl.rate_limit_info.unifiedWindows || {}).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(', '))
  }
  const cli = (v) => plugin ? `/nightshift ${v}` : `nightshift ${v}${repo !== process.cwd() ? ` --repo ${repo}` : ''}`
  console.log(`\nnext: ${cli('loop')}   (watch the agents; fresh context every shift)\n      ${cli('loop --dry-run')} tests the handoff cycle first; ${cli('run')} is the headless fallback`)
}

// --- run ------------------------------------------------------------------------------------

const run = () => {
  const c = readConfig()
  const inline = () => {
    const child = spawn(process.execPath, [join(HERE, 'bin/supervisor.mjs'), '--repo', repo], { stdio: 'inherit' })
    child.on('close', (code) => process.exit(code ?? 0))
  }
  if (flag('--fg') || !has('tmux')) {
    if (!flag('--fg')) console.error('tmux not found — running in the foreground; keep this terminal open')
    return inline()
  }
  const session = 'nightshift'
  if (tmuxHas(session)) die(`a tmux session "${session}" already exists — tmux attach -t ${session}, or nightshift stop`)
  if (tmuxHas('shift-loop')) die('the loop is running (tmux session "shift-loop") — do not run both; nightshift stop first')
  const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'bin/cli.mjs'))} run --fg --repo ${JSON.stringify(repo)}`
  const t = tmuxDetached(session, inner)
  if (t.status !== 0) die('could not start tmux session')
  console.log(`nightshift is running in tmux session "${session}".\n  watch:  tail -f ${join(handoffOf(c), 'nightshift.log')}\n  attach: tmux attach -t ${session}\n  stop:   nightshift stop`)
}

// --- loop: one visible claude session per shift --------------------------------------------------

const loop = () => {
  const c = readConfig()
  const script = join(LOOP_DIR, 'shift-loop.sh')
  if (!existsSync(script)) die(`no ${script} — run: nightshift install`)
  const seed = flag('--dry-run') ? join(LOOP_DIR, 'shift-seed-dryrun.md') : join(LOOP_DIR, 'shift-seed.md')
  const stop = join(handoffOf(c), 'STOP')
  if (existsSync(stop)) die(`${stop} exists — remove it first (the loop refuses to start while it is there)`)
  const inner = `${JSON.stringify(script)} ${JSON.stringify(seed)}`
  if (flag('--fg') || !has('tmux')) {
    if (!flag('--fg')) console.error('tmux not found — running in the foreground; keep this terminal open')
    const child = spawn('sh', ['-c', inner], { stdio: 'inherit', cwd: repo })
    return child.on('close', (code) => process.exit(code ?? 0))
  }
  const session = 'shift-loop'
  if (tmuxHas(session)) die(`a tmux session "${session}" already exists — tmux attach -t ${session}, or nightshift stop`)
  if (tmuxHas('nightshift')) die('the headless supervisor is running (tmux session "nightshift") — do not run both; nightshift stop first')
  const t = tmuxDetached(session, inner)
  if (t.status !== 0) die('could not start tmux session')
  const log = join(handoffOf(c), 'shift-loop.log')
  console.log(`nightshift loop${flag('--dry-run') ? ' (DRY RUN: two sessions, no workflow)' : ''} is running in tmux session "${session}".\n  watch:  tmux attach -t ${session}   (detach: Ctrl-b d)\n  log:    tail -f ${log}\n  stop:   nightshift stop   (the current session finishes its shift, then the loop exits)`)
}

// --- dispatch ----------------------------------------------------------------------------------

if (cmd === 'install' || cmd === 'init' || cmd === 'doctor') install()
else if (cmd === 'run') run()
else if (cmd === 'loop') loop()
else if (cmd === 'stop') {
  const p = join(handoffOf(readConfig()), 'STOP')
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, new Date().toISOString())
  const what = [tmuxHas('shift-loop') && 'the loop (tmux: shift-loop) exits after the current session finishes its shift', tmuxHas('nightshift') && 'the supervisor (tmux: nightshift) exits after the current shift'].filter(Boolean)
  console.log(`wrote ${p} — ${what.join('; ') || 'nothing is running in tmux; remove the file before the next loop/run'}`)
}
else if (cmd === 'status') {
  const c = readConfig()
  const live = [tmuxHas('shift-loop') && 'loop (tmux: shift-loop)', tmuxHas('nightshift') && 'supervisor (tmux: nightshift)'].filter(Boolean)
  const stopped = existsSync(join(handoffOf(c), 'STOP')) ? '  STOP file present' : ''
  const p = join(handoffOf(c), 'STATE.json')
  if (!existsSync(p)) { console.log(`${live.length ? 'running: ' + live.join(', ') : 'not running'}${stopped}\nno STATE.json yet — the first shift will be a groom`); process.exit(0) }
  const s = JSON.parse(readFileSync(p, 'utf8'))
  const rem = s.continueWith ? [...(s.continueWith.serial || []), ...(s.continueWith.parallel || [])] : []
  console.log(`${live.length ? 'running: ' + live.join(', ') : 'not running'}${stopped}  shifts: ${s.units}  done: ${s.done}  ${s.reason || ''}\nremaining phases: ${rem.join(', ') || 'none'}\nlast: ${JSON.stringify((s.history || []).at(-1) || {})}`)
}
else console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 13).join('\n').replace(/^ \*\s?/gm, ''))
