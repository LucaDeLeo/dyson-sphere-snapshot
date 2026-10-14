// The canvas room and the event log kept in step (server/src/arrangement.ts), against sphere-server
// and a scratch Postgres database: pages on the room (tldraw's sync client) and pages from before
// it (the `layout.set`, `note.*` and `canvas` commands) see each other's changes.
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
//
// The database is emptied first, so never point this at a real one.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { RoomSnapshot } from '@tldraw/sync-core'
import { createShapeId, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { CANVAS, type LayoutItem, type Note, type StoredEvent } from '../shared/protocol'
import { CANVAS_PAGE, noteShapeId, plainTextOf, richTextOf, sectionShapeId, sessionShapeId } from '../shared/canvas'
import { Arrangement, RETIRE_MS } from '../server/src/arrangement'
import { Canvas } from '../server/src/canvas'
import { connect } from '../server/src/pg'
import { World } from '../server/src/world'
import { Client } from '../sphere/src/client'
import { DATABASE_URL, openPage, sphereServer, startSession, until, type Page } from './pages'

const PORT = 7464
const server = sphereServer(PORT)
const sql = connect(DATABASE_URL)
const closers: { close(): void }[] = []
let old: Client // a page from before the room: commands only

beforeAll(async () => {
  await sql`drop table if exists events, bodies, canvas_rooms`
  await server.start()
  old = new Client({ url: server.url, token: 'dev-luca' }, 'cli')
  await old.connect()
})

afterAll(async () => {
  closers.forEach(c => c.close())
  old?.close()
  await server.stop()
  await sql.close()
})

const page = async (token = 'dev-luca') => {
  const p = await openPage(PORT, token)
  closers.push(p)
  return p
}
const session = async (repo: string) => {
  const s = await startSession(server.url, { repo })
  closers.push(s.client)
  return s.id
}
/** As systemd restarts it; the older page's connection with it. */
async function restart(between: () => Promise<unknown> = async () => {}) {
  old.close()
  await server.stop()
  await between()
  await server.start()
  old = new Client({ url: server.url, token: 'dev-luca' }, 'cli')
  await old.connect()
}
/** What a page from before the room reads. */
const legacy = () => old.cmd<{ layout: LayoutItem[]; notes: Note[] }>('canvas')
const eventually = async <T,>(read: () => Promise<T>, check: (x: T) => boolean, ms = 3000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const x = await read()
    if (check(x) || Date.now() > end) return x
    await Bun.sleep(50)
  }
}
const sectionSize = (p: Page, region: string) => p.shape(sectionShapeId(region))?.props as { w: number; h: number } | undefined

test("a new session's card goes in its repo's section, in its slot, and older pages place the section where the room did", async () => {
  const luca = await page()
  const [a, b] = [await session('web'), await session('web')]
  await until(() => !!luca.shape(sessionShapeId(b)))
  const { pad, cardW, cardH, gap } = CANVAS
  expect(luca.shape(sessionShapeId(a))).toMatchObject({ parentId: sectionShapeId('region:web'), x: pad, y: pad })
  expect(luca.shape(sessionShapeId(b))).toMatchObject({ parentId: sectionShapeId('region:web'), x: pad + cardW + gap, y: pad })
  // Fitted to its two cards.
  expect(sectionSize(luca, 'region:web')).toMatchObject({ w: pad + 2 * cardW + gap + pad, h: pad + cardH + pad })

  // Another repo's section goes beside it, not on top.
  const c = await session('mobile')
  await until(() => !!luca.shape(sessionShapeId(c)))
  const web = luca.shape(sectionShapeId('region:web'))!
  const mobile = luca.shape(sectionShapeId('region:mobile'))!
  expect(mobile.x).toBeGreaterThanOrEqual(web.x + sectionSize(luca, 'region:web')!.w)
  const { layout } = await legacy()
  expect(layout.find(l => l.id === 'region:mobile')).toMatchObject({ x: mobile.x, y: mobile.y })

  // A third card widens web's section into mobile's: mobile's moves right, for older pages too.
  const d = await session('web')
  await until(() => !!luca.shape(sessionShapeId(d)))
  await until(() => luca.shape(sectionShapeId('region:mobile'))!.x > mobile.x)
  const wide = luca.shape(sectionShapeId('region:web'))!
  const pushed = luca.shape(sectionShapeId('region:mobile'))!
  expect(pushed.x).toBeGreaterThanOrEqual(wide.x + sectionSize(luca, 'region:web')!.w)
  const after = await eventually(legacy, c => c.layout.find(l => l.id === 'region:mobile')?.x === pushed.x)
  expect(after.layout.find(l => l.id === 'region:mobile')).toMatchObject({ x: pushed.x })
})

test("an older page's moves and notes reach the room", async () => {
  const luca = await page()
  const id = await session('api')
  await until(() => !!luca.shape(sessionShapeId(id)))

  await old.cmd('layout.set', { items: [{ id, kind: 'session', x: 400, y: 20, parent: 'region:api' }] })
  await until(() => luca.shape(sessionShapeId(id))!.x === 400)
  await until(() => sectionSize(luca, 'region:api')!.w === 400 + CANVAS.cardW + CANVAS.pad) // grew to fit
  // A card can't leave its frame from an older page either.
  await old.cmd('layout.set', { items: [{ id, kind: 'session', x: 0, y: 0, parent: 'region:web' }] })
  await Bun.sleep(300)
  expect(luca.shape(sessionShapeId(id))).toMatchObject({ parentId: sectionShapeId('region:api'), x: 400 })

  await old.cmd('layout.set', { items: [{ id: 'region:api', kind: 'region', x: 5000, y: 3000 }] })
  await until(() => luca.shape(sectionShapeId('region:api'))!.x === 5000)

  const { id: noteId } = await old.cmd<{ id: string }>('note.create', { text: 'first line\nsecond', color: 'pink', x: 10, y: 20 })
  await until(() => !!luca.shape(noteShapeId(noteId)))
  const note = luca.shape(noteShapeId(noteId))!
  expect(note).toMatchObject({ parentId: CANVAS_PAGE, x: 10, y: 20, meta: { author: 'luca' }, props: { color: 'light-red' } })
  expect(plainTextOf((note.props as { richText: never }).richText)).toBe('first line\nsecond')

  await old.cmd('note.update', { id: noteId, text: 'changed', color: 'blue' })
  await until(() => plainTextOf((luca.shape(noteShapeId(noteId))!.props as { richText: never }).richText) === 'changed')
  expect(luca.shape(noteShapeId(noteId))!.props).toMatchObject({ color: 'light-blue' })
  await old.cmd('note.delete', { id: noteId })
  await until(() => !luca.shape(noteShapeId(noteId)))
})

test("a page's moves and notes reach the log, for older pages", async () => {
  const jp = await page('dev-jp')
  const id = await session('docs')
  await until(() => !!jp.shape(sessionShapeId(id)))

  jp.store.put([{ ...jp.shape(sessionShapeId(id))!, x: 700, y: 60 }])
  let { layout } = await eventually(legacy, c => c.layout.find(l => l.id === id)?.x === 700)
  expect(layout.find(l => l.id === id)).toMatchObject({ kind: 'session', x: 700, y: 60, parent: 'region:docs' })
  await until(() => sectionSize(jp, 'region:docs')!.w === 700 + CANVAS.cardW + CANVAS.pad)

  jp.store.put([{ ...jp.shape(sectionShapeId('region:docs'))!, x: -800, y: 1200 }])
  ;({ layout } = await eventually(legacy, c => c.layout.find(l => l.id === 'region:docs')?.x === -800))
  expect(layout.find(l => l.id === 'region:docs')).toMatchObject({ x: -800, y: 1200 })

  // A note made on the canvas is a note for older pages, by whoever made it.
  const shapeId = createShapeId('from-the-canvas')
  jp.store.put([note(shapeId, 'drawn here', 300, 400)])
  let { notes } = await eventually(legacy, c => c.notes.some(n => `shape:${n.id}` === shapeId))
  const made = notes.find(n => `shape:${n.id}` === shapeId)!
  expect(made).toMatchObject({ text: 'drawn here', color: 'yellow', author: 'jp' })
  expect((await legacy()).layout.find(l => l.id === made.id)).toMatchObject({ kind: 'note', x: 300, y: 400 })

  jp.store.put([{ ...jp.shape(shapeId)!, props: { ...(jp.shape(shapeId)!.props as object), richText: richTextOf('edited'), color: 'light-green' } } as unknown as TLRecord])
  ;({ notes } = await eventually(legacy, c => c.notes.find(n => n.id === made.id)?.text === 'edited'))
  expect(notes.find(n => n.id === made.id)).toMatchObject({ color: 'green' })

  jp.store.remove([shapeId as any])
  ;({ notes } = await eventually(legacy, c => !c.notes.some(n => n.id === made.id)))
  expect(notes.some(n => n.id === made.id)).toBe(false)
})

test("a page's last change before a restart still reaches the log", async () => {
  const jp = await page('dev-jp')
  const id = await session('ops')
  await until(() => !!jp.shape(sessionShapeId(id)))
  jp.store.put([{ ...jp.shape(sessionShapeId(id))!, x: 660 }])
  await Bun.sleep(60) // at the server, within the 300 ms it waits before recording
  await restart()
  const { layout } = await eventually(legacy, c => c.layout.some(l => l.id === id))
  expect(layout.find(l => l.id === id)).toMatchObject({ x: 660 })
})

test("a note whose frame a page deleted stays where it was, for older pages too", async () => {
  const luca = await page()
  const frame = createShapeId('a-frame')
  const inside = createShapeId('in-a-frame')
  luca.store.put([{ ...(note(frame, 'x', 4000, 4000) as unknown as Record<string, unknown>), type: 'frame', props: { w: 400, h: 300, name: 'f', color: 'black' } } as unknown as TLRecord])
  luca.store.put([{ ...(note(inside, 'in a frame', 10, 10) as TLShape), parentId: frame } as TLRecord])
  const noteId = inside.slice('shape:'.length)
  await eventually(legacy, c => c.layout.find(l => l.id === noteId)?.x === 4010)
  luca.store.remove([frame as any])
  await until(() => luca.shape(inside)?.parentId === CANVAS_PAGE)
  expect(luca.shape(inside)).toMatchObject({ x: 4010, y: 4010 })
  await Bun.sleep(600)
  expect((await legacy()).layout.find(l => l.id === noteId)).toMatchObject({ x: 4010, y: 4010 })
})

test('a room lost or never made is rebuilt from the log at startup', async () => {
  const before = await page()
  const id = await session('infra')
  await until(() => !!before.shape(sessionShapeId(id)))
  await old.cmd('layout.set', { items: [{ id, kind: 'session', x: 340, y: 20, parent: 'region:infra' }] })
  const { id: noteId } = await old.cmd<{ id: string }>('note.create', { text: 'kept through the import', x: -50, y: -60 })
  await until(() => !!before.shape(noteShapeId(noteId)))
  const section = before.shape(sectionShapeId('region:infra'))!

  // As on the first start after this deploy: a log with layout and notes, and no room.
  await restart(() => sql`delete from canvas_rooms`)
  const after = await page()
  expect(after.shape(sessionShapeId(id))).toMatchObject({ parentId: sectionShapeId('region:infra'), x: 340, y: 20 })
  expect(after.shape(sectionShapeId('region:infra'))).toMatchObject({ x: section.x, y: section.y })
  expect(plainTextOf((after.shape(noteShapeId(noteId))!.props as { richText: never }).richText)).toBe('kept through the import')
  expect(after.shape(noteShapeId(noteId))).toMatchObject({ x: -50, y: -60, meta: { author: 'luca' } })
})

test('cards of sessions gone for a week leave, and sections left empty with them', async () => {
  const world = new World()
  const canvas = await Canvas.open('t', { load: async () => null, save: async () => {} })
  const arrangement = new Arrangement(world, canvas, async () => {})
  const t0 = Date.parse('2026-10-01T12:00:00Z')
  let seq = 0
  const apply = (type: string, data: Record<string, unknown>, at = t0) =>
    world.apply({ seq: ++seq, topic: 'world', type, actor: 'luca', at: new Date(at).toISOString(), data })
  const start = (sessionId: string, repo: string) => apply('session.started', { sessionId, machine: 'm', cwd: '/x', repo, branch: 'main' })
  start('ended', 'old-repo')
  apply('session.ended', { sessionId: 'ended' })
  start('quiet', 'api') // its laptop went away and never came back
  start('live', 'api')
  world.setConnected('live', true)
  await arrangement.start(null, 0, t0 + 3600_000)
  expect(['ended', 'quiet', 'live'].map(id => !!canvas.get(sessionShapeId(id)))).toEqual([true, true, true])

  arrangement.retire(t0 + RETIRE_MS - 60_000)
  expect(['ended', 'quiet', 'live'].map(id => !!canvas.get(sessionShapeId(id)))).toEqual([true, true, true])
  arrangement.retire(t0 + RETIRE_MS + 60_000)
  expect(['ended', 'quiet', 'live'].map(id => !!canvas.get(sessionShapeId(id)))).toEqual([false, false, true])
  expect(canvas.get(sectionShapeId('region:old-repo'))).toBeUndefined()
  expect(canvas.get(sectionShapeId('region:api'))).toBeTruthy()
  canvas.dispose()
})

// ---------- in this process: a world, a room, and events recorded as main.ts records them ----------

function harness() {
  const world = new World()
  const recorded: StoredEvent[] = []
  let seq = 0
  const t0 = Date.now()
  let canvas!: Canvas
  let arrangement!: Arrangement
  const record = async (e: { topic: string; type: string; actor: string; data: Record<string, unknown> }) => {
    const ev: StoredEvent = { seq: ++seq, at: new Date().toISOString(), ...e }
    recorded.push(ev)
    world.apply(ev)
    await arrangement.onEvent(ev)
    return ev
  }
  return {
    world,
    recorded,
    record,
    get canvas() {
      return canvas
    },
    get arrangement() {
      return arrangement
    },
    async open(saved: { snapshot: RoomSnapshot; logSeq: number | null } | null = null) {
      canvas = await Canvas.open('t', { load: async () => saved, save: async () => {} })
      arrangement = new Arrangement(world, canvas, record)
      return canvas
    },
    /** A session started now, connected, as a bridge reports it. */
    async start(sessionId: string, repo: string) {
      await record({ topic: 'world', type: 'session.started', actor: 'luca', data: { sessionId, machine: 'm', cwd: '/x', repo, branch: 'main' } })
      world.setConnected(sessionId, true)
    },
    t0,
  }
}
const shapeOf = (c: Canvas, id: string) => c.get(id) as TLShape | undefined

test('at startup, the room catches up with events it missed, and the log with changes the room has', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.arrangement.start(null, 1)
  const snapshot = structuredClone(canvas.room.getCurrentSnapshot())
  const logSeq = canvas.logSeq
  canvas.dispose()

  // After that snapshot: an older page moved the card (in the log), and a page moved the
  // section (in the room, its event lost in a crash).
  const moved = await h.record({ topic: 'world', type: 'layout.set', actor: 'jp', data: { items: [{ id: 's1', kind: 'session', x: 400, y: 20, parent: 'region:api' }] } })
  const room = await h.open({ snapshot, logSeq })
  room.write([{ ...shapeOf(room, sectionShapeId('region:api'))!, x: 900 } as TLRecord])
  h.recorded.length = 0
  await h.arrangement.start((async function* () { yield moved })(), moved.seq)
  expect(shapeOf(room, sessionShapeId('s1'))).toMatchObject({ x: 400 })
  expect(h.world.layout.get('region:api')).toMatchObject({ x: 900 })
  expect(h.recorded.map(e => e.type)).toEqual(['layout.set'])
  expect(room.logSeq).toBe(h.recorded.at(-1)!.seq) // including what the reconcile just recorded
  room.dispose()
})

test("a session back after its card retired gets it again", async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.arrangement.start(null, 1)
  h.world.setConnected('s1', false)
  const s = h.world.sessions.get('s1')!
  s.lastSeenAt = new Date(h.t0 - RETIRE_MS - 60_000).toISOString()
  h.arrangement.retire()
  expect(shapeOf(canvas, sessionShapeId('s1'))).toBeUndefined()
  await h.record({ topic: 'session:s1', type: 'session.row', actor: 'luca', data: { sessionId: 's1', kind: 'prompt', text: 'back', summary: 'back' } })
  expect(shapeOf(canvas, sessionShapeId('s1'))).toMatchObject({ parentId: sectionShapeId('region:api') })
  canvas.dispose()
})

test('notes keep their place and size in both kinds of page, inside a section too', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.arrangement.start(null, 1)
  const section = shapeOf(canvas, sectionShapeId('region:api'))!

  // A page puts a note in the section: the log has it where it is on the page.
  const id = createShapeId('in-section')
  canvas.write([{ ...(note(id, 'inside', 10, 200) as TLShape), parentId: section.id, meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  const noteId = id.slice('shape:'.length)
  expect(h.world.layout.get(noteId)).toMatchObject({ x: section.x + 10, y: section.y + 200 })
  // The section moves: so does its note, on the page.
  canvas.write([{ ...shapeOf(canvas, section.id)!, x: section.x + 500 } as TLRecord])
  await h.arrangement.fromPages([section.id])
  expect(h.world.layout.get(noteId)).toMatchObject({ x: section.x + 510, y: section.y + 200 })
  // An older page moves and resizes it: the room converts back to the section's own corner.
  await h.record({ topic: 'world', type: 'layout.set', actor: 'luca', data: { items: [{ id: noteId, kind: 'note', x: section.x + 520, y: section.y + 210, w: 400, h: 400 }] } })
  expect(shapeOf(canvas, id)).toMatchObject({ x: 20, y: 210, props: { scale: 2 } })
  // A page resizes it back without moving it: the log hears of it.
  canvas.write([{ ...shapeOf(canvas, id)!, props: { ...(shapeOf(canvas, id)!.props as object), scale: 1 } } as TLRecord])
  await h.arrangement.fromPages([id])
  expect(h.world.layout.get(noteId)).toMatchObject({ w: 200, h: 200 })
  canvas.dispose()
})

test("an older page's colour change keeps a note's formatting", async () => {
  const h = harness()
  const canvas = await h.open()
  await h.arrangement.start(null, 0)
  const id = createShapeId('formatted')
  const rich = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] }] }
  canvas.write([{ ...(note(id, 'x', 0, 0) as TLShape), props: { ...(note(id, 'x', 0, 0) as TLShape).props, richText: rich }, meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  await h.record({ topic: 'world', type: 'note.updated', actor: 'luca', data: { id: id.slice('shape:'.length), color: 'blue' } })
  expect(shapeOf(canvas, id)!.props).toMatchObject({ color: 'light-blue', richText: rich })
  canvas.dispose()
})

test("a note's size isn't marked agreed by a batch recorded inside its own", async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.start('s2', 'web')
  await h.arrangement.start(null, 2)
  const api = shapeOf(canvas, sectionShapeId('region:api'))!
  const id = createShapeId('in-api')
  canvas.write([{ ...(note(id, 'in api', 20, 220) as TLShape), parentId: api.id, meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  const noteId = id.slice('shape:'.length)
  // Resized big: api grows into web, which is pushed (recorded on its own); then the batch with
  // the note's size is refused once.
  canvas.write([{ ...shapeOf(canvas, id)!, props: { ...(shapeOf(canvas, id)!.props as object), scale: 4 } } as TLRecord])
  const record = h.record
  let refused = false
  ;(h.arrangement as unknown as { record: typeof record }).record = async e => {
    const items = (e.data.items ?? []) as LayoutItem[]
    if (!refused && items.some(i => i.id === noteId)) {
      refused = true
      throw new Error('database restarting')
    }
    return record(e)
  }
  await expect(h.arrangement.fromPages([id])).rejects.toThrow('database restarting')
  expect(shapeOf(canvas, sectionShapeId('region:web'))!.x).toBeGreaterThan(api.x + 340) // pushed, recorded
  await h.arrangement.fromPages([id])
  expect(h.world.layout.get(noteId)).toMatchObject({ w: 800, h: 800 })
  canvas.dispose()
})

test("a batch that grows a section and moves another records where they end up", async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.start('s2', 'web')
  await h.arrangement.start(null, 2)
  const web = shapeOf(canvas, sectionShapeId('region:web'))!
  // One page's commit: api's card far right (api grows into web), and web nudged.
  canvas.write([{ ...shapeOf(canvas, sessionShapeId('s1'))!, x: 1400 } as TLRecord, { ...web, x: web.x + 10 } as TLRecord])
  await h.arrangement.fromPages([sessionShapeId('s1'), web.id])
  const now = shapeOf(canvas, web.id)!
  expect(now.x).toBeGreaterThan(web.x + 10) // pushed
  expect(h.world.layout.get('region:web')).toMatchObject({ x: now.x, y: now.y })
  canvas.dispose()
})

test("an event the room can't follow is replayed at the next start", async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.arrangement.start(null, 1)
  const before = canvas.logSeq!
  const write = canvas.write.bind(canvas)
  canvas.write = () => {
    throw new Error('the room is broken')
  }
  await h.record({ topic: 'world', type: 'layout.set', actor: 'luca', data: { items: [{ id: 's1', kind: 'session', x: 400, y: 20, parent: 'region:api' }] } })
  canvas.write = write
  await h.record({ topic: 'world', type: 'note.created', actor: 'luca', data: { id: 'n1', text: 'later', color: 'yellow', x: 0, y: 0 } })
  expect(canvas.logSeq).toBe(before) // not past the event it missed

  // The next start replays it.
  const snapshot = structuredClone(canvas.room.getCurrentSnapshot())
  canvas.dispose()
  const missed = h.recorded.filter(e => e.seq > before)
  const room = await h.open({ snapshot, logSeq: before })
  await h.arrangement.start((async function* () { yield* missed })(), missed.at(-1)!.seq)
  expect(shapeOf(room, sessionShapeId('s1'))).toMatchObject({ x: 400 })
  expect(room.logSeq).toBeGreaterThanOrEqual(missed.at(-1)!.seq)
  room.dispose()
})

test('a note a page deleted just before a crash stays deleted', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.record({ topic: 'world', type: 'note.created', actor: 'luca', data: { id: 'n1', text: 'gone soon', color: 'yellow', x: 0, y: 0 } })
  await h.arrangement.start(null, 1)
  // The page's deletion reached the room's snapshot; its event never reached the log.
  canvas.write([], [noteShapeId('n1')])
  const snapshot = structuredClone(canvas.room.getCurrentSnapshot())
  canvas.dispose()
  const room = await h.open({ snapshot, logSeq: 1 })
  await h.arrangement.start(null, 1)
  expect(room.get(noteShapeId('n1'))).toBeUndefined()
  expect(h.world.notes.has('n1')).toBe(false)
  room.dispose()
})

test('notes in a section: they move with it when it is pushed or moved by an older page, and it fits them', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.start('s2', 'web')
  await h.arrangement.start(null, 2)
  const web = shapeOf(canvas, sectionShapeId('region:web'))!
  const id = createShapeId('in-web')
  canvas.write([{ ...(note(id, 'in web', 20, 220) as TLShape), parentId: web.id, meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  const noteId = id.slice('shape:'.length)
  // The note made web taller: web fits it.
  expect((shapeOf(canvas, web.id)!.props as { h: number }).h).toBeGreaterThanOrEqual(220 + 200 + CANVAS.pad)
  // api grows into web (a card moved on an older page): web is pushed, and its note's place recorded.
  await h.record({ topic: 'world', type: 'layout.set', actor: 'luca', data: { items: [{ id: 's1', kind: 'session', x: 1400, y: 20, parent: 'region:api' }] } })
  const pushed = shapeOf(canvas, web.id)!
  expect(pushed.x).toBeGreaterThan(web.x)
  expect(h.world.layout.get(noteId)).toMatchObject({ x: pushed.x + 20, y: pushed.y + 220 })
  // An older page moves web: the note goes with it, for older pages too.
  await h.record({ topic: 'world', type: 'layout.set', actor: 'luca', data: { items: [{ id: 'region:web', kind: 'region', x: 9000, y: 9000 }] } })
  expect(h.world.layout.get(noteId)).toMatchObject({ x: 9020, y: 9220 })
  canvas.dispose()
})

test("a batch where a note's section is pushed records the note where it ends up", async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.start('s2', 'web')
  await h.arrangement.start(null, 2)
  const web = shapeOf(canvas, sectionShapeId('region:web'))!
  const id = createShapeId('in-web')
  canvas.write([{ ...(note(id, 'in web', 20, 20) as TLShape), parentId: web.id, meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  // One commit: the note moves in web, and api's card goes far right, so api pushes web aside.
  canvas.write([{ ...shapeOf(canvas, id)!, x: 30 } as TLRecord, { ...shapeOf(canvas, sessionShapeId('s1'))!, x: 1400 } as TLRecord])
  await h.arrangement.fromPages([id, sessionShapeId('s1')])
  const pushed = shapeOf(canvas, web.id)!
  expect(pushed.x).toBeGreaterThan(web.x)
  expect(h.world.layout.get(id.slice('shape:'.length))).toMatchObject({ x: pushed.x + 30, y: pushed.y + 20 })
  canvas.dispose()
})

test('a note that grows with its text gets taller for older pages too', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.arrangement.start(null, 0)
  const id = createShapeId('growing')
  canvas.write([{ ...(note(id, 'short', 0, 0) as TLShape), meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  expect(h.world.layout.get(id.slice('shape:'.length))).toMatchObject({ w: 200, h: 200 })
  canvas.write([{ ...shapeOf(canvas, id)!, props: { ...(shapeOf(canvas, id)!.props as object), growY: 120 } } as TLRecord])
  await h.arrangement.fromPages([id])
  expect(h.world.layout.get(id.slice('shape:'.length))).toMatchObject({ w: 200, h: 320 })
  // And shorter again when its text shrinks.
  canvas.write([{ ...shapeOf(canvas, id)!, props: { ...(shapeOf(canvas, id)!.props as object), growY: 0 } } as TLRecord])
  await h.arrangement.fromPages([id])
  expect(h.world.layout.get(id.slice('shape:'.length))).toMatchObject({ w: 200, h: 200 })
  canvas.dispose()
})

test('a note in a turned section is placed on the page through the turn, both ways', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.arrangement.start(null, 1)
  const section = shapeOf(canvas, sectionShapeId('region:api'))!
  canvas.write([{ ...section, rotation: Math.PI / 2 } as TLRecord])
  const id = createShapeId('turned')
  canvas.write([{ ...(note(id, 'turned', 100, 0) as TLShape), parentId: section.id, meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  const noteId = id.slice('shape:'.length)
  // A quarter turn puts (100, 0) in the section at (0, 100) from its corner on the page.
  expect(h.world.layout.get(noteId)).toMatchObject({ x: section.x, y: section.y + 100 })
  // An older page moves it 50 to the right on the page: in the turned section, that's 50 along its -y.
  await h.record({ topic: 'world', type: 'layout.set', actor: 'luca', data: { items: [{ id: noteId, kind: 'note', x: section.x + 50, y: section.y + 100 }] } })
  const local = shapeOf(canvas, id)!
  expect(local.x).toBeCloseTo(100)
  expect(local.y).toBeCloseTo(-50)
  canvas.dispose()
})

test("an older page's note keeps its size through the import", async () => {
  const h = harness()
  await h.open()
  await h.record({ topic: 'world', type: 'note.created', actor: 'luca', data: { id: 'n1', text: 'classic', color: 'yellow', x: 0, y: 0, w: 220, h: 160 } })
  // The room is new: as on the first start after the deploy.
  const canvas = await h.open()
  await h.arrangement.start(null, 1)
  expect(shapeOf(canvas, noteShapeId('n1'))).toMatchObject({ props: { scale: 1.1 } })
  expect(h.world.layout.get('n1')).toMatchObject({ w: 220, h: 160 })
  canvas.dispose()
})

test("an older page's height-only resize stands through later moves here and restarts", async () => {
  const h = harness()
  await h.open()
  await h.record({ topic: 'world', type: 'note.created', actor: 'luca', data: { id: 'n1', text: 'classic', color: 'yellow', x: 0, y: 0, w: 220, h: 160 } })
  const canvas = await h.open()
  await h.arrangement.start(null, 1)
  await h.record({ topic: 'world', type: 'layout.set', actor: 'luca', data: { items: [{ id: 'n1', kind: 'note', x: 0, y: 0, w: 220, h: 300 }] } })
  // A page moves it here; then the server restarts (the room-to-log pass).
  canvas.write([{ ...shapeOf(canvas, noteShapeId('n1'))!, x: 50 } as TLRecord])
  await h.arrangement.fromPages([noteShapeId('n1')])
  const snapshot = structuredClone(canvas.room.getCurrentSnapshot())
  const logSeq = canvas.logSeq
  canvas.dispose()
  const room = await h.open({ snapshot, logSeq })
  await h.arrangement.start(null, logSeq!)
  expect(h.world.layout.get('n1')).toMatchObject({ x: 50, w: 220, h: 300 })
  room.dispose()
})

test('a size the log failed to take is recorded on the next try', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.arrangement.start(null, 0)
  const id = createShapeId('resized')
  canvas.write([{ ...(note(id, 'x', 0, 0) as TLShape), meta: { author: 'jp' } } as TLRecord])
  await h.arrangement.fromPages([id])
  canvas.write([{ ...shapeOf(canvas, id)!, props: { ...(shapeOf(canvas, id)!.props as object), scale: 2 } } as TLRecord])
  // Postgres refuses the first try.
  const record = h.record
  let refused = false
  ;(h.arrangement as unknown as { record: typeof record }).record = async e => {
    if (!refused) {
      refused = true
      throw new Error('database restarting')
    }
    return record(e)
  }
  await expect(h.arrangement.fromPages([id])).rejects.toThrow('database restarting')
  await h.arrangement.fromPages([id])
  expect(h.world.layout.get(id.slice('shape:'.length))).toMatchObject({ w: 400, h: 400 })
  canvas.dispose()
})

test('a note from before the room kept sizes keeps the size the log has', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.record({ topic: 'world', type: 'note.created', actor: 'luca', data: { id: 'n1', text: 'old', color: 'yellow', x: 0, y: 0, w: 220, h: 160 } })
  // As an earlier version made it: no sizeSeen.
  const old = shapeOf(canvas, noteShapeId('n1'))!
  canvas.write([{ ...old, meta: { author: 'luca' } } as TLRecord])
  await h.arrangement.start(null, 1)
  expect(h.world.layout.get('n1')).toMatchObject({ w: 220, h: 160 })
  canvas.dispose()
})

test('what a page put on a retiring card stays, on the page', async () => {
  const h = harness()
  const canvas = await h.open()
  await h.start('s1', 'api')
  await h.arrangement.start(null, 1)
  const card = shapeOf(canvas, sessionShapeId('s1'))!
  const id = createShapeId('on-card')
  canvas.write([{ ...(note(id, 'on a card', 5, 5) as TLShape), parentId: card.id } as TLRecord])
  const section = shapeOf(canvas, sectionShapeId('region:api'))!
  const onPage = { x: section.x + card.x + 5, y: section.y + card.y + 5 }
  h.world.setConnected('s1', false)
  h.world.sessions.get('s1')!.lastSeenAt = new Date(h.t0 - RETIRE_MS - 60_000).toISOString()
  h.arrangement.retire()
  expect(shapeOf(canvas, card.id)).toBeUndefined()
  expect(shapeOf(canvas, id)).toMatchObject({ parentId: CANVAS_PAGE, ...onPage })
  // The section, left empty, goes too.
  expect(shapeOf(canvas, sectionShapeId('region:api'))).toBeUndefined()
  canvas.dispose()
})

test('rich text reads as plain text a block a line', () => {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const doc = { type: 'doc', content: [p('intro'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('first'), p('second')] }, { type: 'listItem', content: [p('third')] }] }] }
  expect(plainTextOf(doc as never)).toBe('intro\nfirst\nsecond\nthird')
  expect(plainTextOf(richTextOf('a\n\nb'))).toBe('a\n\nb')
})

function note(id: string, text: string, x: number, y: number): TLRecord {
  return {
    id, typeName: 'shape', type: 'note', x, y, rotation: 0, index: 'a5', parentId: CANVAS_PAGE, isLocked: false, opacity: 1, meta: {},
    props: { color: 'yellow', labelColor: 'black', size: 'm', font: 'sans', fontSizeAdjustment: 0, align: 'start', verticalAlign: 'start', growY: 0, url: '', richText: richTextOf(text), scale: 1, textLastEditedBy: null },
  } as unknown as TLRecord
}

