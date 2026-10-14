// Find in transcript: matches painted with the CSS Custom Highlight API, so rendered rows (Markdown
// included) are never rewritten. Adapted from T3 Code (pingdotgg/t3code
// apps/web/src/components/chat/threadFindHighlights.ts and packages/shared/src/threadSearch.ts
// @4f63275a; MIT, Copyright (c) 2026 T3 Tools Inc.; see web/THIRD_PARTY_NOTICES.md). Changed: our
// attributes (`data-row-id`, `data-find-text`, `data-find-ignore`), the search helpers inlined, and
// folds opened by the transcript (which knows its rows) rather than by `beforematch` events.
import { useEffect, useRef } from 'react'

const HIGHLIGHT = 'sphere-find'
const ACTIVE = 'sphere-find-active'
const TEXT = '[data-find-text]'
const IGNORE = '[data-find-ignore]'

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'])

function fold(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, 'σ')
  if (lowered.length === text.length) return lowered
  // Keep offsets: a character whose lower case is longer stays as it is.
  let out = ''
  for (const c of text) {
    const l = c.toLowerCase().replace(/ς/g, 'σ')
    out += l.length === c.length ? l : c
  }
  return out
}

/** Where `query` occurs in `text`, ignoring case. */
export function occurrences(text: string, query: string): number[] {
  if (!text || !query) return []
  const t = fold(text)
  const q = fold(query)
  const out: number[] = []
  for (let i = t.indexOf(q); i >= 0 && i <= t.length - q.length; i = t.indexOf(q, i + q.length)) out.push(i)
  return out
}

type Found = { rowId: string; occurrence: number; range: Range }

/** The occurrences in the rows drawn now, without touching them. */
export function collectRanges(container: HTMLElement, query: string): Found[] {
  if (!query) return []
  const found: Found[] = []
  const perRow = new Map<string, number>()
  for (const scope of container.querySelectorAll(TEXT)) {
    if (scope.parentElement?.closest(TEXT)) continue
    const rowId = scope.closest('[data-row-id]')?.getAttribute('data-row-id')
    if (!rowId) continue
    let text = ''
    let nodes: { node: Node; start: number; end: number }[] = []
    const flush = () => {
      let s = 0
      let e = 0
      for (const offset of occurrences(text, query)) {
        while (s < nodes.length && nodes[s]!.end <= offset) s++
        if (e < s) e = s
        while (e < nodes.length && nodes[e]!.end < offset + query.length) e++
        const a = nodes[s]
        const b = nodes[e]
        if (!a || !b) continue
        const range = container.ownerDocument.createRange()
        range.setStart(a.node, offset - a.start)
        range.setEnd(b.node, offset + query.length - b.start)
        const n = perRow.get(rowId) ?? 0
        found.push({ rowId, occurrence: n, range })
        perRow.set(rowId, n + 1)
      }
      text = ''
      nodes = []
    }
    const visit = (node: Node, inPre: boolean) => {
      const el = node.nodeType === 1 ? (node as Element) : null
      if (el?.matches('svg')) return
      if (el?.matches(IGNORE)) return flush()
      const tag = el?.tagName.toLowerCase() ?? ''
      const block = BLOCK_TAGS.has(tag)
      if (block) flush()
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? ''
        const start = text.length
        text += inPre ? value : value.replace(/\r?\n/g, ' ')
        nodes.push({ node, start, end: text.length })
      }
      for (const child of node.childNodes) visit(child, inPre || tag === 'pre')
      if (block) flush()
    }
    visit(scope, false)
    flush()
  }
  return found
}

const supported = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

/**
 * Paints every occurrence in the rows drawn now, and the active one apart, again whenever rows
 * mount, unmount or change. Calls `onActive` with the active occurrence's range once it's drawn.
 */
export function useFindHighlights(input: { container: HTMLElement | null; query: string; active: { rowId: string; occurrence: number } | null; onActive: (range: Range | null) => void }) {
  const { container, query, active, onActive } = input
  const latest = useRef({ active, onActive })
  latest.current = { active, onActive }
  const repaintRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!supported() || !container || !query) {
      if (supported()) (CSS.highlights.delete(HIGHLIGHT), CSS.highlights.delete(ACTIVE))
      repaintRef.current = () => {}
      return
    }
    const all = new Highlight()
    const current = new Highlight()
    CSS.highlights.set(HIGHLIGHT, all)
    CSS.highlights.set(ACTIVE, current)
    let lastActive: Range | null = null
    const repaint = () => {
      const found = collectRanges(container, query)
      all.clear()
      current.clear()
      const a = latest.current.active
      let mine: Range | null = null
      for (const f of found) {
        if (a && f.rowId === a.rowId && f.occurrence === a.occurrence) mine = f.range
        else all.add(f.range)
      }
      // The row's text may count differently from what it shows: fall back to its first match.
      if (a && !mine) mine = found.find(f => f.rowId === a.rowId)?.range ?? null
      if (mine) (all.delete(mine), current.add(mine))
      if (mine !== lastActive) latest.current.onActive(mine)
      lastActive = mine
    }
    repaintRef.current = repaint
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (frame === null) frame = requestAnimationFrame(() => ((frame = null), repaint()))
    })
    observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-row-id', 'data-find-fold', 'hidden'] })
    repaint()
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      CSS.highlights.delete(HIGHLIGHT)
      CSS.highlights.delete(ACTIVE)
    }
  }, [container, query])

  useEffect(() => repaintRef.current(), [active?.rowId, active?.occurrence])
}
