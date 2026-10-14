import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { CODEX_CANNOT, type Mode, type PartialReply, type PermissionRequest, type StoredEvent } from '../../shared/protocol'
import { LinearPanel } from './linear/LinearPanel'
import { cmd, eventHooks, mergeDeliveries, partialHooks, state, subscribe, tryCmd, unsubscribe, useChannel, type Delivery } from './live'
import type { TranscriptSource } from './transcript/Transcript'
import { ago, Avatar, cardState, Icon, STATE_LABEL, StateGlyph, TicketGlyph, TicketId, ticketSummary, ToolCall, useClock } from './ui'

// Loaded when the first inspector opens: the canvas alone never fetches the transcript's code.
const Transcript = lazy(() => import('./transcript/Transcript').then(m => ({ default: m.Transcript })))

const STEP_LABEL: Record<string, string> = { queued: 'Queued', 'at-bridge': 'At the bridge', injected: 'Delivered', observed: 'Read by the agent', failed: 'Failed' }

/** What each subagent was asked to do, from the sessions' running subagents; kept after they finish. */
const agentNames = new Map<string, string>()

/** Whether the inspector is drawn wide, remembered per browser. */
const WIDE_KEY = 'sphere.inspector.wide'
const readWide = () => {
  try {
    return localStorage.getItem(WIDE_KEY) === '1'
  } catch {
    return false
  }
}

/** A session's rows over Dyson Sphere's socket, for <Transcript>. */
function sessionSource(sessionId: string): TranscriptSource {
  const topic = `session:${sessionId}`
  return {
    async page(before, limit) {
      const r = await cmd<{ rows: StoredEvent[]; deliveries: Delivery[]; more?: boolean }>('show', { sessionId, tail: limit, ...(before !== null && { before }) })
      if (before === null) mergeDeliveries(r.deliveries)
      return { rows: r.rows, more: r.more ?? false }
    },
    follow(since, onRow) {
      const hook = (ev: StoredEvent) => ev.topic === topic && onRow(ev)
      eventHooks.add(hook)
      subscribe(topic, since)
      return () => {
        eventHooks.delete(hook)
        unsubscribe(topic)
      }
    },
    body: async id => (await cmd<{ text: string }>('body', { id })).text,
    search: async query => (await tryCmd<{ seqs: number[] }>('search', { sessionId, query }))?.seqs ?? null,
    partials(onPartial) {
      const hook = (p: PartialReply) => p.sessionId === sessionId && onPartial(p)
      partialHooks.add(hook)
      return () => void partialHooks.delete(hook)
    },
  }
}

function DeliveryLine({ d }: { d: Delivery }) {
  return (
    <div className="delivery">
      <Avatar name={d.author} size="sm" />
      <span className="text">{d.kind === 'interrupt' ? 'Interrupt' : d.kind === 'fill' ? `Prompt box: ${d.text}` : d.text}</span>
      <span>{STEP_LABEL[d.state] ?? d.state}</span>
    </div>
  )
}

export function Inspector({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  useChannel(`session:${sessionId}`)
  useChannel(`deliveries:${sessionId}`)
  useChannel(`live:${sessionId}`)
  useChannel('needs')
  useChannel('conn')
  useChannel(`ticket:${state.sessions.get(sessionId)?.ticket?.id}`)
  useClock()
  const s = state.sessions.get(sessionId)
  const ticket = s?.ticket ? state.tickets.get(s.ticket.id) : undefined
  const [text, setText] = useState('')
  // Codex takes messages only while it works, so mid-turn is the useful default there.
  const [mode, setMode] = useState<Mode>(s?.agent === 'codex' ? 'steer' : 'queue')
  // One inspector serves session after session: a mode chosen for one isn't the next one's.
  useEffect(() => setMode(state.sessions.get(sessionId)?.agent === 'codex' ? 'steer' : 'queue'), [sessionId])
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const [wide, setWide] = useState(readWide)
  // A new connection has none of the old one's subscriptions: the transcript loads again.
  const source = useMemo(() => sessionSource(sessionId), [sessionId, state.epoch])
  // Every permission request of the session, answered ones included, to show at its call.
  const needs = useChannel('needs')
  // Running subagents have a description; finished ones keep it, or are named by their first prompt.
  const running = s?.subagents?.map(a => `${a.id}\n${a.description}`).join('\n') ?? ''
  const names = useMemo(() => {
    for (const a of state.sessions.get(sessionId)?.subagents ?? []) agentNames.set(a.id, a.description)
    return new Map(agentNames)
  }, [sessionId, running])
  const [asked, setAsked] = useState<PermissionRequest[]>([])
  useEffect(() => {
    let alive = true
    void tryCmd<{ permissions: PermissionRequest[] }>('permissions', { sessionId }).then(r => alive && r && setAsked(r.permissions))
    return () => void (alive = false)
  }, [sessionId, needs, state.epoch])

  if (!s) return null
  const me = state.me?.identity
  const mine = s.owner === me
  const perms = [...state.permissions.values()].filter(p => p.sessionId === sessionId && (p.state === 'pending' || p.state === 'deferred'))
  const suggestions = [...state.suggestions.values()].filter(x => x.sessionId === sessionId && x.status === 'pending')
  const deliveries = [...state.deliveries.values()].filter(d => d.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at)).slice(-4)
  const st = cardState(s, mine && perms.some(p => p.state === 'pending'))
  // What Codex's hooks can't carry is left out (the server refuses it too).
  const codex = s.agent === 'codex'
  const codexIdle = codex && s.state !== 'working'
  const title = s.task ?? s.repo ?? s.cwd.split('/').pop()

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    const body = text.trim()
    if (!body) return
    const ok = await run(() =>
      editing ? cmd('approve', { id: editing, text: body }) : cmd(mine ? 'send' : 'suggest', { sessionId, text: body, mode }),
    )
    if (ok) {
      setText('')
      setEditing(null)
    }
  }

  return (
    <aside className={`inspector ${wide ? 'wide' : ''}`} aria-label={`Session ${title}`}>
      <div className="insp-head">
        <div className="insp-title">
          <StateGlyph s={st} />
          <span>{title}</span>
          <button
            className="btn ghost small wide-toggle"
            aria-pressed={wide}
            onClick={() => {
              setWide(!wide)
              try {
                localStorage.setItem(WIDE_KEY, wide ? '0' : '1')
              } catch {}
            }}
            title={wide ? 'Narrower' : 'Wider'}
            aria-label={wide ? 'Make the inspector narrower' : 'Make the inspector wider'}
          >
            {Icon.fit}
          </button>
          <button className="btn ghost small close" onClick={onClose} aria-label="Close inspector">{Icon.close}</button>
        </div>
        <div className="insp-meta">
          <span>{STATE_LABEL[st]}</span>
          {s.ticket && (
            <span className="insp-ticket" title={ticketSummary(s.ticket.id, ticket)}>
              {ticket && <TicketGlyph status={ticket.status} />}
              <TicketId id={s.ticket.id} ticket={ticket} />
              {ticket && <span className="ticket-title">{ticket.title}</span>}
            </span>
          )}
          {s.labels && (
            <span title={s.labels.taskId ? `estra task ${s.labels.taskId}` : undefined}>
              {['estra', s.labels.stage, s.labels.provider].filter(Boolean).join(' · ')}
            </span>
          )}
          {s.repo && <span>{s.repo}</span>}
          <span>{s.owner} on {s.machine.replace(/\.(lan|local|localdomain)$/, '')}</span>
          {s.branch && <span>{s.branch}</span>}
          <span className="mono">{s.id.slice(0, 8)}</span>
          <span title={s.cwd}>{s.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
          <span>started {ago(Date.parse(s.startedAt))}</span>
        </div>
        {s.subagents?.length ? (
          <div className="insp-agents">
            {s.subagents.map(a => (
              <div key={a.id} className="insp-agent">
                {Icon.branch} <span>{a.description}</span>
                <span className="hint">{a.type}{a.background ? ', background' : ''} · {ago(Date.parse(a.startedAt))}</span>
              </div>
            ))}
          </div>
        ) : null}
        <LinearPanel session={s} />
        {mine && s.state !== 'ended' && s.agent !== 'codex' && (
          <div className="insp-actions">
            <button className="btn small" disabled={busy || s.state !== 'working'} onClick={() => run(() => cmd('interrupt', { sessionId }))}>
              {Icon.stop} Interrupt
            </button>
          </div>
        )}
      </div>

      <div className="insp-asks">
        {perms.map(p => (
          <div className="ask" key={p.reqId}>
            <div className="ask-title">
              {p.state === 'deferred' ? `Asked to run ${p.tool}` : `Permission to run ${p.tool}`} · {ago(Date.parse(p.requestedAt))}
            </div>
            <ToolCall text={`${p.tool} ${p.input}`} />
            {p.state === 'deferred' && <p className="hint">Nobody answered in time, so the agent carried on without it. If you allow it, the agent is told and can run it once.</p>}
            {mine ? (
              <div className="row">
                <button className="btn small needs" disabled={busy} onClick={() => run(() => cmd('decide', { reqId: p.reqId, decision: 'allow' }))}>{p.state === 'deferred' ? 'Allow' : 'Allow once'}</button>
                <button className="btn small" disabled={busy} onClick={() => run(() => cmd('decide', { reqId: p.reqId, decision: 'deny' }))}>{p.state === 'deferred' ? 'Decline' : 'Deny'}</button>
              </div>
            ) : (
              <span className="hint">Only {s.owner} can decide.</span>
            )}
          </div>
        ))}
        {suggestions.map(x => (
          <div className="ask suggestion" key={x.id}>
            <div className="ask-title">{x.author} suggests ({x.mode})</div>
            <pre>{x.text}</pre>
            {mine && codexIdle && <span className="hint">You can send it once the session is working again.</span>}
            {mine && (
              <div className="row">
                <button className="btn small primary" disabled={busy || codexIdle} onClick={() => run(() => cmd('approve', { id: x.id }))}>Send as is</button>
                <button
                  className="btn small"
                  disabled={codexIdle}
                  onClick={() => {
                    setText(x.text)
                    setEditing(x.id)
                    input.current?.focus()
                  }}
                >
                  Edit
                </button>
                <button className="btn small" disabled={busy} onClick={() => run(() => cmd('reject', { id: x.id }))}>Reject</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <Suspense fallback={<div className="hint transcript-loading">Loading the transcript…</div>}>
        <Transcript source={source} agent={s.agent} permissions={asked} agentNames={names} working={s.state === 'working'} running={s.subagents} />
      </Suspense>

      <div className="compose">
        {deliveries.length > 0 && <div className="deliveries">{deliveries.map(d => <DeliveryLine key={d.msgId} d={d} />)}</div>}
        {codex && s.state !== 'ended' && (
          <p className="hint codex-note">
            {codexIdle && mine
              ? CODEX_CANNOT.idle
              : 'Codex takes a message at its next tool call (Mid-turn) or as its turn ends (At turn end). It has no prompt box Dyson Sphere can reach, and it can’t be interrupted from here.'}
          </p>
        )}
        <textarea
          ref={input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
          placeholder={editing ? 'Edit the suggestion, then send it' : mine ? 'Message your agent' : `Suggest a message; ${s.owner} approves it first`}
          aria-label="Message"
          disabled={s.state === 'ended' || (codexIdle && mine)}
        />
        <div className="bar">
          <div className="seg" role="group" aria-label="Delivery mode">
            {((codex ? ['steer', 'queue'] : ['queue', 'steer', 'interrupt']) as Mode[]).map(m => (
              <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} title={m === 'queue' ? (codex ? 'Deliver as the running turn ends' : 'Deliver when the agent is idle') : m === 'steer' ? (codex ? 'Deliver at the next tool call' : 'Read at the next step of the running turn') : 'Stop the running turn, then deliver'}>
                {m === 'queue' ? (codex ? 'At turn end' : 'When idle') : m === 'steer' ? 'Mid-turn' : 'Interrupt'}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {mine && !editing && !codex && (
            <button className="btn small ghost" disabled={busy || !text.trim()} onClick={async () => (await run(() => cmd('fill', { sessionId, text: text.trim() }))) && setText('')} title="Put the text in your terminal's prompt box, to edit and send there">
              To prompt box
            </button>
          )}
          <button className="btn small primary" disabled={busy || !text.trim() || s.state === 'ended' || (codexIdle && mine)} onClick={send}>
            {editing ? 'Send edited' : mine ? 'Send' : `Suggest to ${s.owner}`} <span className="kbd">⌘↵</span>
          </button>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </aside>
  )
}
