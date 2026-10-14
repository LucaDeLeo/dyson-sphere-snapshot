// Frame times while the canvas pans and zooms, with many session cards: CS-2554's "2,000 session
// cards pan and zoom at 120 fps". Seeds the sessions into a server through a bridge (use a server
// with its own scratch database, not the demo's or a real one), then drives the canvas in Chromium:
//
//   createdb sphere_bench
//   DATABASE_URL=postgres://localhost/sphere_bench SPHERE_PORT=7432 SPHERE_BUNDLE_ENV=production bun run server
//   bun run scripts/bench-canvas.ts http://127.0.0.1:7432 --sessions 2000 [--headed]
//
// Frame times come from requestAnimationFrame, so they can't beat the display's refresh rate:
// run it headed on a 120 Hz screen for the ticket's number. Headless, Chromium paces frames itself.
import { chromium, type Page } from 'playwright'
import { Client } from '../sphere/src/client'

const args = process.argv.slice(2)
const BASE = args.find(a => a.startsWith('http')) ?? 'http://127.0.0.1:7432'
const sessionsAt = args.indexOf('--sessions')
const N = sessionsAt === -1 ? 2000 : Number(args[sessionsAt + 1])
if (!Number.isSafeInteger(N) || N <= 0) throw new Error('--sessions takes a positive whole number')
const PER_REPO = 20

// ---------- seed ----------

const bridge = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-luca' }, 'bridge')
await bridge.connect()
const existing = (await bridge.cmd<{ sessions: unknown[] }>('status', {})).sessions.length
console.log(`${existing} sessions on the server; seeding ${Math.max(0, N - existing)} more`)
for (let i = existing; i < N; i += 100) {
  const events = []
  for (let k = i; k < Math.min(N, i + 100); k++) {
    const sessionId = crypto.randomUUID()
    const repo = `repo-${String(Math.floor(k / PER_REPO)).padStart(3, '0')}`
    events.push({ key: crypto.randomUUID(), type: 'session.started', holder: 'bench:1', data: { sessionId, machine: 'bench', cwd: `/w/${repo}`, repo, branch: 'main', pid: 1, interactive: true } })
    events.push({ key: crypto.randomUUID(), type: 'session.row', holder: 'bench:1', data: { sessionId, kind: 'prompt', text: `Task ${k}: make the thing work`, summary: `Task ${k}: make the thing work` } })
  }
  await bridge.cmd('ingest', { events })
}

// ---------- measure ----------

type Result = { phase: string; frames: number; p50: number; p95: number; max: number; dropped: string }

/** Runs `step(t)` every frame for `ms`, and reports the frame intervals. */
async function measure(page: Page, phase: string, ms: number, step: string): Promise<Result> {
  const deltas = await page.evaluate(
    ({ ms, step }) =>
      new Promise<number[]>(resolve => {
        const fn = new Function('t', step) as (t: number) => void
        const out: number[] = []
        const start = performance.now()
        let last = start
        const frame = (now: number) => {
          out.push(now - last)
          last = now
          fn((now - start) / ms)
          if (now - start < ms) requestAnimationFrame(frame)
          else resolve(out.slice(1))
        }
        requestAnimationFrame(frame)
      }),
    { ms, step },
  )
  const sorted = [...deltas].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
  const vsync = q(0.1) // the display's frame, as the fastest frames show it
  const dropped = 1 - deltas.length / (ms / vsync)
  return { phase, frames: deltas.length, p50: q(0.5), p95: q(0.95), max: sorted.at(-1)!, dropped: `${Math.max(0, Math.round(dropped * 100))}%` }
}

const browser = await chromium.launch({ headless: !args.includes('--headed') })
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
await page.goto(`${BASE}/?token=dev-luca`)
const t0 = Date.now()
try {
  // Every card on the page, then a moment for it to settle.
  await page.waitForFunction(n => document.querySelectorAll('.tl-card').length >= n, N, { timeout: 300_000, polling: 1000 })
} catch {
  console.log("the cards didn't all mount within 5 minutes")
  await browser.close()
  process.exit(1)
}
console.log(`all cards on the page ${((Date.now() - t0) / 1000).toFixed(1)} s after it loaded`)
await page.waitForTimeout(3000)
const cards = await page.locator('.tl-card').count()
// The camera: page position (x, y) at zoom z, each a function of t (0 to 1).
const set = (x: string, y: string, z: string) => `const z = ${z}; editor.setCamera({ x: ${x}, y: ${y}, z })`
for (const r of [
  await measure(page, 'pan at zoom 1', 4000, set('-t * 6000', '-t * 1500', '1')),
  await measure(page, 'zoom 1 → 0.05 → 1', 6000, set('0', '0', 't < 0.5 ? 1 - t * 1.9 : 0.05 + (t - 0.5) * 1.9')),
  await measure(page, 'pan zoomed out (0.1)', 4000, set('-t * 20000', '-t * 4000', '0.1')),
])
  console.log(
    `${String(cards).padStart(5)} cards  ${r.phase.padEnd(22)} frames ${String(r.frames).padStart(4)}  p50 ${r.p50.toFixed(1)} ms  p95 ${r.p95.toFixed(1)} ms  max ${r.max.toFixed(1)} ms  dropped ${r.dropped}`,
  )
await browser.close()
process.exit(0)
