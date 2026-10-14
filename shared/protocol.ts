// Wire protocol shared by sphere-server, the sphere CLI/bridge and the web page.
// One WebSocket per client. Clients send `hello`, then `sub` and `cmd` messages.
import type { TermFromBridge, TermToBridge } from './terminal'

export type Role = 'bridge' | 'cli' | 'web'

/**
 * What this checkout speaks. The server names its own in `welcome`, and the bridge in its
 * `ready` line to the mod, so each side sends only what the other understands.
 * 2: events carry the Claude Code process that sent them (`holder`), for the fence below.
 * 3: transcript rows carry structured tool calls and results, and thinking rows (shared/rows.ts).
 * 4: a reply in progress is passed on a paragraph at a time (PartialReply), never stored.
 * 5: terminals. A bridge says whether its session runs in tmux, and relays its pane to the
 *    server on request (`term` messages, shared/terminal.ts).
 */
export const PROTOCOL = 5

/** The protocol from which mods, bridges and servers pass on replies in progress. */
export const PARTIAL_REPLIES = 4

/**
 * A reply the agent is still writing: its completed paragraphs so far, in one text block of one
 * model response (`turnId`, `step`, `block`). Each carries all of them, not just the newest, so one
 * lost or late doesn't garble the text. Passed to whoever has the session's transcript open and
 * never stored; the finished message arrives as a transcript row as before.
 */
export type PartialReply = {
  sessionId: string
  /** The subagent writing it; absent for the session's main agent. */
  agentId?: string
  turnId: string
  step: number
  block: number
  text: string
  at: string
}

/** The protocol from which bridges relay their session's terminal (`term` messages). */
export const TERMINALS = 5

/** The longest reply in progress passed on; past it, the finished row is waited for. */
export const PARTIAL_TEXT_LIMIT = 20_000

/**
 * The oldest bridge the server accepts: raised only when a bridge from an older checkout would
 * misbehave against this server, never just because the protocol moved on.
 */
export const BRIDGE_FLOOR = 2

/** Delivery modes from the steering model in docs/architecture.md. */
export type Mode = 'queue' | 'steer' | 'interrupt'

export type SessionState = 'working' | 'idle' | 'ended' | 'unknown'

/** The agent a session runs. Events from bridges that predate Codex support name none: Claude Code. */
export type AgentKind = 'claude' | 'codex'

/**
 * What Dyson Sphere can't do for a Codex session, and why. Codex is reached only through its
 * hooks, which run while it works: a message goes in at its next tool call or as its turn ends.
 * The server gives these as its reasons for refusing, and the canvas shows the same words.
 */
export const CODEX_CANNOT = {
  idle: "This Codex session is idle, so it can't be messaged until it's working again: Codex takes messages only at its next tool call or as its turn ends.",
  promptBox: "Codex sessions can't take text in their prompt box: Codex's hooks have no way to reach it.",
  interrupt: "Codex sessions can't be interrupted from Dyson Sphere: Codex's hooks have no way to stop a turn.",
} as const

/** A stored event. `seq` is global and monotonic; clients resume with it. */
export type StoredEvent = {
  seq: number
  topic: string
  type: string
  actor: string
  at: string
  data: Record<string, unknown>
}

/** An event a bridge sends for ingest. `key` makes ingest idempotent. */
export type IngestEvent = {
  key: string
  type: string
  data: Record<string, unknown>
  /**
   * The Claude Code process that produced it, `<machine>:<pid>`. A session belongs to the
   * process that started it last; events from any other process are dropped.
   */
  holder?: string
}

/** An event the server can never store (bad data), with Postgres's reason. */
export type IngestRejection = { key: string; error: string }

/**
 * The server's answer to `ingest`. `acked` events leave the outbox; it includes `rejected`
 * ones, which the bridge sets aside first. Servers from before `rejected` don't send it. An
 * error instead of an answer (the database is down) means: send the batch again.
 */
export type IngestResult = { acked: string[]; rejected?: IngestRejection[]; superseded?: Record<string, string> }

export type ClientMessage =
  | { t: 'hello'; token: string; role: Role; protocol?: number }
  | { t: 'sub'; topic: string; since?: number }
  | { t: 'unsub'; topic: string }
  | { t: 'cmd'; id: string; op: string; args?: Record<string, unknown> }
  /** Where this person is on the canvas. Ephemeral: rebroadcast, never stored. */
  /** `canvas`: 'tldraw' from a page on the tldraw canvas, which draws its own cursors; pages from before it send none. */
  | { t: 'presence'; cursor: Point | null; viewport: Viewport | null; selected: string | null; following: string | null; canvas?: 'tldraw' }
  /** A bridge relaying its session's terminal (protocol 5): only in answer to the server's `term`. */
  | ({ t: 'term'; sessionId: string } & TermFromBridge)

export type ServerMessage =
  /** `protocol`: the server's PROTOCOL. Servers before 3 send none. */
  | { t: 'welcome'; identity: string; conn: string; color: string; protocol?: number }
  /** A reply in progress, on its session's topic. Never stored: no seq, no replay. */
  | { t: 'partial'; partial: PartialReply }
  | { t: 'ev'; ev: StoredEvent }
  /** Replay for a `sub` is done; live events follow. */
  | { t: 'live'; topic: string; seq: number }
  /** Current summary of one session; sent on the `world` topic, never stored. */
  | { t: 'state'; session: SessionSummary }
  /** One transcript row arrived. Sent on `world` without the row's text. */
  | { t: 'activity'; activity: Activity }
  | { t: 'presence'; presence: Presence }
  | { t: 'presence.leave'; conn: string }
  /** This bridge's session is now run by another Claude Code process; the bridge goes quiet. */
  | { t: 'superseded'; sessionId: string; machine: string }
  /** Layout the server derived (card slots); not stored. */
  | { t: 'layout'; items: LayoutItem[] }
  /** What Linear says about a ticket, on `world`: sent on subscribe and when it changes. Null: Linear has no such issue. */
  | { t: 'ticket'; id: string; ticket: Ticket | null }
  /** To a bridge of protocol 5 or later: what to do with its session's terminal. Never stored. */
  | ({ t: 'term'; sessionId: string } & TermToBridge)
  | { t: 'res'; id: string; ok: true; data: unknown }
  | { t: 'res'; id: string; ok: false; error: string; code: ErrorCode }
  | { t: 'error'; error: string }

export type ErrorCode = 'user' | 'auth' | 'conflict' | 'other'

export type SessionSummary = {
  id: string
  agent: AgentKind
  owner: string
  machine: string
  cwd: string
  repo: string | null
  branch: string | null
  state: SessionState
  turnId: string | null
  lastSummary: string | null
  /** What the session was asked to do: its first prompt, one line. */
  task: string | null
  lastActivityAt: string | null
  /** When the bridge was last heard from. */
  lastSeenAt: string | null
  connected: boolean
  pendingSuggestions: number
  /** Subagents running now; the main loop can be idle while they work. */
  subagents: Subagent[]
  /** Tool calls waiting for a permission decision. */
  pendingPermissions: number
  startedAt: string
  /** What estra started the session for; null when estra didn't start it. */
  labels: SessionLabels | null
  /** The ticket it works on; one found in a branch name once Linear has it. Servers from before tickets don't send it. */
  ticket?: SessionTicket | null
  /**
   * 'tmux': its bridge runs in a tmux pane it can relay to a terminal card (protocol 5). Null when
   * it doesn't, or its bridge predates terminals; servers from before terminals don't send it.
   */
  terminal?: 'tmux' | null
}

/**
 * The labels estra gives the agents it starts, read by the bridge from ESTRA_TICKET,
 * ESTRA_STAGE, ESTRA_TASK_ID and ESTRA_PROVIDER. Optional on the wire: bridges and estras
 * from before them send none, and the session is shown unlabelled.
 */
export type SessionLabels = {
  ticket: string | null
  stage: string | null
  taskId: string | null
  /** The provider estra drew for the stage. An agent the stage started itself inherits it. */
  provider: string | null
}

/** Labels from anywhere (environment, a stored event), as short plain strings; null if none. */
export function cleanLabels(raw: unknown): SessionLabels | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const one = (v: unknown) => {
    if (typeof v !== 'string') return null
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
    return s || null
  }
  const labels = { ticket: one(r.ticket), stage: one(r.stage), taskId: one(r.taskId), provider: one(r.provider) }
  return Object.values(labels).some(Boolean) ? labels : null
}

/**
 * The frame a session's card sits in: its ticket's if it has one, otherwise its repo's. The
 * server assigns card slots in it and the canvas draws it.
 */
export function regionFor(s: { repo: string | null; labels: SessionLabels | null; ticket?: SessionTicket | null }): { id: string; title: string; ticket: string | null } {
  const ticket = s.ticket?.id ?? s.labels?.ticket ?? null
  if (ticket) return { id: `region:ticket:${ticket}`, title: ticket, ticket }
  const repo = s.repo ?? 'No repo'
  return { id: `region:${repo}`, title: repo, ticket: null }
}

/**
 * Where a session's ticket came from. Earlier ones win: estra's label, a person who attached one
 * in Dyson Sphere (`sphere`, CS-2523), the branch, then Orca. Bridges send only the last two.
 */
export type TicketSource = 'estra' | 'sphere' | 'branch' | 'orca'
/** What a bridge may send. `sphere` is left out on purpose: only the server records attachments (`session.ticket`). */
const TICKET_SOURCES: readonly TicketSource[] = ['estra', 'branch', 'orca']

/** The ticket a session works on: its id only. What the ticket says comes from Linear (`Ticket`). */
export type SessionTicket = { id: string; source: TicketSource }

/** A Linear issue as the server last read it. */
export type Ticket = {
  id: string
  title: string
  /** Always on linear.app; null if Linear gave anything else. */
  url: string | null
  /** `type` is Linear's: triage, backlog, unstarted, started, completed or canceled. */
  status: { name: string; type: string; color: string }
  assignee: string | null
}

/** A person's Linear user, as their own Linear account says (CS-2524). */
export type LinearUser = { id: string; name: string; email: string | null }

/**
 * What a page or the CLI may know about the asker's own Linear account (`linear.account`): whether
 * the server can connect one, and whom it's connected as. Never a token. Servers from before
 * Linear accounts answer `unknown op`.
 */
export type LinearAccount =
  | { enabled: false; reason: string }
  | { enabled: true; connected: false }
  | { enabled: true; connected: true; user: LinearUser; connectedAt: string }

/**
 * A ticket's statuses and people, for changing it (`ticket.options`, CS-2523). `viewer`: the
 * Linear user the change would be made as.
 */
export type TicketOptions = {
  team: { id: string; key: string; name: string }
  statuses: { id: string; name: string; type: string; color: string }[]
  members: { id: string; name: string; displayName: string | null }[]
  viewer: string
  /** Without a ticket: the teams a new one can go in. */
  teams?: { id: string; key: string; name: string }[]
  /** The ticket as Linear has it now, read as the asker. Servers from before it send none. */
  ticket?: Ticket | null
}

/** A Linear issue id, such as `CS-2488`. estra's tickets can also be Asana or Todoist ids. */
export const isLinearId = (id: string) => /^[A-Z]{1,10}-\d{1,9}$/.test(id)

/** A ticket id from anywhere, as a short plain string; Linear ids in upper case. */
export function ticketId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  if (!s) return null
  return isLinearId(s.toUpperCase()) ? s.toUpperCase() : s
}

/**
 * The Linear issue a branch is named after, in Linear's branch format: `lucadeleo/cs-2488-fix-x`,
 * `cs-2488`. The id starts a path segment and is followed by `-` or the end. Any team key
 * counts, so a branch like `deps/react-19` reads as REACT-19.
 */
export function ticketFromBranch(branch: string | null | undefined): string | null {
  const m = branch?.match(/(?:^|\/)([a-z]{2,10})-(\d{1,9})(?=-|$)/i)
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : null
}

/** The ticket a session works on, from the first place that names one. `orca` is asked last, and only if needed. */
export function findTicket(from: { estra?: string | null; branch?: string | null; orca?: () => string | null }): SessionTicket | null {
  const estra = ticketId(from.estra)
  if (estra) return { id: estra, source: 'estra' }
  const branch = ticketFromBranch(from.branch)
  if (branch) return { id: branch, source: 'branch' }
  const orca = ticketId(from.orca?.())
  return orca ? { id: orca, source: 'orca' } : null
}

/** A ticket a bridge sent, cleaned like labels; null if it isn't one. Bridges from before tickets send none. */
export function cleanTicket(raw: unknown): SessionTicket | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = ticketId(r.id)
  const source = TICKET_SOURCES.find(x => x === r.source)
  return id && source ? { id, source } : null
}

/** The ticket estra labelled a session with, as a ticket. */
export const labelTicket = (labels: SessionLabels | null): SessionTicket | null => {
  const id = ticketId(labels?.ticket)
  return id ? { id, source: 'estra' } : null
}

export type Subagent = {
  id: string
  description: string
  type: string
  background: boolean
  startedAt: string
}

/** A tool call waiting for permission, raised by the mod's PermissionRequest hook. */
export type PermissionRequest = {
  reqId: string
  sessionId: string
  tool: string
  input: string
  /**
   * `deferred`: nobody answered in time, so the agent was told to carry on without it. The
   * owner can still allow it; the agent is then told, and the retried call goes through.
   */
  state: 'pending' | 'deferred' | 'allowed' | 'denied' | 'answered-locally' | 'expired'
  decidedBy: string | null
  requestedAt: string
}

export type Suggestion = {
  id: string
  sessionId: string
  author: string
  text: string
  mode: Mode
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

/** What the server tells a bridge to do; the bridge passes it to the mod. */
export type SessionCommand =
  /** `asUser`: the owner's own words, read bare. Otherwise the mod adds who sent and who approved it. */
  | { kind: 'deliver'; msgId: string; text: string; mode: Mode; author: string; approvedBy: string | null; asUser: boolean }
  | { kind: 'interrupt'; msgId: string; author: string }
  | { kind: 'fill'; msgId: string; text: string; author: string }
  /**
   * Answers the mod's held permission request (the bridge handles it), or, for a deferred
   * request, goes to the mod, which tells the agent and lets the retried call through.
   */
  | { kind: 'permission'; msgId: string; reqId: string; decision: 'allow' | 'deny'; by: string; message: string | null }

/** Delivery states shown to the sender. */
export type DeliveryState = 'queued' | 'at-bridge' | 'injected' | 'observed' | 'failed'

export const topics = {
  world: 'world',
  presence: 'presence',
  session: (id: string) => `session:${id}`,
  bridge: (id: string) => `bridge:${id}`,
}

export const ROW_TEXT_LIMIT = 4000

export type Point = { x: number; y: number }
export type Viewport = { x: number; y: number; zoom: number }

/** A tool call named in a transcript row. */
export type ToolRef = { name: string; id: string }

export type Activity = {
  sessionId: string
  /** Set when a subagent did it. */
  agentId: string | null
  seq: number
  at: string
  kind: string
  summary: string
  /** Tool calls this row starts (tool-call rows). */
  tools: ToolRef[] | null
  /** Tool calls this row finishes (tool-result rows). */
  toolUseIds: string[] | null
}

export type Presence = {
  /** One per browser tab. */
  conn: string
  identity: string
  color: string
  cursor: Point | null
  viewport: Viewport | null
  selected: string | null
  following: string | null
  /** The page is on the tldraw canvas (CS-2554), whose cursors come from the canvas room. */
  canvas?: 'tldraw'
  at: string
}

/** A saved position on the canvas. Session positions are relative to their region. */
export type LayoutItem = {
  id: string
  kind: 'session' | 'region' | 'note'
  x: number
  y: number
  w?: number
  h?: number
  parent?: string | null
}

export type Note = {
  id: string
  text: string
  color: NoteColor
  author: string
  createdAt: string
  updatedAt: string
}

export const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'gray'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

/** Canvas geometry shared by the server (which assigns card slots) and the web app. */
export const CANVAS = {
  cardW: 300,
  cardH: 168,
  gap: 20,
  pad: 20,
  cols: 3,
  /** An ended session keeps its slot this long, while it can still be seen. */
  endedVisibleMs: 15 * 60_000,
  /** A session offline this long is hidden (a laptop that wakes up brings it back). */
  offlineVisibleMs: 2 * 3600_000,
} as const
