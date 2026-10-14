import type { SessionSummary, Ticket } from '../../shared/protocol'
import { describeCall, parseToolCall } from './toolcall'
import { emit, state, useChannel } from './live'

// One clock for the whole page: "active" and "ago" labels re-evaluate on it.
setInterval(() => emit('clock'), 1000)
export const useClock = () => useChannel('clock')
/** A slower clock for what changes in 30 s steps (sparkline buckets), ticking on their boundaries. */
setTimeout(() => (emit('clock:30s'), setInterval(() => emit('clock:30s'), 30_000)), 30_000 - (Date.now() % 30_000))

/** Activity this recent counts as "working right now"; motion stops after it (accuracy contract). */
export const ACTIVE_MS = 8000

export function ago(ms: number | null | undefined): string {
  if (ms == null) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export type ToolKind = 'read' | 'edit' | 'run' | 'web' | 'agent' | 'other'

export function toolKind(name: string): ToolKind {
  if (/^(Read|Glob|Grep|LS|NotebookRead|LSP)$/.test(name)) return 'read'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit'
  if (/^(Bash|BashOutput|KillShell|Monitor|TaskStop)$/.test(name)) return 'run'
  if (/^(WebFetch|WebSearch)$/.test(name) || /web|fetch|search|exa/i.test(name)) return 'web'
  if (/^(Agent|Task|Workflow|SendMessage|Skill)$/.test(name)) return 'agent'
  return 'other'
}
export const toolColor = (name: string) => `var(--tool-${toolKind(name)})`

/** First word of a tool-call summary ("Bash {...}") is the tool name. */
export const toolFromSummary = (summary: string) => summary.split(/[\s{]/, 1)[0] ?? ''

export type CardState = 'working' | 'idle' | 'needs' | 'offline' | 'ended' | 'unknown'

export function cardState(s: SessionSummary, needs: boolean): CardState {
  if (s.state === 'ended') return 'ended'
  if (needs) return 'needs'
  if (!s.connected) return 'offline'
  // Background subagents keep a session working while its main loop waits.
  if (s.state === 'working' || s.subagents?.length) return 'working'
  if (s.state === 'idle') return 'idle'
  return 'unknown'
}

export const STATE_LABEL: Record<CardState, string> = {
  working: 'Working',
  idle: 'Idle',
  needs: 'Needs you',
  offline: 'Offline',
  ended: 'Ended',
  unknown: 'Unknown',
}

/** Each state has its own shape, so state never depends on color alone. */
export function StateGlyph({ s }: { s: CardState }) {
  const common = { className: `state-glyph ${s}`, viewBox: '0 0 10 10', 'aria-hidden': true } as const
  switch (s) {
    case 'working':
      return <svg {...common}><circle cx="5" cy="5" r="4.5" fill="currentColor" /></svg>
    case 'idle':
      return <svg {...common}><circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    case 'needs':
      return <svg {...common}><path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" fill="currentColor" /></svg>
    case 'offline':
      return <svg {...common}><circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" /></svg>
    default:
      return <svg {...common}><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
  }
}

export function personColor(identity: string): string {
  if (state.me?.identity === identity) return state.me.color
  for (const p of state.presences.values()) if (p.identity === identity) return p.color
  // Same palette and hash as the server, for people who aren't online.
  const colors = ['oklch(0.55 0.17 255)', 'oklch(0.53 0.14 155)', 'oklch(0.55 0.2 330)', 'oklch(0.54 0.12 210)', 'oklch(0.55 0.19 290)', 'oklch(0.56 0.18 30)']
  let h = 0
  for (const c of identity) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return colors[h % colors.length]!
}

/**
 * A ticket's status the way Linear draws it, in Linear's color for it. Session state uses
 * circles too, so this always sits beside the ticket's id, and the status name is in its label.
 */
export function TicketGlyph({ status }: { status: Ticket['status'] }) {
  const common = { className: 'ticket-glyph', viewBox: '0 0 14 14', style: { ['--c' as string]: status.color }, role: 'img', 'aria-label': status.name } as const
  const ring = (dash?: string) => <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} />
  switch (status.type) {
    case 'triage':
      return <svg {...common}>{ring()}<circle cx="7" cy="7" r="2" fill="currentColor" /></svg>
    case 'backlog':
      return <svg {...common}>{ring('1.6 1.6')}</svg>
    case 'started':
      return <svg {...common}>{ring()}<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" /></svg>
    case 'completed':
      return <svg {...common}><circle cx="7" cy="7" r="6.25" fill="currentColor" /><path d="M4.5 7.2 6.2 8.8 9.6 5.4" fill="none" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    case 'canceled':
      return <svg {...common}><circle cx="7" cy="7" r="6.25" fill="currentColor" /><path d="M5 5l4 4M9 5l-4 4" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" /></svg>
    default:
      return <svg {...common}>{ring()}</svg>
  }
}

/** A ticket's id, which opens it in Linear when the server has read its link. */
export function TicketId({ id, ticket }: { id: string; ticket: Ticket | undefined }) {
  if (!ticket?.url) return <span className="ticket-id">{id}</span>
  return (
    <a className="ticket-id nodrag" href={ticket.url} target="_blank" rel="noreferrer" title={`Open ${id} in Linear`} onClick={e => e.stopPropagation()}>
      {id}
    </a>
  )
}

/** What Linear says about a ticket, in one line for a tooltip. */
export const ticketSummary = (id: string, t: Ticket | undefined) =>
  t ? `${id} ${t.title} · ${t.status.name}${t.assignee ? ` · ${t.assignee}` : ''}` : id

export function Avatar({ name, size, title }: { name: string; size?: 'sm'; title?: string }) {
  return (
    <span className={`avatar ${size ?? ''}`} style={{ ['--c' as string]: personColor(name) }} title={title ?? name} aria-label={title ?? name}>
      {name.slice(0, 1)}
    </span>
  )
}

export const Icon = {
  close: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  ),
  stop: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
  ),
  note: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h9v7l-3 3.5h-6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M9.5 13v-3.5h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
  ),
  bell: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5v2.6L3.3 11h9.4l-1.2-2.4V6A3.5 3.5 0 0 0 8 2.5zM6.5 13a1.6 1.6 0 0 0 3 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
  ),
  search: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  ),
  branch: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="11.5" cy="6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M4.5 5.1v5.8M11.5 7.6c0 2.4-2.5 2.6-7 3.3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
  ),
  fit: (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
}

/** One tool call: from a row's structured input when it has one, else from its text. */
export { parseToolCall }

export function ToolCall({ text, call }: { text?: string; call?: { name: string; input: Record<string, unknown> } }) {
  const c = call ? describeCall(call.name, call.input) : parseToolCall(text ?? '')
  return (
    <div className="call">
      <div className="call-main">
        <span className="tool-tag" style={{ ['--c' as string]: toolColor(c.name) }}>{c.name}</span>
        {c.main && <code>{c.main}</code>}
      </div>
      {c.desc && <div className="call-desc">{c.desc}</div>}
      {/* Whatever the line above leaves out is one click away: owners approve on this. */}
      {(c.input ? Object.keys(c.input).some(k => k !== c.mainKey && k !== 'description') : c.raw !== null) && (
        <details>
          <summary>Full input</summary>
          <pre>{c.input ? JSON.stringify(c.input, null, 2) : c.raw}</pre>
        </details>
      )}
    </div>
  )
}
