// A small Markdown renderer for Claude's replies: paragraphs, lists, headings, code blocks,
// inline code and bold. It builds React elements directly, so text is never parsed as HTML.
import { Fragment, type ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    out.push(tok.startsWith('`') ? <code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code> : <strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>)
    last = m.index! + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const parts = text.split(/^```[^\n]*\n?/m)
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      blocks.push(<pre key={`c${pi}`} className="md-code">{part.replace(/\n$/, '')}</pre>)
      return
    }
    const lines = part.split('\n')
    let list: { ordered: boolean; items: string[] } | null = null
    let para: string[] = []
    const flushPara = () => {
      if (para.length) blocks.push(<p key={`p${pi}-${blocks.length}`}>{inline(para.join(' '), `p${pi}-${blocks.length}`)}</p>)
      para = []
    }
    const flushList = () => {
      if (!list) return
      const items = list.items.map((it, ii) => <li key={ii}>{inline(it, `l${pi}-${blocks.length}-${ii}`)}</li>)
      blocks.push(list.ordered ? <ol key={`o${pi}-${blocks.length}`}>{items}</ol> : <ul key={`u${pi}-${blocks.length}`}>{items}</ul>)
      list = null
    }
    for (const raw of lines) {
      const line = raw.trimEnd()
      const bullet = line.match(/^\s*[-*]\s+(.*)$/)
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
      const heading = line.match(/^#{1,6}\s+(.*)$/)
      if (bullet || numbered) {
        flushPara()
        const ordered = !!numbered
        if (list && list.ordered !== ordered) flushList()
        list ??= { ordered, items: [] }
        list.items.push((bullet ?? numbered)![1]!)
      } else if (heading) {
        flushPara()
        flushList()
        blocks.push(<p key={`h${pi}-${blocks.length}`} className="md-h">{inline(heading[1]!, `h${pi}-${blocks.length}`)}</p>)
      } else if (!line.trim()) {
        flushPara()
        flushList()
      } else {
        flushList()
        para.push(line.trim())
      }
    }
    flushPara()
    flushList()
  })
  return <Fragment>{blocks}</Fragment>
}
