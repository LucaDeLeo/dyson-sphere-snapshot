// What a tool call is (a command, a read, an edit, …) and the one line that names it.
//
// The table of Claude Code tools follows T3 Code's CLAUDE_KNOWN_TOOL_CLASSIFICATIONS
// (pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts @4f63275a), and the
// labels and group summaries its toolActivity.ts and work-log presentation.ts ("Read 4 files, ran
// 2 commands"). MIT License, Copyright (c) 2026 T3 Tools Inc. See web/THIRD_PARTY_NOTICES.md.
import { commandDisplayText } from './vendor/commandLabel'
import { list, obj, str } from './toolTypes'

export type ToolAction = 'command' | 'read' | 'search' | 'edit' | 'web' | 'todo' | 'agent' | 'other'

const ACTIONS: Record<string, ToolAction> = {
  bash: 'command',
  exec_command: 'command',
  shell: 'command',
  local_shell: 'command',
  monitor: 'command',
  read: 'read',
  notebookread: 'read',
  ls: 'read',
  grep: 'search',
  glob: 'search',
  toolsearch: 'search',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  apply_patch: 'edit',
  webfetch: 'web',
  websearch: 'web',
  web_search: 'web',
  todowrite: 'todo',
  update_plan: 'todo',
  agent: 'agent',
  task: 'agent',
}

export const actionOf = (tool: string): ToolAction => ACTIONS[tool.toLowerCase()] ?? 'other'

/** A command as one line: a list (Codex's argv) joined, and a `bash -lc` wrapper taken off. */
export function commandText(input: Record<string, unknown>): string | null {
  const c = input.command ?? input.cmd
  if (Array.isArray(c)) {
    // Codex's argv: a shell running a script (`bash -lc '<script>'`) is shown as the script.
    const argv = c.map(String)
    const shell = /(^|\/)(ba|z|da|k)?sh$/.test(argv[0] ?? '')
    if (shell && argv.length === 3 && /^-l?c$/.test(argv[1]!)) return commandDisplayText(argv[2]!)
    return commandDisplayText(argv.join(' '))
  }
  const raw = str(c)
  return raw === null ? null : commandDisplayText(raw)
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p

/** A short path for a label: the last two parts. The full path is in the row's title. */
export const shortPath = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}

/** What a call acted on, shown beside the tool's name: a command, a path, a pattern, a URL. */
export function toolTarget(tool: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  switch (actionOf(tool)) {
    case 'read':
      return path ? shortPath(path) : ''
    case 'edit':
      if (tool.toLowerCase() === 'apply_patch') return patchFiles(str(input.input) ?? str(input.patch) ?? str(input.command) ?? '').map(shortPath).join(', ')
      return path ? shortPath(path) : ''
    case 'search': {
      const pattern = str(input.pattern) ?? str(input.query) ?? ''
      const where = str(input.path)
      return where ? `${pattern} in ${base(where)}` : pattern
    }
    case 'web': {
      const url = str(input.url)
      if (!url) return str(input.query) ?? ''
      try {
        const u = new URL(url)
        return u.host + (u.pathname === '/' ? '' : u.pathname)
      } catch {
        return url
      }
    }
    case 'todo': {
      const n = list(input.todos ?? input.plan).length
      return n ? `${n} ${n === 1 ? 'item' : 'items'}` : ''
    }
    default: {
      const label = toolLabel(tool, input)
      return label === tool ? '' : label.startsWith(`${tool} `) ? label.slice(tool.length + 1) : label
    }
  }
}

/** The line a tool call is named by on its own, verb first: in find, summaries and titles. */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  switch (actionOf(tool)) {
    case 'command':
      return commandText(input) ?? tool
    case 'read':
      return path ? `Read ${shortPath(path)}` : `Read ${tool === 'LS' ? 'folder' : 'file'}`
    case 'search': {
      const pattern = str(input.pattern) ?? str(input.query)
      const where = str(input.path)
      return pattern ? `Searched ${pattern}${where ? ` in ${base(where)}` : ''}` : tool
    }
    case 'edit': {
      if (tool.toLowerCase() === 'apply_patch') {
        const files = patchFiles(str(input.input) ?? str(input.patch) ?? str(input.command) ?? '')
        return files.length ? `Edited ${files.map(shortPath).join(', ')}` : 'Applied a patch'
      }
      return path ? `${tool === 'Write' ? 'Wrote' : 'Edited'} ${shortPath(path)}` : tool
    }
    case 'web': {
      const url = str(input.url)
      if (url) {
        try {
          return `Fetched ${new URL(url).host}${new URL(url).pathname === '/' ? '' : new URL(url).pathname}`
        } catch {
          return `Fetched ${url}`
        }
      }
      return str(input.query) ? `Searched the web for ${input.query}` : tool
    }
    case 'todo': {
      const n = list(input.todos ?? input.plan).length
      return n ? `Updated the to-do list (${n})` : 'Updated the to-do list'
    }
    case 'agent':
      return str(input.description) ?? 'Subagent'
    default: {
      const skill = str(input.skill)
      if (skill) return `Skill ${skill}`
      const main = ['command', 'file_path', 'pattern', 'url', 'query', 'path', 'prompt', 'to', 'name'].map(k => str(input[k])).find(Boolean)
      return main ? `${tool} ${main}` : tool
    }
  }
}

/** Files named in a Codex patch (`*** Update File: …`, `*** Add File: …`, `*** Delete File: …`). */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1]!.trim())
}

const VERBS: Record<ToolAction, [string, string]> = {
  command: ['ran a command', 'ran {n} commands'],
  read: ['read a file', 'read {n} files'],
  search: ['searched once', 'searched {n} times'],
  edit: ['edited a file', 'edited {n} files'],
  web: ['fetched a page', 'fetched {n} pages'],
  todo: ['updated the to-do list', 'updated the to-do list'],
  agent: ['started a subagent', 'started {n} subagents'],
  other: ['used a tool', 'used {n} tools'],
}

/** "Read 4 files, ran 2 commands": the two largest kinds, in the order they first came. */
export function summarize(tools: { name: string; input: Record<string, unknown> }[]): string {
  const counts = new Map<ToolAction, Set<string>>()
  tools.forEach((t, i) => {
    const a = actionOf(t.name)
    // Reading or editing one file twice counts as one file.
    const key = (a === 'read' || a === 'edit') && str(obj(t.input)?.file_path) ? String(t.input.file_path) : String(i)
    counts.set(a, (counts.get(a) ?? new Set()).add(key))
  })
  const kinds = [...counts].map(([a, s], i) => ({ a, n: s.size, i }))
  const top = [...kinds].sort((x, y) => y.n - x.n || x.i - y.i).slice(0, 2).sort((x, y) => x.i - y.i)
  const words = top.map(({ a, n }) => (n === 1 ? VERBS[a][0] : VERBS[a][1].replace('{n}', String(n))))
  const shown = new Set(top.map(k => k.a))
  const rest = tools.filter(t => !shown.has(actionOf(t.name))).length
  const text = words.join(', ') + (rest ? `, and ${rest} more` : '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
