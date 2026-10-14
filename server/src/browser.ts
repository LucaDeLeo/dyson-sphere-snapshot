// Browser cards' relay (shared/browser.ts): the server's Chrome on one side, over CDP on loopback;
// pages watching its tabs on the other. One stream per tab, however many cards and pages show it.
//
// - The Chrome is the one using SPHERE_BROWSER_PROFILE: its port comes from the profile's
//   DevToolsActivePort file, and is trusted only when the browser there names the same browser
//   target, so another program's debugging port is never used.
// - A tab is screencast only while some page's card wants frames (on screen, big enough, within
//   the page's budget of live cards), at most `maxFps` a second and no wider than the widest of
//   those cards. With none, the screencast stops; each card keeps its last frame. A card that has
//   none asks for a still.
// - Anyone signed in may watch; only the owner of the tab's session drives it (mouse, keys,
//   text, navigation), and only with the inputs listed in shared/browser.ts. Pages never see CDP.
// - A page whose socket is backed up misses frames (the next one replaces them) rather than queueing them.
import { BROWSER, encodeFrame, mayDrive, viewportOf, webUrl, type BrowserFromViewer, type BrowserStatus, type BrowserToViewer, type FrameHeader, type Viewport } from '../../shared/browser'

/** The few CDP calls the relay makes, over one tab's connection. */
export type Cdp = {
  readonly ready: Promise<void>
  send(method: string, params?: Record<string, unknown>): Promise<any>
  on(event: string, fn: (params: any) => void): void
  onClose(fn: () => void): void
  close(): void
}

/** The server's Chrome: its tabs, and a CDP connection to each. */
export type Chrome = {
  /** The browser's debugging port: its tabs are kept from it (`openable`). */
  debugPort(): Promise<number | null>
  open(url: string): Promise<string>
  close(targetId: string): Promise<void>
  /** The tabs open now, by target id. */
  tabs(): Promise<Map<string, { url: string; title: string }>>
  connect(targetId: string): Promise<Cdp>
}

/** A page's browser socket, as the relay sees it. */
export type BrowserViewer = {
  readonly identity: string
  send(text: string): void
  sendFrame(frame: Uint8Array): void
  buffered(): number
}

/** Whose session a tab was opened for. Null: not a tab Dyson Sphere opened. */
export type TabCheck = { owner: string; sessionId: string } | null

/** `css`, `dpr`: the card's own size and the viewer's pixel ratio (none from pages before crisp frames). */
type Watching = { viewer: BrowserViewer; canDrive: boolean; active: boolean; width: number; css: { w: number; h: number } | null; dpr: number; refusedAt: number }
type Stream = {
  targetId: string
  viewers: Map<BrowserViewer, Watching>
  cdp: Cdp | null
  connecting: Promise<Cdp | null> | null
  status: BrowserStatus
  reason: string | undefined
  casting: { width: number } | null
  /** The size and ratio the tab is laid out at, as this connection set it; null: Chrome's own. */
  viewport: Viewport | null
  /** A new layout waiting for the cards to stop changing size. */
  relayout: ReturnType<typeof setTimeout> | null
  /** The screencast and layout changes, one after another. */
  turns: Promise<void>
  /** The last frame, encoded: a card that joins, or isn't live, shows it. */
  last: Uint8Array | null
  page: { url: string; title: string }
  ackAt: number
  ackTimer: ReturnType<typeof setTimeout> | null
  closing: ReturnType<typeof setTimeout> | null
  /** The next try at reaching the tab, after the browser didn't answer. */
  retry: ReturnType<typeof setTimeout> | null
  /**
   * A tab Dyson Sphere opened: its connection stays while the tab does, watched or not, since it's
   * what keeps the tab from the browser's debugging port.
   */
  kept: boolean
}

const enc = (m: BrowserToViewer) => JSON.stringify(m)
const MOUSE = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'])
const BUTTONS = new Set(['none', 'left', 'middle', 'right'])
const KEYS = new Set(['keyDown', 'rawKeyDown', 'keyUp', 'char'])
/** Editing commands Chrome performs for ⌘ shortcuts on macOS only when told. */
const COMMANDS = new Set(['selectAll', 'copy', 'cut', 'paste', 'undo', 'redo'])
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const BACKED_UP = 1024 * 1024
/** How long cards' sizes must hold before the tab is laid out at them. */
const RELAYOUT_MS = 300
const sameViewport = (a: Viewport | null, b: Viewport | null) => !!a && !!b && a.width === b.width && a.height === b.height && a.deviceScaleFactor === b.deviceScaleFactor

export type BrowsersOptions = {
  chrome: Chrome | null
  check(targetId: string): TabCheck
  /** How long a tab's connection outlives its last viewer. */
  graceMs?: number
}

export class Browsers {
  private readonly streams = new Map<string, Stream>()
  private readonly graceMs: number

  constructor(private readonly opts: BrowsersOptions) {
    this.graceMs = opts.graceMs ?? 15_000
  }

  get available() {
    return !!this.opts.chrome
  }

  /** Opens a tab in the server's Chrome. Its card and its session are the caller's to record. */
  async open(url: string): Promise<string> {
    const chrome = this.opts.chrome
    if (!chrome) throw new Error('No browser is set up on this server.')
    // Blank first: the guard on the debugging port is in place before the page loads anything.
    const targetId = await chrome.open('about:blank')
    try {
      const cdp = await this.connect(this.keep(targetId))
      if (!cdp) throw new Error("the new tab couldn't be reached")
      if (url !== 'about:blank') {
        // A failed navigation (no such host, a bad certificate) answers with its error rather than failing.
        const r = (await cdp.send('Page.navigate', { url })) as { errorText?: string }
        if (r?.errorText) throw new Error(`${url} didn't load (${r.errorText})`)
      }
      return targetId
    } catch (e) {
      // A tab that can't be guarded and sent on belongs to nobody: it goes.
      await this.closeTab(targetId)
      throw e
    }
  }

  /** A tab Dyson Sphere opened (now, or before a restart): connected and guarded from now on. */
  keep(targetId: string): Stream {
    const s = this.streamOf(targetId)
    s.kept = true
    void this.connect(s)
    return s
  }

  private streamOf(targetId: string): Stream {
    let s = this.streams.get(targetId)
    if (!s)
      this.streams.set(
        targetId,
        (s = { targetId, viewers: new Map(), cdp: null, connecting: null, status: 'connecting', reason: undefined, casting: null, viewport: null, relayout: null, turns: Promise.resolve(), last: null, page: { url: '', title: '' }, ackAt: 0, ackTimer: null, closing: null, retry: null, kept: false }),
      )
    return s
  }

  /**
   * Whether a tab may be sent to this address (already http or https): anywhere but the browser's
   * own debugging port, which would let a page see and close tabs that aren't its.
   */
  async openable(url: string): Promise<boolean> {
    const port = await this.opts.chrome?.debugPort().catch(() => null)
    return !port || !debugAddress(url, port)
  }

  /** A page opened a tab's card. False, with the socket told why, if it can't. */
  join(targetId: string, viewer: BrowserViewer): boolean {
    const check = this.opts.check(targetId)
    if (!check || !this.opts.chrome) {
      viewer.send(enc({ t: 'status', status: 'unavailable', reason: !this.opts.chrome ? 'No browser is set up on this server.' : "This tab isn't one Dyson Sphere opened." }))
      return false
    }
    const s = this.streamOf(targetId)
    if (s.closing) clearTimeout(s.closing)
    s.closing = null
    const canDrive = mayDrive(check, viewer.identity)
    s.viewers.set(viewer, { viewer, canDrive, active: false, width: 0, css: null, dpr: 1, refusedAt: 0 })
    viewer.send(enc({ t: 'hello', owner: check.owner, canDrive }))
    viewer.send(enc({ t: 'status', status: s.status, ...(s.reason && { reason: s.reason }) }))
    if (s.page.url) viewer.send(enc({ t: 'page', ...s.page }))
    if (s.last) viewer.sendFrame(s.last)
    void this.connect(s)
    return true
  }

  leave(targetId: string, viewer: BrowserViewer) {
    const s = this.streams.get(targetId)
    if (!s?.viewers.delete(viewer)) return
    void this.update(s)
    if (s.viewers.size || s.kept) return
    s.closing = setTimeout(() => {
      if (s.viewers.size || this.streams.get(targetId) !== s) return
      this.drop(s)
    }, this.graceMs)
  }

  /** What a page's card sent. */
  async fromViewer(targetId: string, viewer: BrowserViewer, raw: string) {
    const s = this.streams.get(targetId)
    const w = s?.viewers.get(viewer)
    if (!s || !w || raw.length > BROWSER.textLimit * 2) return
    let m: BrowserFromViewer
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m?.t === 'active') {
      w.active = m.on === true
      w.width = Math.round(num(m.width))
      const css = m.css && typeof m.css === 'object' ? { w: num(m.css.w), h: num(m.css.h) } : null
      w.css = css && css.w > 0 && css.h > 0 ? css : null
      w.dpr = num(m.dpr, 1)
      return this.update(s)
    }
    if (m?.t === 'still') return this.still(s, w)
    // Everything else drives the tab: its session's owner's only, checked as things are now.
    const check = this.opts.check(targetId)
    if (!w.canDrive || !check || !mayDrive(check, viewer.identity)) return this.refuse(w, `Only ${check?.owner ?? 'the session’s owner'} can use this tab.`)
    const cdp = s.cdp
    if (!cdp) return
    try {
      switch (m?.t) {
        case 'mouse': {
          if (!MOUSE.has(m.type)) return
          await cdp.send('Input.dispatchMouseEvent', {
            type: m.type,
            x: num(m.x),
            y: num(m.y),
            button: BUTTONS.has(m.button ?? '') ? m.button : 'none',
            buttons: num(m.buttons),
            clickCount: Math.min(3, Math.max(0, Math.round(num(m.clickCount)))),
            modifiers: num(m.modifiers) & 15,
            deltaX: num(m.deltaX),
            deltaY: num(m.deltaY),
          })
          return
        }
        case 'key': {
          if (!KEYS.has(m.type) || typeof m.key !== 'string' || typeof m.code !== 'string' || m.key.length > 32 || m.code.length > 32) return
          const text = typeof m.text === 'string' && m.text.length <= 8 ? m.text : undefined
          const keyCode = Math.round(num(m.keyCode))
          const commands = Array.isArray(m.commands) ? m.commands.filter(c => COMMANDS.has(c)) : []
          await cdp.send('Input.dispatchKeyEvent', {
            type: m.type,
            key: m.key,
            code: m.code,
            modifiers: num(m.modifiers) & 15,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
            ...(text && { text, unmodifiedText: text }),
            ...(commands.length && { commands }),
          })
          return
        }
        case 'text':
          if (typeof m.text === 'string' && m.text && m.text.length <= BROWSER.textLimit) await cdp.send('Input.insertText', { text: m.text })
          return
        case 'nav': {
          const url = webUrl(m.url)
          if (!url) return this.refuse(w, 'Only http and https addresses open here.', true)
          if (!(await this.openable(url))) return this.refuse(w, "That's the server browser's own debugging port, which tabs can't open.", true)
          await cdp.send('Page.navigate', { url })
          return
        }
        case 'history': {
          if (m.go === 'reload') return void (await cdp.send('Page.reload'))
          const h = (await cdp.send('Page.getNavigationHistory')) as { currentIndex: number; entries: { id: number }[] }
          const entry = h?.entries?.[h.currentIndex + (m.go === 'back' ? -1 : 1)]
          if (entry && (m.go === 'back' || m.go === 'forward')) await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id })
          return
        }
      }
    } catch {
      // The tab went while this was on its way: its close is reported.
    }
  }

  /** The tab's card was removed for good: the tab closes. */
  async closeTab(targetId: string) {
    const s = this.streams.get(targetId)
    if (s) {
      this.setStatus(s, 'closed', 'This tab was closed.')
      this.drop(s)
    }
    await this.opts.chrome?.close(targetId).catch(() => {})
  }

  /** For tests and the server's own checks. */
  stream(targetId: string) {
    const s = this.streams.get(targetId)
    return s && { status: s.status, casting: s.casting, viewers: [...s.viewers.values()].map(w => ({ identity: w.viewer.identity, canDrive: w.canDrive, active: w.active })) }
  }

  dispose() {
    for (const s of [...this.streams.values()]) this.drop(s)
  }

  private drop(s: Stream) {
    if (s.closing) clearTimeout(s.closing)
    if (s.ackTimer) clearTimeout(s.ackTimer)
    if (s.retry) clearTimeout(s.retry)
    if (s.relayout) clearTimeout(s.relayout)
    s.closing = s.ackTimer = s.retry = s.relayout = null
    const cdp = s.cdp
    s.cdp = null
    s.casting = null
    if (cdp) {
      void cdp.send('Page.stopScreencast').catch(() => {})
      cdp.close()
    }
    if (this.streams.get(s.targetId) === s) this.streams.delete(s.targetId)
  }

  private connect(s: Stream): Promise<Cdp | null> {
    if (s.cdp) return Promise.resolve(s.cdp)
    if (s.connecting) return s.connecting
    s.connecting = (async () => {
      const chrome = this.opts.chrome!
      let cdp: Cdp | null = null
      try {
        if (!(await chrome.tabs()).has(s.targetId)) {
          this.setStatus(s, 'closed', 'This tab was closed.')
          return null
        }
        cdp = await chrome.connect(s.targetId)
        await cdp.ready
        await cdp.send('Page.enable')
        // Nothing the tab does reaches the browser's debugging port: not a navigation, a redirect
        // or a fetch. That port on any host: every way of writing this machine's address is
        // covered. A tab without this guard isn't used: the connection counts as failed.
        const port = await chrome.debugPort()
        const guarded = cdp
        guarded.on('Fetch.requestPaused', ({ requestId }) => void guarded.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}))
        await guarded.send('Fetch.enable', { patterns: [{ urlPattern: `*://*:${port}/*` }] })
      } catch (e) {
        cdp?.close() // not kept: a browser that half answered gets no pile of sockets
        this.setStatus(s, 'unavailable', `The server's browser can't be reached (${(e as Error).message}).`)
        this.retryLater(s)
        return null
      } finally {
        s.connecting = null
      }
      if (this.streams.get(s.targetId) !== s || (!s.viewers.size && !s.kept)) {
        cdp.close()
        return null
      }
      s.cdp = cdp
      // A new connection: Chrome dropped the last one's layout with it.
      s.viewport = null
      cdp.on('Page.screencastFrame', p => this.frame(s, cdp, p))
      cdp.on('Page.frameNavigated', ({ frame }) => {
        if (frame?.parentId) return
        s.page = { ...s.page, url: String(frame?.url ?? '') }
        this.broadcast(s, enc({ t: 'page', ...s.page }))
      })
      cdp.on('Page.navigatedWithinDocument', ({ url }) => {
        s.page = { ...s.page, url: String(url ?? '') }
        this.broadcast(s, enc({ t: 'page', ...s.page }))
      })
      cdp.on('Page.domContentEventFired', () => {
        void cdp
          .send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
          .then(r => {
            const title = String(r?.result?.value ?? '').slice(0, 300)
            if (title === s.page.title) return
            s.page = { ...s.page, title }
            this.broadcast(s, enc({ t: 'page', ...s.page }))
          })
          .catch(() => {})
      })
      cdp.onClose(() => {
        if (s.cdp !== cdp) return
        s.cdp = null
        s.casting = null
        // Closed by Chrome: the tab went, or the browser did.
        void chrome
          .tabs()
          .then(tabs => {
            if (!tabs.has(s.targetId)) return this.setStatus(s, 'closed', 'This tab was closed.')
            this.setStatus(s, 'unavailable', "The server's browser stopped answering.")
            this.retryLater(s)
          })
          .catch(() => {
            this.setStatus(s, 'unavailable', "The server's browser can't be reached.")
            this.retryLater(s)
          })
      })
      const tab = (await chrome.tabs().catch(() => new Map())).get(s.targetId)
      // Dropped meanwhile (its last viewer's grace ran out): `drop` closed the connection.
      if (this.streams.get(s.targetId) !== s || s.cdp !== cdp) return null
      if (tab) {
        s.page = { url: tab.url, title: tab.title }
        this.broadcast(s, enc({ t: 'page', ...s.page }))
      }
      this.setStatus(s, 'live')
      await this.update(s)
      return cdp
    })()
    return s.connecting
  }

  /** Tries the tab again in a few seconds, while anyone watches. */
  private retryLater(s: Stream) {
    if (s.retry || (!s.viewers.size && !s.kept) || this.streams.get(s.targetId) !== s) return
    // Soon while someone watches; now and then for a tab only kept.
    s.retry = setTimeout(
      () => {
        s.retry = null
        if ((s.viewers.size || s.kept) && this.streams.get(s.targetId) === s) void this.connect(s)
      },
      s.viewers.size ? 3000 : 30_000,
    )
  }

  /** Starts, stops or resizes the screencast for the cards that want frames now. */
  /**
   * Starts, stops or resizes the screencast, and lays the tab out, for the cards that want frames
   * now. One change at a time per tab: each reads the cards as they are when its turn comes, so a
   * change overtaken by another (a card that left, a second resize) never undoes it.
   */
  private update(s: Stream): Promise<void> {
    return this.inTurn(s, () => this.updateNow(s))
  }

  private inTurn(s: Stream, fn: () => Promise<void>): Promise<void> {
    s.turns = s.turns.then(fn, fn).catch(() => {})
    return s.turns
  }

  private async updateNow(s: Stream) {
    const cdp = s.cdp
    if (!cdp || this.streams.get(s.targetId) !== s) return
    const active = [...s.viewers.values()].filter(w => w.active)
    // The tab laid out at the card's size and the viewer's pixel ratio, once they stop changing:
    // a card being resized, or a page joining, doesn't lay the page out again at every step. The
    // canvas's zoom doesn't change it at all; it only changes how wide the frames are made. Only
    // while it's still wanted: a layout waiting for a card that left, or for the size the tab has
    // already, is dropped.
    const want = viewportOf(active)
    if (want && !sameViewport(want, s.viewport)) this.relayoutSoon(s)
    else this.cancelRelayout(s)
    if (!active.length) {
      if (s.casting) {
        s.casting = null
        await cdp.send('Page.stopScreencast').catch(() => {})
      }
      return
    }
    // As wide as the widest card is on screen, in device pixels, and no wider than the page is drawn.
    // Chrome draws at twice the page's size (--force-device-scale-factor=2: an emulated ratio sets the
    // page's devicePixelRatio but adds no pixels), so frames can be up to twice its width.
    const drawn = s.viewport ? s.viewport.width * BROWSER.viewport.maxDpr : BROWSER.maxWidth
    const widest = Math.min(drawn, Math.max(...active.map(w => w.width || drawn)))
    const width = Math.min(BROWSER.maxWidth, Math.max(BROWSER.minWidth, Math.round(widest / 80) * 80))
    // A new size only when it's well off: each restart costs a frame.
    if (s.casting && s.casting.width && Math.abs(s.casting.width - width) / s.casting.width < 0.25) return
    // Chrome keeps a running screencast's size: a new size takes stopping it first.
    if (s.casting) await cdp.send('Page.stopScreencast').catch(() => {})
    s.casting = { width }
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: BROWSER.quality, maxWidth: width, maxHeight: width * 2, everyNthFrame: 1 }).catch(() => {})
  }

  private relayoutSoon(s: Stream) {
    if (s.relayout) clearTimeout(s.relayout)
    s.relayout = setTimeout(() => {
      s.relayout = null
      void this.inTurn(s, () => this.relayout(s))
    }, RELAYOUT_MS)
  }

  private cancelRelayout(s: Stream) {
    if (s.relayout) clearTimeout(s.relayout)
    s.relayout = null
  }

  /** Lays the tab out for the cards live now (not those of when it was asked for), then sizes frames to it. */
  private async relayout(s: Stream) {
    const cdp = s.cdp
    if (!cdp || this.streams.get(s.targetId) !== s) return
    const want = viewportOf([...s.viewers.values()].filter(w => w.active))
    if (!want || sameViewport(want, s.viewport)) return
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...want, mobile: false })
    } catch {
      return // its connection went; the next one lays it out again
    }
    if (s.cdp !== cdp) return
    s.viewport = want
    // Frames at the new size: as wide as the cards need, now that the page is drawn wider or narrower.
    if (s.casting) s.casting = { width: 0 }
    await this.updateNow(s)
  }

  private frame(s: Stream, cdp: Cdp, p: { data: string; metadata: Record<string, number>; sessionId: number }) {
    const m = p.metadata ?? {}
    const header: FrameHeader = { deviceWidth: num(m.deviceWidth), deviceHeight: num(m.deviceHeight), offsetTop: num(m.offsetTop), pageScaleFactor: num(m.pageScaleFactor, 1), at: Date.now() }
    const frame = encodeFrame(header, Buffer.from(p.data, 'base64'))
    s.last = frame
    for (const w of s.viewers.values()) if (w.active && w.viewer.buffered() < BACKED_UP) w.viewer.sendFrame(frame)
    // Chrome sends the next frame once this one is acknowledged: acknowledging no sooner than
    // the frame rate allows is what caps it.
    const ack = () => {
      s.ackTimer = null
      s.ackAt = Date.now()
      void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
    }
    const wait = s.ackAt + 1000 / BROWSER.maxFps - Date.now()
    if (wait <= 0) ack()
    else s.ackTimer = setTimeout(ack, wait)
  }

  /** A still of the tab, for a card that isn't live: the last frame, or a screenshot. */
  private async still(s: Stream, w: Watching) {
    if (s.last) return w.viewer.sendFrame(s.last)
    const cdp = s.cdp ?? (await this.connect(s))
    if (!cdp) return
    try {
      const metrics = (await cdp.send('Page.getLayoutMetrics')) as { cssVisualViewport?: { clientWidth: number; clientHeight: number } }
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })) as { data: string }
      const vv = metrics?.cssVisualViewport
      const header: FrameHeader = { deviceWidth: num(vv?.clientWidth, 1280), deviceHeight: num(vv?.clientHeight, 800), offsetTop: 0, pageScaleFactor: 1, at: Date.now() }
      s.last ??= encodeFrame(header, Buffer.from(shot.data, 'base64'))
      w.viewer.sendFrame(s.last)
    } catch {}
  }

  private setStatus(s: Stream, status: BrowserStatus, reason?: string) {
    if (s.status === status && s.reason === reason) return
    s.status = status
    s.reason = reason
    this.broadcast(s, enc({ t: 'status', status, ...(reason && { reason }) }))
  }

  private broadcast(s: Stream, msg: string) {
    for (const w of s.viewers.values()) w.viewer.send(msg)
  }

  private refuse(w: Watching, reason: string, always = false) {
    const now = Date.now()
    if (!always && now - w.refusedAt < 5000) return
    w.refusedAt = now
    w.viewer.send(enc({ t: 'refused', reason }))
  }
}

/**
 * Whether an address could be the browser's own debugging port: that port, on any host. This
 * machine has too many names (localhost., 127.1, ::ffff:127.0.0.1, its tailnet name…) to list,
 * and another host on the same high port is no loss.
 */
export function debugAddress(raw: string, port: number): boolean {
  if (!URL.canParse(raw)) return true
  const url = new URL(raw)
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port
}

// ---------- the server's Chrome ----------

/** A minimal CDP client over one target's WebSocket. */
function cdpOver(url: string): Cdp {
  const ws = new WebSocket(url)
  let n = 0
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>()
  const handlers = new Map<string, (p: any) => void>()
  const closers: (() => void)[] = []
  // A browser that takes the connection and never answers holds nothing up for long.
  const ready = new Promise<void>((resolve, reject) => {
    const late = setTimeout(() => (reject(new Error('no connection')), ws.close()), 5000)
    ws.onopen = () => (clearTimeout(late), resolve())
    ws.onerror = () => (clearTimeout(late), reject(new Error('no connection')))
  })
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p?.reject(new Error(msg.error.message))
      else p?.resolve(msg.result)
    } else handlers.get(msg.method)?.(msg.params)
  }
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('closed'))
    pending.clear()
    for (const fn of closers) fn()
  }
  return {
    ready,
    send(method, params = {}) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('closed'))
      const id = ++n
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => {
        const late = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} got no answer`))
        }, 10_000)
        pending.set(id, { resolve: r => (clearTimeout(late), resolve(r)), reject: e => (clearTimeout(late), reject(e)) })
      })
    },
    on: (event, fn) => void handlers.set(event, fn),
    onClose: fn => void closers.push(fn),
    close: () => ws.close(),
  }
}

/**
 * The Chrome running with this profile directory. Chrome writes its debugging port and its browser
 * target's path to `<profile>/DevToolsActivePort`; the port is used only while the browser there
 * names that same path, so another program's port is never trusted. Read again each time: a
 * restarted Chrome picks another port.
 */
export function chromeAt(profile: string): Chrome {
  // A browser that takes the connection and never answers holds nothing up for long.
  const get = (url: string, method = 'GET') => fetch(url, { method, signal: AbortSignal.timeout(5000) })
  const port = async () => {
    const [p, path] = (await Bun.file(`${profile}/DevToolsActivePort`).text()).trim().split('\n')
    if (!/^\d+$/.test(p ?? '') || !path) throw new Error('no DevToolsActivePort')
    const info = (await get(`http://127.0.0.1:${p}/json/version`).then(r => r.json())) as { webSocketDebuggerUrl?: string }
    if (!info.webSocketDebuggerUrl?.endsWith(path)) throw new Error('the debugging port is not this profile’s browser')
    return Number(p)
  }
  return {
    debugPort: port,
    async open(url) {
      const res = await get(`http://127.0.0.1:${await port()}/json/new?${encodeURIComponent(url)}`, 'PUT')
      const t = (await res.json()) as { id?: string }
      if (!t.id) throw new Error("the browser didn't open a tab")
      return t.id
    },
    async close(targetId) {
      await get(`http://127.0.0.1:${await port()}/json/close/${targetId}`)
    },
    async tabs() {
      const list = (await (await get(`http://127.0.0.1:${await port()}/json/list`)).json()) as { id: string; type: string; url: string; title: string }[]
      return new Map(list.filter(t => t.type === 'page').map(t => [t.id, { url: t.url, title: t.title }]))
    },
    async connect(targetId) {
      return cdpOver(`ws://127.0.0.1:${await port()}/devtools/page/${targetId}`)
    },
  }
}
