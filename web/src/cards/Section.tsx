import { memo } from 'react'
import { CANVAS } from '../../../shared/protocol'
import { state, useChannel } from '../live'
import { cardState, TicketGlyph, TicketId, ticketSummary } from '../ui'
import { stop, type ZoomBand } from './SessionCard'

export type SectionInfo = { title: string; ticket: string | null; repos: string[]; sessionIds: string[] }

/**
 * A frame's label: its repo, or its ticket with status, title and assignee, and how many of its
 * sessions are working. Plain React, like the cards.
 */
export const SectionLabel = memo(function SectionLabel({ d, band, onTidy }: { d: SectionInfo; band: ZoomBand; onTidy: () => void }) {
  useChannel('session-states')
  useChannel(`ticket:${d.ticket}`)
  const ticket = d.ticket ? state.tickets.get(d.ticket) : undefined
  // Same rule as the cards: an offline session isn't working, whatever it last reported.
  const working = d.sessionIds.filter(id => {
    const s = state.sessions.get(id)
    return s && cardState(s, false) === 'working'
  }).length
  // A ticket's frame: zoomed out, its id and status; closer, its title and assignee too.
  const about = ticket ? [ticket.status.name, band !== 'far' && ticket.assignee].filter(Boolean).join(' · ') + ' · ' : ''
  // With a title, a ticket's label takes two lines: the title is what people read.
  return (
    <div className={ticket && band !== 'far' ? 'region-label two-lines' : 'region-label'} title={d.ticket ? ticketSummary(d.ticket, ticket) : d.title}>
      <span className={d.ticket ? 'name ticket' : 'name'}>
        {ticket && <TicketGlyph status={ticket.status} />}
        {d.ticket ? <TicketId id={d.ticket} ticket={ticket} /> : d.title}
        {ticket && band !== 'far' && <span className="ticket-title">{ticket.title}</span>}
      </span>
      <small>
        {about}
        {d.repos.length && band !== 'far' ? `${d.repos.join(', ')} · ` : ''}
        {d.sessionIds.length} session{d.sessionIds.length === 1 ? '' : 's'}
        {working ? ` · ${working} working` : ''}
      </small>
      <button className="btn ghost small tidy nodrag" onPointerDown={stop} onClick={onTidy} title="Pack these cards into order, closing the gaps">
        Tidy
      </button>
    </div>
  )
})

/** Where Tidy puts a frame's cards: consecutive slots, in their current reading order. */
export function tidySlots(cards: { id: string; x: number; y: number }[]): { id: string; x: number; y: number }[] {
  const { cardW, cardH, gap, pad, cols } = CANVAS
  return [...cards]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ id }, i) => ({ id, x: pad + (i % cols) * (cardW + gap), y: pad + Math.floor(i / cols) * (cardH + gap) }))
}
