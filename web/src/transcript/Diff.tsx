// A file change, drawn by DiffView once it has loaded. Until then (and if it can't load) the
// change shows as text, so it's readable at once.
import { Component, lazy, Suspense, type ReactNode } from 'react'
import type { FileChange } from './diffs'
import { PlainDiff } from './PlainDiff'

const DiffView = lazy(() => import('./DiffView'))

class Fallback extends Component<{ children: ReactNode; plain: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.plain : this.props.children
  }
}

export function Diff({ change }: { change: FileChange }) {
  const plain = <PlainDiff change={change} />
  return (
    <div className="tx-diff">
      <Fallback plain={plain}>
        <Suspense fallback={plain}>
          <DiffView change={change} />
        </Suspense>
      </Fallback>
    </div>
  )
}
