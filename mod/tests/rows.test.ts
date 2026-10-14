// What the mod sends the bridge for transcript rows: thinking as its own row, tool inputs and
// results as objects, and rows as they always were for a bridge from before structured rows.
//
//   claude plugin test dyson-sphere/mod
//
// The bridge is a stand-in: its ready line comes from `process.spawn`, and what the mod posts to
// it is caught at `http.fetch`.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Posted = { type: string; key?: string; data: Record<string, any> }

/** Stands in for the engine beneath the mod and for the bridge, which says it speaks `protocol`. */
function bridge(on: On, protocol: number | null) {
  const posted: Posted[] = []
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
    yield { stream: 'stdout' as const, text: JSON.stringify({ kind: 'ready', sessionId: 'sess-1', socket: '/tmp/b.sock', secret: 's', ...(protocol !== null && { protocol }) }) + '\n' }
    await new Promise(() => {}) // the bridge runs for the session's life
    return { code: 0 } as never
  } as never)
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/events')) posted.push(...(JSON.parse(e.init?.body ?? '{}').events as Posted[]))
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  return posted
}

const rows = (posted: Posted[]) => posted.filter(p => p.type === 'session.row').map(p => p.data)

async function settle(posted: Posted[], n: number) {
  for (let i = 0; i < 50 && rows(posted).length < n; i++) await new Promise(r => setTimeout(r, 10))
}

test('thinking is its own row, and a tool call carries its input as an object, redacted per field', async ($, on) => {
  const posted = bridge(on, 3)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The env file holds the token.', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/w/.env', old_string: 'API_TOKEN=abcd1234efgh5678', new_string: '' } },
      ],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-test' },
    uuid: 'u1',
  } as never)
  await settle(posted, 2)
  const [thinking, call] = rows(posted)
  expect(thinking).toMatchObject({ kind: 'thinking', text: 'The env file holds the token.' })
  expect(call!.kind).toBe('tool-call')
  expect(call!.text.startsWith('Edit {"file_path":"/w/.env"')).toBe(true)
  expect(call!.calls).toEqual([{ id: 'toolu_1', name: 'Edit', input: { file_path: '/w/.env', old_string: 'API_TOKEN=[redacted]', new_string: '' } }])
})

test('a bridge from before structured rows gets rows as they were, and no thinking', async ($, on) => {
  const posted = bridge(on, null)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Listing first.', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } },
      ],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-test' },
    uuid: 'u2',
  } as never)
  await settle(posted, 1)
  await new Promise(r => setTimeout(r, 50))
  expect(rows(posted)).toEqual([
    { sessionId: 'sess-1', uuid: 'u2', door: 'response', origin: 'model', agentId: null, kind: 'tool-call', summary: 'Bash {"command":"ls"}', text: 'Bash {"command":"ls"}', tools: [{ name: 'Bash', id: 'toolu_2' }] },
  ])
})

test("a tool's structured result goes on the row that records it, without the file it edited", async ($, on) => {
  const posted = bridge(on, 3)
  on('tool.call', async () => ({
    result: { filePath: '/w/a.ts', oldString: 'a', newString: 'b', originalFile: 'a\n'.repeat(1000), structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], userModified: false, replaceAll: false },
  }) as never)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'toolu_4', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: 'The file /w/a.ts has been updated.' }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Edit' },
    uuid: 'u4',
  } as never)
  await settle(posted, 1)
  const [result] = rows(posted)
  expect(result).toMatchObject({ kind: 'tool-result', toolUseIds: ['toolu_4'] })
  expect(result!.results).toEqual([
    { id: 'toolu_4', isError: false, output: { filePath: '/w/a.ts', oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], userModified: false, replaceAll: false } },
  ])
})

test('a tool result with nothing in it still gets its row, saying the call finished', async ($, on) => {
  const posted = bridge(on, 3)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: '' }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'u5',
  } as never)
  await settle(posted, 1)
  expect(rows(posted)).toMatchObject([{ kind: 'tool-result', text: '(no output)', toolUseIds: ['toolu_5'], results: [{ id: 'toolu_5', isError: false }] }])
})

test('results of calls run together each keep their own text', async ($, on) => {
  const posted = bridge(on, 3)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'first file' }, { type: 'tool_result', tool_use_id: 'x2', content: 'second file' }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: 'u5',
  } as never)
  await settle(posted, 1)
  const [row] = rows(posted)
  expect(row!.text).toBe('first file\nsecond file')
  expect(row!.results).toEqual([{ id: 'x1', isError: false, text: 'first file' }, { id: 'x2', isError: false, text: 'second file' }])
})
