// What a browser card's frames cost: opens a tab on the demo's sample page (whose clock repaints ten
// times a second) and watches it as a card of a given size would, for a few seconds.
//
//   bun run demo --port 7431            # in one terminal
//   bun run scripts/measure-frames.ts http://127.0.0.1:7431 [card CSS width] [height] [device pixel ratio] [zoom]
//
// Prints frames a second, bytes a frame and a second, and the frames' pixel size. Pages from before
// crisp frames send only the card's on-screen width; this sends that and the card's size and ratio.
import type { SessionSummary } from '../shared/protocol'
import { decodeFrame } from '../shared/browser'
import { Client } from '../sphere/src/client'
import { openPage } from '../tests/pages'
import { samplePage } from './chrome'

const BASE = process.argv[2] ?? 'http://127.0.0.1:7431'
const PORT = Number(new URL(BASE).port)
if (!PORT) throw new Error(`measure-frames needs a base URL with a port, e.g. http://127.0.0.1:7431 (got ${BASE})`)
const [cssW, cssH, dpr, zoom] = [Number(process.argv[3] ?? 1024), Number(process.argv[4] ?? 688), Number(process.argv[5] ?? 2), Number(process.argv[6] ?? 1)]
const SECONDS = 4

/** A JPEG's width and height, from its SOF marker. */
function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    const len = (b[i + 2]! << 8) | b[i + 3]!
    if (marker >= 0xc0 && marker <= 0xc3) return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]! }
    i += 2 + len
  }
  return null
}

const cli = new Client({ url: BASE.replace('http', 'ws') + '/ws', token: 'dev-luca' }, 'cli')
await cli.connect()
const { sessions } = await cli.cmd<{ sessions: SessionSummary[] }>('status')
const mine = sessions.find(s => s.owner === 'luca')!
const page = samplePage()
const sample = page.url
const { targetId, shapeId } = await cli.cmd<{ targetId: string; shapeId: string }>('browser.open', { sessionId: mine.id, url: sample })
/** The measurement's card goes when it's done, and with it its tab, however the run ends. */
const removeCard = async () => {
  const room = await openPage(PORT, 'dev-luca')
  room.store.remove([shapeId as never])
  await Bun.sleep(500)
  room.close()
}
process.on('uncaughtException', e => void removeCard().finally(() => (console.error(e), process.exit(1))))
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/browser?tab=${targetId}&token=dev-luca`)
ws.binaryType = 'arraybuffer'
const frames: { bytes: number; size: { w: number; h: number } | null; at: number }[] = []
ws.onmessage = ev => {
  if (!(ev.data instanceof ArrayBuffer)) return
  const f = decodeFrame(ev.data)
  if (f) frames.push({ bytes: f.jpeg.length, size: jpegSize(f.jpeg), at: Date.now() })
}
await new Promise(r => (ws.onopen = r))
await Bun.sleep(1500) // the page loads
ws.send(JSON.stringify({ t: 'active', on: true, width: Math.round(cssW * zoom * dpr), css: { w: cssW, h: cssH }, dpr }))
await Bun.sleep(1500) // the viewport settles
frames.length = 0
await Bun.sleep(SECONDS * 1000)
ws.close()
const bytes = frames.reduce((n, f) => n + f.bytes, 0)
const sizes = [...new Set(frames.map(f => (f.size ? `${f.size.w}×${f.size.h}` : '?')))]
console.log(`card ${cssW}×${cssH} CSS px at ratio ${dpr}, zoom ${zoom}: ${(frames.length / SECONDS).toFixed(1)} frames/s, ${(bytes / Math.max(1, frames.length) / 1024).toFixed(1)} KB/frame, ${(bytes / SECONDS / 1024).toFixed(0)} KB/s, frames ${sizes.join(', ')}`)
await removeCard()
cli.close()
page.stop()
process.exit(0)
