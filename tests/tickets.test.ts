// Finding a session's ticket, and reading tickets from Linear (a stand-in for it). No database.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linearStub } from '../scripts/linear-stub'
import { Linear, LinearError, Tickets } from '../server/src/linear'
import { World } from '../server/src/world'
import { cleanTicket, findTicket, regionFor, ticketFromBranch, type SessionTicket, type StoredEvent, type Ticket } from '../shared/protocol'
import { orcaLink } from '../sphere/src/ticket'

test('a ticket id in a branch name, in Linear branch format', () => {
  expect(ticketFromBranch('lucadeleo/cs-2519-dyson-sphere-sessions-show-their-linear-ticket')).toBe('CS-2519')
  expect(ticketFromBranch('LucaDeLeo/cs-1293-email-agent-eval-replay')).toBe('CS-1293')
  expect(ticketFromBranch('jpa/cs-2479')).toBe('CS-2479')
  expect(ticketFromBranch('cs-2488-babysit-746')).toBe('CS-2488')
  expect(ticketFromBranch('eng-12-fix')).toBe('ENG-12')
  for (const none of ['main', 'feat/rate-limits', 'jp/advice-matching-v2', 'release/v2-0', 'lucadeleo/dyson-sphere', 'fix/cs2519', 'lucadeleo/fix-cs-2519', null, undefined])
    expect(ticketFromBranch(none)).toBeNull()
})

test("estra's label first, then the branch, then Orca, which is asked only when needed", () => {
  let asked = 0
  const orca = () => (asked++, 'CS-3')
  expect(findTicket({ estra: 'CS-1', branch: 'luca/cs-2-x', orca })).toEqual({ id: 'CS-1', source: 'estra' })
  expect(findTicket({ estra: null, branch: 'luca/cs-2-x', orca })).toEqual({ id: 'CS-2', source: 'branch' })
  expect(asked).toBe(0)
  expect(findTicket({ branch: 'main', orca })).toEqual({ id: 'CS-3', source: 'orca' })
  expect(findTicket({ branch: 'main', orca: () => null })).toBeNull()
  // estra's tickets can be Asana gids; Linear ids are upper-cased.
  expect(findTicket({ estra: '1209876543210987' })).toEqual({ id: '1209876543210987', source: 'estra' })
  expect(findTicket({ estra: ' cs-9\n' })).toEqual({ id: 'CS-9', source: 'estra' })
})

test('a ticket from a bridge is cleaned; anything else is no ticket', () => {
  expect(cleanTicket({ id: 'cs-5', source: 'branch' })).toEqual({ id: 'CS-5', source: 'branch' })
  for (const junk of [null, 'CS-5', { id: 'CS-5' }, { id: 'CS-5', source: 'guess' }, { id: '  ', source: 'orca' }, { id: 42, source: 'orca' }]) expect(cleanTicket(junk)).toBeNull()
})

test("every session with a ticket goes in its ticket's frame", () => {
  expect(regionFor({ repo: 'x', labels: null, ticket: { id: 'CS-5', source: 'branch' } }).id).toBe('region:ticket:CS-5')
  expect(regionFor({ repo: 'x', labels: null }).id).toBe('region:x')
})

test('a ticket found in a branch name shows, in its frame, once Linear confirms it', () => {
  const log: StoredEvent[] = []
  const world = new World()
  const apply = (type: string, data: Record<string, unknown>) => {
    const ev = { seq: log.length + 1, topic: 'world', type, actor: 'luca', at: new Date(Date.UTC(2026, 9, 10, 9, 0, log.length)).toISOString(), data }
    log.push(ev)
    return world.apply(ev)
  }
  const start = (id: string, ticket: SessionTicket | null) => apply('session.started', { sessionId: id, machine: 'm', cwd: '/x', repo: 'x', branch: 'b', ticket })
  const at = (id: string) => [world.sessions.get(id)!.ticket, world.layout.get(id)!.parent]

  // `node-20-upgrade` reads as NODE-20, which Linear has no issue for: no ticket, no frame.
  start('node', { id: 'NODE-20', source: 'branch' })
  start('a', { id: 'CS-5', source: 'branch' })
  expect(at('node')).toEqual([null, 'region:x'])
  expect(at('a')).toEqual([null, 'region:x'])
  expect(world.awaitsConfirmation('CS-5')).toBe(true)
  // estra's and Orca's tickets show at once.
  start('orca', { id: 'CS-6', source: 'orca' })
  expect(at('orca')).toEqual([{ id: 'CS-6', source: 'orca' }, 'region:ticket:CS-6'])
  expect(world.awaitsConfirmation('CS-6')).toBe(false)

  // A resume that finds no ticket keeps the one waiting.
  start('a', null)
  expect(apply('ticket.confirmed', { id: 'CS-5' })).toEqual(['a'])
  expect(at('a')).toEqual([{ id: 'CS-5', source: 'branch' }, 'region:ticket:CS-5'])
  expect(world.awaitsConfirmation('CS-5')).toBe(false)
  // Later sessions on its branch go straight to its frame, in the next slot.
  start('b', { id: 'CS-5', source: 'branch' })
  expect(at('b')).toEqual([{ id: 'CS-5', source: 'branch' }, 'region:ticket:CS-5'])
  expect(world.layout.get('b')).not.toMatchObject({ x: world.layout.get('a')!.x, y: world.layout.get('a')!.y })
  expect(at('node')).toEqual([null, 'region:x'])

  // The log gives the same world again.
  const replayed = new World()
  for (const ev of log) replayed.apply(ev)
  expect(replayed.sessions).toEqual(world.sessions)
  expect(replayed.layout).toEqual(world.layout)
})

test('a ticket a person attached wins over the branch and Orca, but not estra, and the log gives it back', () => {
  const log: StoredEvent[] = []
  const world = new World()
  const apply = (type: string, data: Record<string, unknown>) => {
    const ev = { seq: log.length + 1, topic: 'world', type, actor: 'luca', at: new Date(Date.UTC(2026, 9, 13, 9, 0, log.length)).toISOString(), data }
    log.push(ev)
    return world.apply(ev)
  }
  const start = (id: string, extra: Record<string, unknown> = {}) => apply('session.started', { sessionId: id, machine: 'm', cwd: '/x', repo: 'x', branch: 'b', ...extra })
  const at = (id: string) => [world.sessions.get(id)!.ticket, world.layout.get(id)!.parent]

  start('a', { ticket: { id: 'CS-1', source: 'orca' } })
  expect(apply('session.ticket', { sessionId: 'a', id: 'cs-9' })).toEqual(['a'])
  expect(at('a')).toEqual([{ id: 'CS-9', source: 'sphere' }, 'region:ticket:CS-9'])
  // A resume that finds another ticket in its branch keeps it.
  start('a', { ticket: { id: 'CS-2', source: 'branch' } })
  expect(at('a')).toEqual([{ id: 'CS-9', source: 'sphere' }, 'region:ticket:CS-9'])
  // estra's label stays its session's ticket; an unknown session or junk id changes nothing.
  start('e', { labels: { ticket: 'CS-3', stage: 'code' } })
  expect(apply('session.ticket', { sessionId: 'e', id: 'CS-9' })).toEqual([])
  expect(apply('session.ticket', { sessionId: 'nobody', id: 'CS-9' })).toEqual([])
  expect(apply('session.ticket', { sessionId: 'a', id: 42 })).toEqual([])
  expect(at('e')).toEqual([{ id: 'CS-3', source: 'estra' }, 'region:ticket:CS-3'])

  const replayed = new World()
  for (const ev of log) replayed.apply(ev)
  expect(replayed.sessions).toEqual(world.sessions)
  expect(replayed.layout).toEqual(world.layout)
})

test("Orca's link is read for the pane's own worktree only", () => {
  const bin = mkdtempSync(join(tmpdir(), 'orca-'))
  writeFileSync(join(bin, 'orca'), `#!/bin/sh\necho '{"ok":true,"result":{"worktree":{"linkedLinearIssue":"CS-1052"}}}'\n`)
  chmodSync(join(bin, 'orca'), 0o755)
  const env = { ORCA_CLI_BIN_DIR: bin, ORCA_WORKTREE_ID: 'repo-1::/users/luca/dev/wt' }
  expect(orcaLink('/Users/luca/dev/wt', env)).toBe('CS-1052')
  expect(orcaLink('/Users/luca/dev/elsewhere', env)).toBeNull()
  expect(orcaLink('/Users/luca/dev/wt', { ORCA_CLI_BIN_DIR: bin })).toBeNull() // not in an Orca pane
  expect(orcaLink('/Users/luca/dev/wt', { ...env, ORCA_CLI_BIN_DIR: join(bin, 'missing') })).toBeNull()
})

// ---------- reading Linear ----------

const stub = linearStub({
  'CS-1': { title: 'Show tickets on cards', status: 'In Progress', assignee: 'Luca De Leo' },
  'CS-2': { title: 'Second', status: 'Todo' },
  'ENG-7': { title: 'Another team', status: 'Done' },
})
afterAll(() => stub.stop())

function reader(key: string | null = 'lin_api_test') {
  const changes: [string, Ticket | null][] = []
  const logs: string[] = []
  const t = new Tickets({ linear: new Linear({ url: stub.url }), key, changed: (id, ticket) => changes.push([id, ticket]), log: m => logs.push(m) })
  return { t, changes, logs }
}

test("reads a ticket's title, status, assignee and link, in one request, with the key as-is", async () => {
  const { t, changes } = reader()
  const before = stub.requests.length
  await t.refresh(['CS-1', 'CS-2', 'ENG-7', 'CS-404', '1209876543210987'])
  expect(stub.requests.length).toBe(before + 1)
  const sent = stub.requests.at(-1)!
  expect(sent.authorization).toBe('lin_api_test')
  // Only Linear ids are asked for, grouped by team; an Asana gid never is.
  expect(sent.variables.filter.or).toEqual([
    { team: { key: { eq: 'CS' } }, number: { in: [1, 2, 404] } },
    { team: { key: { eq: 'ENG' } }, number: { in: [7] } },
  ])
  expect(t.known.get('CS-1')).toEqual({
    id: 'CS-1',
    title: 'Show tickets on cards',
    url: 'https://linear.app/80000-hours/issue/CS-1/show-tickets-on-cards',
    status: { name: 'In Progress', type: 'started', color: '#f2c94c' },
    assignee: 'Luca De Leo',
  })
  expect(t.known.has('CS-404')).toBe(false) // Linear has no such issue
  expect(changes.map(([id]) => id).sort()).toEqual(['CS-1', 'CS-2', 'ENG-7'])

  // Nothing changed: nothing published. A status change is.
  changes.length = 0
  await t.refresh(['CS-1', 'CS-2'])
  expect(changes).toEqual([])
  stub.table.get('CS-2')!.status = 'In Review'
  await t.refresh(['CS-1', 'CS-2'])
  expect(changes).toEqual([['CS-2', expect.objectContaining({ status: { name: 'In Review', type: 'started', color: '#0f783c' } })]])
})

test('without a key: one warning, and Linear is never asked', async () => {
  const before = stub.requests.length
  const { t, logs } = reader(null)
  await t.refresh(['CS-1'])
  t.soon('CS-2')
  await Bun.sleep(400)
  expect(stub.requests.length).toBe(before)
  expect(logs).toEqual([expect.stringContaining('SPHERE_LINEAR_KEY is not set')])
})

test('Linear down: one warning, not one per read; what was read stays; one note when it is back', async () => {
  const { t, logs } = reader()
  await t.refresh(['CS-1'])
  stub.fail(503)
  for (let i = 0; i < 3; i++) await t.refresh(['CS-1'])
  expect(logs).toEqual([expect.stringContaining('Linear answered HTTP 503')])
  expect(t.known.get('CS-1')?.title).toBe('Show tickets on cards')
  stub.fail(null)
  await t.refresh(['CS-1'])
  await t.refresh(['CS-1'])
  expect(logs).toEqual([expect.any(String), 'Linear: reading tickets again.'])

  // A refused key says so.
  const refused = reader()
  stub.fail(401)
  await refused.t.refresh(['CS-1'])
  stub.fail(null)
  expect(refused.logs).toEqual([expect.stringContaining('Linear refused SPHERE_LINEAR_KEY')])

  // Nothing listening at all.
  const gone = new Tickets({ linear: new Linear({ url: 'http://127.0.0.1:9/graphql' }), key: 'k', changed: () => {}, log: m => logs.push(m) })
  logs.length = 0
  await gone.refresh(['CS-1'])
  await gone.refresh(['CS-1'])
  expect(logs).toEqual([expect.stringContaining("can't reach Linear")])
})

test("a new session's ticket is read at once; one read before isn't read again until the poll", async () => {
  const { t } = reader()
  const before = stub.requests.length
  t.soon('CS-1')
  t.soon('CS-2')
  await Bun.sleep(400)
  expect(stub.requests.length).toBe(before + 1) // both in one request
  t.soon('CS-1')
  await Bun.sleep(400)
  expect(stub.requests.length).toBe(before + 1)
})

test("nothing Linear sends reaches a page unchecked", async () => {
  const fake = (nodes: unknown[]) => (async () => Response.json({ data: { issues: { nodes } } })) as unknown as typeof fetch
  const changes: Ticket[] = []
  const t = new Tickets({
    linear: new Linear({ fetch: fake([{ identifier: 'CS-1', title: 'T\u0007itle', url: 'javascript:alert(1)', state: { name: 'Odd', type: 'started', color: 'red;background:url(x)' }, assignee: null }]) }),
    key: 'k',
    changed: (_id, x) => x && changes.push(x),
    log: () => {},
  })
  await t.refresh(['CS-1'])
  expect(changes[0]).toEqual({ id: 'CS-1', title: 'T itle', url: null, status: { name: 'Odd', type: 'started', color: '#95a2b3' }, assignee: null })
})

test("the client sends an API key as-is and a person's OAuth token as a bearer token, and takes no error for an answer", async () => {
  const sent: string[] = []
  const answering = (body: unknown, status = 200) =>
    new Linear({ fetch: (async (_url: unknown, init: RequestInit) => (sent.push((init.headers as Record<string, string>).authorization!), Response.json(body, { status }))) as unknown as typeof fetch })
  const ok = { data: { viewer: { id: 'u1' } } }
  expect(await answering(ok).request<{ viewer: { id: string } }>({ apiKey: 'lin_api_x' }, 'query { viewer { id } }')).toEqual({ viewer: { id: 'u1' } })
  await answering(ok).request({ accessToken: 'oauth-token' }, 'query { viewer { id } }')
  expect(sent).toEqual(['lin_api_x', 'Bearer oauth-token'])
  // A change Linear reports an error for didn't happen, whatever data came with it.
  const kind = (p: Promise<unknown>) => p.then(() => 'answered', (e: LinearError) => e.kind)
  expect(await kind(answering({ data: { issueUpdate: null }, errors: [{ message: 'Entity not found' }] }).request({ accessToken: 't' }, 'mutation { x }'))).toBe('rejected')
  expect(await kind(answering({ errors: [{ message: 'no', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 400).request({ accessToken: 't' }, 'query { x }'))).toBe('auth')
  expect(await kind(answering({ errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] }, 400).request({ apiKey: 'k' }, 'query { x }'))).toBe('rate-limited')
  expect(await kind(answering('down', 502).request({ apiKey: 'k' }, 'query { x }'))).toBe('unavailable')
})

test("a read already on its way when a change is answered doesn't undo the change", async () => {
  const gate = Promise.withResolvers<void>()
  const old = { identifier: 'CS-1', title: 'One', url: null, state: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, assignee: null }
  const asked = Promise.withResolvers<void>()
  const slow = (async () => (asked.resolve(), await gate.promise, Response.json({ data: { issues: { nodes: [old] } } }))) as unknown as typeof fetch
  const changes: (Ticket | null)[] = []
  const t = new Tickets({ linear: new Linear({ fetch: slow }), key: 'k', changed: (_id, x) => changes.push(x), log: () => {} })
  const reading = t.refresh(['CS-1'])
  await asked.promise // the read is on its way to Linear
  const changed: Ticket = { id: 'CS-1', title: 'One', url: null, status: { name: 'Done', type: 'completed', color: '#5e6ad2' }, assignee: null }
  t.set('CS-1', changed)
  gate.resolve()
  await reading
  expect(t.known.get('CS-1')).toEqual(changed)
  expect(changes).toEqual([changed])
  // The next read applies again.
  await t.refresh(['CS-1'])
  expect(t.known.get('CS-1')?.status.name).toBe('Todo')
})
