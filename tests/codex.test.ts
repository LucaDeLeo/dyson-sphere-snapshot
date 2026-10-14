// Codex sessions end to end, without Codex: the real hook command (`sphere codex-hook`) and the
// bridge it starts, against a real sphere-server, with a stand-in process for Codex and a
// rollout file the test writes. Same scratch database as server.test.ts:
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { connect } from '../server/src/pg'
import type { Subprocess } from 'bun'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linearStub } from '../scripts/linear-stub'
import { CODEX_CANNOT } from '../shared/protocol'
import { Client } from '../sphere/src/client'
import { codexHookCommand, writeCodexHooks } from '../sphere/src/codex'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/sphere_test'
const PORT = 7462
const ROOT = `${import.meta.dir}/..`
const HOME = mkdtempSync(join(tmpdir(), 'sphere-codex-'))
let server: Subprocess
const codexes: Subprocess[] = []
const linear = linearStub({ 'CS-91': { title: 'Codex sessions show their ticket', status: 'In Progress' } })
// Each hook is a fresh `bun` process, as in Codex; a test runs a few dozen.
setDefaultTimeout(30_000)

beforeAll(async () => {
  const sql = connect(DATABASE_URL)
  await sql`drop table if exists events, bodies`
  await sql.close()
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ url: `ws://127.0.0.1:${PORT}/ws`, token: 'dev-luca' }))
  server = Bun.spawn(['bun', 'run', 'server/src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL, SPHERE_PORT: String(PORT), NODE_ENV: 'test', SPHERE_LINEAR_KEY: 'test-key', SPHERE_LINEAR_URL: linear.url },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error('sphere-server did not start')
})

afterAll(() => {
  for (const c of codexes) c.kill() // their bridges see Codex go and end the sessions
  server?.kill()
  linear.stop()
})

async function cli(token = 'dev-luca') {
  const c = new Client({ url: `ws://127.0.0.1:${PORT}/ws`, token }, 'cli')
  await c.connect()
  return c
}

/** A stand-in Codex process, and a session in it whose rollout the test writes. */
function codex(env: Record<string, string> = {}, resume?: { id: string; transcript: string }) {
  const proc = Bun.spawn(['sleep', '300'])
  codexes.push(proc)
  const id = resume?.id ?? crypto.randomUUID()
  const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
  const transcript = resume?.transcript ?? join(dir, `rollout-${id}.jsonl`)
  const base = { session_id: id, transcript_path: transcript, cwd: ROOT, model: 'gpt-test', permission_mode: 'default' }
  /** Runs one hook the way Codex does: the payload on stdin, from "inside" the Codex process. */
  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const t = Date.now()
    const p = Bun.spawn(['bun', 'sphere/src/cli.ts', 'codex-hook', event, '--pid', String(proc.pid)], {
      cwd: ROOT,
      env: { ...process.env, SPHERE_HOME: HOME, ...env },
      stdin: new Blob([JSON.stringify({ ...base, hook_event_name: event, ...payload })]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(p.stdout).text()
    return { code: await p.exited, out: out ? JSON.parse(out) : null, ms: Date.now() - t }
  }
  const rollout = (...lines: unknown[]) => appendFileSync(transcript, lines.map(l => JSON.stringify(l) + '\n').join(''))
  return { id, proc, hook, rollout, transcript }
}

async function until<T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

const sessionOf = (c: Client, id: string) => c.cmd('show', { sessionId: id, tail: 50 }).catch(() => null)

/** Starts a Codex session and waits for its bridge to report it and be ready for hooks. */
async function started(s: ReturnType<typeof codex>, c: Client) {
  expect((await s.hook('SessionStart', { source: 'startup' })).code).toBe(0)
  const shown = await until('session', async () => {
    const r = await sessionOf(c, s.id)
    return r?.session.connected && r
  })
  s.rollout({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } })
  await until('working', async () => (await sessionOf(c, s.id))?.session.state === 'working')
  return shown.session
}

const delivery = (c: Client, msgId: string) => c.cmd('delivery', { msgId })

test('a Codex session reports through its hooks and its rollout, labelled by estra', async () => {
  const c = await cli()
  const s = codex({ ESTRA_TICKET: 'CS-90', ESTRA_STAGE: 'code', ESTRA_PROVIDER: 'codex' })
  const session = await started(s, c)
  expect(session).toMatchObject({ agent: 'codex', owner: 'luca', labels: { ticket: 'CS-90', stage: 'code', provider: 'codex' }, ticket: { id: 'CS-90', source: 'estra' } })

  s.rollout(
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Read notes.txt' }] } } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions> not ours' }] } },
  )
  await until('prompt row', async () => (await sessionOf(c, s.id))?.rows.length)
  const call = await s.hook('PreToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: 'exec-1', tool_input: { command: 'cat notes.txt' } })
  expect(call).toMatchObject({ code: 0, out: null })
  await s.hook('PostToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: 'exec-1', tool_input: { command: 'cat notes.txt' }, tool_response: 'alpha beta\n' })
  s.rollout(
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'The second word is beta.' }] } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  )
  const r = await until('idle', async () => {
    const r = await sessionOf(c, s.id)
    return r?.session.state === 'idle' && r
  })
  expect(r.rows.map((e: any) => [e.data.kind, e.data.summary])).toEqual([
    ['prompt', 'Read notes.txt'],
    ['tool-call', 'Bash {"command":"cat notes.txt"}'],
    ['tool-result', 'alpha beta'],
    ['assistant', 'The second word is beta.'],
  ])
  expect(r.rows[1].data.tools).toEqual([{ name: 'Bash', id: 'exec-1' }])
  expect(r.session.task).toBe('Read notes.txt')

  // A subagent shows as one, and its tool calls are labelled with it.
  await s.hook('SubagentStart', { agent_id: 'sub-1', agent_type: 'explorer' })
  const running = await until('subagent', async () => (await sessionOf(c, s.id))?.session.subagents[0])
  expect(running).toMatchObject({ id: 'sub-1', type: 'explorer' })
  await s.hook('PreToolUse', { agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'exec-2', tool_input: { command: 'ls' } })
  await s.hook('SubagentStop', { agent_id: 'sub-1', agent_type: 'explorer', last_assistant_message: 'Found two files.' })
  const after = await until('subagent done', async () => {
    const r = await sessionOf(c, s.id)
    return r?.session.subagents.length === 0 && r
  })
  expect(after.rows.slice(-2).map((e: any) => [e.data.kind, e.data.agentId])).toEqual([
    ['tool-call', 'sub-1'],
    ['assistant', 'sub-1'],
  ])
  c.close()
})

test('Codex tool calls and results carry their input and output as objects, and reasoning shows as thinking', async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  const input = { command: 'cat .env', env: { API_TOKEN: 'abcd1234efgh5678' }, note: 'x'.repeat(30_000) }
  await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'exec-s1', tool_input: input })
  await s.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'exec-s1', tool_input: input, tool_response: { output: 'A=1', exit_code: 0 } })
  // A tool whose input is plain text keeps it under `input`.
  await s.hook('PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'exec-s2', tool_input: '*** Begin Patch\n*** End Patch' })
  // Its plain-text result is the row's text; the row still lists the call it finishes.
  await s.hook('PostToolUse', { tool_name: 'apply_patch', tool_use_id: 'exec-s2', tool_input: '*** Begin Patch\n*** End Patch', tool_response: 'Success.' })
  // An empty one still gets its row.
  await s.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'exec-s7', tool_input: { command: 'mkdir x' }, tool_response: '' })
  // A token across the hook's 20,000-character cut is redacted before the cut, not left half there.
  const token = `ghp_${'a'.repeat(30)}`
  await s.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'exec-s6', tool_input: { command: 'env' }, tool_response: { output: ' '.repeat(19_984) + token } })
  // So does a list, and what was cut in it is listed where it now sits.
  await s.hook('PreToolUse', { tool_name: 'batch', tool_use_id: 'exec-s4', tool_input: ['short', 'z'.repeat(25_000)] })
  // Even one that starts like JSON.
  await s.hook('PreToolUse', { tool_name: 'shell', tool_use_id: 'exec-s5', tool_input: '[ -f x ] && echo yes' })
  // Input the hook cut whole (too large to send by field) is only text.
  await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'exec-s3', tool_input: { command: 'echo', blob: Array.from({ length: 20 }, () => 'y'.repeat(15_000)) } })
  // A hook from before `sphere_whole` names nothing. From one of those, a string of 20,000
  // characters that starts like JSON is an object it cut whole; a shorter one is plain input.
  const base = join(HOME, 'run', `${s.id.slice(0, 12)}.${s.proc.pid}`)
  const olderHook = (payload: Record<string, unknown>) =>
    fetch('http://bridge/codex/hook', {
      unix: `${base}.sock`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sphere-secret': readFileSync(`${base}.secret`, 'utf8').trim() },
      body: JSON.stringify({ event: 'PreToolUse', payload: { session_id: s.id, transcript_path: s.transcript, cwd: ROOT, hook_event_name: 'PreToolUse', ...payload } }),
    } as RequestInit)
  await olderHook({ tool_name: 'Bash', tool_use_id: 'exec-o1', tool_input: JSON.stringify({ command: 'echo', blob: 'y'.repeat(30_000) }).slice(0, 20_000) })
  await olderHook({ tool_name: 'shell', tool_use_id: 'exec-o2', tool_input: '[ -f x ] && echo yes' })
  s.rollout(
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'rs_1', summary_text: ['**Checking the env file**', 'It holds the token.'], raw_content: [] } } },
    // Encrypted reasoning with no summary has nothing to show.
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'rs_2', summary_text: [], raw_content: [] } } },
  )
  const rows = await until('rows', async () => {
    const r = await sessionOf(c, s.id)
    return r?.rows.some((e: any) => e.data.kind === 'thinking') && r.rows.map((e: any) => e.data)
  })
  const call = rows.find((d: any) => d.kind === 'tool-call' && d.tools[0].id === 'exec-s1')
  expect(call.calls[0]).toMatchObject({ id: 'exec-s1', name: 'Bash', input: { command: 'cat .env', env: { API_TOKEN: '[redacted]' } } })
  // The hook cut the long field to 20,000 characters and said so; the server kept 8,000 of those.
  expect(call.cut).toEqual([{ path: ['calls', 0, 'input', 'note'], fullLength: 30_000 }])
  expect(call.calls[0].input.note).toHaveLength(8000)
  expect(call.capped[0]).toMatchObject({ path: ['calls', 0, 'input', 'note'], fullLength: 20_000 })
  const resultOf = (id: string) => rows.find((d: any) => d.kind === 'tool-result' && d.toolUseIds[0] === id)
  expect(resultOf('exec-s1').results).toEqual([{ id: 'exec-s1', output: { output: 'A=1', exit_code: 0 } }])
  expect(resultOf('exec-s2').text).toBe('Success.')
  expect(resultOf('exec-s2').results).toEqual([{ id: 'exec-s2' }])
  expect(resultOf('exec-s7')).toMatchObject({ text: '(no output)', results: [{ id: 'exec-s7' }] })
  const straddled = resultOf('exec-s6')
  expect(JSON.stringify(straddled)).not.toContain('ghp_')
  expect((await c.cmd<{ text: string }>('body', { id: straddled.capped[0].bodyId })).text).not.toContain('ghp_')
  const patch = rows.find((d: any) => d.kind === 'tool-call' && d.tools[0].id === 'exec-s2')
  expect(patch.calls[0].input).toEqual({ input: '*** Begin Patch\n*** End Patch' })
  const list = rows.find((d: any) => d.kind === 'tool-call' && d.tools[0].id === 'exec-s4')
  expect(list.calls[0].input.input[0]).toBe('short')
  expect(list.calls[0].input.input[1]).toHaveLength(8000)
  expect(list.cut).toEqual([{ path: ['calls', 0, 'input', 'input', 1], fullLength: 25_000 }])
  expect(list.capped[0]).toMatchObject({ path: ['calls', 0, 'input', 'input', 1], fullLength: 20_000 })
  const whole = rows.find((d: any) => d.kind === 'tool-call' && d.tools[0].id === 'exec-s3')
  expect(whole.calls).toBeUndefined()
  expect(whole.text.startsWith('Bash {"command":"echo"')).toBe(true)
  const callOf = (id: string) => rows.find((d: any) => d.kind === 'tool-call' && d.tools[0].id === id)
  expect(callOf('exec-s5').calls[0].input).toEqual({ input: '[ -f x ] && echo yes' })
  expect(callOf('exec-o1').calls).toBeUndefined()
  expect(callOf('exec-o2').calls[0].input).toEqual({ input: '[ -f x ] && echo yes' })
  expect(rows.filter((d: any) => d.kind === 'thinking').map((d: any) => d.text)).toEqual(['**Checking the env file**\nIt holds the token.'])
  c.close()
})

test('a Codex session started by hand shows the ticket its branch names', async () => {
  const c = await cli()
  const repo = mkdtempSync(join(tmpdir(), 'codex-ticket-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'luca/cs-91-codex-tickets', repo])
  const s = codex()
  expect((await s.hook('SessionStart', { source: 'startup', cwd: repo })).code).toBe(0)
  // Shown once Linear has it.
  const session = await until('ticket', async () => {
    const r = await sessionOf(c, s.id)
    return r?.session.ticket && r.session
  })
  expect(session).toMatchObject({ agent: 'codex', branch: 'luca/cs-91-codex-tickets', labels: null, ticket: { id: 'CS-91', source: 'branch' } })
  c.close()
})

test('a message mid-turn goes in at the next tool call; one at turn end makes Codex carry on', async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)

  const mid = await c.cmd('send', { sessionId: s.id, text: 'Also count the words.', mode: 'steer' })
  await until('at bridge', async () => (await delivery(c, mid.msgId)).state === 'at-bridge')
  // A subagent's tool call doesn't take it: it's for the main agent.
  expect((await s.hook('PreToolUse', { agent_id: 'sub-9', tool_name: 'Bash', tool_use_id: 'x1', tool_input: {} })).out).toBeNull()
  const pre = await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x2', tool_input: { command: 'wc -w notes.txt' } })
  const given = 'Message from the user, sent while you work: Also count the words.'
  expect(pre.out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: given } })
  // The bridge reports in batches every 150 ms.
  await until('injected', async () => ['injected', 'observed'].includes((await delivery(c, mid.msgId)).state))
  // Codex records it as developer context; then it counts as read.
  s.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: given }] } })
  await until('observed', async () => (await delivery(c, mid.msgId)).state === 'observed')
  const note = await until('note row', async () => (await sessionOf(c, s.id))?.rows.find((e: any) => e.data.kind === 'note'))
  expect(note.data.text).toBe(given)
  // Taken once.
  expect((await s.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'x2', tool_response: '2' })).out).toBeNull()

  // "At turn end" waits for Stop, and the owner's own words go in bare, as if typed.
  const end = await c.cmd('send', { sessionId: s.id, text: 'Now run the tests.', mode: 'queue' })
  await until('at bridge', async () => (await delivery(c, end.msgId)).state === 'at-bridge')
  expect((await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x3', tool_input: {} })).out).toBeNull()
  expect((await s.hook('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' })).out).toEqual({ decision: 'block', reason: 'Now run the tests.' })
  s.rollout({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'HookPrompt', id: 'h1', fragments: [{ text: 'Now run the tests.' }] } } })
  await until('observed', async () => (await delivery(c, end.msgId)).state === 'observed')
  // Nothing waiting: the turn ends as Codex decides, even with a Stop hook already active.
  expect((await s.hook('Stop', { stop_hook_active: true })).out).toBeNull()

  // A short message isn't mistaken for delivered because other text contains it.
  const ok = await c.cmd('send', { sessionId: s.id, text: 'ok', mode: 'queue' })
  await until('at bridge', async () => (await delivery(c, ok.msgId)).state === 'at-bridge')
  s.rollout(
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Look at the book.\n\nok' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'HookPrompt', id: 'h2', fragments: [{ text: 'Looks ok to me' }] } } },
  )
  await Bun.sleep(700) // the bridge reads the rollout every 300 ms
  expect((await s.hook('Stop', { stop_hook_active: true })).out).toEqual({ decision: 'block', reason: 'ok' })

  // The same words sent twice are two messages: the first one's arrival doesn't settle the second.
  const once = await c.cmd('send', { sessionId: s.id, text: 'Run the linter.', mode: 'queue' })
  await until('at bridge', async () => (await delivery(c, once.msgId)).state === 'at-bridge')
  expect((await s.hook('Stop', {})).out).toEqual({ decision: 'block', reason: 'Run the linter.' })
  const twice = await c.cmd('send', { sessionId: s.id, text: 'Run the linter.', mode: 'queue' })
  await until('at bridge', async () => (await delivery(c, twice.msgId)).state === 'at-bridge')
  s.rollout({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'HookPrompt', id: 'h3', fragments: [{ text: 'Run the linter.' }] } } })
  await until('first observed', async () => (await delivery(c, once.msgId)).state === 'observed')
  expect((await delivery(c, twice.msgId)).state).toBe('at-bridge')
  expect((await s.hook('Stop', {})).out).toEqual({ decision: 'block', reason: 'Run the linter.' })

  // Two the same handed over together arrive as one prompt holding both: both are observed.
  const pair: string[] = []
  for (const _ of [1, 2]) {
    const m = await c.cmd('send', { sessionId: s.id, text: 'ok', mode: 'queue' })
    await until('at bridge', async () => (await delivery(c, m.msgId)).state === 'at-bridge')
    pair.push(m.msgId)
  }
  expect((await s.hook('Stop', {})).out).toEqual({ decision: 'block', reason: 'ok\n\nok' })
  s.rollout({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'HookPrompt', id: 'h4', fragments: [{ text: 'ok\n\nok' }] } } })
  await until('both observed', async () => (await Promise.all(pair.map(id => delivery(c, id)))).every(d => d.state === 'observed'))

  // An approved suggestion travels the same way, with who sent and who approved it.
  const jp = await cli('dev-jp')
  const { suggestionId } = await jp.cmd('suggest', { sessionId: s.id, text: 'Check the README too.', mode: 'steer' })
  await c.cmd('approve', { id: suggestionId })
  await until('suggestion at bridge', async () => {
    const pre = await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: `x4-${Date.now()}`, tool_input: {} })
    return pre.out?.hookSpecificOutput?.additionalContext === '[From jp, approved by luca, via Dyson Sphere] Check the README too.'
  })
  for (const x of [c, jp]) x.close()
})

test("a restarted bridge doesn't replay the session's old turns", async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  s.rollout({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })
  await until('idle', async () => (await sessionOf(c, s.id))?.session.state === 'idle')
  const sql = connect(DATABASE_URL)
  const statuses = async () => Number((await sql`select count(*)::int as n from events where type = 'session.status' and data->>'sessionId' = ${s.id}`)[0].n)
  const before = await statuses()
  process.kill(Number(readFileSync(join(HOME, 'run', `${s.id.slice(0, 12)}.${s.proc.pid}.lock`), 'utf8')), 'SIGKILL')
  await until('bridge gone', async () => bridges(s.id).length === 0)
  await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'again', tool_input: {} })
  await until('bridge back', async () => (await sessionOf(c, s.id))?.session.connected)
  await Bun.sleep(1500) // it has read the whole rollout again
  expect(await statuses()).toBe(before)
  expect((await sessionOf(c, s.id))?.session.state).toBe('idle')
  await sql.close()
  c.close()
})

test('a Codex permission request is answered from Dyson Sphere, or handed back to Codex', async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  const ask = (command: string) => s.hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command, description: 'probe' } })
  const pending = async (command: string) =>
    until('request', async () => ((await c.cmd('permissions')).permissions as any[]).find(p => p.sessionId === s.id && p.input.includes(command) && p.state === 'pending'))

  const allowing = ask('curl example.com')
  await c.cmd('decide', { reqId: (await pending('curl example.com')).reqId, decision: 'allow' })
  expect((await allowing).out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

  const denying = ask('rm notes.txt')
  await c.cmd('decide', { reqId: (await pending('rm notes.txt')).reqId, decision: 'deny', message: 'Not that file.' })
  expect((await denying).out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not that file.' } } })
  c.close()
})

test('an unattended Codex session waits SPHERE_PERMISSION_WAIT_MINUTES, then Codex decides', async () => {
  const c = await cli()
  const s = codex({ SPHERE_PERMISSION_WAIT_MINUTES: '0.05' })
  await started(s, c)
  const r = await s.hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make deploy' } })
  expect(r.out).toBeNull() // no decision: Codex's own prompt, or its reviewer
  expect(r.ms).toBeGreaterThan(2500)
  expect(r.ms).toBeLessThan(6000)
  // Settled, not waiting on anyone.
  await until('settled', async () => !((await c.cmd('permissions', { all: true })).permissions as any[]).some(p => p.sessionId === s.id))

  const never = codex({ SPHERE_PERMISSION_WAIT_MINUTES: '0' })
  await started(never, c)
  const now = await never.hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make deploy' } })
  expect(now.out).toBeNull()
  expect(now.ms).toBeLessThan(2000)
  c.close()
})

test("the server refuses what Codex's hooks can't carry", async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  await expect(c.cmd('fill', { sessionId: s.id, text: 'draft' })).rejects.toThrow(CODEX_CANNOT.promptBox)
  await expect(c.cmd('interrupt', { sessionId: s.id })).rejects.toThrow(CODEX_CANNOT.interrupt)
  await expect(c.cmd('send', { sessionId: s.id, text: 'stop', mode: 'interrupt' })).rejects.toThrow(CODEX_CANNOT.interrupt)

  s.rollout({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })
  await until('idle', async () => (await sessionOf(c, s.id))?.session.state === 'idle')
  await expect(c.cmd('send', { sessionId: s.id, text: 'hello' })).rejects.toThrow(CODEX_CANNOT.idle)
  // A suggestion can wait for its owner; approving it waits until Codex is working again.
  const jp = await cli('dev-jp')
  const { suggestionId } = await jp.cmd('suggest', { sessionId: s.id, text: 'try this' })
  await expect(c.cmd('approve', { id: suggestionId })).rejects.toThrow(CODEX_CANNOT.idle)
  expect((await c.cmd('approvals')).suggestions.find((x: any) => x.id === suggestionId)).toMatchObject({ status: 'pending' })
  s.rollout({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } })
  await until('working', async () => (await sessionOf(c, s.id))?.session.state === 'working')
  expect(await c.cmd('approve', { id: suggestionId })).toMatchObject({ status: 'approved' })
  for (const x of [c, jp]) x.close()
})

test('a hook never fails or holds up a turn', async () => {
  const c = await cli()
  const s = codex()
  // Not a session at all, and garbage in: exit 0, nothing printed.
  const t = Date.now()
  const junk = Bun.spawn(['bun', 'sphere/src/cli.ts', 'codex-hook', 'PreToolUse', '--pid', String(s.proc.pid)], { cwd: ROOT, env: { ...process.env, SPHERE_HOME: HOME }, stdin: new Blob(['not json']), stdout: 'pipe' })
  expect([await junk.exited, await new Response(junk.stdout).text()]).toEqual([0, ''])
  expect(Date.now() - t).toBeLessThan(1500)

  await started(s, c)
  // Its bridge stops (the session ended in a `/new`): the next hook starts another.
  await s.hook('SessionEnd', { reason: 'other' })
  await until('ended', async () => (await sessionOf(c, s.id))?.session.state === 'ended')
  // A bridge leaves its secret beside its socket until it exits.
  const secret = join(HOME, 'run', `${s.id.slice(0, 12)}.${s.proc.pid}.secret`)
  await until('old bridge gone', async () => !existsSync(secret))
  const lost = await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'y1', tool_input: {} })
  expect(lost).toMatchObject({ code: 0, out: null })
  expect(lost.ms).toBeLessThan(1500) // starts a bridge without waiting for it
  await until('bridge back', async () => (await sessionOf(c, s.id))?.session.connected)

  // The end of a session whose bridge is gone starts none.
  const done = codex()
  expect((await done.hook('SessionEnd', { reason: 'other' })).code).toBe(0)
  await Bun.sleep(1500)
  expect(await sessionOf(c, done.id)).toBeNull()
  c.close()
})

/** The bridge processes of a session, from their command lines. */
const bridges = (id: string) =>
  Bun.spawnSync(['pgrep', '-f', `bridge --agent codex --session ${id}`]).stdout.toString().split('\n').filter(Boolean)

test('hooks arriving together start one bridge', async () => {
  const c = await cli()
  const s = codex()
  await Promise.all([s.hook('SessionStart', { source: 'startup' }), s.hook('SubagentStart', { agent_id: 'a' }), s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'z1', tool_input: {} }), s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'z2', tool_input: {} })])
  await until('session', async () => (await sessionOf(c, s.id))?.session.connected)
  await Bun.sleep(1000)
  expect(bridges(s.id)).toHaveLength(1)
  c.close()
})

test("a message handed over but never seen comes back after a crash; one Codex has doesn't", async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  const kill = async () => {
    const lock = join(HOME, 'run', `${s.id.slice(0, 12)}.${s.proc.pid}.lock`)
    process.kill(Number(readFileSync(lock, 'utf8')), 'SIGKILL')
    await until('bridge gone', async () => bridges(s.id).length === 0)
  }
  const restart = async () => {
    // The next hook finds no bridge and starts one; that one gets the unfinished commands again.
    await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: `r${Date.now()}`, tool_input: {} })
    await until('bridge back', async () => bridges(s.id).length === 1 && (await sessionOf(c, s.id))?.session.connected)
    await Bun.sleep(500)
  }
  const crash = async () => (await kill(), await restart())
  const take = async () => (await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: `t${Date.now()}`, tool_input: {} })).out?.hookSpecificOutput?.additionalContext ?? null

  const lost = await c.cmd('send', { sessionId: s.id, text: 'First.', mode: 'steer' })
  await until('at bridge', async () => (await delivery(c, lost.msgId)).state === 'at-bridge')
  expect(await take()).toBe('Message from the user, sent while you work: First.')
  // The answer never reached Codex (no trace in the rollout), and the bridge dies.
  await crash()
  expect(await until('redelivered', take)).toBe('Message from the user, sent while you work: First.')

  // This time Codex has it before the crash: the next bridge doesn't send it again.
  s.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Message from the user, sent while you work: First.' }] } })
  await until('observed', async () => (await delivery(c, lost.msgId)).state === 'observed')
  await crash()
  expect(await take()).toBeNull()

  // Codex records it just as the bridge dies, before that bridge reads it: the next bridge
  // finds it in the rollout and doesn't send it again either.
  const late = await c.cmd('send', { sessionId: s.id, text: 'Second.', mode: 'steer' })
  await until('at bridge', async () => (await delivery(c, late.msgId)).state === 'at-bridge')
  expect(await take()).toBe('Message from the user, sent while you work: Second.')
  await kill()
  s.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Message from the user, sent while you work: Second.' }] } })
  await restart()
  await until('observed', async () => (await delivery(c, late.msgId)).state === 'observed')
  expect(await take()).toBeNull()

  // The same words handed over twice, but only one answer reached Codex: one comes back.
  const twins: string[] = []
  for (const _ of [1, 2]) {
    const m = await c.cmd('send', { sessionId: s.id, text: 'Same.', mode: 'steer' })
    await until('at bridge', async () => (await delivery(c, m.msgId)).state === 'at-bridge')
    expect(await take()).toBe('Message from the user, sent while you work: Same.')
    twins.push(m.msgId)
  }
  await kill()
  s.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Message from the user, sent while you work: Same.' }] } })
  await restart()
  expect(await until('the lost one again', take)).toBe('Message from the user, sent while you work: Same.')
  expect(await take()).toBeNull()
  // This time it arrives.
  s.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Message from the user, sent while you work: Same.' }] } })
  await until('both observed', async () => (await Promise.all(twins.map(id => delivery(c, id)))).every(d => d.state === 'observed'))

  // The bridge saw it arrive and recorded so, but died before marking it done: the next one
  // settles it from that record rather than sending it again.
  const third = await c.cmd('send', { sessionId: s.id, text: 'Third.', mode: 'steer' })
  await until('at bridge', async () => (await delivery(c, third.msgId)).state === 'at-bridge')
  const given = 'Message from the user, sent while you work: Third.'
  expect(await take()).toBe(given)
  await kill()
  const at = statSync(s.transcript).size
  s.rollout({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: given }] } })
  appendFileSync(join(HOME, 'sessions', `${s.id}.${s.proc.pid}`, 'handed'), JSON.stringify({ claimed: `${s.transcript}\n${at}\n${given}`, msgId: third.msgId }) + '\n')
  await restart()
  await until('observed', async () => (await delivery(c, third.msgId)).state === 'observed')
  expect(await take()).toBeNull()
  c.close()
})

test('a Codex process that another one took the session from gets no more messages', async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  const m = await c.cmd('send', { sessionId: s.id, text: 'Keep going.', mode: 'steer' })
  await until('at bridge', async () => (await delivery(c, m.msgId)).state === 'at-bridge')
  // `codex exec resume` of the same session: another Codex process, with its own bridge.
  const resumed = codex({}, { id: s.id, transcript: s.transcript })
  await resumed.hook('SessionStart', { source: 'resume' })
  await until('taken over', async () => {
    const lock = join(HOME, 'run', `${s.id.slice(0, 12)}.${resumed.proc.pid}.lock`)
    return existsSync(lock) && (await sessionOf(c, s.id))?.session.connected
  })
  await Bun.sleep(1000)
  expect((await s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'old1', tool_input: {} })).out).toBeNull()
  expect((await s.hook('Stop', {})).out).toBeNull()
  c.close()
})

test("sphere move refuses a Codex session before changing anything", async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  s.rollout({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })
  await until('idle', async () => (await sessionOf(c, s.id))?.session.state === 'idle')
  const target = mkdtempSync(join(tmpdir(), 'move-target-'))
  const moving = Bun.spawn(['bun', 'sphere/src/cli.ts', 'move', s.id, '--to', target], { cwd: ROOT, env: { ...process.env, SPHERE_HOME: HOME }, stdout: 'pipe', stderr: 'pipe' })
  expect(await moving.exited).toBe(1)
  expect(await new Response(moving.stderr).text()).toContain("Codex sessions can't be moved yet")
  expect(Bun.spawnSync(['ls', '-A', target]).stdout.toString()).toBe('')
  c.close()
})

test('hooks recovering together from a dead bridge start one', async () => {
  const c = await cli()
  const s = codex()
  // A bridge that died long ago left its lock, naming a process that's gone.
  mkdirSync(join(HOME, 'run'), { recursive: true })
  const lock = join(HOME, 'run', `${s.id.slice(0, 12)}.${s.proc.pid}.lock`)
  writeFileSync(lock, '999999')
  utimesSync(lock, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000))
  await Promise.all([1, 2, 3, 4].map(i => s.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: `s${i}`, tool_input: {} })))
  await until('session', async () => (await sessionOf(c, s.id))?.session.connected)
  await Bun.sleep(1000)
  expect(bridges(s.id)).toHaveLength(1)
  c.close()
})

test('a hook with a huge tool output stays quick', async () => {
  const c = await cli()
  const s = codex()
  await started(s, c)
  const big = await s.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'big', tool_input: { command: 'cat big.log' }, tool_response: 'x'.repeat(5_000_000) })
  expect(big.code).toBe(0)
  expect(big.ms).toBeLessThan(1500)
  const row = await until('row', async () => (await sessionOf(c, s.id))?.rows.find((e: any) => e.data.kind === 'tool-result'))
  expect(row.data.fullLength).toBe(20_000) // capped by the hook, then cut to a row by the server
  c.close()
})

test('install adds our hooks without moving anyone else’s, and they run without sphere', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const theirs = { type: 'command', command: 'orca-hook', timeout: 10 }
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ description: 'kept', hooks: { PreToolUse: [{ hooks: [theirs] }], Stop: [{ matcher: '', hooks: [theirs] }] } }))
  expect(writeCodexHooks(codexHome, '/opt/sphere/bin/sphere', HOME).changed).toBe(true)
  const doc = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
  expect(doc.description).toBe('kept')
  expect(doc.hooks.PreToolUse[0].hooks[0]).toEqual(theirs) // trust is keyed by position: still first
  expect(doc.hooks.PreToolUse[1].hooks[0]).toMatchObject({ command: codexHookCommand('PreToolUse', '/opt/sphere/bin/sphere', HOME), timeout: 5 })
  expect(doc.hooks.SessionStart[0].hooks[0]).toMatchObject({ async: true })
  expect(Object.keys(doc.hooks).sort()).toEqual(['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop'])

  // Running it again changes nothing; a new binary path is updated where it stands.
  expect(writeCodexHooks(codexHome, '/opt/sphere/bin/sphere', HOME).changed).toBe(false)
  doc.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'later-tool' }] })
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(doc))
  writeCodexHooks(codexHome, '/elsewhere/sphere', HOME)
  const again = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
  expect(again.hooks.PreToolUse.map((g: any) => g.hooks[0].command.slice(0, 22))).toEqual(['orca-hook', ': dyson-sphere-hook=1;', 'later-tool'])

  // Someone put another hook in our group: a reinstall keeps it.
  const shared = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
  shared.hooks.Stop[1].hooks.push({ type: 'command', command: 'their-stop-hook' })
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(shared))
  writeCodexHooks(codexHome, '/opt/sphere/bin/sphere', HOME)
  const kept = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks.Stop[1].hooks.map((x: any) => x.command.slice(0, 22))
  expect(kept).toEqual([': dyson-sphere-hook=1;', 'their-stop-hook'])

  // With sphere removed the hook drains its input and exits 0, as if it weren't there.
  const gone = Bun.spawn(['sh', '-c', codexHookCommand('PreToolUse', join(codexHome, 'no-such-sphere'), HOME)], { stdin: new Blob(['x'.repeat(200_000)]), stdout: 'pipe' })
  expect([await gone.exited, await new Response(gone.stdout).text()]).toEqual([0, ''])
})

test('trusting the hooks fails cleanly without Codex, for install.sh to report', async () => {
  const { trustCodexHooks } = await import('../sphere/src/codex')
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
  mkdirSync(codexHome, { recursive: true })
  await expect(trustCodexHooks(codexHome, join(codexHome, 'no-such-codex'))).rejects.toThrow()
})
