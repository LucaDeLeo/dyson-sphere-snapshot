// Structured rows' pure helpers: redaction and cuts per field, what an older peer is sent, and
// the server's checks and caps. No server needed.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { capRow, cleanRow, cutFields, FIELD_TEXT_LIMIT, fieldAt, forPeer, redactValue, sourceValue, SOURCE_FIELD_LIMIT, SOURCE_VALUE_LIMIT, VALUE_JSON_LIMIT, type CutField } from '../shared/rows'

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'

test('every string in a tool input is redacted, including inside an Edit', () => {
  const input = {
    file_path: '/x/.env',
    old_string: `ANTHROPIC_API_KEY=${KEY}\nother=1`,
    new_string: 'ANTHROPIC_API_KEY=\nother=1',
    nested: [{ deep: `ghp_${'a'.repeat(30)}` }],
    count: 3,
  }
  const out = redactValue(input) as typeof input
  expect(JSON.stringify(out)).not.toContain(KEY)
  expect(JSON.stringify(out)).not.toContain('ghp_aaaa')
  expect(out.old_string).toContain('other=1')
  expect(out.count).toBe(3)
  expect(out.file_path).toBe('/x/.env')
})

test('a credential under a secret-named key is redacted, though the key no longer sits beside it', () => {
  // The JSON string had `"token":"…"` for redact's pattern to find; a field on its own doesn't.
  expect(redactValue({ token: 'abcd1234efgh', password: 'hunter2hunter2', apiKey: 'x'.repeat(12) })).toEqual({ token: '[redacted]', password: '[redacted]', apiKey: '[redacted]' })
  expect(redactValue({ env: { GITHUB_TOKEN: 'ghx_abcdefgh', AWS_SECRET_ACCESS_KEY: 'abcdEFGH1234', DB_PASSWORD: 'p4ssw0rd!', HOME: '/home/abcdefgh' } })).toEqual({
    env: { GITHUB_TOKEN: '[redacted]', AWS_SECRET_ACCESS_KEY: '[redacted]', DB_PASSWORD: '[redacted]', HOME: '/home/abcdefgh' },
  })
  expect(redactValue({ clientSecret: 'abcdefgh1234', accessToken: 'abcdefgh1234', max_tokens: '12000000', tokenizer: 'cl100k_base' })).toEqual({
    clientSecret: '[redacted]',
    accessToken: '[redacted]',
    max_tokens: '12000000',
    tokenizer: 'cl100k_base',
  })
  // Spaces or a newline at its ends don't hide one.
  expect(redactValue({ apiKey: ' abcdEFGH12345678\n' })).toEqual({ apiKey: '[redacted]' })
  // Ordinary values under those names, and other keys, are left alone.
  expect(redactValue({ token: 'short', password: 'two words here', description: 'abcd1234efgh' })).toEqual({ token: 'short', password: 'two words here', description: 'abcd1234efgh' })
})

test('a value nested too deep to redact is dropped, not sent as it was', () => {
  let deep: Record<string, unknown> = { token: 'abcdefgh1234', note: KEY }
  for (let i = 0; i < 40; i++) deep = { inner: deep }
  const out = JSON.stringify(redactValue({ output: deep }))
  expect(out).not.toContain('abcdefgh1234')
  expect(out).not.toContain(KEY)
  expect(out).toContain('[too deep]')
})

test('redaction comes before the cut, so a secret cut short is still caught', () => {
  const cut: CutField[] = []
  const long = 'x'.repeat(SOURCE_FIELD_LIMIT - 20) + '\n' + KEY
  const v = sourceValue({ content: long }, ['calls', 0, 'input'], cut) as { content: string }
  expect(v.content.includes('sk-ant')).toBe(false)
  // The redacted string is shorter than the limit, so nothing was cut.
  expect(cut).toEqual([])
})

test('long strings are cut per field and listed; a value still too large is dropped whole', () => {
  const cut: CutField[] = []
  const v = cutFields({ a: 'x'.repeat(SOURCE_FIELD_LIMIT + 5), b: ['y'] }, ['calls', 1, 'input'], cut) as { a: string; b: string[] }
  expect(v.a).toHaveLength(SOURCE_FIELD_LIMIT)
  expect(v.b).toEqual(['y'])
  expect(cut).toEqual([{ path: ['calls', 1, 'input', 'a'], fullLength: SOURCE_FIELD_LIMIT + 5 }])

  const many: CutField[] = []
  const big = { lines: Array.from({ length: 10 }, () => 'z'.repeat(SOURCE_VALUE_LIMIT / 8)) }
  expect(sourceValue(big, ['results', 0, 'output'], many)).toBeNull()
  expect(many).toHaveLength(1)
  expect(many[0]!.path).toEqual(['results', 0, 'output'])
})

test('an older peer gets rows as they were: no structured fields and no thinking rows', () => {
  const events = [
    { key: 'a', type: 'session.row', data: { kind: 'tool-call', text: 'Bash {"command":"ls"}', calls: [{ id: '1', name: 'Bash', input: { command: 'ls' } }], cut: [] } },
    { key: 'b', type: 'session.row', data: { kind: 'thinking', text: 'hmm' } },
    { key: 'c', type: 'session.status', data: { state: 'idle' } },
  ]
  const old = forPeer(events, 2)
  expect(old.dropped).toEqual(['b'])
  expect(old.events.map(e => e.key)).toEqual(['a', 'c'])
  expect(old.events[0]!.data).toEqual({ kind: 'tool-call', text: 'Bash {"command":"ls"}' })
  // A current peer gets them untouched.
  expect(forPeer(events, 3)).toEqual({ events, dropped: [] })
})

test('the server keeps only well-formed structured fields, and never a client-set cap', () => {
  const data: Record<string, unknown> = {
    kind: 'tool-call',
    calls: [{ id: '1', name: 'Bash', input: { command: 'ls' } }, { id: 2, name: 'x', input: {} }, { id: '3', name: 'Read', input: 'not an object' }],
    results: 'nope',
    cut: [{ path: ['calls', 0, 'input', 'command'], fullLength: 9 }, { path: [], fullLength: 1 }, { path: ['x'], fullLength: 'big' }],
    capped: [{ path: ['text'], bodyId: '<img onerror=alert(1)>', fullLength: 1 }],
  }
  cleanRow(data)
  expect(data).toEqual({
    kind: 'tool-call',
    calls: [{ id: '1', name: 'Bash', input: { command: 'ls' } }],
    cut: [{ path: ['calls', 0, 'input', 'command'], fullLength: 9 }],
  })
})

test('long fields go to bodies, and a value too large as a whole goes to one as JSON', async () => {
  const bodies = new Map<string, string>()
  const put = async (t: string) => {
    const id = `b${bodies.size}`
    bodies.set(id, t)
    return id
  }
  const long = 'L'.repeat(FIELD_TEXT_LIMIT + 100)
  const huge = { lines: Array.from({ length: 200 }, (_, i) => `line ${i} `.repeat(60)) }
  const data: Record<string, unknown> = {
    kind: 'tool-result',
    calls: [{ id: '1', name: 'Edit', input: { file_path: '/a', old_string: long, new_string: 'short' } }],
    results: [{ id: '1', output: huge }, { id: '2', isError: true }],
  }
  await capRow(data, put)
  const capped = data.capped as { path: (string | number)[]; bodyId: string; fullLength: number; json?: true }[]
  expect(capped).toHaveLength(2)
  const [field, whole] = capped
  expect(field).toMatchObject({ path: ['calls', 0, 'input', 'old_string'], fullLength: long.length })
  expect(fieldAt(data, field!.path)).toHaveLength(FIELD_TEXT_LIMIT)
  expect(bodies.get(field!.bodyId)).toBe(long)
  expect(fieldAt(data, ['calls', 0, 'input', 'new_string'])).toBe('short')
  expect(whole).toMatchObject({ path: ['results', 0, 'output'], json: true })
  expect(JSON.stringify(huge).length).toBeGreaterThan(VALUE_JSON_LIMIT)
  expect(fieldAt(data, whole!.path)).toBeNull()
  expect(JSON.parse(bodies.get(whole!.bodyId)!)).toEqual(huge)
  expect((data.results as unknown[])[1]).toEqual({ id: '2', isError: true })
})

test('a value that goes whole to a body leaves no bodies behind for its fields', async () => {
  const bodies: string[] = []
  const put = async (t: string) => (bodies.push(t), `b${bodies.length - 1}`)
  const output = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, String(i).repeat(FIELD_TEXT_LIMIT + 1000)]))
  const data: Record<string, unknown> = { kind: 'tool-result', results: [{ id: '1', output }] }
  await capRow(data, put)
  expect(data.capped).toEqual([{ path: ['results', 0, 'output'], bodyId: 'b0', fullLength: JSON.stringify(output).length, json: true }])
  expect(bodies).toHaveLength(1)
})

test("the mod's copies match shared/rows.ts and shared/protocol.ts", () => {
  // A mod can't import from outside its folder, so it keeps copies (mod/hooks/register.ts).
  const read = (f: string) => readFileSync(`${import.meta.dir}/../${f}`, 'utf8')
  const mod = read('mod/hooks/register.ts')
  const pick = (src: string, re: RegExp) => src.match(re)?.[0]
  const copies: [string, RegExp[]][] = [
    ['shared/rows.ts', [/const SECRET_KEY = .*/, /const secretKey = .*/, /SOURCE_FIELD_LIMIT = [\d_]+/, /SOURCE_VALUE_LIMIT = [\d_]+/, /STRUCTURED_ROWS = \d+/, /function redactValue\([\s\S]*?\n}/]],
    ['shared/protocol.ts', [/PARTIAL_REPLIES = \d+/, /PARTIAL_TEXT_LIMIT = [\d_]+/]],
  ]
  for (const [file, res] of copies)
    for (const re of res) {
      expect(pick(mod, re)).toBeString()
      expect(pick(mod, re)).toBe(pick(read(file), re))
    }
})

test("a result's own text is kept and capped like its other fields", async () => {
  const data: Record<string, unknown> = { kind: 'tool-result', results: [{ id: 'a', text: 'short' }, { id: 'b', text: 'T'.repeat(FIELD_TEXT_LIMIT + 1) }, { id: 'c', text: 42 }] }
  cleanRow(data)
  expect((data.results as any[])[2]).toEqual({ id: 'c' })
  const bodies: string[] = []
  await capRow(data, async t => (bodies.push(t), `b${bodies.length}`))
  expect(data.capped).toEqual([{ path: ['results', 1, 'text'], bodyId: 'b1', fullLength: FIELD_TEXT_LIMIT + 1 }])
  expect((data.results as any[])[0].text).toBe('short')
})
