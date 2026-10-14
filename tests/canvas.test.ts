// The canvas room (server/src/canvas.ts): validated server writes and snapshots, in this process;
// then sphere-server's `/canvas` socket, with pages as tldraw's own sync client, against a scratch
// Postgres database.
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
//
// The database is emptied first, so never point this at a real one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { RoomSnapshot } from '@tldraw/sync-core'
import { createShapeId, createShapePropsMigrationSequence, createTLSchema, defaultBindingSchemas, defaultShapeSchemas, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { CANVAS_PAGE, canvasSchema, liveShapeId, sectionProps, sectionShapeId, sessionProps, sessionShapeId } from '../shared/canvas'
import { Canvas, CanvasWriteError, liveRoomId, withoutLive, type Saved, type Snapshots } from '../server/src/canvas'
import { connect } from '../server/src/pg'
import { DATABASE_URL, openPage, sphereServer, startSession, until, type Page } from './pages'

const PORT = 7463

/** Snapshots in memory, by row, counting saves. `snapshot` and `logSeq` are the room's own row's. */
function memory() {
  const m = { snapshot: null as RoomSnapshot | null, logSeq: null as number | null, saves: 0, rows: new Map<string, Saved>() }
  const snapshots: Snapshots = {
    load: async room => structuredClone(m.rows.get(room) ?? null),
    save: async (room, s) => {
      m.rows.set(room, structuredClone(s))
      if (!room.endsWith(':live')) {
        m.snapshot = structuredClone(s.snapshot)
        m.logSeq = s.logSeq
      }
      m.saves++
    },
  }
  return { m, snapshots }
}

/** The schema of a page from before terminal cards. */
const oldSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    session: { props: sessionProps, migrations: createShapePropsMigrationSequence({ sequence: [] }) },
    section: { props: sectionProps, migrations: createShapePropsMigrationSequence({ sequence: [] }) },
  },
  bindings: defaultBindingSchemas,
}) as unknown as typeof canvasSchema

/** A shape as the server writes one: every field, so it validates. */
function shape(id: string, type: string, props: Record<string, unknown>, extra: Partial<TLShape> = {}): TLRecord {
  return { id, typeName: 'shape', type, x: 0, y: 0, rotation: 0, index: 'a1', parentId: CANVAS_PAGE, isLocked: false, opacity: 1, props, meta: {}, ...extra } as unknown as TLRecord
}
const note = (id: string, text: string) =>
  shape(id, 'note', { color: 'yellow', labelColor: 'black', size: 'm', font: 'draw', fontSizeAdjustment: 0, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, scale: 1, textLastEditedBy: null })
const section = (region: string, title: string) => shape(sectionShapeId(region), 'section', { w: 960, h: 400, title })
const terminal = (sessionId: string, extra: Partial<TLShape> = {}) => shape(liveShapeId('terminal'), 'terminal', { w: 760, h: 480, sessionId }, extra)
const card = (sessionId: string, region: string) => shape(sessionShapeId(sessionId), 'session', { w: 300, h: 168, sessionId }, { parentId: sectionShapeId(region), x: 20, y: 20 })

/** Rooms opened here, closed at the end: a room's timers would keep the test process running. */
const rooms = {
  all: [] as Canvas[],
  open(c: Canvas) {
    this.all.push(c)
    return c
  },
}
afterAll(() => rooms.all.forEach(c => c.dispose()))

describe('the room', () => {
  test('starts with a document and its page', async () => {
    const canvas = rooms.open(await Canvas.open('t', memory().snapshots))
    const types = canvas.records().map(r => r.typeName).sort()
    expect(types).toEqual(['document', 'page'])
    expect(canvas.get(CANVAS_PAGE)).toMatchObject({ typeName: 'page' })
  })

  test('writes valid records, refuses invalid ones whole', async () => {
    const canvas = rooms.open(await Canvas.open('t', memory().snapshots))
    canvas.write([section('region:api', 'api'), card('s1', 'region:api')])
    expect(canvas.get(sessionShapeId('s1'))).toMatchObject({ parentId: sectionShapeId('region:api'), props: { sessionId: 's1' } })

    // A bad prop, alongside a good record: neither is written.
    const bad = card('s2', 'region:api') as any
    bad.props.w = 'wide'
    expect(() => canvas.write([section('region:web', 'web'), bad])).toThrow(CanvasWriteError)
    expect(canvas.get(sectionShapeId('region:web'))).toBeUndefined()

    // An unknown shape type, a shape whose parent doesn't exist, a record that isn't the document's.
    expect(() => canvas.write([shape(createShapeId('x'), 'nonsense', { w: 1, h: 1 })])).toThrow(/invalid shape/)
    expect(() => canvas.write([card('s3', 'region:nowhere')])).toThrow(/no parent/)
    expect(() => canvas.write([{ id: 'instance_presence:x', typeName: 'instance_presence' } as unknown as TLRecord])).toThrow(/not a document record/)

    // Removing a section would leave its card without a parent; a note on it can go with it.
    expect(() => canvas.write([], [sectionShapeId('region:api')])).toThrow(/no parent/)
    canvas.write([section('region:web', 'web'), { ...(note(createShapeId('n'), 'x') as TLShape), parentId: sectionShapeId('region:web') } as TLRecord])
    canvas.write([], [sectionShapeId('region:web'), createShapeId('n')])
    expect(canvas.get(sectionShapeId('region:web'))).toBeUndefined()
  })

  test("keeps session cards, in their session's section, for the server too", async () => {
    const sections: Record<string, string> = { s1: sectionShapeId('region:api') }
    const canvas = rooms.open(await Canvas.open('t', memory().snapshots, { sectionOf: id => sections[id] ?? null }))
    canvas.write([section('region:api', 'api'), section('region:ticket:CS-1', 'CS-1'), card('s1', 'region:api')])

    expect(() => canvas.write([], [sessionShapeId('s1')])).toThrow(/never removed/)
    expect(() => canvas.write([card('s1', 'region:ticket:CS-1')])).toThrow(/belongs in shape:region:api/)
    // Its session moved to the ticket's frame: so does its card.
    sections.s1 = sectionShapeId('region:ticket:CS-1')
    canvas.write([card('s1', 'region:ticket:CS-1')])
    expect(canvas.get(sessionShapeId('s1'))).toMatchObject({ parentId: sectionShapeId('region:ticket:CS-1') })
    // Not replaced by another shape, and its id isn't anyone else's.
    expect(() => canvas.write([{ ...(note(sessionShapeId('s1'), 'x') as TLShape), parentId: sectionShapeId('region:api') } as TLRecord])).toThrow(/kept for a session card/)
    canvas.write([note(createShapeId('n'), 'x')])
    expect(() => canvas.write([section('region:x', 'x'), { ...(section('region:x', 'x') as TLShape), id: createShapeId('n') } as TLRecord])).toThrow(/is a note, not a section/)
    // One card per session, under the session's own id.
    expect(() => canvas.write([{ ...(card('s2', 'region:api') as TLShape), id: sessionShapeId('s1') } as TLRecord])).toThrow(/must be shape:session:s2/)
  })

  test('saves what changed, once, and opens from it', async () => {
    const { m, snapshots } = memory()
    const canvas = rooms.open(await Canvas.open('t', snapshots, { saveMs: 10 }))
    await canvas.flush() // the new document and page
    expect(m.saves).toBe(1)
    await canvas.flush()
    expect(m.saves).toBe(1) // nothing changed since

    canvas.write([section('region:api', 'api'), card('s1', 'region:api')])
    canvas.write([{ ...canvas.get(sessionShapeId('s1'))!, x: 340 } as TLRecord])
    await Bun.sleep(50) // both changes in one save, a moment later
    expect(m.saves).toBe(2)

    const again = rooms.open(await Canvas.open('t', snapshots))
    expect(again.get(sessionShapeId('s1'))).toMatchObject({ x: 340 })
    expect(again.records().filter(r => r.typeName === 'page')).toHaveLength(1)
  })

  test('on shutdown, keeps trying to save, and lets no page in', async () => {
    const { m, snapshots } = memory()
    let failures = 2
    const flaky: Snapshots = {
      load: snapshots.load,
      save: async (room, s) => {
        if (failures-- > 0) throw new Error('database restarting')
        await snapshots.save(room, s)
      },
    }
    const canvas = rooms.open(await Canvas.open('t', flaky, { saveMs: 60_000 }))
    canvas.write([section('region:api', 'api')])
    await canvas.shutdown(3000)
    expect(m.saves).toBe(1)
    expect(m.snapshot!.documents.some(d => d.state.id === sectionShapeId('region:api'))).toBe(true)

    const closed: unknown[] = []
    expect(canvas.connect({ send() {}, close: (...a: unknown[]) => void closed.push(a), readyState: 1 }, { identity: 'luca' })).toBeNull()
    expect(closed).toEqual([[1012, 'restarting']])
  })
})

describe('live cards in the room', () => {
  test("a live card's id names its type, for the server's writes too", async () => {
    const canvas = rooms.open(await Canvas.open('t', memory().snapshots))
    const t = terminal('s1')
    canvas.write([t])
    expect(canvas.get(t.id)).toMatchObject({ type: 'terminal', props: { sessionId: 's1' } })
    expect(() => canvas.write([{ ...(t as TLShape), id: createShapeId('plain') } as TLRecord])).toThrow(/a live card's id names its type/)
    expect(() => canvas.write([note(liveShapeId('terminal'), 'not a terminal')])).toThrow(/a live card's id names its type/)
    // Unlike a session's card, a terminal card can go.
    canvas.write([], [t.id])
    expect(canvas.get(t.id)).toBeUndefined()
  })

  test("are saved in a row of their own, which servers from before them don't read", async () => {
    const { m, snapshots } = memory()
    const canvas = rooms.open(await Canvas.open('t', snapshots, { saveMs: 10 }))
    await canvas.flush()
    expect(m.rows.has(liveRoomId('t'))).toBe(false) // nothing to save there yet
    const t = terminal('s1', { x: 77 })
    canvas.write([note(createShapeId('n'), 'x'), t])
    await canvas.flush()
    const ids = (room: string) => m.rows.get(room)!.snapshot.documents.map(d => d.state.id)
    expect(ids('t')).toContain(createShapeId('n'))
    expect(ids('t')).not.toContain(t.id)
    expect(ids(liveRoomId('t'))).toEqual([t.id])
    // The live row is saved again only when a live card changes.
    const saves = m.saves
    canvas.write([{ ...(canvas.get(createShapeId('n')) as TLShape), x: 5 } as TLRecord])
    await canvas.flush()
    expect(m.saves).toBe(saves + 1)

    // Opened again, it's whole.
    const again = rooms.open(await Canvas.open('t', snapshots))
    expect(again.get(t.id)).toMatchObject({ x: 77 })
    expect(again.get(createShapeId('n'))).toBeTruthy()

    // A removal is kept too.
    again.write([], [t.id])
    await again.flush()
    const third = rooms.open(await Canvas.open('t', snapshots))
    expect(third.get(t.id)).toBeUndefined()
  })

  test("are kept when a first save stopped after their row, before the room's", async () => {
    const { m, snapshots } = memory()
    const canvas = rooms.open(await Canvas.open('t', snapshots))
    const t = terminal('s1', { x: 9 })
    canvas.write([t])
    await canvas.flush()
    m.rows.delete('t')
    const again = rooms.open(await Canvas.open('t', snapshots))
    expect(again.get(t.id)).toMatchObject({ x: 9, parentId: CANVAS_PAGE })
    expect(again.get(CANVAS_PAGE)).toBeTruthy()
  })

  test('one whose parent went while a server from before them ran goes on the page', async () => {
    const { m, snapshots } = memory()
    const canvas = rooms.open(await Canvas.open('t', snapshots))
    const frame = createShapeId('frame')
    canvas.write([shape(frame, 'frame', { w: 900, h: 600, name: 'x', color: 'black' }, { x: 100, y: 100 })])
    const t = terminal('s1', { parentId: frame, x: 10, y: 20 })
    canvas.write([t])
    await canvas.flush()
    // An older server removes the frame: it writes the room's row, not knowing the live one.
    const row = m.rows.get('t')!
    row.snapshot.documents = row.snapshot.documents.filter(d => d.state.id !== frame)
    const again = rooms.open(await Canvas.open('t', snapshots))
    expect(again.get(t.id)).toMatchObject({ parentId: CANVAS_PAGE })
  })

  test('are left out of what a page from before them is sent', () => {
    const id = liveShapeId('terminal')
    const other = createShapeId('n')
    const hidden = new Set(['terminal'] as const)
    const msg = (x: unknown) => JSON.parse(withoutLive(JSON.stringify(x), hidden))
    expect(msg({ type: 'connect', diff: { [id]: ['put', {}], [other]: ['put', {}] } }).diff).toEqual({ [other]: ['put', {}] })
    expect(
      msg({ type: 'data', data: [{ type: 'patch', diff: { [id]: ['patch', {}] } }, { type: 'push_result', action: { rebaseWithDiff: { [id]: ['remove'], [other]: ['remove'] } } }] }).data,
    ).toEqual([{ type: 'patch', diff: {} }, { type: 'push_result', action: { rebaseWithDiff: { [other]: ['remove'] } } }])
    expect(msg({ type: 'pong' })).toEqual({ type: 'pong' })
  })
})

describe('sphere-server /canvas', () => {
  const server = sphereServer(PORT, { SPHERE_TLDRAW_LICENSE_KEY: 'tldraw-test-"key"' })
  const sql = connect(DATABASE_URL)
  const open: Page[] = []
  const page = async (token = 'dev-luca', schema = canvasSchema) => {
    const p = await openPage(PORT, token, schema)
    open.push(p)
    return p
  }
  /** A session's card and its repo's section, which the server made when the session started. */
  let s1 = ''
  let bridge: { close(): void } | null = null

  beforeAll(async () => {
    await sql`drop table if exists events, bodies, canvas_rooms`
    await server.start()
    const started = await startSession(server.url, { repo: 'api' })
    s1 = started.id
    bridge = started.client
  })

  afterAll(async () => {
    open.forEach(p => p.close())
    bridge?.close()
    await server.stop()
    await sql.close()
  })

  test('refuses other sites and unknown tokens', async () => {
    expect((await fetch(`${server.http}/canvas?token=nope`)).status).toBe(401)
    expect((await fetch(`${server.http}/canvas?token=dev-luca`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    // A known token gets as far as the upgrade.
    expect((await fetch(`${server.http}/canvas?token=dev-luca`)).status).toBe(400)
  })

  test('puts the licence key in the page', async () => {
    const html = await (await fetch(`${server.http}/`)).text()
    expect(html).toContain('<meta name="tldraw-license-key" content="tldraw-test-&#34;key&#34;">')
  })

  test("two pages see each other's changes, signed with who made them", async () => {
    const [luca, jp] = [await page(), await page('dev-jp')]
    expect(jp.shape(sessionShapeId(s1))).toMatchObject({ parentId: sectionShapeId('region:api'), props: { sessionId: s1 } })

    const id = createShapeId('n1')
    luca.store.put([note(id, 'hello')])
    await until(() => !!jp.shape(id))
    // The server stamps the author; the page's own copy catches up.
    await until(() => luca.shape(id)?.meta.author === 'luca')
    expect(jp.shape(id)!.meta.author).toBe('luca')

    jp.store.put([{ ...jp.shape(id)!, x: 500 }])
    await until(() => luca.shape(id)!.x === 500)

    // Nobody signs as someone else.
    jp.store.put([{ ...jp.shape(id)!, meta: { author: 'jp' } }])
    await Bun.sleep(300)
    expect(luca.shape(id)!.meta.author).toBe('luca')
    await until(() => jp.shape(id)!.meta.author === 'luca')
  })

  test("a page moves the server's cards and sections but can't remove, reparent or make them", async () => {
    const [luca, jp] = [await page(), await page('dev-jp')]
    const cardId = sessionShapeId(s1)
    luca.store.put([{ ...luca.shape(cardId)!, x: 340 }])
    await until(() => jp.shape(cardId)!.x === 340)

    luca.store.remove([cardId as any])
    await until(() => !!luca.shape(cardId)) // put back
    expect(jp.shape(cardId)).toBeTruthy()

    luca.store.put([{ ...luca.shape(cardId)!, parentId: CANVAS_PAGE }])
    await until(() => luca.shape(cardId)!.parentId === sectionShapeId('region:api'))

    const sectionId = sectionShapeId('region:api')
    luca.store.put([{ ...luca.shape(sectionId)!, props: { ...(luca.shape(sectionId)!.props as object), title: 'renamed' } } as unknown as TLRecord])
    await until(() => (luca.shape(sectionId)!.props as { title: string }).title === 'api')

    const made = card('s9', 'region:api')
    luca.store.put([made])
    await Bun.sleep(300)
    expect(jp.shape(made.id)).toBeUndefined()
    await until(() => !luca.shape(made.id))
  })

  test("a page can't take a session card's id, or leave a shape without its parent", async () => {
    const [luca, jp] = [await page(), await page('dev-jp')]
    // A note where a session's card would go.
    const squat = { ...(note(sessionShapeId('not-yet') as never, 'mine') as TLShape) } as TLRecord
    luca.store.put([squat])
    await until(() => !luca.store.get(squat.id as any)) // refused, and taken back
    expect(jp.store.get(squat.id as any)).toBeUndefined()

    // A note longer than the log keeps: refused, so a rebuild from the log loses nothing.
    const long = createShapeId('long')
    luca.store.put([note(long, 'x'.repeat(5000))])
    await until(() => !luca.store.get(long as any))
    expect(jp.store.get(long as any)).toBeUndefined()

    // A frame with a note in it, then the frame removed alone: the note goes on the page.
    const frame = createShapeId('frame')
    const inside = createShapeId('inside')
    luca.store.put([shape(frame, 'frame', { w: 400, h: 300, name: 'x', color: 'black' }, { x: 3000, y: 3000 })])
    luca.store.put([{ ...(note(inside, 'in a frame') as TLShape), parentId: frame, x: 10, y: 10 } as TLRecord])
    await until(() => !!jp.store.get(inside as any))
    luca.store.remove([frame as any])
    await until(() => (jp.store.get(inside as any) as TLShape | undefined)?.parentId === CANVAS_PAGE)
    await until(() => (luca.store.get(inside as any) as TLShape | undefined)?.parentId === CANVAS_PAGE)
    // Where it was on the page: the frame's corner plus its place in the frame.
    expect(jp.store.get(inside as any)).toMatchObject({ x: 3010, y: 3010 })

    // Through a turned frame too: a quarter turn puts (10, 0) in the frame at (0, 10) on the page.
    const turned = createShapeId('turned')
    const onTurned = createShapeId('on-turned')
    luca.store.put([shape(turned, 'frame', { w: 400, h: 300, name: 'y', color: 'black' }, { x: 5000, y: 5000, rotation: Math.PI / 2 })])
    luca.store.put([{ ...(note(onTurned, 'turned') as TLShape), parentId: turned, x: 10, y: 0 } as TLRecord])
    await until(() => !!jp.store.get(onTurned as any))
    luca.store.remove([turned as any])
    await until(() => (jp.store.get(onTurned as any) as TLShape | undefined)?.parentId === CANVAS_PAGE)
    const kept = jp.store.get(onTurned as any) as TLShape
    expect(kept.x).toBeCloseTo(5000)
    expect(kept.y).toBeCloseTo(5010)
    expect(kept.rotation).toBeCloseTo(Math.PI / 2)
  })

  test('pages add terminal cards, under the rules for live cards', async () => {
    const [luca, jp] = [await page(), await page('dev-jp')]
    const t = terminal(s1, { x: 4000, y: 0 })
    luca.store.put([t])
    await until(() => (jp.shape(t.id)?.meta.author as string | undefined) === 'luca')
    expect(jp.shape(t.id)).toMatchObject({ type: 'terminal', props: { sessionId: s1 } })

    // Its session stays its session.
    jp.store.put([{ ...jp.shape(t.id)!, props: { ...(jp.shape(t.id)!.props as object), sessionId: 'another' } } as TLRecord])
    await until(() => (jp.shape(t.id)!.props as { sessionId: string }).sessionId === s1)
    // A terminal whose id doesn't say so, or a note whose id says terminal, is refused.
    const plain = { ...(terminal(s1) as TLShape), id: createShapeId('plain-terminal') } as TLRecord
    luca.store.put([plain])
    await until(() => !luca.shape(plain.id))
    const squat = note(liveShapeId('terminal'), 'squat')
    luca.store.put([squat])
    await until(() => !luca.shape(squat.id))
    // An arrow can't be bound to a live card.
    const arrow = createShapeId('arrow')
    luca.store.put([shape(arrow, 'arrow', { kind: 'arc', dash: 'draw', size: 'm', fill: 'none', color: 'black', labelColor: 'black', bend: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, arrowheadStart: 'none', arrowheadEnd: 'arrow', richText: { type: 'doc', content: [] }, labelPosition: 0.5, font: 'draw', scale: 1, elbowMidPoint: 0.5 }, { x: 3800 })])
    await until(() => !!jp.shape(arrow))
    const binding = { id: 'binding:b1', typeName: 'binding', type: 'arrow', fromId: arrow, toId: t.id, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' }, meta: {} } as unknown as TLRecord
    luca.store.put([binding])
    await until(() => !luca.store.get('binding:b1' as any))
    expect(jp.store.get('binding:b1' as any)).toBeUndefined()

    // Anyone can remove one: it shows a session, it isn't the session.
    jp.store.remove([t.id as any])
    await until(() => !luca.shape(t.id))
  })

  test("a page from before terminal cards doesn't get them, and keeps working", async () => {
    const luca = await page()
    const old = await page('dev-jp', oldSchema)
    const t = terminal(s1, { x: 5000, y: 0 })
    // Why: such a page can't take one. Its store refuses the record, and its sync client starts over, again and again.
    expect(() => oldSchema.types.shape.validate(t)).toThrow()
    luca.store.put([t])
    await until(() => (luca.shape(t.id)?.meta.author as string | undefined) === 'luca')
    // A change to it, and its removal, don't reach the old page either.
    luca.store.put([{ ...luca.shape(t.id)!, x: 5100 }])
    const n = createShapeId('n-old')
    luca.store.put([note(n, 'after the terminal')])
    await until(() => !!old.shape(n))
    expect(old.shape(t.id)).toBeUndefined()
    // The old page still writes, and a page that just connected gets the terminal.
    old.store.put([{ ...old.shape(n)!, x: 1234 }])
    await until(() => luca.shape(n)!.x === 1234)
    const late = await page('dev-jp')
    expect(late.shape(t.id)).toMatchObject({ x: 5100 })
    const old2 = await page('dev-jp', oldSchema)
    expect(old2.shape(t.id)).toBeUndefined()
    expect(old2.shape(n)).toBeTruthy()
    luca.store.remove([t.id as any])
    await until(() => !late.shape(t.id))
  })

  test('keeps the canvas across a restart', async () => {
    const luca = await page()
    const id = createShapeId('n2')
    luca.store.put([note(id, 'kept')])
    await until(() => luca.shape(id)?.meta.author === 'luca')
    // Stopped within the second it waits to save: the shutdown saves it.
    await server.stop()
    await server.start()
    const later = await page('dev-jp')
    expect(later.shape(id)).toMatchObject({ meta: { author: 'luca' } })
    expect(later.shape(sessionShapeId(s1))).toMatchObject({ x: 340 })
  })
})
