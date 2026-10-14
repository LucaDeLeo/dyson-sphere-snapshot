// From a session's stored rows to the rows the transcript draws: one model for Claude Code and
// Codex. Tool calls are paired with their results by tool id, runs of calls are grouped, a
// subagent's rows are gathered under the call that started it, and permission requests are
// attached to the calls they were for. Rows from before structured rows (no `calls`) are read
// from their text.
//
// The row union is modelled on T3 Code's MessagesTimeline rows (pingdotgg/t3code
// apps/web/src/components/chat/MessagesTimeline.logic.ts @4f63275a; MIT, Copyright (c) 2026 T3
// Tools Inc.) and Vibe Kanban's NormalizedEntry (one entry type across agents); the code is ours.
import type { AgentKind, PartialReply, PermissionRequest, StoredEvent } from '../../../shared/protocol'
import type { CappedField, RowData } from '../../../shared/rows'
import { parseToolCall } from '../toolcall'
import { actionOf, summarize, toolLabel, toolTarget } from './classify'
import { occurrences } from './find'

export type ToolResult = {
  seq: number
  at: string
  text: string
  isError: boolean
  /** The tool's structured result, when the source sent one. */
  output: unknown
  /** The result's whole text, when the row cut it short. */
  bodyId: string | null
  fullLength: number | null
  capped: CappedField[]
  /** How many calls this text covers: results of calls run together, from sources that don't keep them apart. */
  shared: number
}

export type ToolEntry = {
  /** The tool call's id (tool_use_id). */
  id: string
  name: string
  input: Record<string, unknown>
  label: string
  /** What it acted on, shown beside its name. */
  target: string
  /** No structured input: read from the row's text, as rows were before protocol 3. */
  legacy: boolean
  /** Some of the input isn't in the row: cut by the source or the server, or a legacy row cut at 2,000 characters. */
  partial: boolean
  /** The source cut some of it before sending: no body holds the rest. */
  cut: boolean
  capped: CappedField[]
  seq: number
  at: string
  agentId: string | null
  result: ToolResult | null
  status: 'running' | 'done' | 'error'
  permission: PermissionRequest | null
  /** The run of the subagent this call started (Claude Code's Agent / Task). */
  subagent: SubagentRun | null
}

export type SubagentRun = { agentId: string; task: string; rows: TimelineRow[]; count: number; last: string | null }

type Base = { id: string; seq: number; at: string }
type Text = Base & { text: string; bodyId: string | null; fullLength: number | null }

export type TimelineRow =
  | (Text & { kind: 'prompt'; turn: number })
  /** `streaming`: a reply still being written, its completed paragraphs so far. */
  | (Text & { kind: 'assistant'; streaming?: boolean })
  | (Text & { kind: 'thinking' })
  /** A steering note, a notice, or a message the session was sent. */
  | (Text & { kind: 'note'; label: string })
  | (Base & { kind: 'tool'; tool: ToolEntry })
  /** Three or more calls in a row, shown as one line until opened. */
  | (Base & { kind: 'work'; tools: ToolEntry[]; summary: string; failed: boolean })
  /** A result whose call isn't loaded (it's older than the rows loaded so far). */
  | (Text & { kind: 'result'; isError: boolean; toolId: string | null })
  /** A subagent's rows when no loaded call started it. */
  | (Base & { kind: 'subagent'; run: SubagentRun })

export type Turn = { rowId: string; index: number; text: string; reply: string | null }
export type Timeline = { rows: TimelineRow[]; turns: Turn[] }

export type TimelineOptions = {
  agent?: AgentKind
  /** Every permission request of the session, any state. */
  permissions?: PermissionRequest[]
  /** What each subagent was asked to do, by id, when the session reports it. */
  agentNames?: Map<string, string>
  /** The session is working: its last run of calls stays open. */
  working?: boolean
  /** Replies in progress, each drawn last in its agent's rows until its row arrives. */
  writing?: PartialReply[]
}

/** Runs of this many calls or more are grouped. */
export const GROUP_MIN = 3

const NOTE_LABEL: Record<string, string> = { note: 'Note', notice: 'Notice', delivery: 'Message', command: 'Command', 'hook-context': 'Hook' }

export function buildTimeline(events: StoredEvent[], opts: TimelineOptions = {}): Timeline {
  const byTool = new Map<string, ToolEntry>()
  const main: Item[] = []
  const subs = new Map<string, Item[]>()
  const order: string[] = [] // subagents by first appearance

  for (const ev of events) {
    const d = ev.data as unknown as RowData
    if (!d || typeof d.kind !== 'string' || d.kind === 'attachment') continue
    const agentId = d.agentId ?? null
    const into = agentId ? (subs.get(agentId) ?? (order.push(agentId), subs.set(agentId, []).get(agentId)!)) : main
    for (const item of itemsOf(ev, d, byTool)) into.push({ ...item, agentId })
  }
  for (const p of opts.writing ?? []) {
    const agentId = p.agentId ?? null
    const into = agentId ? (subs.get(agentId) ?? (order.push(agentId), subs.set(agentId, []).get(agentId)!)) : main
    into.push({ kind: 'assistant', id: `w:${partialKey(p)}`, seq: Number.MAX_SAFE_INTEGER, at: p.at, text: p.text, bodyId: null, fullLength: null, streaming: true, agentId })
  }

  const runs = new Map<string, SubagentRun>()
  for (const id of order) {
    const items = subs.get(id)!
    const firstPrompt = items.find(i => i.kind === 'prompt') as (Item & { kind: 'prompt' }) | undefined
    const task = opts.agentNames?.get(id) ?? firstPrompt?.text.split('\n')[0]?.slice(0, 120) ?? 'Subagent'
    const rows = layout(items, false, 0).rows
    const last = [...items].reverse().find(i => i.kind === 'assistant' || i.kind === 'tool')
    runs.set(id, { agentId: id, task, rows, count: items.filter(i => i.kind === 'tool').length, last: last ? (last.kind === 'tool' ? last.tool.label : firstLine(last.text)) : null })
  }

  // A subagent belongs to the call that started it: Claude Code's Agent call whose prompt is the
  // subagent's first prompt, or whose description names it.
  const placed = new Set<string>()
  for (const tool of byTool.values()) {
    if (actionOf(tool.name) !== 'agent' || tool.agentId) continue
    for (const id of order) {
      if (placed.has(id)) continue
      const items = subs.get(id)!
      const firstPrompt = items.find(i => i.kind === 'prompt') as (Item & { kind: 'prompt' }) | undefined
      const prompt = typeof tool.input.prompt === 'string' ? tool.input.prompt.trim() : null
      const named = opts.agentNames?.get(id)
      if ((prompt && firstPrompt && firstPrompt.text.trim() === prompt) || (named && named === tool.input.description)) {
        tool.subagent = runs.get(id)!
        placed.add(id)
        break
      }
    }
  }
  // The rest stand on their own, where the subagent first did something.
  for (const id of order) {
    if (placed.has(id)) continue
    const first = subs.get(id)![0]!
    const at = main.findIndex(i => i.seq > first.seq)
    const row: Item = { kind: 'subagent', id: `a:${id}`, seq: first.seq, at: first.at, run: runs.get(id)!, agentId: null }
    if (at < 0) main.push(row)
    else main.splice(at, 0, row)
  }

  attachPermissions([...byTool.values()], opts.permissions ?? [])
  return layout(main, opts.working ?? false, GROUP_MIN)
}

/** Which response block a reply in progress is the text of. */
export const partialKey = (p: PartialReply) => `${p.agentId ?? ''}:${p.turnId}:${p.step}:${p.block}`

type Item = TimelineRow & { agentId: string | null }

const firstLine = (s: string) => s.split('\n').find(l => l.trim())?.trim() ?? ''

/** The rows one stored row makes: tool calls become entries; results complete them. */
function* itemsOf(ev: StoredEvent, d: RowData, byTool: Map<string, ToolEntry>): Generator<TimelineRow> {
  const base = { seq: ev.seq, at: ev.at }
  const text = { text: d.text ?? '', bodyId: d.bodyId ?? null, fullLength: d.fullLength ?? null }
  const agentId = d.agentId ?? null
  switch (d.kind) {
    case 'prompt':
      // The engine's own messages (a background task finishing, say) come in as prompts too.
      if (fromEngine(d)) return yield { kind: 'note', id: `r:${ev.seq}`, ...base, ...text, label: 'Notification' }
      return yield { kind: 'prompt', id: `r:${ev.seq}`, ...base, ...text, turn: 0 }
    case 'assistant':
      return yield { kind: 'assistant', id: `r:${ev.seq}`, ...base, ...text }
    case 'thinking':
      return yield { kind: 'thinking', id: `r:${ev.seq}`, ...base, ...text }
    case 'tool-call': {
      // Prose the model wrote in the same message as its calls shares the row's text.
      const prose = proseOf(d)
      if (prose) yield { kind: 'assistant', id: `r:${ev.seq}:text`, ...base, text: prose, bodyId: null, fullLength: null }
      for (const t of callsOf(d)) {
        if (byTool.has(t.id)) continue // the same call reported twice (a bridge restart)
        const entry: ToolEntry = { ...t, seq: ev.seq, at: ev.at, agentId, result: null, status: 'running', permission: null, subagent: null, label: toolLabel(t.name, t.input), target: toolTarget(t.name, t.input) }
        byTool.set(t.id, entry)
        yield { kind: 'tool', id: `t:${t.id}`, ...base, tool: entry }
      }
      return
    }
    case 'tool-result':
    case 'tool-error': {
      const isError = d.kind === 'tool-error'
      const ids = d.toolUseIds ?? []
      let matched = false
      for (const id of ids) {
        const entry = byTool.get(id)
        if (!entry) continue
        const j = d.results?.findIndex(x => x.id === id) ?? -1
        const r = j >= 0 ? d.results![j] : undefined
        // A call's own flag, where the source sent one; the row's kind is its last result's.
        const err = typeof r?.isError === 'boolean' ? r.isError : isError
        const mine = (d.capped ?? []).filter(c => c.path[0] === 'results' && c.path[1] === j)
        const capped = mine.filter(c => c.path[2] === 'output').map(c => ({ ...c, path: ['results', 0, ...c.path.slice(2)] }))
        // Its own text when the row finishes several calls and the source kept them apart.
        // Not when the source cut it: the row's own text has a body with all of it.
        const ownCut = (d.cut ?? []).some(c => c.path[0] === 'results' && c.path[1] === j && c.path[2] === 'text')
        const own = typeof r?.text === 'string' && !ownCut ? r.text : null
        const textCap = own === null ? undefined : mine.find(c => c.path[2] === 'text' && c.path.length === 3)
        entry.result = {
          seq: ev.seq,
          at: ev.at,
          text: own ?? text.text,
          isError: err,
          output: r?.output ?? null,
          bodyId: own === null ? text.bodyId : (textCap?.bodyId ?? null),
          fullLength: own === null ? text.fullLength : (textCap?.fullLength ?? null),
          capped,
          shared: own === null ? ids.length : 1,
        }
        entry.status = err ? 'error' : 'done'
        matched = true
      }
      if (!matched) yield { kind: 'result', id: `r:${ev.seq}`, ...base, ...text, isError, toolId: ids[0] ?? null }
      return
    }
    default:
      if (!text.text.trim()) return
      return yield { kind: 'note', id: `r:${ev.seq}`, ...base, ...text, label: NOTE_LABEL[d.kind] ?? d.kind }
  }
}

/** A prompt the engine wrote, not a person: by its origin, or by opening with engine markup. */
const fromEngine = (d: RowData) => d.origin === 'task-notification' || d.origin === 'engine' || /^\s*<(task-notification|system-reminder|local-command-[a-z]+|command-[a-z]+)>/.test(d.text ?? '')

/** A tool-call row's text is its prose and one "<Name> <json>" line per call. */
const callNames = (d: RowData) => (d.calls?.length ? d.calls.map(c => c.name) : (d.tools ?? []).map(t => t.name))
const isCallLine = (line: string, names: string[]) => names.some(n => line.startsWith(`${n} {`))

/**
 * The prose of a tool-call row: its text without the call lines. Codex's rows hold only their call,
 * whose input can be plain text over many lines (a patch), so they have none.
 */
function proseOf(d: RowData): string {
  if (d.origin === 'codex') return ''
  const names = callNames(d)
  return (d.text ?? '')
    .split('\n')
    .filter(l => !isCallLine(l, names))
    .join('\n')
    .trim()
}

/**
 * A call's input from its line of a row's text: its JSON, or what's left of JSON cut short (the main
 * argument), or, for a tool whose input is plain text (Codex's apply_patch), that text as `input`.
 */
function inputFromLine(line: string, name: string): Record<string, unknown> {
  const parsed = parseToolCall(line)
  if (parsed.input) return parsed.input
  if (parsed.mainKey && parsed.main !== null) return { [parsed.mainKey]: parsed.main }
  const rest = line.startsWith(`${name} `) ? line.slice(name.length + 1) : ''
  return rest && !rest.trimStart().startsWith('{') ? { input: rest } : {}
}

/** Rows before structured rows kept a call's input to its first 2,000 characters. */
const LEGACY_INPUT_LIMIT = 2000

/** Whether a call's line was cut short: JSON that doesn't close, plain text at the limit, or a patch without its end. */
function lineCut(line: string, name: string): boolean {
  const rest = line.startsWith(`${name} `) ? line.slice(name.length + 1) : ''
  if (rest.trimStart().startsWith('{')) return parseToolCall(line).input === null
  return rest.length >= LEGACY_INPUT_LIMIT || (/^\s*\*\*\* Begin Patch/.test(rest) && !/\*\*\* End Patch\s*$/.test(rest))
}

/**
 * A row's calls: its structured ones, or, from older sources, parsed from its call lines. A call's
 * capped fields are given as if it were the row's only call (`['calls', 0, …]`), as renderers read them.
 */
function callsOf(d: RowData): { id: string; name: string; input: Record<string, unknown>; legacy: boolean; partial: boolean; cut: boolean; capped: CappedField[] }[] {
  const capped = d.capped ?? []
  const cut = d.cut ?? []
  if (d.calls?.length) {
    const lines = (d.text ?? '').split('\n').filter(l => isCallLine(l, callNames(d)))
    return d.calls.map((c, i) => {
      const mine = (p: { path: (string | number)[] }) => p.path[0] === 'calls' && p.path[1] === i
      const own = capped.filter(mine).map(p => ({ ...p, path: ['calls', 0, ...p.path.slice(2)] }))
      const sourceCut = cut.some(mine)
      const partial = capped.some(mine) || sourceCut
      // An input too large as a whole is stored as a body (null here) or dropped at the source:
      // until it's loaded, the call is read from its line of the text.
      if (!c.input || !Object.keys(c.input).length) {
        const input = inputFromLine(lines[i] ?? c.name, c.name)
        return { id: c.id, name: c.name, input, legacy: false, partial: partial || !!lines[i], cut: sourceCut, capped: own }
      }
      return { id: c.id, name: c.name, input: c.input, legacy: false, partial, cut: sourceCut, capped: own }
    })
  }
  const tools = d.tools ?? []
  const matched = (d.text ?? '').split('\n').filter(l => isCallLine(l, callNames(d)))
  // A Codex call whose input was plain text: the whole text is its one call.
  const lines = matched.length || tools.length !== 1 ? matched : [d.text ?? '']
  return tools.map((t, i) => {
    const line = lines[i] ?? t.name
    return { id: t.id, name: t.name, input: inputFromLine(line, t.name), legacy: true, partial: lineCut(line, t.name), cut: false, capped: [] }
  })
}

/** Ties each permission request to the call it asked about: same tool, asked after the call, before its result. */
function attachPermissions(tools: ToolEntry[], permissions: PermissionRequest[]) {
  const sorted = [...permissions].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  for (const p of sorted) {
    const asked = Date.parse(p.requestedAt)
    const candidates = tools.filter(t => !t.permission && t.name === p.tool && Date.parse(t.at) <= asked + 2_000 && (!t.result || Date.parse(t.result.at) >= asked - 2_000))
    // The same input wins; otherwise the latest call asked before it.
    const same = candidates.find(t => sameInput(t.input, p.input))
    const pick = same ?? candidates.filter(t => Date.parse(t.at) <= asked + 2_000).at(-1)
    if (pick) pick.permission = p
  }
}

function sameInput(input: Record<string, unknown>, asked: string): boolean {
  try {
    return JSON.stringify(JSON.parse(asked)) === JSON.stringify(input)
  } catch {
    return asked.startsWith(JSON.stringify(input).slice(0, 200))
  }
}

/** Groups runs of calls and numbers the turns. The last run stays open while the session works. */
function layout(items: Item[], working: boolean, groupMin: number): Timeline {
  const rows: TimelineRow[] = []
  const turns: Turn[] = []
  let run: ToolEntry[] = []
  let runRows: TimelineRow[] = []
  const flush = (last: boolean) => {
    if (groupMin && run.length >= groupMin && !(last && working)) {
      const first = runRows[0]!
      rows.push({ kind: 'work', id: `g:${run[0]!.id}`, seq: first.seq, at: first.at, tools: run, summary: summarize(run), failed: run.some(t => t.status === 'error') })
    } else rows.push(...runRows)
    run = []
    runRows = []
  }
  for (const item of items) {
    const { agentId: _, ...row } = item
    if (row.kind === 'tool') {
      run.push(row.tool)
      runRows.push(row)
      continue
    }
    flush(false)
    if (row.kind === 'prompt') {
      const r = { ...row, turn: turns.length }
      turns.push({ rowId: r.id, index: rows.length, text: firstLine(r.text), reply: null })
      rows.push(r)
      continue
    }
    if (row.kind === 'assistant' && turns.length) turns.at(-1)!.reply = row.text
    rows.push(row as TimelineRow)
  }
  flush(true)
  return { rows, turns }
}

/** The text a row is found by: what it shows, whether or not it's open. */
export function searchText(row: TimelineRow): string {
  switch (row.kind) {
    case 'tool':
      return toolText(row.tool)
    case 'work':
      return row.tools.map(toolText).join('\n')
    case 'subagent':
      return [row.run.task, ...row.run.rows.map(searchText)].join('\n')
    default:
      return row.text
  }
}

export function toolText(t: ToolEntry): string {
  const parts = [t.label, ...Object.values(t.input).filter((v): v is string => typeof v === 'string'), t.result?.text ?? '']
  if (t.subagent) parts.push(t.subagent.task, ...t.subagent.rows.map(searchText))
  return parts.join('\n')
}

/** The ids of the folds to open to show `query` in a row, down through groups and subagents. */
export function foldsTo(row: TimelineRow, query: string): string[] {
  const has = (t: string | null | undefined) => !!t && occurrences(t, query).length > 0
  const tool = (t: ToolEntry): string[] => {
    if (!has(toolText(t))) return []
    const ids = [`t:${t.id}`]
    if (has(t.result?.text)) ids.push(`${t.id}:content`, `${t.id}:answer`)
    if (has(typeof t.input.prompt === 'string' ? t.input.prompt : null)) ids.push(`${t.id}:prompt`)
    for (const r of t.subagent?.rows ?? []) if (has(searchText(r))) ids.push(...foldsTo(r, query))
    return ids
  }
  switch (row.kind) {
    case 'tool':
      return tool(row.tool)
    case 'work':
      return [row.id, ...row.tools.flatMap(tool)]
    case 'subagent':
      return [row.id, ...row.run.rows.filter(r => has(searchText(r))).flatMap(r => foldsTo(r, query))]
    case 'thinking':
    case 'note':
      return [row.id]
    default:
      return []
  }
}
