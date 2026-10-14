#!/usr/bin/env bun
// One command for a live demo: a fresh database, the server, and a calm set of simulated
// sessions for three people. Ctrl+C stops everything.
//
//   bun run demo [--sessions 9] [--port 7430] [--db sphere_demo] [--history 5000] [--keep]
//
// --keep reuses the demo database instead of starting from an empty one. With PGHOST set to a
// socket directory (PGHOST=/var/run/postgresql), the server connects the way createdb does.
import { samplePage, startChrome } from './chrome'
import { linearStub, STUB_CLIENT } from './linear-stub'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1]! : fallback
}
const PORT = flag('port', '7430')
const SESSIONS = flag('sessions', '9')
const HISTORY = flag('history', '0')
const DB = flag('db', 'sphere_demo')
const root = `${import.meta.dir}/../`

if (!args.includes('--keep')) {
  Bun.spawnSync(['dropdb', '--if-exists', DB])
  const made = Bun.spawnSync(['createdb', DB], { stderr: 'pipe' })
  if (!made.success) {
    console.error(`createdb ${DB} failed: ${made.stderr.toString().trim()}`)
    process.exit(1)
  }
}

// The demo's tickets come from a stand-in for Linear, even with a real key in the environment.
const linear = linearStub({
  'CS-2199': { title: 'Autouse fixture leaks database state between tests', status: 'In Progress', assignee: 'Luca De Leo' },
  'CS-2210': { title: 'estra: cap review spend per ticket', status: 'In Review', assignee: 'Luca De Leo' },
  'CS-2231': { title: 'Advice matching v2: rank by embedding similarity', status: 'In Progress', assignee: 'JP Addison' },
  'CS-2240': { title: 'Rate-limit the public search endpoint', status: 'Todo', assignee: 'JP Addison' },
  'CS-2251': { title: 'Backfill career_stage for existing advisees', status: 'In Progress', assignee: 'Luca De Leo' },
})
// Browser cards show tabs of a Chrome of the demo's own (Playwright's Chromium), never yours.
const chrome = await startChrome()
const sample = chrome ? samplePage() : null
const env = {
  ...process.env,
  // Never a browser of yours from the environment: the demo's own, or none.
  SPHERE_BROWSER_PROFILE: chrome?.profile ?? '',
  DATABASE_URL: `postgres://localhost/${DB}${process.env.PGHOST?.startsWith('/') ? `?host=${encodeURIComponent(process.env.PGHOST)}` : ''}`,
  SPHERE_PORT: PORT,
  SPHERE_URL: `ws://127.0.0.1:${PORT}/ws`,
  SPHERE_LINEAR_KEY: 'demo',
  SPHERE_LINEAR_URL: linear.url,
  SPHERE_LINEAR_POLL_SECONDS: '10',
  // People connect their own (stand-in) Linear accounts, to change tickets as themselves.
  SPHERE_LINEAR_CLIENT_ID: STUB_CLIENT.id,
  SPHERE_LINEAR_CLIENT_SECRET: STUB_CLIENT.secret,
  SPHERE_LINEAR_TOKEN_KEY: 'demo-only-token-key-not-for-any-real-server',
}
const server = Bun.spawn(['bun', 'run', `${root}server/src/main.ts`], { env, stdout: 'inherit', stderr: 'inherit' })

let up = false
for (let i = 0; i < 50 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok
  } catch {}
  if (!up) await Bun.sleep(200)
}
if (!up) {
  console.error(`The server didn't start on port ${PORT}.`)
  server.kill()
  await chrome?.stop()
  process.exit(1)
}

// With tmux, luca's and jp's simulated sessions run in panes of the simulator's own tmux server,
// which their terminal cards show (scripts/simulate.ts --terminals).
const TMUX = !!Bun.which('tmux') && Bun.spawnSync(['tmux', '-V'], { stderr: 'ignore' }).success
const sim = Bun.spawn(['bun', 'run', `${root}scripts/simulate.ts`, '--sessions', SESSIONS, '--speed', '0.7', '--profile', 'demo', '--history', HISTORY, ...(TMUX ? ['--terminals'] : [])], { env, stdout: 'inherit', stderr: 'inherit' })

console.log(`
  Dyson Sphere demo

  Your view:        http://127.0.0.1:${PORT}/?token=dev-luca
  A teammate's:     http://127.0.0.1:${PORT}/?token=dev-jp      (open in a second browser window)

  Move a ticket in the stand-in Linear (cards follow within 10 s):
    curl -X POST ${linear.url.replace('/graphql', '/_set')} -d '{"id": "CS-2199", "status": "In Review"}'
  Add the ticket a branch names that Linear doesn't have yet (its sessions move to its frame):
    curl -X POST ${linear.url.replace('/graphql', '/_set')} -d '{"id": "CS-2263", "title": "Design tokens for onboarding"}'

  Terminals: select one of luca's or jp's sessions and press T.${TMUX ? '' : ' (Needs tmux, which this machine lacks.)'}
  Browser tabs: select one of your sessions and press B, then open ${sample ? sample.url : 'a page'}.${chrome ? '' : ' (Needs Chromium: bunx playwright install chromium.)'}
  Connect Linear from any session's inspector: the stand-in asks whom to sign in as.

  Add a real Claude Code session:
    SPHERE_URL=ws://127.0.0.1:${PORT}/ws SPHERE_TOKEN=dev-luca claude --plugin-dir ${root}mod

  Ctrl+C stops the demo.
`)

let stopping = false
const stop = async () => {
  stopping = true
  sim.kill('SIGINT') // the simulator marks its sessions ended
  await Promise.race([sim.exited, Bun.sleep(3500)])
  server.kill()
  await chrome?.stop()
  sample?.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const code = await server.exited
if (!stopping) {
  console.error(`The server stopped (exit ${code}); stopping the demo.`)
  sim.kill('SIGINT')
  await Promise.race([sim.exited, Bun.sleep(3500)])
  await chrome?.stop()
  sample?.stop()
  process.exit(code || 1)
}
