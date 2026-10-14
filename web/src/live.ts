// Live data for the canvas: one WebSocket to sphere-server, and a store split into
// channels so a cursor moving doesn't re-render every card.
import { useSyncExternalStore } from 'react'
import type {
  PartialReply,
  Activity,
  DeliveryState,
  LayoutItem,
  Note,
  PermissionRequest,
  Presence,
  ServerMessage,
  SessionSummary,
  StoredEvent,
  Suggestion,
  Ticket,
  Viewport,
} from '../../shared/protocol'

// ---------- store ----------

type Listener = () => void
const listeners = new Map<string, Set<Listener>>()
const versions = new Map<string, number>()

export function emit(channel: string) {
  versions.set(channel, (versions.get(channel) ?? 0) + 1)
  for (const l of listeners.get(channel) ?? []) l()
}

/** Re-renders the caller whenever `channel` changes. Returns its version. */
export function useChannel(channel: string): number {
  return useSyncExternalStore(
    l => {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set.add(l))
      return () => set.delete(l)
    },
    () => versions.get(channel) ?? 0,
  )
}

export type Delivery = {
  msgId: string
  sessionId: string
  author: string
  text: string | null
  kind: string
  state: DeliveryState
  detail: string | null
  at: string
}

/** A tool call seen on a session's track. `endedAt` is null while it runs. */
export type TrackItem = { id: string; name: string; startedAt: number; endedAt: number | null; failed: boolean; sub: boolean }

export type SessionLive = {
  latest: Activity | null
  /** The last rows, light form, oldest first. Shown inside a card at close zoom. */
  rows: Activity[]
  /** Most recent last. */
  track: TrackItem[]
  /** Rows per 30 s for the last 10 minutes, oldest first. */
  buckets: number[]
  bucketsAnchor: number
  lastActivityMs: number | null
}

export const state = {
  me: null as { identity: string; conn: string; color: string } | null,
  conn: 'connecting' as 'connecting' | 'open' | 'closed' | 'unauthorized',
  /** Counts connections: a new one has none of the old one's subscriptions. */
  epoch: 0,
  loaded: false,
  sessions: new Map<string, SessionSummary>(),
  live: new Map<string, SessionLive>(),
  layout: new Map<string, LayoutItem>(),
  notes: new Map<string, Note>(),
  presences: new Map<string, Presence>(),
  permissions: new Map<string, PermissionRequest>(),
  suggestions: new Map<string, Suggestion>(),
  deliveries: new Map<string, Delivery>(),
  /** What Linear says about sessions' tickets, by id. A ticket without an entry shows its id only. */
  tickets: new Map<string, Ticket>(),
}

const RANK: Record<DeliveryState, number> = { queued: 0, 'at-bridge': 1, injected: 2, observed: 3, failed: 4 }
const BUCKET_MS = 30_000
const BUCKETS = 20

function liveFor(id: string): SessionLive {
  let l = state.live.get(id)
  if (!l) {
    l = { latest: null, rows: [], track: [], buckets: new Array(BUCKETS).fill(0), bucketsAnchor: Math.floor(Date.now() / BUCKET_MS), lastActivityMs: null }
    state.live.set(id, l)
  }
  return l
}

/** Shifts a session's sparkline so its last bucket is the current 30 s. */
export function rollBuckets(l: SessionLive, now = Date.now()) {
  const anchor = Math.floor(now / BUCKET_MS)
  const shift = anchor - l.bucketsAnchor
  if (shift <= 0) return
  l.buckets = shift >= BUCKETS ? new Array(BUCKETS).fill(0) : [...l.buckets.slice(shift), ...new Array(shift).fill(0)]
  l.bucketsAnchor = anchor
}

/** Summaries can carry engine markup (`<local-command-stdout>`); the canvas shows the words. */
const clean = (s: string) =>
  s
    .replace(/<\/?[a-z][\w-]*[^>]*>/gi, ' ')
    .replace(/\*\*|__|^#+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const TICKER_KINDS = new Set(['tool-call', 'assistant', 'prompt', 'tool-error', 'note', 'delivery'])

function applyActivity(raw: Activity, live: boolean) {
  const a = { ...raw, summary: clean(raw.summary) }
  const l = liveFor(a.sessionId)
  const t = Date.parse(a.at)
  // The ticker shows what the agent did: calls, replies, prompts and errors, not raw tool output
  // or injected context.
  if (TICKER_KINDS.has(a.kind) && (!l.latest || a.seq > l.latest.seq)) l.latest = a
  if (a.kind !== 'attachment' && a.kind !== 'thinking' && !l.rows.some(r => r.seq === a.seq)) {
    l.rows.push(a)
    l.rows.sort((x, y) => x.seq - y.seq)
    if (l.rows.length > 24) l.rows = l.rows.slice(-24)
  }
  if (l.lastActivityMs === null || t > l.lastActivityMs) l.lastActivityMs = t
  for (const tool of a.tools ?? []) {
    if (!l.track.some(x => x.id === tool.id)) l.track.push({ id: tool.id, name: tool.name, startedAt: t, endedAt: null, failed: false, sub: !!a.agentId })
  }
  for (const id of a.toolUseIds ?? []) {
    const item = l.track.find(x => x.id === id)
    if (item && item.endedAt === null) Object.assign(item, { endedAt: t, failed: a.kind === 'tool-error' })
  }
  if (l.track.length > 60) l.track = l.track.slice(-60)
  if (live) {
    rollBuckets(l)
    l.buckets[BUCKETS - 1]! += 1
  }
  emit(`live:${a.sessionId}`)
}

// ---------- connection ----------

let ws: WebSocket | null = null
let n = 0
const pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void }>()
let backoff = 500
/** Tickets held from before this connection that the server hasn't sent again yet. */
let staleTickets: Set<string> | null = null

export const token = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token')
  if (fromUrl) {
    try {
      sessionStorage.setItem('sphere-token', fromUrl)
    } catch {}
    history.replaceState(null, '', location.pathname)
  }
  let stored: string | null = null
  try {
    stored = sessionStorage.getItem('sphere-token')
  } catch {}
  // Behind Tailscale no token is needed; locally, open the page with ?token=…
  return fromUrl || stored || ''
})()

export function cmd<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the server'))
  const id = String(++n)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws!.send(JSON.stringify({ t: 'cmd', id, op, args }))
  })
}

function raw(m: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
}

export function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return // already connecting or open
  state.conn = 'connecting'
  emit('conn')
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws = socket
  socket.onopen = () => raw({ t: 'hello', token, role: 'web' })
  socket.onclose = ev => {
    for (const p of pending.values()) p.reject(new Error('Connection lost'))
    pending.clear()
    if (ev.code === 4001) {
      // Not signed in: retrying won't help.
      state.conn = 'unauthorized'
      emit('conn')
      return
    }
    state.conn = 'closed'
    for (const p of state.presences.values()) viewersChanged(p.selected, null)
    state.presences.clear()
    emit('conn')
    emit('presence')
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 5000)
  }
  socket.onmessage = msg => onMessage(JSON.parse(String(msg.data)) as ServerMessage)
}

async function onWelcome() {
  backoff = 500
  state.conn = 'open'
  state.epoch++
  emit('conn')
  // The server sends every ticket it knows before `live`; one it doesn't send was dropped
  // while this page was away.
  staleTickets = new Set(state.tickets.keys())
  raw({ t: 'sub', topic: 'world' })
  raw({ t: 'sub', topic: 'presence' })
  try {
    await load()
  } catch (e) {
    // Without the first load the canvas can't show anything true; start over.
    toast(`Couldn't load the canvas: ${(e as Error).message}. Reconnecting.`, 'error')
    ws?.close()
  }
}

async function load() {
  // Each snapshot is applied the moment its answer arrives: the server sends answers and
  // events in order on one socket, so an event that follows a snapshot is applied after it,
  // never overwritten by it.
  const [, , , recent, activity] = await Promise.all([
    cmd<{ layout: LayoutItem[]; notes: Note[] }>('canvas').then(canvas => {
      state.layout = new Map(canvas.layout.map(i => [i.id, i]))
      state.notes = new Map(canvas.notes.map(x => [x.id, x]))
    }),
    cmd<{ permissions: PermissionRequest[] }>('permissions', { all: true }).then(perms => {
      state.permissions = new Map(perms.permissions.map(p => [p.reqId, p]))
    }),
    cmd<{ suggestions: Suggestion[] }>('approvals', { all: true }).then(sugg => {
      state.suggestions = new Map(sugg.suggestions.map(s => [s.id, s]))
    }),
    cmd<{ recent: Record<string, Activity[]> }>('recent', { limit: 40 }),
    cmd<{ buckets: Record<string, number[]> }>('activity', { minutes: 10 }),
  ])
  for (const rows of Object.values(recent.recent)) for (const a of rows) applyActivity(a, false)
  for (const [id, b] of Object.entries(activity.buckets)) {
    const l = liveFor(id)
    l.buckets = b.length === BUCKETS ? b : [...new Array(Math.max(0, BUCKETS - b.length)).fill(0), ...b].slice(-BUCKETS)
    l.bucketsAnchor = Math.floor(Date.now() / BUCKET_MS)
    emit(`live:${id}`)
  }
  state.loaded = true
  emit('conn')
  emit('layout')
  emit('notes')
  emit('needs')
}

async function refreshNeeds() {
  try {
    const [perms, sugg] = await Promise.all([
      cmd<{ permissions: PermissionRequest[] }>('permissions', { all: true }),
      cmd<{ suggestions: Suggestion[] }>('approvals', { all: true }),
    ])
    state.permissions = new Map(perms.permissions.map(p => [p.reqId, p]))
    state.suggestions = new Map(sugg.suggestions.map(s => [s.id, s]))
    emit('needs')
  } catch {}
}

/** Called for every stored event the canvas sees, for components that react to them. */
export const eventHooks = new Set<(ev: StoredEvent) => void>()
/** Replies in progress, as the server passes them on (never stored). */
export const partialHooks = new Set<(p: PartialReply) => void>()

/** Deliveries a snapshot returned, such as `show`'s: a state never moves backwards. */
export function mergeDeliveries(list: Delivery[]) {
  const touched = new Set<string>()
  for (const d of list) {
    const prev = state.deliveries.get(d.msgId)
    if (prev && (prev.state === 'failed' || RANK[d.state] < RANK[prev.state])) continue
    state.deliveries.set(d.msgId, d)
    touched.add(d.sessionId)
  }
  for (const id of touched) emit(`deliveries:${id}`)
}

function onEvent(ev: StoredEvent) {
  const d = ev.data as Record<string, any>
  switch (ev.type) {
    case 'layout.set':
      for (const item of d.items as LayoutItem[]) state.layout.set(item.id, item)
      emit('layout')
      break
    case 'note.created':
      state.notes.set(d.id, { id: d.id, text: d.text, color: d.color, author: ev.actor, createdAt: ev.at, updatedAt: ev.at })
      state.layout.set(d.id, { id: d.id, kind: 'note', x: d.x, y: d.y, parent: null })
      emit('notes')
      emit('layout')
      break
    case 'note.updated': {
      const note = state.notes.get(d.id)
      if (note) {
        Object.assign(note, { ...(d.text !== undefined && { text: d.text }), ...(d.color !== undefined && { color: d.color }), updatedAt: ev.at })
        emit(`note:${d.id}`)
      }
      break
    }
    case 'note.deleted':
      state.notes.delete(d.id)
      state.layout.delete(d.id)
      emit('notes')
      emit('layout')
      break
    case 'delivery': {
      const prev = state.deliveries.get(d.msgId)
      // Reports can arrive out of order; a message's state never moves backwards.
      if (prev && (prev.state === 'failed' || RANK[d.state as DeliveryState] < RANK[prev.state])) break
      state.deliveries.set(d.msgId, {
        msgId: d.msgId,
        sessionId: d.sessionId ?? prev?.sessionId,
        author: d.author ?? prev?.author ?? ev.actor,
        text: d.text ?? prev?.text ?? null,
        kind: d.kind ?? prev?.kind ?? 'deliver',
        state: d.state,
        detail: d.detail ?? null,
        at: ev.at,
      })
      emit(`deliveries:${d.sessionId ?? prev?.sessionId}`)
      break
    }
    case 'permission.requested':
    case 'permission.decided':
    case 'permission.resolved':
    // Starting or ending a session expires its open requests on the server.
    case 'session.started':
    case 'session.ended':
    case 'suggestion.created':
    case 'suggestion.approved':
    case 'suggestion.rejected':
      void refreshNeeds()
      break
  }
  for (const h of eventHooks) h(ev)
}

/**
 * Who is looking at a card changed: `viewers:<session>` tells just those cards, where `presence`
 * would re-render every card on every cursor move.
 */
function viewersChanged(before: string | null | undefined, after: string | null | undefined) {
  if (before === after) return
  if (before) emit(`viewers:${before}`)
  if (after) emit(`viewers:${after}`)
}

function onMessage(m: ServerMessage) {
  switch (m.t) {
    case 'partial':
      for (const h of partialHooks) h(m.partial)
      return
    case 'welcome':
      state.me = { identity: m.identity, conn: m.conn, color: m.color }
      void onWelcome()
      return
    case 'res': {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.ok) p?.resolve(m.data)
      else p?.reject(new Error(m.error))
      return
    }
    case 'state': {
      const known = state.sessions.has(m.session.id)
      state.sessions.set(m.session.id, m.session)
      emit(`session:${m.session.id}`)
      if (!known) emit('sessions')
      else emit('session-states')
      return
    }
    case 'activity':
      applyActivity(m.activity, true)
      return
    case 'ev':
      onEvent(m.ev)
      return
    case 'presence': {
      const before = state.presences.get(m.presence.conn)?.selected
      state.presences.set(m.presence.conn, m.presence)
      viewersChanged(before, m.presence.selected)
      emit('presence')
      return
    }
    case 'layout':
      for (const item of m.items) state.layout.set(item.id, item)
      emit('layout')
      return
    case 'ticket':
      staleTickets?.delete(m.id)
      if (m.ticket) state.tickets.set(m.id, m.ticket)
      else state.tickets.delete(m.id)
      emit(`ticket:${m.id}`)
      return
    case 'live':
      if (m.topic === 'world' && staleTickets) {
        for (const id of staleTickets) (state.tickets.delete(id), emit(`ticket:${id}`))
        staleTickets = null
      }
      return
    case 'presence.leave':
      viewersChanged(state.presences.get(m.conn)?.selected, null)
      state.presences.delete(m.conn)
      emit('presence')
      return
    case 'error':
      console.warn('server:', m.error)
  }
}

export function subscribe(topic: string, since?: number) {
  raw({ t: 'sub', topic, since })
}
export function unsubscribe(topic: string) {
  raw({ t: 'unsub', topic })
}

// ---------- presence (throttled) ----------

const mine = { cursor: null as { x: number; y: number } | null, viewport: null as Viewport | null, selected: null as string | null, following: null as string | null }
let presenceTimer: ReturnType<typeof setTimeout> | null = null

export function setPresence(p: Partial<typeof mine>) {
  Object.assign(mine, p)
  if (presenceTimer) return
  presenceTimer = setTimeout(() => {
    presenceTimer = null
    // Every page is on tldraw now; the field stays so tldraw pages don't draw this cursor twice.
    raw({ t: 'presence', ...mine, canvas: 'tldraw' })
  }, 50) // at most 20 updates a second
}

// ---------- derived ----------

export function needsMe() {
  const me = state.me?.identity
  const mineOnly = (sessionId: string) => state.sessions.get(sessionId)?.owner === me
  return {
    // Deferred requests need me too, though the agent isn't waiting on them.
    permissions: [...state.permissions.values()].filter(p => (p.state === 'pending' || p.state === 'deferred') && mineOnly(p.sessionId)),
    suggestions: [...state.suggestions.values()].filter(s => s.status === 'pending' && mineOnly(s.sessionId)),
  }
}

// ---------- toasts ----------

export type Toast = { id: number; text: string; tone: 'error' | 'info' }
export const toasts: Toast[] = []
let toastN = 0

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const t = { id: ++toastN, text, tone }
  toasts.push(t)
  emit('toasts')
  setTimeout(() => {
    toasts.splice(toasts.indexOf(t), 1)
    emit('toasts')
  }, tone === 'error' ? 7000 : 4000)
}

/** Runs a server command and reports a failure as a toast instead of throwing. */
export async function tryCmd<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T | null> {
  try {
    return await cmd<T>(op, args)
  } catch (e) {
    toast((e as Error).message, 'error')
    return null
  }
}
