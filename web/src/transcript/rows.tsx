// One transcript row each: prompts, replies, thinking, notes, tool calls, groups of calls and
// subagents. `data-row-id` and `data-find-text` mark what find in transcript searches.
import { memo } from 'react'
import { actionOf } from './classify'
import { useTranscript } from './context'
import { Markdown } from './Markdown'
import type { TimelineRow, ToolEntry } from './model'
import { LongText, openByDefault, PermissionBadge, ToolDetail } from './tools'

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function duration(t: ToolEntry): string | null {
  if (!t.result) return null
  const ms = Date.parse(t.result.at) - Date.parse(t.at)
  if (!(ms >= 1000)) return null
  return ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`
}

const STATUS = { running: 'Running', done: 'Done', error: 'Failed' } as const

export function ToolRow({ tool, nested = false }: { tool: ToolEntry; nested?: boolean }) {
  const { isOpen, toggle } = useTranscript()
  const id = `t:${tool.id}`
  const fallback = openByDefault(tool)
  const open = isOpen(id, fallback)
  const took = duration(tool)
  return (
    <div className={`tx-tool ${tool.status} ${open ? 'open' : ''} ${nested ? 'nested' : ''}`} data-action={actionOf(tool.name)}>
      <button className="tx-tool-head" aria-expanded={open} onClick={() => toggle(id, fallback)}>
        <span className="tx-dot" aria-hidden />
        <span className="tx-tool-name">{tool.name}</span>
        <span className="tx-tool-label" data-find-text title={tool.label}>{tool.target}</span>
        {tool.permission && <PermissionBadge p={tool.permission} />}
        <span className="tx-tool-meta">
          {tool.status !== 'done' && <span className={`tx-status ${tool.status}`}>{STATUS[tool.status]}</span>}
          {took && <span>{took}</span>}
        </span>
      </button>
      {open && (
        <div className="tx-tool-body">
          <ToolDetail tool={tool} />
        </div>
      )}
    </div>
  )
}

function WorkRow({ row }: { row: Extract<TimelineRow, { kind: 'work' }> }) {
  const { isOpen, toggle } = useTranscript()
  const open = isOpen(row.id, false)
  return (
    <div className={`tx-work ${open ? 'open' : ''}`}>
      <button className="tx-work-head" aria-expanded={open} onClick={() => toggle(row.id, false)}>
        <span className="tx-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
        <span data-find-text>{row.summary}</span>
        {row.failed && <span className="tx-status error">a call failed</span>}
        <span className="tx-tool-meta">{row.tools.length} calls</span>
      </button>
      {open && row.tools.map(t => <ToolRow key={t.id} tool={t} nested />)}
    </div>
  )
}

function SubagentRow({ row }: { row: Extract<TimelineRow, { kind: 'subagent' }> }) {
  const { isOpen, toggle, renderRows } = useTranscript()
  const open = isOpen(row.id, false)
  return (
    <div className={`tx-tool ${open ? 'open' : ''}`} data-action="agent">
      <button className="tx-tool-head" aria-expanded={open} onClick={() => toggle(row.id, false)}>
        <span className="tx-dot" aria-hidden />
        <span className="tx-tool-name">Subagent</span>
        <span className="tx-tool-label" data-find-text>{row.run.task}</span>
        <span className="tx-tool-meta">{row.run.count === 1 ? '1 call' : `${row.run.count} calls`}</span>
      </button>
      {!open && row.run.last && <div className="tx-sub-last" data-find-text>{row.run.last}</div>}
      {open && <div className="tx-tool-body tx-nested">{renderRows(row.run.rows)}</div>}
    </div>
  )
}

function Thinking({ row }: { row: Extract<TimelineRow, { kind: 'thinking' }> }) {
  const { isOpen, toggle } = useTranscript()
  const open = isOpen(row.id, false)
  return (
    <div className={`tx-thinking ${open ? 'open' : ''}`}>
      <button className="tx-thinking-head" aria-expanded={open} onClick={() => toggle(row.id, false)}>
        <span className="tx-chevron" aria-hidden>{open ? '▾' : '▸'}</span> Thinking
      </button>
      {/* Closed, it still shows its first lines; find opens it to show a match further down. */}
      <div className="tx-thinking-body" data-find-text data-find-fold={open ? undefined : ''} onClick={() => !open && toggle(row.id, false)}>
        {open ? <LongText text={row.text} bodyId={row.bodyId} fullLength={row.fullLength} markdown /> : row.text.replace(/\*\*|__/g, '')}
      </div>
    </div>
  )
}

/** A note: a steering message, a notice, the engine's notification. Long ones open on click. */
function Note({ row }: { row: Extract<TimelineRow, { kind: 'note' }> }) {
  const { isOpen, toggle } = useTranscript()
  const long = row.text.length > 240 || row.text.split('\n').length > 3
  const open = isOpen(row.id, false)
  return (
    <div className={`tx-note ${long && !open ? 'folded' : ''}`} onClick={long && !open ? () => toggle(row.id, false) : undefined}>
      <span className="tx-note-label">{row.label}</span>
      <span data-find-text data-find-fold={long && !open ? '' : undefined}>
        {long && !open ? row.text : <LongText text={row.text} bodyId={row.bodyId} fullLength={row.fullLength} className="tx-note-text" />}
      </span>
    </div>
  )
}

/** `nested`: drawn inside a subagent, whose prompt is the task it was given. */
export const Row = memo(function Row({ row, nested = false }: { row: TimelineRow; nested?: boolean }) {
  const { agent } = useTranscript()
  switch (row.kind) {
    case 'prompt':
      return (
        <div className={`tx-prompt ${nested ? '' : 'mine'}`} data-turn={row.turn}>
          <div className="tx-who">{nested ? 'Task' : 'You'}<span className="tx-time">{time(row.at)}</span></div>
          <div className="tx-bubble" data-find-text>
            <LongText text={row.text} bodyId={row.bodyId} fullLength={row.fullLength} className="tx-prompt-text" />
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="tx-reply">
          {/* Your messages stand apart as bubbles, so the agent's need a name only inside a subagent or while being written. */}
          {(nested || row.streaming) && (
            <div className="tx-who">
              {nested ? 'Subagent' : agent === 'codex' ? 'Codex' : 'Claude'}
              {row.streaming && <span className="tx-writing">writing…</span>}
            </div>
          )}
          <div data-find-text>
            {row.streaming ? <Markdown text={row.text} streaming /> : <LongText text={row.text} bodyId={row.bodyId} fullLength={row.fullLength} markdown />}
          </div>
        </div>
      )
    case 'thinking':
      return <Thinking row={row} />
    case 'note':
      return <Note row={row} />
    case 'tool':
      return <ToolRow tool={row.tool} />
    case 'work':
      return <WorkRow row={row} />
    case 'subagent':
      return <SubagentRow row={row} />
    case 'result':
      return (
        <div className={`tx-orphan ${row.isError ? 'error' : ''}`}>
          <div className="tx-quiet">{row.isError ? 'Error' : 'Result'} of an earlier call</div>
          <LongText text={row.text} bodyId={row.bodyId} fullLength={row.fullLength} className={`tx-pre ${row.isError ? 'error' : ''}`} />
        </div>
      )
  }
})
