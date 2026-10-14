// What each tool call shows when opened. The renderers for Bash, Edit, Read, Write, Task/Agent and
// TodoWrite are adapted from claude-code-viewer's tool visualizers (d-kimuson/claude-code-viewer
// src/web/app/projects/[projectId]/sessions/[sessionId]/components/conversationList/toolVisualizers
// @9367cf0; MIT, Copyright (c) 2025 Claude Code Viewer), restyled with our CSS and reading our rows.
// See web/THIRD_PARTY_NOTICES.md.
import { useState, type ReactNode } from 'react'
import type { PermissionRequest } from '../../../shared/protocol'
import { actionOf, commandText, shortPath } from './classify'
import { Diff } from './Diff'
import { created, fragment, fromCodexPatch, fromHunks, type FileChange } from './diffs'
import { Markdown } from './Markdown'
import type { CappedField } from '../../../shared/rows'
import type { ToolEntry } from './model'
import { hunks, list, num, obj, str, todos } from './toolTypes'
import { useTranscript } from './context'

/** Text that may have been cut short: "Show all" fetches the whole of it. */
export function LongText({ text, bodyId, fullLength, className, markdown = false }: { text: string; bodyId: string | null; fullLength: number | null; className?: string; markdown?: boolean }) {
  const { body } = useTranscript()
  const [full, setFull] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = full ?? text
  return (
    <>
      {markdown ? <Markdown text={shown} /> : <pre className={className ?? 'tx-pre'} data-find-text>{shown}</pre>}
      {bodyId && full === null && (
        <button className="tx-more" data-find-ignore onClick={() => body(bodyId).then(setFull, e => setError(String(e?.message ?? e)))}>
          Show all {fullLength?.toLocaleString()} characters
        </button>
      )}
      {error && <span className="tx-error-text">{error}</span>}
    </>
  )
}

/** Whether the server stored any of a call's input or output fields whole, keeping only their start. */
const isCapped = (tool: ToolEntry) => tool.capped.length > 0 || (tool.result?.capped.length ?? 0) > 0

/** Puts `value` at `path` inside `root`; an empty path replaces the root. */
function setAt(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (!path.length) return value
  let o = root as Record<string | number, unknown>
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>
  o[path.at(-1)!] = value
  return root
}

/** A value with every capped field put back from its body; whole values (stored as JSON) first. */
async function fill(value: unknown, caps: CappedField[], body: (id: string) => Promise<string>): Promise<unknown> {
  let out: unknown = structuredClone(value ?? null)
  for (const c of [...caps].sort((a, b) => a.path.length - b.path.length)) {
    const full = await body(c.bodyId)
    out = setAt(out, c.path.slice(3), c.json ? JSON.parse(full) : full)
  }
  return out
}

/** What loading a call's capped fields brought back. The output is tied to the result it came from. */
type Restored = { input?: Record<string, unknown>; output?: { seq: number; value: unknown } }

/** The call as it is now, with what was restored laid over it. */
function withRestored(tool: ToolEntry, r: Restored): ToolEntry {
  const input = r.input && !tool.capped.length ? tool.input : (r.input ?? tool.input)
  const output = tool.result && r.output?.seq === tool.result.seq ? r.output.value : tool.result?.output
  const inputDone = !!r.input || !tool.capped.length
  return {
    ...tool,
    input,
    capped: inputDone ? [] : tool.capped,
    // What the source cut before sending isn't in any body: that stays missing.
    partial: inputDone ? (tool.legacy && tool.partial) || tool.cut : tool.partial,
    result: tool.result && { ...tool.result, output, capped: r.output?.seq === tool.result.seq ? [] : tool.result.capped },
  }
}

/**
 * The call with every field the server capped put back from its body: strings whole, and values
 * stored whole as JSON parsed. Paths are `['calls', 0, 'input', …]` and `['results', 0, 'output', …]`.
 */
export async function restored(tool: ToolEntry, body: (id: string) => Promise<string>): Promise<ToolEntry> {
  return withRestored(tool, await restore(tool, body))
}

async function restore(tool: ToolEntry, body: (id: string) => Promise<string>): Promise<Restored> {
  const r: Restored = {}
  if (tool.capped.length) r.input = ((await fill(tool.input, tool.capped, body)) ?? {}) as Record<string, unknown>
  if (tool.result?.capped.length) r.output = { seq: tool.result.seq, value: await fill(tool.result.output, tool.result.capped, body) }
  return r
}

/**
 * A call with its capped fields put back on request: the button that asks, and the call to draw.
 * What's restored is kept apart from the call, so a result arriving later still shows, and offers
 * its own capped fields in turn.
 */
function useRestored(tool: ToolEntry): [ToolEntry, ReactNode] {
  const { body } = useTranscript()
  const [r, setR] = useState<Restored>({})
  const [error, setError] = useState<string | null>(null)
  const shown = withRestored(tool, r)
  const button =
    isCapped(shown) ? (
      <>
        <button className="tx-more" data-find-ignore onClick={() => restore(shown, body).then(more => setR(prev => ({ ...prev, ...more })), e => setError(String(e?.message ?? e)))}>
          {actionOf(tool.name) === 'edit' ? 'Show the whole change' : 'Show the whole input and output'}
        </button>
        {error && <span className="tx-error-text">{error}</span>}
      </>
    ) : null
  return [shown, button]
}

const PERMISSION: Record<PermissionRequest['state'], string> = {
  pending: 'Waiting for permission',
  deferred: 'Asked; nobody answered in time',
  allowed: 'Allowed',
  denied: 'Denied',
  'answered-locally': 'Answered in the terminal',
  expired: 'Permission request expired',
}

export function PermissionBadge({ p }: { p: PermissionRequest }) {
  const text = PERMISSION[p.state] + (p.decidedBy && (p.state === 'allowed' || p.state === 'denied') ? ` by ${p.decidedBy}` : '')
  return <span className={`tx-perm ${p.state}`}>{text}</span>
}

function Output({ tool, fallback }: { tool: ToolEntry; fallback?: ReactNode }) {
  const r = tool.result
  if (!r) return <>{fallback}</>
  return (
    <>
      {r.shared > 1 && <div className="tx-quiet">This output is shared by {r.shared} calls that ran together.</div>}
      <LongText text={r.text} bodyId={r.bodyId} fullLength={r.fullLength} className={`tx-pre ${r.isError ? 'error' : ''}`} />
    </>
  )
}

function Bash({ tool }: { tool: ToolEntry }) {
  const command = commandText(tool.input) ?? ''
  const raw = str(tool.input.command)
  const desc = str(tool.input.description)
  const out = obj(tool.result?.output)
  const stdout = str(out?.stdout) ?? str(out?.output) ?? str(out?.aggregated_output)
  const stderr = str(out?.stderr)
  const exit = num(out?.exit_code) ?? num(out?.exitCode)
  const [copied, setCopied] = useState(false)
  return (
    <div className="tx-term">
      <div className="tx-term-cmd">
        <span className="tx-prompt-sign" aria-hidden>$</span>
        <pre data-find-text title={raw && raw !== command ? raw : undefined}>{command}</pre>
        <button className="tx-copy" data-find-ignore aria-label="Copy command" onClick={() => void navigator.clipboard?.writeText(raw ?? command).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {desc && <div className="tx-term-desc">{desc}</div>}
      {tool.result && (stdout !== null || stderr !== null) && !tool.result.bodyId ? (
        <>
          {stdout ? <pre className="tx-pre" data-find-text>{stdout}</pre> : null}
          {stderr ? <pre className="tx-pre error" data-find-text>{stderr}</pre> : null}
          {!stdout && !stderr && <div className="tx-quiet">No output</div>}
        </>
      ) : (
        <Output tool={tool} fallback={<div className="tx-quiet">Running…</div>} />
      )}
      {(out?.interrupted === true || exit !== null || str(out?.returnCodeInterpretation)) && (
        <div className="tx-term-foot">
          {out?.interrupted === true && <span>Interrupted</span>}
          {exit !== null && <span className={exit ? 'error' : undefined}>Exit {exit}</span>}
          {str(out?.returnCodeInterpretation) && <span>{str(out?.returnCodeInterpretation)}</span>}
        </div>
      )}
    </div>
  )
}

function changesOf(tool: ToolEntry): FileChange[] {
  const out = obj(tool.result?.output)
  const path = str(tool.input.file_path) ?? str(out?.filePath) ?? 'file'
  const patch = hunks(out?.structuredPatch)
  const name = tool.name.toLowerCase()
  if (name === 'apply_patch') return fromCodexPatch(str(tool.input.input) ?? str(tool.input.patch) ?? str(tool.input.command) ?? '')
  if (name === 'write') {
    if (patch && out?.type === 'update') return [fromHunks(path, patch)]
    const content = str(tool.input.content)
    return content === null ? [] : [created(path, content)]
  }
  if (patch) return [fromHunks(path, patch)]
  if (name === 'multiedit') return list(tool.input.edits).map(obj).filter(Boolean).map(e => fragment(path, str(e!.old_string) ?? '', str(e!.new_string) ?? ''))
  const before = str(tool.input.old_string)
  const after = str(tool.input.new_string)
  return before === null || after === null ? [] : [fragment(path, before, after)]
}

function Edit({ tool }: { tool: ToolEntry }) {
  const changes = changesOf(tool)
  const out = obj(tool.result?.output)
  const shown = changes
  return (
    <div className="tx-edit">
      {shown.map((c, i) => (
        <div key={i}>
          {shown.length > 1 && <div className="tx-file" title={c.path}>{shortPath(c.path)}</div>}
          <Diff change={c} />
        </div>
      ))}
      {!shown.length && <Output tool={tool} />}
      {/* What the source cut isn't in any body, so this stays whatever is still to load. */}
      {tool.cut ? (
        <div className="tx-quiet tx-warn">Part of this change was cut short before it was sent; the diff may be incomplete.</div>
      ) : (
        tool.partial && !isCapped(tool) && <div className="tx-quiet tx-warn">Only the start of this change was recorded; the diff may be incomplete.</div>
      )}
      {!hunks(out?.structuredPatch) && changes.some(c => c.kind === 'sides') && <div className="tx-quiet">The replaced text only; line numbers count from it.</div>}
      {out?.userModified === true && <div className="tx-quiet">The owner changed this edit before it was applied.</div>}
      {tool.status === 'error' && <Output tool={tool} />}
    </div>
  )
}

function Read({ tool }: { tool: ToolEntry }) {
  const path = str(tool.input.file_path) ?? str(tool.input.path) ?? ''
  const file = obj(obj(tool.result?.output)?.file)
  const start = num(file?.startLine)
  const lines = num(file?.numLines)
  const total = num(file?.totalLines)
  const { isOpen, toggle } = useTranscript()
  const open = isOpen(`${tool.id}:content`, tool.status === 'error')
  const setOpen = () => toggle(`${tool.id}:content`, tool.status === 'error')
  return (
    <div className="tx-read">
      <div className="tx-kv">
        <span className="tx-path" data-find-text>{path}</span>
        {start !== null && lines !== null && <span>lines {start}–{start + Math.max(lines - 1, 0)}{total !== null ? ` of ${total}` : ''}</span>}
      </div>
      {tool.result && (open ? <Output tool={tool} /> : <button className="tx-more" data-find-ignore onClick={setOpen}>Show what was read</button>)}
    </div>
  )
}

function Search({ tool }: { tool: ToolEntry }) {
  const out = obj(tool.result?.output)
  const files = list(out?.filenames).filter((f): f is string => typeof f === 'string')
  const n = num(out?.numFiles)
  const matches = num(out?.numMatches) ?? num(out?.numLines)
  return (
    <div className="tx-search">
      <div className="tx-kv">
        <code data-find-text>{str(tool.input.pattern) ?? str(tool.input.query)}</code>
        {str(tool.input.path) && <span>in {str(tool.input.path)}</span>}
        {str(tool.input.glob) && <span>files {str(tool.input.glob)}</span>}
        {n !== null && <span>{n === 1 ? '1 file' : `${n} files`}{matches !== null ? `, ${matches} ${matches === 1 ? 'line' : 'lines'}` : ''}</span>}
      </div>
      {files.length && !str(out?.content) ? (
        <ul className="tx-files" data-find-text>
          {files.slice(0, 50).map(f => <li key={f} title={f}>{f}</li>)}
          {files.length > 50 && <li className="tx-quiet">and {files.length - 50} more</li>}
        </ul>
      ) : (
        <Output tool={tool} />
      )}
    </div>
  )
}

function Web({ tool }: { tool: ToolEntry }) {
  const url = str(tool.input.url)
  const out = obj(tool.result?.output)
  const code = num(out?.code)
  const results = list(out?.results).flatMap(r => list(obj(r)?.content)).map(obj).filter(Boolean) as Record<string, unknown>[]
  return (
    <div className="tx-web">
      <div className="tx-kv">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" data-find-text>{url}</a>
        ) : (
          <span data-find-text>Searched for “{str(tool.input.query)}”</span>
        )}
        {code !== null && <span className={code >= 400 ? 'error' : undefined}>{code} {str(out?.codeText)}</span>}
        {num(out?.bytes) !== null && <span>{Math.round(num(out?.bytes)! / 1024)} KB</span>}
      </div>
      {str(tool.input.prompt) && <div className="tx-quiet" data-find-text>Asked: {str(tool.input.prompt)}</div>}
      {results.length ? (
        <ul className="tx-links">
          {results.slice(0, 10).map((r, i) => (
            <li key={i}>
              <a href={str(r.url) ?? undefined} target="_blank" rel="noopener noreferrer">{str(r.title) ?? str(r.url)}</a>
            </li>
          ))}
        </ul>
      ) : tool.result ? (
        <LongText text={tool.result.text} bodyId={tool.result.bodyId} fullLength={tool.result.fullLength} markdown={!tool.result.isError} />
      ) : null}
    </div>
  )
}

const TODO_MARK = { completed: '✓', in_progress: '◐', pending: '○' } as const

function TodoList({ tool }: { tool: ToolEntry }) {
  const items = todos(tool.input.todos) ?? todos(obj(tool.result?.output)?.newTodos) ?? todos(tool.input.plan)
  if (!items) return <Output tool={tool} />
  return (
    <ul className="tx-todos" data-find-text>
      {items.map((t, i) => (
        <li key={i} className={t.status}>
          <span className="tx-todo-mark" aria-label={t.status.replace('_', ' ')}>{TODO_MARK[t.status]}</span>
          <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  )
}

function Agent({ tool }: { tool: ToolEntry }) {
  const { renderRows, isOpen, toggle } = useTranscript()
  const prompt = isOpen(`${tool.id}:prompt`, false)
  const setPrompt = () => toggle(`${tool.id}:prompt`, false)
  const run = tool.subagent
  return (
    <div className="tx-agent">
      <div className="tx-kv">
        {str(tool.input.subagent_type) && <span className="tx-chip">{str(tool.input.subagent_type)}</span>}
        {tool.input.run_in_background === true && <span>in the background</span>}
        {run && <span>{run.count === 1 ? '1 tool call' : `${run.count} tool calls`}</span>}
      </div>
      {str(tool.input.prompt) && (prompt ? <pre className="tx-pre" data-find-text>{str(tool.input.prompt)}</pre> : <button className="tx-more" data-find-ignore onClick={setPrompt}>Show the prompt</button>)}
      {run && <div className="tx-nested">{renderRows(run.rows)}</div>}
      {tool.result && <Clamped id={`${tool.id}:answer`}><LongText text={tool.result.text} bodyId={tool.result.bodyId} fullLength={tool.result.fullLength} markdown={!tool.result.isError} /></Clamped>}
    </div>
  )
}

/** Long content shown by its first lines until opened. */
function Clamped({ id, children }: { id: string; children: ReactNode }) {
  const { isOpen, toggle } = useTranscript()
  const open = isOpen(id, false)
  return (
    <div className={`tx-clamp ${open ? 'open' : ''}`} data-find-fold={open ? undefined : ''}>
      <div className="tx-clamp-body">{children}</div>
      {!open && <button className="tx-more" data-find-ignore onClick={() => toggle(id, false)}>Show all</button>}
    </div>
  )
}

function Generic({ tool }: { tool: ToolEntry }) {
  const keys = Object.keys(tool.input)
  return (
    <div className="tx-generic">
      {keys.length > 0 && <pre className="tx-pre" data-find-text>{JSON.stringify(tool.input, null, 2)}</pre>}
      {tool.partial && <div className="tx-quiet">{tool.legacy ? 'Only the start of this input was recorded.' : tool.cut && !tool.capped.length ? 'Part of this input was cut short before it was sent.' : 'Part of this input was cut short.'}</div>}
      <Output tool={tool} />
    </div>
  )
}

/** The opened view of a call, by tool, with its capped fields loadable whatever the tool. */
export function ToolDetail({ tool: original }: { tool: ToolEntry }) {
  const [tool, more] = useRestored(original)
  return (
    <>
      <ToolView tool={tool} />
      {more}
    </>
  )
}

function ToolView({ tool }: { tool: ToolEntry }) {
  switch (actionOf(tool.name)) {
    case 'command':
      return <Bash tool={tool} />
    case 'edit':
      return <Edit tool={tool} />
    case 'read':
      return tool.name === 'LS' ? <Generic tool={tool} /> : <Read tool={tool} />
    case 'search':
      return tool.name === 'ToolSearch' ? <Generic tool={tool} /> : <Search tool={tool} />
    case 'web':
      return <Web tool={tool} />
    case 'todo':
      return <TodoList tool={tool} />
    case 'agent':
      return <Agent tool={tool} />
    default:
      return <Generic tool={tool} />
  }
}

/** Calls whose detail is worth seeing without a click: edits (as diffs), to-do lists, failures. */
export const openByDefault = (tool: ToolEntry) => ['edit', 'todo'].includes(actionOf(tool.name)) || tool.status === 'error'
