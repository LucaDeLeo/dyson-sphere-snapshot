// A browser card's content: the screencast of one tab of the server's Chrome, from sphere-server's
// `/browser` socket (shared/browser.ts), with the session owner's pointer, wheel and keys sent back.
// Plain DOM, no canvas library: the canvas adopts `root` (an element it never remounts, so the
// socket and the last frame survive culling) and says when the card wants frames and when it's
// interactive.
//
// - Frames go through the card's frame hub (frames.ts), not straight into the <img>: whatever
//   draws them (the <img> today, a layer behind the canvas one day) subscribes there.
// - Keyboard focus sits in a transparent textarea, which also takes IME composition and paste.
// - A click maps to the tab's page from where it lands in the drawn frame, so the canvas's and
//   the card's scale don't matter.
import { BROWSER, decodeFrame, type BrowserStatus, type BrowserToViewer, type FrameHeader } from '../../../shared/browser'
import { dropFrames, onFrames, pushFrame } from './frames'
import { isExitChord } from './terminal'

export type BrowserView = {
  status: BrowserStatus
  reason: string | null
  owner: string | null
  canDrive: boolean
  url: string
  title: string
  /** Whether a frame has been drawn: a card that isn't live shows it as it was. */
  hasFrame: boolean
  refused: string | null
  /** The tab's page size in CSS pixels, as its latest frame says. */
  viewport: { w: number; h: number } | null
}

export type BrowserHandle = {
  readonly root: HTMLDivElement
  view(): BrowserView
  subscribe(fn: () => void): () => void
  /** Whether the card wants frames (on screen, big enough, in the page's budget), and its width on screen in device pixels. */
  setActive(on: boolean, width: number): void
  setInteractive(on: boolean): void
  focus(): void
  navigate(url: string): void
  history(go: 'back' | 'forward' | 'reload'): void
  dispose(): void
}

type Options = { targetId: string; token: string; onExitRequest(): void }

const handles = new Map<string, BrowserHandle>()
const optionsById = new Map<string, Options>()

const KEPT = ['keydown', 'keyup', 'keypress', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'copy', 'cut', 'paste', 'contextmenu'] as const
const BUTTON = ['left', 'middle', 'right'] as const
/** CDP's modifier bits. */
const mods = (e: KeyboardEvent | MouseEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
/** ⌘ shortcuts Chrome performs on macOS only when told which editing command they are. */
const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' }

export function getBrowser(cardId: string, opts: Options): BrowserHandle {
  optionsById.set(cardId, opts)
  const existing = handles.get(cardId)
  if (existing) return existing

  const root = document.createElement('div')
  root.className = 'browser-root'
  root.dataset.card = cardId
  const img = document.createElement('img')
  img.className = 'browser-frame'
  img.alt = ''
  img.draggable = false
  const keys = document.createElement('textarea')
  keys.className = 'browser-keys'
  keys.setAttribute('aria-label', 'Type into the browser tab')
  keys.autocapitalize = 'off'
  keys.spellcheck = false
  root.append(img, keys)

  let view: BrowserView = { status: 'connecting', reason: null, owner: null, canDrive: false, url: '', title: '', hasFrame: false, refused: null, viewport: null }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<BrowserView>) => {
    view = { ...view, ...patch }
    for (const fn of listeners) fn()
  }
  let interactive = false
  let active = false
  let told = false
  let width = 0
  let disposed = false
  let header: FrameHeader | null = null

  // ----- frames: through the card's hub, drawn by the <img> -----
  // The frame shown, and the one loading: any other is let go at once, so none stays in memory.
  let shown: string | null = null
  let loading: string | null = null
  const stopDrawing = onFrames(cardId, f => {
    const next = URL.createObjectURL(f.data)
    if (loading) URL.revokeObjectURL(loading) // replaced before it was drawn
    loading = next
    img.onload = img.onerror = () => {
      if (loading !== next) return
      if (shown) URL.revokeObjectURL(shown)
      shown = next
      loading = null
    }
    img.src = next
  })

  // ----- keys stay in the card while it's interactive -----
  root.addEventListener(
    'keydown',
    e => {
      if (interactive && isExitChord(e)) {
        e.preventDefault()
        e.stopPropagation()
        optionsById.get(cardId)?.onExitRequest()
      }
    },
    { capture: true },
  )
  for (const type of KEPT) root.addEventListener(type, e => interactive && e.stopPropagation())

  // ----- the socket -----
  let ws: WebSocket | null = null
  let backoff = 500
  let retry: ReturnType<typeof setTimeout> | null = null
  let refusedTimer: ReturnType<typeof setTimeout> | null = null
  const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
  /**
   * The card's own size in CSS pixels (the canvas's zoom doesn't change it: its transform is above
   * the card), and the screen's pixel ratio: the tab is laid out to match (`viewportOf`).
   */
  const cardSize = () => ({ w: root.clientWidth, h: root.clientHeight })
  let sent = cardSize()
  const announce = () => {
    sent = cardSize()
    // Not a card parked out of sight (it's a pixel wide there), nor one not laid out yet.
    const sized = sent.w >= 100 && sent.h >= 60
    send({ t: 'active', on: active, width, ...(sized && { css: sent }), dpr: window.devicePixelRatio || 1 })
    if (!active && !view.hasFrame) send({ t: 'still' })
  }
  // A card resized: said once it has stopped changing (the server waits a little too).
  let resized: ReturnType<typeof setTimeout> | null = null
  const sizeObserver = new ResizeObserver(() => {
    const now = cardSize()
    if (now.w === sent.w && now.h === sent.h) return
    if (resized) clearTimeout(resized)
    resized = setTimeout(() => {
      resized = null
      if (active) announce()
    }, 200)
  })
  sizeObserver.observe(root)
  const connect = () => {
    retry = null
    if (disposed) return
    const url = new URL('/browser', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const { targetId, token } = optionsById.get(cardId)!
    url.search = new URLSearchParams({ tab: targetId, ...(token && { token }) }).toString()
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    ws = socket
    socket.onopen = () => {
      backoff = 500
      announce()
    }
    socket.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = decodeFrame(ev.data)
        if (!frame) return
        if (!header || header.deviceWidth !== frame.header.deviceWidth || header.deviceHeight !== frame.header.deviceHeight)
          update({ viewport: { w: frame.header.deviceWidth, h: frame.header.deviceHeight } })
        header = frame.header
        pushFrame(cardId, { data: new Blob([frame.jpeg], { type: 'image/jpeg' }), width: frame.header.deviceWidth, height: frame.header.deviceHeight, at: frame.header.at })
        if (!view.hasFrame) update({ hasFrame: true })
        return
      }
      const m = JSON.parse(String(ev.data)) as BrowserToViewer
      if (m.t === 'hello') update({ owner: m.owner, canDrive: m.canDrive })
      else if (m.t === 'status') update({ status: m.status, reason: m.reason ?? null })
      else if (m.t === 'page') update({ url: m.url, title: m.title || view.title })
      else if (m.t === 'refused') {
        if (refusedTimer) clearTimeout(refusedTimer)
        refusedTimer = setTimeout(() => update({ refused: null }), 4000)
        update({ refused: m.reason })
      }
    }
    socket.onclose = ev => {
      if (ws !== socket || disposed) return
      ws = null
      if (asleep) return // closed on purpose, while not live
      // Refused for good (no such tab, no browser, too many open): asked again only slowly.
      if (ev.code === 4004 || ev.code === 4029) backoff = 30_000
      retry = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  /** The socket, closed after a minute without frames: the card keeps its last one. */
  let asleep = false
  let sleeping: ReturnType<typeof setTimeout> | null = null
  const closeSocket = () => {
    const socket = ws
    ws = null
    if (!socket) return
    socket.onmessage = socket.onclose = socket.onopen = null
    socket.close()
  }
  connect()

  // ----- input: the session owner's, mapped onto the tab's page -----
  /** A point on screen as CSS pixels of the tab's page, from where it lands in the drawn frame. */
  /** `clamp`: a point off the frame counts as its nearest edge (a drag that ends outside). */
  const toPage = (e: MouseEvent, clamp = false) => {
    if (!header || !img.naturalWidth) return null
    const r = img.getBoundingClientRect()
    const fit = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
    const w = img.naturalWidth * fit
    const h = img.naturalHeight * fit
    let u = (e.clientX - (r.left + (r.width - w) / 2)) / w
    let v = (e.clientY - (r.top + (r.height - h) / 2)) / h
    if (clamp) [u, v] = [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]
    if (u < 0 || u > 1 || v < 0 || v > 1) return null
    return { x: u * header.deviceWidth, y: v * header.deviceHeight + header.offsetTop }
  }
  const driving = () => interactive && view.canDrive
  root.addEventListener('pointerdown', e => {
    if (!interactive) return
    e.preventDefault() // focus stays in the key textarea
    keys.focus({ preventScroll: true })
    const p = driving() && toPage(e)
    if (!p) return
    // The button goes up in the tab too, wherever it's let go: the card holds the pointer till then.
    pressed = true
    root.setPointerCapture?.(e.pointerId)
    send({ t: 'mouse', type: 'mousePressed', ...p, button: BUTTON[e.button] ?? 'left', buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) })
  })
  let pressed = false
  const release = (e: PointerEvent) => {
    if (!pressed) return
    pressed = false
    const p = toPage(e, true)
    if (p) send({ t: 'mouse', type: 'mouseReleased', ...p, button: BUTTON[e.button] ?? 'left', buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) })
  }
  root.addEventListener('pointerup', release)
  root.addEventListener('pointercancel', release)
  let moved: PointerEvent | null = null
  root.addEventListener('pointermove', e => {
    if (!driving()) return
    if (!moved)
      requestAnimationFrame(() => {
        const ev = moved!
        moved = null
        const p = toPage(ev)
        if (p) send({ t: 'mouse', type: 'mouseMoved', ...p, buttons: ev.buttons, button: ev.buttons & 1 ? 'left' : 'none', modifiers: mods(ev) })
      })
    moved = e
  })
  root.addEventListener(
    'wheel',
    e => {
      if (!interactive) return
      e.preventDefault()
      const p = driving() && toPage(e)
      if (p) send({ t: 'mouse', type: 'mouseWheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: mods(e) })
    },
    { passive: false },
  )
  keys.addEventListener('keydown', e => {
    if (!driving() || e.isComposing || e.key === 'Process') return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return // the paste event brings the local clipboard
    e.preventDefault()
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey
    const text = printable ? e.key : e.key === 'Enter' ? '\r' : undefined
    const command = e.metaKey && !e.ctrlKey ? MAC_COMMANDS[e.key.toLowerCase()] : undefined
    send({ t: 'key', type: text ? 'keyDown' : 'rawKeyDown', key: e.key, code: e.code, text, keyCode: e.keyCode, modifiers: mods(e), commands: command ? [command] : undefined })
  })
  keys.addEventListener('keyup', e => {
    if (!driving() || e.isComposing || e.key === 'Process') return
    e.preventDefault()
    send({ t: 'key', type: 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e) })
  })
  keys.addEventListener('compositionend', e => {
    if (driving() && e.data) send({ t: 'text', text: e.data })
    keys.value = ''
  })
  keys.addEventListener('input', e => {
    // Text that came without a key we sent: an IME commit outside a composition, the emoji picker, dictation.
    const ie = e as InputEvent
    if (driving() && !ie.isComposing && ie.inputType === 'insertText' && ie.data) send({ t: 'text', text: ie.data })
    if (!ie.isComposing) keys.value = ''
  })
  keys.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text/plain')
    e.preventDefault()
    if (driving() && text) send({ t: 'text', text: text.slice(0, BROWSER.textLimit) })
  })

  const handle: BrowserHandle = {
    root,
    view: () => view,
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    setActive(on, w) {
      const next = Math.round(w)
      // Width matters only a lot at a time: a resize of the screencast costs a frame. The first
      // call counts whatever it says: a card that starts paused falls asleep too.
      if (told && on === active && (!on || Math.abs(next - width) < width * 0.2)) return
      told = true
      active = on
      width = next
      root.classList.toggle('inactive', !on)
      if (sleeping) clearTimeout(sleeping)
      sleeping = null
      if (on && asleep) {
        asleep = false
        if (!retry) connect() // announces itself once open
        return
      }
      announce()
      if (!on)
        sleeping = setTimeout(() => {
          sleeping = null
          if (active || disposed) return
          asleep = true
          if (retry) clearTimeout(retry)
          retry = null
          closeSocket()
        }, 60_000)
    },
    setInteractive(on) {
      interactive = on
      root.classList.toggle('interactive', on)
      if (!on) keys.blur()
    },
    focus: () => keys.focus({ preventScroll: true }),
    navigate: url => send({ t: 'nav', url }),
    history: go => send({ t: 'history', go }),
    dispose() {
      disposed = true
      if (retry) clearTimeout(retry)
      if (refusedTimer) clearTimeout(refusedTimer)
      stopDrawing()
      dropFrames(cardId)
      if (shown) URL.revokeObjectURL(shown)
      if (loading) URL.revokeObjectURL(loading)
      if (resized) clearTimeout(resized)
      sizeObserver.disconnect()
      if (sleeping) clearTimeout(sleeping)
      closeSocket()
      root.remove()
      listeners.clear()
      handles.delete(cardId)
      optionsById.delete(cardId)
    },
  }
  handles.set(cardId, handle)
  return handle
}

export function disposeBrowser(cardId: string) {
  handles.get(cardId)?.dispose()
}

/** For tests and the console: the live browser cards by card id. */
export const browsers = handles
