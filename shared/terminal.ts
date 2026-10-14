// Terminal cards (protocol 5): a session's tmux pane, relayed from its bridge through
// sphere-server to the canvas. The bridge runs as the session's owner, on the session's machine,
// and attaches to the pane with tmux's control mode; the server checks who may watch and who may
// type; pages get the pane's screen, then its output as it comes.
//
//   page ──/term socket──▶ sphere-server ──bridge's /ws──▶ bridge ──tmux -C──▶ the session's pane
//
// Nothing here is stored: a terminal is live or it isn't.

/** The server to a bridge, about its session's pane. */
export type TermToBridge =
  /** Someone is watching: attach to the pane and send its screen (`state`). */
  | { op: 'open' }
  /** Nobody is watching any more: detach. */
  | { op: 'close' }
  /** Send the whole screen again: a viewer joined, came back, or fell behind. */
  | { op: 'snapshot' }
  /**
   * Keys the session's owner typed, as the terminal sends them. Only ever the owner's. `binary`: `d`'s
   * characters are bytes (xterm's onBinary: old-style mouse reports). `paste`: pasted text, which
   * tmux wraps in bracketed-paste markers when the program asked for them.
   */
  | { op: 'in'; d: string; binary?: true; paste?: true }
  /** The owner asked for the pane's window to be this size. */
  | { op: 'fit'; cols: number; rows: number }

/** A bridge to the server, about its session's pane. */
export type TermFromBridge =
  /** The whole screen at this size: what a terminal shows after writing `d` into a fresh one. */
  | { op: 'state'; cols: number; rows: number; d: string }
  /** Output since the last `state` or `out`, in order. */
  | { op: 'out'; d: string }
  /** The pane can't be shown (gone, or the session doesn't run in tmux): why. */
  | { op: 'closed'; reason: string }

/** A page's terminal card to the server, on its `/term` socket. */
export type TermFromViewer =
  /** Typed keys: the session owner's only; anyone else's are refused. */
  | { t: 'in'; d: string; binary?: true; paste?: true }
  /** The owner asks for the pane's window to fit the card. */
  | { t: 'fit'; cols: number; rows: number }
  /** The card is off screen: stop sending output until `resume`. */
  | { t: 'pause' }
  | { t: 'resume' }

/** Why a terminal shows nothing live. */
export type TermStatus =
  | 'connecting'
  | 'live'
  /** The session's bridge isn't connected right now. */
  | 'offline'
  | 'ended'
  /** This session's terminal can't be shown at all: `reason` says why. */
  | 'unavailable'

/** The server to a page's terminal card. */
export type TermToViewer =
  /** First: who may do what. */
  | { t: 'hello'; owner: string; canType: boolean }
  | { t: 'status'; status: TermStatus; reason?: string }
  /** Reset the terminal to this size and write `d`: the whole screen. */
  | { t: 'state'; cols: number; rows: number; d: string }
  | { t: 'out'; d: string }
  /** Something the viewer asked for was refused. */
  | { t: 'refused'; reason: string }

export const TERM = {
  /** The most a single `in` carries (a paste). */
  inputLimit: 64 * 1024,
  /** Columns and rows the owner can ask for. */
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 200,
  /** Lines of history a snapshot carries above the screen. */
  history: 1000,
} as const

/** A pane's size as tmux reports it: any split, however narrow, up to a sanity cap. */
export const validScreen = (cols: unknown, rows: unknown) =>
  Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) >= 1 && (cols as number) <= 2000 && (rows as number) >= 1 && (rows as number) <= 1000

/** A size the owner may ask the pane to be (Fit pane). */
export const validSize = (cols: unknown, rows: unknown) =>
  Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) >= TERM.minCols && (cols as number) <= TERM.maxCols && (rows as number) >= TERM.minRows && (rows as number) <= TERM.maxRows

/** Who may type into a session's terminal: its owner only. Trusted agents send messages, not keys. */
export const mayType = (session: { owner: string }, identity: string) => session.owner === identity
