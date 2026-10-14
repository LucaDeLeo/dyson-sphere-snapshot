// The transcript's row model, from stored rows: no server or browser needed.
import { expect, test } from 'bun:test'
import type { PermissionRequest, StoredEvent } from '../shared/protocol'
import { patchFiles, summarize, toolLabel, toolTarget } from '../web/src/transcript/classify'
import { buildTimeline, foldsTo, searchText, type TimelineRow } from '../web/src/transcript/model'
import { restored } from '../web/src/transcript/tools'

let seq = 0
const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, s)).toISOString()
const ev = (data: Record<string, unknown>): StoredEvent => {
  seq++
  return { seq, topic: 'session:s', type: 'session.row', actor: 'luca', at: at(seq), data: { sessionId: 's', summary: '', text: '', ...data } }
}
const call = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ev({ kind: 'tool-call', text: `${name} ${JSON.stringify(input)}`, tools: [{ name, id }], calls: [{ id, name, input }], ...extra })
const result = (id: string, text: string, extra: Record<string, unknown> = {}) => ev({ kind: 'tool-result', text, toolUseIds: [id], ...extra })
const kinds = (rows: TimelineRow[]) => rows.map(r => r.kind)

test('a call and its result are one row, with the structured output', () => {
  const t = buildTimeline([
    ev({ kind: 'prompt', text: 'Fix the test' }),
    call('t1', 'Bash', { command: 'bun test', description: 'Run tests' }),
    result('t1', '12 pass', { results: [{ id: 't1', isError: false, output: { stdout: '12 pass', stderr: '', interrupted: false } }] }),
    ev({ kind: 'assistant', text: 'All green.' }),
  ])
  expect(kinds(t.rows)).toEqual(['prompt', 'tool', 'assistant'])
  const tool = (t.rows[1] as Extract<TimelineRow, { kind: 'tool' }>).tool
  expect(tool).toMatchObject({ name: 'Bash', status: 'done', label: 'bun test', legacy: false, result: { text: '12 pass', output: { stdout: '12 pass' } } })
  expect(t.turns).toEqual([{ rowId: t.rows[0]!.id, index: 0, text: 'Fix the test', reply: 'All green.' }])
})

test('rows from before structured rows are read from their text, even cut short', () => {
  const long = 'x'.repeat(3000)
  const cut = `Edit ${JSON.stringify({ file_path: '/a/b.ts', old_string: long, new_string: 'y' })}`.slice(0, 2000)
  const t = buildTimeline([
    ev({ kind: 'tool-call', text: 'Read {"file_path":"/a/b.ts"}', tools: [{ name: 'Read', id: 'r1' }] }),
    ev({ kind: 'tool-error', text: 'File not found', toolUseIds: ['r1'] }),
    ev({ kind: 'tool-call', text: cut, tools: [{ name: 'Edit', id: 'e1' }] }),
  ])
  const [read, edit] = t.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool)
  expect(read).toMatchObject({ legacy: true, partial: false, status: 'error', input: { file_path: '/a/b.ts' }, label: 'Read /a/b.ts' })
  expect(edit).toMatchObject({ legacy: true, partial: true, status: 'running', input: { file_path: '/a/b.ts' } })
})

test("the engine's own prompts are notes, not turns", () => {
  const t = buildTimeline([
    ev({ kind: 'prompt', text: 'Find the callers', origin: 'unclassified' }),
    ev({ kind: 'prompt', text: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>', origin: 'task-notification' }),
    ev({ kind: 'prompt', text: '<system-reminder>context</system-reminder>' }),
  ])
  expect(t.rows.map(r => [r.kind, r.kind === 'note' ? r.label : null])).toEqual([['prompt', null], ['note', 'Notification'], ['note', 'Notification']])
  expect(t.turns).toHaveLength(1)
})

test('a result whose call is older than the loaded rows still shows', () => {
  const t = buildTimeline([result('gone', 'output of a call further back')])
  expect(t.rows).toMatchObject([{ kind: 'result', text: 'output of a call further back', toolId: 'gone' }])
})

test('runs of three or more calls are grouped, but not the running one', () => {
  const rows = [
    ev({ kind: 'prompt', text: 'Look around' }),
    call('a', 'Read', { file_path: '/x/one.ts' }),
    result('a', '1'),
    call('b', 'Read', { file_path: '/x/two.ts' }),
    result('b', '2'),
    call('c', 'Bash', { command: 'ls' }),
    ev({ kind: 'tool-error', text: 'denied', toolUseIds: ['c'] }),
    ev({ kind: 'thinking', text: 'Now edit.' }),
    call('d', 'Edit', { file_path: '/x/one.ts', old_string: 'a', new_string: 'b' }),
    call('e', 'Edit', { file_path: '/x/one.ts', old_string: 'c', new_string: 'd' }),
    call('f', 'Grep', { pattern: 'TODO' }),
  ]
  const done = buildTimeline(rows)
  expect(kinds(done.rows)).toEqual(['prompt', 'work', 'thinking', 'work'])
  const first = done.rows[1] as Extract<TimelineRow, { kind: 'work' }>
  expect(first).toMatchObject({ summary: 'Read 2 files, ran a command', failed: true })
  expect((done.rows[3] as Extract<TimelineRow, { kind: 'work' }>).summary).toBe('Edited a file, searched once')
  // While the session works, its latest calls stay one by one.
  expect(kinds(buildTimeline(rows, { working: true }).rows)).toEqual(['prompt', 'work', 'thinking', 'tool', 'tool', 'tool'])
})

test("a subagent's rows go under the call that started it; one with no call stands alone", () => {
  const t = buildTimeline([
    ev({ kind: 'prompt', text: 'Explore' }),
    call('ag', 'Agent', { description: 'Find callers', prompt: 'Find every caller of login()' }),
    ev({ kind: 'prompt', text: 'Find every caller of login()', agentId: 'sub1' }),
    call('g1', 'Grep', { pattern: 'login(' }, { agentId: 'sub1' }),
    result('g1', 'a.ts\nb.ts', { agentId: 'sub1' }),
    ev({ kind: 'assistant', text: 'Two callers.', agentId: 'sub1' }),
    result('ag', 'Two callers.'),
    // Background work of a teammate whose start isn't in the loaded rows.
    call('x1', 'Bash', { command: 'pwd' }, { agentId: 'sub2' }),
    ev({ kind: 'assistant', text: 'Done.' }),
  ], { agentNames: new Map([['sub2', 'Check the build']]) })
  expect(kinds(t.rows)).toEqual(['prompt', 'tool', 'subagent', 'assistant'])
  const agent = (t.rows[1] as Extract<TimelineRow, { kind: 'tool' }>).tool
  expect(agent.subagent).toMatchObject({ agentId: 'sub1', task: 'Find every caller of login()', count: 1, last: 'Two callers.' })
  expect(kinds(agent.subagent!.rows)).toEqual(['prompt', 'tool', 'assistant'])
  expect((t.rows[2] as Extract<TimelineRow, { kind: 'subagent' }>).run).toMatchObject({ agentId: 'sub2', task: 'Check the build', count: 1 })
  // Subagent prompts aren't turns of the session.
  expect(t.turns.map(x => x.text)).toEqual(['Explore'])
  expect(searchText(t.rows[1]!)).toContain('Two callers.')
})

test('a permission request is shown at the call it asked about', () => {
  const rows = [call('p1', 'Bash', { command: 'rm -rf build' }), call('p2', 'Bash', { command: 'ls' }), result('p2', 'a'), result('p1', 'removed')]
  const ask = (reqId: string, input: string, s: number, state: PermissionRequest['state']): PermissionRequest => ({ reqId, sessionId: 's', tool: 'Bash', input, state, decidedBy: 'luca', requestedAt: at(s) })
  const base = rows[0]!.seq
  const t = buildTimeline(rows, { permissions: [ask('q1', '{"command":"rm -rf build"}', base + 1, 'allowed')] })
  const tools = t.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool)
  expect(tools[0]!.permission).toMatchObject({ reqId: 'q1', state: 'allowed' })
  expect(tools[1]!.permission).toBeNull()
})

test('labels name what a call did', () => {
  expect(toolLabel('Bash', { command: "bash -lc 'git status'" })).toBe('git status')
  expect(toolLabel('Bash', { command: ['/bin/bash', '-lc', 'cat notes.txt'] })).toBe('cat notes.txt')
  expect(toolLabel('Bash', { command: ['git', 'status'] })).toBe('git status')
  expect(toolLabel('Read', { file_path: '/Users/luca/dev/app/src/auth/session.ts' })).toBe('Read …/auth/session.ts')
  expect(toolLabel('Grep', { pattern: 'TODO', path: '/repo/src' })).toBe('Searched TODO in src')
  expect(toolLabel('WebFetch', { url: 'https://docs.example.com/rate-limits' })).toBe('Fetched docs.example.com/rate-limits')
  expect(toolLabel('TodoWrite', { todos: [{}, {}] })).toBe('Updated the to-do list (2)')
  expect(toolLabel('apply_patch', { input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: b.ts\n+x\n*** End Patch' })).toBe('Edited src/a.ts, b.ts')
  expect(toolLabel('mcp__linear__get_issue', { id: 'CS-1' })).toBe('mcp__linear__get_issue')
  expect(patchFiles('*** Delete File: old.ts')).toEqual(['old.ts'])
  // Beside the tool's name, only what it acted on.
  expect(toolTarget('Read', { file_path: '/Users/luca/dev/app/src/auth/session.ts' })).toBe('…/auth/session.ts')
  expect(toolTarget('Bash', { command: 'bun test' })).toBe('bun test')
  expect(toolTarget('Grep', { pattern: 'TODO', path: '/repo/src' })).toBe('TODO in src')
  expect(toolTarget('TodoWrite', { todos: [{}] })).toBe('1 item')
  expect(toolTarget('mcp__linear__get_issue', { id: 'CS-1' })).toBe('')
  expect(toolTarget('Skill', { skill: 'review' })).toBe('review')
  expect(summarize([{ name: 'Read', input: {} }, { name: 'WebFetch', input: {} }, { name: 'Bash', input: {} }, { name: 'Bash', input: {} }])).toBe('Read a file, ran 2 commands, and 1 more')
})

test('prose written beside a call stays, as a reply before it', () => {
  const t = buildTimeline([
    ev({ kind: 'tool-call', text: "I'll check the config first.\nRead {\"file_path\":\"/a.ts\"}", tools: [{ name: 'Read', id: 'p1' }], calls: [{ id: 'p1', name: 'Read', input: { file_path: '/a.ts' } }] }),
    // Older rows too: the call is read from its own line, whichever line it's on.
    ev({ kind: 'tool-call', text: 'Now the tests.\nBash {"command":"bun test"}', tools: [{ name: 'Bash', id: 'p2' }] }),
  ])
  expect(t.rows.map(r => [r.kind, r.kind === 'assistant' ? r.text : r.kind === 'tool' ? r.tool.label : null])).toEqual([
    ['assistant', "I'll check the config first."],
    ['tool', 'Read /a.ts'],
    ['assistant', 'Now the tests.'],
    ['tool', 'bun test'],
  ])
})

test("each call keeps its own error flag and its own capped fields", () => {
  const t = buildTimeline([
    ev({ kind: 'tool-call', text: 'Edit {}\nEdit {}', tools: [{ name: 'Edit', id: 'e1' }, { name: 'Edit', id: 'e2' }], calls: [{ id: 'e1', name: 'Edit', input: { old_string: 'a' } }, { id: 'e2', name: 'Edit', input: { old_string: 'b' } }], capped: [{ path: ['calls', 1, 'input', 'old_string'], bodyId: 'B1', fullLength: 9000 }] }),
    ev({ kind: 'tool-error', text: 'x', toolUseIds: ['e1', 'e2'], results: [{ id: 'e1', isError: false, output: { a: 1 } }, { id: 'e2', isError: true }], capped: [{ path: ['results', 0, 'output', 'a'], bodyId: 'B2', fullLength: 9000 }] }),
  ])
  const [one, two] = t.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool)
  expect([one!.status, two!.status]).toEqual(['done', 'error'])
  expect(one!.capped).toEqual([])
  expect(two!.capped).toEqual([{ path: ['calls', 0, 'input', 'old_string'], bodyId: 'B1', fullLength: 9000 }])
  expect(one!.result!.capped).toEqual([{ path: ['results', 0, 'output', 'a'], bodyId: 'B2', fullLength: 9000 }])
  expect(two!.result!.capped).toEqual([])
})

test('capped fields come back whole: strings, and values stored as JSON', async () => {
  const t = buildTimeline([
    ev({ kind: 'tool-call', text: 'Edit {}', tools: [{ name: 'Edit', id: 'r1' }], calls: [{ id: 'r1', name: 'Edit', input: { file_path: '/a', old_string: 'ab', new_string: 'cd' } }], capped: [{ path: ['calls', 0, 'input', 'old_string'], bodyId: 'OLD', fullLength: 5 }, { path: ['calls', 0, 'input', 'new_string'], bodyId: 'NEW', fullLength: 5 }] }),
    ev({ kind: 'tool-result', text: 'ok', toolUseIds: ['r1'], results: [{ id: 'r1', output: null }], capped: [{ path: ['results', 0, 'output'], bodyId: 'OUT', fullLength: 40, json: true }] }),
  ])
  const tool = (t.rows[0] as Extract<TimelineRow, { kind: 'tool' }>).tool
  const bodies: Record<string, string> = { OLD: 'abcde', NEW: 'cdefg', OUT: JSON.stringify({ structuredPatch: [] }) }
  const full = await restored(tool, async id => bodies[id]!)
  expect(full.input).toMatchObject({ old_string: 'abcde', new_string: 'cdefg' })
  expect(full.result!.output).toEqual({ structuredPatch: [] })
  expect(tool.input.old_string).toBe('ab') // the row itself is untouched
})

test('find opens every fold between a row and its match', () => {
  const t = buildTimeline([
    call('ag', 'Agent', { description: 'Look', prompt: 'Find the callers' }),
    ev({ kind: 'prompt', text: 'Find the callers', agentId: 's1' }),
    call('g', 'Grep', { pattern: 'login' }, { agentId: 's1' }),
    result('g', 'needle.ts', { agentId: 's1' }),
    result('ag', 'done'),
    call('r', 'Read', { file_path: '/x' }),
    result('r', 'a needle in the file'),
    call('b', 'Bash', { command: 'ls' }),
  ])
  // The three calls are one group: it opens, and so do the calls that hold the match, down into
  // the subagent's Grep; the Bash call that doesn't stays shut.
  expect(t.rows.map(r => r.kind)).toEqual(['work'])
  expect(foldsTo(t.rows[0]!, 'needle')).toEqual(['g:ag', 't:ag', 't:g', 'g:content', 'g:answer', 't:r', 'r:content', 'r:answer'])
  expect(foldsTo(t.rows[0]!, 'nothing')).toEqual(['g:ag'])
})

test('a call whose input was stored whole is read from its line until loaded', () => {
  const long = `Edit ${JSON.stringify({ file_path: '/big.ts', old_string: 'x'.repeat(3000) })}`.slice(0, 2000)
  const t = buildTimeline([ev({ kind: 'tool-call', text: long, tools: [{ name: 'Edit', id: 'w1' }], calls: [{ id: 'w1', name: 'Edit', input: null }], capped: [{ path: ['calls', 0, 'input'], bodyId: 'IN', fullLength: 60000, json: true }] })])
  const tool = (t.rows[0] as Extract<TimelineRow, { kind: 'tool' }>).tool
  expect(tool).toMatchObject({ input: { file_path: '/big.ts' }, partial: true, label: 'Edited /big.ts', capped: [{ path: ['calls', 0, 'input'], json: true }] })
})

test("Codex's plain-text inputs are its calls, never replies", () => {
  const patch = '*** Begin Patch\n*** Update File: a.py\n@@\n-x\n+y\n*** End Patch'
  const t = buildTimeline([
    ev({ kind: 'tool-call', origin: 'codex', text: `apply_patch ${patch}`, tools: [{ name: 'apply_patch', id: 'c1' }], calls: [{ id: 'c1', name: 'apply_patch', input: { input: patch } }] }),
    // From a bridge before structured rows: the whole text is the one call.
    ev({ kind: 'tool-call', origin: 'codex', text: `apply_patch ${patch}`, tools: [{ name: 'apply_patch', id: 'c2' }] }),
  ])
  expect(t.rows.map(r => r.kind)).toEqual(['tool', 'tool'])
  // Both keep the patch, so both draw it as a diff.
  for (const r of t.rows) expect((r as Extract<TimelineRow, { kind: 'tool' }>).tool).toMatchObject({ input: { input: patch }, label: 'Edited a.py' })
})

test('what the source cut stays flagged after the capped rest is loaded, and a newer result is not covered', async () => {
  const rows = [
    ev({ kind: 'tool-call', text: 'Bash {}', tools: [{ name: 'Bash', id: 'k1' }], calls: [{ id: 'k1', name: 'Bash', input: { command: 'x'.repeat(10) } }], cut: [{ path: ['calls', 0, 'input', 'command'], fullLength: 200000 }], capped: [{ path: ['calls', 0, 'input', 'command'], bodyId: 'C', fullLength: 100000 }] }),
  ]
  const running = (buildTimeline(rows).rows[0] as Extract<TimelineRow, { kind: 'tool' }>).tool
  const full = await restored(running, async () => 'y'.repeat(100000))
  expect(full).toMatchObject({ partial: true, cut: true, capped: [] })
  expect(full.input.command).toHaveLength(100000)
  // The result arrives after: the restored call shows it (restoring doesn't freeze the call).
  const later = buildTimeline([...rows, result('k1', 'done', { results: [{ id: 'k1', output: { stdout: 'ok' } }] })])
  const done = (later.rows[0] as Extract<TimelineRow, { kind: 'tool' }>).tool
  expect((await restored(done, async () => 'y'.repeat(100000))).result).toMatchObject({ text: 'done', output: { stdout: 'ok' } })
})

test('an older Codex patch cut at 2,000 characters is marked incomplete', () => {
  const long = '*** Begin Patch\n*** Update File: a.py\n@@\n' + '+x\n'.repeat(1000)
  const t = buildTimeline([
    ev({ kind: 'tool-call', origin: 'codex', text: `apply_patch ${long}`.slice(0, 2000 + 'apply_patch '.length), tools: [{ name: 'apply_patch', id: 'l1' }] }),
    ev({ kind: 'tool-call', origin: 'codex', text: 'apply_patch *** Begin Patch\n*** Add File: b.py\n+y\n*** End Patch', tools: [{ name: 'apply_patch', id: 'l2' }] }),
  ])
  expect(t.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool.partial)).toEqual([true, false])
})

test('calls run together show their own results, or say they share one', () => {
  const two = [call('a', 'Read', { file_path: '/a' }), call('b', 'Read', { file_path: '/b' })]
  const own = buildTimeline([...two, ev({ kind: 'tool-result', text: 'A\nB', toolUseIds: ['a', 'b'], results: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] })])
  expect(own.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool.result).map(r => [r!.text, r!.shared])).toEqual([['A', 1], ['B', 1]])
  // From a mod that didn't keep them apart: the shared text, said to be shared.
  const shared = buildTimeline([...two, ev({ kind: 'tool-result', text: 'A\nB', toolUseIds: ['a', 'b'] })])
  expect(shared.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool.result).map(r => [r!.text, r!.shared])).toEqual([['A\nB', 2], ['A\nB', 2]])
  // A call's own text that the source cut: the row's whole text (and its body) instead.
  const cut = buildTimeline([...two, ev({ kind: 'tool-result', text: 'A\nB', bodyId: 'ALL', fullLength: 300000, toolUseIds: ['a', 'b'], results: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], cut: [{ path: ['results', 1, 'text'], fullLength: 200000 }] })])
  expect(cut.rows.map(r => (r as Extract<TimelineRow, { kind: 'tool' }>).tool.result).map(r => [r!.text, r!.shared, r!.bodyId])).toEqual([['A', 1, null], ['A\nB', 2, 'ALL']])
})

test("a reply in progress is drawn last in its agent's rows: the main agent's, or a subagent's under its call", () => {
  const p = (text: string, agentId?: string) => ({ sessionId: 's', ...(agentId && { agentId }), turnId: 't', step: 0, block: 0, text, at: at(99) })
  const t = buildTimeline(
    [
      ev({ kind: 'prompt', text: 'Look around' }),
      call('a1', 'Agent', { description: 'Explore', prompt: 'Find the callers' }),
      ev({ kind: 'prompt', text: 'Find the callers', agentId: 'sub1' }),
      call('s1', 'Grep', { pattern: 'x' }, { agentId: 'sub1' }),
    ],
    { working: true, writing: [p('Found two so far.', 'sub1'), p('Still looking.')] },
  )
  expect(kinds(t.rows)).toEqual(['prompt', 'tool', 'assistant'])
  expect(t.rows[2]).toMatchObject({ text: 'Still looking.', streaming: true })
  const run = (t.rows[1] as Extract<TimelineRow, { kind: 'tool' }>).tool.subagent!
  expect(run.rows.at(-1)).toMatchObject({ kind: 'assistant', text: 'Found two so far.', streaming: true })
  expect(run.last).toBe('Found two so far.')
})
