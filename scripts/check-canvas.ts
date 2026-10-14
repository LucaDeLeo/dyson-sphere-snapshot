// Browser checks of the canvas, against a running server with the demo's sessions:
//
//   bun run demo --port 7431            # in one terminal
//   bunx playwright install chromium    # once
//   bun run check:canvas http://127.0.0.1:7431 [screenshot-dir]
//
// Two people on the canvas in headless Chromium, and what older clients send and read: a `/ws`
// client standing in for a tab still on the removed React Flow canvas (its cursor, `layout.set`,
// the `canvas` command). Prints PASS or FAIL per check and exits 1 on any failure. Not run in CI,
// which has no browser.
import { chromium, type Page } from 'playwright'
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

async function open(token: string, query = '', remembered?: string) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  // A browser that chose the React Flow canvas before it was removed.
  if (remembered) await context.addInitScript(v => localStorage.setItem('sphere-canvas', v), remembered)
  const page = await context.newPage()
  page.on('console', m => void (m.type() === 'error' && errors.push(`${token}${query && ` ${query}`}: ${m.text()}`)))
  page.on('pageerror', e => void errors.push(`${token}${query && ` ${query}`}: ${e.message}`))
  await page.goto(`${BASE}/?${query}${query && '&'}token=${token}`)
  await page.waitForSelector('.tl-card', { timeout: 20000 })
  return page
}

const luca = await open('dev-luca')
const jp = await open('dev-jp')
await luca.waitForTimeout(1500)

// The removed React Flow canvas's address, and a browser that remembered choosing it, get the
// canvas, and the remembered choice is cleared.
for (const [name, query, remembered] of [
  ['?canvas=classic opens the canvas', 'canvas=classic', undefined],
  ['a remembered classic choice opens the canvas', '', 'classic'],
] as const) {
  const page = await open('dev-luca', query, remembered).catch(() => null)
  check(name, !!page && (await page.locator('.tl-card .card').count()) > 0)
  if (page) check(`${name}, and forgets the choice`, (await page.evaluate(() => localStorage.getItem('sphere-canvas'))) === null)
  await page?.context().close()
}

// An older client on /ws: to the server, the same as a tab still on the React Flow canvas.
const old = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-jp' }, 'web')
await old.connect()
type Item = { id: string; x: number; y: number; parent: string | null }
const layoutOf = async (id: string) => (await old.cmd<{ layout: Item[] }>('canvas')).layout.find(i => i.id === id)

// What the canvas shows.
const cards = await luca.locator('.tl-card .card').count()
check('cards are drawn', cards >= 9, `${cards} cards`)
const sections = await luca.evaluate(() => editor.getCurrentPageShapes().filter(s => s.type === 'section' && !editor.isShapeHidden(s)).length)
check('sections are drawn', sections >= 5, `${sections}`)
check('the minimap draws the canvas', await within(luca, 1000, async () => (await luca.locator('.tl-minimap-svg rect').count()) > cards))

// A drag reaches the other tldraw page, gliding there, and the React Flow page.
const target = await luca.evaluate(() => {
  // The card nearest the top of the view: dragged down, it stays on screen.
  const s = editor
    .getCurrentPageShapes()
    .filter(s => s.type === 'session' && !editor.isShapeHidden(s))
    .sort((a, b) => editor.getShapePageBounds(a)!.y - editor.getShapePageBounds(b)!.y)[0]!
  const b = editor.getShapePageBounds(s)!
  const p = editor.pageToViewport({ x: b.x + 40, y: b.y + 14 })
  return { id: s.id, sessionId: (s.props as { sessionId: string }).sessionId, y: s.y, sx: p.x, sy: p.y }
})
await luca.mouse.move(target.sx, target.sy)
await luca.mouse.down()
await luca.mouse.move(target.sx, target.sy + 120, { steps: 12 })
await luca.mouse.up()
const glided = await within(jp, 1500, () => jp.evaluate(id => !!document.querySelector(`.tl-shape.glide[data-shape-id="${id}"]`), target.id))
check("someone else's drag glides", glided)
await luca.waitForTimeout(800)
const inJp = await jp.evaluate(id => editor.getShape(id as never)!.y, target.id)
check('a drag reaches the other page', inJp !== target.y, `y ${target.y} -> ${Math.round(inJp)}`)
const logged = await layoutOf(target.sessionId)
check('a drag reaches the log (the `canvas` command)', logged?.y === Math.round(inJp), JSON.stringify(logged))

// An older client's `layout.set` moves the card on the canvas.
if (logged) {
  const to = logged.y + 40
  await old.cmd('layout.set', { items: [{ id: target.sessionId, kind: 'session', x: logged.x, y: to, parent: logged.parent }] })
  const moved = await within(jp, 2000, () => jp.evaluate(([id, y]) => Math.round(editor.getShape(id as never)!.y) === y, [target.id, to] as const))
  check("an older client's layout.set moves the card", moved)
}

// Selecting a card opens the inspector. Where the card is now, on screen: the drag moved it.
const at = await luca.evaluate(id => {
  const b = editor.getShapePageBounds(editor.getShape(id as never)!)!
  return editor.pageToViewport({ x: b.x + 40, y: b.y + 14 })
}, target.id)
await luca.evaluate(() => void editor.selectNone())
await luca.waitForTimeout(600) // past tldraw's double-click window
await luca.mouse.click(at.x, at.y)
check('selecting a card opens the inspector', await within(luca, 1500, async () => (await luca.locator('.inspector').count()) === 1))

// Escape closes it, and the same card opens it again.
await luca.keyboard.press('Escape')
check('Escape closes the inspector', await within(luca, 1000, async () => (await luca.locator('.inspector').count()) === 0))
await luca.waitForTimeout(600) // past tldraw's double-click window, as a person would be
await luca.mouse.click(at.x, at.y)
check('the same card opens it again', await within(luca, 1500, async () => (await luca.locator('.inspector').count()) === 1))

// A suggestion flies to its card.
const cli = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-jp' }, 'cli')
await cli.connect()
await cli.cmd('suggest', { sessionId: target.sessionId, text: 'a suggestion from the canvas check' })
check('a suggestion flies to its card', await within(luca, 1500, async () => (await luca.locator('.flight').count()) > 0))
cli.close()
await luca.keyboard.press('Escape')

// A `/ws` cursor without `canvas: 'tldraw'` (a tab still on the React Flow canvas) is drawn; the
// other page's `/ws` cursor isn't, since tldraw draws it from the room.
;(old as unknown as { raw(m: unknown): void }).raw({ t: 'presence', cursor: { x: 600, y: 500 }, viewport: null, selected: null, following: null })
check("an older page's cursor shows", await within(luca, 2000, async () => (await luca.locator('.cursor .label', { hasText: 'jp' }).count()) === 1))
await jp.mouse.move(700, 400, { steps: 4 })
await luca.waitForTimeout(500)
check("a page's own /ws cursor isn't drawn twice", (await luca.locator('.cursor .label', { hasText: 'jp' }).count()) === 1)
old.close()

// N makes a note; the other page and the log both get it.
// Nothing selected, the canvas focused: a click on empty canvas, without hunting for a free spot.
const clear = () => luca.evaluate(() => void (editor.selectNone(), (editor.getContainer() as HTMLElement).focus()))
await clear()
await luca.keyboard.press('n')
await luca.waitForTimeout(300)
// The note this run made: the one being edited. Only it is deleted at the end.
const made = await luca.evaluate(() => editor.getEditingShapeId())
await luca.keyboard.type('hello from tldraw')
await luca.keyboard.press('Escape')
const noteIn = (p: Page) => p.evaluate(() => editor.getCurrentPageShapes().some(s => s.type === 'note' && JSON.stringify(s.props).includes('hello from tldraw')))
// The check's own note goes at the end, so runs don't pile notes up in the demo.
const dropNote = () => luca.evaluate(id => void (id && editor.deleteShapes([id as never])), made)
check('a note reaches the other page', await within(jp, 3000, () => noteIn(jp)))
const reader = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-bot' }, 'cli')
await reader.connect()
const noteLogged = () => reader.cmd<{ notes: { text: string }[] }>('canvas').then(c => c.notes.some(n => n.text.includes('hello from tldraw')))
check('a note reaches the log (the `canvas` command)', await within(luca, 3000, noteLogged))
reader.close()

// Keys: ours, not tldraw's.
await clear()
await luca.keyboard.press('r')
check('R does not switch to a drawing tool', (await luca.evaluate(() => editor.getCurrentToolId())) === 'select')
await luca.keyboard.press('/')
check('/ opens find', await within(luca, 1000, async () => (await luca.locator('.search').count()) === 1))
await luca.keyboard.press('Escape')
await luca.keyboard.press('f')
check('F follows the other person', await within(luca, 1000, () => luca.evaluate(() => !!editor.getInstanceState().followingUserId)))
await luca.keyboard.press('Escape')
check('each page sees the other person', (await jp.evaluate(() => editor.getCollaborators().map(c => c.userName))).includes('luca'))

if (SHOTS) {
  await jp.evaluate(() => void editor.zoomToFit())
  await jp.waitForTimeout(500)
  await jp.screenshot({ path: `${SHOTS}/tldraw.png` })
}
await dropNote()
await luca.waitForTimeout(500)
check('no errors in the console', errors.length === 0, errors.join(' | '))
console.log(results.join('\n'))
await browser.close()
process.exit(failed ? 1 : 0)

// The page's tldraw editor, which the tldraw canvas puts on window for checks like these.
type Shape = { id: string; type: string; x: number; y: number; props: unknown }
type Pt = { x: number; y: number }
declare const editor: {
  getCurrentPageShapes(): Shape[]
  isShapeHidden(s: Shape): boolean
  getShapePageBounds(s: Shape): (Pt & { w: number; h: number }) | undefined
  getShape(id: never): Shape | undefined
  pageToViewport(p: Pt): Pt
  getCurrentToolId(): string
  getInstanceState(): { followingUserId: string | null }
  getCollaborators(): { userName: string }[]
  zoomToFit(): unknown
  selectNone(): unknown
  getContainer(): unknown
  deleteShapes(ids: never[]): unknown
  getEditingShapeId(): string | null
}
