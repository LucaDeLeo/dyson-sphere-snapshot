#!/usr/bin/env bun
// Simulated sessions for developing and testing the canvas without running Claude Code.
//
//   bun scripts/simulate.ts [--sessions 18] [--speed 1] [--history 5000]
//
// --history N gives the first session N rows of earlier history, for long transcripts. The last
// session runs as Codex, with its shell commands and patches.
//
// Each simulated session is a fake bridge: it streams prompts, tool calls, results and
// replies, asks for permission now and then, and answers steering and permission commands
// the way the real mod does. Every simulated session runs on a machine named "sim-<owner>".
// Ctrl+C ends them all.
//
// --terminals: luca's and jp's sessions run on this machine instead, each in a tmux pane of a tmux
// server of the simulator's own (a shell in a scratch folder), which their terminal cards show
// and their owner can type into, as a real bridge relays it.
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTicket, topics, type SessionCommand, type SessionLabels } from '../shared/protocol'
import { validSize } from '../shared/terminal'
import { Client, loadConfig } from '../sphere/src/client'
import { TmuxPane, type PaneTarget } from '../sphere/src/terminal'

const args = process.argv.slice(2)
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const COUNT = flag('sessions', 18)
const SPEED = flag('speed', 1)
const HISTORY = flag('history', 0)
// --profile demo: realistic repos and tasks for showing it to people. The default profile
// includes awkward data (very long names, Chinese text, emoji) for testing the layout.
const DEMO = args.includes('--profile') && args[args.indexOf('--profile') + 1] === 'demo'
const TERMINALS = args.includes('--terminals')

const OWNERS = [
  { token: 'dev-luca', name: 'luca' },
  { token: 'dev-jp', name: 'jp' },
  { token: 'dev-bot', name: 'ops-bot' },
]
const REPOS = [
  { repo: 'minerva', branches: ['main', 'cs-2199-autouse-fixture', 'jp/advice-matching-v2'] },
  { repo: 'career-guide-api', branches: ['main', 'feat/rate-limits'] },
  { repo: 'dyson-sphere', branches: ['main', 'canvas-polish'] },
  { repo: 'an-internal-repository-with-a-really-long-name-for-testing', branches: ['main'] },
  { repo: 'onboarding-web', branches: ['main', 'fix/ünïcödé-slugs'] },
]
const TASKS = [
  'Fix the flaky auth test in tests/api/test_login.py and make it deterministic',
  'Add rate limiting to the public search endpoint',
  'Refactor the advice matcher to use the new embeddings table',
  'Write a migration that backfills career_stage for all existing advisees, then verify on staging',
  'Investigate why the nightly export job takes 40 minutes',
  '修复用户资料页面上的日期格式问题',
  'Review PR #482 and leave comments on anything risky 🚦',
  'Bump React to 19.3 and fix the type errors',
  'Draft release notes for v2026.10.1 from the merged PRs',
  'Trace the 502s on /api/sessions back to their cause and propose a fix with a test that reproduces it first',
  'Clean up unused feature flags',
  'Port the onboarding checklist to the new design tokens',
]
// Branches named after tickets put sessions in their tickets' frames; `bun run demo` serves
// those tickets from a stand-in for Linear (scripts/linear-stub.ts). It has no CS-2263, so
// that branch's sessions stay in their repo's frame, as with a real branch Linear has no issue for.
const DEMO_REPOS = [
  { repo: 'minerva', branches: ['main', 'luca/cs-2199-autouse-fixture', 'jp/cs-2231-advice-matching-v2'] },
  { repo: 'career-guide-api', branches: ['main', 'jp/cs-2240-rate-limits'] },
  { repo: 'estra', branches: ['main', 'luca/cs-2210-review-budget'] },
  { repo: 'onboarding-web', branches: ['main', 'luca/cs-2263-design-tokens'] },
]
/** The demo's ops-bot sessions are estra's stages of one ticket, labelled as estra labels them. */
const DEMO_STAGES: SessionLabels[] = ['plan', 'code', 'review'].map((stage, i) => ({ ticket: 'CS-2251', stage, taskId: 'task-2251', provider: i === 1 ? 'codex' : 'claude' }))
const DEMO_TASKS = [
  'Fix the flaky auth test in tests/api/test_login.py and make it deterministic',
  'Add rate limiting to the public search endpoint',
  'Refactor the advice matcher to use the new embeddings table',
  'Backfill career_stage for existing advisees, then verify on staging',
  'Investigate why the nightly export job takes 40 minutes',
  'Review PR #482 and leave comments on anything risky',
  'Port the onboarding checklist to the new design tokens',
  'Draft release notes for v2026.10.1 from the merged PRs',
  'Trace the 502s on /api/sessions back to their cause',
]
const FILES = ['src/auth/session.ts', 'tests/api/test_login.py', 'server/src/world.ts', 'web/src/App.tsx', 'docs/architecture.md', 'migrations/0042_career_stage.sql', 'package.json']
const EDITS = [
  { old: 'const now = Date.now()\nexpect(session.expiresAt).toBeGreaterThan(now)', new: 'const clock = freezeClock("2026-10-10T12:00:00Z")\nexpect(session.expiresAt).toBeGreaterThan(clock.now())\nclock.restore()' },
  { old: 'export const LIMIT = 100', new: '/** Requests per minute per token. */\nexport const LIMIT = 60\nexport const BURST = 10' },
]
const TODOS = ['Reproduce the failure', 'Find the cause', 'Write a failing test', 'Fix it', 'Run the suite']
/** Simulated tools: the input a call gets, the text its result shows, and the structured output newer mods send. */
const TOOLS: { name: string; input: () => Record<string, unknown>; result: (input: Record<string, any>) => string; output?: (input: Record<string, any>) => unknown; slow?: boolean }[] = [
  { name: 'Read', input: () => ({ file_path: `/Users/dev/${pick(FILES)}` }), result: () => '1  import { describe } from "vitest"\n2  …', output: () => ({ type: 'text', file: { numLines: 2, startLine: 1, totalLines: 214 } }) },
  { name: 'Grep', input: () => ({ pattern: pick(['session.append', 'TODO', 'rateLimit', 'career_stage']), output_mode: 'files_with_matches' }), result: () => `Found 3 files\nsrc/auth/session.ts\nserver/src/world.ts\nweb/src/App.tsx`, output: () => ({ mode: 'files_with_matches', numFiles: 3, filenames: ['src/auth/session.ts', 'server/src/world.ts', 'web/src/App.tsx'] }) },
  { name: 'Glob', input: () => ({ pattern: pick(['**/*.test.ts', 'migrations/*.sql']) }), result: () => 'tests/api/login.test.ts\ntests/api/search.test.ts', output: () => ({ numFiles: 2, filenames: ['tests/api/login.test.ts', 'tests/api/search.test.ts'], truncated: false }) },
  {
    name: 'Edit',
    input: () => {
      const e = pick(EDITS)
      return { file_path: `/Users/dev/${pick(FILES)}`, old_string: e.old, new_string: e.new }
    },
    result: i => `The file ${i.file_path} has been updated successfully.`,
    output: i => ({ filePath: i.file_path, structuredPatch: [{ oldStart: 41, oldLines: i.old_string.split('\n').length, newStart: 41, newLines: i.new_string.split('\n').length, lines: [...i.old_string.split('\n').map((l: string) => `-${l}`), ...i.new_string.split('\n').map((l: string) => `+${l}`)] }], userModified: false, replaceAll: false }),
  },
  { name: 'Write', input: () => ({ file_path: '/Users/dev/migrations/0043_rate_limits.sql', content: 'create table rate_limits (\n  token text primary key,\n  window_start timestamptz not null,\n  count int not null default 0\n);\n' }), result: i => `File created successfully at: ${i.file_path}`, output: i => ({ type: 'create', filePath: i.file_path, structuredPatch: [] }) },
  {
    name: 'Bash',
    input: () => ({ command: pick(['bun test', 'pytest -q tests/api', 'git diff --stat', 'npm run typecheck', 'psql -c "select count(*) from advisees"']), description: 'Run it' }),
    result: () => pick(['12 passed', '1 failed, 11 passed', ' 3 files changed, 41 insertions(+), 9 deletions(-)']),
    output: () => ({ stdout: pick(['12 passed in 3.1s', ' 3 files changed, 41 insertions(+), 9 deletions(-)']), stderr: '', interrupted: false }),
    slow: true,
  },
  { name: 'TodoWrite', input: () => ({ todos: TODOS.map((content, i) => ({ content, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending', activeForm: content })) }), result: () => 'Todos have been modified successfully.', output: i => ({ newTodos: i.todos }) },
  { name: 'WebFetch', input: () => ({ url: 'https://docs.example.com/rate-limits', prompt: 'How are limits counted?' }), result: () => 'Limits are counted per token over a sliding minute.', output: () => ({ bytes: 18_204, code: 200, codeText: 'OK', durationMs: 412, url: 'https://docs.example.com/rate-limits' }) },
  { name: 'Agent', input: () => ({ description: 'Explore the auth module', prompt: 'Find every caller', subagent_type: 'Explore' }), result: () => 'Found 7 callers', slow: true },
]
const CODEX_TOOLS: typeof TOOLS = [
  { name: 'Bash', input: () => ({ command: ['/bin/bash', '-lc', pick(['rg -n "rateLimit" src', 'cargo test -q', 'git status --short'])] }), result: () => 'src/api/search.ts:41: rateLimit(60)', output: () => ({ output: 'src/api/search.ts:41: rateLimit(60)\n', exit_code: 0 }) },
  {
    name: 'apply_patch',
    input: () => ({ input: '*** Begin Patch\n*** Update File: src/api/search.ts\n@@ export function search(\n-  return rateLimit(100)\n+  return rateLimit(60, { burst: 10 })\n*** Add File: src/api/limits.ts\n+export const LIMIT = 60\n+export const BURST = 10\n*** End Patch' }),
    result: () => 'Success. Updated the following files:\nM src/api/search.ts\nA src/api/limits.ts',
  },
  { name: 'update_plan', input: () => ({ plan: [{ step: 'Find the endpoint', status: 'completed' }, { step: 'Add the limit', status: 'in_progress' }, { step: 'Test it', status: 'pending' }].map(p => ({ content: p.step, status: p.status })) }), result: () => 'Plan updated' },
]
const LONG_REPLIES = [
  'Found it. The flaky test compared `expires_at` with a time taken before the session was made, so it failed whenever the day changed in between.\n\nI switched it to the `frozen_clock` fixture:\n\n```py\ndef test_session_expiry(frozen_clock):\n    session = make_session()\n    assert session.expires_at == frozen_clock.now() + SESSION_TTL\n```\n\nThe suite passes 50 runs in a row now. **One question:** should the fixture move to `tests/conftest.py` so the other auth tests can use it?',
  'The export is slow because it reads `events` without an index on `topic`, so every batch scans the whole table.\n\n| Step | Before | After |\n|---|---|---|\n| Query | 38 min | 41 s |\n| Memory | 2.1 GB | 310 MB |\n\nI added the index in a migration and checked the plan on a copy of production. Ready for review.',
]
const THOUGHTS = [
  'The test fails only around midnight UTC, so it probably compares a date computed before and after the day changes. I should look at how `expiresAt` is built.',
  'Two options: add the limit in the middleware, or in the handler. The middleware sees every route, which is what the ticket asks for.',
  'The export query scans `events` without an index on `topic`. Before changing it, I want the query plan to confirm.',
]
function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!
}
function rand(a: number, b: number) {
  return a + Math.floor(Math.random() * (b - a + 1))
}
const sleep = (ms: number) => Bun.sleep(ms / SPEED)
const key = () => crypto.randomUUID()

type Sim = { id: string; owner: (typeof OWNERS)[number]; holder: string; client: Client; turn: number; pendingPerm: string | null; queue: string[]; codex: boolean; pane: PaneTarget | null; terminal: TmuxPane | null }

/** The simulator's own tmux server, for --terminals: never the user's. */
const tmuxDir = TERMINALS ? mkdtempSync(join(tmpdir(), 'sphere-sim-')) : ''
const tmuxSocket = join(tmuxDir, 'tmux.sock')
function simPane(name: string, cwd: string): PaneTarget | null {
  const banner = `printf '\\033[1mSimulated session %s\\033[0m: a shell on this machine, in a scratch folder.\\n' ${name}`
  const r = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', tmuxSocket, 'new-session', '-d', '-s', name, '-x', '100', '-y', '28', '-c', cwd, '-P', '-F', '#{pane_id}', `${banner}; exec env PS1='\\W $ ' bash --noprofile --norc`], { stderr: 'pipe' })
  if (!r.success) {
    console.error(`tmux: ${r.stderr.toString().trim()}`)
    return null
  }
  return { socket: tmuxSocket, pane: r.stdout.toString().trim() }
}

async function main() {
  const base = await loadConfig()
  const clients = new Map<string, Client>()
  const sims: Sim[] = []

  // One bridge connection per owner, reconnecting like the real bridge does.
  const connectOwner = async (owner: (typeof OWNERS)[number]): Promise<Client> => {
    const c = new Client({ ...base, token: owner.token }, 'bridge', {
      onEvent: ev => {
        if (ev.type !== 'command.issued') return
        const sim = sims.find(s => s.id === ev.data.sessionId)
        if (sim) void onCommand(sim, ev.data.command as SessionCommand)
      },
      onTerm: m => {
        const sim = sims.find(s => s.id === m.sessionId)
        if (!sim) return
        if (!sim.pane) return void c.term({ t: 'term', sessionId: sim.id, op: 'closed', reason: "This session doesn't run in tmux." })
        if (m.op === 'close') return void sim.terminal?.close()
        sim.terminal ??= new TmuxPane(sim.pane, { send: out => sim.client.term({ t: 'term', sessionId: sim.id, ...out }), buffered: () => sim.client.buffered })
        if (m.op === 'open') void sim.terminal.start()
        else if (m.op === 'snapshot') void (sim.terminal.open ? sim.terminal.snapshot() : sim.terminal.start())
        else if (m.op === 'in') sim.terminal.input(m.d, { binary: m.binary === true, paste: m.paste === true })
        else if (m.op === 'fit' && validSize(m.cols, m.rows)) sim.terminal.fit(m.cols, m.rows)
      },
      onClose: () => {
        for (const sim of sims) if (sim.owner === owner) sim.terminal?.close()
        void reconnect(owner)
      },
    })
    await c.connect()
    clients.set(owner.name, c)
    return c
  }
  const reconnect = async (owner: (typeof OWNERS)[number]) => {
    for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
      await Bun.sleep(wait)
      try {
        const c = await connectOwner(owner)
        for (const sim of sims.filter(x => x.owner === owner)) {
          sim.client = c
          await c.cmd('attach', { sessionId: sim.id, holder: sim.holder })
          c.sub(topics.bridge(sim.id), 0)
        }
        console.log(`reconnected ${owner.name}`)
        return
      } catch {}
    }
  }
  for (const owner of OWNERS) await connectOwner(owner)

  const send = (sim: Sim, type: string, data: Record<string, unknown>, k: string = key()) =>
    sim.client.cmd('ingest', { events: [{ key: k, type, data: { sessionId: sim.id, ...data }, holder: sim.holder }] }).catch(e => console.error(sim.id.slice(0, 8), e.message))

  const row = (sim: Sim, kind: string, text: string, extra: Record<string, unknown> = {}) =>
    send(sim, 'session.row', { uuid: key(), door: kind === 'assistant' || kind === 'tool-call' || kind === 'thinking' ? 'response' : 'prompt', origin: 'sim', kind, summary: text.split('\n')[0]!.slice(0, 140), text, ...extra })

  async function onCommand(sim: Sim, c: SessionCommand) {
    await send(sim, 'delivery', { msgId: c.msgId, state: 'at-bridge' }, `${c.msgId}:at-bridge`)
    if (c.kind === 'permission') {
      if (sim.pendingPerm === c.reqId) sim.pendingPerm = null
      await send(sim, 'permission.resolved', { reqId: c.reqId, decision: c.decision, by: c.by }, `${c.reqId}:resolved`)
      return
    }
    await sleep(150)
    await send(sim, 'delivery', { msgId: c.msgId, state: 'injected' }, `${c.msgId}:injected`)
    if (c.kind === 'deliver') {
      const framed = c.asUser ? c.text : `[From ${c.author}${c.approvedBy ? `, approved by ${c.approvedBy}` : ''}, via Dyson Sphere] ${c.text}`
      await row(sim, c.mode === 'steer' ? 'note' : 'prompt', framed)
      sim.queue.push(c.text)
    }
    await send(sim, 'delivery', { msgId: c.msgId, state: 'observed' }, `${c.msgId}:observed`)
  }

  for (let i = 0; i < COUNT; i++) {
    const owner = OWNERS[i % OWNERS.length]!
    const repos = DEMO ? DEMO_REPOS : REPOS
    const r = repos[i % repos.length]!
    const codex = COUNT > 1 && i === COUNT - 1
    const local = TERMINALS && owner.name !== 'ops-bot'
    const machine = local ? hostname() : `sim-${owner.name}`
    const sim: Sim = { id: crypto.randomUUID(), owner, holder: `${machine}:${i + 1}`, client: clients.get(owner.name)!, turn: 0, pendingPerm: null, queue: [], codex, pane: null, terminal: null }
    if (local) sim.pane = simPane(`sim-${i + 1}-${owner.name}`, tmuxDir)
    sims.push(sim)
    const branch = pick(r.branches)
    const labels = DEMO && owner.name === 'ops-bot' ? DEMO_STAGES[Math.floor(i / OWNERS.length) % DEMO_STAGES.length]! : null
    // What a bridge sends: estra's labels, and the ticket from them or the branch.
    const ticket = findTicket({ estra: labels?.ticket, branch })
    await send(sim, 'session.started', { machine, cwd: `/Users/${owner.name}/dev/${r.repo}`, repo: r.repo, branch, pid: 0, interactive: true, ...(labels && { labels }), ticket, ...(codex && { agent: 'codex' }), ...(sim.pane && { terminal: 'tmux' }) })
    sim.client.sub(topics.bridge(sim.id), 0)
    await sim.client.cmd('attach', { sessionId: sim.id, holder: sim.holder })
    const tasks = DEMO ? DEMO_TASKS : TASKS
    if (i === 0 && HISTORY > 0) await history(sim, HISTORY)
    await row(sim, 'prompt', tasks[i % tasks.length]!)
    void life(sim)
    await sleep(120)
  }
  console.log(`simulating ${sims.length} sessions (Ctrl+C ends them)`)

  /** Earlier turns, sent fast in batches: a long transcript to scroll back through. */
  async function history(sim: Sim, n: number) {
    const events: { key: string; type: string; data: Record<string, unknown>; holder: string }[] = []
    const add = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
      events.push({ key: key(), type: 'session.row', holder: sim.holder, data: { sessionId: sim.id, uuid: key(), door: kind === 'prompt' ? 'prompt' : 'response', origin: 'sim', kind, summary: text.split('\n')[0]!.slice(0, 140), text, ...extra } })
    for (let turn = 1; events.length < n; turn++) {
      add('prompt', `Turn ${turn}: ${pick(DEMO_TASKS)}`)
      if (turn % 3 === 0) add('thinking', pick(THOUGHTS))
      for (let s = 0; s < rand(3, 12) && events.length < n; s++) {
        const tool = pick(TOOLS)
        const id = `toolu_${key().slice(0, 12)}`
        const input = tool.input()
        add('tool-call', `${tool.name} ${JSON.stringify(input)}`, { tools: [{ name: tool.name, id }], calls: [{ id, name: tool.name, input }] })
        add('tool-result', tool.result(input), { toolUseIds: [id], results: [{ id, isError: false, ...(tool.output && { output: tool.output(input) }) }] })
      }
      add('assistant', `Turn ${turn} done. ${pick(['All tests pass.', 'I left a note on the PR.', 'The **index** fixed it: the export now takes 3 minutes.'])}`)
    }
    for (let i = 0; i < events.length; i += 500) await sim.client.cmd('ingest', { events: events.slice(i, i + 500) })
    console.log(`gave ${sim.id.slice(0, 8)} ${events.length} rows of history`)
  }

  /** A subagent's rows, as Claude Code reports them: its prompt, its calls, its answer. */
  async function subagent(sim: Sim, prompt: string) {
    const agentId = `a${key().slice(0, 10)}`
    await row(sim, 'prompt', prompt, { agentId })
    for (const t of [TOOLS[1]!, TOOLS[0]!]) {
      const id = `toolu_${key().slice(0, 12)}`
      const input = t.input()
      await row(sim, 'tool-call', `${t.name} ${JSON.stringify(input)}`, { agentId, tools: [{ name: t.name, id }], calls: [{ id, name: t.name, input }] })
      await sleep(rand(300, 900))
      await row(sim, 'tool-result', t.result(input), { agentId, toolUseIds: [id], results: [{ id, isError: false, ...(t.output && { output: t.output(input) }) }] })
    }
    await row(sim, 'assistant', 'Found 7 callers: three in `src/auth`, four in tests.', { agentId })
  }

  async function life(sim: Sim) {
    // Some sessions are busy, some idle between turns, a few ask for permission.
    const busy = Math.random()
    while (true) {
      sim.turn++
      await send(sim, 'session.status', { state: 'working', turnId: `t${sim.turn}` })
      const steps = rand(2, 9)
      for (let s = 0; s < steps; s++) {
        const tool = pick(sim.codex ? CODEX_TOOLS : TOOLS)
        const id = `toolu_${key().slice(0, 12)}`
        const input = tool.input()
        if (!sim.codex && tool.name === 'Bash' && sim.owner.name !== 'ops-bot' && Math.random() < 0.18 && !sim.pendingPerm) {
          await row(sim, 'tool-call', `${tool.name} ${JSON.stringify(input)}`, { tools: [{ name: tool.name, id }], calls: [{ id, name: tool.name, input }] })
          const reqId = `p_sim_${key().slice(0, 8)}`
          sim.pendingPerm = reqId
          await send(sim, 'permission.requested', { reqId, tool: tool.name, input: JSON.stringify(input) }, `${reqId}:requested`)
          while (sim.pendingPerm === reqId) await sleep(500) // waits for someone to decide
          await row(sim, 'tool-result', tool.result(input), { toolUseIds: [id], results: [{ id, isError: false, output: tool.output?.(input) }] })
          continue
        }
        if (s === 0 && Math.random() < 0.6) await row(sim, 'thinking', pick(THOUGHTS))
        await row(sim, 'tool-call', `${tool.name} ${JSON.stringify(input)}`, { tools: [{ name: tool.name, id }], calls: [{ id, name: tool.name, input }] })
        if (tool.name === 'Agent') await subagent(sim, String(input.prompt))
        await sleep(tool.slow ? rand(2000, 7000) : rand(300, 1800))
        const failed = Math.random() < 0.08
        await row(sim, failed ? 'tool-error' : 'tool-result', failed ? 'Error: command exited with code 1' : tool.result(input), {
          toolUseIds: [id],
          results: [{ id, isError: failed, ...(!failed && tool.output && { output: tool.output(input) }) }],
        })
        await sleep(rand(200, 1200))
      }
      const asked = sim.queue.shift()
      if (!sim.codex && !asked && Math.random() < 0.5) {
        // A longer reply, passed on a paragraph at a time as Claude Code's mod does, then stored.
        const reply = pick(LONG_REPLIES)
        const paragraphs = reply.split('\n\n')
        for (let p = 1; p < paragraphs.length; p++) {
          await sleep(rand(700, 1600))
          await sim.client.cmd('partial', { sessionId: sim.id, holder: sim.holder, turnId: `t${sim.turn}`, step: 0, block: 0, text: paragraphs.slice(0, p).join('\n\n') }).catch(() => {})
        }
        await sleep(rand(500, 1200))
        await row(sim, 'assistant', reply)
      } else await row(sim, 'assistant', asked ? `Done: ${asked}` : pick(['Fixed. The test was depending on wall-clock time; it now uses a frozen clock.', 'I found the cause: the export query does a sequential scan on events. **Proposed fix:** add an index on (topic, seq).', 'Done. 3 files changed, all tests pass.', 'I need a decision: should the backfill run in one transaction or in batches of 10k?']))
      await send(sim, 'session.status', { state: 'idle', turnId: null, reason: 'answer' })
      await sleep(busy > 0.5 ? rand(2000, 8000) : rand(15_000, 60_000))
    }
  }

  process.on('SIGINT', async () => {
    // Mark them ended, but never hang on a dead connection.
    await Promise.race([Promise.all(sims.map(s => send(s, 'session.ended', { reason: 'simulation stopped' }, `${s.id}:ended`))), Bun.sleep(3000)])
    if (TERMINALS) {
      for (const sim of sims) sim.terminal?.close()
      Bun.spawnSync(['tmux', '-S', tmuxSocket, 'kill-server'], { stderr: 'ignore' })
      rmSync(tmuxDir, { recursive: true, force: true })
    }
    process.exit(0)
  })
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
