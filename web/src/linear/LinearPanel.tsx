// The inspector's Linear panel: the viewer's own Linear account (CS-2524), and changing the
// session's ticket or making a new one, as the viewer (CS-2523). Every change goes to Linear as
// the viewer; Linear's answer reaches every canvas from the server.
import { useEffect, useId, useState } from 'react'
import { isLinearId, type SessionSummary, type TicketOptions } from '../../../shared/protocol'
import { cmd, state, toast } from '../live'
import { connectLinear, disconnectLinear, useLinearAccount } from './account'
import './linear.css'

type Team = { id: string; key: string; name: string }

export function LinearPanel({ session: s }: { session: SessionSummary }) {
  const account = useLinearAccount()
  const [open, setOpen] = useState<'edit' | 'new' | null>(null)
  // One inspector serves session after session: a form open for one isn't the next one's.
  useEffect(() => setOpen(null), [s.id])
  // Not asked yet, or a server from before Linear accounts: nothing to offer.
  if (!account || 'unsupported' in account) return null
  if (!account.enabled) return <p className="hint linear-line">{account.reason}</p>
  if (!account.connected)
    return (
      <div className="linear-line">
        <span className="hint">Connect your Linear account, so what Dyson Sphere changes in Linear for you is done as you.</span>
        <button className="btn small" onClick={() => void connectLinear()}>Connect Linear</button>
      </div>
    )
  const ticket = s.ticket && isLinearId(s.ticket.id) ? s.ticket.id : null
  return (
    <div className="linear-panel">
      <div className="linear-line">
        {ticket && (
          <button className="btn small" aria-expanded={open === 'edit'} onClick={() => setOpen(open === 'edit' ? null : 'edit')}>
            Edit {ticket}
          </button>
        )}
        <button className="btn small" aria-expanded={open === 'new'} onClick={() => setOpen(open === 'new' ? null : 'new')}>
          New ticket
        </button>
        <span className="hint linear-who" title={account.user.email ?? undefined}>as {account.user.name}</span>
        <button className="btn small ghost" onClick={() => void disconnectLinear()} title="Forget your Linear account here, and ask Linear to revoke Dyson Sphere's access">Disconnect</button>
      </div>
      {open === 'edit' && ticket && <EditTicket key={ticket} id={ticket} sessionId={s.id} onDone={() => setOpen(null)} />}
      {open === 'new' && <NewTicket session={s} onDone={() => setOpen(null)} />}
    </div>
  )
}

/** Status, assignee and title, from the ticket's team's own lists. Only what changed is sent. */
function EditTicket({ id, sessionId, onDone }: { id: string; sessionId: string; onDone: () => void }) {
  const ids = useId()
  const [options, setOptions] = useState<TicketOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What the form opened with: only fields the person changed from it are sent, so a change
  // someone else makes meanwhile isn't undone by fields this person didn't touch.
  const [start, setStart] = useState<{ title: string; stateId: string; assigneeId: string | null } | null>(null)
  const [title, setTitle] = useState('')
  const [stateId, setStateId] = useState('')
  const [assigneeId, setAssigneeId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    cmd<TicketOptions>('ticket.options', { id, sessionId }).then(
      o => {
        if (!alive) return
        setOptions(o)
        // The ticket as the person's own Linear reads it; servers from before that send what the page has.
        const t = o.ticket ?? state.tickets.get(id)
        const opened = {
          title: t?.title ?? '',
          stateId: o.statuses.find(x => x.name === t?.status.name)?.id ?? '',
          assigneeId: o.members.find(m => m.name === t?.assignee)?.id ?? null,
        }
        setStart(opened)
        setTitle(opened.title)
        setStateId(opened.stateId)
        setAssigneeId(opened.assigneeId)
      },
      e => alive && setError((e as Error).message),
    )
    return () => void (alive = false)
  }, [id])

  const save = async () => {
    if (!options || !start) return
    const change: Record<string, unknown> = {}
    if (title.trim() && title.trim() !== start.title) change.title = title
    if (stateId && stateId !== start.stateId) change.stateId = stateId
    if (assigneeId !== start.assigneeId) change.assigneeId = assigneeId
    if (!Object.keys(change).length) return onDone()
    setBusy(true)
    setError(null)
    try {
      await cmd('ticket.update', { id, sessionId, ...change })
      toast(`Changed ${id} in Linear.`)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="linear-form" onSubmit={e => (e.preventDefault(), void save())} aria-label={`Change ${id} in Linear`}>
      {!options && !error && <p className="hint">Asking Linear for {id}'s statuses and people…</p>}
      {options && (
        <>
          <label htmlFor={`${ids}-title`}>Title</label>
          <input id={`${ids}-title`} value={title} onChange={e => setTitle(e.target.value)} maxLength={255} required={!!start?.title} />
          <div className="linear-two">
            <div>
              <label htmlFor={`${ids}-status`}>Status</label>
              <select id={`${ids}-status`} value={stateId} onChange={e => setStateId(e.target.value)}>
                {!stateId && <option value="">Unknown</option>}
                {options.statuses.map(x => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${ids}-assignee`}>Assignee</label>
              <select id={`${ids}-assignee`} value={assigneeId ?? ''} onChange={e => setAssigneeId(e.target.value || null)}>
                <option value="">Unassigned</option>
                {options.members.map(m => (
                  <option key={m.id} value={m.id}>{m.name}{m.id === options.viewer ? ' (you)' : ''}</option>
                ))}
              </select>
            </div>
          </div>
        </>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="linear-actions">
        <button type="button" className="btn small ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn small primary" disabled={!start || busy || (!!start.title && !title.trim())}>{busy ? 'Saving…' : 'Save in Linear'}</button>
      </div>
    </form>
  )
}

/** A new ticket in a team, attached to this session when it's the viewer's and estra didn't name one. */
function NewTicket({ session: s, onDone }: { session: SessionSummary; onDone: () => void }) {
  const ids = useId()
  const [teams, setTeams] = useState<Team[] | null>(null)
  const [team, setTeam] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const canAttach = s.owner === state.me?.identity && !s.labels?.ticket
  const [attach, setAttach] = useState(canAttach && !s.ticket)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    cmd<{ teams: Team[] }>('ticket.teams').then(
      r => {
        if (!alive) return
        setTeams(r.teams)
        // The team of the ticket the session has, or else the first.
        const key = s.ticket?.id.split('-')[0]
        setTeam((r.teams.find(t => t.key === key) ?? r.teams[0])?.id ?? '')
      },
      e => alive && setError((e as Error).message),
    )
    return () => void (alive = false)
  }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await cmd<{ ticket: { id: string } }>('ticket.create', { teamId: team, title, description, ...(attach && { sessionId: s.id }) })
      toast(attach ? `Made ${r.ticket.id} in Linear, as this session's ticket.` : `Made ${r.ticket.id} in Linear.`)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="linear-form" onSubmit={e => (e.preventDefault(), void create())} aria-label="New ticket in Linear">
      {!teams && !error && <p className="hint">Asking Linear for your teams…</p>}
      {teams && (
        <>
          <label htmlFor={`${ids}-team`}>Team</label>
          <select id={`${ids}-team`} value={team} onChange={e => setTeam(e.target.value)}>
            {teams.map(t => (
              <option key={t.id} value={t.id}>{t.name} ({t.key})</option>
            ))}
          </select>
          <label htmlFor={`${ids}-title`}>Title</label>
          <input id={`${ids}-title`} value={title} onChange={e => setTitle(e.target.value)} maxLength={255} required autoFocus />
          <label htmlFor={`${ids}-description`}>Description <span className="hint">(Markdown, optional)</span></label>
          <textarea id={`${ids}-description`} value={description} onChange={e => setDescription(e.target.value)} rows={4} />
          {canAttach && (
            <label className="linear-check">
              <input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} />
              {s.ticket ? `Make it this session's ticket, instead of ${s.ticket.id}` : "Make it this session's ticket"}
            </label>
          )}
        </>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="linear-actions">
        <button type="button" className="btn small ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn small primary" disabled={!teams || !team || busy || !title.trim()}>{busy ? 'Making…' : 'Make in Linear'}</button>
      </div>
    </form>
  )
}
