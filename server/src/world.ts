// In-memory world state, built by applying stored events in order.
import { CANVAS, cleanLabels, cleanTicket, labelTicket, regionFor, ticketId } from '../../shared/protocol'
import type { DeliveryState, LayoutItem, Mode, Note, NoteColor, PermissionRequest, SessionState, SessionSummary, SessionTicket, StoredEvent, Suggestion } from '../../shared/protocol'

const RANK: Record<DeliveryState, number> = { queued: 0, 'at-bridge': 1, injected: 2, observed: 3, failed: 4 }

/** A prompt's first meaningful line, without Dyson Sphere's delivery framing or engine markup. */
function taskFrom(text: string): string | null {
  const body = text
    .replace(/^The \S+ plugin sent a message:\s*/, '')
    .replace(/^\[From [^\]]*via Dyson Sphere\]\s*/, '')
    .replace(/<[^>]+>/g, ' ')
  const line = body.split('\n').map(l => l.trim()).find(Boolean)
  if (!line || line.startsWith('/')) return null // slash commands aren't tasks
  return line.length > 120 ? line.slice(0, 119) + '…' : line
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

/**
 * Which Claude Code process runs a session. The latest one to start it holds it; the ones
 * before are retired for good, so a moved session's old terminal can't take it back by
 * restarting its bridge.
 */
export type Holder = { current: string; retired: Set<string> }

export class World {
  sessions = new Map<string, SessionSummary>()
  holders = new Map<string, Holder>()
  suggestions = new Map<string, Suggestion>()
  deliveries = new Map<string, Delivery>()
  permissions = new Map<string, PermissionRequest>()
  /**
   * Browser tabs opened for sessions (browser cards), by Chrome's target id: whose session each
   * shows, so only its owner drives it. From `browser.opened` and `browser.closed`.
   */
  tabs = new Map<string, { sessionId: string; url: string; openedBy: string; openedAt: string }>()
  layout = new Map<string, LayoutItem>()
  notes = new Map<string, Note>()
  /** Each session's ticket as its bridge found it. One found in a branch name shows once Linear has it. */
  found = new Map<string, SessionTicket>()
  /** Ids found in branch names that Linear has an issue for (`ticket.confirmed`). */
  confirmed = new Set<string>()
  /** Tickets people attached to sessions in Dyson Sphere (`session.ticket`): only estra's label comes before them. */
  attached = new Map<string, SessionTicket>()

  /** Applies one event. Returns the ids of sessions whose summary changed. */
  apply(ev: StoredEvent): string[] {
    const d = ev.data as Record<string, any>
    switch (ev.type) {
      case 'session.started': {
        const prev = this.sessions.get(d.sessionId)
        // A start without labels (resumed by hand, or by an older bridge) keeps the ones it had.
        const labels = cleanLabels(d.labels) ?? prev?.labels ?? null
        // So does one that finds no ticket. estra's label comes first wherever it came from,
        // and is the ticket of a session whose bridge predates tickets but not labels.
        const found = labelTicket(labels) ?? this.attached.get(d.sessionId) ?? cleanTicket(d.ticket) ?? this.found.get(d.sessionId) ?? null
        if (found) this.found.set(d.sessionId, found)
        const ticket = this.shown(found)
        this.assignSlot(d.sessionId, regionFor({ repo: d.repo ?? null, labels, ticket }).id, ev.at)
        if (typeof d.holder === 'string') {
          const h = this.holders.get(d.sessionId)
          if (!h) this.holders.set(d.sessionId, { current: d.holder, retired: new Set() })
          else if (h.current !== d.holder) {
            h.retired.add(h.current)
            h.current = d.holder
          }
        }
        // A new bridge means a reloaded mod: its waits and grants from before are gone.
        this.expirePermissions(d.sessionId)
        this.sessions.set(d.sessionId, {
          id: d.sessionId,
          agent: d.agent === 'codex' ? 'codex' : 'claude',
          owner: ev.actor,
          machine: d.machine,
          cwd: d.cwd,
          repo: d.repo ?? null,
          branch: d.branch ?? null,
          // A resumed session is live again, not ended.
          state: prev && prev.state !== 'ended' ? prev.state : 'idle',
          turnId: prev && prev.state !== 'ended' ? prev.turnId : null,
          lastSummary: prev?.lastSummary ?? null,
          task: prev?.task ?? null,
          lastActivityAt: prev?.lastActivityAt ?? null,
          lastSeenAt: ev.at,
          connected: prev?.connected ?? false,
          pendingSuggestions: prev?.pendingSuggestions ?? 0,
          pendingPermissions: 0,
          // A (re)started bridge: its mod reports the running agents again within seconds.
          subagents: [],
          startedAt: prev?.startedAt ?? ev.at,
          labels,
          ticket,
          // As this start says: a bridge from before terminals, or one outside tmux, says nothing.
          terminal: d.terminal === 'tmux' ? 'tmux' : null,
        })
        return [d.sessionId]
      }
      case 'session.status':
        return this.patch(d.sessionId, { state: d.state as SessionState, turnId: d.turnId ?? null, lastSeenAt: ev.at })
      case 'session.agent': {
        const s = this.sessions.get(d.sessionId)
        if (!s) return []
        const others = s.subagents.filter(a => a.id !== d.agentId)
        const subagents =
          d.state === 'running'
            ? [...others, { id: d.agentId, description: d.description ?? 'Subagent', type: d.subagentType ?? 'agent', background: !!d.background, startedAt: ev.at }]
            : others
        return this.patch(d.sessionId, { subagents, lastSeenAt: ev.at })
      }
      case 'session.ended':
        this.patch(d.sessionId, { subagents: [] })
        this.expirePermissions(d.sessionId)
        return this.patch(d.sessionId, { state: 'ended', turnId: null, connected: false, lastSeenAt: ev.at })
      case 'session.row': {
        const s = this.sessions.get(d.sessionId)
        const task = !s?.task && d.kind === 'prompt' ? taskFrom(String(d.text ?? d.summary ?? '')) : null
        // Thinking isn't something the session did: the card's last action stays as it was.
        const summary = d.kind === 'thinking' ? {} : { lastSummary: d.summary ?? null }
        return this.patch(d.sessionId, { ...summary, lastActivityAt: ev.at, lastSeenAt: ev.at, ...(task && { task }) })
      }
      case 'suggestion.created':
        this.suggestions.set(d.id, {
          id: d.id,
          sessionId: d.sessionId,
          author: ev.actor,
          text: d.text,
          mode: d.mode as Mode,
          status: 'pending',
          createdAt: ev.at,
        })
        return this.recount(d.sessionId)
      case 'suggestion.approved':
      case 'suggestion.rejected': {
        const s = this.suggestions.get(d.id)
        if (!s) return []
        s.status = ev.type === 'suggestion.approved' ? 'approved' : 'rejected'
        return this.recount(s.sessionId)
      }
      case 'delivery': {
        const prev = this.deliveries.get(d.msgId)
        // A message belongs to one session; a report naming another one isn't about it.
        if (prev && d.sessionId && prev.sessionId !== d.sessionId) return []
        // Reports can arrive out of order (a prompt row is stored before submit resolves).
        // A state never moves backwards; `failed` is final.
        if (prev && (prev.state === 'failed' || RANK[d.state as DeliveryState] < RANK[prev.state])) return []
        this.deliveries.set(d.msgId, {
          msgId: d.msgId,
          sessionId: d.sessionId ?? prev?.sessionId,
          author: d.author ?? prev?.author ?? ev.actor,
          text: d.text ?? prev?.text ?? null,
          kind: d.kind ?? prev?.kind ?? 'deliver',
          state: d.state,
          detail: d.detail ?? null,
          at: ev.at,
        })
        return []
      }
      case 'permission.requested': {
        // Request ids are the mod's; one from another session must not replace this one.
        const known = this.permissions.get(d.reqId)
        if (known && known.sessionId !== d.sessionId) return []
        this.permissions.set(d.reqId, {
          reqId: d.reqId,
          sessionId: d.sessionId,
          tool: d.tool,
          input: d.input,
          state: 'pending',
          decidedBy: null,
          requestedAt: ev.at,
        })
        return this.recountPermissions(d.sessionId)
      }
      case 'permission.decided':
      case 'permission.resolved': {
        // `decided`: the owner chose in Dyson Sphere. `resolved`: the mod reports the outcome.
        const p = this.permissions.get(d.reqId)
        // Only the session that asked, or its owner's decision, settles a request.
        if (!p || p.sessionId !== d.sessionId) return []
        const state = d.decision === 'allow' ? 'allowed' : d.decision === 'deny' ? 'denied' : d.decision
        if (ev.type === 'permission.decided') {
          if (p.state === 'pending' || p.state === 'deferred') p.state = state
        } else if (!(state === 'deferred' && p.state !== 'pending')) {
          // A decision the owner made just as the wait timed out stands: the bridge passes it on.
          p.state = state
        }
        p.decidedBy = d.by ?? (ev.type === 'permission.decided' ? ev.actor : p.decidedBy)
        return this.recountPermissions(p.sessionId)
      }
      case 'ticket.confirmed': {
        // Linear has an issue with this id: the sessions that found it in their branch name
        // show it now, and move to its frame. Recorded once per id, by the server.
        if (typeof d.id !== 'string') return []
        this.confirmed.add(d.id)
        const changed: string[] = []
        for (const [id, found] of this.found) {
          const s = this.sessions.get(id)
          if (!s || s.ticket || found.id !== d.id) continue
          this.assignSlot(id, regionFor({ ...s, ticket: found }).id, ev.at)
          changed.push(...this.patch(id, { ticket: found }))
        }
        return changed
      }
      case 'session.ticket': {
        // A person attached a Linear ticket to the session (CS-2523): it shows, and the card moves
        // to its frame. estra's label still wins: the server refuses those, and so does a replay.
        const s = this.sessions.get(d.sessionId)
        const id = ticketId(d.id)
        if (!s || !id || labelTicket(s.labels)) return []
        const ticket: SessionTicket = { id, source: 'sphere' }
        this.attached.set(s.id, ticket)
        this.found.set(s.id, ticket)
        this.assignSlot(s.id, regionFor({ ...s, ticket }).id, ev.at)
        return this.patch(s.id, { ticket })
      }
      case 'layout.set':
        for (const item of d.items as LayoutItem[]) {
          // A card saved in a frame its session has left (by a server or page from before
          // ticket frames, or while it restarted) keeps the slot it has in its own frame.
          const s = item.kind === 'session' ? this.sessions.get(item.id) : undefined
          if (s && item.parent !== regionFor(s).id) continue
          this.layout.set(item.id, item)
        }
        return []
      case 'note.created':
        this.notes.set(d.id, { id: d.id, text: d.text ?? '', color: (d.color ?? 'yellow') as NoteColor, author: ev.actor, createdAt: ev.at, updatedAt: ev.at })
        this.layout.set(d.id, { id: d.id, kind: 'note', x: d.x, y: d.y, w: d.w ?? 220, h: d.h ?? 160, parent: null })
        return []
      case 'note.updated': {
        const n = this.notes.get(d.id)
        if (n) Object.assign(n, { ...(d.text !== undefined && { text: d.text }), ...(d.color !== undefined && { color: d.color }), updatedAt: ev.at })
        return []
      }
      case 'note.deleted':
        this.notes.delete(d.id)
        this.layout.delete(d.id)
        return []
      case 'browser.opened':
        if (typeof d.targetId === 'string' && typeof d.sessionId === 'string')
          this.tabs.set(d.targetId, { sessionId: d.sessionId, url: String(d.url ?? ''), openedBy: ev.actor, openedAt: ev.at })
        return []
      case 'browser.closed':
        this.tabs.delete(d.targetId)
        return []
      default:
        return []
    }
  }

  /** A ticket as sessions show it: one from a branch name only once Linear has confirmed it, since a branch like `node-20-upgrade` reads as NODE-20. */
  private shown(t: SessionTicket | null): SessionTicket | null {
    return t && (t.source !== 'branch' || this.confirmed.has(t.id)) ? t : null
  }

  /** Whether a session found this id in its branch name and waits for Linear to confirm it. */
  awaitsConfirmation(id: string): boolean {
    if (this.confirmed.has(id)) return false
    for (const t of this.found.values()) if (t.source === 'branch' && t.id === id) return true
    return false
  }

  /** Whether events from this Claude Code process may change the session. */
  accepts(sessionId: string, holder: string | undefined, starting: boolean): boolean {
    const h = this.holders.get(sessionId)
    if (!h) return true // not yet held, or recorded before holders existed
    if (holder === h.current) return true
    // A process that hasn't run this session before may take it over by starting it.
    return starting && !!holder && !h.retired.has(holder)
  }

  private expirePermissions(sessionId: string) {
    for (const p of this.permissions.values()) if (p.sessionId === sessionId && (p.state === 'pending' || p.state === 'deferred')) p.state = 'expired'
    this.recountPermissions(sessionId)
  }

  private recountPermissions(sessionId: string): string[] {
    const n = [...this.permissions.values()].filter(p => p.sessionId === sessionId && p.state === 'pending').length
    return this.patch(sessionId, { pendingPermissions: n })
  }

  /**
   * Gives a session the first free card slot in its repo's frame, unless it already has a
   * place there. Every client then draws the same layout, and cards don't shift when another
   * session drops out of view.
   *
   * Depends on events being applied in log order: the slot depends on the other sessions'
   * states at this point in the log, which is what makes a replay after a restart land
   * every card in the same place.
   */
  private assignSlot(sessionId: string, rid: string, at: string) {
    const current = this.layout.get(sessionId)
    if (current && current.parent === rid) return
    const now = Date.parse(at)
    const taken = [...this.layout.values()].filter(l => {
      if (l.kind !== 'session' || l.parent !== rid || l.id === sessionId) return false
      const s = this.sessions.get(l.id)
      // Slots of sessions that ended long ago are free again.
      return !s || s.state !== 'ended' || now - Date.parse(s.lastSeenAt ?? s.startedAt) < CANVAS.endedVisibleMs
    })
    const { cardW, cardH, gap, pad, cols } = CANVAS
    for (let i = 0; ; i++) {
      const x = pad + (i % cols) * (cardW + gap)
      const y = pad + Math.floor(i / cols) * (cardH + gap)
      const clash = taken.some(l => x < l.x + cardW && x + cardW > l.x && y < l.y + cardH && y + cardH > l.y)
      if (!clash) {
        this.layout.set(sessionId, { id: sessionId, kind: 'session', x, y, parent: rid })
        return
      }
    }
  }

  setConnected(sessionId: string, connected: boolean): string[] {
    return this.patch(sessionId, { connected, lastSeenAt: new Date().toISOString() })
  }

  /** Resolves a full id or a unique prefix of at least 4 characters. */
  resolveSession(ref: string): SessionSummary | 'ambiguous' | null {
    const exact = this.sessions.get(ref)
    if (exact) return exact
    if (ref.length < 4) return null
    const hits = [...this.sessions.values()].filter(s => s.id.startsWith(ref))
    return hits.length === 1 ? hits[0]! : hits.length > 1 ? 'ambiguous' : null
  }

  private patch(id: string, p: Partial<SessionSummary>): string[] {
    const s = this.sessions.get(id)
    if (!s) return []
    Object.assign(s, p)
    return [id]
  }

  private recount(sessionId: string): string[] {
    const n = [...this.suggestions.values()].filter(s => s.sessionId === sessionId && s.status === 'pending').length
    return this.patch(sessionId, { pendingSuggestions: n })
  }
}
