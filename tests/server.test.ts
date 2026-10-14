// Runs sphere-server against a scratch Postgres database and drives it the way bridges do.
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
//
// The database is emptied first, so never point this at a real one.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { connect } from '../server/src/pg'
import type { Subprocess } from 'bun'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { linearStub } from '../scripts/linear-stub'
import { Outbox, sendFrom } from '../sphere/src/bridge'
import { PROTOCOL } from '../shared/protocol'
import { Client } from '../sphere/src/client'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/sphere_test'
const PORT = 7461
const URL = `ws://127.0.0.1:${PORT}/ws`
const ROOT = `${import.meta.dir}/..`
let server: Subprocess
// Linear, as the server sees it: read every second here.
const linear = linearStub({
  'CS-501': { title: 'Show tickets on cards', status: 'In Progress', assignee: 'Luca De Leo' },
  'CS-503': { title: 'Tickets after a restart', status: 'Todo' },
})

beforeAll(async () => {
  const sql = connect(DATABASE_URL)
  await sql`drop table if exists events, bodies, canvas_rooms`
  await sql.close()
  await startServer()
})

async function startServer() {
  server = Bun.spawn(['bun', 'run', 'server/src/main.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, DATABASE_URL, SPHERE_PORT: String(PORT), NODE_ENV: 'test', SPHERE_LINEAR_KEY: 'test-key', SPHERE_LINEAR_URL: linear.url, SPHERE_LINEAR_POLL_SECONDS: '1' },
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
}

afterAll(() => {
  server?.kill()
  linear.stop()
})

type Bridge = { client: Client; superseded: string[]; commands: any[] }

async function bridge(token = 'dev-luca'): Promise<Bridge> {
  const b: Bridge = { client: null as unknown as Client, superseded: [], commands: [] }
  b.client = new Client({ url: URL, token }, 'bridge', {
    onSuperseded: (id, machine) => b.superseded.push(`${id}@${machine}`),
    onEvent: ev => {
      if (ev.type === 'command.issued') b.commands.push(ev.data)
    },
  })
  await b.client.connect()
  return b
}

const ingest = (b: Bridge, holder: string, sessionId: string, type: string, data: Record<string, unknown> = {}) =>
  b.client.cmd<{ acked: string[]; superseded: Record<string, string> }>('ingest', {
    events: [{ key: crypto.randomUUID(), type, data: { sessionId, ...data }, holder }],
  })

const start = (b: Bridge, holder: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  ingest(b, holder, sessionId, 'session.started', { machine: holder.split(':')[0], cwd: '/tmp/x', repo: 'x', branch: 'main', pid: 1, interactive: true, ...extra })

const ESTRA = { ticket: 'CS-77', stage: 'code', taskId: 'task-77', provider: 'codex' }

async function shown(c: Client, id: string) {
  const { session } = await c.cmd('show', { sessionId: id, tail: 0 })
  const { layout } = await c.cmd('canvas')
  return { labels: session.labels, frame: layout.find((l: any) => l.id === id)?.parent }
}

/** Asks until `check` passes, for what the server reads from Linear on its own time. */
async function eventually<T>(read: () => Promise<T>, check: (x: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const x = await read()
    if (check(x) || Date.now() > end) return x
    await Bun.sleep(100)
  }
}

async function cli(token = 'dev-luca') {
  const c = new Client({ url: URL, token }, 'cli')
  await c.connect()
  return c
}

test('a session reports to its owner and no one else', async () => {
  const a = await bridge()
  const id = crypto.randomUUID()
  await start(a, 'laptop:100', id)
  await ingest(a, 'laptop:100', id, 'session.row', { kind: 'prompt', text: 'hello', summary: 'hello' })
  const c = await cli()
  const { sessions } = await c.cmd('status')
  expect(sessions.find((s: any) => s.id === id)).toMatchObject({ owner: 'luca', machine: 'laptop', task: 'hello', connected: true })
  const jp = await bridge('dev-jp')
  await expect(ingest(jp, 'other:1', id, 'session.row', { kind: 'prompt', text: 'x' })).rejects.toThrow(/belongs to luca/)
  for (const x of [a.client, jp.client, c]) x.close()
})

test('a new process takes a session over, and the old one is fenced off for good', async () => {
  const old = await bridge()
  const id = crypto.randomUUID()
  await start(old, 'laptop:200', id)
  old.client.sub(`bridge:${id}`, 0)

  // The new process attaches before its session.started arrives, then takes over.
  const next = await bridge()
  expect(await next.client.cmd<{ attached: boolean }>('attach', { sessionId: id, holder: 'box:300' })).toEqual({ attached: true })
  next.client.sub(`bridge:${id}`, 0)
  await start(next, 'box:300', id)
  await Bun.sleep(100)
  expect(old.superseded).toEqual([`${id}@box`]) // told where it runs now

  // The old process's events are acknowledged but dropped, including its exit.
  const late = await ingest(old, 'laptop:200', id, 'session.ended', { reason: 'exit' })
  expect(late.acked).toHaveLength(1)
  expect(late.superseded).toEqual({ [id]: 'box' })
  // Restarting its bridge doesn't win the session back.
  expect((await start(old, 'laptop:200', id)).superseded).toEqual({ [id]: 'box' })
  await expect(old.client.cmd('attach', { sessionId: id, holder: 'laptop:200' })).rejects.toThrow(/now runs on box/)

  const c = await cli()
  const { session } = await c.cmd('show', { sessionId: id, tail: 0 })
  expect(session).toMatchObject({ machine: 'box', state: 'idle' })

  // Commands name the process they're for.
  await c.cmd('send', { sessionId: id, text: 'carry on' })
  await Bun.sleep(100)
  expect(next.commands.at(-1)).toMatchObject({ holder: 'box:300', command: { kind: 'deliver', text: 'carry on' } })
  for (const x of [old.client, next.client, c]) x.close()
})

test('a deferred permission request can still be allowed, and the agent is told', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'box:400', id)
  b.client.sub(`bridge:${id}`, 0)
  await ingest(b, 'box:400', id, 'permission.requested', { reqId: 'p_1', tool: 'Bash', input: '{"command":"touch x"}' })
  await ingest(b, 'box:400', id, 'permission.resolved', { reqId: 'p_1', decision: 'deferred' })

  const c = await cli()
  const { permissions } = await c.cmd('permissions')
  expect(permissions.find((p: any) => p.reqId === 'p_1')).toMatchObject({ state: 'deferred' })
  const decided = await c.cmd('decide', { reqId: 'p_1', decision: 'allow' })
  expect(decided.msgId).toBeString()
  await Bun.sleep(100)
  expect(b.commands.at(-1)).toMatchObject({ holder: 'box:400', command: { kind: 'permission', reqId: 'p_1', decision: 'allow' } })
  expect(await c.cmd('delivery', { msgId: decided.msgId })).toMatchObject({ kind: 'permission', state: 'queued' })
  await expect(c.cmd('decide', { reqId: 'p_1', decision: 'deny' })).rejects.toThrow(/already allowed/)
  // Someone else's request isn't theirs to decide.
  const jp = await cli('dev-jp')
  await ingest(b, 'box:400', id, 'permission.requested', { reqId: 'p_2', tool: 'Bash', input: '{}' })
  await expect(jp.cmd('decide', { reqId: 'p_2', decision: 'allow' })).rejects.toThrow(/only luca/)
  for (const x of [b.client, c, jp]) x.close()
})

test('a bridge from an older checkout is told to update', async () => {
  const ws = new WebSocket(URL)
  const closed = new Promise<number>(resolve => (ws.onclose = e => resolve(e.code)))
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: 'dev-luca', role: 'bridge' }))
  expect(await closed).toBe(4002)
})

test('two decisions at once: one wins, the other is refused', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'box:500', id)
  await ingest(b, 'box:500', id, 'permission.requested', { reqId: 'p_race', tool: 'Bash', input: '{}' })
  const c = await cli()
  const both = await Promise.allSettled([c.cmd('decide', { reqId: 'p_race', decision: 'allow' }), c.cmd('decide', { reqId: 'p_race', decision: 'deny' })])
  expect(both.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  for (const x of [b.client, c]) x.close()
})

test("a session can't settle another session's permission request", async () => {
  const luca = await bridge()
  const id = crypto.randomUUID()
  await start(luca, 'laptop:600', id)
  await ingest(luca, 'laptop:600', id, 'permission.requested', { reqId: 'p_mine', tool: 'Bash', input: '{}' })
  const jp = await bridge('dev-jp')
  const other = crypto.randomUUID()
  await start(jp, 'jp-laptop:1', other)
  await ingest(jp, 'jp-laptop:1', other, 'permission.resolved', { reqId: 'p_mine', decision: 'allow' })
  await ingest(jp, 'jp-laptop:1', other, 'permission.requested', { reqId: 'p_mine', tool: 'Bash', input: '{"command":"rm -rf"}' })
  const c = await cli()
  const { permissions } = await c.cmd('permissions')
  expect(permissions.find((p: any) => p.reqId === 'p_mine')).toMatchObject({ sessionId: id, state: 'pending', input: '{}' })
  for (const x of [luca.client, jp.client, c]) x.close()
})

test('a resumed session is live again, and can end again', async () => {
  const first = await bridge()
  const id = crypto.randomUUID()
  await start(first, 'laptop:700', id)
  await first.client.cmd('ingest', { events: [{ key: `${id}:laptop:700:ended`, type: 'session.ended', data: { sessionId: id, reason: 'exit' }, holder: 'laptop:700' }] })
  const c = await cli()
  expect((await c.cmd('show', { sessionId: id, tail: 0 })).session.state).toBe('ended')

  const resumed = await bridge()
  await start(resumed, 'laptop:701', id)
  expect((await c.cmd('show', { sessionId: id, tail: 0 })).session).toMatchObject({ state: 'idle', connected: true })
  await resumed.client.cmd('ingest', { events: [{ key: `${id}:laptop:701:ended`, type: 'session.ended', data: { sessionId: id, reason: 'exit' }, holder: 'laptop:701' }] })
  expect((await c.cmd('show', { sessionId: id, tail: 0 })).session.state).toBe('ended')
  for (const x of [first.client, resumed.client, c]) x.close()
})

test('a row with NULs is stored without them, so the events behind it go through', async () => {
  // Sent the way any bridge sends, including one from before `rejected`: the server alone
  // makes these storable. Postgres refuses U+0000 in jsonb and text, and a lone surrogate in jsonb.
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:750', id)
  const row = (data: Record<string, unknown>) => ({ key: crypto.randomUUID(), type: 'session.row', data: { sessionId: id, kind: 'tool-result', summary: 'x', ...data }, holder: 'laptop:750' })
  const nul = row({ text: 'a\u0000b', nested: { list: ['c\u0000d', { 'k\u0000ey': 'v\u0000' }], n: 1, ok: true, none: null } })
  // A backslash followed by "u0000" isn't a NUL, and stays as it is.
  const escaped = row({ text: 'C:\\u0000\\dir' })
  // Over ROW_TEXT_LIMIT: the body keeps all of it but the NUL; the row's text is cut inside the emoji.
  const long = row({ text: 'x'.repeat(3999) + '\u{1F600}\u0000end' })
  const after = row({ text: 'next' })
  const { acked, rejected } = await b.client.cmd('ingest', { events: [nul, escaped, long, after] })
  expect(acked).toEqual([nul, escaped, long, after].map(e => e.key))
  expect(rejected).toEqual([])

  const c = await cli()
  const { rows } = await c.cmd('show', { sessionId: id, tail: 10 })
  const [a, e, cut, n] = rows.map((r: any) => r.data)
  expect(a).toMatchObject({ text: 'ab', nested: { list: ['cd', { key: 'v' }], n: 1, ok: true, none: null } })
  expect(e.text).toBe('C:\\u0000\\dir')
  expect(cut.text).toBe('x'.repeat(3999) + '\uFFFD')
  const body = (await c.cmd('body', { id: cut.bodyId })).text
  expect(body).toBe('x'.repeat(3999) + '\u{1F600}end')
  expect(cut.fullLength).toBe(body.length)
  expect(n.text).toBe('next')
  for (const x of [b.client, c]) x.close()
})

test("a NUL in a session id can't pass for a new session and take over someone else's", async () => {
  const luca = await bridge()
  const id = crypto.randomUUID()
  await start(luca, 'laptop:770', id)
  const jp = await bridge('dev-jp')
  await expect(start(jp, 'jp-laptop:1', `${id}\u0000`)).rejects.toThrow(/belongs to luca/)
  await expect(ingest(jp, 'jp-laptop:1', `\u0000${id}`, 'session.row', { kind: 'prompt', text: 'x' })).rejects.toThrow(/belongs to luca/)
  const c = await cli()
  expect((await c.cmd('show', { sessionId: id, tail: 10 })).session).toMatchObject({ owner: 'luca', machine: 'laptop' })
  // Its own bridge still reports.
  expect((await ingest(luca, 'laptop:770', id, 'session.row', { kind: 'prompt', text: 'still mine' })).acked).toHaveLength(1)
  for (const x of [luca.client, jp.client, c]) x.close()
})

test('an event the database can never store is rejected, and the rest of its batch is stored', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:760', id)
  const row = (key: string, text: string) => ({ key, type: 'session.row', data: { sessionId: id, kind: 'prompt', text, summary: text }, holder: 'laptop:760' })
  // The key is the event's identity, so it's stored as sent; Postgres refuses a NUL in text.
  // (If keys are ever cleaned too, pick another event Postgres refuses.)
  const [before, bad, after] = [row(crypto.randomUUID(), 'before'), row(`row:\u0000${crypto.randomUUID()}`, 'bad'), row(crypto.randomUUID(), 'after')]
  const r = await b.client.cmd('ingest', { events: [before, bad, after] })
  // Acknowledged as well, so a bridge from before `rejected` drops it rather than send it forever.
  expect(r.acked).toEqual([before.key, bad.key, after.key])
  expect(r.rejected).toEqual([{ key: bad.key, error: expect.stringContaining('(22021)') }])
  const c = await cli()
  const { rows } = await c.cmd('show', { sessionId: id, tail: 10 })
  expect(rows.map((r: any) => r.data.text)).toEqual(['before', 'after'])
  for (const x of [b.client, c]) x.close()
})

test('a bridge sets aside an event the server rejects, logs it once, and sends the rest', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sphere-bridge-'))
  const id = crypto.randomUUID()
  const bridge = Bun.spawn(['bun', 'sphere/src/cli.ts', 'bridge', '--session', id, '--cwd', ROOT], {
    cwd: ROOT,
    env: { ...process.env, SPHERE_HOME: home, SPHERE_URL: URL, SPHERE_TOKEN: 'dev-luca' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    // The bridge tells the mod (its parent; here, this test) where its socket is.
    const lines = bridge.stdout.pipeThrough(new TextDecoderStream()).getReader()
    let ready: { socket: string; secret: string } | undefined
    for (let buf = ''; !ready; ) {
      const { value, done } = await lines.read()
      if (done) throw new Error('bridge exited')
      buf += value
      ready = buf.split('\n').map(l => (l.startsWith('{') ? JSON.parse(l) : null)).find(m => m?.kind === 'ready')
    }
    const row = (key: string, text: string) => ({ key, type: 'session.row', data: { sessionId: id, kind: 'prompt', text, summary: text } })
    const post = async (events: unknown[]) =>
      expect((await fetch('http://bridge/events', { unix: ready!.socket, method: 'POST', headers: { 'x-sphere-secret': ready!.secret }, body: JSON.stringify({ events }) })).status).toBe(204)
    // A NUL in its key: the server rejects it (see the test above).
    const bad = row(`row:\u0000${crypto.randomUUID()}`, 'bad')
    await post([bad, row(crypto.randomUUID(), 'first after'), row(crypto.randomUUID(), 'second after')])

    // Settled once the server has the rows and the outbox beside the dead letter is empty.
    const c = await cli()
    const dir = join(home, 'sessions', `${id}.${process.pid}`)
    const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null)
    const texts = async () => (await c.cmd('show', { sessionId: id, tail: 10 }).catch(() => ({ rows: [] }))).rows.map((r: any) => r.data.text)
    const settled = async () => (await texts()).length === 2 && read('outbox.jsonl') === '' && read('dead-letter.jsonl') !== null
    const until = async (done: () => Promise<boolean>) => {
      for (const end = Date.now() + 8000; !(await done()) && Date.now() < end; ) await Bun.sleep(100)
    }
    await until(settled)
    expect(await texts()).toEqual(['first after', 'second after'])
    expect(read('outbox.jsonl')).toBe('')
    const dead = () => read('dead-letter.jsonl')!.trim().split('\n').map(l => JSON.parse(l))
    expect(dead()).toEqual([{ at: expect.any(String), error: expect.stringContaining('(22021)'), event: { ...bad, data: { ...bad.data, sessionId: id }, holder: `${hostname()}:${process.pid}` } }])

    // Sent again (as by a bridge that stopped before it could ack): it isn't set aside twice.
    await post([bad, row(crypto.randomUUID(), 'third after')])
    await until(async () => (await texts()).length === 3 && read('outbox.jsonl') === '')
    expect(await texts()).toEqual(['first after', 'second after', 'third after'])
    expect(dead()).toHaveLength(1)
    c.close()
    await Bun.sleep(500) // a few more send rounds: nothing is sent again
  } finally {
    bridge.kill()
    await bridge.exited
  }
  const log = await new Response(bridge.stderr).text()
  expect(log.match(/set aside session\.row "row:/g)).toHaveLength(1)
}, 20_000)

test("another site's page can't open a connection", async () => {
  const upgrade = (origin: string) =>
    fetch(`http://127.0.0.1:${PORT}/ws`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin } })
  expect((await upgrade('https://evil.example')).status).toBe(403)
  expect((await upgrade(`http://127.0.0.1:${PORT}`)).status).toBe(101)
})

test('a session with no holder is refused commands, and its suggestions stay pending', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  // Recorded the way a bridge from before holders existed did: no holder.
  await b.client.cmd('ingest', { events: [{ key: crypto.randomUUID(), type: 'session.started', data: { sessionId: id, machine: 'old', cwd: '/tmp/x', repo: 'x', branch: 'main', pid: 1, interactive: true } }] })
  const c = await cli()
  await expect(c.cmd('send', { sessionId: id, text: 'hello' })).rejects.toThrow(/restart it/)
  const jp = await cli('dev-jp')
  const { suggestionId } = await jp.cmd('suggest', { sessionId: id, text: 'try this' })
  await expect(c.cmd('approve', { id: suggestionId })).rejects.toThrow(/restart it/)
  const { suggestions } = await c.cmd('approvals')
  expect(suggestions.find((x: any) => x.id === suggestionId)).toMatchObject({ status: 'pending' })
  // Once a current bridge starts it, it names its process and commands flow again.
  await start(b, 'laptop:800', id)
  expect(await c.cmd('approve', { id: suggestionId })).toMatchObject({ status: 'approved' })
  for (const x of [b.client, c, jp]) x.close()
})

test("estra's labels are stored and put the session in its ticket's frame", async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:900', id, { labels: ESTRA })
  const c = await cli()
  expect(await shown(c, id)).toEqual({ labels: ESTRA, frame: 'region:ticket:CS-77' })
  const { sessions } = await c.cmd('status')
  expect(sessions.find((s: any) => s.id === id).labels).toEqual(ESTRA)
  // A bridge from before tickets sends only the label; that is the session's ticket.
  expect(sessions.find((s: any) => s.id === id).ticket).toEqual({ id: 'CS-77', source: 'estra' })
  // A second stage of the same ticket joins the same frame, in the next slot.
  const next = crypto.randomUUID()
  await start(b, 'laptop:901', next, { labels: { ...ESTRA, stage: 'review', provider: 'claude' } })
  const { layout } = await c.cmd('canvas')
  const [first, second] = [id, next].map(x => layout.find((l: any) => l.id === x))
  expect(second.parent).toBe('region:ticket:CS-77')
  expect([second.x, second.y]).not.toEqual([first.x, first.y])
  for (const x of [b.client, c]) x.close()
})

test('a card saved in a frame its session has left keeps its slot', async () => {
  const b = await bridge()
  const c = await cli()
  const [id, next] = [crypto.randomUUID(), crypto.randomUUID()]
  await start(b, 'laptop:950', id, { labels: { ...ESTRA, ticket: 'CS-79' } })
  await start(b, 'laptop:951', next, { labels: { ...ESTRA, ticket: 'CS-79', stage: 'review' } })
  const card = async (x: string) => (await c.cmd('canvas')).layout.find((l: any) => l.id === x)
  const slot = await card(next)
  // A page from before ticket frames drew the card in its repo's frame, and saves it there.
  await c.cmd('layout.set', { items: [{ id: next, kind: 'session', x: 0, y: 0, parent: 'region:x' }] })
  expect(await card(next)).toEqual(slot)
  await c.cmd('layout.set', { items: [{ id: next, kind: 'session', x: 900, y: 40, parent: 'region:ticket:CS-79' }] })
  expect(await card(next)).toMatchObject({ x: 900, y: 40, parent: 'region:ticket:CS-79' })
  for (const x of [b.client, c]) x.close()
})

test('a session without labels (older estra or bridge, or no estra) stays in its repo frame', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:910', id)
  const c = await cli()
  expect(await shown(c, id)).toEqual({ labels: null, frame: 'region:x' })
  for (const x of [b.client, c]) x.close()
})

test('labels are cleaned, and a resume that sends none keeps them', async () => {
  const b = await bridge()
  const c = await cli()
  const junk = crypto.randomUUID()
  await start(b, 'laptop:920', junk, { labels: { ticket: 42, stage: '  ', provider: ['codex'], taskId: null } })
  expect(await shown(c, junk)).toEqual({ labels: null, frame: 'region:x' })
  const messy = crypto.randomUUID()
  await start(b, 'laptop:921', messy, { labels: { ticket: ' CS-78\n', stage: 'p'.repeat(200) } })
  expect((await shown(c, messy)).labels).toEqual({ ticket: 'CS-78', stage: 'p'.repeat(80), taskId: null, provider: null })

  // Someone resumes an estra session by hand: no labels this time, same ticket and frame.
  const id = crypto.randomUUID()
  await start(b, 'laptop:930', id, { labels: ESTRA })
  await start(b, 'laptop:931', id)
  expect(await shown(c, id)).toEqual({ labels: ESTRA, frame: 'region:ticket:CS-77' })
  for (const x of [b.client, c]) x.close()
})

test("a session shows its ticket and what Linear says about it, and follows Linear's changes", async () => {
  const b = await bridge()
  const c = await cli()
  const id = crypto.randomUUID()
  await start(b, 'laptop:960', id, { branch: 'lucadeleo/cs-501-show-tickets', ticket: { id: 'CS-501', source: 'branch' } })
  // A ticket found in a branch name shows once Linear has it: read within a second of the
  // session starting, not at the next poll. Then the session moves to the ticket's frame.
  expect((await c.cmd('show', { sessionId: id, tail: 0 })).session.ticket).toBeNull()
  const status = () => c.cmd('status')
  const first = await eventually(status, r => !!r.tickets['CS-501'] && !!r.sessions.find((s: any) => s.id === id).ticket, 1500)
  expect(first.sessions.find((s: any) => s.id === id).ticket).toEqual({ id: 'CS-501', source: 'branch' })
  expect(await shown(c, id)).toEqual({ labels: null, frame: 'region:ticket:CS-501' })
  expect(first.tickets['CS-501']).toMatchObject({ title: 'Show tickets on cards', status: { name: 'In Progress' }, assignee: 'Luca De Leo' })
  expect(linear.requests.at(-1)!.authorization).toBe('test-key')

  // Moved in Linear: the next read (every second here, every minute by default) has it.
  linear.table.get('CS-501')!.status = 'In Review'
  const moved = await eventually(status, r => r.tickets['CS-501']?.status.name === 'In Review')
  expect(moved.tickets['CS-501'].status).toEqual({ name: 'In Review', type: 'started', color: '#0f783c' })

  // A resume that finds no ticket keeps it.
  await start(b, 'laptop:961', id, { branch: 'main' })
  expect((await c.cmd('show', { sessionId: id, tail: 0 })).session.ticket).toEqual({ id: 'CS-501', source: 'branch' })
  for (const x of [b.client, c]) x.close()
})

test('a bridge from before tickets reports as before, and its session has no ticket', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  // Its branch names a ticket, but it doesn't say so: that's no ticket.
  await start(b, 'laptop:970', id, { branch: 'lucadeleo/cs-501-show-tickets' })
  await ingest(b, 'laptop:970', id, 'session.row', { kind: 'prompt', text: 'hello', summary: 'hello' })
  const c = await cli()
  const { session } = await c.cmd('show', { sessionId: id, tail: 0 })
  expect(session).toMatchObject({ ticket: null, task: 'hello', connected: true })
  expect(await shown(c, id)).toEqual({ labels: null, frame: 'region:x' })
  for (const x of [b.client, c]) x.close()
})

test('sphere sessions --ticket lists that ticket\'s sessions, with what Linear says', async () => {
  const b = await bridge()
  const [mine, other] = [crypto.randomUUID(), crypto.randomUUID()]
  await start(b, 'laptop:980', mine, { ticket: { id: 'CS-501', source: 'orca' } })
  await start(b, 'laptop:981', other, { labels: { ...ESTRA, ticket: 'CS-502' } })
  // A branch like `deps/react-19` reads as REACT-19, which Linear has no issue for.
  const react = crypto.randomUUID()
  await start(b, 'laptop:982', react, { branch: 'deps/react-19', ticket: { id: 'REACT-19', source: 'branch' } })
  const c = await cli()
  await eventually(() => c.cmd('status'), r => !!r.tickets['CS-501'])
  const asked = async () => linear.requests.some(r => JSON.stringify(r.variables).includes('"REACT"'))
  expect(await eventually(asked, x => x)).toBe(true)
  expect((await c.cmd('show', { sessionId: react, tail: 0 })).session.ticket).toBeNull()
  expect(await shown(c, react)).toEqual({ labels: null, frame: 'region:x' })
  c.close()
  const sessions = async (...args: string[]) => {
    const p = Bun.spawn(['bun', 'sphere/src/cli.ts', 'sessions', ...args, '--json'], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, SPHERE_URL: URL, SPHERE_TOKEN: 'dev-luca' },
      stdout: 'pipe',
    })
    return JSON.parse(await new Response(p.stdout).text()) as any[]
  }
  const on501 = await sessions('--ticket', 'cs-501')
  expect(on501.map(s => s.id)).toContain(mine)
  expect(on501.map(s => s.id)).not.toContain(other)
  expect(on501.find(s => s.id === mine).ticket).toMatchObject({ id: 'CS-501', source: 'orca', title: 'Show tickets on cards' })
  // A ticket Linear doesn't know (or an estra ticket from Asana) still lists, by its id.
  expect((await sessions('--ticket', 'CS-502')).map(s => [s.id, s.ticket])).toEqual([[other, { id: 'CS-502', source: 'estra' }]])
  expect(await sessions('--ticket', 'REACT-19')).toEqual([])
  b.client.close()
})

test('labels come back from the log after a restart, including ones an older server stored', async () => {
  // An older server stores a newer bridge's labels with the event without reading them;
  // a server that reads them rebuilds them from the log, as it does after any restart.
  // Tickets the same, and so does Linear's confirmation of a ticket found in a branch name.
  const b = await bridge()
  const [id, ticketed] = [crypto.randomUUID(), crypto.randomUUID()]
  await start(b, 'laptop:940', id, { labels: ESTRA })
  await start(b, 'laptop:941', ticketed, { ticket: { id: 'CS-503', source: 'branch' } })
  const before = await cli()
  await eventually(() => before.cmd('show', { sessionId: ticketed, tail: 0 }), r => !!r.session.ticket, 1500)
  for (const x of [b.client, before]) x.close()
  // Linear is down when the server comes back.
  linear.fail(503)
  server.kill()
  await server.exited
  await startServer()
  const c = await cli()
  expect(await shown(c, id)).toEqual({ labels: ESTRA, frame: 'region:ticket:CS-77' })
  expect(await shown(c, ticketed)).toEqual({ labels: null, frame: 'region:ticket:CS-503' })
  expect((await c.cmd('show', { sessionId: ticketed, tail: 0 })).session.ticket).toEqual({ id: 'CS-503', source: 'branch' })
  // Linear is read again once it answers.
  linear.fail(null)
  expect((await eventually(() => c.cmd('status', { all: true }), r => !!r.tickets['CS-503'], 3000)).tickets['CS-503']).toBeDefined()
  c.close()
})

// ---------------------------------------------------------------------------------------------
// Structured transcript rows (protocol 3), and paging through a session's history.
// ---------------------------------------------------------------------------------------------

const row = (b: Bridge, holder: string, id: string, data: Record<string, unknown>) => ingest(b, holder, id, 'session.row', { summary: String(data.text ?? '').split('\n')[0], ...data })

test('a tool call is stored with its input as an object, long fields capped into bodies', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1000', id)
  const big = 'const a = 1\n'.repeat(1500) // 18,000 characters: over the 8,000 kept in the row
  const input = { file_path: '/x/a.ts', old_string: big, new_string: 'const a = 2\n' }
  await row(b, 'laptop:1000', id, {
    kind: 'tool-call',
    text: `Edit ${JSON.stringify(input).slice(0, 2000)}`,
    tools: [{ name: 'Edit', id: 'toolu_1' }],
    calls: [{ id: 'toolu_1', name: 'Edit', input }],
    // Only the server sets these; a bridge that sends them is ignored.
    capped: [{ path: ['text'], bodyId: 'forged', fullLength: 1 }],
  })
  await row(b, 'laptop:1000', id, {
    kind: 'tool-result',
    text: 'The file has been updated.',
    toolUseIds: ['toolu_1'],
    results: [{ id: 'toolu_1', isError: false, output: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const a = 1', '+const a = 2'] }] } }],
  })
  const c = await cli()
  const { rows } = await c.cmd('show', { sessionId: id, tail: 10 })
  const [call, result] = rows.map((r: any) => r.data)
  // What an older page or CLI reads is as it always was.
  expect(call.text.startsWith('Edit {"file_path":"/x/a.ts"')).toBe(true)
  expect(call.calls[0].input.new_string).toBe('const a = 2\n')
  expect(call.calls[0].input.old_string).toHaveLength(8000)
  expect(call.capped).toEqual([{ path: ['calls', 0, 'input', 'old_string'], bodyId: expect.any(String), fullLength: big.length }])
  expect((await c.cmd('body', { id: call.capped[0].bodyId })).text).toBe(big)
  expect(result.results[0].output.structuredPatch[0].lines).toEqual(['-const a = 1', '+const a = 2'])
  expect(result.capped).toBeUndefined()
  for (const x of [b.client, c]) x.close()
})

test('thinking is its own row, and leaves the card showing what the session last did', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1010', id)
  await row(b, 'laptop:1010', id, { kind: 'tool-call', text: 'Bash {"command":"ls"}', tools: [{ name: 'Bash', id: 't' }] })
  await row(b, 'laptop:1010', id, { kind: 'thinking', text: 'The listing shows two files; the config is the one to read.' })
  const c = await cli()
  const { session, rows } = await c.cmd('show', { sessionId: id, tail: 10 })
  expect(rows.map((r: any) => r.data.kind)).toEqual(['tool-call', 'thinking'])
  expect(session.lastSummary).toBe('Bash {"command":"ls"}')
  for (const x of [b.client, c]) x.close()
})

test('older history is served a page at a time', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1020', id)
  await b.client.cmd('ingest', {
    events: Array.from({ length: 25 }, (_, i) => ({ key: crypto.randomUUID(), type: 'session.row', data: { sessionId: id, kind: 'assistant', text: `row ${i}`, summary: `row ${i}` }, holder: 'laptop:1020' })),
  })
  const c = await cli()
  const texts = (r: any) => r.rows.map((e: any) => e.data.text)
  const last = await c.cmd('show', { sessionId: id, tail: 10 })
  expect(texts(last)).toEqual(Array.from({ length: 10 }, (_, i) => `row ${15 + i}`))
  expect(last.more).toBe(true)
  const middle = await c.cmd('show', { sessionId: id, tail: 10, before: last.rows[0].seq })
  expect(texts(middle)).toEqual(Array.from({ length: 10 }, (_, i) => `row ${5 + i}`))
  expect(middle.more).toBe(true)
  const first = await c.cmd('show', { sessionId: id, tail: 10, before: middle.rows[0].seq })
  expect(texts(first)).toEqual(Array.from({ length: 5 }, (_, i) => `row ${i}`))
  expect(first.more).toBe(false)
  await expect(c.cmd('show', { sessionId: id, tail: 10, before: 'soon' })).rejects.toThrow(/before must be a row seq/)
  // Exactly a page's worth left: no further page.
  expect((await c.cmd('show', { sessionId: id, tail: 5, before: middle.rows[0].seq })).more).toBe(false)
  for (const x of [b.client, c]) x.close()
})

test('bridges from before structured rows still report, and their rows show as before', async () => {
  // A bridge on protocol 2 (holders, no structured rows) is accepted, and told the server's protocol.
  const ws = new WebSocket(URL)
  const welcome = new Promise<any>(resolve => (ws.onmessage = m => resolve(JSON.parse(String(m.data)))))
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: 'dev-luca', role: 'bridge', protocol: 2 }))
  expect(await welcome).toMatchObject({ t: 'welcome', protocol: PROTOCOL })
  ws.close()

  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1030', id)
  await row(b, 'laptop:1030', id, { kind: 'tool-call', text: 'Bash {"command":"ls -la"}', tools: [{ name: 'Bash', id: 't1' }] })
  const c = await cli()
  const { rows } = await c.cmd('show', { sessionId: id, tail: 5 })
  expect(rows[0].data).toEqual({ sessionId: id, kind: 'tool-call', text: 'Bash {"command":"ls -la"}', summary: 'Bash {"command":"ls -la"}', tools: [{ name: 'Bash', id: 't1' }] })
  for (const x of [b.client, c]) x.close()
})

test('a bridge talking to a server from before structured rows sends rows as that server knew them', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1040', id)
  b.client.serverProtocol = 2 // as an older server's welcome leaves it
  const dir = mkdtempSync(join(tmpdir(), 'sphere-outbox-'))
  const box = new Outbox(join(dir, 'outbox.jsonl'))
  const holder = 'laptop:1040'
  box.push({ key: crypto.randomUUID(), type: 'session.row', data: { sessionId: id, kind: 'thinking', text: 'hmm', summary: 'hmm' }, holder })
  box.push({ key: crypto.randomUUID(), type: 'session.row', data: { sessionId: id, kind: 'tool-call', text: 'Bash {"command":"ls"}', summary: 'Bash', calls: [{ id: 't', name: 'Bash', input: { command: 'ls' } }] }, holder })
  const sent = await sendFrom(b.client, box)
  expect(sent?.acked).toHaveLength(2) // the thinking row counts as sent, though it never left
  expect(box.events).toEqual([])
  const c = await cli()
  const { rows } = await c.cmd('show', { sessionId: id, tail: 5 })
  expect(rows.map((r: any) => r.data.kind)).toEqual(['tool-call'])
  expect(rows[0].data.calls).toBeUndefined()
  for (const x of [b.client, c]) x.close()
})

test("find in transcript searches a session's whole history, text and tool inputs", async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1050', id)
  await row(b, 'laptop:1050', id, { kind: 'prompt', text: 'Why is the Nightly Export slow?' })
  await row(b, 'laptop:1050', id, { kind: 'tool-call', text: 'Bash {"command":"psql"}', tools: [{ name: 'Bash', id: 'q1' }], calls: [{ id: 'q1', name: 'Bash', input: { command: 'psql -c "explain select * from nightly_export"' } }] })
  await row(b, 'laptop:1050', id, { kind: 'attachment', text: 'nightly export context the page never shows' })
  await row(b, 'laptop:1050', id, { kind: 'assistant', text: 'It scans 100% of the rows.' })
  const other = crypto.randomUUID()
  await start(b, 'laptop:1051', other)
  await row(b, 'laptop:1051', other, { kind: 'prompt', text: 'nightly export elsewhere' })
  const c = await cli()
  const { rows } = await c.cmd('show', { sessionId: id, tail: 10 })
  const seqOf = (kind: string) => rows.find((r: any) => r.data.kind === kind).seq
  // Any case; tool inputs too; never attachments or another session's rows; newest first.
  expect((await c.cmd('search', { sessionId: id, query: 'nightly' })).seqs).toEqual([seqOf('tool-call'), seqOf('prompt')])
  // `%` and `_` are text, not wildcards.
  expect((await c.cmd('search', { sessionId: id, query: '100%' })).seqs).toEqual([seqOf('assistant')])
  expect((await c.cmd('search', { sessionId: id, query: 'nightly_' })).seqs).toEqual([seqOf('tool-call')])
  await expect(c.cmd('search', { sessionId: id, query: '  ' })).rejects.toThrow(/query required/)
  for (const x of [b.client, c]) x.close()
})

test("a session's permission requests come with their answers, for its transcript", async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'box:1060', id)
  await ingest(b, 'box:1060', id, 'permission.requested', { reqId: 'p_t1', tool: 'Bash', input: '{"command":"rm -rf build"}' })
  await ingest(b, 'box:1060', id, 'permission.requested', { reqId: 'p_t2', tool: 'Bash', input: '{"command":"ls"}' })
  const c = await cli()
  await c.cmd('decide', { reqId: 'p_t1', decision: 'allow' })
  const { permissions } = await c.cmd('permissions', { sessionId: id })
  expect(permissions.map((p: any) => [p.reqId, p.state]).sort()).toEqual([['p_t1', 'allowed'], ['p_t2', 'pending']])
  // Without a session, still only what's waiting, as before.
  expect((await c.cmd('permissions', { all: true })).permissions.some((p: any) => p.reqId === 'p_t1')).toBe(false)
  for (const x of [b.client, c]) x.close()
})

test('a reply in progress reaches whoever has the session open, and is never stored', async () => {
  const b = await bridge()
  const id = crypto.randomUUID()
  await start(b, 'laptop:1100', id)
  await ingest(b, 'laptop:1100', id, 'session.status', { state: 'working', turnId: 't1' })
  // A page with the session's transcript open.
  const got: any[] = []
  const live = Promise.withResolvers<void>()
  const page = new Client({ url: URL, token: 'dev-luca' }, 'web', { onLive: () => live.resolve(), onPartial: p => got.push(p) })
  await page.connect()
  page.sub(`session:${id}`, 0)
  await live.promise
  const sent = await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', turnId: 't1', step: 0, block: 0, text: 'First paragraph.' })
  expect(sent).toEqual({ sent: true })
  await eventually(async () => got.length, n => n > 0)
  expect(got).toMatchObject([{ sessionId: id, turnId: 't1', step: 0, block: 0, text: 'First paragraph.' }])
  // A subagent's is named by its agent, and passed on only while that subagent runs.
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', agentId: 'sub-1', turnId: 't1', step: 0, block: 0, text: 'Too soon.' })).toEqual({ sent: false })
  await ingest(b, 'laptop:1100', id, 'session.agent', { agentId: 'sub-1', state: 'running', description: 'Find callers' })
  await b.client.cmd('partial', { sessionId: id, holder: 'laptop:1100', agentId: 'sub-1', turnId: 't1', step: 0, block: 0, text: 'Found two.' })
  await eventually(async () => got.length, n => n > 1)
  expect(got[1]).toMatchObject({ agentId: 'sub-1', text: 'Found two.' })
  expect(got[0].agentId).toBeUndefined()
  const c = await cli()
  expect((await c.cmd('show', { sessionId: id, tail: 10 })).rows).toEqual([])
  // Only the process that runs the session, and only its owner.
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:9999', turnId: 't1', step: 0, block: 0, text: 'x' })).toEqual({ sent: false })
  const jp = await bridge('dev-jp')
  await expect(jp.client.cmd('partial', { sessionId: id, holder: 'laptop:1100', turnId: 't1', step: 0, block: 0, text: 'x' })).rejects.toThrow(/not your session/)
  await expect(c.cmd('partial', { sessionId: id, turnId: 't1', step: 0, block: 0, text: 'x' })).rejects.toThrow(/only bridges/)
  // Nothing empty or past the limit is passed on.
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', turnId: 't1', step: 0, block: 0, text: 'y'.repeat(20_001) })).toEqual({ sent: false })
  // Nor one for another turn, nor any once the session stops working (its row has replaced it).
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', turnId: 't0', step: 0, block: 0, text: 'x' })).toEqual({ sent: false })
  await ingest(b, 'laptop:1100', id, 'session.status', { state: 'idle', turnId: null })
  await eventually(async () => (await c.cmd('show', { sessionId: id, tail: 0 })).session.state, st => st === 'idle')
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', turnId: 't1', step: 0, block: 0, text: 'Late.' })).toEqual({ sent: false })
  // A subagent in the background writes on after the main agent's turn, while it runs.
  await ingest(b, 'laptop:1100', id, 'session.agent', { agentId: 'bg-1', state: 'running', description: 'Watch CI', background: true })
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', agentId: 'bg-1', turnId: 'r1', step: 0, block: 0, text: 'Still watching.' })).toEqual({ sent: true })
  await ingest(b, 'laptop:1100', id, 'session.agent', { agentId: 'bg-1', state: 'done' })
  expect(await b.client.cmd<{ sent: boolean }>('partial', { sessionId: id, holder: 'laptop:1100', agentId: 'bg-1', turnId: 'r1', step: 0, block: 0, text: 'Late.' })).toEqual({ sent: false })
  await eventually(async () => got.length, n => n > 2)
  await Bun.sleep(50)
  expect(got.map(p => p.text)).toEqual(['First paragraph.', 'Found two.', 'Still watching.'])
  for (const x of [page, b.client, jp.client, c]) x.close()
})
