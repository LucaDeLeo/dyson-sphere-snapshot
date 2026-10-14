// Motion on the tldraw canvas, each from an event (PRODUCT.md: motion is data): a card someone
// else moved glides there, and a message flies from its sender to its card.
import { useEffect, useRef, useState } from 'react'
import { useEditor, useValue, type TLShape } from 'tldraw'
import { sessionShapeId } from '../../../shared/canvas'
import { eventHooks, state, useChannel } from '../live'
import { personColor } from '../ui'

const GLIDE_MS = 400

/**
 * Someone else moved a shape: it glides to its new place instead of jumping. Only changes from
 * the room; a person's own drag follows their pointer.
 */
export function useRemoteGlide() {
  const editor = useEditor()
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const stop = editor.store.listen(
      ({ changes }) => {
        for (const [before, after] of Object.values(changes.updated)) {
          if (after.typeName !== 'shape') continue
          const [b, a] = [before as TLShape, after as TLShape]
          if (b.x === a.x && b.y === a.y) continue
          const el = editor.getContainer().querySelector<HTMLElement>(`.tl-shape[data-shape-id="${a.id}"]`)
          if (!el) continue
          el.classList.add('glide')
          clearTimeout(timers.get(a.id))
          timers.set(a.id, setTimeout(() => el.classList.remove('glide'), GLIDE_MS))
        }
      },
      { source: 'remote', scope: 'document' },
    )
    return () => {
      stop()
      for (const t of timers.values()) clearTimeout(t)
    }
  }, [editor])
}

type Point = { x: number; y: number }
type Flight = { id: string; from: Point; to: Point; color: string }

/**
 * A dot flies from the sender's cursor (or the top of the view) to the card when a message is
 * sent or suggested. Drawn on the canvas, in page coordinates, so it moves with the camera.
 */
export function Flights() {
  const editor = useEditor()
  const [flights, setFlights] = useState<Flight[]>([])
  useEffect(() => {
    const hook = (ev: { type: string; actor: string; data: Record<string, unknown> }) => {
      const sent = ev.type === 'delivery' && ev.data.state === 'queued'
      if (!sent && ev.type !== 'suggestion.created') return
      const card = editor.getShape(sessionShapeId(String(ev.data.sessionId)))
      const bounds = card && !editor.isShapeHidden(card) ? editor.getShapePageBounds(card) : null
      if (!bounds) return
      const author = String(ev.actor)
      const mine = author === state.me?.identity
      const theirs = editor.getCollaborators().find(c => c.userName === author)?.cursor
      const top = editor.getViewportPageBounds()
      const from = mine ? editor.inputs.getCurrentPagePoint() : (theirs ?? { x: top.center.x, y: top.y + 40 / editor.getZoomLevel() })
      setFlights(f => [...f, { id: String(ev.data.msgId ?? ev.data.id), from: { x: from.x, y: from.y }, to: bounds.center, color: personColor(author) }])
    }
    eventHooks.add(hook)
    return () => void eventHooks.delete(hook)
  }, [editor])
  return (
    <>
      {flights.map(f => (
        <div
          key={f.id}
          className="flight"
          style={{ ['--c' as string]: f.color, transform: `translate(${f.to.x}px, ${f.to.y}px)` }}
          ref={el => {
            if (!el || el.dataset.started) return
            el.dataset.started = '1'
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
            const a = el.animate(
              reduced
                ? [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }]
                : [
                    { transform: `translate(${f.from.x}px, ${f.from.y}px) scale(0.6)`, opacity: 0.4 },
                    { transform: `translate(${f.to.x}px, ${f.to.y}px) scale(1)`, opacity: 1, offset: 0.85 },
                    { transform: `translate(${f.to.x}px, ${f.to.y}px) scale(0.2)`, opacity: 0 },
                  ],
              { duration: reduced ? 400 : 760, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' },
            )
            a.onfinish = () => setFlights(fs => fs.filter(x => x.id !== f.id))
          }}
        />
      ))}
    </>
  )
}

/**
 * Cursors from `/ws` presence without `canvas: 'tldraw'`: tldraw draws only the room's. The React
 * Flow canvas that sent them is gone, but a tab opened before it went keeps running it until it
 * reloads, so its cursor is still drawn. Harmless with none: it draws nothing.
 */
export function ClassicCursors() {
  const editor = useEditor()
  useChannel('presence')
  const zoom = useValue('zoom', () => editor.getZoomLevel(), [editor])
  const els = useRef(new Map<string, HTMLDivElement>())
  const pos = useRef(new Map<string, Point>())
  useEffect(() => {
    let raf = 0
    const tick = () => {
      for (const [conn, el] of els.current) {
        const target = state.presences.get(conn)?.cursor
        if (!target) continue
        const cur = pos.current.get(conn) ?? { ...target }
        cur.x += (target.x - cur.x) * 0.35
        cur.y += (target.y - cur.y) * 0.35
        pos.current.set(conn, cur)
        el.style.transform = `translate(${cur.x}px, ${cur.y}px) scale(${1 / Math.max(zoom, 0.05)})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [zoom])
  const classic = [...state.presences.values()].filter(p => p.cursor && p.canvas !== 'tldraw' && p.identity !== state.me?.identity)
  return (
    <>
      {classic.map(p => (
        <div
          key={p.conn}
          className="cursor"
          style={{ ['--c' as string]: p.color, transformOrigin: '0 0' }}
          ref={el => {
            if (el) els.current.set(p.conn, el)
            else els.current.delete(p.conn)
          }}
        >
          <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
            <path d="M1 1l5.5 15 2.2-6.3L15 7.5z" fill={p.color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span className="label">{p.identity}</span>
        </div>
      ))}
    </>
  )
}
