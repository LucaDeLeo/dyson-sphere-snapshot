// Browser cards end to end, with a stand-in for the server's Chrome (fake-chrome.ts): who may open,
// watch and drive a tab, what reaches Chrome, the screencast's start, stop, size and rate, and the
// cards in the room. Against a scratch Postgres database:
//
//   DATABASE_URL=postgres://localhost/sphere_test bun test
//
// The database is emptied first, so never point this at a real one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createShapePropsMigrationSequence, createTLSchema, defaultBindingSchemas, defaultShapeSchemas, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { decodeFrame, viewportOf, webUrl, type BrowserToViewer } from '../shared/browser'
import { debugAddress } from '../server/src/browser'
import { canvasSchema, CANVAS_PAGE, liveShapeId, sectionProps, sessionProps, terminalProps } from '../shared/canvas'
import { connect } from '../server/src/pg'
import { Client } from '../sphere/src/client'
import { fakeChrome } from './fake-chrome'
import { DATABASE_URL, openPage, sphereServer, startSession, until, type Page } from './pages'

const PORT = 7466

/** A page's browser card's socket. */
async function card(http: string, targetId: string, token: string) {
  const got: BrowserToViewer[] = []
  const frames: ArrayBuffer[] = []
  const ws = new WebSocket(`${http.replace('http', 'ws')}/browser?tab=${targetId}&token=${token}`)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = ev => void (ev.data instanceof ArrayBuffer ? frames.push(ev.data) : got.push(JSON.parse(String(ev.data))))
  const closed = new Promise<number>(resolve => (ws.onclose = ev => resolve(ev.code)))
  await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('refused')))))
  return { ws, got, frames, closed, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}

/** The schema of a page from terminal cards but before browser cards. */
const terminalEraSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    session: { props: sessionProps, migrations: createShapePropsMigrationSequence({ sequence: [] }) },
    section: { props: sectionProps, migrations: createShapePropsMigrationSequence({ sequence: [] }) },
    terminal: { props: terminalProps, migrations: createShapePropsMigrationSequence({ sequence: [] }) },
  },
  bindings: defaultBindingSchemas,
}) as unknown as typeof canvasSchema

test("the debugging port, under any of this machine's names", () => {
  for (const url of ['http://localhost:9222/json', 'http://localhost.:9222/', 'http://127.1:9222/', 'http://[::ffff:127.0.0.1]:9222/', 'http://[::]:9222/', 'https://box.tailnet.ts.net:9222/'])
    expect(debugAddress(url, 9222)).toBe(true)
  for (const url of ['http://localhost:3000/', 'https://example.com/', 'http://127.0.0.1/']) expect(debugAddress(url, 9222)).toBe(false)
})

test("which card a tab is laid out for: the owner's, else the biggest; none from older pages", () => {
  expect(viewportOf([{ canDrive: false }, { canDrive: true, css: null }])).toBeNull()
  expect(viewportOf([{ canDrive: false, css: { w: 1600, h: 900 }, dpr: 1 }, { canDrive: true, css: { w: 800, h: 600 }, dpr: 2 }])).toEqual({ width: 800, height: 600, deviceScaleFactor: 2 })
  expect(viewportOf([{ canDrive: false, css: { w: 600, h: 400 }, dpr: 1 }, { canDrive: false, css: { w: 1600, h: 900 }, dpr: 3 }])).toEqual({ width: 1600, height: 900, deviceScaleFactor: 2 })
  // Within limits, and ratios to the half.
  expect(viewportOf([{ canDrive: true, css: { w: 9000, h: 50 }, dpr: 1.1 }])).toEqual({ width: 2560, height: 200, deviceScaleFactor: 1.5 })
})

test('only http and https addresses', () => {
  expect(webUrl('example.com/x')).toBe('http://example.com/x')
  expect(webUrl('localhost:3000')).toBe('http://localhost:3000/')
  expect(webUrl('https://a.b/')).toBe('https://a.b/')
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x', '', 42]) expect(webUrl(bad)).toBeNull()
})

describe('sphere-server browser cards', () => {
  const chrome = fakeChrome()
  const server = sphereServer(PORT, { SPHERE_BROWSER_PROFILE: chrome.profile, SPHERE_TERMINAL_GRACE_MS: '200' })
  const sql = connect(DATABASE_URL)
  const closers: (() => void)[] = []
  let sessionId = ''
  let luca: Client
  let jp: Client
  const pages: Page[] = []
  const page = async (token = 'dev-luca', schema = canvasSchema) => {
    const p = await openPage(PORT, token, schema)
    pages.push(p)
    return p
  }

  beforeAll(async () => {
    await sql`drop table if exists events, bodies, canvas_rooms`
    await server.start()
    const s = await startSession(server.url)
    sessionId = s.id
    closers.push(() => s.client.close())
    luca = new Client({ url: server.url, token: 'dev-luca' }, 'cli')
    jp = new Client({ url: server.url, token: 'dev-jp' }, 'cli')
    await luca.connect()
    await jp.connect()
  })
  afterAll(async () => {
    closers.forEach(c => c())
    pages.forEach(p => p.close())
    luca.close()
    jp.close()
    await server.stop()
    await sql.close()
    chrome.stop()
  })

  test("the session's owner opens a tab, and the server makes its card", async () => {
    const watching = await page('dev-jp')
    await expect(jp.cmd('browser.open', { sessionId, url: 'https://example.com' })).rejects.toThrow(/only luca can open a browser/)
    await expect(luca.cmd('browser.open', { sessionId, url: 'file:///etc/passwd' })).rejects.toThrow(/only http and https/)
    const { shapeId, targetId } = await luca.cmd<{ shapeId: string; targetId: string }>('browser.open', { sessionId, url: 'https://example.com', x: 100, y: 200 })
    expect(shapeId.startsWith('shape:browser:')).toBe(true)
    expect(chrome.tabs.get(targetId)?.url).toBe('https://example.com/')
    await until(() => !!watching.shape(shapeId))
    expect(watching.shape(shapeId)).toMatchObject({ type: 'browser', x: 100, y: 200, parentId: CANVAS_PAGE, props: { sessionId, targetId }, meta: { author: 'luca' } })
  })

  test("pages can't make a browser card, or point one at another tab", async () => {
    const p = await page()
    const { shapeId } = await luca.cmd<{ shapeId: string }>('browser.open', { sessionId })
    await until(() => !!p.shape(shapeId))
    // Made by a page, with a tab of its choosing: refused.
    const forged = { ...(p.shape(shapeId) as TLShape), id: liveShapeId('browser'), props: { w: 800, h: 600, sessionId, targetId: 'A'.repeat(32) } } as TLRecord
    p.store.put([forged])
    await until(() => !p.shape(forged.id))
    // Pointed at another tab: put back.
    const mine = p.shape(shapeId)!
    p.store.put([{ ...mine, props: { ...(mine.props as object), targetId: 'B'.repeat(32) } } as TLRecord])
    await until(() => (p.shape(shapeId)!.props as { targetId: string }).targetId !== 'B'.repeat(32))
    // Moved and resized: fine.
    p.store.put([{ ...p.shape(shapeId)!, x: 900, props: { ...(p.shape(shapeId)!.props as object), w: 640 } } as TLRecord])
    await Bun.sleep(300)
    expect(p.shape(shapeId)).toMatchObject({ x: 900, props: { w: 640 } })
  })

  test('refuses other sites, unknown tokens, and tabs it never opened', async () => {
    expect((await fetch(`${server.http}/browser?tab=${'A'.repeat(32)}&token=nope`)).status).toBe(401)
    expect((await fetch(`${server.http}/browser?tab=${'A'.repeat(32)}&token=dev-luca`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${server.http}/browser?tab=nope&token=dev-luca`)).status).toBe(400)
    // A tab of the server's Chrome that Dyson Sphere didn't open (an agent's, say): not shown.
    const other = await (await fetch(`http://127.0.0.1:${(await Bun.file(`${chrome.profile}/DevToolsActivePort`).text()).split('\n')[0]}/json/new?about:blank`, { method: 'PUT' })).json()
    const c = await card(server.http, other.id, 'dev-luca')
    expect(await c.closed).toBe(4004)
    expect(c.got).toEqual([{ t: 'status', status: 'unavailable', reason: "This tab isn't one Dyson Sphere opened." }])
  })

  test('the owner drives the tab; anyone else watches; frames only while wanted, sized and capped', async () => {
    const { targetId } = await luca.cmd<{ targetId: string }>('browser.open', { sessionId, url: 'https://example.com' })
    const mine = await card(server.http, targetId, 'dev-luca')
    const theirs = await card(server.http, targetId, 'dev-jp')
    closers.push(() => mine.ws.close(), () => theirs.ws.close())
    await until(() => mine.got.some(m => m.t === 'status' && m.status === 'live'))
    expect(mine.got[0]).toEqual({ t: 'hello', owner: 'luca', canDrive: true })
    expect(theirs.got[0]).toEqual({ t: 'hello', owner: 'luca', canDrive: false })
    const calls = (method: string) => chrome.calls.filter(c => c.tab === targetId && c.method === method)

    // Nobody wants frames yet: no screencast. A card that isn't live asks for a still.
    await Bun.sleep(200)
    expect(calls('Page.startScreencast')).toHaveLength(0)
    theirs.send({ t: 'still' })
    await until(() => theirs.frames.length === 1)
    expect(decodeFrame(theirs.frames[0]!)?.header).toMatchObject({ deviceWidth: 1280, deviceHeight: 800 })

    // luca's card is on screen, 600 device pixels wide: frames no wider than that, at most 30 a second.
    mine.send({ t: 'active', on: true, width: 600 })
    await until(() => calls('Page.startScreencast').length === 1)
    expect(calls('Page.startScreencast')[0]!.params).toMatchObject({ format: 'jpeg', maxWidth: 640 })
    const before = mine.frames.length
    await Bun.sleep(1000)
    const perSecond = mine.frames.length - before
    expect(perSecond).toBeGreaterThan(10)
    expect(perSecond).toBeLessThanOrEqual(32)
    // jp's card isn't live: it gets none of them.
    expect(theirs.frames).toHaveLength(1)
    // jp's widens the stream a lot; a little doesn't restart it.
    theirs.send({ t: 'active', on: true, width: 1400 })
    await until(() => calls('Page.startScreencast').length === 2)
    expect(calls('Page.startScreencast')[1]!.params).toMatchObject({ maxWidth: 1440 }) // the widest, in steps of 80
    theirs.send({ t: 'active', on: true, width: 1450 })
    await Bun.sleep(200)
    expect(calls('Page.startScreencast')).toHaveLength(2)

    // Driving: luca's input reaches the tab, cleaned; jp's doesn't.
    mine.send({ t: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 255 })
    mine.send({ t: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', commands: ['selectAll', 'Browser.close'] })
    mine.send({ t: 'nav', url: 'https://example.org/next' })
    mine.send({ t: 'nav', url: 'javascript:alert(1)' })
    await until(() => calls('Page.navigate').length === 2 && calls('Input.dispatchKeyEvent').length === 1)
    expect(calls('Input.dispatchMouseEvent')[0]!.params).toMatchObject({ type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 15 })
    expect(calls('Input.dispatchKeyEvent')[0]!.params.commands).toEqual(['selectAll'])
    expect(calls('Page.navigate')[1]!.params).toEqual({ url: 'https://example.org/next' })
    await until(() => mine.got.some(m => m.t === 'refused'))
    await until(() => theirs.got.some(m => m.t === 'page' && m.url === 'https://example.org/next'))
    theirs.send({ t: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left' })
    theirs.send({ t: 'nav', url: 'https://evil.example' })
    theirs.send({ t: 'text', text: 'typed by jp' })
    await until(() => theirs.got.some(m => m.t === 'refused'))
    await Bun.sleep(200)
    expect(calls('Input.dispatchMouseEvent')).toHaveLength(1)
    expect(calls('Page.navigate')).toHaveLength(2) // the address it opened at, and luca's
    expect(calls('Input.insertText')).toHaveLength(0)

    // Both off screen: the screencast stops.
    mine.send({ t: 'active', on: false })
    theirs.send({ t: 'active', on: false })
    await until(() => calls('Page.stopScreencast').length >= 1)
  })

  test("a tab is laid out at its cards' size and ratio: the owner's card first, once sizes settle", async () => {
    const { targetId } = await luca.cmd<{ targetId: string }>('browser.open', { sessionId, url: 'https://example.com' })
    const calls = (method: string) => chrome.calls.filter(c => c.tab === targetId && c.method === method)
    const old = await card(server.http, targetId, 'dev-jp')
    const mine = await card(server.http, targetId, 'dev-luca')
    const theirs = await card(server.http, targetId, 'dev-jp')
    closers.push(() => old.ws.close(), () => mine.ws.close(), () => theirs.ws.close())
    await until(() => mine.got.some(m => m.t === 'status' && m.status === 'live'))

    // A page from before crisp frames names no size: the tab keeps Chrome's own.
    old.send({ t: 'active', on: true, width: 800 })
    await Bun.sleep(600)
    expect(calls('Emulation.setDeviceMetricsOverride')).toHaveLength(0)

    // jp's bigger card, then luca's, resized a few times in a row: one layout, at luca's last size.
    theirs.send({ t: 'active', on: true, width: 1400, css: { w: 1400, h: 900 }, dpr: 1 })
    for (const w of [900, 950, 1000]) mine.send({ t: 'active', on: true, width: w * 2, css: { w, h: 640 }, dpr: 2 })
    await until(() => calls('Emulation.setDeviceMetricsOverride').length === 1, 2000)
    await Bun.sleep(500)
    expect(calls('Emulation.setDeviceMetricsOverride').map(c => c.params)).toEqual([{ width: 1000, height: 640, deviceScaleFactor: 2, mobile: false }])
    // Frames as wide as the widest card on screen, no wider than the page is drawn (twice its width), at quality 85.
    await until(() => calls('Page.startScreencast').at(-1)?.params.maxWidth === 2000, 2000)
    expect(calls('Page.startScreencast').at(-1)!.params).toMatchObject({ quality: 85 })
    // Each new size stops the running screencast first: Chrome keeps a running one's size.
    const order = chrome.calls.filter(c => c.tab === targetId && c.method.endsWith('Screencast')).map(c => c.method)
    expect(order.slice(-2)).toEqual(['Page.stopScreencast', 'Page.startScreencast'])

    // A card that sizes the tab and leaves before its layout comes lays nothing out; nor does
    // asking for the size the tab has already.
    old.send({ t: 'active', on: false })
    const big = await card(server.http, targetId, 'dev-jp')
    closers.push(() => big.ws.close())
    big.send({ t: 'active', on: true, width: 1600, css: { w: 1600, h: 1000 }, dpr: 1 })
    mine.send({ t: 'active', on: false })
    await Bun.sleep(100)
    big.send({ t: 'active', on: false })
    mine.send({ t: 'active', on: true, width: 2000, css: { w: 1000, h: 640 }, dpr: 2 })
    await Bun.sleep(700)
    expect(calls('Emulation.setDeviceMetricsOverride')).toHaveLength(1)
    old.send({ t: 'active', on: true, width: 800 })

    // Zooming the canvas changes only how wide frames are made; it lays nothing out again.
    mine.send({ t: 'active', on: true, width: 1000, css: { w: 1000, h: 640 }, dpr: 2 })
    await until(() => calls('Page.startScreencast').at(-1)?.params.maxWidth === 1440, 2000) // jp's 1400, now the widest, in steps of 80
    await Bun.sleep(500)
    expect(calls('Emulation.setDeviceMetricsOverride')).toHaveLength(1)

    // luca's card off screen: jp's, the biggest live card, sets the layout, its ratio rounded to a half.
    mine.send({ t: 'active', on: false })
    theirs.send({ t: 'active', on: true, width: 1400, css: { w: 1400, h: 900 }, dpr: 1.25 })
    await until(() => calls('Emulation.setDeviceMetricsOverride').length === 2, 2000)
    expect(calls('Emulation.setDeviceMetricsOverride').at(-1)!.params).toEqual({ width: 1400, height: 900, deviceScaleFactor: 1.5, mobile: false })
  })

  test("the browser's debugging port is off limits, and the tab is reached again when the browser comes back", async () => {
    await expect(luca.cmd('browser.open', { sessionId, url: `http://localhost:${chrome.port}/json/list` })).rejects.toThrow(/debugging port/)
    const { targetId } = await luca.cmd<{ targetId: string }>('browser.open', { sessionId, url: 'https://example.com' })
    const c = await card(server.http, targetId, 'dev-luca')
    closers.push(() => c.ws.close())
    await until(() => c.got.some(m => m.t === 'status' && m.status === 'live'))
    c.send({ t: 'nav', url: `http://127.0.0.1:${chrome.port}/json/close/${targetId}` })
    await until(() => c.got.some(m => m.t === 'refused' && m.reason.includes('debugging port')))
    // And whatever the tab itself does, with the debugging port's requests failed while it's watched.
    const fetchEnable = chrome.calls.find(x => x.tab === targetId && x.method === 'Fetch.enable')
    expect(fetchEnable?.params.patterns).toEqual([{ urlPattern: `*://*:${chrome.port}/*` }])
    // From before the page loaded anything: the tab opened blank, guarded, then went to its address.
    const order = chrome.calls.filter(x => x.tab === targetId).map(x => x.method)
    expect(order.indexOf('Fetch.enable')).toBeLessThan(order.indexOf('Page.navigate'))
    expect(chrome.calls.find(x => x.tab === targetId && x.method === 'Page.navigate')?.params).toEqual({ url: 'https://example.com/' })

    // The browser stops answering: the card says so, and the tab is reached again.
    const enables = () => chrome.calls.filter(x => x.tab === targetId && x.method === 'Page.enable').length
    chrome.kick(targetId)
    await until(() => c.got.some(m => m.t === 'status' && m.status === 'unavailable'))
    await until(() => enables() === 2, 6000)
    await until(() => c.got.at(-1)?.t === 'status' && (c.got.at(-1) as { status: string }).status === 'live')
  })

  test("a tab that can't be sent on in time is closed, and nothing else waits for it", async () => {
    chrome.muted.add('Page.navigate')
    const before = new Set(chrome.tabs.keys())
    try {
      const opening = luca.cmd('browser.open', { sessionId, url: 'https://example.com/slow' })
      // Meanwhile the server answers anything else.
      await jp.cmd('status')
      await expect(opening).rejects.toThrow(/Page.navigate got no answer/)
    } finally {
      chrome.muted.delete('Page.navigate')
    }
    const opened = chrome.calls.filter(c => c.method === 'Page.navigate' && c.params.url === 'https://example.com/slow').map(c => c.tab)
    expect(opened).toHaveLength(1)
    expect(before.has(opened[0]!)).toBe(false)
    expect(chrome.closed).toContain(opened[0]!)

    // A tab whose guard on the debugging port can't be set is closed, never sent anywhere.
    chrome.muted.add('Fetch.enable')
    const navigatesBefore = chrome.calls.filter(c => c.method === 'Page.navigate').length
    try {
      await expect(luca.cmd('browser.open', { sessionId, url: 'https://example.com/unguarded' })).rejects.toThrow(/the new tab couldn't be reached/)
    } finally {
      chrome.muted.delete('Fetch.enable')
    }
    expect(chrome.calls.filter(c => c.method === 'Page.navigate')).toHaveLength(navigatesBefore)

    // An address that doesn't load: the tab goes, and the owner is told.
    await expect(luca.cmd('browser.open', { sessionId, url: 'https://nowhere.invalid/' })).rejects.toThrow(/didn't load \(net::ERR_NAME_NOT_RESOLVED\)/)
    const failed = chrome.calls.find(c => c.method === 'Page.navigate' && c.params.url === 'https://nowhere.invalid/')!
    expect(chrome.closed).toContain(failed.tab)
  }, 40_000)

  test('a session has at most eight tabs; other shapes are as big as they like', async () => {
    // Open until the limit: the earlier tests opened some already.
    for (let i = 0; i < 10; i++) if (!(await luca.cmd('browser.open', { sessionId }).then(() => true, () => false))) break
    await expect(luca.cmd('browser.open', { sessionId })).rejects.toThrow(/8 tabs open already/)
    // A frame bigger than any live card may be: fine, it isn't one.
    const p = await page()
    const big = { id: 'shape:big-frame', typeName: 'shape', type: 'frame', x: 0, y: 9000, rotation: 0, index: 'a9', parentId: CANVAS_PAGE, isLocked: false, opacity: 1, props: { w: 9000, h: 9000, name: 'big', color: 'black' }, meta: {} } as unknown as TLRecord
    p.store.put([big])
    await until(() => p.shape(big.id)?.meta.author === 'luca')
  })

  test('a removed card closes its tab; pages from before browser cards never see one', async () => {
    const p = await page()
    const old = await page('dev-jp', terminalEraSchema)
    // Another session: the first has all the tabs it may have by now.
    const other = await startSession(server.url)
    closers.push(() => other.client.close())
    const { shapeId, targetId } = await luca.cmd<{ shapeId: string; targetId: string }>('browser.open', { sessionId: other.id })
    await until(() => !!p.shape(shapeId))
    await Bun.sleep(200)
    expect(old.shape(shapeId)).toBeUndefined()
    // jp's page from before them still syncs.
    expect(old.store.allRecords().some(r => r.typeName === 'shape' && (r as TLShape).type === 'session')).toBe(true)

    p.store.remove([shapeId as any])
    await until(() => chrome.closed.includes(targetId))
    const c = await card(server.http, targetId, 'dev-luca')
    expect(await c.closed).toBe(4004) // no longer one Dyson Sphere has open
  })
})
