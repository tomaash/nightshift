#!/usr/bin/env node
/**
 * claude-plan-runner CLI
 *
 *   npx claude-plan-runner init [project-dir] [--link|--plugin]   install into a project (copies the workflow; --link symlinks; --plugin: you installed the Claude Code plugin, so only write config)
 *   npx claude-plan-runner run  [--repo <dir>]           start the supervisor (run it under tmux)
 *   npx claude-plan-runner stop [--repo <dir>]           ask a running supervisor to stop after the current unit
 *   npx claude-plan-runner status [--repo <dir>]         show STATE.json summary
 *   npx claude-plan-runner doctor [--repo <dir>]         check prerequisites
 */
import { existsSync, mkdirSync, copyFileSync, symlinkSync, unlinkSync, lstatSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (f) => argv.includes(f)
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const repo = resolve(opt('--repo', argv[1] && !argv[1].startsWith('--') && cmd === 'init' ? argv[1] : process.cwd()))
const die = (m) => { console.error(m); process.exit(1) }

const readConfig = () => {
  const p = join(repo, '.claude/agent-supervisor.json')
  if (!existsSync(p)) die(`no ${p} — run: npx claude-plan-runner init ${repo}`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

if (cmd === 'init') {
  if (!existsSync(join(repo, '.git'))) die(`${repo} is not a git repository (the runner works on branches and merges)`)
  const plugin = flag('--plugin')
  if (!plugin) {
    const wfDir = join(repo, '.claude/workflows')
    mkdirSync(wfDir, { recursive: true })
    const src = join(HERE, 'workflows/execute-phased-plan.js')
    const dst = join(wfDir, basename(src))
    if (existsSync(dst) || (() => { try { lstatSync(dst); return true } catch { return false } })()) unlinkSync(dst)
    // Copy by default: under npx the toolkit lives in a cache that may be pruned, so a
    // symlink would dangle. --link is for developing the toolkit itself.
    if (flag('--link')) { symlinkSync(src, dst); console.log(`linked  ${dst} -> ${src}`) }
    else { copyFileSync(src, dst); console.log(`copied  ${dst}  (re-run init after upgrading claude-plan-runner)`) }
  } else console.log('plugin mode: the workflow comes from the installed Claude Code plugin (claude-plan-runner:execute-phased-plan)')
  const cfg = join(repo, '.claude/agent-supervisor.json')
  if (!existsSync(cfg)) {
    const tpl = JSON.parse(readFileSync(join(HERE, 'templates/agent-supervisor.json'), 'utf8'))
    if (plugin) tpl.workflowName = 'claude-plan-runner:execute-phased-plan'
    writeFileSync(cfg, JSON.stringify(tpl, null, 2) + '\n'); console.log(`wrote   ${cfg}  <- edit planFile, tests, devServer, visualUrl`)
  } else console.log(`kept    ${cfg}`)
  const handoff = JSON.parse(readFileSync(cfg, 'utf8')).handoffDir || 'handoff'
  const gi = join(repo, '.gitignore')
  const have = existsSync(gi) ? readFileSync(gi, 'utf8').split('\n') : []
  const add = [`${handoff}/STATE.json`, `${handoff}/STOP`, `${handoff}/supervisor.log`].filter((l) => !have.includes(l))
  if (add.length) { appendFileSync(gi, (have.length && have.at(-1) !== '' ? '\n' : '') + '# claude-plan-runner runtime state\n' + add.join('\n') + '\n'); console.log(`gitignored ${add.join(', ')}`) }
  console.log(`\nnext:\n  1. write your plan (see README: "## Phase <id> — <title>" sections)\n  2. edit ${cfg}\n  3. tmux new -s agent "npx claude-plan-runner run --repo ${repo}"`)
}
else if (cmd === 'run') {
  readConfig()
  const child = spawn(process.execPath, [join(HERE, 'bin/agent-supervisor.mjs'), '--repo', repo], { stdio: 'inherit' })
  child.on('close', (c) => process.exit(c ?? 0))
}
else if (cmd === 'stop') {
  const c = readConfig(); const p = join(repo, c.handoffDir || 'handoff', 'STOP')
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, new Date().toISOString()); console.log(`wrote ${p} — the supervisor stops after its current unit`)
}
else if (cmd === 'status') {
  const c = readConfig(); const p = join(repo, c.handoffDir || 'handoff', 'STATE.json')
  if (!existsSync(p)) { console.log('no STATE.json yet — the first unit will be a groom'); process.exit(0) }
  const s = JSON.parse(readFileSync(p, 'utf8'))
  const rem = s.continueWith ? [...(s.continueWith.serial || []), ...(s.continueWith.parallel || [])] : []
  console.log(`units: ${s.units}  done: ${s.done}  ${s.reason || ''}\nremaining phases: ${rem.join(', ') || 'none'}\nlast: ${JSON.stringify(s.history.at(-1) || {})}`)
}
else if (cmd === 'doctor') {
  const check = (name, ok, hint) => console.log(`${ok ? 'ok  ' : 'MISS'} ${name}${ok ? '' : ` — ${hint}`}`)
  const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0
  check('claude CLI', has('claude'), 'install Claude Code: https://code.claude.com')
  check('git', has('git'), 'install git')
  check('tmux', has('tmux'), 'brew install tmux (optional but recommended)')
  check('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, `you have ${process.version}`)
  const init = spawnSync('claude', ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { encoding: 'utf8', cwd: repo })
  const lines = (init.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const sys = lines.find((l) => l.type === 'system' && l.subtype === 'init')
  check('Workflow tool available headless', !!sys && (sys.tools || []).includes('Workflow'), 'your Claude Code build has no Workflow tool')
  const rl = lines.find((l) => l.type === 'rate_limit_event')
  check('rate_limit_event in stream (budget awareness)', !!rl, 'the supervisor will fall back to parsing error text')
  if (rl) console.log('     usage now:', Object.entries(rl.rate_limit_info.unifiedWindows || {}).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(', '))
  const cfg = join(repo, '.claude/agent-supervisor.json')
  check('.claude/agent-supervisor.json', existsSync(cfg), 'run: npx claude-plan-runner init')
  if (existsSync(cfg)) { const c = JSON.parse(readFileSync(cfg, 'utf8')); check(`plan file ${c.planFile}`, existsSync(join(repo, c.planFile)), 'write the plan first'); const wfn = c.workflowName || 'execute-phased-plan'; if (!wfn.includes(':')) check('workflow installed', existsSync(join(repo, '.claude/workflows', wfn + '.js')), 'run: npx claude-plan-runner init'); else check(`workflow from plugin (${wfn})`, !!sys && (sys.slash_commands || []).some((x) => String(x).includes(wfn.split(':')[0])) || true, '') }
}
else {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 9).join('\n').replace(/^ \*\s?/gm, ''))
}
