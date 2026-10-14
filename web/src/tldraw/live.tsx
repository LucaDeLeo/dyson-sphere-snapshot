// Live cards on the canvas: thin tldraw shapes around content that keeps running (cards/terminal.ts).
// Their content is an app-owned element: tldraw never unmounts or recreates it, culling only hides
// it, and when the shape unmounts while it still exists (a page change, the editor remounting) the
// element waits in a parking lot, still connected, so the terminal and its socket carry on.
import './live.css'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { BaseBoxShapeUtil, Box, HTMLContainer, moveElementInto, useEditor, useIsEditing, useValue, type Editor, type TLShapeId } from 'tldraw'
import { BROWSER } from '../../../shared/browser'
import { browserProps, LIVE_TYPES, liveShapeId, sessionShapeId, terminalProps, type BrowserShape, type TerminalShape } from '../../../shared/canvas'
import { browsers, disposeBrowser, getBrowser, type BrowserHandle } from '../cards/browser'
import { disposeTerminal, getTerminal, terminals, type TerminalHandle } from '../cards/terminal'
import { cmd, state, toast, token } from '../live'

/** Below this many screen pixels wide, a live card is too small to read: it stops streaming. */
const MIN_SCREEN_W = 160

/** Where live elements wait, still connected to the document, while no shape shows them. */
let lot: HTMLDivElement | undefined
function parkingLot() {
  if (!lot) {
    lot = document.createElement('div')
    lot.className = 'live-parking-lot'
    lot.setAttribute('aria-hidden', 'true')
    document.body.appendChild(lot)
  }
  return lot
}

/** Whether the shape being edited is a live card, whose keys are all its own. */
export function editingLiveCard(editor: Editor): boolean {
  const id = editor.getEditingShapeId()
  const shape = id && editor.getShape(id)
  return !!shape && (LIVE_TYPES as readonly string[]).includes(shape.type)
}

/** The exit chord for a live card in edit mode: ⌘Esc on a Mac, Ctrl+Esc elsewhere. */
export const EXIT_CHORD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘Esc' : 'Ctrl+Esc'

export class TerminalShapeUtil extends BaseBoxShapeUtil<TerminalShape> {
  static override type = 'terminal' as const
  static override props = terminalProps

  override canEdit() {
    return true
  }
  override canResize() {
    return true
  }
  override hideRotateHandle() {
    return true
  }
  // Off screen it still keeps its terminal: culling hides it, the app-owned element stays.
  override canCull() {
    return true
  }

  getDefaultProps(): TerminalShape['props'] {
    return { w: 760, h: 480, sessionId: '' }
  }

  _handle(shape: TerminalShape): TerminalHandle {
    return getTerminal(shape.id, {
      sessionId: shape.props.sessionId,
      token,
      onExitRequest: () => {
        this.editor.setEditingShape(null)
        this.editor.select(shape.id)
      },
    })
  }

  override getAppOwnedElement(shape: TerminalShape) {
    return this._handle(shape).root
  }

  override onReleaseAppOwnedElement(shape: TerminalShape, element: HTMLElement) {
    // Still there (a page change, the editor remounting): parked, connected, so it keeps its
    // state. Removed: the terminal closes, and the server lets the bridge detach.
    if (this.editor.getShape(shape.id)) {
      moveElementInto(parkingLot(), element)
      this._handle(shape).setVisible(false) // nobody sees it while it's parked
    } else disposeTerminal(shape.id)
  }

  component(shape: TerminalShape) {
    return <TerminalShapeView util={this} shape={shape} />
  }

  getIndicatorPath(shape: TerminalShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}

function TerminalShapeView({ util, shape }: { util: TerminalShapeUtil; shape: TerminalShape }) {
  const editor = useEditor()
  const editing = useIsEditing(shape.id)
  const handle = util._handle(shape)
  const view = useSyncExternalStore(handle.subscribe, handle.view)

  // Streams while some of it is in view and it's big enough to read. Not culling: tldraw never
  // culls a selected shape, even far off screen.
  const visible = useValue(
    'terminal visible',
    () => {
      const bounds = editor.getShapePageBounds(shape.id)
      if (!bounds || !editor.getViewportPageBounds().collides(bounds)) return false
      return bounds.w * editor.getZoomLevel() >= MIN_SCREEN_W
    },
    [editor, shape.id],
  )
  useEffect(() => handle.setVisible(visible), [visible, handle])
  useEffect(() => {
    handle.setInteractive(editing)
    // tldraw focuses its own container when editing starts; the terminal takes it after.
    if (editing) requestAnimationFrame(() => handle.focus())
  }, [editing, handle])

  const s = state.sessions.get(shape.props.sessionId)
  const title = s?.task ?? (s ? `${s.repo ?? 'session'}${s.branch ? ` · ${s.branch}` : ''}` : 'Terminal')
  const owner = view.owner ?? s?.owner ?? null
  const hint = view.status !== 'live'
    ? null
    : editing
      ? view.canType
        ? `Typing into the terminal · ${EXIT_CHORD} to leave`
        : `View only: only ${owner} can type · ${EXIT_CHORD} to leave`
      : view.canType
        ? 'Double-click to type'
        : `View only · ${owner}'s session`

  return (
    <HTMLContainer className={`live-card term-card ${editing ? 'editing' : ''}`} style={{ width: shape.props.w, height: shape.props.h }}>
      <div className="live-title">
        <span className={`live-dot ${view.status}`} aria-hidden />
        <span className="live-name" title={title}>
          {title}
        </span>
        {owner && <span className="live-owner">{owner}</span>}
        <span className="live-hint">{view.refused ?? hint}</span>
        {view.canType && view.status === 'live' && (
          <button
            className="btn ghost small live-action"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => handle.fitPaneToCard()}
            title={`Make the pane ${view.cols}×${view.rows} → the card's size (tmux keeps that size for its window)`}
          >
            Fit pane
          </button>
        )}
      </div>
      {view.status !== 'live' && (
        <div className="live-status" role="status">
          {statusText(view.status, view.reason)}
        </div>
      )}
    </HTMLContainer>
  )
}

function statusText(status: string, reason: string | null): string {
  if (reason) return reason
  if (status === 'connecting') return 'Connecting to the terminal…'
  if (status === 'offline') return "The session's bridge isn't connected. The terminal comes back when it does."
  if (status === 'ended') return 'This session has ended.'
  return "This terminal can't be shown."
}

/**
 * A session's terminal card: the one already on the canvas, or a new one beside the session's
 * section, level with its card. Selected and brought into view either way.
 */
export function openTerminal(editor: Editor, sessionId: string) {
  const existing = editor.getCurrentPageShapes().find(s => s.type === 'terminal' && (s as TerminalShape).props.sessionId === sessionId)
  let id = existing?.id as TLShapeId | undefined
  if (!id) {
    id = liveShapeId('terminal')
    const card = editor.getShape(sessionShapeId(sessionId))
    const cardBounds = card && editor.getShapePageBounds(card)
    const section = card && editor.getShape(card.parentId as TLShapeId)
    const sectionBounds = section && editor.getShapePageBounds(section)
    const size = { w: 760, h: 480 }
    const at = sectionBounds && cardBounds ? freeSpot(editor, sectionBounds, cardBounds.y, size) : editor.getViewportPageBounds().center
    editor.createShape<TerminalShape>({ id, type: 'terminal', x: at.x, y: at.y, props: { ...size, sessionId } })
  }
  editor.select(id)
  const b = editor.getShapePageBounds(id)
  if (b) editor.zoomToBounds(Box.ExpandBy(b, 80), { targetZoom: Math.min(Math.max(editor.getZoomLevel(), 0.8), 1), animation: { duration: 300 } })
}

/**
 * Where a new card beside a section covers nothing: to its right, level with `y`, or else below it,
 * further down until it's clear.
 */
function freeSpot(editor: Editor, section: Box, y: number, size: { w: number; h: number }) {
  const gap = 48
  const taken = editor
    .getCurrentPageShapes()
    .filter(s => s.parentId === editor.getCurrentPageId() && !editor.isShapeHidden(s))
    .flatMap(s => editor.getShapePageBounds(s) ?? [])
  const clear = (x: number, y: number) => !taken.some(b => b.collides(new Box(x - gap / 2, y - gap / 2, size.w + gap, size.h + gap)))
  if (clear(section.maxX + gap, y)) return { x: section.maxX + gap, y }
  for (let step = 0; step < 200; step++) {
    const below = section.maxY + gap + step * 120
    if (clear(section.x, below)) return { x: section.x, y: below }
  }
  return { x: section.x, y: section.maxY + gap }
}

// ---------- browser cards ----------

export class BrowserShapeUtil extends BaseBoxShapeUtil<BrowserShape> {
  static override type = 'browser' as const
  static override props = browserProps

  override canEdit() {
    return true
  }
  override canResize() {
    return true
  }
  override hideRotateHandle() {
    return true
  }

  getDefaultProps(): BrowserShape['props'] {
    return { w: 1024, h: 720, sessionId: '', targetId: '' }
  }

  _handle(shape: BrowserShape): BrowserHandle {
    return getBrowser(shape.id, {
      targetId: shape.props.targetId,
      token,
      onExitRequest: () => {
        this.editor.setEditingShape(null)
        this.editor.select(shape.id)
      },
    })
  }

  override getAppOwnedElement(shape: BrowserShape) {
    return this._handle(shape).root
  }

  override onReleaseAppOwnedElement(shape: BrowserShape, element: HTMLElement) {
    if (this.editor.getShape(shape.id)) {
      moveElementInto(parkingLot(), element)
      this._handle(shape).setActive(false, 0) // nobody sees it while it's parked
    } else disposeBrowser(shape.id)
  }

  component(shape: BrowserShape) {
    return <BrowserShapeView util={this} shape={shape} />
  }

  getIndicatorPath(shape: BrowserShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}

/**
 * The browser cards this page streams: on screen, big enough to read, and within the page's
 * budget: the one being used first, then selected ones, then the biggest on screen. The rest show
 * their last frame. Not culling: tldraw never culls a selected shape, even far off screen.
 */
function liveBrowsers(editor: Editor): Set<string> {
  const view = editor.getViewportPageBounds()
  const zoom = editor.getZoomLevel()
  const editing = editor.getEditingShapeId()
  const selected = new Set<string>(editor.getSelectedShapeIds())
  const ranked = editor
    .getCurrentPageShapes()
    .filter(s => s.type === 'browser')
    .flatMap(s => {
      const b = editor.getShapePageBounds(s)
      if (!b || !view.collides(b) || b.w * zoom < BROWSER.minScreenWidth) return []
      const area = Math.min(b.w, view.w) * Math.min(b.h, view.h) * zoom * zoom
      return [{ id: s.id as string, rank: (s.id === editing ? 2e12 : 0) + (selected.has(s.id) ? 1e12 : 0) + area }]
    })
    .sort((a, b) => b.rank - a.rank)
  return new Set(ranked.slice(0, BROWSER.liveBudget).map(r => r.id))
}

function BrowserShapeView({ util, shape }: { util: BrowserShapeUtil; shape: BrowserShape }) {
  const editor = useEditor()
  const editing = useIsEditing(shape.id)
  const handle = util._handle(shape)
  const view = useSyncExternalStore(handle.subscribe, handle.view)
  const live = useValue('browser live', () => liveBrowsers(editor).has(shape.id), [editor, shape.id])
  // Its width on screen in device pixels: frames are made no wider (rounded by the server).
  const width = useValue('browser width', () => Math.round(shape.props.w * editor.getZoomLevel() * (window.devicePixelRatio || 1)), [editor, shape.props.w])
  useEffect(() => handle.setActive(live, width), [live, width, handle])
  useEffect(() => {
    handle.setInteractive(editing)
    if (editing) requestAnimationFrame(() => handle.focus())
  }, [editing, handle])
  const [address, setAddress] = useState<string | null>(null)

  const s = state.sessions.get(shape.props.sessionId)
  const owner = view.owner ?? s?.owner ?? null
  const hint =
    view.refused ??
    (editing ? (view.canDrive ? `Using the tab · ${EXIT_CHORD} to leave` : `View only · ${EXIT_CHORD} to leave`) : view.canDrive ? 'Double-click to use' : `View only · ${owner}'s session`)
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation()
  return (
    <HTMLContainer className={`live-card browser-card ${editing ? 'editing' : ''}`} style={{ width: shape.props.w, height: shape.props.h }}>
      <div className="live-title">
        <span className={`live-dot ${view.status === 'live' && live ? 'live' : view.status}`} aria-hidden />
        {view.canDrive && (
          <span className="browser-nav" onPointerDown={stop}>
            <button className="btn ghost small" onClick={() => handle.history('back')} aria-label="Back" title="Back">
              ←
            </button>
            <button className="btn ghost small" onClick={() => handle.history('forward')} aria-label="Forward" title="Forward">
              →
            </button>
            <button className="btn ghost small" onClick={() => handle.history('reload')} aria-label="Reload" title="Reload">
              ↻
            </button>
          </span>
        )}
        {view.canDrive ? (
          <input
            className="browser-address"
            aria-label="Address"
            value={address ?? view.url}
            placeholder="Type an address and press Enter"
            onPointerDown={stop}
            onFocus={e => setAddress(e.currentTarget.value)}
            onBlur={() => setAddress(null)}
            onChange={e => setAddress(e.currentTarget.value)}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter' && address) {
                handle.navigate(address)
                e.currentTarget.blur()
              } else if (e.key === 'Escape') e.currentTarget.blur()
            }}
          />
        ) : (
          <span className="live-name browser-url" title={view.url}>
            {view.url || 'about:blank'}
          </span>
        )}
        {owner && <span className="live-owner">{owner}</span>}
        <span className="live-hint">
          {!live && view.status === 'live' ? 'Paused · ' : ''}
          {hint}
        </span>
      </div>
      {(view.status !== 'live' || !view.hasFrame) && (
        <div className="live-status" role="status">
          {view.status === 'live' ? (live ? 'Waiting for the first frame…' : 'Paused: off screen, too small, or past this page’s live cards.') : browserStatusText(view.status, view.reason)}
        </div>
      )}
    </HTMLContainer>
  )
}

function browserStatusText(status: string, reason: string | null): string {
  if (reason) return reason
  if (status === 'connecting') return 'Connecting to the tab…'
  if (status === 'closed') return 'This tab was closed.'
  return "This tab can't be shown."
}

/**
 * A new tab of the server's browser for a session, and its card beside the session's section: the
 * session's owner's to open. The server makes both; the card arrives through the room.
 */
export async function openBrowser(editor: Editor, sessionId: string, url = '') {
  const card = editor.getShape(sessionShapeId(sessionId))
  const cardBounds = card && editor.getShapePageBounds(card)
  const section = card && editor.getShape(card.parentId as TLShapeId)
  const sectionBounds = section && editor.getShapePageBounds(section)
  const at = sectionBounds && cardBounds ? freeSpot(editor, sectionBounds, cardBounds.y, { w: 1024, h: 720 }) : editor.getViewportPageBounds().center
  try {
    const { shapeId } = await cmd<{ shapeId: TLShapeId }>('browser.open', { sessionId, url, x: at.x, y: at.y })
    for (let i = 0; i < 50 && !editor.getShape(shapeId); i++) await new Promise(r => setTimeout(r, 50))
    if (!editor.getShape(shapeId)) return
    editor.select(shapeId)
    const b = editor.getShapePageBounds(shapeId)
    if (b) editor.zoomToBounds(Box.ExpandBy(b, 80), { targetZoom: Math.min(Math.max(editor.getZoomLevel(), 0.6), 1), animation: { duration: 300 } })
  } catch (e) {
    toast((e as Error).message)
  }
}

/** Over the selected session's card: what can be opened from it (its terminal, a browser tab). */
export function SessionActions({ sessionId }: { sessionId: string }) {
  const editor = useEditor()
  // The card's top right corner, on screen; none while the camera moves or the card is off screen.
  const at = useValue(
    'session actions',
    () => {
      const b = editor.getShapePageBounds(sessionShapeId(sessionId))
      if (!b || editor.getInstanceState().isChangingStyle || !editor.getViewportPageBounds().collides(b)) return null
      const p = editor.pageToViewport({ x: b.maxX, y: b.minY })
      return { x: Math.round(p.x), y: Math.round(p.y) }
    },
    [editor, sessionId],
  )
  if (!at) return null
  return (
    <div className="session-actions" style={{ left: at.x, top: at.y }}>
      <button className="btn small" onPointerDown={e => e.stopPropagation()} onClick={() => openTerminal(editor, sessionId)} title="Open this session's terminal (T)">
        Terminal
      </button>
      {state.me && state.sessions.get(sessionId)?.owner === state.me.identity && (
        <button className="btn small" onPointerDown={e => e.stopPropagation()} onClick={() => void openBrowser(editor, sessionId)} title="Open a tab of the server's browser for this session (B)">
          Browser
        </button>
      )}
    </div>
  )
}

/**
 * Live cards removed while no shape showed them (parked, the canvas between mounts) close too:
 * their release came before their removal, so it parked them.
 */
export function watchLiveCards(editor: Editor): () => void {
  return editor.sideEffects.registerAfterDeleteHandler('shape', shape => {
    if (shape.type === 'terminal') disposeTerminal(shape.id)
    else if (shape.type === 'browser') disposeBrowser(shape.id)
  })
}

/** For tests and the console. */
Object.assign(window, { __terminals: terminals, __browsers: browsers })
