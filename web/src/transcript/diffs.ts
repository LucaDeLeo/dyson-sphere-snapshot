// Unified diffs from what tool calls carry: Claude Code's structuredPatch (Edit, Write), an Edit's
// replaced fragment when there's no patch, a Write's whole file, and Codex's apply_patch format.
import type { StructuredPatchHunk } from './toolTypes'

/** One file's change, as `@pierre/diffs` draws it: a unified patch, or the two sides to compare. */
export type FileChange =
  | { kind: 'patch'; path: string; patch: string; added: number; removed: number }
  | { kind: 'sides'; path: string; before: string; after: string; added: number; removed: number }

const count = (lines: string[], sign: string) => lines.filter(l => l.startsWith(sign)).length

export function fromHunks(path: string, hunks: StructuredPatchHunk[], created = false): FileChange {
  const body = hunks.map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`).join('\n')
  const all = hunks.flatMap(h => h.lines)
  return { kind: 'patch', path, patch: `--- ${created ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n${body}\n`, added: count(all, '+'), removed: count(all, '-') }
}

/** A Write's content as a new file. */
export function created(path: string, content: string): FileChange {
  const lines = content.replace(/\n$/, '').split('\n')
  return fromHunks(path, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => `+${l}`) }], true)
}

/**
 * An Edit's replaced fragment against its replacement, when the result has no patch (Codex, rows
 * from before structured results, or a call still running). Without the file around it, the
 * line numbers count from the fragment.
 */
export function fragment(path: string, before: string, after: string): FileChange {
  const a = before.split('\n')
  const b = after.split('\n')
  return { kind: 'sides', path, before, after, added: b.length, removed: a.length }
}

/** The files a Codex patch changes (`*** Begin Patch` … `*** End Patch`), each as a unified diff. */
export function fromCodexPatch(text: string): FileChange[] {
  const out: FileChange[] = []
  let file: { path: string; op: 'Update' | 'Add' | 'Delete'; lines: string[]; moveTo?: string } | null = null
  const finish = () => {
    if (!file) return
    const path = file.moveTo ?? file.path
    const lines = file.lines
    if (file.op === 'Add') out.push(created(path, lines.map(l => l.slice(1)).join('\n')))
    else if (file.op === 'Delete') out.push({ kind: 'patch', path, patch: `--- a/${path}\n+++ /dev/null\n@@ -1,0 +0,0 @@\n`, added: 0, removed: 0 })
    else {
      // Codex hunks start with `@@` and an optional context line, without line numbers.
      const hunks: StructuredPatchHunk[] = []
      let cur: string[] | null = null
      for (const l of lines) {
        if (l.startsWith('@@')) {
          cur = []
          hunks.push({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: cur })
        } else if (l !== '*** End of File') (cur ?? (hunks.push({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: (cur = []) }), cur)).push(l)
      }
      for (const h of hunks) {
        h.oldLines = h.lines.filter(l => !l.startsWith('+')).length
        h.newLines = h.lines.filter(l => !l.startsWith('-')).length
      }
      out.push(fromHunks(path, hunks.filter(h => h.lines.length)))
    }
    file = null
  }
  for (const line of text.split('\n')) {
    const head = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)
    if (head) {
      finish()
      file = { path: head[2]!.trim(), op: head[1] as 'Update' | 'Add' | 'Delete', lines: [] }
    } else if (line.startsWith('*** Move to: ') && file) file.moveTo = line.slice(13).trim()
    else if (line.startsWith('*** ')) finish()
    else if (file) file.lines.push(line)
  }
  finish()
  return out
}
