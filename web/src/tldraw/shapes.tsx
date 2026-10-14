// tldraw's side of the canvas's own shapes: thin wrappers that position, select and cull our cards.
// What a card shows comes from `cards/`, which knows nothing of tldraw.
import {
  atom,
  BaseBoxShapeUtil,
  BaseFrameLikeShapeUtil,
  HTMLContainer,
  useEditor,
  useValue,
  type Atom,
  type Editor,
  type TLShape,
} from 'tldraw'
import { sectionProps, sessionProps, type SectionShape, type SessionShape } from '../../../shared/canvas'
import { SectionLabel, tidySlots } from '../cards/Section'
import { SessionCard, zoomBand, type ZoomBand } from '../cards/SessionCard'
import { state, toast } from '../live'

/**
 * Whether a card is drawn as HTML or left to something drawn behind the canvas (a GPU layer, one
 * day: a few hundred live cards at once). Always 'html' today; the layer would set 'none' for the
 * cards it draws, and the shape then renders nothing while tldraw still selects and moves it.
 */
export type Presentation = 'html' | 'none'
const presentations = new Map<string, Atom<Presentation>>()
const presentationOf = (id: string) => {
  let p = presentations.get(id)
  if (!p) presentations.set(id, (p = atom(`presentation:${id}`, 'html' as Presentation)))
  return p
}
export const setPresentation = (shapeId: string, p: Presentation) => presentationOf(shapeId).set(p)

/** The zoom band, changing only once the camera stops, so a zoom doesn't re-render every card on the way. */
export function useBand(): ZoomBand {
  const editor = useEditor()
  return useValue('band', () => zoomBand(editor.getDebouncedZoomLevel()), [editor])
}

export class SessionShapeUtil extends BaseBoxShapeUtil<SessionShape> {
  static override type = 'session' as const
  static override props = sessionProps

  override canResize() {
    return false
  }
  override canEdit() {
    return false
  }
  override hideRotateHandle() {
    return true
  }
  override hideSelectionBoundsBg() {
    return true
  }
  override hideSelectionBoundsFg() {
    return true
  }

  getDefaultProps(): SessionShape['props'] {
    return { w: 300, h: 168, sessionId: '' }
  }

  component(shape: SessionShape) {
    return <SessionShapeView shape={shape} />
  }

  getIndicatorPath(shape: SessionShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}

function SessionShapeView({ shape }: { shape: SessionShape }) {
  const editor = useEditor()
  const band = useBand()
  // Off screen, tldraw hides the card but keeps it: it needn't keep up until it's back.
  const culled = useValue('culled', () => editor.getCulledShapes().has(shape.id), [editor, shape.id])
  const shown = useValue('presentation', () => presentationOf(shape.id).get(), [shape.id])
  if (shown === 'none') return null
  return (
    // The card's own controls (Allow, Deny) stop their presses; everything else drags and selects.
    <HTMLContainer className="tl-card" style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
      <SessionCard id={shape.props.sessionId} band={band} paused={culled} />
    </HTMLContainer>
  )
}

/**
 * A frame of cards: a repo's or a ticket's. Its cards move with it, can't be dragged out of it,
 * and are clipped to it. The server sizes it to its cards; its title stays readable far out.
 */
export class SectionShapeUtil extends BaseFrameLikeShapeUtil<SectionShape> {
  static override type = 'section' as const
  static override props = sectionProps

  override canResize() {
    return false
  }
  override canEdit() {
    return false
  }
  override hideRotateHandle() {
    return true
  }
  // Notes can go in a section; session cards stay in the section of their region.
  override canReceiveNewChildrenOfType(_s: SectionShape, type: TLShape['type']) {
    return type !== 'session' && type !== 'section'
  }
  override canRemoveChildrenOfType(_s: SectionShape, type: TLShape['type']) {
    return type !== 'session'
  }

  getDefaultProps(): SectionShape['props'] {
    return { w: 340, h: 208, title: '' }
  }

  component(shape: SectionShape) {
    return <SectionShapeView shape={shape} />
  }

  getIndicatorPath(shape: SectionShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 14)
    return path
  }
}

function SectionShapeView({ shape }: { shape: SectionShape }) {
  const editor = useEditor()
  const band = useBand()
  // Its visible cards, as the label counts them.
  const sessionIds = useValue(
    'section sessions',
    () =>
      editor
        .getSortedChildIdsForParent(shape.id)
        .map(id => editor.getShape(id))
        .filter((s): s is SessionShape => s?.type === 'session' && !editor.isShapeHidden(s))
        .map(s => s.props.sessionId),
    [editor, shape.id],
  )
  const regionId = shape.id.slice('shape:'.length)
  const ticket = regionId.startsWith('region:ticket:') ? regionId.slice('region:ticket:'.length) : null
  // A ticket's frame names its repos, which a repo's frame doesn't need to.
  const repos = ticket ? [...new Set(sessionIds.map(id => state.sessions.get(id)?.repo ?? 'No repo'))] : []
  return (
    <HTMLContainer className={`region tl-section ${band}`} style={{ width: shape.props.w, height: shape.props.h }}>
      <div className="tl-section-heading">
        <SectionLabel d={{ title: shape.props.title, ticket, repos, sessionIds }} band={band} onTidy={() => tidy(editor, shape)} />
      </div>
    </HTMLContainer>
  )
}

/** Packs a section's visible cards into consecutive slots. The server records the moves for older pages. */
function tidy(editor: Editor, section: SectionShape) {
  const cards = editor
    .getSortedChildIdsForParent(section.id)
    .map(id => editor.getShape(id))
    .filter((s): s is SessionShape => s?.type === 'session' && !editor.isShapeHidden(s))
  const slots = tidySlots(cards.map(c => ({ id: c.id, x: c.x, y: c.y })))
  editor.updateShapes(slots.map(s => ({ id: s.id as SessionShape['id'], type: 'session' as const, x: s.x, y: s.y })))
  toast(`Tidied ${slots.length} cards`)
}
