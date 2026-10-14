// Prints what the canvas room holds, as a page sees it: `bun scripts/room-dump.ts <port> [token]`.
// A development aid for the move to tldraw; not a test.
import type { TLShape } from '@tldraw/tlschema'
import { openPage } from '../tests/pages'

const page = await openPage(Number(process.argv[2] ?? 7420), process.argv[3] ?? 'dev-luca')
const shapes = page.store.allRecords().filter((r): r is TLShape => r.typeName === 'shape')
for (const s of shapes.sort((a, b) => a.id.localeCompare(b.id))) {
  const p = s.props as Record<string, unknown>
  console.log(`${s.type.padEnd(8)} ${s.id.padEnd(56)} parent=${s.parentId.padEnd(30)} x=${Math.round(s.x)} y=${Math.round(s.y)}${p.w ? ` ${p.w}×${p.h}` : ''}`)
}
page.close()
process.exit(0)
