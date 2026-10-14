// Keeps the canvas room (tldraw) and the world's layout and notes in step, both ways. The page
// edits the room; `layout.set` and `note.*` still come from tabs opened before the React Flow
// canvas was removed (and stay `/ws` commands any client may send), and a server rolled back to
// before the room reads them.
//
// - Events to the room: a session's card goes in its region's section, in the slot the world
//   gave it; a section is made, and placed, the first time its region has a card; `layout.set`
//   and `note.*` from older pages move and change the room's shapes.
// - The room to events: what pages change in the room is recorded as the same events, so older
//   pages, the `canvas` command and a server rolled back to before the room all see it. Those
//   events carry `source: 'canvas'` and aren't applied to the room again.
//
// The room owns the arrangement; the events are its mirror. Each direction patches only what
// its change concerns, so a page's drag isn't undone by an unrelated event.
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import type { TLRecord, TLShape } from '@tldraw/tlschema'
import {
  CANVAS_PAGE,
  isRegionSection,
  liveTypeOfId,
  NOTE_TEXT_LIMIT,
  noteColorFromTldraw,
  noteColorToTldraw,
  noteIdOf,
  noteShapeId,
  noteSize,
  plainTextOf,
  richTextOf,
  sectionShapeId,
  sessionShapeId,
} from '../../shared/canvas'
import { CANVAS, regionFor, type LayoutItem, type Note, type NoteColor, type SessionSummary, type StoredEvent } from '../../shared/protocol'
import type { Canvas } from './canvas'
import type { World } from './world'

/** Records an event (in the log, then the world), as `record` in main.ts does. */
export type Recorder = (e: { topic: string; type: string; actor: string; data: Record<string, unknown> }) => Promise<unknown>

const { cardW, cardH, pad } = CANVAS
/** Where new sections go: in rows this wide, this far apart. */
const ROW_WIDTH = 2400
const SECTION_GAP = 96
/** A card whose session ended, or wasn't seen, this long ago leaves the canvas. */
export const RETIRE_MS = 7 * 24 * 3600_000

type Box = { x: number; y: number; w: number; h: number }
/** Notes' canvas sizes, by shape id, that the log agrees with once their layout batch is recorded. */
type Sizes = Map<string, { w: number; h: number }>
/** A React Flow note's width as a tldraw note's scale (tldraw's notes are 200 wide, and square). */
const noteScale = (w: number) => Math.min(4, Math.max(0.5, Math.round((w / 200) * 100) / 100))

export class Arrangement {
  constructor(
    private readonly world: World,
    private readonly canvas: Canvas,
    private readonly record: Recorder,
  ) {}

  // ---------- events to the room ----------

  /**
   * On startup, after the world is built from the log. The room's last snapshot may be behind the
   * log, or ahead of it, after a crash; this brings them back in step:
   * 1. the arrangement events logged after the snapshot are applied to the room again;
   * 2. every session that still shows, and every note, gets its shape if it has none (all of
   *    them, the first time); the cards of sessions long gone leave;
   * 3. what the room has that the log doesn't (a page's change saved in the room but not yet
   *    recorded) is recorded.
   */
  async start(missed: AsyncIterable<StoredEvent> | null, lastSeq: number, now = Date.now()) {
    if (missed) for await (const ev of missed) await this.onEvent(ev, true)
    // One shape that can't be made doesn't keep the others from being made, or the server from
    // starting: each failure is logged, and the canvas serves what it has.
    const sessions = [...this.world.sessions.values()].filter(s => !this.retirable(s, now)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    for (const s of sessions) await this.softly(`the card of ${s.id}`, () => this.ensureCard(s, false))
    // A note missing from the room was deleted there, if the room remembers removing it (its event
    // was lost in a crash); otherwise it's new to the room.
    const removed = this.canvas.removed()
    for (const n of this.world.notes.values()) {
      const id = noteShapeId(n.id)
      if (this.canvas.get(id)) continue
      if (removed.has(id)) await this.softly(`note ${n.id}'s removal`, () => this.record({ topic: 'world', type: 'note.deleted', actor: 'canvas', data: { id: n.id, source: 'canvas' } }))
      else await this.softly(`note ${n.id}`, async () => this.putNote(n, this.world.layout.get(n.id)))
    }
    await this.softly('retiring cards', async () => this.retire(now))
    await this.softly('recording what the room has', () => this.fromPages(this.canvas.records().filter(r => r.typeName === 'shape').map(r => r.id)))
    if (!this.stuck) this.canvas.followed(lastSeq)
  }

  private async softly(what: string, fn: () => Promise<unknown>) {
    try {
      await fn()
    } catch (e) {
      console.error(`canvas: ${what}:`, e)
    }
  }

  /**
   * An event the room couldn't follow. From then on the room doesn't count itself caught up with
   * the log, so the next start replays from before it.
   */
  private stuck = false

  /** The event types the room follows. */
  static readonly FOLLOWS = ['session.started', 'session.ticket', 'ticket.confirmed', 'layout.set', 'note.created', 'note.updated', 'note.deleted']

  /**
   * After the world applied an event. Events the room itself caused are skipped, except when
   * replaying at startup: the room may have lost what caused them.
   */
  async onEvent(ev: StoredEvent, replaying = false) {
    try {
      await this.apply(ev, replaying)
    } catch (e) {
      // The event stands; the room catches up at the next start, which replays it.
      console.error(`canvas: applying ${ev.type} #${ev.seq} to the room:`, e)
      this.stuck = true
    }
    if (!this.stuck) this.canvas.followed(ev.seq)
  }

  private async apply(ev: StoredEvent, replaying: boolean) {
    const d = ev.data as Record<string, any>
    if (d.source === 'canvas' && !replaying) return
    switch (ev.type) {
      case 'session.started': {
        const s = this.world.sessions.get(d.sessionId)
        if (s) await this.ensureCard(s, true)
        return
      }
      case 'session.ticket': {
        // A person attached a ticket: the card moves to its frame.
        const s = this.world.sessions.get(d.sessionId)
        if (s) await this.ensureCard(s, true)
        return
      }
      case 'ticket.confirmed':
        // Sessions that found this ticket in their branch moved to its frame.
        for (const [id, t] of this.world.found) {
          const s = this.world.sessions.get(id)
          if (s && t.id === d.id) await this.ensureCard(s, true)
        }
        return
      case 'layout.set':
        for (const item of (d.items ?? []) as LayoutItem[]) await this.moveFromLayout(item)
        return
      case 'note.created':
      case 'note.updated': {
        const n = this.world.notes.get(d.id)
        if (n) this.putNote(n, ev.type === 'note.created' ? this.world.layout.get(n.id) : undefined)
        return
      }
      case 'note.deleted':
        if (this.canvas.get(noteShapeId(d.id)) && !this.world.notes.has(d.id)) this.canvas.write([], [noteShapeId(d.id)])
        return
      // A session that comes back after its card retired gets it back.
      case 'session.status':
      case 'session.row':
      case 'session.agent':
        await this.revive(d.sessionId)
        return
    }
  }

  /** A session heard from again: its card, if it retired while the session was away. */
  async revive(sessionId: string) {
    const s = this.world.sessions.get(sessionId)
    if (s && !this.canvas.get(sessionShapeId(sessionId)) && !this.retirable(s)) await this.ensureCard(s, false)
  }

  /** A session's card in its region's section; with `reslot`, at the slot the world gave it. */
  private async ensureCard(s: SessionSummary, reslot: boolean) {
    const region = regionFor(s)
    const section = await this.ensureSection(region)
    const id = sessionShapeId(s.id)
    const card = this.canvas.get(id) as TLShape | undefined
    const slot = this.world.layout.get(s.id)
    const at = slot && slot.parent === region.id ? { x: slot.x, y: slot.y } : { x: pad, y: pad }
    if (card && card.parentId === section && !reslot) return
    if (card && card.parentId === section && card.x === at.x && card.y === at.y) return
    const previous = card?.parentId
    this.canvas.write([
      card
        ? ({ ...card, parentId: section, ...at } as TLRecord)
        : this.shape(id, 'session', { w: cardW, h: cardH, sessionId: s.id }, { parentId: section, ...at }),
    ])
    await this.fit(section)
    if (previous && previous !== section) await this.fit(previous)
  }

  /** A region's section, made where the world saved it, or else in the first free place. */
  private async ensureSection(region: { id: string; title: string }): Promise<string> {
    const id = sectionShapeId(region.id)
    if (this.canvas.get(id)) return id
    const saved = this.world.layout.get(region.id)
    const w = cardW + 2 * pad
    const h = cardH + 2 * pad
    const at = saved ? { x: saved.x, y: saved.y } : this.freeSpot(w, h)
    this.canvas.write([this.shape(id, 'section', { w, h, title: region.title }, at)])
    // Older pages place unsaved frames themselves; this one is saved, so they agree.
    if (!saved) await this.record({ topic: 'world', type: 'layout.set', actor: 'canvas', data: { items: [{ id: region.id, kind: 'region', x: at.x, y: at.y }], source: 'canvas' } })
    return id
  }

  /**
   * A section's size follows its cards: they never hang over its edge, and it doesn't stay big
   * when they leave. A section that grows into others pushes them right, as React Flow pages laid
   * frames out again as they grew; the moves are recorded, so those pages agree.
   */
  private async fit(sectionId: string) {
    const section = this.canvas.get(sectionId) as TLShape | undefined
    if (!section || section.type !== 'section') return
    const children = this.canvas.records().filter((r): r is TLShape => r.typeName === 'shape' && r.parentId === sectionId)
    const sizes = children.map(c => ({ x: c.x, y: c.y, ...this.sizeOf(c) }))
    const w = Math.ceil(Math.max(cardW + 2 * pad, ...sizes.map(c => c.x + c.w + pad)))
    const h = Math.ceil(Math.max(cardH + 2 * pad, ...sizes.map(c => c.y + c.h + pad)))
    const props = section.props as { w: number; h: number; title: string }
    if (props.w === w && props.h === h) return
    const grew = w > props.w || h > props.h
    this.canvas.write([{ ...section, props: { ...props, w, h } } as TLRecord])
    if (grew && section.parentId === CANVAS_PAGE) await this.makeRoom(sectionId)
  }

  /** Moves the sections a grown one now overlaps to its right, and the ones those then overlap. */
  private async makeRoom(grownId: string) {
    const moved: LayoutItem[] = []
    const sizes: Sizes = new Map()
    const queue = [grownId]
    for (let guard = 0; queue.length && guard < 200; guard++) {
      const pusher = this.sectionBox(queue.shift()!)
      if (!pusher) continue
      for (const other of this.sections()) {
        if (other.id === pusher.id) continue
        const o = this.sectionBox(other.id)!
        const overlaps = o.x < pusher.x + pusher.w + SECTION_GAP && o.x + o.w + SECTION_GAP > pusher.x && o.y < pusher.y + pusher.h + SECTION_GAP && o.y + o.h + SECTION_GAP > pusher.y
        // Only ones to its right: what's to its left was there first.
        if (!overlaps || o.x < pusher.x) continue
        const x = pusher.x + pusher.w + SECTION_GAP
        this.canvas.write([{ ...other, x } as TLRecord])
        moved.push({ id: other.id.slice('shape:'.length), kind: 'region', x, y: other.y }, ...(await this.notesIn(other.id, sizes)))
        queue.push(other.id)
      }
    }
    await this.recordLayout(moved, sizes)
  }

  private sections(): TLShape[] {
    return this.canvas.records().filter((r): r is TLShape => r.typeName === 'shape' && r.type === 'section' && r.parentId === CANVAS_PAGE)
  }

  private sectionBox(id: string): (Box & { id: string }) | null {
    const r = this.canvas.get(id) as TLShape | undefined
    return r ? { id, x: r.x, y: r.y, w: (r.props as Box).w, h: (r.props as Box).h } : null
  }

  /** The first place, row by row, where a box this size touches no section. */
  private freeSpot(w: number, h: number): { x: number; y: number } {
    const taken: Box[] = this.sections().map(r => this.sectionBox(r.id)!)
    const hit = (x: number, y: number) =>
      taken.find(o => x < o.x + o.w + SECTION_GAP && x + w + SECTION_GAP > o.x && y < o.y + o.h + SECTION_GAP && y + h + SECTION_GAP > o.y)
    let x = 0
    let y = 0
    for (let guard = 0; guard < 1000; guard++) {
      if (x > 0 && x + w > ROW_WIDTH) {
        // Next row: below everything in this one.
        const row = taken.filter(o => o.y < y + h + SECTION_GAP && o.y + o.h + SECTION_GAP > y)
        y = Math.max(y + h, ...row.map(o => o.y + o.h)) + SECTION_GAP
        x = 0
      }
      const blocker = hit(x, y)
      if (!blocker) break
      x = blocker.x + blocker.w + SECTION_GAP
    }
    return { x, y }
  }

  /** A position an older page saved. The world has already checked it (a card stays in its frame). */
  private async moveFromLayout(item: LayoutItem) {
    const saved = this.world.layout.get(item.id)
    if (!saved || saved.x !== item.x || saved.y !== item.y) return // refused by the world
    const id = item.kind === 'session' ? sessionShapeId(item.id) : item.kind === 'region' ? sectionShapeId(item.id) : noteShapeId(item.id)
    const shape = this.canvas.get(id) as TLShape | undefined
    if (!shape) return
    if (item.kind === 'session' && shape.parentId !== sectionShapeId(item.parent ?? '')) return
    // Notes in the log are placed on the page; one inside a section is placed in the section.
    const at = item.kind === 'note' ? this.toLocal(shape.parentId, item) : { x: item.x, y: item.y }
    // A React Flow page's width sets a note's scale (tldraw's notes are square); the log keeps its
    // exact size, which the room then agrees with (`sizeSeen`).
    const props = item.kind === 'note' && item.w ? { ...(shape.props as { scale: number; growY: number }), scale: noteScale(item.w) } : shape.props
    const meta = item.kind === 'note' ? { ...shape.meta, sizeSeen: noteSize(props as { scale: number; growY: number }) } : shape.meta
    const same = (a: number, b: number) => Math.abs(a - b) < 0.5
    if (same(shape.x, at.x) && same(shape.y, at.y) && JSON.stringify([props, meta]) === JSON.stringify([shape.props, shape.meta])) return
    this.canvas.write([{ ...shape, ...at, props, meta } as TLRecord])
    if (shape.parentId !== CANVAS_PAGE) await this.fit(shape.parentId)
    // Notes in a section move with it on the page; older pages learn where they are now.
    if (item.kind === 'region') {
      const sizes: Sizes = new Map()
      await this.recordLayout(await this.notesIn(id, sizes), sizes)
    }
  }

  /** Where the notes in a section are on the page now, for those the log has elsewhere. */
  private async notesIn(sectionId: string, sizes: Sizes): Promise<LayoutItem[]> {
    const items: LayoutItem[] = []
    for (const child of this.canvas.records()) {
      if (child.typeName !== 'shape' || child.parentId !== sectionId || child.type !== 'note') continue
      const item = await this.noteFromPage(child.id, child, sizes)
      if (item) items.push(item)
    }
    return items
  }

  /** A note as a tldraw note; `at` places a new one (an existing one stays where it is). */
  private putNote(n: Note, at: LayoutItem | undefined) {
    const id = noteShapeId(n.id)
    const shape = this.canvas.get(id) as TLShape | undefined
    const color = noteColorToTldraw(n.color)
    if (shape) {
      const current = shape.props as Record<string, unknown>
      // Its text as it is, formatting included, unless the words changed.
      const sameText = plainTextOf(current.richText as never) === n.text
      if (sameText && current.color === color) return
      this.canvas.write([{ ...shape, props: { ...current, color, ...(!sameText && { richText: richTextOf(n.text) }) } } as TLRecord])
      return
    }
    this.canvas.write([
      this.shape(
        id,
        'note',
        { color, richText: richTextOf(n.text), labelColor: 'black', size: 'm', font: 'sans', fontSizeAdjustment: 0, align: 'start', verticalAlign: 'start', growY: 0, url: '', scale: at?.w ? noteScale(at.w) : 1, textLastEditedBy: null },
        { x: at?.x ?? 0, y: at?.y ?? 0, meta: { author: n.author, sizeSeen: noteSize({ scale: at?.w ? noteScale(at.w) : 1, growY: 0 }) } },
      ),
    ])
  }

  // ---------- the room to events ----------

  /**
   * Pages changed these records: record what older pages and the world can follow, as
   * `layout.set` and `note.*` events. Called with the ids of a few commits at a time.
   */
  async fromPages(ids: Iterable<string>) {
    const items: LayoutItem[] = []
    const sizes: Sizes = new Map()
    const sections = new Set<string>()
    let notes = false
    for (const id of new Set(ids)) {
      const r = this.canvas.get(id) as TLShape | undefined
      if (id.startsWith('shape:session:')) {
        if (!r) continue
        const s = this.world.sessions.get((r.props as { sessionId: string }).sessionId)
        if (!s) continue
        const region = regionFor(s).id
        sections.add(r.parentId)
        const saved = this.world.layout.get(s.id)
        if (r.parentId === sectionShapeId(region) && (saved?.x !== Math.round(r.x) || saved?.y !== Math.round(r.y) || saved?.parent !== region))
          items.push({ id: s.id, kind: 'session', x: Math.round(r.x), y: Math.round(r.y), parent: region })
      } else if (isRegionSection(id)) {
        if (!r) continue
        const region = id.slice('shape:'.length)
        const saved = this.world.layout.get(region)
        if (saved?.x !== Math.round(r.x) || saved?.y !== Math.round(r.y)) items.push({ id: region, kind: 'region', x: Math.round(r.x), y: Math.round(r.y) })
        // Its notes moved on the page with it.
        items.push(...(await this.notesIn(id, sizes)))
      } else if (r?.type === 'note' || (!r && this.world.notes.has(noteIdOf(id)))) {
        notes = true
        const item = await this.noteFromPage(id, r, sizes)
        if (item) items.push(item)
      } else if (liveTypeOfId(id)) {
        // A live card isn't in the log, but one dropped into a section, or resized there, sizes it.
        notes = true
      }
    }
    // A note (or a live card) that grew, moved in or left changes its section's size; which
    // section it left isn't known here, so they're all fitted.
    for (const s of notes ? this.sections().map(s => s.id) : sections) await this.fit(s)
    // Fitting can push sections aside, and their notes with them, recording where they went:
    // what's recorded here is where everything is now, so it doesn't undo that.
    for (const item of items) {
      const r = (item.kind === 'region' ? this.canvas.get(sectionShapeId(item.id)) : item.kind === 'note' ? this.canvas.get(noteShapeId(item.id)) : undefined) as TLShape | undefined
      const at = r && (item.kind === 'note' ? this.onPage(r) : r)
      if (at) Object.assign(item, { x: Math.round(at.x), y: Math.round(at.y) })
    }
    await this.recordLayout(items, sizes)
  }

  /**
   * Records places and sizes for older pages, then marks the batch's notes' sizes as agreed
   * (`sizeSeen`). Only then: if recording fails, the sizes still count as changed, and the retry
   * records them. Each batch carries its own sizes, so a batch recorded inside another (a section
   * pushed aside while fitting) doesn't mark the outer batch's sizes before that's recorded.
   */
  private async recordLayout(items: LayoutItem[], sizes: Sizes) {
    if (items.length) await this.record({ topic: 'world', type: 'layout.set', actor: 'canvas', data: { items, source: 'canvas' } })
    for (const [id, sizeSeen] of sizes) {
      const r = this.canvas.get(id) as TLShape | undefined
      if (r) this.canvas.write([{ ...r, meta: { ...r.meta, sizeSeen } } as TLRecord])
    }
  }

  /** A note a page made, changed or removed. Returns its new place, if it moved. */
  private async noteFromPage(id: string, r: TLShape | undefined, sizes: Sizes): Promise<LayoutItem | null> {
    const noteId = noteIdOf(id)
    const known = this.world.notes.get(noteId)
    if (!r) {
      if (known) await this.record({ topic: 'world', type: 'note.deleted', actor: 'canvas', data: { id: noteId, source: 'canvas' } })
      return null
    }
    const props = r.props as { richText: never; color: string; scale: number; growY: number }
    const text = plainTextOf(props.richText).slice(0, NOTE_TEXT_LIMIT)
    const color: NoteColor = noteColorFromTldraw(props.color)
    // Notes in the log sit on the page; one inside a section is placed in the section.
    const page = this.onPage(r)
    const x = Math.round(page.x)
    const y = Math.round(page.y)
    // The log's size stands unless the note changed size here: resized, or grown or shrunk with its
    // text. `sizeSeen` is its size on the canvas when the log last agreed with it; a note from
    // before it was kept changes size only once it changes here.
    const saved = this.world.layout.get(noteId)
    const current = noteSize(props)
    const seen = r.meta.sizeSeen as { w: number; h: number } | undefined
    const changedHere = !known || !saved?.w || (!!seen && (seen.w !== current.w || seen.h !== current.h))
    const size = changedHere ? current : { w: saved!.w!, h: saved!.h ?? current.h }
    if (!seen || seen.w !== current.w || seen.h !== current.h) sizes.set(r.id, current)
    const author = typeof r.meta.author === 'string' ? r.meta.author : 'canvas'
    if (!known) {
      await this.record({ topic: 'world', type: 'note.created', actor: author, data: { id: noteId, text, color, x, y, ...size, source: 'canvas' } })
      return null
    }
    if (known.text !== text || known.color !== color)
      await this.record({ topic: 'world', type: 'note.updated', actor: author, data: { id: noteId, ...(known.text !== text && { text }), ...(known.color !== color && { color }), source: 'canvas' } })
    return saved?.x === x && saved?.y === y && saved.w === size.w && saved.h === size.h ? null : { id: noteId, kind: 'note', x, y, ...size }
  }

  // ---------- retiring ----------

  /** Whether a session's card can leave the canvas: ended, or not heard from, for a week. */
  retirable(s: SessionSummary, now = Date.now()): boolean {
    const quiet = now - Date.parse(s.lastSeenAt ?? s.startedAt)
    return quiet > RETIRE_MS && (s.state === 'ended' || !s.connected)
  }

  /** Removes the cards of sessions long gone, and the server's sections left without cards. */
  retire(now = Date.now()) {
    const shapes = this.canvas.records().filter((r): r is TLShape => r.typeName === 'shape')
    const cards = shapes.filter(r => r.type === 'session' && this.retirableId((r.props as { sessionId: string }).sessionId, now)).map(r => r.id)
    const gone = new Set<string>(cards)
    const empty = shapes.filter(r => isRegionSection(r.id) && !shapes.some(c => c.parentId === r.id && !gone.has(c.id))).map(r => r.id)
    if (!cards.length && !empty.length) return
    // Anything a page put inside a retiring card stays, on the page where it is.
    const leaving = new Set<string>([...cards, ...empty])
    const kept = shapes.filter(r => leaving.has(r.parentId as string) && !leaving.has(r.id))
    if (kept.length) this.canvas.write(kept.map(r => ({ ...r, ...this.onPage(r), parentId: CANVAS_PAGE }) as TLRecord))
    this.canvas.retire([...cards, ...empty])
  }

  private retirableId(sessionId: string, now: number) {
    const s = this.world.sessions.get(sessionId)
    return !s || this.retirable(s, now)
  }

  // ---------- records ----------

  /** Where a parent puts its children on the page: its corner and its turn, through its own parents. */
  private frameOf(parentId: string, depth = 0): { x: number; y: number; rotation: number } {
    const p = this.canvas.get(parentId) as TLShape | undefined
    if (p?.typeName !== 'shape' || depth > 50) return { x: 0, y: 0, rotation: 0 }
    const outer = this.frameOf(p.parentId, depth + 1)
    return { ...this.place(outer, p.x, p.y), rotation: outer.rotation + p.rotation }
  }

  private place(f: { x: number; y: number; rotation: number }, x: number, y: number) {
    const [cos, sin] = [Math.cos(f.rotation), Math.sin(f.rotation)]
    return { x: f.x + x * cos - y * sin, y: f.y + x * sin + y * cos }
  }

  /** A shape's place on the page. */
  private onPage(shape: TLShape): { x: number; y: number } {
    return this.place(this.frameOf(shape.parentId), shape.x, shape.y)
  }

  /** A place on the page, in a parent's own coordinates. */
  private toLocal(parentId: string, page: { x: number; y: number }): { x: number; y: number } {
    const f = this.frameOf(parentId)
    const [dx, dy] = [page.x - f.x, page.y - f.y]
    const [cos, sin] = [Math.cos(-f.rotation), Math.sin(-f.rotation)]
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos }
  }

  private sizeOf(shape: TLShape): { w: number; h: number } {
    if (shape.type === 'note') return noteSize(shape.props as { scale: number; growY: number })
    const p = shape.props as { w?: number; h?: number }
    return { w: p.w ?? 0, h: p.h ?? 0 }
  }

  private shape(id: string, type: string, props: Record<string, unknown>, at: { x: number; y: number; parentId?: string; meta?: Record<string, unknown> }): TLRecord {
    return {
      id,
      typeName: 'shape',
      type,
      x: at.x,
      y: at.y,
      rotation: 0,
      index: this.nextIndex(),
      parentId: at.parentId ?? CANVAS_PAGE,
      isLocked: false,
      opacity: 1,
      props,
      meta: at.meta ?? {},
    } as unknown as TLRecord
  }

  /** Above every shape: new shapes go on top. */
  private nextIndex(): IndexKey {
    let top: IndexKey | null = null
    for (const r of this.canvas.records()) if (r.typeName === 'shape' && (!top || r.index > top)) top = r.index
    return getIndexAbove(top)
  }
}
