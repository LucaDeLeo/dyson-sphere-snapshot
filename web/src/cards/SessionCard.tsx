import { memo, useEffect, useRef, useState } from 'react'
import { rollBuckets, state, tryCmd, useChannel, type Delivery } from '../live'
import { ACTIVE_MS, ago, Avatar, cardState, Icon, parseToolCall, STATE_LABEL, StateGlyph, TicketGlyph, TicketId, ticketSummary, toolColor, toolFromSummary } from '../ui'

/** How close the viewer is: far out a card is a tile; close in it shows transcript rows. */
export type ZoomBand = 'far' | 'mid' | 'near'
export const FAR = 0.7
export const NEAR = 1.5
export const zoomBand = (zoom: number): ZoomBand => (zoom < FAR ? 'far' : zoom >= NEAR ? 'near' : 'mid')

// Sessions that start while the page is open scale in; the ones already there don't.
const PAGE_OPENED = Date.now()

/** Keeps a press on a control from starting a drag or a selection on the canvas. */
export const stop = (e: { stopPropagation(): void }) => e.stopPropagation()
/** The wheel scrolls a list that can scroll, instead of the canvas. */
const stopIfScrolls = (e: React.WheelEvent<HTMLElement>) => {
  if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation()
}

const STEPS = ['queued', 'at-bridge', 'injected', 'observed'] as const
const ROW_LABEL: Record<string, string> = { prompt: 'Prompt', assistant: 'Claude', 'tool-result': 'Result', 'tool-error': 'Error', note: 'Note', notice: 'Notice' }

/** The newest message to this session that's still on its way (or just arrived). */
function inFlight(sessionId: string): Delivery | null {
  let latest: Delivery | null = null
  for (const d of state.deliveries.values()) if (d.sessionId === sessionId && (!latest || d.at > latest.at)) latest = d
  if (!latest) return null
  const age = Date.now() - Date.parse(latest.at)
  if (latest.state === 'observed' || latest.state === 'failed') return age < 5000 ? latest : null
  return age < 10 * 60_000 ? latest : null
}

function Steps({ d }: { d: Delivery }) {
  const reached = d.state === 'failed' ? 1 : STEPS.indexOf(d.state as (typeof STEPS)[number]) + 1
  return (
    <span className={`steps ${d.state === 'failed' ? 'failed' : ''}`} role="img" aria-label={`Delivery: ${d.state}`}>
      {STEPS.map((s, i) => <i key={s} className={i < reached ? 'on' : ''} />)}
    </span>
  )
}

function Sparkline({ buckets, active }: { buckets: number[]; active: boolean }) {
  const max = Math.max(3, ...buckets)
  return (
    <svg className="spark" width={118} height={18} viewBox="0 0 118 18" role="img" aria-label="Activity over the last 10 minutes">
      {buckets.map((v, i) => (
        <rect
          key={i}
          x={i * 6}
          y={0}
          width={4}
          height={18}
          rx={0.5}
          className={active && i === buckets.length - 1 && v > 0 ? 'hot' : ''}
          style={{ transform: `scaleY(${v === 0 ? 0.06 : Math.max(0.15, v / max)})` }}
        />
      ))}
    </svg>
  )
}

/**
 * A session's card: its state, latest action, tool track, sparkline, and Allow and Deny when it
 * waits for a permission. Plain React that knows nothing of the canvas around it, so tldraw
 * or a GPU layer can each place it. `band` is the zoom band it's seen at.
 */
export const SessionCard = memo(function SessionCard({ id, band, paused = false }: { id: string; band: ZoomBand; paused?: boolean }) {
  // What re-renders a card, kept to what it shows: with 2,000 cards, a channel every card hears
  // costs 2,000 renders. A paused card (off screen) hears nothing until it's back.
  const on = (channel: string) => (paused ? '' : channel)
  useChannel(on(`session:${id}`))
  useChannel(on(`live:${id}`))
  useChannel(on(`deliveries:${id}`))
  useChannel(on('needs'))
  useChannel(on(`viewers:${id}`))
  useChannel(on(`ticket:${state.sessions.get(id)?.ticket?.id}`))
  // Far out a card shows no "active 4s ago": its sparkline's 30 s buckets are enough.
  useChannel(on(band === 'far' ? 'clock:30s' : 'clock'))
  const s = state.sessions.get(id)
  const live = state.live.get(id)
  const seen = useRef<{ seq: number; ticks: Set<string>; needs: boolean } | null>(null)
  const [arrived, setArrived] = useState(false)
  const [received, setReceived] = useState(false)
  const [deciding, setDeciding] = useState(false)

  const perm = [...state.permissions.values()].find(p => p.sessionId === id && p.state === 'pending') ?? null
  const suggestions = [...state.suggestions.values()].filter(x => x.sessionId === id && x.status === 'pending').length
  const mine = s?.owner === state.me?.identity
  const flight = inFlight(id)

  useEffect(() => {
    const prev = seen.current
    if (prev && !prev.needs && perm) {
      setArrived(true)
      const t = setTimeout(() => setArrived(false), 1000)
      return () => clearTimeout(t)
    }
  }, [!!perm])

  useEffect(() => {
    if (flight?.state !== 'observed') return
    setReceived(true)
    const t = setTimeout(() => setReceived(false), 700)
    return () => clearTimeout(t)
  }, [flight?.msgId, flight?.state])

  // Far out the clock ticks every 30 s; the sweep still stops when its 8 s are up: one render then.
  const [, expire] = useState(0)
  const lastActivity = live?.lastActivityMs ?? null
  useEffect(() => {
    const left = lastActivity === null ? 0 : ACTIVE_MS - (Date.now() - lastActivity)
    if (band !== 'far' || paused || left <= 0) return
    const t = setTimeout(() => expire(n => n + 1), left + 20)
    return () => clearTimeout(t)
  }, [band, paused, lastActivity])

  if (!s) return null
  if (live) rollBuckets(live)
  // Red means it needs the viewer: someone else's request waits on them, not on you.
  const st = cardState(s, !!perm && mine)
  const active = st === 'working' && live?.lastActivityMs != null && Date.now() - live.lastActivityMs < ACTIVE_MS
  const latest = live?.latest ?? null
  const latestTool = latest?.kind === 'tool-call' ? (latest.tools?.[0]?.name ?? toolFromSummary(latest.summary)) : null
  const track = (live?.track ?? []).slice(-36)
  const viewers = [...state.presences.values()].filter(p => p.selected === id)
  // The frame already names the repo; a card says what its session is doing. In a
  // ticket's frame that's the stage estra started it for (its first prompt is estra's).
  const title = s.labels?.stage ?? s.task ?? s.branch ?? s.id.slice(0, 8)
  // The agent that runs, as its bridge says: a stage's own seats inherit its estra provider label.
  // The ticket has its own line below.
  const labels = s.agent === 'codex' ? 'Codex' : s.labels ? 'Claude' : null
  const ticketId = s.ticket?.id ?? null
  const ticket = ticketId ? state.tickets.get(ticketId) : undefined

  const firstRender = seen.current === null
  // Animate only what's new since the last render, never the first paint.
  const isNewSeq = seen.current !== null && latest !== null && latest.seq > seen.current.seq
  const newTicks = seen.current ? new Set(track.filter(t => !seen.current!.ticks.has(t.id)).map(t => t.id)) : new Set<string>()
  seen.current = { seq: latest?.seq ?? 0, ticks: new Set(track.map(t => t.id)), needs: !!perm }

  const decide = async (decision: 'allow' | 'deny') => {
    if (!perm) return
    setDeciding(true)
    await tryCmd('decide', { reqId: perm.reqId, decision })
    setDeciding(false)
  }

  const fresh = firstRender && Date.parse(s.startedAt) > PAGE_OPENED
  const classes = ['card', band, fresh && 'enter', st === 'ended' && 'ended', st === 'needs' && 'needs', arrived && 'arrived', !s.connected && st !== 'ended' && 'offline', active && 'active', received && 'received']
  return (
    <div className={classes.filter(Boolean).join(' ')} aria-label={`${title}, ${STATE_LABEL[st]}, owned by ${s.owner}`}>
      <span className="sweep" aria-hidden="true" />
      <div className="card-head">
        <StateGlyph s={st} />
        <div className="card-title" title={title}>{title}</div>
        <Avatar name={s.owner} />
      </div>
      {/* Far out a card is a tile: these aren't drawn at all, not just hidden. */}
      {band !== 'far' && (
        <>
        <div className="card-meta">
          {STATE_LABEL[st]}
          {s.subagents?.length ? ` · ${s.subagents.length} subagent${s.subagents.length > 1 ? 's' : ''}` : ''} · {labels ? `${labels} · ` : ''}{!s.labels && s.branch ? `${s.branch} · ` : ''}{s.machine.replace(/\.(lan|local|localdomain)$/, '')} ·{' '}
          {st === 'offline' ? `offline since ${ago(Date.parse(s.lastSeenAt ?? s.startedAt))}` : `active ${ago(live?.lastActivityMs)}`}
        </div>
        {ticketId && (
          <div className="card-ticket" title={ticketSummary(ticketId, ticket)}>
            {ticket && <TicketGlyph status={ticket.status} />}
            <TicketId id={ticketId} ticket={ticket} />
            {ticket && <span className="ticket-title">{ticket.title}</span>}
          </div>
        )}
        </>
      )}
      <div className="far-line">
        {perm ? (mine ? 'Waiting for your permission' : `Waiting for ${s.owner}'s permission`) : latest ? (latestTool ? `${latestTool} ${parseToolCall(latest.summary).main ?? ''}` : latest.summary) : STATE_LABEL[st]}
      </div>

      {/* Far out a card is a tile: these aren't drawn at all, not just hidden. */}
      {band !== 'far' && (
        <>
        {perm ? (
          <div className="card-perm">
            <span className="what">
              <b>{perm.tool}</b> {parseToolCall(`${perm.tool} ${perm.input}`).main ?? perm.input}
            </span>
            {mine ? (
              <>
                <button className="btn small nodrag" disabled={deciding} onPointerDown={stop} onClick={() => decide('deny')}>Deny</button>
                <button className="btn small needs nodrag" disabled={deciding} onPointerDown={stop} onClick={() => decide('allow')}>Allow</button>
              </>
            ) : (
              <span className="hint">waiting on {s.owner}</span>
            )}
          </div>
        ) : flight ? (
          <div className="flight-note">
            <Avatar name={flight.author} size="sm" />
            <span className="text">{flight.kind === 'interrupt' ? 'Interrupt' : (flight.text ?? flight.kind)}</span>
            <Steps d={flight} />
          </div>
        ) : (
          <div className="ticker" aria-live="off">
            {latest && (
              <div key={latest.seq} className={`ticker-line ${isNewSeq ? 'enter' : ''}`}>
                {latestTool && <span className="tool-tag" style={{ ['--c' as string]: toolColor(latestTool) }}>{latestTool}</span>}
                <span className="text">{latestTool ? (parseToolCall(latest.summary).main ?? latest.summary.slice(latestTool.length)) : latest.summary}</span>
              </div>
            )}
          </div>
        )}

        <div className="track" aria-label={`${track.length} recent tool calls`}>
          {track.length === 0 && <span className="track-empty">No tool calls yet</span>}
          {track.map(t => (
            <span
              key={t.id}
              title={`${t.sub ? 'Subagent: ' : ''}${t.name}${t.endedAt === null ? ' (running)' : t.failed ? ' (failed)' : ''}`}
              className={`tick ${t.sub ? 'sub' : ''} ${t.endedAt === null && st !== 'ended' ? 'running' : ''} ${t.failed ? 'failed' : ''} ${newTicks.has(t.id) ? 'new' : ''}`}
              style={{ ['--c' as string]: toolColor(t.name) }}
            />
          ))}
        </div>
        </>
      )}

      {band === 'near' && (
        <div className="rows nowheel" aria-label="Recent transcript" onWheel={stopIfScrolls}>
          {/* newest first in a column-reverse box: anchored to the bottom, scrolls up into history */}
          {(live?.rows ?? []).slice(-24).reverse().map(r => {
            const call = r.kind === 'tool-call' ? parseToolCall(r.summary) : null
            return (
              <div key={r.seq} className={r.kind}>
                {r.agentId ? '↳ ' : ''}
                <b>{call ? call.name : r.kind === 'assistant' && s.agent === 'codex' ? 'Codex' : (ROW_LABEL[r.kind] ?? r.kind)}</b> {call ? (call.main ?? r.summary) : r.summary}
              </div>
            )
          })}
        </div>
      )}

      <div className="card-foot">
        {live && <Sparkline buckets={live.buckets} active={active} />}
        {perm && mine && <span className="needs-big">Needs you</span>}
        {s.subagents?.length ? (
          <span className="badge sub" title={s.subagents.map(a => `${a.description} (${a.type})`).join('\n')}>
            {Icon.branch} {s.subagents.length === 1 ? s.subagents[0]!.description : `${s.subagents.length} subagents`}
          </span>
        ) : null}
        {suggestions > 0 && <span className="badge">{suggestions} suggestion{suggestions > 1 ? 's' : ''}</span>}
        <span className="spacer" />
        {viewers.length > 0 && (
          <span className="avatars" aria-label={`Viewing: ${viewers.map(v => v.identity).join(', ')}`}>
            {viewers.slice(0, 4).map(v => <Avatar key={v.conn} name={v.identity} size="sm" title={`${v.identity} is looking at this`} />)}
          </span>
        )}
      </div>
    </div>
  )
})

