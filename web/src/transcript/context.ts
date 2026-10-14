// What rows need from the transcript around them, without importing it: fetching a stored body,
// drawing nested rows (a subagent's), and which rows are open. Open state lives in the transcript,
// not in rows, because the list unmounts rows that scroll out of view.
import { createContext, useContext, type ReactNode } from 'react'
import type { AgentKind } from '../../../shared/protocol'
import type { TimelineRow } from './model'

export type TranscriptContext = {
  agent: AgentKind
  body: (id: string) => Promise<string>
  renderRows: (rows: TimelineRow[]) => ReactNode
  /** Whether a row or call is open; `fallback` when nobody has opened or closed it. */
  isOpen: (id: string, fallback: boolean) => boolean
  toggle: (id: string, fallback: boolean) => void
}

export const Ctx = createContext<TranscriptContext | null>(null)

export function useTranscript(): TranscriptContext {
  const c = useContext(Ctx)
  if (!c) throw new Error('transcript rows must be drawn inside <Transcript>')
  return c
}
