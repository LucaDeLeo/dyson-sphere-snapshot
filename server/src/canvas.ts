// The canvas document: one tldraw sync room in this process, kept in memory and saved to
// Postgres as a snapshot about once a second. Pages edit it over `/canvas`; the server's own
// writes (slots, the CLI, agents) go through `write`, which validates them first, because the
// room's storage takes whatever it's given.
//
// Live cards (terminals; `LIVE_TYPES` in shared/canvas.ts) are kept from pages too old to read
// them, and saved in a row of their own (`<room>:live`), which servers from before them never load.
import { InMemorySyncStorage, TLSocketRoom, type RoomSnapshot, type TLRecordAuthorizer, type WebSocketMinimal } from '@tldraw/sync-core'
import { DocumentRecordType, PageRecordType, TLDOCUMENT_ID, type TLDocument, type TLPage, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { getIndexAbove } from '@tldraw/utils'
import {
  CANVAS_PAGE,
  canvasSchema,
  isRegionSection,
  LIVE_TYPES,
  liveTypeOfId,
  NOTE_TEXT_LIMIT,
  plainTextOf,
  SESSION_ID,
  sessionShapeId,
  shapeSequenceId,
  type LiveType,
  type SessionShape,
} from '../../shared/canvas'

/** Who a page's connection is signed in as. */
export type CanvasMeta = { identity: string }

/**
 * Where snapshots are kept: Postgres in the server, memory in tests. `logSeq` is the last event in
 * the log the room had followed when the snapshot was taken (null: none yet), so a restart can
 * replay what came after.
 */
export type Saved = { snapshot: RoomSnapshot; logSeq: number | null }
export type Snapshots = {
  load(room: string): Promise<Saved | null>
  save(room: string, saved: Saved): Promise<void>
}

export class CanvasWriteError extends Error {}

export type CanvasOptions = {
  /** How long after a change the room is saved. */
  saveMs?: number
  /**
   * The section a session's card belongs in (the shape id of its region's section), or null if
   * the server doesn't know the session. The server's own writes must keep a card there.
   */
  sectionOf?: (sessionId: string) => string | null
  /** Pages changed these records (ids), in one commit. Not called for the server's own writes. */
  onPagesChanged?: (ids: string[]) => void
  /** Pages removed these live cards, as they were. */
  onLiveRemoved?: (shapes: TLShape[]) => void
}

/** The row a room's live cards are saved in, beside the room's own. */
export const liveRoomId = (room: string) => `${room}:live`

/** The largest a live card can be, either way: a page that asks for more is refused. */
const LIVE_MAX_SIZE = 8000

const SAVE_MS = 1000
/** A room whose only change is the events it has followed is saved at most this often. */
const SEQ_SAVE_MS = 60_000

/** When a snapshot's document last changed. */
const clockOf = (s: RoomSnapshot) => s.documentClock ?? s.clock ?? 0

export class Canvas {
  readonly room: TLSocketRoom<TLRecord, CanvasMeta>
  private readonly storage: InMemorySyncStorage<TLRecord>
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt = Infinity
  private saving: Promise<void> = Promise.resolve()
  private savedClock: number
  /** The last event in the log the room has followed, and the one in the last snapshot. */
  logSeq: number | null
  private savedSeq: number | null
  private closing = false
  private readonly saveMs: number
  private readonly sectionOf: (sessionId: string) => string | null

  private constructor(
    readonly id: string,
    private readonly snapshots: Snapshots,
    saved: Saved | null,
    opts: CanvasOptions,
  ) {
    const snapshot = saved?.snapshot ?? null
    this.logSeq = this.savedSeq = saved?.logSeq ?? null
    this.saveMs = opts.saveMs ?? SAVE_MS
    this.sectionOf = opts.sectionOf ?? (() => null)
    this.storage = new InMemorySyncStorage<TLRecord>(snapshot ? { snapshot } : {})
    this.savedClock = snapshot ? clockOf(snapshot) : -1
    this.room = new TLSocketRoom<TLRecord, CanvasMeta>({
      schema: canvasSchema,
      storage: this.storage,
      log: { warn: (...a: unknown[]) => console.warn('canvas:', ...a), error: (...a: unknown[]) => console.error('canvas:', ...a) },
      authorizeRecord: {
        shape: a => {
          const allowed = authorizeLive(a) ? authorizeShape(a) : null
          // What a page removes, as it was: its children may outlive it (adoptOrphans).
          if (a.type === 'delete' && allowed) this.removedByPages.set(a.prev.id, a.prev)
          return allowed
        },
        page: serverOnly<TLPage>(),
        document: serverOnly<TLDocument>(),
        // Arrows aren't bound to live cards: a page that can't see the card would drop the binding.
        binding: a => (a.next && (liveTypeOfId(a.next.fromId) || liveTypeOfId(a.next.toId)) ? null : (a.next ?? a.prev)),
      },
      // A page's write can leave a shape without its parent (a frame deleted without its children,
      // a note moved into a shape that's gone): tldraw checks each record, not the whole document.
      onCommittedChanges: ({ diff }) => {
        const removedLive = [...this.removedByPages.values()].filter(r => liveTypeOfId(r.id) && diff.deletes.includes(r.id))
        const adopted = this.adoptOrphans()
        opts.onPagesChanged?.([...Object.keys(diff.puts), ...diff.deletes, ...adopted])
        if (removedLive.length) opts.onLiveRemoved?.(removedLive)
      },
    })
    this.storage.onChange(() => this.schedule(this.saveMs))
    // The room makes the document and a page when it starts empty; this is for a snapshot
    // without them. The server's own writes need that page as a parent.
    this.storage.transaction(txn => {
      if (!txn.get(TLDOCUMENT_ID)) txn.set(TLDOCUMENT_ID, DocumentRecordType.create({ id: TLDOCUMENT_ID }))
      if (!txn.get(CANVAS_PAGE)) txn.set(CANVAS_PAGE, PageRecordType.create({ id: CANVAS_PAGE, name: 'Page 1', index: getIndexAbove() }))
    })
  }

  static async open(id: string, snapshots: Snapshots, opts: CanvasOptions = {}): Promise<Canvas> {
    const [main, live] = await Promise.all([snapshots.load(id), snapshots.load(liveRoomId(id))])
    // The live row is saved first: a first save cut short leaves it without the room's own.
    const saved = main ? { ...main, snapshot: withLive(main.snapshot, live?.snapshot ?? null) } : live?.snapshot.documents.length ? { snapshot: withLive({ documents: [] }, live.snapshot), logSeq: null } : null
    const canvas = new Canvas(id, snapshots, saved, opts)
    canvas.savedLive = liveKey(splitLive(canvas.storage.getSnapshot()).live)
    // A live card whose parent went while it was saved apart (a section a server from before
    // live cards removed) goes on the page.
    canvas.adoptOrphans()
    return canvas
  }

  /** The live card types each page's schema doesn't have, by its session in the room. */
  private readonly unknownLive = new Map<string, Set<LiveType>>()

  /**
   * A page's connection. The room's session id is ours, not the page's, so no page can take over
   * another's session. Null once the room is closing: the page reconnects to the next server.
   */
  connect(socket: WebSocketMinimal, meta: CanvasMeta): string | null {
    if (this.closing) {
      socket.close(1012, 'restarting')
      return null
    }
    const sessionId = crypto.randomUUID()
    // What the room sends a page from before a live card type leaves those cards out.
    const unknownLive = this.unknownLive
    const filtered: WebSocketMinimal = {
      send: data => {
        const hidden = unknownLive.get(sessionId)
        socket.send(hidden ? withoutLive(data, hidden) : data)
      },
      close: (code, reason) => socket.close(code, reason),
      get readyState() {
        return socket.readyState
      },
    }
    this.room.handleSocketConnect({ sessionId, socket: filtered, meta })
    return sessionId
  }

  message(sessionId: string, data: string | Buffer) {
    const text = typeof data === 'string' ? data : data.toString('utf8')
    // A page names its schema when it connects, before anything is sent to it.
    if (text.startsWith('{"type":"connect"')) this.noteSchema(sessionId, text)
    this.room.handleSocketMessage(sessionId, text)
  }

  close(sessionId: string) {
    this.unknownLive.delete(sessionId)
    this.room.handleSocketClose(sessionId)
  }

  /** The live card types a page's schema doesn't name are kept from it. */
  private noteSchema(sessionId: string, text: string) {
    let msg: { type?: string; schema?: { sequences?: Record<string, number> } }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg?.type !== 'connect') return
    const sequences = msg.schema?.sequences ?? {}
    const unknown = new Set(LIVE_TYPES.filter(t => sequences[shapeSequenceId(t)] === undefined))
    if (unknown.size) this.unknownLive.set(sessionId, unknown)
    else this.unknownLive.delete(sessionId)
  }

  /** The room has followed the log up to this event. Saved with the next snapshot, within a minute. */
  followed(seq: number) {
    if (this.logSeq !== null && seq <= this.logSeq) return
    this.logSeq = seq
    this.schedule(SEQ_SAVE_MS)
  }

  /** Ids of records removed from the room, as long as it remembers (tldraw prunes old ones). */
  removed(): Set<string> {
    return new Set(Object.keys(this.storage.getSnapshot().tombstones ?? {}))
  }

  get(id: string): TLRecord | undefined {
    return this.storage.transaction(txn => txn.get(id)).result
  }

  records(): TLRecord[] {
    return this.storage.transaction(txn => [...txn.values()]).result
  }

  /**
   * The server's own changes, all or nothing: every record is checked against the schema, and
   * each shape's parent must exist once the change is made. Session cards follow the same rules
   * as for pages: never removed, and always in their session's section. Connected pages get the
   * change at once. Throws `CanvasWriteError` and changes nothing if any of it is invalid.
   */
  write(put: TLRecord[], remove: string[] = []) {
    this.change(put, remove, false)
  }

  /**
   * Removes the cards of sessions nobody will look at again (ended or unseen for days), and
   * sections left empty: the one way a session card leaves the canvas, so the page doesn't fill
   * up with every session there ever was.
   */
  retire(ids: string[]) {
    this.change([], ids, true)
  }

  private change(put: TLRecord[], remove: string[], retiring: boolean) {
    const checked = put.map(r => {
      const type = canvasSchema.types[r?.typeName as keyof typeof canvasSchema.types]
      if (!type || type.scope !== 'document') throw new CanvasWriteError(`not a document record: ${r?.typeName}`)
      let valid: TLRecord
      try {
        valid = type.validate(r) as TLRecord
      } catch (e) {
        throw new CanvasWriteError(`invalid ${r.typeName} ${r.id}: ${(e as Error).message}`)
      }
      if (valid.typeName === 'shape' && valid.type === 'session') {
        const { sessionId } = (valid as SessionShape).props
        if (valid.id !== sessionShapeId(sessionId)) throw new CanvasWriteError(`session card ${valid.id} must be ${sessionShapeId(sessionId)}`)
        const section = this.sectionOf(sessionId)
        if (section && valid.parentId !== section) throw new CanvasWriteError(`session card ${valid.id} belongs in ${section}, not ${valid.parentId}`)
      } else if (valid.id.startsWith('shape:session:')) throw new CanvasWriteError(`${valid.id} is kept for a session card`)
      if (valid.typeName === 'shape' && !liveIdMatches(valid as TLShape)) throw new CanvasWriteError(`${valid.id} can't be a ${valid.type}: a live card's id names its type`)
      return valid
    })
    this.storage.transaction(txn => {
      for (const id of remove) {
        const r = txn.get(id)
        if (r?.typeName === 'shape' && r.type === 'session' && !retiring) throw new CanvasWriteError(`session cards are never removed: ${id}`)
      }
      // A shape keeps its type, as for pages: replacing a card with a note would remove the card.
      for (const r of checked) {
        const before = txn.get(r.id)
        if (before?.typeName === 'shape' && r.typeName === 'shape' && before.type !== r.type) throw new CanvasWriteError(`${r.id} is a ${before.type}, not a ${r.type}`)
      }
      const gone = new Set(remove)
      const after = new Map<string, TLRecord>()
      for (const [id, r] of txn.entries()) if (!gone.has(id)) after.set(id, r)
      for (const r of checked) after.set(r.id, r)
      for (const r of after.values()) {
        if (r.typeName !== 'shape') continue
        const parent = after.get((r as TLShape).parentId)
        if (!parent || (parent.typeName !== 'page' && parent.typeName !== 'shape'))
          throw new CanvasWriteError(`shape ${r.id} has no parent ${(r as TLShape).parentId}`)
      }
      for (const id of remove) txn.delete(id)
      for (const r of checked) txn.set(r.id, r)
    })
  }

  /**
   * For shutdown: closes every page's connection and refuses new ones, so nothing changes after
   * the last snapshot, then saves what changed, trying again until `withinMs` has passed.
   * Pages reconnect to the next server and keep what they had.
   */
  async shutdown(withinMs: number, beforeSave: () => Promise<void> = async () => {}) {
    this.closing = true
    this.dispose()
    // What pages changed just before is recorded in the log too, before the last snapshot.
    await beforeSave()
    await this.flush(withinMs)
  }

  /** Closes every page's connection and stops the room's timers. */
  dispose() {
    this.clearTimer()
    this.room.close()
  }

  /** Shapes pages removed in the commit being handled, as they were. */
  private readonly removedByPages = new Map<string, TLShape>()

  /**
   * Puts every shape whose parent is gone on the page, where it was on the page: its position and
   * rotation through the parents it had, removed ones included. Returns their ids.
   */
  private adoptOrphans(): string[] {
    const records = this.records()
    const byId = new Map(records.map(r => [r.id as string, r]))
    const orphans = records.filter((r): r is TLShape => r.typeName === 'shape' && !byId.has(r.parentId))
    const onPage = (shape: TLShape, depth = 0): { x: number; y: number; rotation: number } => {
      const parent = (byId.get(shape.parentId) ?? this.removedByPages.get(shape.parentId)) as TLRecord | undefined
      if (!parent || parent.typeName !== 'shape' || depth > 50) return { x: shape.x, y: shape.y, rotation: shape.rotation }
      const p = onPage(parent as TLShape, depth + 1)
      const [cos, sin] = [Math.cos(p.rotation), Math.sin(p.rotation)]
      return { x: p.x + shape.x * cos - shape.y * sin, y: p.y + shape.x * sin + shape.y * cos, rotation: p.rotation + shape.rotation }
    }
    const adopted = orphans.map(r => ({ ...r, ...onPage(r), parentId: CANVAS_PAGE }) as TLRecord)
    this.removedByPages.clear()
    if (adopted.length) this.write(adopted)
    return adopted.map(r => r.id)
  }

  /** Saves now if anything changed since the last save, trying again until `withinMs` has passed. */
  async flush(withinMs = 0) {
    this.clearTimer()
    const end = Date.now() + withinMs
    while (!(await this.save()) && Date.now() < end) await Bun.sleep(200)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dueAt = Infinity
  }

  /** A save within `ms`, unless one is already due sooner. */
  private schedule(ms: number) {
    if (this.closing || Date.now() + ms >= this.dueAt) return
    this.clearTimer()
    this.dueAt = Date.now() + ms
    this.timer = setTimeout(() => {
      this.timer = null
      this.dueAt = Infinity
      // A failed save is tried again a second later; the room keeps working meanwhile.
      void this.save().then(saved => saved || this.schedule(this.saveMs))
    }, ms)
  }

  /** The live cards as last saved, to save their row only when they change. */
  private savedLive = ''

  /** One save at a time. True when everything is saved. */
  private save(): Promise<boolean> {
    const next = this.saving.then(async () => {
      const snapshot = this.storage.getSnapshot()
      const clock = clockOf(snapshot)
      const logSeq = this.logSeq
      if (clock === this.savedClock && logSeq === this.savedSeq) return true
      try {
        // Live cards in a row of their own, saved first: the room's row never holds one, so a
        // server from before them, which reads only that row, never loads one.
        const { main, live } = splitLive(snapshot)
        const key = liveKey(live)
        if (key !== this.savedLive) {
          await this.snapshots.save(liveRoomId(this.id), { snapshot: live, logSeq: null })
          this.savedLive = key
        }
        await this.snapshots.save(this.id, { snapshot: main, logSeq })
        this.savedClock = clock
        this.savedSeq = logSeq
        return true
      } catch (e) {
        console.warn(`canvas: couldn't save room ${this.id} (${(e as Error).message})`)
        return false
      }
    })
    this.saving = next.then(() => {})
    return next
  }
}

// ---------- live cards ----------

/** A shape's id and type agree about live cards: `shape:terminal:…` is a terminal, and a terminal has such an id. */
function liveIdMatches(shape: TLShape): boolean {
  const byId = liveTypeOfId(shape.id)
  return byId ? byId === shape.type : !(LIVE_TYPES as readonly string[]).includes(shape.type)
}

/**
 * What a page may do with live cards, beyond what it may do with any shape: a card's id names its
 * type, it keeps the session it shows, and it can't be made absurdly big. Anyone may add, move,
 * resize or remove one: it shows a session, it isn't the session.
 */
const authorizeLive: TLRecordAuthorizer<TLShape, CanvasMeta> = a => {
  if (a.type === 'delete') return a.prev
  const next = a.next
  if (!liveIdMatches(next)) return null
  // The rest is for live cards only: any other shape is as big as it likes.
  if (!liveTypeOfId(next.id)) return next
  const props = next.props as { w: number; h: number; sessionId: string; targetId?: string }
  if (!SESSION_ID.test(props.sessionId) || props.w > LIVE_MAX_SIZE || props.h > LIVE_MAX_SIZE) return null
  if (a.type === 'update' && (a.prev.props as { sessionId: string }).sessionId !== props.sessionId) return null
  if (next.type === 'browser') {
    // Only the server makes a browser card, with the tab it opened for the session (`browser.open`);
    // the card keeps that tab.
    if (a.type === 'create' || (a.prev.props as { targetId: string }).targetId !== props.targetId) return null
  }
  return next
}

/** A snapshot's live cards, and the rest: what goes in each row. */
export function splitLive(snapshot: RoomSnapshot): { main: RoomSnapshot; live: RoomSnapshot } {
  const isLive = (id: string) => liveTypeOfId(id) !== null
  const tombstones = Object.entries(snapshot.tombstones ?? {})
  return {
    main: {
      ...snapshot,
      documents: snapshot.documents.filter(d => !isLive(d.state.id)),
      tombstones: Object.fromEntries(tombstones.filter(([id]) => !isLive(id))),
    },
    live: {
      clock: snapshot.clock,
      documentClock: snapshot.documentClock,
      documents: snapshot.documents.filter(d => isLive(d.state.id)),
      tombstones: Object.fromEntries(tombstones.filter(([id]) => isLive(id))),
      schema: snapshot.schema,
    },
  }
}

/** What the live row holds, to tell whether it changed: its records and removals, not its clocks. */
const liveKey = (live: RoomSnapshot) => JSON.stringify([live.documents, live.tombstones])

/**
 * The room's row with its live cards put back. The room's row may have been saved since by a
 * server from before live cards, whose schema doesn't name their types: the live row's versions
 * of those types stand, so their records aren't migrated as if they were older.
 */
export function withLive(main: RoomSnapshot, live: RoomSnapshot | null): RoomSnapshot {
  if (!live || (!live.documents.length && !Object.keys(live.tombstones ?? {}).length)) return main
  const schema = main.schema ? structuredClone(main.schema) : live.schema
  if (schema && 'sequences' in schema && live.schema && 'sequences' in live.schema)
    for (const type of LIVE_TYPES) {
      const v = live.schema.sequences[shapeSequenceId(type)]
      if (v !== undefined) schema.sequences[shapeSequenceId(type)] = v
    }
  const ids = new Set(main.documents.map(d => d.state.id))
  return {
    ...main,
    clock: Math.max(main.clock ?? 0, live.clock ?? 0),
    documentClock: Math.max(clockOf(main), clockOf(live)),
    documents: [...main.documents, ...live.documents.filter(d => !ids.has(d.state.id))],
    tombstones: { ...live.tombstones, ...main.tombstones },
    schema,
  }
}

/**
 * A message for a page that doesn't know these live card types, without them. What the room sends
 * of the document is changes by record id (in `connect`, `patch`, and a push's rebase), and a live
 * card's id names its type.
 */
export function withoutLive(data: string, hidden: Set<LiveType>): string {
  let msg: unknown
  try {
    msg = JSON.parse(data)
  } catch {
    return data
  }
  const strip = (diff: unknown) => {
    if (!diff || typeof diff !== 'object') return
    for (const id of Object.keys(diff)) {
      const type = liveTypeOfId(id)
      if (type && hidden.has(type)) delete (diff as Record<string, unknown>)[id]
    }
  }
  const event = (e: any) => {
    if (!e || typeof e !== 'object') return
    if (e.type === 'connect' || e.type === 'patch') strip(e.diff)
    else if (e.type === 'push_result' && e.action && typeof e.action === 'object') strip(e.action.rebaseWithDiff)
    else if (e.type === 'data' && Array.isArray(e.data)) e.data.forEach(event)
  }
  if (Array.isArray(msg)) msg.forEach(event)
  else event(msg)
  return JSON.stringify(msg)
}

/** The document and its page: a page can rename them, never add or remove one. */
const serverOnly = <R extends TLDocument | TLPage>(): TLRecordAuthorizer<R, CanvasMeta> => a => (a.type === 'update' ? a.next : null)

/**
 * What a page may do to shapes. The server owns session cards and the repo and ticket sections:
 * a page can move them, never create or delete them, and a card stays in its section (and keeps
 * its session). Any shape a page makes is stamped with who made it.
 */
const authorizeShape: TLRecordAuthorizer<TLShape, CanvasMeta> = a => {
  const shape = a.next ?? a.prev
  // Ids a session card or a server section would have count too: a note there would block the card.
  const owned = shape.type === 'session' || shape.id.startsWith('shape:session:') || isRegionSection(shape.id)
  if (a.type === 'delete') return owned ? null : a.prev
  // A note holds what the log can hold, so a rebuild from the log loses none of it.
  if (a.next?.type === 'note' && plainTextOf((a.next.props as unknown as { richText: never }).richText).length > NOTE_TEXT_LIMIT) return null
  if (a.type === 'create') return owned ? null : { ...a.next, meta: { ...a.next.meta, author: a.session.meta.identity } }
  const { prev, next } = a
  if (next.meta.author !== prev.meta.author || next.type !== prev.type) return null
  if (prev.type === 'session' && (next.parentId !== prev.parentId || (next.props as { sessionId: string }).sessionId !== (prev.props as { sessionId: string }).sessionId)) return null
  if (isRegionSection(prev.id) && (next.parentId !== prev.parentId || (next.props as { title: string }).title !== (prev.props as { title: string }).title)) return null
  return next
}
