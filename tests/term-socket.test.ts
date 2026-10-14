// sphere-server's `/term` socket, end to end with bridges standing in for real ones: who may
// connect, watch and type, what a session elsewhere or a bridge from before terminals says, and
// that the bridge is told to detach. Against a scratch Postgres database:
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
//
// The database is emptied first, so never point this at a real one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '../shared/protocol'
import type { TermToViewer } from '../shared/terminal'
import { connect } from '../server/src/pg'
import { Client } from '../sphere/src/client'
import { DATABASE_URL, sphereServer, until } from './pages'

const PORT = 7465
type Term = Extract<ServerMessage, { t: 'term' }>

/** A bridge of this version: it records what the server asks of its terminal. */
async function bridge(url: string, token: string, machine: string, extra: Record<string, unknown> = {}) {
  const asked: Term[] = []
  const client = new Client({ url, token }, 'bridge', { onTerm: m => void asked.push(m) })
  await client.connect()
  const id = crypto.randomUUID()
  const holder = `${machine}:1`
  await client.cmd('ingest', { events: [{ key: crypto.randomUUID(), type: 'session.started', holder, data: { sessionId: id, machine, cwd: '/tmp/x', repo: 'api', branch: 'main', pid: 1, interactive: true, ...extra } }] })
  await client.cmd('attach', { sessionId: id, holder })
  return { id, client, asked, ops: () => asked.map(m => m.op) }
}

/** A page's terminal card's socket. */
async function term(http: string, sessionId: string, token: string) {
  const got: TermToViewer[] = []
  const ws = new WebSocket(`${http.replace('http', 'ws')}/term?session=${sessionId}&token=${token}`)
  ws.onmessage = ev => void got.push(JSON.parse(String(ev.data)))
  const closed = new Promise<number>(resolve => (ws.onclose = ev => resolve(ev.code)))
  await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('refused')))))
  return { ws, got, closed, send: (m: unknown) => ws.send(JSON.stringify(m)), last: () => got.at(-1) }
}

describe('sphere-server /term', () => {
  const server = sphereServer(PORT, { SPHERE_TERMINAL_MACHINES: `box,${hostname()}`, SPHERE_TERMINAL_GRACE_MS: '200' })
  const sql = connect(DATABASE_URL)
  const closers: (() => void)[] = []

  beforeAll(async () => {
    await sql`drop table if exists events, bodies, canvas_rooms`
    await server.start()
  })
  afterAll(async () => {
    closers.forEach(c => c())
    await server.stop()
    await sql.close()
  })

  test('refuses other sites, unknown tokens and bad sessions', async () => {
    expect((await fetch(`${server.http}/term?session=x&token=nope`)).status).toBe(401)
    expect((await fetch(`${server.http}/term?session=x&token=dev-luca`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${server.http}/term?session=${encodeURIComponent('a b')}&token=dev-luca`)).status).toBe(400)
    // A known token and a session id get as far as the upgrade.
    expect((await fetch(`${server.http}/term?session=x&token=dev-luca`)).status).toBe(400)
    const none = await term(server.http, 'no-such-session', 'dev-luca')
    expect(await none.closed).toBe(4004)
    expect(none.got).toEqual([{ t: 'status', status: 'unavailable', reason: 'There is no such session.' }])
  })

  test('the owner types, anyone else watches; only the owner reaches the bridge', async () => {
    const b = await bridge(server.url, 'dev-luca', 'box', { terminal: 'tmux' })
    closers.push(() => b.client.close())
    const luca = await term(server.http, b.id, 'dev-luca')
    const jp = await term(server.http, b.id, 'dev-jp')
    closers.push(() => luca.ws.close(), () => jp.ws.close())
    await until(() => b.ops().includes('open'))
    expect(luca.got[0]).toEqual({ t: 'hello', owner: 'luca', canType: true })
    expect(jp.got[0]).toEqual({ t: 'hello', owner: 'luca', canType: false })

    b.client.term({ t: 'term', sessionId: b.id, op: 'state', cols: 80, rows: 24, d: 'the screen' })
    await until(() => jp.last()?.t === 'state' && luca.last()?.t === 'state')
    expect(jp.last()).toEqual({ t: 'state', cols: 80, rows: 24, d: 'the screen' })
    b.client.term({ t: 'term', sessionId: b.id, op: 'out', d: 'output' })
    await until(() => jp.last()?.t === 'out')
    // A narrow split is a screen too, though nobody may ask for one that small.
    b.client.term({ t: 'term', sessionId: b.id, op: 'state', cols: 12, rows: 3, d: 'narrow' })
    await until(() => jp.last()?.t === 'state' && (jp.last() as { cols: number }).cols === 12)

    luca.send({ t: 'in', d: 'ls\r' })
    await until(() => b.ops().includes('in'))
    expect(b.asked.find(m => m.op === 'in')).toMatchObject({ sessionId: b.id, d: 'ls\r' })
    jp.send({ t: 'in', d: 'whoami\r' })
    jp.send({ t: 'fit', cols: 100, rows: 30 })
    await until(() => jp.last()?.t === 'refused')
    await Bun.sleep(200)
    expect(b.asked.filter(m => m.op === 'in' || m.op === 'fit')).toHaveLength(1)
  })

  test('a person has at most 24 terminals open, and is told so', async () => {
    const b = await bridge(server.url, 'dev-luca', 'box', { terminal: 'tmux' })
    closers.push(() => b.client.close())
    const open = []
    for (let i = 0; i < 24; i++) open.push(await term(server.http, b.id, 'dev-bot'))
    const over = await term(server.http, b.id, 'dev-bot')
    expect(await over.closed).toBe(4029)
    expect((over.got[0] as { reason: string }).reason).toContain('24 live cards (terminals and browser tabs) open already')
    open[0]!.ws.close()
    await open[0]!.closed
    await Bun.sleep(50)
    const room = await term(server.http, b.id, 'dev-bot')
    await until(() => room.got[0]?.t === 'hello')
    for (const t of [...open, room]) t.ws.close()
  })

  test("nobody else's bridge speaks for a session's terminal", async () => {
    const b = await bridge(server.url, 'dev-luca', 'box', { terminal: 'tmux' })
    const luca = await term(server.http, b.id, 'dev-luca')
    closers.push(() => b.client.close(), () => luca.ws.close())
    await until(() => b.ops().includes('open'))
    const other = new Client({ url: server.url, token: 'dev-jp' }, 'bridge')
    await other.connect()
    other.term({ t: 'term', sessionId: b.id, op: 'state', cols: 80, rows: 24, d: 'forged' })
    await Bun.sleep(300)
    expect(luca.got.some(m => m.t === 'state')).toBe(false)
    other.close()
  })

  test('says why a session has no terminal', async () => {
    const laptop = await bridge(server.url, 'dev-luca', 'laptop', { terminal: 'tmux' })
    const plain = await bridge(server.url, 'dev-luca', 'box')
    closers.push(() => laptop.client.close(), () => plain.client.close())
    const a = await term(server.http, laptop.id, 'dev-luca')
    const b = await term(server.http, plain.id, 'dev-luca')
    closers.push(() => a.ws.close(), () => b.ws.close())
    await until(() => a.got.length >= 2 && b.got.length >= 2)
    expect(a.got[1]).toMatchObject({ t: 'status', status: 'unavailable' })
    expect((a.got[1] as { reason: string }).reason).toContain(`sessions on box, ${hostname()} for now. This one runs on laptop.`)
    expect((b.got[1] as { reason: string }).reason).toContain("doesn't run in tmux")
    expect(laptop.asked).toHaveLength(0)

    // A bridge from before terminals (protocol 4): it's told nothing, and the card says why.
    const id = crypto.randomUUID()
    const old = new WebSocket(server.url)
    const asked: unknown[] = []
    old.onmessage = ev => {
      const m = JSON.parse(String(ev.data))
      if (m.t === 'term') asked.push(m)
    }
    await new Promise(r => (old.onopen = r))
    old.send(JSON.stringify({ t: 'hello', token: 'dev-luca', role: 'bridge', protocol: 4 }))
    old.send(JSON.stringify({ t: 'cmd', id: '1', op: 'ingest', args: { events: [{ key: crypto.randomUUID(), type: 'session.started', holder: 'box:9', data: { sessionId: id, machine: 'box', cwd: '/x', repo: 'api', branch: 'main', pid: 9, interactive: true } }] } }))
    old.send(JSON.stringify({ t: 'cmd', id: '2', op: 'attach', args: { sessionId: id, holder: 'box:9' } }))
    await Bun.sleep(300)
    const c = await term(server.http, id, 'dev-luca')
    closers.push(() => old.close(), () => c.ws.close())
    await until(() => c.got.length >= 2)
    expect((c.got[1] as { reason: string }).reason).toContain('predates terminal cards')
    expect(asked).toHaveLength(0)
  })

  test('the bridge detaches once the last viewer has gone; a bridge that goes leaves its viewers waiting', async () => {
    const b = await bridge(server.url, 'dev-luca', 'box', { terminal: 'tmux' })
    const v = await term(server.http, b.id, 'dev-jp')
    await until(() => b.ops().includes('open'))
    b.client.term({ t: 'term', sessionId: b.id, op: 'state', cols: 80, rows: 24, d: '' })
    await until(() => v.got.some(m => m.t === 'status' && m.status === 'live'))

    // The bridge goes: its viewers wait; it comes back: it's asked again.
    b.client.close()
    await until(() => v.last()?.t === 'status' && (v.last() as { status: string }).status === 'offline')
    const back = new Client({ url: server.url, token: 'dev-luca' }, 'bridge', { onTerm: m => void b.asked.push(m) })
    await back.connect()
    await back.cmd('attach', { sessionId: b.id, holder: 'box:1' })
    await until(() => b.ops().filter(o => o === 'open').length === 2)

    v.ws.close()
    await Bun.sleep(100)
    expect(b.ops().at(-1)).toBe('open') // not yet: a reload would come back within the grace
    await until(() => b.ops().at(-1) === 'close', 2000)
    back.close()
  })

  // The real bridge, in a tmux pane of a tmux server of the test's own, its session's shell behind it.
  test.skipIf(!Bun.spawnSync(['tmux', '-V'], { stderr: 'ignore' }).success)('a real bridge relays its pane: the owner types into it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sphere-term-e2e-'))
    const socket = join(dir, 'tmux.sock')
    const tmux = (...a: string[]) => Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...a], { stderr: 'pipe' })
    const session = crypto.randomUUID()
    const cli = join(import.meta.dir, '..', 'sphere', 'src', 'cli.ts')
    const env = { SPHERE_URL: server.url, SPHERE_TOKEN: 'dev-luca', SPHERE_HOME: join(dir, 'home'), PATH: process.env.PATH ?? '' }
    // The bridge in the background of the pane's shell, as Claude Code's would be beside it.
    const r = tmux('new-session', '-d', '-x', '90', '-y', '20', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), `sh -c '${process.execPath} ${cli} bridge --session ${session} --cwd ${dir} 2>${dir}/bridge.log & exec env PS1="$ " bash --noprofile --norc'`)
    expect(r.success).toBe(true)
    try {
      const status = new Client({ url: server.url, token: 'dev-luca' }, 'cli')
      await status.connect()
      let found = false
      for (let i = 0; i < 100 && !found; i++) {
        const { sessions } = await status.cmd<{ sessions: { id: string; terminal?: string }[] }>('status')
        found = sessions.some(s => s.id === session && s.terminal === 'tmux')
        if (!found) await Bun.sleep(100)
      }
      status.close()
      expect(found).toBe(true)

      const luca = await term(server.http, session, 'dev-luca')
      const screen = () => luca.got.map(m => (m.t === 'state' || m.t === 'out' ? m.d : '')).join('')
      await until(() => luca.got.some(m => m.t === 'state'), 5000)
      expect(luca.got.find(m => m.t === 'state')).toMatchObject({ cols: 90, rows: 20 })
      luca.send({ t: 'in', d: 'echo e2e-$((2*21))\r' })
      await until(() => screen().includes('e2e-42'), 5000)

      const jp = await term(server.http, session, 'dev-jp')
      await until(() => jp.got.some(m => m.t === 'state'), 5000)
      expect((jp.got.find(m => m.t === 'state') as { d: string }).d).toContain('e2e-42')
      jp.send({ t: 'in', d: 'echo jp\r' })
      await until(() => jp.last()?.t === 'refused')

      // Both cards gone: the bridge detaches from tmux.
      const controlClients = () => tmux('list-clients', '-F', '#{client_control_mode}').stdout.toString().split('\n').filter(l => l === '1').length
      expect(controlClients()).toBe(1)
      luca.ws.close()
      jp.ws.close()
      await until(() => controlClients() === 0, 3000)
    } finally {
      tmux('kill-server')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
