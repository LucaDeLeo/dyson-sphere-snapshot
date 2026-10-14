// Replies in progress: the main agent's and subagents' text goes to the bridge a paragraph at a time, as it
// streams through `turn.step`, and every chunk passes on untouched.
//
//   claude plugin test dyson-sphere/mod
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Partial = { agentId?: string; turnId: string; step: number; block: number; text: string }

/** The engine beneath the mod and a bridge that says it speaks `protocol`; catches `/partial` posts. */
function bridge(on: On, protocol: number) {
  const partials: Partial[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('env.get', async () => ({ value: undefined }))
  on('fs.exists', async () => ({ value: false }))
  on('agent.list', async () => ({ value: [] }))
  on('clock.every', async () => ({ value: undefined }) as never)
  on('clock.now', async () => ({ value: 1_000 }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.log', async () => ({ value: undefined }) as never)
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: JSON.stringify({ kind: 'ready', sessionId: 'sess-1', socket: '/tmp/b.sock', secret: 's', protocol }) + '\n' }
    await new Promise(() => {})
    return { code: 0 } as never
  } as never)
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/partial')) partials.push(JSON.parse(e.init?.body ?? '{}'))
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  return partials
}

/** A model response streamed in these pieces of text, in block 0. */
function model(on: On, pieces: string[]) {
  on('turn.step', async function* (_$, e) {
    for (const text of pieces) yield { kind: 'text' as const, index: 0, text }
    return { turnId: e.turnId, index: e.index, answer: pieces.join(''), toolUses: [] } as never
  } as never)
}

const REPLY = ['The test fails', ' near midnight.\n', '\nIt compares two', ' dates.\n\n```py\nx = 1\n', '\ny = 2\n```\n', '\nThe token is sk-ant-api03-abcdefghijklmnopqrstuv', '\n\nTail without a blank line']

test('a reply goes to the bridge a paragraph at a time, a code block whole, secrets redacted', async ($, on) => {
  const partials = bridge(on, 4)
  model(on, REPLY)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 30)) // the bridge's ready line, which says what it speaks
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  const seen: string[] = []
  for await (const c of stream) if (c.kind === 'text') seen.push(c.text)
  await new Promise(r => setTimeout(r, 30))
  // Untouched for the person and the transcript.
  expect(seen).toEqual(REPLY)
  expect(partials.map(p => p.text)).toEqual([
    'The test fails near midnight.',
    'The test fails near midnight.\n\nIt compares two dates.',
    'The test fails near midnight.\n\nIt compares two dates.\n\n```py\nx = 1\n\ny = 2\n```',
    'The test fails near midnight.\n\nIt compares two dates.\n\n```py\nx = 1\n\ny = 2\n```\n\nThe token is [redacted]',
  ])
  expect(partials[0]).toMatchObject({ turnId: 't1', step: 0, block: 0 })
})

test('a bridge from before replies in progress gets none', async ($, on) => {
  const partials = bridge(on, 3)
  model(on, REPLY)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 30))
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
  }
  await new Promise(r => setTimeout(r, 30))
  expect(partials).toEqual([])
})

test("a subagent's reply is sent too, named by its agent", async ($, on) => {
  const partials = bridge(on, 4)
  model(on, REPLY)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 30))
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId: 'sub-1' })) {
  }
  await new Promise(r => setTimeout(r, 30))
  expect(partials).toHaveLength(4)
  expect(partials[0]).toMatchObject({ agentId: 'sub-1', turnId: 't1', step: 0, block: 0, text: 'The test fails near midnight.' })
})

test('past the limit, nothing more of the block is sent', async ($, on) => {
  const partials = bridge(on, 4)
  model(on, ['First.\n\n', 'x'.repeat(20_001), '\n\nThird.\n\n'])
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 30))
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
  }
  await new Promise(r => setTimeout(r, 30))
  expect(partials.map(p => p.text)).toEqual(['First.'])
})
