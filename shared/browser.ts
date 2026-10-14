// Browser cards: tabs of the server's own Chrome, opened for a session from the canvas and
// streamed to it by screencast (CDP `Page.startScreencast`), with the session owner's input sent
// back (`Input.dispatch*`). No page ever iframes a site, or sees CDP: sphere-server holds the
// Chrome connection and passes on only what's listed here.
//
//   page's card ──/browser──▶ sphere-server ──CDP (loopback)──▶ the server's Chrome, one tab
//
// Nothing here is stored but which tab belongs to which session (`browser.opened`, `browser.closed`).

/** Chrome's id for a tab (a page target). */
export const TARGET_ID = /^[A-F0-9]{32}$/i

/** What a page's browser card sends. */
export type BrowserFromViewer =
  /**
   * Whether the card wants frames (on screen, big enough, within the page's budget of live cards),
   * and how wide it is on screen, in device pixels: frames are made no wider than the widest card.
   * `css` and `dpr` (pages from before crisp frames send neither): the card's own size in CSS
   * pixels, whatever the canvas's zoom, and the viewer's device pixel ratio. The tab is laid out at
   * that size and ratio (`viewportOf`), so its frames fill the card, sharp.
   */
  | { t: 'active'; on: boolean; width?: number; css?: { w: number; h: number }; dpr?: number }
  /** A still of the tab now, for a card that isn't live and has none. */
  | { t: 'still' }
  /** The session owner's input. */
  | { t: 'mouse'; type: MouseType; x: number; y: number; button?: MouseButton; buttons?: number; clickCount?: number; modifiers?: number; deltaX?: number; deltaY?: number }
  | { t: 'key'; type: KeyType; key: string; code: string; text?: string; keyCode?: number; modifiers?: number; commands?: string[] }
  | { t: 'text'; text: string }
  | { t: 'nav'; url: string }
  | { t: 'history'; go: 'back' | 'forward' | 'reload' }

export type MouseType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
export type MouseButton = 'none' | 'left' | 'middle' | 'right'
export type KeyType = 'keyDown' | 'rawKeyDown' | 'keyUp' | 'char'

export type BrowserStatus = 'connecting' | 'live' | 'paused' | 'closed' | 'unavailable'

/**
 * What the server sends a card: these as text, and frames as binary messages: a 4-byte length
 * (big-endian), that many bytes of `FrameHeader` as JSON, then the JPEG.
 */
export type BrowserToViewer =
  | { t: 'hello'; owner: string; canDrive: boolean }
  | { t: 'status'; status: BrowserStatus; reason?: string }
  | { t: 'page'; url: string; title: string }
  | { t: 'refused'; reason: string }

/** Where a frame's pixels sit on the tab's page, from Chrome's screencast metadata. */
export type FrameHeader = { deviceWidth: number; deviceHeight: number; offsetTop: number; pageScaleFactor: number; at: number }

export const BROWSER = {
  /** The most frames a second a tab is streamed at. */
  maxFps: 30,
  /** Frames are made no wider than this, nor narrower: a 1600-pixel-wide card on a 2× screen. */
  maxWidth: 3200,
  minWidth: 320,
  /** JPEG quality of a frame. */
  quality: 85,
  /** The size a tab is laid out at, in CSS pixels, and its device pixel ratio, kept within these. */
  viewport: { minW: 320, maxW: 2560, minH: 200, maxH: 1600, maxDpr: 2 },
  /** The most browser cards a page streams at once; the rest show their last frame. */
  liveBudget: 4,
  /** Below this many screen pixels wide, a card is too small to read: it doesn't stream. */
  minScreenWidth: 160,
  /** The most text one `text` or `nav` message carries. */
  textLimit: 16 * 1024,
} as const

/**
 * A web address a tab may be sent to: http or https only. Not file:, chrome:, javascript: or data:,
 * which would reach the server's files, the browser's own pages or run code in a page.
 */
export function webUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  const s = raw.trim()
  if (!s) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost:\d/i.test(s) ? s : `http://${s}`
  if (!URL.canParse(withScheme)) return null
  const url = new URL(withScheme)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}

/** Who may drive a session's browser tab: its owner only, as for its terminal. */
export const mayDrive = (session: { owner: string }, identity: string) => session.owner === identity

export type Viewport = { width: number; height: number; deviceScaleFactor: number }

/**
 * The size and ratio to lay a tab out at, for the cards that show it: the card of the person who
 * can drive the tab (the session's owner) when it's live, otherwise the biggest live card. Cards
 * from pages before crisp frames name no size: with none that does, the tab keeps the size it has.
 */
export function viewportOf(cards: { css?: { w: number; h: number } | null; dpr?: number; canDrive: boolean }[]): Viewport | null {
  const sized = cards.filter(c => c.css && Number.isFinite(c.css.w) && Number.isFinite(c.css.h) && c.css.w > 0 && c.css.h > 0)
  if (!sized.length) return null
  const card = sized.find(c => c.canDrive) ?? sized.reduce((a, b) => (b.css!.w * b.css!.h > a.css!.w * a.css!.h ? b : a))
  const v = BROWSER.viewport
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
  const dpr = Number.isFinite(card.dpr) && card.dpr! > 0 ? card.dpr! : 1
  return {
    width: Math.round(clamp(card.css!.w, v.minW, v.maxW)),
    height: Math.round(clamp(card.css!.h, v.minH, v.maxH)),
    // Halves are enough: 1.25 and 1.5 screens get 1.5, which their scaling makes no blurrier.
    deviceScaleFactor: clamp(Math.ceil(dpr * 2) / 2, 1, v.maxDpr),
  }
}

/** A frame as sent on the wire: header length, header, JPEG. */
export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(4 + head.length + jpeg.length)
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  out.set(jpeg, 4 + head.length)
  return out
}

export function decodeFrame(data: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array<ArrayBuffer> } | null {
  if (data.byteLength < 4) return null
  const n = new DataView(data).getUint32(0)
  if (4 + n > data.byteLength) return null
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, n))) as FrameHeader
    return { header, jpeg: new Uint8Array(data, 4 + n) }
  } catch {
    return null
  }
}
