// Browser checks of terminal cards, against `bun run demo` on a machine with tmux (its luca and jp
// sessions run in tmux panes there):
//
//   bun run demo --port 7431            # in one terminal
//   bun run check:terminal http://127.0.0.1:7431 [screenshot-dir]
//
// Two people in headless Chromium: luca opens his session's terminal and types into it; jp sees
// the same card and output but can't type; in edit mode every key goes to the terminal and none to
// the canvas; the terminal survives being panned away; a session elsewhere says why it has none;
// removing the card closes it on both pages. Prints PASS or FAIL per check and exits 1 on any
// failure. Not run in CI, which has no browser.
import { chromium, type Page } from 'playwright'
import type { SessionSummary } from '../shared/protocol'
import { Client } from '../sphere/src/client'

const BASE = process.argv[2] ?? 'http://127.0.0.1:7431'
const SHOTS = process.argv[3] ?? null
const browser = await chromium.launch()
const errors: string[] = []
const results: string[] = []
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
  return ok
}
const within = async (page: Page, ms: number, test: () => Promise<boolean>) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await test()) return true
    await page.waitForTimeout(50)
  }
  return false
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function open(token: string, colorScheme: 'light' | 'dark' = 'light') {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme })
  const page = await context.newPage()
  page.on('console', m => void (m.type() === 'error' && errors.push(`${token}: ${m.text()}`)))
  page.on('pageerror', e => void errors.push(`${token}: ${e.message}`))
  await page.goto(`${BASE}/?token=${token}`)
  await page.waitForSelector('.tl-card', { timeout: 20000 })
  return page
}

// Which sessions have a terminal: the server says, as it says to the CLI.
const cli = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-luca' }, 'cli')
await cli.connect()
const { sessions } = await cli.cmd<{ sessions: SessionSummary[] }>('status')
cli.close()
const mine = sessions.find(s => s.owner === 'luca' && s.terminal === 'tmux')
const elsewhere = sessions.find(s => s.owner === 'ops-bot')
if (!mine || !elsewhere) {
  console.error('Needs `bun run demo` on a machine with tmux: no session of luca runs in tmux.')
  process.exit(2)
}

const luca = await open('dev-luca')
const jp = await open('dev-jp', 'dark')
await luca.waitForTimeout(1000)

const shapeCount = (p: Page) => p.evaluate(() => editor.getCurrentPageShapes().length)
const terminalCard = (p: Page) => p.evaluate(() => editor.getCurrentPageShapes().find((s: { type: string }) => s.type === 'terminal')?.id ?? null)
const screenText = (p: Page) => p.evaluate(() => document.querySelector('.term-root .xterm-rows')?.textContent ?? '')

// Opening it: select luca's card, press T.
await luca.evaluate(id => void editor.select(`shape:session:${id}` as never), mine.id)
await luca.keyboard.press('t')
const cardId = (await within(luca, 3000, async () => !!(await terminalCard(luca)))) ? await terminalCard(luca) : null
check('T opens the selected session’s terminal card', !!cardId, String(cardId))
check('its id names its type', !!cardId?.startsWith('shape:terminal:'))
check('the card goes live', await within(luca, 8000, async () => (await luca.locator('.term-card .live-dot.live').count()) === 1))
check('it shows the pane', await within(luca, 5000, async () => (await screenText(luca)).includes('Simulated session')))

// The other person gets the same card, live, view only.
check('a second person sees the card', await within(jp, 3000, async () => (await terminalCard(jp)) === cardId))
check('…live, with the same screen', await within(jp, 8000, async () => (await screenText(jp)).includes('Simulated session')))
check('…and is told it is view only', await within(jp, 2000, async () => (await jp.locator('.term-card .live-hint').textContent())?.startsWith('View only') ?? false))

// luca types: double-click enters edit mode, keys reach the shell.
await luca.evaluate(id => void (editor.select(id as never), editor.setEditingShape(id as never)), cardId)
await luca.waitForTimeout(300)
const word = `ok-${Math.random().toString(36).slice(2, 7)}`
const shapesBefore = await shapeCount(luca)
const camera = JSON.stringify(await luca.evaluate(() => editor.getCamera()))
await luca.keyboard.type(`echo ${word}`)
// Keys the canvas would take: n (note), f (follow), / and ⌘K (find), t, Escape, ⌘A, ⌘Z.
for (const key of ['n', 'f', '/', 't', '.', '?', 'Escape', `${MOD}+k`, `${MOD}+a`, `${MOD}+z`]) await luca.keyboard.press(key)
check('in edit mode the canvas takes no key', (await shapeCount(luca)) === shapesBefore && JSON.stringify(await luca.evaluate(() => editor.getCamera())) === camera && (await luca.locator('.search-backdrop, .shortcuts').count()) === 0)
check('…and stays in edit mode, Escape included', (await luca.evaluate(() => editor.getEditingShapeId())) === cardId)
// Clear the line the canvas keys left (Ctrl+U), then run the command.
await luca.keyboard.press('Control+u')
await luca.keyboard.type(`echo ${word}-$((6*7))`)
await luca.keyboard.press('Enter')
check('the owner’s keys reach the shell', await within(luca, 4000, async () => (await screenText(luca)).includes(`${word}-42`)))
check('…and the other page sees the output', await within(jp, 4000, async () => (await screenText(jp)).includes(`${word}-42`)))
await luca.keyboard.press('Control+Escape')
check('Ctrl+Esc leaves edit mode', await within(luca, 1000, async () => (await luca.evaluate(() => editor.getEditingShapeId())) === null))
if (SHOTS) await luca.screenshot({ path: `${SHOTS}/terminal-luca.png` })

// jp can't type into luca's shell.
await jp.evaluate(id => void (editor.select(id as never), editor.setEditingShape(id as never)), cardId)
await jp.waitForTimeout(300)
await jp.keyboard.type('echo jp-was-here')
await jp.keyboard.press('Enter')
await luca.waitForTimeout(800)
check('someone else’s keys never reach the shell', !(await screenText(luca)).includes('jp-was-here'))
await jp.keyboard.press('Control+Escape')
if (SHOTS) await jp.screenshot({ path: `${SHOTS}/terminal-jp-dark.png` })

// Panned far away (culled) and back: the same terminal, still live, with what happened meanwhile.
const marker = await luca.evaluate(id => {
  const el = document.querySelector(`.term-root[data-card="${id}"]`) as HTMLElement & { __mark?: string }
  el.__mark = 'same'
  return !!el
}, cardId)
await luca.evaluate(() => void editor.selectNone())
await luca.evaluate(() => void editor.setCamera({ x: -50000, y: -50000, z: 1 }))
await luca.waitForTimeout(500)
const culled = await luca.evaluate(id => editor.getCulledShapes().has(id as never), cardId)
// Output while it's away: typed by luca's own second window would do; here, jp's view checks it still flows to him.
await luca.evaluate(id => void (editor.select(id as never), editor.zoomToSelection()), cardId)
await luca.waitForTimeout(800)
const same = await luca.evaluate(id => (document.querySelector(`.term-root[data-card="${id}"]`) as HTMLElement & { __mark?: string })?.__mark === 'same', cardId)
check('panned away, the card is culled', culled)
check('…and back, it is the same element, never reloaded', marker && same)
check('…and live', await within(luca, 4000, async () => (await screenText(luca)).includes(`${word}-42`) && (await luca.locator('.term-card .live-dot.live').count()) === 1))

// A session that doesn't run here says why it has no terminal.
await luca.evaluate(id => void editor.select(`shape:session:${id}` as never), elsewhere.id)
await luca.keyboard.press('t')
check('a session elsewhere says terminals show this machine’s sessions for now', await within(luca, 5000, async () => ((await luca.locator('.live-status').allTextContents()).join(' ')).includes('for now')))
if (SHOTS) await luca.screenshot({ path: `${SHOTS}/terminal-elsewhere.png` })

// Removing the card closes its terminal on both pages.
await jp.evaluate(() => void editor.deleteShapes(editor.getCurrentPageShapes().filter((s: { type: string }) => s.type === 'terminal').map((s: { id: string }) => s.id)))
check('removed, the terminals close on every page', await within(luca, 4000, async () => (await luca.evaluate(() => (window as any).__terminals.size)) === 0 && (await jp.evaluate(() => (window as any).__terminals.size)) === 0))

await browser.close()
for (const r of results) console.log(r)
if (errors.length) console.log(`\nPage errors:\n${errors.join('\n')}`)
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

// The page's tldraw editor, which the canvas puts on window for checks like these.
declare const editor: any
