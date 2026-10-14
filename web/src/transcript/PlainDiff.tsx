// A file change as plain text: shown while the highlighted diff loads, and if it can't.
import type { FileChange } from './diffs'

export function plainDiff(change: FileChange): string {
  return change.kind === 'patch'
    ? change.patch.split('\n').filter(l => !l.startsWith('---') && !l.startsWith('+++')).join('\n')
    : [...change.before.split('\n').map(l => `-${l}`), ...change.after.split('\n').map(l => `+${l}`)].join('\n')
}

export function PlainDiff({ change }: { change: FileChange }) {
  return (
    <pre className="tx-diff-plain" data-find-text>
      {plainDiff(change)
        .split('\n')
        .map((l, i) => (
          <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : undefined}>
            {l + '\n'}
          </span>
        ))}
    </pre>
  )
}
