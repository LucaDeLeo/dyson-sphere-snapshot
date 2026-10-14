// A terminal card's content: an xterm.js terminal showing a session's tmux pane, fed by
// sphere-server's `/term` socket (shared/terminal.ts). Plain DOM and xterm, no canvas library: the
// canvas adopts `root` (an element it never remounts, so the terminal and its socket survive
// culling, zooming and panning away) and says when it's interactive and when it's on screen.
//
// - The terminal is the pane's size (the server says), scaled to fit the card.
// - In edit mode every key, the wheel, pointer and clipboard events stay in the terminal; the exit
//   chord (⌘Esc, Ctrl+Esc) is caught before xterm sees it.
// - xterm maps a click to a cell as if nothing were scaled; under the camera's and the card's
//   scale, mouse events are sent again with corrected coordinates.
// - Only the session's owner can type: the server refuses anyone else's keys, and the card doesn't
//   send them.
import type { Terminal } from '@xterm/xterm'
import { TERM, type TermStatus, type TermToViewer } from '../../../shared/terminal'

/** What the card's chrome shows about its terminal. */
export type TermView = {
  status: TermStatus
  reason: string | null
  owner: string | null
  canType: boolean
  cols: number
  rows: number
  /** The server refused something the viewer did, and why. Cleared after a while. */
  refused: string | null
}

export type TerminalHandle = {
  readonly root: HTMLDivElement
  view(): TermView
  /** Calls `fn` whenever `view()` changes. Returns how to stop. */
  subscribe(fn: () => void): () => void
  /** Edit mode: keys, pointer and wheel go to the terminal and nothing else. */
  setInteractive(on: boolean): void
  /** On screen and big enough to read: output flows. Off: the server holds it back. */
  setVisible(on: boolean): void
  focus(): void
  /** The owner asks for the pane to be as big as the card. */
  fitPaneToCard(): void
  dispose(): void
}

type Options = {
  sessionId: string
  /** A dev server's token; none behind Tailscale. */
  token: string
  /** The person asked to leave the terminal (⌘Esc, Ctrl+Esc). */
  onExitRequest(): void
}

const handles = new Map<string, TerminalHandle>()
const optionsById = new Map<string, Options>()

// Events a terminal in edit mode keeps to itself. The canvas listens for them on its container
// (bubbling), so stopping them at the root is enough.
const KEPT = ['keydown', 'keyup', 'keypress', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'copy', 'cut', 'paste', 'contextmenu'] as const
const MOUSE = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick'] as const
const corrected = new WeakSet<Event>()

/** The xterm theme: terminals stay dark in both color schemes, as programs pick colors for a dark one. */
const THEME = { background: '#16181d', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#3b4a6b' }

/** Whether this is the exit chord: ⌘Esc on a Mac, Ctrl+Esc elsewhere (either works anywhere). */
export const isExitChord = (e: KeyboardEvent) => e.key === 'Escape' && (e.metaKey || e.ctrlKey)

export function getTerminal(cardId: string, opts: Options): TerminalHandle {
  optionsById.set(cardId, opts) // the newest shape util's callbacks win
  const existing = handles.get(cardId)
  if (existing) return existing

  const root = document.createElement('div')
  root.className = 'term-root'
  root.dataset.card = cardId
  const host = document.createElement('div')
  host.className = 'term-host'
  root.append(host)

  let view: TermView = { status: 'connecting', reason: null, owner: null, canType: false, cols: 80, rows: 24, refused: null }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<TermView>) => {
    view = { ...view, ...patch }
    for (const fn of listeners) fn()
  }

  let term: Terminal | null = null
  let interactive = false
  let visible = true
  let disposed = false

  // ----- scale: the terminal at its pane's size, fitted to the card -----
  const screen = () => root.querySelector('.xterm-screen') as HTMLElement | null
  /** The room the terminal has in the card, in the card's own pixels (the camera's scale aside). */
  const room = () => {
    const cs = getComputedStyle(root)
    const pad = (a: string, b: string) => (parseFloat(cs.getPropertyValue(a)) || 0) + (parseFloat(cs.getPropertyValue(b)) || 0)
    return { w: root.clientWidth - pad('padding-left', 'padding-right'), h: root.clientHeight - pad('padding-top', 'padding-bottom') }
  }
  const fitScale = () => {
    const el = screen()
    const r = room()
    if (!el || !el.offsetWidth || r.w <= 0 || r.h <= 0) return
    const s = Math.min(r.w / el.offsetWidth, r.h / el.offsetHeight, 2)
    host.style.transform = `scale(${s})`
  }
  const resizeObserver = new ResizeObserver(() => fitScale())
  resizeObserver.observe(root)

  // ----- keys stay in the terminal while it's interactive -----
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
  // A paste goes to the pane as a paste, not as keys: tmux adds the bracketed-paste markers when the
  // program asked for them, which xterm can't know of a program that asked before the card opened.
  root.addEventListener(
    'paste',
    e => {
      if (!interactive) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const text = e.clipboardData?.getData('text/plain')?.replace(/\r?\n/g, '\r')
      if (!view.canType || !text) return
      // Whole or not at all: half a paste would be worse than none.
      if (text.length > TERM.inputLimit) return say(`That paste is over ${Math.round(TERM.inputLimit / 1024)} KB, too long to send to the terminal.`)
      send({ t: 'in', d: text, paste: true })
    },
    { capture: true },
  )

  // ----- clicks land on the right cell under the canvas's and the card's scale -----
  let dragging = false
  const correct = (e: MouseEvent) => {
    if (corrected.has(e) || !interactive) return
    const inside = root.contains(e.target as Node)
    if (e.type === 'mousedown') dragging = inside
    if (!inside && !dragging) return
    if (e.type === 'mouseup') dragging = false
    const el = screen()
    if (!el?.offsetWidth) return
    const rect = el.getBoundingClientRect()
    const scale = rect.width / el.offsetWidth
    if (Math.abs(scale - 1) < 1e-3) return
    const fixed = new MouseEvent(e.type, {
      bubbles: e.bubbles,
      cancelable: e.cancelable,
      composed: e.composed,
      view: e.view,
      detail: e.detail,
      screenX: e.screenX,
      screenY: e.screenY,
      clientX: rect.left + (e.clientX - rect.left) / scale,
      clientY: rect.top + (e.clientY - rect.top) / scale,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      button: e.button,
      buttons: e.buttons,
      relatedTarget: e.relatedTarget,
    })
    corrected.add(fixed)
    e.stopImmediatePropagation()
    if (e.type === 'mousedown') e.preventDefault()
    ;(e.target as EventTarget).dispatchEvent(fixed)
  }
  for (const type of MOUSE) window.addEventListener(type, correct as EventListener, { capture: true })

  // ----- the socket -----
  let ws: WebSocket | null = null
  let backoff = 500
  let retry: ReturnType<typeof setTimeout> | null = null
  let refusedTimer: ReturnType<typeof setTimeout> | null = null
  const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
  /** A note in the card's title bar for a few seconds: something it was asked to do didn't happen. */
  const say = (reason: string) => {
    if (refusedTimer) clearTimeout(refusedTimer)
    refusedTimer = setTimeout(() => update({ refused: null }), 4000)
    update({ refused: reason })
  }
  const onMessage = (m: TermToViewer) => {
    if (!term) return
    switch (m.t) {
      case 'hello':
        term.options.disableStdin = !m.canType
        return update({ owner: m.owner, canType: m.canType })
      case 'status':
        return update({ status: m.status, reason: m.reason ?? null })
      case 'state':
        term.reset()
        if (term.cols !== m.cols || term.rows !== m.rows) term.resize(m.cols, m.rows)
        term.write(m.d, () => fitScale())
        return update({ status: 'live', reason: null, cols: m.cols, rows: m.rows })
      case 'out':
        term.write(m.d)
        return
      case 'refused':
        return say(m.reason)
    }
  }
  const connect = () => {
    retry = null
    // One socket at a time, and none before the terminal it feeds has loaded.
    if (disposed || ws || !term) return
    const url = new URL('/term', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const { sessionId, token } = optionsById.get(cardId)!
    url.search = new URLSearchParams({ session: sessionId, ...(token && { token }) }).toString()
    const socket = new WebSocket(url)
    ws = socket
    socket.onopen = () => {
      backoff = 500
      if (!visible) send({ t: 'pause' })
    }
    socket.onmessage = ev => onMessage(JSON.parse(String(ev.data)) as TermToViewer)
    socket.onclose = ev => {
      if (ws !== socket || disposed) return
      ws = null
      if (asleep) return // closed on purpose, while off screen
      if (view.status === 'live') update({ status: 'connecting', reason: null })
      // Refused for good (no such session, too many open): asked again only slowly. Its status says why.
      if (ev.code === 4004 || ev.code === 4029) backoff = 30_000
      retry = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  /** The socket, closed while the card has been off screen a while: one less held open. */
  let asleep = false
  let sleeping: ReturnType<typeof setTimeout> | null = null
  const closeSocket = () => {
    const socket = ws
    ws = null
    if (!socket) return
    socket.onmessage = socket.onclose = socket.onopen = null
    socket.close()
  }

  // xterm loads on first use: most pages never open a terminal.
  void import('@xterm/xterm').then(({ Terminal }) => {
    if (disposed) return
    term = new Terminal({
      cols: view.cols,
      rows: view.rows,
      fontSize: 13,
      lineHeight: 1,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: false,
      macOptionIsMeta: true,
      scrollback: 5000,
      disableStdin: true,
      theme: THEME,
    })
    term.open(host)
    term.onData(d => view.canType && send({ t: 'in', d }))
    // Bytes as characters (old-style mouse reports): kept as bytes all the way to the pane.
    term.onBinary(d => view.canType && send({ t: 'in', d, binary: true }))
    fitScale()
    connect()
  })

  const handle: TerminalHandle = {
    root,
    view: () => view,
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    setInteractive(on) {
      interactive = on
      root.classList.toggle('interactive', on)
      if (!on) {
        dragging = false
        term?.blur()
      }
    },
    setVisible(on) {
      if (on === visible) return
      visible = on
      if (sleeping) clearTimeout(sleeping)
      sleeping = null
      if (on && asleep) {
        // Back on screen: connect again, and get the whole screen.
        asleep = false
        if (!retry) connect()
        return
      }
      send({ t: on ? 'resume' : 'pause' })
      // A minute off screen, and the socket goes; the terminal keeps what it showed.
      if (!on)
        sleeping = setTimeout(() => {
          sleeping = null
          if (visible || disposed) return
          asleep = true
          if (retry) clearTimeout(retry)
          retry = null
          closeSocket()
        }, 60_000)
    },
    focus: () => term?.focus(),
    fitPaneToCard() {
      const el = screen()
      if (!term || !el?.offsetWidth) return
      // Cells that fit the card at the terminal's own size (scale 1).
      const cellW = el.offsetWidth / term.cols
      const cellH = el.offsetHeight / term.rows
      const r = room()
      const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)))
      send({ t: 'fit', cols: clamp(r.w / cellW, TERM.minCols, TERM.maxCols), rows: clamp(r.h / cellH, TERM.minRows, TERM.maxRows) })
    },
    dispose() {
      disposed = true
      if (retry) clearTimeout(retry)
      if (refusedTimer) clearTimeout(refusedTimer)
      for (const type of MOUSE) window.removeEventListener(type, correct as EventListener, { capture: true })
      if (sleeping) clearTimeout(sleeping)
      resizeObserver.disconnect()
      closeSocket()
      term?.dispose()
      term = null
      root.remove()
      listeners.clear()
      handles.delete(cardId)
      optionsById.delete(cardId)
    },
  }
  handles.set(cardId, handle)
  return handle
}

export function disposeTerminal(cardId: string) {
  handles.get(cardId)?.dispose()
}

/** For tests and the console: the live terminals by card id. */
export const terminals = handles
