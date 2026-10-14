// Terminal cards' relay: pages watching a session's terminal on one side, the session's bridge on
// the other (shared/terminal.ts). One stream per session, however many cards and pages show it.
//
// - Who may do what is decided here, for every message: anyone signed in may watch, only the
//   session's owner may type or resize. Nobody gets a shell: a terminal is the session's own tmux
//   pane, reached through its owner's bridge.
// - The bridge attaches to the pane while anyone watches, and detaches `graceMs` after the last
//   viewer leaves (a card removed, a page closed), so a page reloading doesn't restart it.
// - A viewer that falls behind (its socket's buffer over `highWater`) misses output rather than
//   queueing it; once it catches up it gets the whole screen again. So does one that comes back
//   on screen after `pause`, or reconnects. Output is never queued without bound.
import { mayType, TERM, validSize, type TermFromBridge, type TermFromViewer, type TermStatus, type TermToBridge, type TermToViewer } from '../../shared/terminal'

/** A page's terminal socket, as the relay sees it. */
export type Viewer = {
  readonly identity: string
  send(message: string): void
  /** Bytes the socket hasn't sent yet. */
  buffered(): number
}

/** Whether a session's terminal can be shown now, and whose it is. Null: no such session. */
export type TermCheck = { owner: string; status: Exclude<TermStatus, 'connecting'>; reason?: string } | null

export type TerminalsOptions = {
  check(sessionId: string): TermCheck
  /** Sends to the session's bridge. False when no bridge that relays terminals is attached. */
  toBridge(sessionId: string, m: TermToBridge): boolean
  /** How long a stream outlives its last viewer. */
  graceMs?: number
  /** A viewer with this much unsent is behind: it gets no more output until it catches up. */
  highWater?: number
  /** ...and has caught up once below this. */
  lowWater?: number
  /** The most viewers one session's terminal takes. */
  maxViewers?: number
}

/** `sync`: waiting for the whole screen. `live`: getting output. `paused`: off screen. `behind`: its socket is backed up. */
type Mode = 'sync' | 'live' | 'paused' | 'behind'
type Watching = { viewer: Viewer; canType: boolean; mode: Mode; refusedAt: number }

type Stream = {
  sessionId: string
  viewers: Map<Viewer, Watching>
  status: TermStatus
  reason: string | undefined
  /** The bridge was told to attach (and hasn't been told to detach, or gone). */
  opened: boolean
  /** A whole screen was asked of the bridge and hasn't come. */
  asked: boolean
  closing: ReturnType<typeof setTimeout> | null
}

const enc = (m: TermToViewer) => JSON.stringify(m)

export class Terminals {
  private readonly streams = new Map<string, Stream>()
  private readonly graceMs: number
  private readonly highWater: number
  private readonly lowWater: number
  private readonly maxViewers: number

  constructor(private readonly opts: TerminalsOptions) {
    this.graceMs = opts.graceMs ?? 15_000
    this.highWater = opts.highWater ?? 1024 * 1024
    this.lowWater = opts.lowWater ?? 256 * 1024
    this.maxViewers = opts.maxViewers ?? 32
  }

  /** A page opened a session's terminal. False, with the socket told why, if it can't. */
  join(sessionId: string, viewer: Viewer): boolean {
    const check = this.opts.check(sessionId)
    if (!check) {
      viewer.send(enc({ t: 'status', status: 'unavailable', reason: 'There is no such session.' }))
      return false
    }
    let s = this.streams.get(sessionId)
    if (!s) this.streams.set(sessionId, (s = { sessionId, viewers: new Map(), status: 'connecting', reason: undefined, opened: false, asked: false, closing: null }))
    if (s.viewers.size >= this.maxViewers) {
      viewer.send(enc({ t: 'status', status: 'unavailable', reason: `This terminal has ${this.maxViewers} viewers already.` }))
      if (!s.viewers.size) this.streams.delete(sessionId)
      return false
    }
    if (s.closing) clearTimeout(s.closing)
    s.closing = null
    const canType = mayType(check, viewer.identity)
    s.viewers.set(viewer, { viewer, canType, mode: 'sync', refusedAt: 0 })
    viewer.send(enc({ t: 'hello', owner: check.owner, canType }))
    // Its status: as everyone's changes now, or as it stands.
    const before = `${s.status}:${s.reason}`
    this.refresh(sessionId)
    if (`${s.status}:${s.reason}` === before) viewer.send(enc({ t: 'status', status: s.status, ...(s.reason && { reason: s.reason }) }))
    return true
  }

  /** A page's terminal socket closed. */
  leave(sessionId: string, viewer: Viewer) {
    const s = this.streams.get(sessionId)
    if (!s?.viewers.delete(viewer) || s.viewers.size) return
    // The last one: detach a little later, unless someone comes back.
    s.closing = setTimeout(() => {
      if (s.viewers.size || this.streams.get(sessionId) !== s) return
      if (s.opened) this.opts.toBridge(sessionId, { op: 'close' })
      this.streams.delete(sessionId)
    }, this.graceMs)
  }

  /**
   * Whether the session's terminal can be shown may have changed (its bridge came or went, it
   * ended): attach, or tell its viewers why not.
   */
  refresh(sessionId: string) {
    const s = this.streams.get(sessionId)
    if (!s) return
    const check = this.opts.check(sessionId)
    if (!s.viewers.size) {
      // Nobody watching, waiting to detach: a bridge that went has detached already, so a viewer
      // who comes back has it attach again.
      if (!check || check.status !== 'live') s.opened = s.asked = false
      return
    }
    if (!check || check.status !== 'live') {
      // A bridge that stays (a session ended by /clear goes on as another) detaches.
      if (s.opened) this.opts.toBridge(sessionId, { op: 'close' })
      s.opened = s.asked = false
      for (const w of s.viewers.values()) if (w.mode !== 'paused') w.mode = 'sync'
      return this.setStatus(s, check?.status ?? 'unavailable', check ? check.reason : 'There is no such session.')
    }
    if (!s.opened) {
      if (!this.opts.toBridge(sessionId, { op: 'open' })) return this.setStatus(s, 'offline')
      s.opened = s.asked = true
      if (s.status !== 'live') this.setStatus(s, 'connecting')
      return
    }
    this.askIfNeeded(s)
  }

  /** What a page's card sent. */
  fromViewer(sessionId: string, viewer: Viewer, raw: string) {
    const s = this.streams.get(sessionId)
    const w = s?.viewers.get(viewer)
    if (!s || !w || raw.length > TERM.inputLimit * 2) return
    let m: TermFromViewer
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    switch (m?.t) {
      case 'in':
      case 'fit': {
        // The owner's only, checked against the session as it is now (owners don't change, but
        // a session that is gone has none).
        const check = this.opts.check(sessionId)
        if (!w.canType || !check || !mayType(check, viewer.identity)) return this.refuse(w, `Only ${check?.owner ?? 'the session’s owner'} can type here.`)
        if (s.status !== 'live') return
        if (m.t === 'in') {
          if (typeof m.d !== 'string' || !m.d.length || m.d.length > TERM.inputLimit) return
          // Bytes are characters up to 0xff; anything else isn't what xterm sends as binary.
          if (m.binary === true && /[^\x00-\xff]/.test(m.d)) return
          this.opts.toBridge(sessionId, { op: 'in', d: m.d, ...(m.binary === true && { binary: true }), ...(m.paste === true && { paste: true }) })
        } else if (validSize(m.cols, m.rows)) this.opts.toBridge(sessionId, { op: 'fit', cols: m.cols, rows: m.rows })
        return
      }
      case 'pause':
        w.mode = 'paused'
        return
      case 'resume':
        if (w.mode !== 'paused') return
        w.mode = 'sync'
        return this.askIfNeeded(s)
    }
  }

  /** What the session's bridge sent. */
  fromBridge(sessionId: string, m: TermFromBridge) {
    const s = this.streams.get(sessionId)
    if (!s) {
      // Nobody watches (any more): the bridge needn't stay attached.
      if (m.op !== 'closed') this.opts.toBridge(sessionId, { op: 'close' })
      return
    }
    if (!s.opened) return // from before it was last told to stop
    if (m.op === 'state') {
      s.asked = false
      if (s.status !== 'live') this.setStatus(s, 'live')
      const msg = enc({ t: 'state', cols: m.cols, rows: m.rows, d: m.d })
      // The whole screen, to everyone getting output: it's how a resize, and a bridge that fell
      // behind, start over.
      for (const w of s.viewers.values()) {
        if (w.mode === 'paused') continue
        if (w.viewer.buffered() > this.highWater) w.mode = 'behind'
        else w.viewer.send(msg), (w.mode = 'live')
      }
      return
    }
    if (m.op === 'out') {
      const msg = enc({ t: 'out', d: m.d })
      for (const w of s.viewers.values()) {
        if (w.mode === 'behind' && w.viewer.buffered() < this.lowWater) this.caughtUp(s, w)
        if (w.mode !== 'live') continue
        // Behind: it misses this and what follows, and gets the whole screen once it has caught up.
        if (w.viewer.buffered() > this.highWater) w.mode = 'behind'
        else w.viewer.send(msg)
      }
      return
    }
    if (m.op === 'closed') {
      s.opened = s.asked = false
      for (const w of s.viewers.values()) if (w.mode !== 'paused') w.mode = 'sync'
      this.setStatus(s, 'unavailable', m.reason)
    }
  }

  /** A viewer's socket sent what it had queued. */
  drained(sessionId: string, viewer: Viewer) {
    const s = this.streams.get(sessionId)
    const w = s?.viewers.get(viewer)
    if (s && w?.mode === 'behind' && viewer.buffered() < this.lowWater) this.caughtUp(s, w)
  }

  /** For tests and the server's own checks. */
  stream(sessionId: string) {
    const s = this.streams.get(sessionId)
    return s && { status: s.status, opened: s.opened, viewers: [...s.viewers.values()].map(w => ({ identity: w.viewer.identity, canType: w.canType, mode: w.mode })) }
  }

  /** Stops every pending detach; for shutdown and tests. */
  dispose() {
    for (const s of this.streams.values()) if (s.closing) clearTimeout(s.closing)
    this.streams.clear()
  }

  private caughtUp(s: Stream, w: Watching) {
    w.mode = 'sync'
    this.askIfNeeded(s)
  }

  /** Asks the bridge for the whole screen, once, if a viewer waits for it. */
  private askIfNeeded(s: Stream) {
    if (!s.opened || s.asked || ![...s.viewers.values()].some(w => w.mode === 'sync')) return
    if (this.opts.toBridge(s.sessionId, { op: 'snapshot' })) s.asked = true
  }

  private setStatus(s: Stream, status: TermStatus, reason?: string) {
    if (s.status === status && s.reason === reason) return
    s.status = status
    s.reason = reason
    const msg = enc({ t: 'status', status, ...(reason && { reason }) })
    for (const w of s.viewers.values()) w.viewer.send(msg)
  }

  /** Tells a viewer its keys went nowhere, at most once every few seconds. */
  private refuse(w: Watching, reason: string) {
    const now = Date.now()
    if (now - w.refusedAt < 5000) return
    w.refusedAt = now
    w.viewer.send(enc({ t: 'refused', reason }))
  }
}
