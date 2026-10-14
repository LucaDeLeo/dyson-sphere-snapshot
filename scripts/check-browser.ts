// Browser checks of browser cards, against `bun run demo` on a machine with Playwright's Chromium
// (the demo gives sphere-server a Chrome of its own):
//
//   bun run demo --port 7431            # in one terminal
//   bun run check:browser http://127.0.0.1:7431 [screenshot-dir]
//
// Two people in headless Chromium: luca opens a tab for his session and drives it; jp sees the same
// frames but can't drive it; edit mode keeps every key from the canvas; cards off screen, too small
// or past the page's budget stop streaming; removing the card closes the tab. Prints PASS or FAIL
// per check and exits 1 on any failure. Not run in CI, which has no browser.
import { chromium, type Page } from 'playwright'
import type { SessionSummary } from '../shared/protocol'
import { Client } from '../sphere/src/client'
import { samplePage } from './chrome'

const BASE = process.argv[2] ?? 'http://127.0.0.1:7431'
const SHOTS = process.argv[3] ?? null
const sample = samplePage()
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

async function open(token: string, colorScheme: 'light' | 'dark' = 'light', deviceScaleFactor = 1) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme, deviceScaleFactor })
  const page = await context.newPage()
  page.on('console', m => void (m.type() === 'error' && errors.push(`${token}: ${m.text()}`)))
  page.on('pageerror', e => void errors.push(`${token}: ${e.message}`))
  await page.goto(`${BASE}/?token=${token}`)
  await page.waitForSelector('.tl-card', { timeout: 20000 })
  return page
}

const cli = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-luca' }, 'cli')
await cli.connect()
const { sessions } = await cli.cmd<{ sessions: SessionSummary[] }>('status')
const mine = sessions.find(s => s.owner === 'luca')!
const theirs = sessions.find(s => s.owner === 'jp')!

// luca on a 2× screen, as on a Mac; jp at 1×.
const luca = await open('dev-luca', 'light', 2)
const jp = await open('dev-jp', 'dark')
await luca.waitForTimeout(1000)

type View = { status: string; url: string; hasFrame: boolean; canDrive: boolean; viewport: { w: number; h: number } | null }
const cards = (p: Page) => p.evaluate(() => editor.getCurrentPageShapes().filter((s: { type: string }) => s.type === 'browser').map((s: { id: string }) => s.id) as string[])
const viewOf = (p: Page, id: string) => p.evaluate(id => (window as any).__browsers.get(id)?.view() ?? null, id) as Promise<View | null>
const liveCount = (p: Page) => p.evaluate(() => document.querySelectorAll('.browser-root:not(.inactive)').length)

// Someone else's session offers no browser; luca's does.
check('a session of someone else offers no browser', !(await cli.cmd('browser.open', { sessionId: theirs.id, url: sample.url }).then(() => true, () => false)))
await luca.evaluate(id => void editor.select(`shape:session:${id}`), mine.id)
check('the owner’s session offers one', await within(luca, 2000, async () => (await luca.locator('.session-actions button', { hasText: 'Browser' }).count()) === 1))
await luca.keyboard.press('b')
check('B opens a browser card, made by the server', await within(luca, 5000, async () => (await cards(luca)).length === 1))
const [cardId] = await cards(luca)
check('its id names its type', !!cardId?.startsWith('shape:browser:'))

// luca sends it to a page.
await luca.locator('.browser-address').fill(sample.url)
await luca.locator('.browser-address').press('Enter')
check('the owner navigates it', await within(luca, 8000, async () => (await viewOf(luca, cardId!))?.url === sample.url))
check('frames arrive', await within(luca, 8000, async () => (await viewOf(luca, cardId!))?.hasFrame === true))
check('…drawn in the card', await within(luca, 3000, async () => (await luca.evaluate(id => (document.querySelector(`.browser-root[data-card="${id}"] img`) as HTMLImageElement | null)?.naturalWidth ?? 0, cardId)) > 0))
// Crisp: the tab is laid out at the card's size and luca's ratio, and frames are as wide as the card on his screen.
const drawn = (p: Page) =>
  p.evaluate(id => {
    const root = document.querySelector(`.browser-root[data-card="${id}"]`) as HTMLElement
    const img = root.querySelector('img') as HTMLImageElement
    return { cardW: root.clientWidth, cardH: root.clientHeight, natural: img.naturalWidth, onScreen: img.getBoundingClientRect().width * devicePixelRatio }
  }, cardId)
check('the tab is laid out at the card’s size', await within(luca, 5000, async () => {
  const [v, d] = [await viewOf(luca, cardId!), await drawn(luca)]
  return !!v?.viewport && Math.abs(v.viewport.w - d.cardW) <= 1 && Math.abs(v.viewport.h - d.cardH) <= 1
}), JSON.stringify([(await viewOf(luca, cardId!))?.viewport, await drawn(luca)]))
check('…and its frames have as many pixels as the card on a 2× screen', await within(luca, 5000, async () => {
  const d = await drawn(luca)
  return d.natural >= d.onScreen * 0.75 && d.natural > d.cardW * 1.5
}), JSON.stringify(await drawn(luca)))
check('another person sees it, live', await within(jp, 8000, async () => (await viewOf(jp, cardId!))?.hasFrame === true))
check('…view only', (await viewOf(jp, cardId!))?.canDrive === false && ((await jp.locator('.browser-card .live-hint').textContent()) ?? '').startsWith('View only'))

// Edit mode: keys go to the tab, none to the canvas; the owner's reach the page.
await luca.evaluate(id => void (editor.select(id), editor.setEditingShape(id)), cardId)
await luca.waitForTimeout(300)
const shapes = await luca.evaluate(() => editor.getCurrentPageShapes().length)
for (const key of ['n', 'f', '/', 't', 'b', '?', 'Escape', `${MOD}+k`]) await luca.keyboard.press(key)
check('in edit mode the canvas takes no key', (await luca.evaluate(() => editor.getCurrentPageShapes().length)) === shapes && (await luca.locator('.search-backdrop, .shortcuts').count()) === 0)
check('…and stays in edit mode', (await luca.evaluate(() => editor.getEditingShapeId())) === cardId)
// Tab to the button, press it; Tab to the field, type.
await luca.keyboard.press('Tab')
await luca.keyboard.press('Enter')
check('the owner’s keys reach the page', await within(luca, 5000, async () => (await viewOf(luca, cardId!))?.url.endsWith('#clicked-1') ?? false))
await luca.keyboard.press('Tab')
await luca.keyboard.type('hi there')
check('…typing too', await within(luca, 5000, async () => (await viewOf(luca, cardId!))?.url.endsWith('#typed-hi%20there') ?? false))
// Clicks land where they're aimed, in the page's CSS pixels, at any zoom and ratio.
const clickAt = async (x: number, y: number) => {
  const at = await luca.evaluate(
    ({ id, x, y }) => {
      const v = (window as any).__browsers.get(id).view()
      const img = document.querySelector(`.browser-root[data-card="${id}"] img`) as HTMLImageElement
      const r = img.getBoundingClientRect()
      const fit = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
      const [w, h] = [img.naturalWidth * fit, img.naturalHeight * fit]
      return { x: r.left + (r.width - w) / 2 + (x / v.viewport.w) * w, y: r.top + (r.height - h) / 2 + (y / v.viewport.h) * h }
    },
    { id: cardId, x, y },
  )
  const before = (await viewOf(luca, cardId!))?.url
  await luca.mouse.click(at.x, at.y)
  const landed = await within(luca, 4000, async () => { const url = (await viewOf(luca, cardId!))?.url ?? ''; return url !== before && url.includes('#at-') })
  const m = ((await viewOf(luca, cardId!))?.url ?? '').match(/#at-(\d+)-(\d+)-w(\d+)-r([\d.]+)/)
  return landed && m ? { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), ratio: Number(m[4]) } : null
}
const near = (got: { x: number; y: number } | null, x: number, y: number) => !!got && Math.abs(got.x - x) <= 3 && Math.abs(got.y - y) <= 3
const zoom1 = await clickAt(300, 400)
check('a click lands where it’s aimed, at zoom 1', near(zoom1, 300, 400), JSON.stringify(zoom1))
check('…in a page drawn at luca’s 2× ratio', zoom1?.ratio === 2, JSON.stringify(zoom1))
await luca.evaluate(id => void editor.zoomToBounds(editor.getShapePageBounds(id), { targetZoom: 0.6, inset: 0 }), cardId)
await luca.waitForTimeout(1200)
const zoomed = await clickAt(500, 250)
check('…and at zoom 0.6', near(zoomed, 500, 250), JSON.stringify(zoomed))
check('…the page laid out the same: zooming changes frames, not layout', !!zoom1 && zoomed?.width === zoom1.width, JSON.stringify([zoom1?.width, zoomed?.width]))
await luca.evaluate(id => void editor.zoomToBounds(editor.getShapePageBounds(id), { targetZoom: 1, inset: 0 }), cardId)
await luca.waitForTimeout(800)
await luca.keyboard.press('Control+Escape')
check('Ctrl+Esc leaves edit mode', await within(luca, 1000, async () => (await luca.evaluate(() => editor.getEditingShapeId())) === null))
if (SHOTS) await luca.screenshot({ path: `${SHOTS}/browser-luca.png` })
// A card resized: the tab is laid out again at its new size, once.
await luca.evaluate(id => void editor.updateShape({ id, type: 'browser', props: { w: 800, h: 600 } }), cardId)
check('a resized card lays the tab out at its new size', await within(luca, 5000, async () => (await viewOf(luca, cardId!))?.viewport?.w === 800), JSON.stringify((await viewOf(luca, cardId!))?.viewport))
const beforeJp = (await viewOf(luca, cardId!))?.url

// jp can't drive it.
await jp.evaluate(id => void (editor.select(id), editor.setEditingShape(id)), cardId)
await jp.waitForTimeout(300)
await jp.keyboard.type('nope')
await jp.mouse.click(700, 450)
await jp.waitForTimeout(800)
check('someone else’s input never reaches the tab', (await viewOf(luca, cardId!))?.url === beforeJp)
await jp.keyboard.press('Control+Escape')
if (SHOTS) await jp.screenshot({ path: `${SHOTS}/browser-jp-dark.png` })

// Off screen it stops; back, it streams again, the same element throughout.
await luca.evaluate(id => ((document.querySelector(`.browser-root[data-card="${id}"]`) as any).__mark = 'same'), cardId)
await luca.evaluate(() => void editor.selectNone())
await luca.evaluate(() => void editor.setCamera({ x: -60000, y: -60000, z: 1 }))
check('off screen, it stops streaming', await within(luca, 2000, async () => (await liveCount(luca)) === 0))
await luca.evaluate(id => void editor.zoomToBounds(editor.getShapePageBounds(id)), cardId)
check('back on screen, it streams again', await within(luca, 2000, async () => (await liveCount(luca)) === 1))
check('…the same element, never reloaded', await luca.evaluate(id => (document.querySelector(`.browser-root[data-card="${id}"]`) as any)?.__mark === 'same', cardId))

// A budget of live cards: four more tabs, all in view; four stream, the fifth shows its last frame.
for (let i = 0; i < 4; i++) {
  await luca.evaluate(id => void editor.select(`shape:session:${id}`), mine.id)
  await luca.keyboard.press('b')
  await within(luca, 5000, async () => (await cards(luca)).length === i + 2)
}
await luca.waitForTimeout(1000) // the last card's own zoom into view
await luca.evaluate(() => {
  editor.select(...editor.getCurrentPageShapes().filter((s: { type: string }) => s.type === 'browser').map((s: { id: string }) => s.id))
  const b = editor.getSelectionPageBounds()
  editor.selectNone()
  editor.zoomToBounds(b, { inset: 0, force: true })
})
await luca.waitForTimeout(800)
const live = await liveCount(luca)
const layout = await luca.evaluate(() => {
  const v = editor.getViewportPageBounds()
  const z = editor.getZoomLevel()
  return `zoom ${z.toFixed(2)}; ` + editor.getCurrentPageShapes().filter((s: { type: string }) => s.type === 'browser').map((s: { id: string }) => {
    const b = editor.getShapePageBounds(s.id)
    return `${Math.round(b.w * z)}px${v.collides(b) ? '' : ' off'}`
  }).join(', ')
})
check('a page streams at most four browser cards', live === 4, `${live} live of ${(await cards(luca)).length}: ${layout}`)
if (SHOTS) await luca.screenshot({ path: `${SHOTS}/browser-budget.png` })

// Removed, a card closes its tab, for everyone.
const all = await cards(luca)
await jp.evaluate(ids => void editor.deleteShapes(ids), all)
check('removed, the cards close on every page', await within(luca, 4000, async () => (await luca.evaluate(() => (window as any).__browsers.size)) === 0 && (await jp.evaluate(() => (window as any).__browsers.size)) === 0))
await luca.waitForTimeout(500)
const opened = await cli.cmd<{ sessions: SessionSummary[] }>('status')
check('the server still answers', opened.sessions.length > 0)

cli.close()
await browser.close()
sample.stop()
for (const r of results) console.log(r)
if (errors.length) console.log(`\nPage errors:\n${errors.join('\n')}`)
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

// The page's tldraw editor, which the canvas puts on window for checks like these.
declare const editor: any
