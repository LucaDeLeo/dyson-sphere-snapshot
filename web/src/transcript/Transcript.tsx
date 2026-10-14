// A session's transcript: a plain React component that knows nothing of the canvas around it. It
// gets its rows from a TranscriptSource (the inspector passes one over Dyson Sphere's socket) and
// draws them in a virtualised list (@legendapp/list) that loads older rows as the reader scrolls
// up, with find in transcript and jumps between turns. Steering stays with whoever embeds it.
import { LegendList, type LegendListRef } from '@legendapp/list/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentKind, PartialReply, PermissionRequest, StoredEvent } from '../../../shared/protocol'
import type { RowData } from '../../../shared/rows'
import { Ctx, type TranscriptContext } from './context'
import { occurrences, useFindHighlights } from './find'
import { buildTimeline, foldsTo, partialKey, searchText, type TimelineRow } from './model'
import { Row } from './rows'
import './transcript.css'

export type TranscriptSource = {
  /** The last `limit` rows before row `before`, or the latest; `more` when older ones remain. */
  page(before: number | null, limit: number): Promise<{ rows: StoredEvent[]; more: boolean }>
  /** Calls `onRow` with each row stored after `since`, until the returned function is called. */
  follow(since: number, onRow: (ev: StoredEvent) => void): () => void
  /** A stored body: the whole of a field or text the row cut short. */
  body(id: string): Promise<string>
  /** The seqs of the session's rows that contain `query`, newest first; null where the server can't search. */
  search?(query: string): Promise<number[] | null>
  /** Calls `onPartial` with each reply in progress (servers from protocol 4), until the returned function is called. */
  partials?(onPartial: (p: PartialReply) => void): () => void
}

export type TranscriptProps = {
  source: TranscriptSource
  agent: AgentKind
  /** The session's permission requests, any state: each is shown at its call. */
  permissions?: PermissionRequest[]
  agentNames?: Map<string, string>
  /** The main agent is working on a turn. */
  working?: boolean
  /** The subagents still running, which may outlast the turn (in the background). */
  running?: { id: string }[]
  /** Shown when the session has no rows yet. */
  empty?: ReactNode
}

const PAGE = 200

type Match = { index: number; rowId: string; occurrence: number }

export function Transcript({ source, agent, permissions, agentNames, working = false, running = [], empty }: TranscriptProps) {
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Map<string, boolean>>(new Map())
  const list = useRef<LegendListRef>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const older = useRef<Promise<void> | null>(null)
  const oldest = useRef<number | null>(null)
  // The source shown now: a load that finishes after a switch to another session is dropped.
  const current = useRef(source)

  useEffect(() => {
    let alive = true
    let stop = () => {}
    current.current = source
    older.current = null
    setEvents([])
    setOpen(new Map())
    setLoading(true)
    setError(null)
    oldest.current = null
    source.page(null, PAGE).then(
      r => {
        if (!alive) return
        setEvents(r.rows)
        setMore(r.more)
        setLoading(false)
        oldest.current = r.rows[0]?.seq ?? null
        let last = r.rows.at(-1)?.seq ?? 0
        stop = source.follow(last, ev => {
          if (ev.seq <= last) return
          last = ev.seq
          setEvents(prev => [...prev, ev])
          // The message a reply in progress belonged to is in: its row replaces it.
          const d = ev.data as unknown as RowData
          if (d.kind === 'assistant' || d.kind === 'tool-call' || d.kind === 'thinking')
            setWriting(prev => {
              const kept = [...prev].filter(([key, p]) => (p.agentId ?? null) !== (d.agentId ?? null) || p.at > ev.at || (finished.current.add(key), false))
              return kept.length === prev.size ? prev : new Map(kept)
            })
        })
      },
      e => alive && (setError(String(e?.message ?? e)), setLoading(false)),
    )
    return () => {
      alive = false
      stop()
    }
  }, [source])

  /** Loads the page before the oldest row loaded. */
  const loadOlder = useCallback(() => {
    if (older.current || !more || oldest.current === null) return older.current ?? Promise.resolve()
    const mine = source
    older.current = source
      .page(oldest.current, PAGE)
      .then(r => {
        if (current.current !== mine) return
        oldest.current = r.rows[0]?.seq ?? oldest.current
        setMore(r.more)
        setEvents(prev => prepend(r.rows, prev))
      })
      .catch(e => void (current.current === mine && setError(String(e?.message ?? e))))
      .finally(() => current.current === mine && (older.current = null))
    return older.current
  }, [source, more])

  // Replies in progress, by response block; each carries all its completed paragraphs so far.
  const [writing, setWriting] = useState<Map<string, PartialReply>>(new Map())
  // A partial that arrives late, after its row or once its agent stopped, isn't shown.
  const finished = useRef(new Set<string>())
  const runningKey = running.map(a => a.id).join(' ')
  const live = useRef<(p: PartialReply) => boolean>(() => false)
  live.current = (p: PartialReply) => (p.agentId ? running.some(a => a.id === p.agentId) : working)
  useEffect(() => {
    setWriting(new Map())
    finished.current = new Set()
    return source.partials?.(p =>
      setWriting(prev => {
        const key = partialKey(p)
        if (!live.current(p) || finished.current.has(key)) return prev
        const had = prev.get(key)
        // One that arrives late, with fewer paragraphs, changes nothing.
        return had && had.text.length >= p.text.length ? prev : new Map(prev).set(key, p)
      }),
    )
  }, [source])
  // An agent that stopped has no reply in progress: the main agent once its turn ends, a subagent
  // once it finishes.
  useEffect(
    () =>
      setWriting(prev => {
        const kept = [...prev].filter(([, p]) => live.current(p))
        return kept.length === prev.size ? prev : new Map(kept)
      }),
    [working, runningKey],
  )

  const timeline = useMemo(
    () => buildTimeline(events, { agent, permissions, agentNames, working, writing: [...writing.values()] }),
    [events, agent, permissions, agentNames, working, writing],
  )
  const rows = timeline.rows

  const isOpen = useCallback((id: string, fallback: boolean) => open.get(id) ?? fallback, [open])
  const toggle = useCallback((id: string, fallback: boolean) => setOpen(prev => new Map(prev).set(id, !(prev.get(id) ?? fallback))), [])
  // Nested rows (a subagent's) are found as part of the row that holds them.
  const renderRows = useCallback((nested: TimelineRow[]) => nested.map(r => <div key={r.id} data-nested-id={r.id}><Row row={r} nested /></div>), [])
  const ctx: TranscriptContext = useMemo(() => ({ agent, body: source.body, renderRows, isOpen, toggle }), [agent, source, renderRows, isOpen, toggle])

  // --- find in transcript ---
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const [olderHits, setOlderHits] = useState<number | null>(null)
  const matches = useMemo<Match[]>(() => {
    if (!query.trim()) return []
    const out: Match[] = []
    rows.forEach((r, index) => occurrences(searchText(r), query).forEach((_, occurrence) => out.push({ index, rowId: r.id, occurrence })))
    return out
  }, [rows, query])
  const active = finding && matches.length ? matches[Math.min(at, matches.length - 1)]! : null

  // Matches the server finds further back than the rows loaded (newer servers only).
  useEffect(() => {
    setOlderHits(null)
    if (!finding || !query.trim() || !source.search) return
    const t = setTimeout(() => {
      source.search!(query).then(seqs => setOlderHits(seqs === null ? null : seqs.filter(s => oldest.current !== null && s < oldest.current).length), () => setOlderHits(null))
    }, 300)
    return () => clearTimeout(t)
  }, [finding, query, source, events.length])

  const show = useCallback(
    (m: Match | null) => {
      if (!m) return
      // Open everything between the row and the match: groups, calls, their folds, subagents.
      const row = rows[m.index]!
      setOpen(prev => {
        const next = new Map(prev)
        for (const id of foldsTo(row, query)) next.set(id, true)
        return next
      })
      void list.current?.scrollToIndex({ index: m.index, viewPosition: 0.3, animated: false })
    },
    [rows, query],
  )
  // Also on a new query whose first match sits where the last one's did: other folds may hold it.
  useEffect(() => show(active), [active?.rowId, active?.occurrence, query]) // eslint-disable-line react-hooks/exhaustive-deps

  const onActiveRange = useCallback((range: Range | null) => {
    // The list put the row in view; bring the match itself into view within it.
    const el = range?.startContainer.parentElement
    if (el && container) {
      const r = range!.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      if (r.top < box.top + 40 || r.bottom > box.bottom - 40) el.scrollIntoView({ block: 'center' })
    }
  }, [container])
  useFindHighlights({ container: finding ? container : null, query: query.trim(), active: active && { rowId: active.rowId, occurrence: active.occurrence }, onActive: onActiveRange })

  const findInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && container?.isConnected) {
        e.preventDefault()
        // Already open: select the query to type a new one. Opening focuses an empty input.
        if (findInput.current) findInput.current.select()
        else setFinding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [container])

  const step = (d: number) => matches.length && setAt(i => (Math.min(i, matches.length - 1) + d + matches.length) % matches.length)

  /**
   * Older pages until the earliest match the server found is loaded, then finds from there. It
   * holds the same lock as scrolling up, so the two never fetch the same page.
   */
  const loadAll = async () => {
    const mine = source
    while (older.current && current.current === mine) await older.current
    if (current.current !== mine) return
    const run = (async () => {
      const seqs = (await source.search?.(query)) ?? []
      if (!seqs.length) return
      const earliest = Math.min(...seqs)
      const pages: StoredEvent[][] = []
      let from = oldest.current
      let left = more
      while (from !== null && earliest < from && left) {
        const r = await source.page(from, 1000)
        if (!r.rows.length) break
        pages.unshift(r.rows)
        from = r.rows[0]!.seq
        left = r.more
      }
      if (current.current !== mine) return
      oldest.current = from
      setMore(left)
      setEvents(prev => prepend(pages.flat(), prev))
      setAt(0)
    })()
    const done = run.catch(e => void (current.current === mine && setError(String(e?.message ?? e)))).finally(() => current.current === mine && (older.current = null))
    older.current = done
    await done
  }

  // --- turns ---
  const [turnAt, setTurnAt] = useState<number | null>(null)
  const goTurn = (i: number) => {
    const t = timeline.turns[i]
    if (!t) return
    setTurnAt(i)
    void list.current?.scrollToIndex({ index: t.index, viewPosition: 0, animated: false })
  }
  const currentTurn = () => {
    if (turnAt !== null) return turnAt
    return timeline.turns.length - 1
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="tx" ref={setContainer} tabIndex={-1}>
        <div className="tx-bar">
          {finding ? (
            <div className="tx-find" role="search">
              <input
                ref={findInput}
                autoFocus
                value={query}
                placeholder="Find in transcript"
                aria-label="Find in transcript"
                onChange={e => (setQuery(e.target.value), setAt(0))}
                onKeyDown={e => {
                  if (e.key === 'Enter') (e.preventDefault(), step(e.shiftKey ? -1 : 1))
                  if (e.key === 'Escape') (setFinding(false), setQuery(''))
                }}
              />
              <span className="tx-find-count" aria-live="polite">
                {query.trim() ? (matches.length ? `${Math.min(at, matches.length - 1) + 1} of ${matches.length}` : 'No matches') : ''}
              </span>
              <button className="btn small ghost" disabled={!matches.length} onClick={() => step(-1)} aria-label="Previous match">↑</button>
              <button className="btn small ghost" disabled={!matches.length} onClick={() => step(1)} aria-label="Next match">↓</button>
              <button className="btn small ghost" onClick={() => (setFinding(false), setQuery(''))} aria-label="Close find">✕</button>
            </div>
          ) : (
            <>
              <span className="tx-bar-label">{timeline.turns.length === 1 ? '1 turn' : `${timeline.turns.length} turns`}{more ? ' loaded' : ''}</span>
              <button className="btn small ghost" disabled={!timeline.turns.length} onClick={() => goTurn(Math.max(0, currentTurn() - 1))} aria-label="Previous turn" title="Previous turn">↑ Turn</button>
              <button className="btn small ghost" disabled={!timeline.turns.length} onClick={() => goTurn(Math.min(timeline.turns.length - 1, currentTurn() + 1))} aria-label="Next turn" title="Next turn">↓ Turn</button>
              <button className="btn small ghost" onClick={() => setFinding(true)} title="Find in transcript (⌘F)">Find</button>
            </>
          )}
        </div>
        {finding && olderHits ? (
          <div className="tx-older-hits">
            {olderHits === 1 ? '1 more match' : `${olderHits} more matches`} in older history.{' '}
            <button className="tx-more" onClick={() => void loadAll()}>Load it</button>
          </div>
        ) : null}
        <div className="tx-body">
          {loading ? (
            <div className="tx-quiet tx-pad">Loading…</div>
          ) : error && !rows.length ? (
            <div className="tx-error-text tx-pad" role="alert">{error}</div>
          ) : !rows.length ? (
            <div className="tx-quiet tx-pad">{empty ?? 'No transcript rows yet.'}</div>
          ) : (
            <LegendList
              ref={list}
              data={rows}
              extraData={open}
              keyExtractor={r => r.id}
              renderItem={({ item }) => (
                <div data-row-id={item.id} className="tx-item">
                  <Row row={item} />
                </div>
              )}
              estimatedItemSize={56}
              initialScrollAtEnd
              maintainScrollAtEnd
              maintainVisibleContentPosition
              onStartReached={() => void loadOlder()}
              onStartReachedThreshold={0.5}
              recycleItems={false}
              style={{ height: '100%' }}
              ListHeaderComponent={more ? <div className="tx-quiet tx-pad">Loading older rows…</div> : timeline.turns.length ? <div className="tx-quiet tx-pad">Start of the session</div> : null}
            />
          )}
          {timeline.turns.length > 1 && <TurnRail turns={timeline.turns} rows={rows.length} current={turnAt} go={goTurn} />}
        </div>
      </div>
    </Ctx.Provider>
  )
}

/** Older rows in front of the loaded ones, leaving out any already loaded. */
function prepend(older: StoredEvent[], loaded: StoredEvent[]): StoredEvent[] {
  const have = new Set(loaded.map(e => e.seq))
  return [...older.filter(e => !have.has(e.seq)), ...loaded]
}

/** A mark per turn down the side, placed by where it starts; hover shows the prompt and reply. */
function TurnRail({ turns, rows, current, go }: { turns: { text: string; reply: string | null; index: number }[]; rows: number; current: number | null; go: (i: number) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const preview = hover !== null ? turns[hover] : null
  return (
    <nav className="tx-rail" aria-label="Turns">
      {turns.map((t, i) => (
        <button
          key={i}
          className={`tx-rail-mark ${i === current ? 'current' : ''}`}
          style={{ top: `${(t.index / Math.max(rows - 1, 1)) * 100}%` }}
          aria-label={`Turn ${i + 1}: ${t.text.slice(0, 80)}`}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(h => (h === i ? null : h))}
          onFocus={() => setHover(i)}
          onBlur={() => setHover(null)}
          onClick={() => go(i)}
        />
      ))}
      {preview && (
        <div className="tx-rail-preview" style={{ top: `${(preview.index / Math.max(rows - 1, 1)) * 100}%` }} role="tooltip">
          <div className="tx-rail-q">{preview.text.replace(/\s+/g, ' ').slice(0, 160)}</div>
          {preview.reply && <div className="tx-rail-a">{preview.reply.replace(/\s+/g, ' ').slice(0, 200)}</div>}
        </div>
      )}
    </nav>
  )
}
