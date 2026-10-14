// The per-card frame hub (web/src/cards/frames.ts): what live cards will send their frames through.
import { expect, test } from 'bun:test'
import { dropFrames, onFrames, pushFrame, watched, type Frame } from '../web/src/cards/frames'

const frame = (at: number): Frame => ({ data: new Blob([String(at)]), width: 1280, height: 800, at })

test('a drawer gets the newest frame at once, then each new one, until it stops', () => {
  pushFrame('c1', frame(1))
  pushFrame('c1', frame(2))
  const seen: number[] = []
  const stop = onFrames('c1', f => seen.push(f.at))
  expect(seen).toEqual([2])
  expect(watched('c1')).toBe(true)

  // A second drawer (a GPU layer taking over) gets the same frames.
  const other: number[] = []
  const stopOther = onFrames('c1', f => other.push(f.at))
  pushFrame('c1', frame(3))
  expect(seen).toEqual([2, 3])
  expect(other).toEqual([2, 3])

  stop()
  stopOther()
  expect(watched('c1')).toBe(false)
  pushFrame('c1', frame(4))
  expect(seen).toEqual([2, 3])
})

test("cards don't share frames, and a dropped card starts empty", () => {
  pushFrame('c2', frame(1))
  const seen: number[] = []
  onFrames('c3', f => seen.push(f.at))
  expect(seen).toEqual([])
  dropFrames('c2')
  const later: number[] = []
  onFrames('c2', f => later.push(f.at))
  expect(later).toEqual([])
})
