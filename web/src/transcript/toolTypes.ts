// The tool inputs and outputs the transcript draws, typed by tool.
//
// Claude Code's are named after the Claude Agent SDK's `sdk-tools` types (`BashInput`,
// `FileEditInput`, …) and carry the fields of Claude Code 2.1.296's built-in tools that we read.
// Codex's follow the item types of `@openai/codex-sdk` (`CommandExecutionItem`, `FileChangeItem`,
// `TodoListItem`), adapted to what Codex's hooks hand us. Neither package is a dependency (both
// install large native binaries); see the CS-2563 PR for that decision. Every value comes off the
// wire, so renderers check what they read (`str`, `num`, `list` below) rather than trust a cast.

// --- Claude Code ---

export type BashInput = { command: string; description?: string; timeout?: number; run_in_background?: boolean }
export type BashOutput = { stdout: string; stderr: string; interrupted: boolean; returnCodeInterpretation?: string; backgroundTaskId?: string }

export type FileEditInput = { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
export type MultiEditInput = { file_path: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[] }
export type StructuredPatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export type FileEditOutput = { filePath: string; structuredPatch: StructuredPatchHunk[]; userModified?: boolean; replaceAll?: boolean }

export type FileWriteInput = { file_path: string; content: string }
export type FileWriteOutput = { type: 'create' | 'update'; filePath: string; structuredPatch: StructuredPatchHunk[] }

export type FileReadInput = { file_path: string; offset?: number; limit?: number; pages?: string }
export type FileReadOutput = { type: 'text'; file: { filePath: string; numLines: number; startLine: number; totalLines: number } } | { type: 'image' | 'pdf' | 'notebook'; file?: { filePath?: string } }

export type GrepInput = { pattern: string; path?: string; glob?: string; type?: string; output_mode?: 'content' | 'files_with_matches' | 'count' }
export type GrepOutput = { mode?: string; numFiles: number; filenames: string[]; numLines?: number; numMatches?: number }
export type GlobInput = { pattern: string; path?: string }
export type GlobOutput = { numFiles: number; filenames: string[]; truncated?: boolean }

export type WebFetchInput = { url: string; prompt?: string }
export type WebFetchOutput = { bytes: number; code: number; codeText: string; durationMs: number; url: string }
export type WebSearchInput = { query: string; allowed_domains?: string[]; blocked_domains?: string[] }
export type WebSearchOutput = { query: string; results: ({ content: { title: string; url: string }[] } | string)[]; durationSeconds?: number }

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type Todo = { content: string; status: TodoStatus; activeForm?: string }
export type TodoWriteInput = { todos: Todo[] }

/** Claude Code's subagent tool (`Agent`, formerly `Task`). */
export type AgentInput = { description: string; prompt: string; subagent_type?: string; run_in_background?: boolean }

// --- Codex (hooks: PreToolUse / PostToolUse) ---

/** Codex's shell tool as its hooks name it (`Bash`), or `exec_command` / `shell` in some builds. */
export type CodexCommandInput = { command: string | string[]; workdir?: string; cmd?: string }
/** Codex's PostToolUse `tool_response` for a command: a string, or one of these fields. */
export type CodexCommandOutput = { output?: string; aggregated_output?: string; stdout?: string; stderr?: string; exit_code?: number; exitCode?: number }

// --- reading values off the wire ---

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

export function hunks(v: unknown): StructuredPatchHunk[] | null {
  const out = list(v).filter((h): h is StructuredPatchHunk => {
    const o = obj(h)
    return !!o && num(o.oldStart) !== null && num(o.newStart) !== null && Array.isArray(o.lines) && o.lines.every(l => typeof l === 'string')
  })
  return out.length ? out : null
}

export function todos(v: unknown): Todo[] | null {
  const out = list(v)
    .map(obj)
    .filter((t): t is Record<string, unknown> => !!t && typeof t.content === 'string')
    .map(t => ({ content: t.content as string, status: (['pending', 'in_progress', 'completed'].includes(t.status as string) ? t.status : 'pending') as TodoStatus, activeForm: str(t.activeForm) ?? undefined }))
  return out.length ? out : null
}
