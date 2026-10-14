// Draws file changes with @pierre/diffs (Apache-2.0), which highlights with Shiki. Loaded on first
// use (see Diff.tsx), so the canvas and transcripts without edits never fetch it. It renders in
// its own shadow root, so our styles and its don't meet.
import { getFiletypeFromFileName, preloadHighlighter, type SupportedLanguages } from '@pierre/diffs'
import { MultiFileDiff, PatchDiff } from '@pierre/diffs/react'
import { useEffect, useState } from 'react'
import type { FileChange } from './diffs'
import { PlainDiff } from './PlainDiff'

const THEMES = ['pierre-light', 'pierre-dark']
const options = { diffStyle: 'unified', overflow: 'wrap', themeType: 'system', disableFileHeader: true, theme: { light: 'pierre-light', dark: 'pierre-dark' } } as const

// A diff mounted before the highlighter has its language draws nothing (@pierre/diffs 1.5.1), so
// each language is loaded first, once, and the change shows as text until then.
const loading = new Map<SupportedLanguages, Promise<boolean>>()
const loaded = new Set<SupportedLanguages>()
function load(lang: SupportedLanguages): Promise<boolean> {
  let p = loading.get(lang)
  if (!p) {
    p = preloadHighlighter({ themes: THEMES, langs: [lang] }).then(
      () => (loaded.add(lang), true),
      () => false,
    )
    loading.set(lang, p)
  }
  return p
}

export default function DiffView({ change }: { change: FileChange }) {
  const lang = getFiletypeFromFileName(change.path)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(loaded.has(lang) ? 'ready' : 'loading')
  useEffect(() => {
    let alive = true
    if (!loaded.has(lang)) void load(lang).then(ok => alive && setState(ok ? 'ready' : 'failed'))
    return () => void (alive = false)
  }, [lang])
  if (state !== 'ready') return <PlainDiff change={change} />
  return change.kind === 'patch' ? (
    <PatchDiff patch={change.patch} options={options} disableWorkerPool />
  ) : (
    <MultiFileDiff oldFile={{ name: change.path, contents: change.before }} newFile={{ name: change.path, contents: change.after }} options={options} disableWorkerPool />
  )
}
