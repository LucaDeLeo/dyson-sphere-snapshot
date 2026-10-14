// Where a live card's frames go: a browser card's screencast, one day a simulator's video. One hub
// per card, so whoever draws the frames (an <img> in the card today, a GPU layer behind the canvas
// later, or both during a hand-off) subscribes here, and the stream doesn't need to know.
// Nothing streams yet: browser cards come after the move to tldraw (CS-2554).

export type Frame = {
  /** The encoded image, as the stream sent it. */
  data: Blob
  width: number
  height: number
  /** When it was captured, ms since the epoch. */
  at: number
}

type Sink = (f: Frame) => void
const hubs = new Map<string, { latest: Frame | null; sinks: Set<Sink> }>()

const hub = (cardId: string) => {
  let h = hubs.get(cardId)
  if (!h) hubs.set(cardId, (h = { latest: null, sinks: new Set() }))
  return h
}

/** A card's stream has a new frame. Only the newest is kept: a drawer that's behind skips ahead. */
export function pushFrame(cardId: string, frame: Frame) {
  const h = hub(cardId)
  h.latest = frame
  for (const sink of h.sinks) sink(frame)
}

/** Draws a card's frames: the newest one at once, if there is one, then each new one. Returns how to stop. */
export function onFrames(cardId: string, sink: Sink): () => void {
  const h = hub(cardId)
  h.sinks.add(sink)
  if (h.latest) sink(h.latest)
  return () => void h.sinks.delete(sink)
}

/** Whether anything draws this card's frames: a stream can pause when nothing does. */
export const watched = (cardId: string) => (hubs.get(cardId)?.sinks.size ?? 0) > 0

/** The card is gone: its hub goes too. */
export const dropFrames = (cardId: string) => void hubs.delete(cardId)
