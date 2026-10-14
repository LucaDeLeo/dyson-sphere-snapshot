// sphere-server: event log in Postgres, world state in memory, one WebSocket protocol.
import type { HTMLBundle, ServerWebSocket } from 'bun'
import {
  BRIDGE_FLOOR,
  PARTIAL_TEXT_LIMIT,
  type PartialReply,
  CANVAS,
  CODEX_CANNOT,
  isLinearId,
  labelTicket,
  ticketId,
  ROW_TEXT_LIMIT,
  topics,
  type ClientMessage,
  type ErrorCode,
  type Activity,
  type IngestEvent,
  type IngestRejection,
  type IngestResult,
  type LayoutItem,
  type Mode,
  NOTE_COLORS,
  type NoteColor,
  type Presence,
  PROTOCOL,
  TERMINALS,
  regionFor,
  type Role,
  type ServerMessage,
  type SessionCommand,
  type SessionSummary,
  type StoredEvent,
  type Ticket,
} from '../../shared/protocol'
import { chmodSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { capRow, cleanRow } from '../../shared/rows'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import type { TLRecord } from '@tldraw/tlschema'
import { CANVAS_PAGE, type BrowserShape, CANVAS_ROOM, liveShapeId, SESSION_ID, sectionShapeId } from '../../shared/canvas'
import { mayDrive, TARGET_ID, webUrl } from '../../shared/browser'
import { validScreen, type TermFromBridge, type TermToBridge } from '../../shared/terminal'
import { Arrangement } from './arrangement'
import { Browsers, chromeAt, type BrowserViewer } from './browser'
import { Canvas } from './canvas'
import * as db from './db'
import { Linear, LINEAR_URL, LinearError, Tickets } from './linear'
import { LinearAccounts, NotConnected, oauthFromEnv } from './linear-accounts'
import { type Ask, assigneeId, ChangeError, commentOn, createTicket, optionsFor, readTicket, statusId, teams, type TicketChange, updateTicket } from './linear-changes'
import { Terminals, type TermCheck, type Viewer } from './terminals'
import { World } from './world'

const PORT = Number(process.env.SPHERE_PORT ?? 7420)

const PRODUCTION = process.env.NODE_ENV === 'production'
/** SPHERE_DEV=1: the canvas is served with hot reloading. */
const DEV = !PRODUCTION && process.env.SPHERE_DEV === '1'

/**
 * SPHERE_PEOPLE_FILE: who can use Dyson Sphere, kept by `deploy/people.ts`. Each person has
 * an identity, the Tailscale logins that sign in as them, and tokens for their bridges and
 * CLI; an agent is a person with tokens and no login. One file, so a person's browser and
 * their sessions can't end up with two different names.
 */
type Person = { identity: string; logins?: string[]; tokens?: string[] }
const PEOPLE: Person[] = process.env.SPHERE_PEOPLE_FILE ? ((await Bun.file(process.env.SPHERE_PEOPLE_FILE).json()) as { people: Person[] }).people : []

/**
 * The fixed dev tokens (`dev-luca`, …) work only on a development server: not in production,
 * with no people or tokens configured, listening on this machine only and not behind
 * Tailscale. Anywhere else they'd let anyone sign in as a teammate.
 */
const DEV_OK =
  !PRODUCTION &&
  !PEOPLE.length &&
  !process.env.SPHERE_TOKENS_FILE &&
  !process.env.SPHERE_WEB_SOCKET &&
  ['127.0.0.1', '::1', 'localhost'].includes(process.env.SPHERE_HOST ?? '127.0.0.1')

// token → identity, for bridges, agents and the CLI. People in a browser sign in through
// Tailscale (below). Also SPHERE_TOKENS="token:identity,…" or SPHERE_TOKENS_FILE (JSON).
const DEV_TOKENS = 'dev-luca:luca,dev-jp:jp,dev-bot:ops-bot'
const TOKENS = new Map<string, string>(
  process.env.SPHERE_TOKENS_FILE
    ? Object.entries(await Bun.file(process.env.SPHERE_TOKENS_FILE).json())
    : // Dev tokens only on a development server that nothing else can reach (see DEV_OK).
      (process.env.SPHERE_TOKENS ?? (DEV_OK ? DEV_TOKENS : ''))
        .split(',')
        .filter(Boolean)
        .map(pair => pair.split(':') as [string, string]),
)
for (const p of PEOPLE) for (const t of p.tokens ?? []) TOKENS.set(t, p.identity)
if (PRODUCTION && [...TOKENS.keys()].some(t => t.startsWith('dev-'))) {
  console.error('Refusing to start: dev tokens are configured in production.')
  process.exit(1)
}

// SPHERE_AUTH=tailscale: people in a browser come through `tailscale serve`, which adds the
// signed-in person's login to each request. The server trusts that header only on the Unix
// socket SPHERE_WEB_SOCKET, which `tailscale serve unix:<path>` forwards to and which only
// this server's user and root can open. The TCP port, for bridges and the CLI on this
// machine, never trusts it: anyone with an account on the machine can reach that port.
const TAILSCALE = process.env.SPHERE_AUTH === 'tailscale'
const WEB_SOCKET = process.env.SPHERE_WEB_SOCKET ?? null
if (TAILSCALE && !WEB_SOCKET) {
  console.error('Refusing to start: SPHERE_AUTH=tailscale needs SPHERE_WEB_SOCKET, the Unix socket `tailscale serve` forwards to.')
  process.exit(1)
}
const HOST = process.env.SPHERE_HOST ?? '127.0.0.1'
// The page's origin, if the proxy in front doesn't pass the original Host on.
const ORIGIN = process.env.SPHERE_ORIGIN ?? null
// Who a Tailscale login is: an explicit map ("luca@example.org:luca,…"), or the part before @
// for logins in SPHERE_LOGIN_DOMAIN. Any other login is refused: tailnets can include
// people from outside the team.
const LOGINS = new Map((process.env.SPHERE_LOGINS ?? '').split(',').filter(Boolean).map(p => p.split(':') as [string, string]).map(([l, id]) => [l.toLowerCase(), id]))
for (const p of PEOPLE) for (const l of p.logins ?? []) LOGINS.set(l.toLowerCase(), p.identity)
const LOGIN_DOMAIN = process.env.SPHERE_LOGIN_DOMAIN?.toLowerCase()
function identityFromLogin(login: string): string | null {
  const mapped = LOGINS.get(login.toLowerCase())
  if (mapped) return mapped
  const [local, domain] = login.toLowerCase().split('@')
  return LOGIN_DOMAIN && domain === LOGIN_DOMAIN && local ? local : null
}
if (TAILSCALE && !LOGINS.size && !LOGIN_DOMAIN) console.warn('SPHERE_AUTH=tailscale with no SPHERE_LOGINS or SPHERE_LOGIN_DOMAIN: nobody can sign in.')

// owner → identities whose messages skip approval on the owner's sessions.
const TRUST = new Map<string, Set<string>>()
for (const pair of (process.env.SPHERE_TRUST ?? '').split(',').filter(Boolean)) {
  const [owner, trusted] = pair.split(':') as [string, string]
  TRUST.set(owner, (TRUST.get(owner) ?? new Set()).add(trusted))
}

/** `attached`: the sessions a bridge reports for, each with the Claude Code process it speaks for. */
/** `subs`: the latest subscription to each topic, so an unsubscribe cancels one still waiting. */
/** `canvas`: a `/canvas` socket, which speaks tldraw's sync protocol: its session in the room once open. */
type Conn = {
  id: string
  identity: string | null
  login: string | null
  role: Role | null
  attached: Map<string, string | null>
  presence: Presence | null
  via: number
  subs: Map<string, symbol>
  canvas?: { session: string | null }
  /** The protocol the client named in its hello (1 if none). */
  protocol?: number
  /** A `/term` socket: a page's terminal card watching this session. */
  term?: { sessionId: string; viewer: Viewer; tooMany?: boolean }
  /** A `/browser` socket: a page's browser card watching this tab. */
  browser?: { targetId: string; viewer: BrowserViewer; tooMany?: boolean }
}

// A stable color per person, for cursors and avatars. Same hue order the canvas uses.
const PERSON_COLORS = ['oklch(0.55 0.17 255)', 'oklch(0.53 0.14 155)', 'oklch(0.55 0.2 330)', 'oklch(0.54 0.12 210)', 'oklch(0.55 0.19 290)', 'oklch(0.56 0.18 30)']
const colorFor = (identity: string) => {
  let h = 0
  for (const c of identity) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PERSON_COLORS[h % PERSON_COLORS.length]!
}
const presences = new Map<string, Presence>() // conn id → presence

class CmdError extends Error {
  constructor(message: string, readonly code: ErrorCode = 'user') {
    super(message)
  }
}

await db.migrate()
const world = new World()
const canvas = await Canvas.open(
  CANVAS_ROOM,
  { load: db.loadRoom, save: db.saveRoom },
  {
    sectionOf: id => {
      const s = world.sessions.get(id)
      return s ? sectionShapeId(regionFor(s).id) : null
    },
    onPagesChanged: ids => pagesChanged(ids),
    onLiveRemoved: shapes => {
      // A browser card removed for good: its tab closes, unless another card shows it.
      for (const shape of shapes) {
        if (shape.type !== 'browser') continue
        const { targetId } = (shape as BrowserShape).props
        if (canvas.records().some(r => r.typeName === 'shape' && r.type === 'browser' && (r as BrowserShape).props.targetId === targetId)) continue
        void serially(async () => {
          if (!world.tabs.has(targetId)) return
          await record({ topic: topics.world, type: 'browser.closed', actor: 'canvas', data: { targetId } })
        }).catch(e => console.error('browser: recording a closed tab:', e))
        void browsers.closeTab(targetId)
      }
    },
  },
)
for await (const ev of db.all()) world.apply(ev)
const arrangement = new Arrangement(world, canvas, e => record(e))

/** What pages change in the room, recorded as events a few hundred ms later: one per drag, not one per frame. */
const changedByPages = new Set<string>()
let pagesTimer: ReturnType<typeof setTimeout> | null = null
function pagesChanged(ids: string[]) {
  for (const id of ids) changedByPages.add(id)
  pagesTimer ??= setTimeout(() => void recordPageChanges(), 300)
}
function recordPageChanges(): Promise<void> {
  if (pagesTimer) clearTimeout(pagesTimer)
  pagesTimer = null
  const batch = [...changedByPages]
  changedByPages.clear()
  return serially(() => arrangement.fromPages(batch)).catch(e => {
    // Postgres refused, perhaps for a moment: the batch is tried again with the next one, a
    // second later at the latest. What's already recorded is skipped (fromPages records differences).
    console.error('canvas: recording what pages changed (trying again):', e)
    for (const id of batch) changedByPages.add(id)
    pagesTimer ??= setTimeout(() => void recordPageChanges(), 1000)
  })
}
const bridges = new Map<string, number>() // sessionId → live bridge connections
const sockets = new Set<ServerWebSocket<Conn>>()

const send = (ws: ServerWebSocket<Conn>, m: ServerMessage) => ws.send(JSON.stringify(m))

// Linear: SPHERE_LINEAR_KEY, read every SPHERE_LINEAR_POLL_SECONDS (60). SPHERE_LINEAR_URL
// points it at a stand-in, for tests and the demo.
const linear = new Linear({ url: process.env.SPHERE_LINEAR_URL || LINEAR_URL })
const tickets = new Tickets({
  linear,
  key: process.env.SPHERE_LINEAR_KEY || null,
  changed: (id, ticket) => {
    publish(topics.world, JSON.stringify({ t: 'ticket', id, ticket } satisfies ServerMessage))
    if (ticket) void confirm(id)
  },
})

// Each person's own Linear account (CS-2524), for changes made as them. Off without
// SPHERE_LINEAR_CLIENT_ID, SPHERE_LINEAR_CLIENT_SECRET and SPHERE_LINEAR_TOKEN_KEY.
// Linear sends people back to the canvas's own address: SPHERE_ORIGIN, or this machine in development.
const linearOAuth = oauthFromEnv(process.env, { origin: ORIGIN ?? (PRODUCTION ? null : `http://${HOST}:${PORT}`), linearUrl: process.env.SPHERE_LINEAR_URL || null })
const accounts = new LinearAccounts({ linear, store: db.linearGrants, ...linearOAuth })
if (!accounts.enabled) console.warn(`Linear: ${accounts.reason}`)

/** Linear's callback, after a person said yes (or no): back to the canvas, which says how it went. */
async function linearCallback(url: URL, signedIn: string | null): Promise<Response> {
  const back = (params: Record<string, string>) => new Response(null, { status: 303, headers: { location: `/?${new URLSearchParams(params)}`, 'cache-control': 'no-store' } })
  try {
    const { identity, user } = await accounts.finish({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error') }, signedIn)
    console.log(`Linear: ${identity} connected as ${user.name}.`)
    return back({ linear: 'connected' })
  } catch (e) {
    if (!(e instanceof NotConnected || e instanceof LinearError)) console.error('Linear: finishing a connection:', e)
    return back({ linear: 'failed', why: e instanceof NotConnected || e instanceof LinearError ? e.message : 'Something went wrong; see the server log.' })
  }
}

/**
 * Linear has this ticket: sessions that found its id in their branch name show it, in its
 * frame. Recorded once per id, so it holds after a restart while Linear can't be reached;
 * and inside `serially`, like every event, so the world applies events in log order.
 */
function confirm(id: string): Promise<void> {
  return serially(async () => {
    if (!world.awaitsConfirmation(id)) return
    try {
      await record({ key: `ticket.confirmed:${id}`, topic: topics.world, type: 'ticket.confirmed', actor: 'linear', data: { id } })
    } catch (e) {
      console.warn(`Linear: couldn't record that ${id} exists (${(e as Error).message}); trying again after the next read.`)
      return
    }
    publishSlots([...world.found].flatMap(([sessionId, t]) => (t.id === id ? [sessionId] : [])))
  })
}

/** The Linear tickets of the sessions a canvas shows by default: not ended long ago, not offline for hours. */
function liveTickets(): string[] {
  const now = Date.now()
  const ids = new Set<string>()
  for (const s of world.sessions.values()) {
    // Including ids found in branch names that Linear hasn't confirmed yet.
    const id = world.found.get(s.id)?.id
    if (!id || !isLinearId(id)) continue
    const quiet = now - Date.parse(s.lastSeenAt ?? s.startedAt)
    if (s.state === 'ended' ? quiet < CANVAS.endedVisibleMs : s.connected || quiet < CANVAS.offlineVisibleMs) ids.add(id)
  }
  return [...ids]
}

/** What Linear says about these sessions' tickets, by id. */
const ticketsOf = (sessions: SessionSummary[]): Record<string, Ticket> =>
  Object.fromEntries(sessions.flatMap(s => (s.ticket && tickets.known.has(s.ticket.id) ? [[s.ticket.id, tickets.known.get(s.ticket.id)!]] : [])))
/** The world gave these sessions slots; tell the canvases (not stored: it follows from the log). */
const publishSlots = (ids: string[]) => {
  const items = ids.flatMap(id => world.layout.get(id) ?? [])
  if (items.length) publish(topics.world, JSON.stringify({ t: 'layout', items } satisfies ServerMessage))
}
const publishState = (ids: string[]) => {
  for (const id of ids) {
    const session = world.sessions.get(id)
    if (session) publish(topics.world, JSON.stringify({ t: 'state', session } satisfies ServerMessage))
    terminals.refresh(id)
  }
}

// ---------- terminal cards (shared/terminal.ts, server/src/terminals.ts) ----------

/**
 * SPHERE_TERMINAL_MACHINES: the machines whose sessions' terminals the canvas may show, as their
 * bridges name them. By default this server's own: sessions people run on the team server. A
 * laptop's tmux isn't offered yet.
 */
const TERMINAL_MACHINES = new Set((process.env.SPHERE_TERMINAL_MACHINES ?? hostname()).split(',').map(m => m.trim()).filter(Boolean))
/** The most live card sockets (terminals, browser tabs) one person may have open at once, across pages and cards. */
const TERM_SOCKETS_PER_PERSON = 24
const tooManyLiveCards = `You have ${TERM_SOCKETS_PER_PERSON} live cards (terminals and browser tabs) open already, in this page and others. Close some pages, or remove cards you don't need.`
const termSockets = new Map<string, number>()

/** The bridge connection that relays a session's terminal: its current process's, protocol 5 or later, signed in as its owner. */
function termBridge(s: SessionSummary): ServerWebSocket<Conn> | null {
  const holder = holderOf(s.id)
  for (const ws of sockets) {
    const c = ws.data
    if (c.role === 'bridge' && c.identity === s.owner && c.attached.has(s.id) && c.attached.get(s.id) === holder && (c.protocol ?? 1) >= TERMINALS) return ws
  }
  return null
}

function termCheck(id: string): TermCheck {
  const s = world.sessions.get(id)
  if (!s) return null
  const owner = s.owner
  if (s.state === 'ended') return { owner, status: 'ended' }
  if (!TERMINAL_MACHINES.has(s.machine))
    return { owner, status: 'unavailable', reason: `Terminal cards show sessions on ${[...TERMINAL_MACHINES].join(', ')} for now. This one runs on ${s.machine}.` }
  if (!termBridge(s)) {
    const holder = holderOf(id)
    const older = [...sockets].some(ws => ws.data.role === 'bridge' && ws.data.attached.get(id) === holder)
    return older
      ? { owner, status: 'unavailable', reason: "This session's sphere bridge predates terminal cards. It gets one once sphere is updated (dyson-sphere/install.sh) and the session restarted." }
      : { owner, status: 'offline' }
  }
  if (s.terminal !== 'tmux') return { owner, status: 'unavailable', reason: "This session doesn't run in tmux, so there's no terminal to show. Sessions started in tmux show theirs here." }
  return { owner, status: 'live' }
}

// ---------- browser cards (shared/browser.ts, server/src/browser.ts) ----------

/** SPHERE_BROWSER_PROFILE: the profile directory of the Chrome whose tabs browser cards show. Unset: none. */
const BROWSER_PROFILE = process.env.SPHERE_BROWSER_PROFILE || null
const browsers = new Browsers({
  chrome: BROWSER_PROFILE ? chromeAt(BROWSER_PROFILE) : null,
  check: targetId => {
    const tab = world.tabs.get(targetId)
    const s = tab && world.sessions.get(tab.sessionId)
    return s ? { owner: s.owner, sessionId: s.id } : null
  },
  graceMs: Number(process.env.SPHERE_TERMINAL_GRACE_MS) || undefined,
})
/** The most tabs open for one session, and for all, through browser cards. */
const TABS_PER_SESSION = 8
const TABS = 40
/** Above every shape: a new card goes on top. */
const topIndex = (): IndexKey => {
  let top: IndexKey | null = null
  for (const r of canvas.records()) if (r.typeName === 'shape' && (!top || r.index > top)) top = r.index
  return getIndexAbove(top)
}

const terminals = new Terminals({
  check: termCheck,
  toBridge(id, m: TermToBridge) {
    const s = world.sessions.get(id)
    const ws = s && termBridge(s)
    if (!ws) return false
    send(ws, { t: 'term', sessionId: id, ...m })
    return true
  },
  graceMs: Number(process.env.SPHERE_TERMINAL_GRACE_MS) || undefined,
})

/** A bridge's `term` message: only from its session's current process, signed in as the owner, and well formed. */
function termFromBridge(conn: Conn, m: Record<string, unknown>) {
  const id = String(m.sessionId ?? '')
  const s = world.sessions.get(id)
  if (conn.role !== 'bridge' || !s || s.owner !== conn.identity || !conn.attached.has(id) || conn.attached.get(id) !== holderOf(id)) return
  const d = m.d
  let msg: TermFromBridge | null = null
  if (m.op === 'state' && typeof d === 'string' && validScreen(m.cols, m.rows)) msg = { op: 'state', cols: m.cols as number, rows: m.rows as number, d }
  else if (m.op === 'out' && typeof d === 'string') msg = { op: 'out', d }
  else if (m.op === 'closed') msg = { op: 'closed', reason: typeof m.reason === 'string' ? m.reason.slice(0, 300) : "The terminal can't be shown." }
  if (msg) terminals.fromBridge(id, msg)
}

async function record(e: { key?: string; topic: string; type: string; actor: string; data: Record<string, unknown> }) {
  const ev = await db.append(e)
  if (!ev) return null
  publishState(world.apply(ev))
  // The room follows (it logs what it can't, and catches up at the next start).
  await arrangement.onEvent(ev)
  publish(ev.topic, JSON.stringify({ t: 'ev', ev } satisfies ServerMessage))
  if (ev.type === 'session.row') publish(topics.world, JSON.stringify({ t: 'activity', activity: toActivity(ev) } satisfies ServerMessage))
  return ev
}

/** The light form of a transcript row: what the canvas animates, without the text. */
function toActivity(ev: StoredEvent): Activity {
  const d = ev.data as Record<string, any>
  return {
    sessionId: d.sessionId,
    agentId: d.agentId ?? null,
    seq: ev.seq,
    at: ev.at,
    kind: d.kind,
    summary: String(d.summary ?? '').slice(0, 160),
    tools: Array.isArray(d.tools) ? d.tools : null,
    toolUseIds: Array.isArray(d.toolUseIds) ? d.toolUseIds : null,
  }
}

const ownerOrTrusted = (session: SessionSummary, actor: string) =>
  session.owner === actor || (TRUST.get(session.owner)?.has(actor) ?? false)

/**
 * Whose Linear account a change goes through (CS-2523). The asker's own, when they've connected
 * one. Otherwise, an agent the session's owner trusts acts through the owner's, but only on that
 * session: its ticket, or a ticket made for it or attached to it. Anyone else is refused.
 */
async function linearAs(actor: string, s: SessionSummary | null, ticket: string | null): Promise<string> {
  if (!accounts.enabled) throw new CmdError(accounts.reason)
  const own = await accounts.account(actor)
  if (own.enabled && own.connected) return actor
  if (s && s.owner !== actor && ownerOrTrusted(s, actor)) {
    if (ticket && ticket !== s.ticket?.id) throw new CmdError(`acting for ${s.owner}, you can change only this session's ticket (${s.ticket?.id ?? 'none'}); connect your own Linear account for others`, 'auth')
    const owner = await accounts.account(s.owner)
    if (owner.enabled && owner.connected) return s.owner
    throw new CmdError(`${s.owner} hasn't connected a Linear account to Dyson Sphere, so their trusted agents can't change tickets for them`, 'auth')
  }
  throw new CmdError('connect your Linear account first: Connect Linear in a session on the canvas, or `sphere linear connect`', 'auth')
}

/** One person's Linear, for linear-changes.ts. */
const askAs = (identity: string): Ask => (query, variables) => accounts.request(identity, query, variables)

/** What Linear or a person's connection refused, as the command's error. */
async function inLinear<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof CmdError) throw e
    if (e instanceof ChangeError) throw new CmdError(e.message)
    if (e instanceof NotConnected) throw new CmdError(e.message, 'auth')
    // FORBIDDEN: a connected account Linear doesn't let do this (another team's ticket, say).
    if (e instanceof LinearError && (e.code === 'FORBIDDEN' || e.status === 403)) throw new CmdError("Linear doesn't let this Linear account do that", 'user')
    if (e instanceof LinearError) throw new CmdError(e.message, e.kind === 'auth' ? 'auth' : e.kind === 'rejected' ? 'user' : 'other')
    throw e
  }
}

/** A Linear ticket id from a command, or the session's ticket. */
function ticketOf(raw: unknown, s: SessionSummary | null): string {
  const id = ticketId(raw) ?? s?.ticket?.id ?? null
  if (!id) throw new CmdError(s ? `session ${s.id.slice(0, 8)} has no ticket; name one` : 'which ticket? give its id, such as CS-123')
  if (!isLinearId(id)) throw new CmdError(`${id} isn't a Linear ticket`)
  return id
}

/** A ticket can be attached to this session by this person. */
function attachable(s: SessionSummary, actor: string) {
  if (!ownerOrTrusted(s, actor)) throw new CmdError(`only ${s.owner} or agents they trust can attach a ticket to ${s.id.slice(0, 8)}`, 'auth')
  if (labelTicket(s.labels)) throw new CmdError(`estra started ${s.id.slice(0, 8)} for ${s.labels!.ticket}, so that stays its ticket`)
}

/** Records that a person attached a ticket to a session (in `serially`, like every event; checked again there). */
const attachTicket = (s: SessionSummary, actor: string, id: string) =>
  serially(async () => {
    attachable(world.sessions.get(s.id) ?? s, actor)
    await record({ topic: topics.world, type: 'session.ticket', actor, data: { sessionId: s.id, id } })
    publishSlots([s.id])
  })

function session(ref: unknown): SessionSummary {
  if (typeof ref !== 'string' || !ref) throw new CmdError('session id required')
  const s = world.resolveSession(ref)
  if (s === 'ambiguous') throw new CmdError(`session prefix ${ref} matches more than one session`)
  if (!s) throw new CmdError(`no session ${ref}`)
  return s
}

const mode = (m: unknown): Mode => (m === 'steer' || m === 'interrupt' ? m : 'queue')

/**
 * Refuses what Codex's hooks can't carry. A message reaches a Codex session only from a hook
 * of the turn it's working on, so one sent while it's idle would wait unseen.
 */
function codexCan(s: SessionSummary, what: 'message' | 'interrupt' | 'fill', m?: Mode) {
  if (s.agent !== 'codex') return
  if (what === 'fill') throw new CmdError(CODEX_CANNOT.promptBox)
  if (what === 'interrupt' || m === 'interrupt') throw new CmdError(CODEX_CANNOT.interrupt)
  if (s.state !== 'working') throw new CmdError(CODEX_CANNOT.idle, 'conflict')
}
const text = (t: unknown): string => {
  if (typeof t !== 'string' || !t.trim()) throw new CmdError('text required')
  return t
}

async function issue(s: SessionSummary, actor: string, command: Exclude<SessionCommand, { kind: 'permission' }>, shownText: string | null) {
  const holder = heldBy(s)
  await record({
    topic: topics.world,
    type: 'delivery',
    actor,
    data: { msgId: command.msgId, sessionId: s.id, author: command.author, text: shownText, kind: command.kind, state: 'queued' },
  })
  await record({ topic: topics.bridge(s.id), type: 'command.issued', actor, data: { sessionId: s.id, holder, command } })
  return { msgId: command.msgId, sessionId: s.id, state: 'queued' }
}

/** Commands name the process they're for: a moved session's old terminal must not act on them. */
const holderOf = (sessionId: string) => world.holders.get(sessionId)?.current ?? null

/**
 * The process a command for this session goes to. Every current bridge names its process when
 * it starts a session, so a session without one hasn't run under this version since it was
 * recorded. A command for it would belong to no process, and could run once per process that
 * later started it, so it's refused instead.
 */
function heldBy(s: SessionSummary): string {
  const h = holderOf(s.id)
  if (!h) throw new CmdError(`session ${s.id.slice(0, 8)} hasn't run since Dyson Sphere was updated; restart it to message it`, 'conflict')
  return h
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`

const INGEST_TYPES = new Set(['session.started', 'session.row', 'session.status', 'session.ended', 'session.agent', 'delivery', 'permission.requested', 'permission.resolved'])

/**
 * `rejected`: events the database refused and always will (bad data). They are acknowledged
 * too, so they don't hold up the rest: bridges from before `rejected` drop them, as they drop
 * malformed events; newer ones set them aside in a dead-letter file. Any other failure fails
 * the whole command, and the bridge sends the batch again (stored events are skipped by key).
 */
async function ingest(conn: Conn, events: IngestEvent[]) {
  const actor = conn.identity!
  const acked: string[] = []
  const rejected: IngestRejection[] = []
  const superseded = new Map<string, string>() // sessionId → the machine it runs on now
  for (const sent of events) {
    // Made storable before anything is checked, so what is checked is what is stored: `<id>\0`
    // mustn't pass the owner check below as a new session and then be stored as `<id>`. The
    // key stays as sent: it's how the bridge knows the event.
    const e = { ...sent, data: db.storable(sent.data), holder: db.storable(sent.holder) }
    const sessionId = e.data.sessionId as string | undefined
    if (!INGEST_TYPES.has(e.type) || !sessionId) {
      acked.push(e.key) // drop malformed events rather than block the outbox
      continue
    }
    const known = world.sessions.get(sessionId)
    if (known && known.owner !== actor) throw new CmdError(`session ${sessionId} belongs to ${known.owner}`, 'auth')
    const starting = e.type === 'session.started'
    if (!world.accepts(sessionId, e.holder, starting)) {
      // Another Claude Code process runs this session now (it was moved or resumed elsewhere).
      // Acknowledged so the sender's outbox drains, but not recorded.
      const current = holderOf(sessionId) ?? ''
      superseded.set(sessionId, current.slice(0, current.lastIndexOf(':')))
      acked.push(e.key)
      continue
    }
    const previous = holderOf(sessionId)
    const data = { ...e.data }
    if (starting && e.holder) data.holder = e.holder
    // Only the server sets these, from the stored body.
    delete data.bodyId
    delete data.fullLength
    const topic = e.type === 'session.row' ? topics.session(sessionId) : topics.world
    try {
      if (e.type === 'session.row' && typeof data.text === 'string' && data.text.length > ROW_TEXT_LIMIT) {
        data.bodyId = await db.putBody(data.text)
        data.fullLength = data.text.length
        data.text = data.text.slice(0, ROW_TEXT_LIMIT)
      }
      if (e.type === 'session.row') {
        // Structured tool calls and results: long fields are stored as bodies, fetched on demand.
        cleanRow(data)
        await capRow(data, db.putBody)
      }
      await record({ key: e.key, topic, type: e.type, actor, data })
    } catch (err) {
      if (!db.refusedData(err)) throw err
      // Logged once: it isn't sent again.
      console.warn(`ingest: refused ${e.type} ${JSON.stringify(e.key)} of session ${sessionId.slice(0, 8)} for ${actor}: ${err.message} (${err.errno})`)
      rejected.push({ key: e.key, error: `${err.message} (${err.errno})` })
      acked.push(e.key)
      continue
    }
    if (starting) {
      if (previous && previous !== e.holder) supersede(sessionId, e.holder!)
      attach(conn, sessionId, e.holder ?? null)
      const found = world.found.get(sessionId)
      if (found) {
        tickets.soon(found.id)
        // Read already, for another session: no new read will report it. (Queued after this
        // ingest, which runs inside `serially`.)
        if (tickets.known.has(found.id)) void confirm(found.id)
      }
      publishSlots([sessionId])
    }
    acked.push(e.key)
  }
  return { acked, rejected, superseded: Object.fromEntries(superseded) } satisfies IngestResult
}

function attach(conn: Conn, sessionId: string, holder: string | null) {
  if (conn.attached.get(sessionId) === holder) return
  if (!conn.attached.has(sessionId)) bridges.set(sessionId, (bridges.get(sessionId) ?? 0) + 1)
  conn.attached.set(sessionId, holder)
  publishState(world.setConnected(sessionId, true))
  terminals.refresh(sessionId)
  // Its card, if it retired while the session was away. After whatever runs now.
  void serially(() => arrangement.revive(sessionId)).catch(e => console.error('canvas: restoring a card:', e))
}

function detach(ws: ServerWebSocket<Conn>, sessionId: string) {
  if (!ws.data.attached.delete(sessionId)) return
  try {
    ws.unsubscribe(topics.bridge(sessionId))
  } catch {} // already closed
  const n = (bridges.get(sessionId) ?? 1) - 1
  bridges.set(sessionId, n)
  if (n <= 0) publishState(world.setConnected(sessionId, false))
  terminals.refresh(sessionId)
}

/** A new Claude Code process took the session over: the bridges of the old one go quiet. */
function supersede(sessionId: string, holder: string) {
  const machine = holder.slice(0, holder.lastIndexOf(':'))
  for (const ws of sockets) {
    const h = ws.data.attached.get(sessionId)
    if (h === undefined || h === holder) continue
    send(ws, { t: 'superseded', sessionId, machine })
    detach(ws, sessionId)
  }
}

async function command(conn: Conn, op: string, a: Record<string, unknown>): Promise<unknown> {
  const actor = conn.identity!
  switch (op) {
    case 'ingest':
      if (conn.role !== 'bridge') throw new CmdError('only bridges ingest', 'auth')
      return ingest(conn, (a.events as IngestEvent[]) ?? [])

    case 'partial': {
      // A reply in progress, passed to whoever has the session open and never stored. Only from
      // the bridge of the process that runs the session, as for its rows.
      if (conn.role !== 'bridge') throw new CmdError('only bridges send replies in progress', 'auth')
      const id = String(a.sessionId ?? '')
      const s = world.sessions.get(id)
      if (!s || s.owner !== actor) throw new CmdError('not your session', 'auth')
      if (!world.accepts(id, typeof a.holder === 'string' ? a.holder : undefined, false)) return { sent: false }
      const text = typeof a.text === 'string' ? a.text : ''
      const step = Number(a.step)
      const block = Number(a.block)
      if (!text.trim() || text.length > PARTIAL_TEXT_LIMIT || typeof a.turnId !== 'string' || !Number.isInteger(step) || !Number.isInteger(block)) return { sent: false }
      const agentId = typeof a.agentId === 'string' && a.agentId ? a.agentId.slice(0, 200) : undefined
      // One that arrives late, once its turn is over, isn't passed on: its row has replaced it. A
      // subagent's turnId is its own run's, so it is held to the subagent still running instead
      // (one in the background runs on after the main agent's turn).
      const current = agentId ? s.subagents.some(x => x.id === agentId) : s.state === 'working' && s.turnId === a.turnId
      if (!current) return { sent: false }
      const partial: PartialReply = { sessionId: id, ...(agentId && { agentId }), turnId: a.turnId.slice(0, 200), step, block, text, at: new Date().toISOString() }
      publish(topics.session(id), JSON.stringify({ t: 'partial', partial } satisfies ServerMessage))
      return { sent: true }
    }

    case 'attach': {
      if (conn.role !== 'bridge') throw new CmdError('only bridges attach', 'auth')
      const s = world.sessions.get(String(a.sessionId))
      if (s && s.owner !== actor) throw new CmdError('not your session', 'auth')
      const holder = typeof a.holder === 'string' ? a.holder : undefined
      // A new process may attach before its session.started arrives and takes the session
      // over; until then, commands still name the old one.
      if (s && !world.accepts(s.id, holder, true)) {
        const current = holderOf(s.id)!
        throw new CmdError(`session ${s.id.slice(0, 8)} now runs on ${current.slice(0, current.lastIndexOf(':'))}`, 'conflict')
      }
      if (s) attach(conn, s.id, holder ?? null)
      return { attached: !!s }
    }

    case 'status': {
      const sessions = [...world.sessions.values()]
        .filter(s => a.all || s.state !== 'ended')
        .sort((x, y) => (y.lastActivityAt ?? '').localeCompare(x.lastActivityAt ?? ''))
      return { sessions, tickets: ticketsOf(sessions) }
    }

    case 'show': {
      // The last `tail` rows, or with `before`, the last `tail` rows older than that seq: a page
      // further back. `more`: older rows remain. A server before paging ignores `before`.
      const s = session(a.sessionId)
      const limit = Math.max(0, Math.min(Number(a.tail ?? 50) || 0, 1000))
      const before = a.before === undefined || a.before === null ? null : Number(a.before)
      if (before !== null && !(Number.isSafeInteger(before) && before > 0)) throw new CmdError('before must be a row seq')
      const page = limit ? await db.tail(topics.session(s.id), limit + 1, before) : []
      const more = page.length > limit
      const rows = more ? page.slice(1) : page
      const deliveries = [...world.deliveries.values()].filter(d => d.sessionId === s.id).slice(-20)
      return { session: s, rows, deliveries, more, tickets: ticketsOf([s]) }
    }

    case 'search': {
      // A session's rows that contain the text, newest first: find in transcript beyond the rows loaded.
      const s = session(a.sessionId)
      const q = typeof a.query === 'string' ? a.query.trim() : ''
      if (!q) throw new CmdError('query required')
      return { seqs: await db.search(topics.session(s.id), q.slice(0, 200), 500) }
    }

    case 'body': {
      const body = await db.getBody(String(a.id))
      if (body === null) throw new CmdError(`no body ${a.id}`)
      return { id: a.id, text: body }
    }

    case 'send': {
      const s = session(a.sessionId)
      if (!ownerOrTrusted(s, actor)) throw new CmdError(`only ${s.owner} or agents they trust can send to ${s.id.slice(0, 8)}; use suggest`, 'auth')
      const t = text(a.text)
      codexCan(s, 'message', mode(a.mode))
      return issue(s, actor, { kind: 'deliver', msgId: newId('m'), text: t, mode: mode(a.mode), author: actor, approvedBy: null, asUser: actor === s.owner }, t)
    }

    case 'suggest': {
      const s = session(a.sessionId)
      const t = text(a.text)
      if (ownerOrTrusted(s, actor)) return command(conn, 'send', a)
      // Waiting for approval is fine while it's idle; an interrupt never will be.
      if (s.agent === 'codex' && mode(a.mode) === 'interrupt') throw new CmdError(CODEX_CANNOT.interrupt)
      const id = newId('a')
      await record({ topic: topics.world, type: 'suggestion.created', actor, data: { id, sessionId: s.id, text: t, mode: mode(a.mode) } })
      return { suggestionId: id, sessionId: s.id, status: 'pending', owner: s.owner }
    }

    case 'approvals': {
      const pending = [...world.suggestions.values()].filter(x => x.status === 'pending')
      return { suggestions: a.all ? pending : pending.filter(x => world.sessions.get(x.sessionId)?.owner === actor) }
    }

    case 'approve':
    case 'reject': {
      const sug = world.suggestions.get(String(a.id))
      if (!sug) throw new CmdError(`no suggestion ${a.id}`)
      const s = session(sug.sessionId)
      if (s.owner !== actor) throw new CmdError(`only ${s.owner} can ${op} suggestions on this session`, 'auth')
      if (sug.status !== 'pending') throw new CmdError(`suggestion ${sug.id} is already ${sug.status}`, 'conflict')
      if (op === 'reject') {
        await record({ topic: topics.world, type: 'suggestion.rejected', actor, data: { id: sug.id, sessionId: s.id } })
        return { suggestionId: sug.id, status: 'rejected' }
      }
      heldBy(s) // before the approval is recorded: a suggestion isn't approved if it can't be sent
      codexCan(s, 'message', sug.mode)
      const t = typeof a.text === 'string' && a.text.trim() ? a.text : sug.text
      await record({ topic: topics.world, type: 'suggestion.approved', actor, data: { id: sug.id, sessionId: s.id, text: t, edited: t !== sug.text } })
      const sent = await issue(s, actor, { kind: 'deliver', msgId: newId('m'), text: t, mode: sug.mode, author: sug.author, approvedBy: actor, asUser: false }, t)
      return { suggestionId: sug.id, status: 'approved', ...sent }
    }

    case 'interrupt': {
      const s = session(a.sessionId)
      if (!ownerOrTrusted(s, actor)) throw new CmdError('only the owner or a trusted agent can interrupt', 'auth')
      codexCan(s, 'interrupt')
      return issue(s, actor, { kind: 'interrupt', msgId: newId('m'), author: actor }, null)
    }

    case 'fill': {
      const s = session(a.sessionId)
      if (!ownerOrTrusted(s, actor)) throw new CmdError('only the owner can fill their prompt box', 'auth')
      codexCan(s, 'fill')
      const t = text(a.text)
      return issue(s, actor, { kind: 'fill', msgId: newId('m'), text: t, author: actor }, t)
    }

    case 'permissions': {
      // One session's requests in any state, for its transcript: each shows at its tool call.
      if (a.sessionId !== undefined) {
        const s = session(a.sessionId)
        return { permissions: [...world.permissions.values()].filter(p => p.sessionId === s.id) }
      }
      const pending = [...world.permissions.values()].filter(p => p.state === 'pending' || p.state === 'deferred')
      const mine = pending.filter(p => world.sessions.get(p.sessionId)?.owner === actor)
      return { permissions: a.all ? pending : mine }
    }

    case 'decide': {
      const p = world.permissions.get(String(a.reqId))
      if (!p) throw new CmdError(`no permission request ${a.reqId}`)
      const s = session(p.sessionId)
      // Approving a tool call runs code on the owner's machine, so only the owner decides.
      if (s.owner !== actor) throw new CmdError(`only ${s.owner} can decide permission requests on this session`, 'auth')
      if (p.state !== 'pending' && p.state !== 'deferred') throw new CmdError(`request ${p.reqId} is already ${p.state}`, 'conflict')
      const holder = heldBy(s)
      const decision = a.decision === 'allow' ? 'allow' : a.decision === 'deny' ? 'deny' : null
      if (!decision) throw new CmdError('decision must be allow or deny')
      const message = typeof a.message === 'string' && a.message.trim() ? a.message : null
      const deferred = p.state === 'deferred'
      await record({ topic: topics.world, type: 'permission.decided', actor, data: { reqId: p.reqId, sessionId: s.id, decision, by: actor, message } })
      const command: SessionCommand = { kind: 'permission', msgId: newId('m'), reqId: p.reqId, decision, by: actor, message }
      if (deferred) {
        // The agent moved on without it; the mod tells it the outcome, like any message.
        const shown = `${decision === 'allow' ? 'Allowed' : 'Declined'}: ${p.tool} ${p.input}`.slice(0, 300)
        await record({ topic: topics.world, type: 'delivery', actor, data: { msgId: command.msgId, sessionId: s.id, author: actor, text: shown, kind: 'permission', state: 'queued' } })
      }
      await record({ topic: topics.bridge(s.id), type: 'command.issued', actor, data: { sessionId: s.id, holder, command } })
      return { reqId: p.reqId, decision, ...(deferred && { msgId: command.msgId }) }
    }

    case 'moved': {
      const s = session(a.sessionId)
      if (s.owner !== actor) throw new CmdError('only the owner can move a session', 'auth')
      await record({ topic: topics.world, type: 'session.moved', actor, data: { sessionId: s.id, from: { machine: s.machine, cwd: s.cwd }, to: a.to, wip: a.wip } })
      return { recorded: true }
    }

    case 'browser.open': {
      // A tab of the server's Chrome for a session, and its card: the session's owner's to open.
      const s = session(a.sessionId)
      if (!mayDrive(s, actor)) throw new CmdError(`only ${s.owner} can open a browser for this session`, 'auth')
      const url = a.url === undefined || a.url === '' ? 'about:blank' : webUrl(a.url)
      if (!url) throw new CmdError('only http and https addresses open here')
      if (!browsers.available) throw new CmdError('No browser is set up on this server (SPHERE_BROWSER_PROFILE).', 'conflict')
      const open = [...world.tabs.values()]
      if (open.filter(t => t.sessionId === s.id).length >= TABS_PER_SESSION) throw new CmdError(`this session has ${TABS_PER_SESSION} tabs open already; remove a browser card first`, 'conflict')
      if (open.length >= TABS) throw new CmdError(`the server's browser has ${TABS} tabs open for sessions already; remove some browser cards first`, 'conflict')
      if (!(await browsers.openable(url))) throw new CmdError("that's the server browser's own debugging port, which tabs can't open")
      // Chrome is asked outside the queue of changes, so a slow browser holds up nothing else.
      let targetId: string
      try {
        targetId = await browsers.open(url)
      } catch (e) {
        throw new CmdError(`the server's browser didn't open a tab (${(e as Error).message})`, 'other')
      }
      return serially(async () => {
        // Counted again in the queue: opens that ran side by side each passed the first count.
        const now = [...world.tabs.values()]
        if (now.filter(t => t.sessionId === s.id).length >= TABS_PER_SESSION || now.length >= TABS) throw new CmdError('too many tabs are open; remove some browser cards first', 'conflict')
        await record({ topic: topics.world, type: 'browser.opened', actor, data: { targetId, sessionId: s.id, url } })
        const id = liveShapeId('browser')
        const at = { x: Number.isFinite(a.x) ? Math.round(a.x as number) : 0, y: Number.isFinite(a.y) ? Math.round(a.y as number) : 0 }
        canvas.write([
          {
            id,
            typeName: 'shape',
            type: 'browser',
            ...at,
            rotation: 0,
            index: topIndex(),
            parentId: CANVAS_PAGE,
            isLocked: false,
            opacity: 1,
            props: { w: 1024, h: 720, sessionId: s.id, targetId },
            meta: { author: actor },
          } as unknown as TLRecord,
        ])
        return { shapeId: id, targetId }
      }).catch(async e => {
        // Not recorded: the tab would belong to nobody, so it goes.
        await browsers.closeTab(targetId)
        throw e
      })
    }

    case 'canvas':
      return { layout: [...world.layout.values()], notes: [...world.notes.values()] }

    case 'layout.set': {
      const items = (Array.isArray(a.items) ? a.items : []) as LayoutItem[]
      const clean = items
        .filter(i => typeof i?.id === 'string' && ['session', 'region', 'note'].includes(i.kind) && Number.isFinite(i.x) && Number.isFinite(i.y))
        .slice(0, 200)
        .map(i => ({ id: i.id, kind: i.kind, x: Math.round(i.x), y: Math.round(i.y), ...(Number.isFinite(i.w) && { w: Math.round(i.w!) }), ...(Number.isFinite(i.h) && { h: Math.round(i.h!) }), parent: i.parent ?? null }))
      if (!clean.length) throw new CmdError('no valid layout items')
      await record({ topic: topics.world, type: 'layout.set', actor, data: { items: clean } })
      return { saved: clean.length }
    }

    case 'note.create': {
      const id = newId('n')
      const color: NoteColor = NOTE_COLORS.includes(a.color as NoteColor) ? (a.color as NoteColor) : 'yellow'
      await record({ topic: topics.world, type: 'note.created', actor, data: { id, text: String(a.text ?? '').slice(0, 4000), color, x: Number(a.x) || 0, y: Number(a.y) || 0 } })
      return { id }
    }

    case 'note.update':
    case 'note.delete': {
      if (!world.notes.has(String(a.id))) throw new CmdError(`no note ${a.id}`)
      if (op === 'note.delete') await record({ topic: topics.world, type: 'note.deleted', actor, data: { id: a.id } })
      else {
        const color = NOTE_COLORS.includes(a.color as NoteColor) ? (a.color as NoteColor) : undefined
        const text = typeof a.text === 'string' ? a.text.slice(0, 4000) : undefined
        await record({ topic: topics.world, type: 'note.updated', actor, data: { id: a.id, ...(text !== undefined && { text }), ...(color && { color }) } })
      }
      return { id: a.id }
    }

    case 'recent': {
      // The last rows of each session, light form: fills tool tracks and tickers on load.
      // Without a list: live sessions first, then the most recently active.
      const ids = Array.isArray(a.sessionIds)
        ? (a.sessionIds as string[])
        : [...world.sessions.values()]
            .sort((x, y) => Number(x.state === 'ended') - Number(y.state === 'ended') || (y.lastActivityAt ?? y.startedAt).localeCompare(x.lastActivityAt ?? x.startedAt))
            .map(s => s.id)
      const limit = Math.min(Number(a.limit ?? 40), 200)
      const out: Record<string, Activity[]> = {}
      for (const id of ids.slice(0, 100)) out[id] = (await db.tail(topics.session(id), limit)).map(toActivity)
      return { recent: out }
    }

    case 'activity': {
      // Rows per session in 30 s buckets: the sparklines on load.
      const minutes = Math.min(Number(a.minutes ?? 10), 120)
      return { buckets: await db.activityBuckets(minutes), bucketSeconds: 30, minutes }
    }

    // This person's Linear account: whether it's connected and as whom, never a token.
    case 'linear.account':
      return accounts.account(actor)

    case 'linear.connect':
      // The address to open in a browser; Linear sends it back to /linear/callback.
      if (!accounts.enabled) throw new CmdError(accounts.reason)
      return { url: accounts.start(actor) }

    case 'linear.disconnect':
      return accounts.disconnect(actor)

    // ---------- changes in Linear (CS-2523): each as one person, its answer to every canvas ----------

    case 'ticket.options': {
      // A ticket's statuses and people, to change it with.
      const s = a.sessionId !== undefined ? session(a.sessionId) : null
      const id = ticketOf(a.id, s)
      const as = await linearAs(actor, s, id)
      const options = await inLinear(() => optionsFor(askAs(as), { ticket: id }))
      if (options.ticket) tickets.set(options.ticket.id, options.ticket)
      return options
    }

    case 'ticket.teams': {
      // The teams a new ticket can go in, and with `team`, that team's statuses and people.
      const s = a.sessionId !== undefined ? session(a.sessionId) : null
      const as = await linearAs(actor, s, null)
      return inLinear(async () => ({
        teams: await teams(askAs(as)),
        ...(typeof a.team === 'string' && a.team && { options: await optionsFor(askAs(as), { team: a.team }) }),
      }))
    }

    case 'ticket.update': {
      // Status, assignee and title: by id from the canvas, by name from the CLI.
      const s = a.sessionId !== undefined ? session(a.sessionId) : null
      const id = ticketOf(a.id, s)
      const as = await linearAs(actor, s, id)
      const ask = askAs(as)
      const ticket = await inLinear(async () => {
        const change: TicketChange = {}
        if (typeof a.title === 'string') change.title = a.title
        const byName = typeof a.status === 'string' || a.assignee !== undefined
        const options = byName ? await optionsFor(ask, { ticket: id }) : null
        if (typeof a.stateId === 'string') change.stateId = a.stateId
        else if (typeof a.status === 'string') change.stateId = statusId(options!, a.status)
        if (a.assigneeId === null || typeof a.assigneeId === 'string') change.assigneeId = a.assigneeId
        else if (a.assignee === null || typeof a.assignee === 'string') change.assigneeId = assigneeId(options!, a.assignee)
        return updateTicket(ask, id, change)
      })
      tickets.set(ticket.id, ticket)
      return { ticket, as }
    }

    case 'ticket.create': {
      // A new ticket, attached to the session when one is named.
      const s = a.sessionId !== undefined ? session(a.sessionId) : null
      if (s) attachable(s, actor)
      const as = await linearAs(actor, s, null)
      const ask = askAs(as)
      const team = typeof a.teamId === 'string' ? a.teamId : typeof a.team === 'string' ? a.team : null
      if (!team) throw new CmdError('which team? give its key, such as CS')
      const ticket = await inLinear(async () => {
        const all = await teams(ask)
        const t = all.find(x => x.id === team || x.key.toUpperCase() === team.toUpperCase())
        if (!t) throw new ChangeError(`no team ${team} in ${as}'s Linear workspace; there are ${all.map(x => x.key).join(', ')}`)
        return createTicket(ask, { teamId: t.id, title: String(a.title ?? ''), description: typeof a.description === 'string' ? a.description : null })
      })
      tickets.set(ticket.id, ticket)
      if (s) await attachTicket(s, actor, ticket.id)
      return { ticket, as, ...(s && { attachedTo: s.id }) }
    }

    case 'ticket.comment': {
      // A comment, shown in Linear under whoever it's made as.
      const s = a.sessionId !== undefined ? session(a.sessionId) : null
      const id = ticketOf(a.id, s)
      const as = await linearAs(actor, s, id)
      const comment = await inLinear(() => commentOn(askAs(as), id, String(a.body ?? '')))
      return { id, comment, as }
    }

    case 'ticket.attach': {
      // An existing ticket, as this session's: checked in Linear first, so no frame for a typo.
      const s = session(a.sessionId)
      attachable(s, actor)
      const id = ticketOf(a.id, null)
      const as = await linearAs(actor, s, null)
      const ticket = await inLinear(() => readTicket(askAs(as), id))
      if (!ticket) throw new CmdError(`Linear has no ticket ${id} that ${as} can see`)
      tickets.set(ticket.id, ticket)
      await attachTicket(s, actor, ticket.id)
      return { ticket, as, attachedTo: s.id }
    }

    case 'delivery': {
      const d = world.deliveries.get(String(a.msgId))
      if (!d) throw new CmdError(`no message ${a.msgId}`)
      return d
    }

    default:
      throw new CmdError(`unknown op ${op}`)
  }
}

// Commands that change anything run one at a time. A command checks the world, then records
// events; with two at once, both could pass the same check (one suggestion approved twice),
// and events could reach the world in a different order than the log stores them.
// `browser.open` waits on Chrome outside the queue, and queues only what it records.
const READS = new Set(['browser.open', 'status', 'show', 'partial', 'search', 'body', 'approvals', 'permissions', 'canvas', 'recent', 'activity', 'delivery', 'linear.account', 'linear.connect', 'linear.disconnect',
  // They wait on Linear, so they don't hold up other commands; what they record goes through `serially`.
  'ticket.options', 'ticket.teams', 'ticket.update', 'ticket.create', 'ticket.comment', 'ticket.attach'])
let queue: Promise<unknown> = Promise.resolve()
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn)
  queue = result.catch(() => {})
  return result
}

async function onMessage(ws: ServerWebSocket<Conn>, raw: string) {
  let m: ClientMessage
  try {
    m = JSON.parse(raw)
  } catch {
    return send(ws, { t: 'error', error: 'invalid JSON' })
  }
  const conn = ws.data
  if (m.t === 'hello') {
    // A browser behind Tailscale is who Tailscale says it is; everything else needs a token.
    const identity = m.role === 'web' && conn.login ? identityFromLogin(conn.login) : (TOKENS.get(m.token) ?? null)
    if (!identity) {
      send(ws, { t: 'error', error: TAILSCALE ? 'Open Dyson Sphere through Tailscale, or use a valid token.' : 'unknown token' })
      return ws.close(4001, 'auth')
    }
    if (m.role === 'bridge' && (m.protocol ?? 1) < BRIDGE_FLOOR) {
      send(ws, { t: 'error', error: `This sphere bridge is older than the server (protocol ${m.protocol ?? 1}, server ${PROTOCOL}). Update sphere: see the README.` })
      return ws.close(4002, 'outdated')
    }
    conn.identity = identity
    conn.role = m.role
    conn.protocol = typeof m.protocol === 'number' ? m.protocol : 1
    return send(ws, { t: 'welcome', identity, conn: conn.id, color: colorFor(identity), protocol: PROTOCOL })
  }
  if (!conn.identity) return send(ws, { t: 'error', error: 'send hello first' })

  // A bridge relaying its session's terminal: passed to the pages watching it, never stored.
  if (m.t === 'term') return termFromBridge(conn, m as unknown as Record<string, unknown>)

  if (m.t === 'presence') {
    if (conn.role !== 'web') return
    const p: Presence = {
      conn: conn.id,
      identity: conn.identity,
      color: colorFor(conn.identity),
      cursor: m.cursor && Number.isFinite(m.cursor.x) && Number.isFinite(m.cursor.y) ? { x: m.cursor.x, y: m.cursor.y } : null,
      viewport: m.viewport && Number.isFinite(m.viewport.zoom) ? { x: m.viewport.x, y: m.viewport.y, zoom: m.viewport.zoom } : null,
      selected: typeof m.selected === 'string' ? m.selected : null,
      following: typeof m.following === 'string' ? m.following : null,
      ...(m.canvas === 'tldraw' && { canvas: 'tldraw' as const }),
      at: new Date().toISOString(),
    }
    conn.presence = p
    presences.set(conn.id, p)
    // Everyone else gets it; the sender already knows where it is.
    const msg = JSON.stringify({ t: 'presence', presence: p } satisfies ServerMessage)
    servers.forEach((srv, i) => (i === conn.via ? ws.publish(topics.presence, msg) : srv.publish(topics.presence, msg)))
    return
  }

  if (m.t === 'sub') {
    // A bridge topic carries one session's commands, for the bridges attached to it. A new
    // session's bridge subscribes before its session.started has created the session.
    if (m.topic.startsWith('bridge:')) {
      const id = m.topic.slice('bridge:'.length)
      if (conn.role !== 'bridge' || (world.sessions.has(id) && !conn.attached.has(id)))
        return send(ws, { t: 'error', error: 'attach to the session before subscribing to its commands' })
    }
    let last = m.since ?? 0
    const ticket = Symbol(m.topic)
    conn.subs.set(m.topic, ticket)
    if (m.since === undefined) ws.subscribe(m.topic) // at once: snapshots read next must not see a gap
    else
      // History first, then live events, with nothing recorded in between (events are only
      // recorded inside `serially`): a live event can't overtake the history it follows.
      await serially(async () => {
        if (conn.subs.get(m.topic) !== ticket) return // unsubscribed while waiting
        for (const ev of await db.since(m.topic, m.since!)) (send(ws, { t: 'ev', ev }), (last = ev.seq))
        ws.subscribe(m.topic)
      })
    if (conn.subs.get(m.topic) !== ticket) return
    if (m.topic === topics.world) {
      for (const s of world.sessions.values()) send(ws, { t: 'state', session: s })
      for (const [id, ticket] of tickets.known) send(ws, { t: 'ticket', id, ticket })
    }
    if (m.topic === topics.presence) for (const p of presences.values()) if (p.conn !== conn.id) send(ws, { t: 'presence', presence: p })
    return send(ws, { t: 'live', topic: m.topic, seq: last })
  }
  if (m.t === 'unsub') {
    conn.subs.delete(m.topic)
    return ws.unsubscribe(m.topic)
  }

  if (m.t === 'cmd') {
    try {
      const run = () => command(conn, m.op, m.args ?? {})
      send(ws, { t: 'res', id: m.id, ok: true, data: await (READS.has(m.op) ? run() : serially(run)) })
    } catch (err) {
      const code = err instanceof CmdError ? err.code : 'other'
      if (!(err instanceof CmdError)) console.error(err)
      send(ws, { t: 'res', id: m.id, ok: false, error: (err as Error).message, code })
    }
  }
}

/**
 * The canvas and the debug page, bundled here at startup with code splitting: what a page loads
 * with `import()` (the transcript, and the diff and highlighting code with Shiki's grammars, most
 * of the bundle) is fetched only when first needed. Bun.serve's HTML routes bundle without
 * splitting, so they're used only with SPHERE_DEV=1, for hot reloading.
 */
async function pages(): Promise<Record<string, Response | HTMLBundle>> {
  if (DEV) return { '/': (await import('../../web/index.html')).default, '/debug': (await import('../../web/debug.html')).default }
  const web = `${import.meta.dir}/../../web`
  // NODE_ENV as the server runs: React and tldraw (which checks its licence only in production)
  // each read it to pick their production build. SPHERE_BUNDLE_ENV=production gives a development
  // server the production build, to measure what production runs (scripts/bench-canvas.ts).
  const built = await Bun.build({
    entrypoints: [`${web}/index.html`, `${web}/debug.html`],
    target: 'browser',
    splitting: true,
    minify: true,
    publicPath: '/',
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.SPHERE_BUNDLE_ENV === 'production' || PRODUCTION ? 'production' : 'development') },
  })
  if (!built.success) throw new AggregateError(built.logs, 'bundling the canvas failed')
  const routes: Record<string, Response> = {}
  for (const out of built.outputs) {
    const name = out.path.replace(/^\.\//, '')
    const page = name === 'index.html' ? '/' : name === 'debug.html' ? '/debug' : null
    // Chunk and asset names carry a hash of their content, so a browser can keep them for good.
    const headers = { 'content-type': out.type, 'cache-control': page ? 'no-cache' : 'public, max-age=31536000, immutable' }
    routes[page ?? `/${name}`] = new Response(await out.arrayBuffer(), { headers })
  }
  return routes
}
/**
 * SPHERE_TLDRAW_LICENSE_KEY: tldraw's licence key, which the canvas needs in production (https on
 * a host other than this machine). It's checked in the browser, so it goes in the page; it isn't
 * secret, but it stays out of the repo. Development needs none, and SPHERE_DEV=1 pages get none.
 */
const TLDRAW_LICENSE_KEY = process.env.SPHERE_TLDRAW_LICENSE_KEY?.trim() || null
const escapeAttr = (s: string) => s.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`)
/** The canvas page with the licence key in a `<meta>`, where the canvas reads it before tldraw mounts. */
async function withLicense(page: Response): Promise<Response> {
  if (!TLDRAW_LICENSE_KEY) return page
  const html = (await page.text()).replace(/<head>/i, m => `${m}<meta name="tldraw-license-key" content="${escapeAttr(TLDRAW_LICENSE_KEY)}">`)
  return new Response(html, { headers: page.headers })
}
/**
 * tldraw's fonts, icons and translations, from its assets package rather than its CDN: the canvas
 * asks for `/tldraw-assets/<folder>/<file>`. Only those folders, and nothing outside them.
 */
// Where the package is, as the canvas's workspace resolves it: an install may put it there or hoist it.
const TLDRAW_ASSETS = dirname(Bun.resolveSync('@tldraw/assets/selfHosted', `${import.meta.dir}/../../web`))
const TLDRAW_ASSET_DIRS = new Set(['fonts', 'icons', 'translations', 'embed-icons'])
async function tldrawAsset(path: string): Promise<Response> {
  const parts = decodeURIComponent(path.slice('/tldraw-assets/'.length)).split('/')
  if (!TLDRAW_ASSET_DIRS.has(parts[0]!) || parts.some(p => !p || p === '.' || p === '..')) return new Response('not found', { status: 404 })
  const file = Bun.file(`${TLDRAW_ASSETS}/${parts.join('/')}`)
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  // tldraw's version is pinned, and a deploy that changes it restarts the server.
  return new Response(file, { headers: { 'cache-control': 'public, max-age=86400' } })
}
const PAGES = await pages()
if (PAGES['/'] instanceof Response) PAGES['/'] = await withLicense(PAGES['/'])

/** One listener's options. `trustLogin`: this is the socket `tailscale serve` forwards to. */
const listener = (via: number, trustLogin: boolean) => ({
  // Bun bundles the canvas (React, TSX, CSS) from its HTML entry when the server starts.
  routes: PAGES,
  development: DEV,
  fetch(req: Request, srv: import('bun').Server<Conn>) {
    const url = new URL(req.url)
    if (url.pathname === '/ws' || url.pathname === '/canvas' || url.pathname === '/term' || url.pathname === '/browser') {
      // Browsers send an Origin with every WebSocket. Another site's page must not connect:
      // behind Tailscale it would be signed in as whoever has it open.
      const origin = req.headers.get('origin')
      const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
      if (origin && (ORIGIN ? origin !== ORIGIN : URL.canParse(origin) ? new URL(origin).host !== host : true)) return new Response('forbidden origin', { status: 403 })
      const login = trustLogin ? req.headers.get('tailscale-user-login') : null
      const data: Conn = { id: crypto.randomUUID().slice(0, 8), identity: null, login, role: null, attached: new Map(), presence: null, via, subs: new Map() }
      if (url.pathname === '/canvas' || url.pathname === '/term' || url.pathname === '/browser') {
        // tldraw's protocol has no hello, nor does a terminal's, so who it is is settled before
        // the upgrade: the Tailscale login, as for a page on /ws, or else a token in the URL.
        data.identity = login ? identityFromLogin(login) : (TOKENS.get(url.searchParams.get('token') ?? '') ?? null)
        if (!data.identity) return new Response(TAILSCALE ? 'Open Dyson Sphere through Tailscale, or use a valid token.' : 'unknown token', { status: 401 })
      }
      if (url.pathname === '/canvas') data.canvas = { session: null }
      if (url.pathname === '/browser') {
        const targetId = url.searchParams.get('tab') ?? ''
        if (!TARGET_ID.test(targetId)) return new Response('tab required', { status: 400 })
        const tooMany = (termSockets.get(data.identity!) ?? 0) >= TERM_SOCKETS_PER_PERSON
        data.browser = { targetId, viewer: null as unknown as BrowserViewer, tooMany }
      }
      if (url.pathname === '/term') {
        const sessionId = url.searchParams.get('session') ?? ''
        if (!SESSION_ID.test(sessionId)) return new Response('session required', { status: 400 })
        // Over the limit: let in, to be told why, then closed.
        const tooMany = (termSockets.get(data.identity!) ?? 0) >= TERM_SOCKETS_PER_PERSON
        data.term = { sessionId, viewer: null as unknown as Viewer, tooMany }
      }
      return srv.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname.startsWith('/tldraw-assets/')) return tldrawAsset(url.pathname)
    if (url.pathname === '/linear/callback' && req.method === 'GET') {
      // Behind Tailscale, whoever the browser is signed in as must be who started the link.
      const login = trustLogin ? req.headers.get('tailscale-user-login') : null
      return linearCallback(url, trustLogin ? (login ? identityFromLogin(login) : null) ?? '' : null)
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws: ServerWebSocket<Conn>) {
      if (ws.data.canvas) ws.data.canvas.session = canvas.connect(ws, { identity: ws.data.identity! })
      else if (ws.data.browser) {
        const identity = ws.data.identity!
        termSockets.set(identity, (termSockets.get(identity) ?? 0) + 1)
        const viewer: BrowserViewer = { identity, send: m => void ws.send(m), sendFrame: f => void ws.send(f), buffered: () => ws.getBufferedAmount() }
        ws.data.browser.viewer = viewer
        if (ws.data.browser.tooMany) {
          ws.send(JSON.stringify({ t: 'status', status: 'unavailable', reason: tooManyLiveCards }))
          ws.close(4029, 'too many')
        } else if (!browsers.join(ws.data.browser.targetId, viewer)) ws.close(4004, 'unavailable')
      } else if (ws.data.term) {
        const identity = ws.data.identity!
        termSockets.set(identity, (termSockets.get(identity) ?? 0) + 1)
        const viewer: Viewer = { identity, send: m => void ws.send(m), buffered: () => ws.getBufferedAmount() }
        ws.data.term.viewer = viewer
        if (ws.data.term.tooMany) {
          ws.send(JSON.stringify({ t: 'status', status: 'unavailable', reason: tooManyLiveCards }))
          ws.close(4029, 'too many')
        } else if (!terminals.join(ws.data.term.sessionId, viewer)) ws.close(4004, 'unavailable')
      } else sockets.add(ws)
    },
    message(ws: ServerWebSocket<Conn>, raw: string | Buffer) {
      if (ws.data.canvas?.session) canvas.message(ws.data.canvas.session, raw)
      else if (ws.data.term) terminals.fromViewer(ws.data.term.sessionId, ws.data.term.viewer, String(raw))
      else if (ws.data.browser) void browsers.fromViewer(ws.data.browser.targetId, ws.data.browser.viewer, String(raw))
      else if (!ws.data.canvas) void onMessage(ws, String(raw))
    },
    drain(ws: ServerWebSocket<Conn>) {
      if (ws.data.term) terminals.drained(ws.data.term.sessionId, ws.data.term.viewer)
    },
    close(ws: ServerWebSocket<Conn>) {
      if (ws.data.canvas) {
        if (ws.data.canvas.session) canvas.close(ws.data.canvas.session)
        return
      }
      if (ws.data.browser) {
        const identity = ws.data.identity!
        termSockets.set(identity, (termSockets.get(identity) ?? 1) - 1)
        if (!termSockets.get(identity)) termSockets.delete(identity)
        browsers.leave(ws.data.browser.targetId, ws.data.browser.viewer)
        return
      }
      if (ws.data.term) {
        const identity = ws.data.identity!
        termSockets.set(identity, (termSockets.get(identity) ?? 1) - 1)
        if (!termSockets.get(identity)) termSockets.delete(identity)
        terminals.leave(ws.data.term.sessionId, ws.data.term.viewer)
        return
      }
      sockets.delete(ws)
      if (presences.delete(ws.data.id)) publish(topics.presence, JSON.stringify({ t: 'presence.leave', conn: ws.data.id } satisfies ServerMessage))
      for (const id of [...ws.data.attached.keys()]) detach(ws, id)
    },
  },
})

const servers = [Bun.serve<Conn>({ port: PORT, hostname: HOST, ...listener(0, false) })]
if (WEB_SOCKET) {
  rmSync(WEB_SOCKET, { force: true })
  servers.push(Bun.serve<Conn>({ unix: WEB_SOCKET, ...listener(1, TAILSCALE) }))
  chmodSync(WEB_SOCKET, 0o660)
}
/** Each listener has its own subscribers. */
function publish(topic: string, msg: string) {
  for (const srv of servers) srv.publish(topic, msg)
}

// Sessions are disconnected until a bridge attaches after a restart.
for (const s of world.sessions.values()) s.connected = false
// One read at a time: a poll while Linear is slow to answer is skipped, not queued.
let polling = false
const poll = async () => {
  if (polling) return
  polling = true
  try {
    await tickets.refresh(liveTickets()).catch(() => {})
  } finally {
    polling = false
  }
  // A confirmation that couldn't be recorded is tried again.
  for (const id of tickets.known.keys()) void confirm(id)
}
void poll()
// The room and the log back in step (Arrangement.start: what the room missed, shapes it doesn't
// have yet, what it has that the log doesn't), then, every hour, the cards of sessions gone for a
// week leave.
{
  const missed = canvas.logSeq === null ? null : db.eventsAfter(canvas.logSeq, Arrangement.FOLLOWS)
  const last = await db.lastSeq()
  // A room that can't be brought in step doesn't keep the server from serving the log.
  await serially(() => arrangement.start(missed, last)).catch(e => console.error('canvas: bringing the room in step at startup:', e))
}
// Every tab Dyson Sphere opened, kept connected and guarded, as from the moment it opened.
if (browsers.available) for (const id of world.tabs.keys()) browsers.keep(id)
setInterval(() => void serially(async () => arrangement.retire()).catch(e => console.error('canvas: retiring cards:', e)), 3600_000)
// The canvas is saved about once a second. On the way down, pages are disconnected first, so
// nothing changes after the last save, and what changed since goes too: tried for 3 seconds, and
// given up on if Postgres hasn't answered within 4.
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    // Pages' last changes reach the log, and every queued command finishes, before the last save.
    void Promise.race([canvas.shutdown(3000, () => recordPageChanges().then(() => serially(async () => {}))), Bun.sleep(4000)]).finally(() => process.exit(0))
  })
// A mistyped setting reads as the default, and nothing reads Linear more than once a second.
const pollSeconds = Number(process.env.SPHERE_LINEAR_POLL_SECONDS || 60)
setInterval(() => void poll(), Math.max(Number.isFinite(pollSeconds) ? pollSeconds : 60, 1) * 1000)
console.log(`sphere-server on http://${HOST}:${servers[0]!.port}${WEB_SOCKET ? ` and ${WEB_SOCKET}` : ''} (${world.sessions.size} sessions, ${TOKENS.size} tokens${TAILSCALE ? ', Tailscale sign-in' : ''}${PRODUCTION ? ', production' : ''})`)
export type { StoredEvent }
