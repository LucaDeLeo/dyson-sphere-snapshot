// A stand-in for the server's Chrome, for tests: the DevTools HTTP endpoints sphere-server uses
// (/json/version, /json/new, /json/list, /json/close) and a page's CDP socket, which screencasts
// small frames for as long as it's asked, sends the next only once the last is acknowledged, and
// records every command it gets. It writes DevToolsActivePort into a profile folder, as Chrome does.
import type { ServerWebSocket } from 'bun'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The smallest JPEG worth sending: 1×1, white. */
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

type Tab = { id: string; url: string; title: string; casting: boolean; waiting: boolean; sockets: Set<ServerWebSocket<{ id: string }>> }

export function fakeChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'sphere-fake-chrome-'))
  const browserPath = `/devtools/browser/${crypto.randomUUID()}`
  const tabs = new Map<string, Tab>()
  /** Every CDP command, by tab: `[method, params]`. */
  const calls: { tab: string; method: string; params: any }[] = []
  const closed: string[] = []
  /** Commands it takes and never answers. */
  const muted = new Set<string>()
  let frames = 0
  const newId = () => crypto.randomUUID().replaceAll('-', '').toUpperCase()

  const emit = (t: Tab, method: string, params: unknown) => {
    for (const ws of t.sockets) ws.send(JSON.stringify({ method, params }))
  }
  const frame = (t: Tab) => {
    if (!t.casting || t.waiting) return
    t.waiting = true
    frames++
    emit(t, 'Page.screencastFrame', { data: JPEG, sessionId: frames, metadata: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, timestamp: Date.now() / 1000 } })
  }

  const server = Bun.serve<{ id: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/json/version') return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}${browserPath}` })
      if (url.pathname === '/json/new') {
        const t: Tab = { id: newId(), url: decodeURI(url.search.slice(1)) || 'about:blank', title: 'Fake', casting: false, waiting: false, sockets: new Set() }
        tabs.set(t.id, t)
        return Response.json({ id: t.id, type: 'page', url: t.url })
      }
      if (url.pathname === '/json/list') return Response.json([...tabs.values()].map(t => ({ id: t.id, type: 'page', url: t.url, title: t.title })))
      if (url.pathname.startsWith('/json/close/')) {
        const id = url.pathname.slice('/json/close/'.length)
        closed.push(id)
        const t = tabs.get(id)
        tabs.delete(id)
        for (const ws of t?.sockets ?? []) ws.close()
        return new Response('Target is closing')
      }
      const m = url.pathname.match(/^\/devtools\/page\/([A-F0-9]+)$/)
      if (m && tabs.has(m[1]!) && srv.upgrade(req, { data: { id: m[1]! } })) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        tabs.get(ws.data.id)?.sockets.add(ws)
      },
      close(ws) {
        tabs.get(ws.data.id)?.sockets.delete(ws)
      },
      message(ws, raw) {
        const t = tabs.get(ws.data.id)
        const { id, method, params } = JSON.parse(String(raw))
        calls.push({ tab: ws.data.id, method, params })
        if (muted.has(method)) return // a browser that took the command and never answers
        let result: unknown = {}
        if (!t) return void ws.send(JSON.stringify({ id, error: { message: 'No target' } }))
        if (method === 'Page.startScreencast') {
          t.casting = true
          t.waiting = false
          queueMicrotask(() => frame(t))
        } else if (method === 'Page.stopScreencast') t.casting = false
        else if (method === 'Page.screencastFrameAck') {
          t.waiting = false
          setTimeout(() => frame(t), 1) // as fast as acknowledged
        } else if (method === 'Page.navigate' && String(params.url).includes('.invalid')) result = { frameId: 'main', errorText: 'net::ERR_NAME_NOT_RESOLVED' }
        else if (method === 'Page.navigate') {
          t.url = params.url
          setTimeout(() => emit(t, 'Page.frameNavigated', { frame: { id: 'main', url: t.url } }), 5)
        } else if (method === 'Page.captureScreenshot') result = { data: JPEG }
        else if (method === 'Page.getLayoutMetrics') result = { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
        else if (method === 'Page.getNavigationHistory') result = { currentIndex: 0, entries: [{ id: 1, url: t.url }] }
        ws.send(JSON.stringify({ id, result }))
      },
    },
  })
  writeFileSync(join(profile, 'DevToolsActivePort'), `${server.port}\n${browserPath}\n`)
  return {
    profile,
    tabs,
    calls,
    closed,
    get frames() {
      return frames
    },
    port: server.port,
    /** Drops a tab's CDP connections, as a browser that stopped answering does; the tab stays. */
    muted,
    kick(id: string) {
      for (const ws of tabs.get(id)?.sockets ?? []) ws.close()
    },
    stop() {
      server.stop(true)
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
