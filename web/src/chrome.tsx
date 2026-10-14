// The canvas's chrome: what sits around and above it.
import { useEffect, useState } from 'react'
import { CANVAS, type SessionSummary } from '../../shared/protocol'
import { state, toasts, useChannel } from './live'

/**
 * Whether a session's card shows. Finished sessions get out of the way after a while, and so do
 * sessions offline for hours (a laptop that wakes up brings its sessions back). "Show inactive"
 * shows them all.
 */
export function sessionShows(s: SessionSummary, showEnded: boolean, now = Date.now()): boolean {
  const seen = now - Date.parse(s.lastSeenAt ?? s.startedAt)
  return showEnded || (s.state === 'ended' ? seen < CANVAS.endedVisibleMs : s.connected || seen < CANVAS.offlineVisibleMs)
}

/** "Show inactive", a per-viewer preference, so it lives in this browser. */
export function useShowEnded(): [boolean, (f: (v: boolean) => boolean) => void] {
  const [showEnded, setShowEnded] = useState(() => {
    try {
      return localStorage.getItem('sphere-show-ended') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('sphere-show-ended', showEnded ? '1' : '0')
    } catch {}
  }, [showEnded])
  return [showEnded, setShowEnded]
}

/** ⌘K: find a session by task, repo, branch, owner, ticket (id or title) or estra stage, then fly to it. */
export function Search({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const results = [...state.sessions.values()]
    .filter(s => s.state !== 'ended' || words.length)
    .map(s => ({ s, hay: [s.task, s.repo, s.branch, s.owner, s.machine, s.id.slice(0, 8), s.ticket?.id, s.ticket && state.tickets.get(s.ticket.id)?.title, s.labels?.stage].filter(Boolean).join(' ').toLowerCase() }))
    .filter(r => words.every(w => r.hay.includes(w)))
    .sort((a, b) => Number(a.s.state === 'ended') - Number(b.s.state === 'ended') || (b.s.lastActivityAt ?? '').localeCompare(a.s.lastActivityAt ?? ''))
    .slice(0, 8)
  const pick = (k: number) => results[k] && onPick(results[k]!.s.id)
  return (
    <div className="search-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="search" role="dialog" aria-label="Find a session">
        <input
          autoFocus
          value={q}
          placeholder="Find a session: task, ticket, repo, branch or person"
          aria-label="Search sessions"
          aria-controls="search-results"
          aria-activedescendant={results[i] ? `sr-${results[i]!.s.id}` : undefined}
          onChange={e => (setQ(e.target.value), setI(0))}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') (e.preventDefault(), setI(x => Math.min(x + 1, results.length - 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setI(x => Math.max(x - 1, 0)))
            else if (e.key === 'Enter') pick(i)
          }}
        />
        <ul id="search-results" role="listbox">
          {results.length === 0 && <li className="search-empty">No session matches “{q}”.</li>}
          {results.map((r, k) => (
            <li
              key={r.s.id}
              id={`sr-${r.s.id}`}
              role="option"
              aria-selected={k === i}
              onMouseEnter={() => setI(k)}
              onMouseDown={e => (e.preventDefault(), pick(k))}
            >
              <span className="search-title">{r.s.task ?? r.s.branch ?? r.s.id.slice(0, 8)}</span>
              <span className="search-meta">
                {r.s.ticket || r.s.labels?.stage ? `${[r.s.ticket?.id, r.s.labels?.stage].filter(Boolean).join(' ')} · ` : ''}{r.s.repo ?? 'no repo'} · {r.s.owner} · {r.s.state}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function Toasts() {
  useChannel('toasts')
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
      ))}
    </div>
  )
}

