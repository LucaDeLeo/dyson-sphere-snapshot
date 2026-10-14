// The terminal relay (server/src/terminals.ts), in this process: who may watch and type, what a
// viewer that joins late, falls behind or goes off screen gets, and when the bridge detaches.
import { afterEach, describe, expect, test } from 'bun:test'
import type { TermToBridge, TermToViewer } from '../shared/terminal'
import { Terminals, type TermCheck, type Viewer } from '../server/src/terminals'

type FakeViewer = Viewer & { got: TermToViewer[]; backlog: number }
const viewer = (identity: string): FakeViewer => {
  const v: FakeViewer = { identity, got: [], backlog: 0, send: m => void v.got.push(JSON.parse(m)), buffered: () => v.backlog }
  return v
}

let current: Terminals | null = null
afterEach(() => current?.dispose())

function relay(check: TermCheck = { owner: 'luca', status: 'live' }) {
  const toBridge: TermToBridge[] = []
  const state = { check, bridge: true }
  const t = new Terminals({
    check: () => state.check,
    toBridge: (_id, m) => (state.bridge ? (toBridge.push(m), true) : false),
    graceMs: 30,
    highWater: 1000,
    lowWater: 100,
    maxViewers: 3,
  })
  current = t
  return { t, toBridge, state }
}
const ops = (ms: TermToBridge[]) => ms.map(m => m.op)
const kinds = (v: FakeViewer) => v.got.map(m => m.t)

describe('the terminal relay', () => {
  test('the owner watches and types; anyone else watches only', () => {
    const { t, toBridge } = relay()
    const luca = viewer('luca')
    const jp = viewer('jp')
    expect(t.join('s1', luca)).toBe(true)
    expect(luca.got[0]).toEqual({ t: 'hello', owner: 'luca', canType: true })
    expect(ops(toBridge)).toEqual(['open'])
    t.join('s1', jp)
    expect(jp.got[0]).toEqual({ t: 'hello', owner: 'luca', canType: false })
    expect(ops(toBridge)).toEqual(['open']) // one stream per session

    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: 'screen' })
    expect(luca.got.at(-1)).toEqual({ t: 'state', cols: 80, rows: 24, d: 'screen' })
    expect(jp.got.at(-1)).toEqual({ t: 'state', cols: 80, rows: 24, d: 'screen' })
    t.fromBridge('s1', { op: 'out', d: 'more' })
    expect(jp.got.at(-1)).toEqual({ t: 'out', d: 'more' })

    t.fromViewer('s1', luca, JSON.stringify({ t: 'in', d: 'ls\r' }))
    t.fromViewer('s1', luca, JSON.stringify({ t: 'fit', cols: 100, rows: 30 }))
    expect(toBridge.slice(1)).toEqual([
      { op: 'in', d: 'ls\r' },
      { op: 'fit', cols: 100, rows: 30 },
    ])
    // jp's keys and resizes go nowhere, and jp is told why (once, not per key).
    t.fromViewer('s1', jp, JSON.stringify({ t: 'in', d: 'rm -rf ~\r' }))
    t.fromViewer('s1', jp, JSON.stringify({ t: 'in', d: 'x' }))
    t.fromViewer('s1', jp, JSON.stringify({ t: 'fit', cols: 100, rows: 30 }))
    expect(toBridge).toHaveLength(3)
    expect(jp.got.filter(m => m.t === 'refused')).toEqual([{ t: 'refused', reason: 'Only luca can type here.' }])
    // Nonsense and oversized input go nowhere either.
    t.fromViewer('s1', luca, 'not json')
    t.fromViewer('s1', luca, JSON.stringify({ t: 'in', d: 'x'.repeat(70_000) }))
    t.fromViewer('s1', luca, JSON.stringify({ t: 'fit', cols: 5000, rows: 30 }))
    expect(toBridge).toHaveLength(3)
  })

  test('a late viewer waits for the whole screen; it alone needs it', () => {
    const { t, toBridge } = relay()
    const luca = viewer('luca')
    t.join('s1', luca)
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: 'a' })
    const jp = viewer('jp')
    t.join('s1', jp)
    expect(ops(toBridge)).toEqual(['open', 'snapshot'])
    // Output before it comes isn't jp's to see: jp's terminal would draw it on nothing.
    t.fromBridge('s1', { op: 'out', d: 'x' })
    expect(kinds(jp)).toEqual(['hello', 'status'])
    expect(luca.got.at(-1)).toEqual({ t: 'out', d: 'x' })
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: 'ax' })
    expect(jp.got.at(-1)).toMatchObject({ t: 'state', d: 'ax' })
  })

  test('a viewer that falls behind misses output, then gets the screen once it catches up', () => {
    const { t, toBridge } = relay()
    const v = viewer('jp')
    t.join('s1', v)
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: '' })
    v.backlog = 5000
    t.fromBridge('s1', { op: 'out', d: 'lost' })
    t.fromBridge('s1', { op: 'out', d: 'lost too' })
    expect(v.got.some(m => m.t === 'out')).toBe(false)
    expect(t.stream('s1')!.viewers[0]!.mode).toBe('behind')
    v.backlog = 0
    t.drained('s1', v)
    expect(ops(toBridge)).toEqual(['open', 'snapshot'])
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: 'all of it' })
    expect(v.got.at(-1)).toMatchObject({ t: 'state', d: 'all of it' })
  })

  test('off screen it gets nothing; back on, the whole screen', () => {
    const { t, toBridge } = relay()
    const v = viewer('luca')
    t.join('s1', v)
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: '' })
    t.fromViewer('s1', v, JSON.stringify({ t: 'pause' }))
    t.fromBridge('s1', { op: 'out', d: 'unseen' })
    t.fromBridge('s1', { op: 'state', cols: 90, rows: 24, d: 'resized' })
    expect(v.got.filter(m => m.t === 'out' || m.t === 'state')).toHaveLength(1)
    t.fromViewer('s1', v, JSON.stringify({ t: 'resume' }))
    expect(ops(toBridge)).toEqual(['open', 'snapshot'])
  })

  test('the bridge detaches a while after the last viewer leaves, not if one comes back', async () => {
    const { t, toBridge } = relay()
    const a = viewer('luca')
    t.join('s1', a)
    t.leave('s1', a)
    await Bun.sleep(10)
    const b = viewer('luca')
    t.join('s1', b) // a reload: the screen the bridge sends for `open` is its too
    await Bun.sleep(50)
    expect(ops(toBridge)).toEqual(['open'])
    t.leave('s1', b)
    await Bun.sleep(50)
    expect(ops(toBridge)).toEqual(['open', 'close'])
    expect(t.stream('s1')).toBeUndefined()
    // Output that still arrives tells the bridge again to stop.
    t.fromBridge('s1', { op: 'out', d: 'late' })
    expect(ops(toBridge).at(-1)).toBe('close')
  })

  test("says why there's nothing to show, and attaches once there is", () => {
    const { t, toBridge, state } = relay({ owner: 'luca', status: 'offline' })
    const v = viewer('jp')
    t.join('s1', v)
    expect(v.got.at(-1)).toEqual({ t: 'status', status: 'offline' })
    expect(toBridge).toHaveLength(0)
    state.check = { owner: 'luca', status: 'live' }
    t.refresh('s1')
    expect(ops(toBridge)).toEqual(['open'])
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: '' })
    expect(v.got.find(m => m.t === 'status' && m.status === 'live')).toBeTruthy()
    // The session ended: its viewers are told, and the bridge detaches.
    state.check = { owner: 'luca', status: 'ended' }
    t.refresh('s1')
    expect(v.got.at(-1)).toEqual({ t: 'status', status: 'ended' })
    expect(ops(toBridge)).toEqual(['open', 'close'])
    // The pane went away under the bridge.
    state.check = { owner: 'luca', status: 'live' }
    t.refresh('s1')
    t.fromBridge('s1', { op: 'closed', reason: 'gone' })
    expect(v.got.at(-1)).toEqual({ t: 'status', status: 'unavailable', reason: 'gone' })
  })

  test('bytes and pastes are marked as such; bytes are bytes', () => {
    const { t, toBridge } = relay()
    const v = viewer('luca')
    t.join('s1', v)
    t.fromBridge('s1', { op: 'state', cols: 80, rows: 24, d: '' })
    t.fromViewer('s1', v, JSON.stringify({ t: 'in', d: '\x1b[M \xa0!', binary: true }))
    t.fromViewer('s1', v, JSON.stringify({ t: 'in', d: 'é', binary: true }))
    t.fromViewer('s1', v, JSON.stringify({ t: 'in', d: 'Ā', binary: true })) // past 0xff: not a byte
    t.fromViewer('s1', v, JSON.stringify({ t: 'in', d: 'a\rb', paste: true }))
    expect(toBridge.slice(1)).toEqual([
      { op: 'in', d: '\x1b[M \xa0!', binary: true },
      { op: 'in', d: 'é', binary: true },
      { op: 'in', d: 'a\rb', paste: true },
    ])
  })

  test('a viewer back within the grace, after the bridge went, has it attach again', () => {
    const { t, toBridge, state } = relay()
    const a = viewer('luca')
    t.join('s1', a)
    t.leave('s1', a)
    // The bridge went while nobody watched (and with it, its tmux client).
    state.check = { owner: 'luca', status: 'offline' }
    t.refresh('s1')
    state.check = { owner: 'luca', status: 'live' }
    t.join('s1', viewer('luca'))
    expect(ops(toBridge)).toEqual(['open', 'open'])
  })

  test('no such session, or too many viewers, is refused', () => {
    const none = relay(null)
    const v = viewer('luca')
    expect(none.t.join('nope', v)).toBe(false)
    expect(v.got).toEqual([{ t: 'status', status: 'unavailable', reason: 'There is no such session.' }])

    const { t } = relay()
    for (let i = 0; i < 3; i++) expect(t.join('s1', viewer('jp'))).toBe(true)
    const fourth = viewer('jp')
    expect(t.join('s1', fourth)).toBe(false)
    expect(fourth.got.at(-1)).toMatchObject({ status: 'unavailable' })
  })
})
