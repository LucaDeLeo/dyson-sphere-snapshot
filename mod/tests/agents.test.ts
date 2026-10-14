// Running subagents are reported again to a bridge that restarted: its session.started clears the
// session's subagents on the server.
//
//   claude plugin test dyson-sphere/mod
import { expect, test } from 'claude-code/testing'

type Posted = { type: string; data: Record<string, any> }

test('a restarted bridge is told the subagents still running', async ($, on) => {
  const posted: Posted[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('env.get', async () => ({ value: undefined }))
  on('fs.exists', async () => ({ value: false }))
  on('agent.list', async () => ({ value: [{ id: 'bg-1', description: 'Watch CI', type: 'general-purpose', status: 'running' }] }) as never)
  on('clock.every', async () => ({ value: undefined }) as never)
  // The restart's backoff, run at once.
  on('clock.after', async () => ({ value: undefined }) as never)
  on('clock.now', async () => ({ value: 1_000 }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.log', async () => ({ value: undefined }) as never)
  const ready = JSON.stringify({ kind: 'ready', sessionId: 'sess-1', socket: '/tmp/b.sock', secret: 's', protocol: 4 }) + '\n'
  let spawns = 0
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: ready }
    // The first bridge exits soon after it is ready, and the mod starts another.
    if (++spawns === 1) {
      await new Promise(r => setTimeout(r, 50))
      return { value: { code: 1, signal: null } } as never
    }
    await new Promise(() => {})
    return { code: 0 } as never
  } as never)
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/events')) posted.push(...(JSON.parse(e.init?.body ?? '{}').events as Posted[]))
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 200))
  const running = posted.filter(p => p.type === 'session.agent' && p.data.agentId === 'bg-1' && p.data.state === 'running')
  expect(spawns).toBe(2)
  expect(running).toHaveLength(2)
})
