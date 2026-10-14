// The minimap, with the canvas's state colours: red for what waits on the viewer, the accent for
// sessions at work. tldraw's own minimap draws every shape alike.
import { useRef } from 'react'
import { Box, useEditor, useValue, type TLShape } from 'tldraw'
import type { SessionShape } from '../../../shared/canvas'
import { state, useChannel } from '../live'

const W = 200
const H = 136

export function Minimap() {
  const editor = useEditor()
  useChannel('session-states')
  useChannel('needs')
  const shapes = useValue(
    'minimap shapes',
    () =>
      editor
        .getCurrentPageShapes()
        .filter(s => (s.type === 'section' || s.type === 'session' || s.type === 'note') && !editor.isShapeHidden(s))
        .map(s => ({ s, b: editor.getShapePageBounds(s)! }))
        .filter(x => x.b),
    [editor],
  )
  const view = useValue('minimap view', () => editor.getViewportPageBounds(), [editor])
  const svg = useRef<SVGSVGElement>(null)
  if (!shapes.length) return null
  const all = Box.ExpandBy(Box.Common([...shapes.map(x => x.b), view]), 80)

  const fill = (s: TLShape) => {
    if (s.type === 'note') return 'var(--line-strong)'
    const id = (s as SessionShape).props.sessionId
    const session = state.sessions.get(id)
    const waitsOnMe = session?.owner === state.me?.identity && [...state.permissions.values()].some(p => p.sessionId === id && p.state === 'pending')
    return waitsOnMe ? 'var(--needs)' : session?.state === 'working' ? 'var(--accent)' : 'var(--line-strong)'
  }
  // Pressing or dragging on the map moves the view there.
  const go = (e: React.PointerEvent) => {
    const m = svg.current?.getScreenCTM()
    if (!m) return
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    editor.centerOnPoint({ x: p.x, y: p.y })
  }

  return (
    <svg
      ref={svg}
      className="tl-minimap-svg"
      width={W}
      height={H}
      viewBox={`${all.x} ${all.y} ${all.w} ${all.h}`}
      role="img"
      aria-label="Minimap"
      onPointerDown={e => (e.currentTarget.setPointerCapture(e.pointerId), go(e))}
      onPointerMove={e => e.buttons && go(e)}
    >
      {shapes.map(({ s, b }) =>
        s.type === 'section' ? (
          <rect key={s.id} x={b.x} y={b.y} width={b.w} height={b.h} rx={14} fill="none" stroke="var(--line-strong)" strokeWidth={all.w / W} />
        ) : (
          <rect key={s.id} x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill={fill(s)} />
        ),
      )}
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="color-mix(in oklch, var(--accent) 8%, transparent)" stroke="var(--accent-ink)" strokeWidth={(1.5 * all.w) / W} />
    </svg>
  )
}
