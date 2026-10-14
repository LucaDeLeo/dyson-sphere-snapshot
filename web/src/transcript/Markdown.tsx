// What agents write, as Markdown: GitHub's flavour (tables, task lists, strikethrough, autolinks),
// no raw HTML, links opening in a new tab. While a message streams, `remend` closes what the text
// so far leaves open (a `**` or a fence) and T3 Code's incremental parser re-parses only the tail.
// A reply in progress arrives a paragraph at a time (PartialReply) and is drawn `streaming`.
import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remend from 'remend'
import { createIncrementalMarkdownPlugin } from './vendor/markdown-incremental'

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = (node: React.ReactNode): string =>
    typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node.props as { children?: React.ReactNode }).children) : ''
  return (
    <div className="tx-code">
      <button
        className="tx-copy"
        data-find-ignore
        aria-label="Copy code"
        onClick={() => void navigator.clipboard?.writeText(text(children).replace(/\n$/, '')).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Wide tables scroll inside the column instead of widening it.
  table: ({ children }) => (
    <div className="tx-table">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span className="tx-img">[image{alt ? `: ${alt}` : ''}]</span>,
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // One cache per streaming message, kept across its renders.
  const incremental = useMemo(() => (streaming ? createIncrementalMarkdownPlugin() : null), [streaming])
  const plugins = useMemo(() => (incremental ? [remarkGfm, incremental] : [remarkGfm]), [incremental])
  return (
    <div className="tx-md">
      <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
        {streaming ? remend(text) : text}
      </ReactMarkdown>
    </div>
  )
})
