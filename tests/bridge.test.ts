// The bridge's pure helpers, without a server.
import { expect, test } from 'bun:test'
import { pollHold } from '../sphere/src/bridge'

test("a permission poll is held no longer than the mod's wait has left", () => {
  // Older mods send no timeout: the 8 s hold, as before.
  expect(pollHold(undefined)).toBe(8_000)
  expect(pollHold(null)).toBe(8_000)
  expect(pollHold('3000')).toBe(8_000)
  // A wait shorter than 8 s ends on time, and a longer one is still polled every 8 s.
  expect(pollHold(3_000)).toBe(3_000)
  expect(pollHold(600_000)).toBe(8_000)
  // A wait that ran out between the mod's check and its request isn't held at all.
  expect(pollHold(0)).toBe(0)
  expect(pollHold(-5)).toBe(0)
})
