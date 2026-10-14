// Linear accounts and changes through sphere-server (CS-2524, CS-2523), against a stand-in for
// Linear and a scratch Postgres database, the way pages and the CLI use them.
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { linearStub, STUB_CLIENT } from '../scripts/linear-stub'
import { connect } from '../server/src/pg'
import { Client } from '../sphere/src/client'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/sphere_test'
const PORT = 7465
const HTTP = `http://127.0.0.1:${PORT}`
const URL_ = `ws://127.0.0.1:${PORT}/ws`
const linear = linearStub({
  'CS-601': { title: 'Change tickets from Dyson Sphere', status: 'Todo', assignee: 'JP Addison' },
})
let server: Subprocess

beforeAll(async () => {
  const sql = connect(DATABASE_URL)
  await sql`drop table if exists events, bodies, canvas_rooms, linear_accounts`
  await sql.close()
  server = Bun.spawn(['bun', 'run', 'server/src/main.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      DATABASE_URL,
      SPHERE_PORT: String(PORT),
      NODE_ENV: 'test',
      SPHERE_LINEAR_KEY: 'test-key',
      SPHERE_LINEAR_URL: linear.url,
      SPHERE_LINEAR_CLIENT_ID: STUB_CLIENT.id,
      SPHERE_LINEAR_CLIENT_SECRET: STUB_CLIENT.secret,
      SPHERE_LINEAR_TOKEN_KEY: 'test-token-key-of-at-least-32-characters',
      SPHERE_TRUST: 'luca:ops-bot',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${HTTP}/`)).ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error('sphere-server did not start')
})

afterAll(() => {
  server?.kill()
  linear.stop()
})

async function client(token = 'dev-luca', role: 'cli' | 'web' | 'bridge' = 'cli') {
  const c = new Client({ url: URL_, token }, role)
  await c.connect()
  return c
}

/** A person connects Linear as a browser would: the server's link, Linear's consent, the server's callback. */
async function connectLinear(c: Client, as: string): Promise<URL> {
  const { url } = await c.cmd<{ url: string }>('linear.connect')
  const consent = await fetch(`${url}&as=${as}`, { redirect: 'manual' })
  const callback = consent.headers.get('location')!
  expect(callback).toStartWith(`${HTTP}/linear/callback?`)
  const back = await fetch(callback, { redirect: 'manual' })
  expect(back.status).toBe(303)
  return new URL(back.headers.get('location')!, HTTP)
}

test('a person connects their own Linear account, sees whom as, and can disconnect', async () => {
  const luca = await client()
  expect(await luca.cmd<unknown>('linear.account')).toEqual({ enabled: true, connected: false })
  const back = await connectLinear(luca, 'user-luca')
  expect(back.pathname + back.search).toBe('/?linear=connected')
  expect(await luca.cmd<unknown>('linear.account')).toMatchObject({ enabled: true, connected: true, user: { id: 'user-luca', name: 'Luca De Leo' } })
  // Nobody else is connected by it.
  const jp = await client('dev-jp')
  expect(await jp.cmd<unknown>('linear.account')).toEqual({ enabled: true, connected: false })
  // The token stays on the server: not in any answer, and sealed in the database.
  const sql = connect(DATABASE_URL)
  const rows: { identity: string; sealed: string }[] = await sql`select identity, sealed from linear_accounts`
  await sql.close()
  expect(rows.map(r => r.identity)).toEqual(['luca'])
  expect(rows[0]!.sealed).not.toContain('stub_')

  expect(await jp.cmd<unknown>('linear.disconnect')).toEqual({ disconnected: false, revoked: false })
  expect(await luca.cmd<unknown>('linear.disconnect')).toEqual({ disconnected: true, revoked: true })
  expect(await luca.cmd<unknown>('linear.account')).toEqual({ enabled: true, connected: false })
  for (const c of [luca, jp]) c.close()
})

test('a callback that fails goes back to the canvas saying why', async () => {
  const bad = await fetch(`${HTTP}/linear/callback?state=nope&code=x`, { redirect: 'manual' })
  expect(bad.status).toBe(303)
  const to = new URL(bad.headers.get('location')!, HTTP)
  expect(to.searchParams.get('linear')).toBe('failed')
  expect(to.searchParams.get('why')).toContain('expired or was already used')

  const jp = await client('dev-jp')
  const back = await connectLinear(jp, 'deny')
  expect(back.searchParams.get('why')).toBe('Linear access was not granted.')
  expect(await jp.cmd<unknown>('linear.account')).toEqual({ enabled: true, connected: false })
  jp.close()
})

// ---------- changes in Linear (CS-2523) ----------

let n = 0
/** A session of `token`'s person, started by a bridge as the mod would. */
async function session(token: string, extra: Record<string, unknown> = {}) {
  const b = await client(token, 'bridge')
  const id = crypto.randomUUID()
  const holder = `laptop:${++n}`
  const start = (more: Record<string, unknown> = {}) =>
    b.cmd('ingest', { events: [{ key: crypto.randomUUID(), type: 'session.started', holder, data: { sessionId: id, machine: 'laptop', cwd: '/tmp/x', repo: 'x', branch: 'main', pid: 1, interactive: true, ...extra, ...more } }] })
  await start()
  return { id, bridge: b, start }
}

/** A page, as the canvas listens: every `ticket` message on `world`. */
async function page(token = 'dev-jp') {
  const heard: { id: string; ticket: any }[] = []
  const ws = new WebSocket(URL_)
  const live = Promise.withResolvers<void>()
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, role: 'web' }))
  ws.onmessage = m => {
    const msg = JSON.parse(String(m.data))
    if (msg.t === 'welcome') ws.send(JSON.stringify({ t: 'sub', topic: 'world' }))
    if (msg.t === 'live') live.resolve()
    if (msg.t === 'ticket') heard.push({ id: msg.id, ticket: msg.ticket })
  }
  await live.promise
  return { heard, close: () => ws.close() }
}

const shown = async (c: Client, id: string) => {
  const { session } = await c.cmd('show', { sessionId: id, tail: 0 })
  const { layout } = await c.cmd('canvas')
  return { ticket: session.ticket, frame: layout.find((l: any) => l.id === id)?.parent }
}

test("a person changes a ticket's status, assignee and title as themselves, and every canvas hears at once", async () => {
  const luca = await client()
  const s = await session('dev-luca', { ticket: { id: 'CS-601', source: 'orca' } })
  // Not connected: refused, and Linear never asked.
  await expect(luca.cmd('ticket.update', { sessionId: s.id, status: 'In Progress' })).rejects.toThrow(/connect your Linear account first/)
  await connectLinear(luca, 'user-luca')

  const watcher = await page()
  // From the CLI: by name; `me` is the Linear user it's made as.
  const r = await luca.cmd('ticket.update', { sessionId: s.id, status: 'in progress', assignee: 'me' })
  expect(r).toMatchObject({ as: 'luca', ticket: { id: 'CS-601', status: { name: 'In Progress', type: 'started' }, assignee: 'Luca De Leo' } })
  expect(linear.changes.at(-1)).toMatchObject({ by: 'user-luca', op: 'TicketUpdate', id: 'CS-601', input: { stateId: 'state-in-progress', assigneeId: 'user-luca' } })
  // Canvases hear Linear's answer now, not at the next read (once a minute here).
  await Bun.sleep(100)
  expect(watcher.heard.at(-1)).toMatchObject({ id: 'CS-601', ticket: { status: { name: 'In Progress' }, assignee: 'Luca De Leo' } })

  // From the canvas: the ticket's own statuses and people, then ids.
  const options = await luca.cmd('ticket.options', { id: 'CS-601' })
  expect(options.team).toMatchObject({ key: 'CS' })
  expect(options.statuses.map((x: any) => x.name)).toContain('In Review')
  expect(options.members.map((x: any) => x.id)).toEqual(['user-jp', 'user-luca'])
  expect(options.viewer).toBe('user-luca')
  // The ticket as luca's own Linear reads it, so a form can start from it without the server's key.
  expect(options.ticket).toMatchObject({ id: 'CS-601', status: { name: 'In Progress' }, assignee: 'Luca De Leo' })
  const review = options.statuses.find((x: any) => x.name === 'In Review').id
  expect((await luca.cmd('ticket.update', { id: 'CS-601', stateId: review, assigneeId: null, title: '  Change tickets from the canvas ' })).ticket).toMatchObject({
    title: 'Change tickets from the canvas',
    status: { name: 'In Review' },
    assignee: null,
  })
  await Bun.sleep(100)
  expect(watcher.heard.at(-1)!.ticket).toMatchObject({ title: 'Change tickets from the canvas', assignee: null })

  // What Linear refuses or doesn't have is the person's error, and says what there is.
  await expect(luca.cmd('ticket.update', { id: 'CS-601', status: 'Shipped' })).rejects.toThrow(/CS has no status "Shipped"; it has Triage, Backlog/)
  await expect(luca.cmd('ticket.update', { id: 'CS-601', assignee: 'nobody' })).rejects.toThrow(/nobody called "nobody"/)
  await expect(luca.cmd('ticket.update', { id: 'CS-601', stateId: 'state-made-up' })).rejects.toThrow(/Entity not found/)
  await expect(luca.cmd('ticket.update', { id: 'CS-601' })).rejects.toThrow(/nothing to change/)
  await expect(luca.cmd('ticket.update', { id: 'CS-601', title: '   ' })).rejects.toThrow(/needs a title/)
  // Changes never use the server's key.
  const mutations = linear.requests.filter(x => /^\s*mutation/.test(x.query))
  expect(mutations.length).toBeGreaterThan(0)
  for (const m of mutations) expect(m.authorization).toStartWith('Bearer ')
  for (const c of [luca, s.bridge]) c.close()
  watcher.close()
})

test("anyone changes a ticket through their own account; a trusted agent through its owner's, on that session only", async () => {
  const s = await session('dev-luca', { ticket: { id: 'CS-601', source: 'orca' } })
  const theirs = await session('dev-jp', { ticket: { id: 'CS-601', source: 'orca' } })
  const jp = await client('dev-jp')
  await expect(jp.cmd('ticket.update', { sessionId: s.id, status: 'Todo' })).rejects.toThrow(/connect your Linear account first/)
  await connectLinear(jp, 'user-jp')
  expect(await jp.cmd('ticket.update', { sessionId: s.id, status: 'Todo' })).toMatchObject({ as: 'jp' })
  expect(linear.changes.at(-1)).toMatchObject({ by: 'user-jp', id: 'CS-601' })

  // ops-bot, trusted by luca (SPHERE_TRUST), has no Linear account: it acts as luca on luca's session.
  const bot = await client('dev-bot')
  expect(await bot.cmd('ticket.update', { sessionId: s.id, status: 'In Progress' })).toMatchObject({ as: 'luca' })
  expect(linear.changes.at(-1)).toMatchObject({ by: 'user-luca', id: 'CS-601' })
  // Only that session's ticket, and not on sessions of people who don't trust it.
  await expect(bot.cmd('ticket.update', { sessionId: s.id, id: 'CS-602', status: 'Done' })).rejects.toThrow(/only this session's ticket \(CS-601\)/)
  await expect(bot.cmd('ticket.update', { id: 'CS-601', status: 'Done' })).rejects.toThrow(/connect your Linear account first/)
  await expect(bot.cmd('ticket.update', { sessionId: theirs.id, status: 'Done' })).rejects.toThrow(/connect your Linear account first/)
  // Once luca disconnects, it's refused, and says why.
  const luca = await client()
  await luca.cmd('linear.disconnect')
  await expect(bot.cmd('ticket.update', { sessionId: s.id, status: 'Done' })).rejects.toThrow(/luca hasn't connected a Linear account/)
  await connectLinear(luca, 'user-luca')
  for (const c of [jp, bot, luca, s.bridge, theirs.bridge]) c.close()
})

test('a new ticket is made in Linear as its maker, and attached to the session moves it to its frame', async () => {
  const luca = await client()
  const s = await session('dev-luca', { branch: 'lucadeleo/cs-601-change-tickets', ticket: { id: 'CS-601', source: 'branch' } })
  const plain = await session('dev-luca')
  expect(await shown(luca, plain.id)).toEqual({ ticket: null, frame: 'region:x' })
  const watcher = await page()

  const teams = await luca.cmd('ticket.teams', { team: 'cs' })
  expect(teams.teams).toEqual([{ id: 'team-CS', key: 'CS', name: 'Coding Systems' }])
  expect(teams.options.team.key).toBe('CS')

  const made = await luca.cmd('ticket.create', { sessionId: plain.id, team: 'CS', title: 'Let agents attach tickets', description: 'Line one\nLine two' })
  expect(made).toMatchObject({ as: 'luca', attachedTo: plain.id, ticket: { id: 'CS-602', title: 'Let agents attach tickets', status: { name: 'Todo' } } })
  expect(linear.table.get('CS-602')).toMatchObject({ description: 'Line one\nLine two' })
  expect(linear.changes.at(-1)).toMatchObject({ by: 'user-luca', op: 'TicketCreate', input: { teamId: 'team-CS' } })
  expect(await shown(luca, plain.id)).toEqual({ ticket: { id: 'CS-602', source: 'sphere' }, frame: 'region:ticket:CS-602' })
  await Bun.sleep(100)
  expect(watcher.heard.map(h => h.id)).toContain('CS-602')

  // An existing ticket attaches the same way, once Linear has it; the bridge's ticket gives way.
  await expect(luca.cmd('ticket.attach', { sessionId: s.id, id: 'CS-999' })).rejects.toThrow(/Linear has no ticket CS-999/)
  await luca.cmd('ticket.attach', { sessionId: s.id, id: 'cs-602' })
  expect(await shown(luca, s.id)).toEqual({ ticket: { id: 'CS-602', source: 'sphere' }, frame: 'region:ticket:CS-602' })
  // A resume whose branch names another ticket keeps the one a person attached.
  await s.start()
  expect((await shown(luca, s.id)).ticket).toEqual({ id: 'CS-602', source: 'sphere' })

  // Only the owner (or an agent they trust) attaches; estra's label stays.
  const jp = await client('dev-jp')
  await expect(jp.cmd('ticket.attach', { sessionId: s.id, id: 'CS-601' })).rejects.toThrow(/only luca or agents they trust/)
  await expect(jp.cmd('ticket.create', { sessionId: s.id, team: 'CS', title: 'x' })).rejects.toThrow(/only luca or agents they trust/)
  expect((await jp.cmd('ticket.create', { team: 'CS', title: 'Unattached' })).ticket.id).toBe('CS-603')
  const estra = await session('dev-luca', { labels: { ticket: 'CS-601', stage: 'code' } })
  await expect(luca.cmd('ticket.attach', { sessionId: estra.id, id: 'CS-602' })).rejects.toThrow(/estra started .* for CS-601/)
  await expect(luca.cmd('ticket.create', { team: 'NOPE', title: 'x' })).rejects.toThrow(/no team NOPE/)
  await expect(luca.cmd('ticket.create', { team: 'CS', title: '' })).rejects.toThrow(/needs a title/)

  // A trusted agent attaches to its owner's session as the owner.
  const bot = await client('dev-bot')
  const fresh = await session('dev-luca')
  expect(await bot.cmd('ticket.create', { sessionId: fresh.id, team: 'CS', title: 'Made by an agent' })).toMatchObject({ as: 'luca', attachedTo: fresh.id })
  await expect(bot.cmd('ticket.create', { team: 'CS', title: 'Not for a session' })).rejects.toThrow(/connect your Linear account first/)
  for (const c of [luca, jp, bot, s.bridge, plain.bridge, estra.bridge, fresh.bridge]) c.close()
  watcher.close()
})

test('agents use `sphere ticket` and `sphere linear`; refusals exit 3', async () => {
  // Not spawnSync: the stand-in for Linear runs in this process, and must keep answering.
  const run = async (token: string, ...args: string[]) => {
    const p = Bun.spawn(['bun', 'sphere/src/cli.ts', ...args], { cwd: `${import.meta.dir}/..`, env: { ...process.env, SPHERE_URL: URL_, SPHERE_TOKEN: token, SPHERE_HOME: '/nonexistent' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out.trim(), err: err.trim() }
  }
  const s = await session('dev-luca', { ticket: { id: 'CS-601', source: 'orca' } })
  // ops-bot acts for luca, who trusts it and is connected.
  const set = await run('dev-bot', 'ticket', 'set', '--session', s.id.slice(0, 8), '--status', 'Done', '--assignee', 'jp')
  expect(set.code).toBe(0)
  expect(JSON.parse(set.out)).toMatchObject({ as: 'luca', ticket: { id: 'CS-601', status: { name: 'Done' }, assignee: 'JP Addison' } })
  const opts = await run('dev-bot', 'ticket', 'options', '--session', s.id)
  expect(JSON.parse(opts.out).statuses.length).toBe(7)
  const made = await run('dev-bot', 'ticket', 'new', '--team', 'CS', '--title', 'From the CLI', '--session', s.id)
  expect(JSON.parse(made.out)).toMatchObject({ as: 'luca', attachedTo: s.id })
  // Not trusted, not connected: exit 3 (auth), with why.
  const jp = await client('dev-jp')
  await jp.cmd('linear.disconnect')
  const refused = await run('dev-jp', 'ticket', 'set', 'CS-601', '--status', 'Todo')
  expect(refused.code).toBe(3)
  expect(JSON.parse(refused.err)).toMatchObject({ code: 'auth', error: expect.stringContaining('connect your Linear account first') })
  expect(JSON.parse((await run('dev-jp', 'linear')).out)).toEqual({ enabled: true, connected: false })
  expect(JSON.parse((await run('dev-jp', 'linear', 'connect')).out).url).toContain('/oauth/authorize?')
  for (const c of [jp, s.bridge]) c.close()
}, 30_000)

test("a comment shows in Linear under each person's own name", async () => {
  const luca = await client()
  const jp = await client('dev-jp')
  for (const [c, as] of [[luca, 'user-luca'], [jp, 'user-jp']] as const) {
    if (!(await c.cmd('linear.account')).connected) await connectLinear(c, as)
  }
  const s = await session('dev-luca', { ticket: { id: 'CS-601', source: 'orca' } })
  expect(await luca.cmd('ticket.comment', { sessionId: s.id, body: 'Test comment from Dyson Sphere' })).toMatchObject({ id: 'CS-601', as: 'luca', comment: { url: expect.stringContaining('linear.app') } })
  expect(await jp.cmd('ticket.comment', { id: 'CS-601', body: 'And from JP' })).toMatchObject({ as: 'jp' })
  expect(linear.comments.slice(-2)).toEqual([
    { by: 'user-luca', id: 'CS-601', body: 'Test comment from Dyson Sphere' },
    { by: 'user-jp', id: 'CS-601', body: 'And from JP' },
  ])
  await expect(luca.cmd('ticket.comment', { id: 'CS-601', body: '  ' })).rejects.toThrow(/needs some text/)
  // ops-bot comments as luca, on luca's session's ticket only.
  const bot = await client('dev-bot')
  expect(await bot.cmd('ticket.comment', { sessionId: s.id, body: 'From the agent' })).toMatchObject({ as: 'luca' })
  await expect(bot.cmd('ticket.comment', { id: 'CS-601', body: 'No session' })).rejects.toThrow(/connect your Linear account first/)
  for (const c of [luca, jp, bot, s.bridge]) c.close()
})

test('the grant store replaces or deletes a row only if it still holds what was read', async () => {
  // db.ts connects as it loads, to DATABASE_URL: this file's scratch database, not the default.
  process.env.DATABASE_URL = DATABASE_URL
  const { linearGrants, sql } = await import('../server/src/db')
  await linearGrants.put('replace-test', 'a')
  expect(await linearGrants.replace('replace-test', 'stale', 'b')).toBe(false)
  expect(await linearGrants.replace('replace-test', 'a', 'b')).toBe(true)
  expect(await linearGrants.get('replace-test')).toBe('b')
  expect(await linearGrants.replace('replace-test', 'a', null)).toBe(false)
  expect(await linearGrants.replace('replace-test', 'b', null)).toBe(true)
  expect(await linearGrants.get('replace-test')).toBeNull()
  await sql.close()
})
