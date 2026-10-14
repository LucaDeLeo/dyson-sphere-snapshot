// The canvas on tldraw 5 (CS-2554): the room on sphere-server holds the arrangement (sections,
// session cards' places, notes); everything a session does still comes from live.ts.
import 'tldraw/tldraw.css'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  atom,
  Box,
  createShapeId,
  createUserId,
  Tldraw,
  useEditor,
  useValue,
  type Editor,
  type TLAssetStore,
  type TLShape,
  type TLUiOverrides,
  type TLUser,
  type TLUserId,
} from 'tldraw'
import { canvasSchema, sessionShapeId, type SessionShape } from '../../../shared/canvas'
import { Search, sessionShows, Toasts, useShowEnded } from '../chrome'
import { Inspector } from '../Inspector'
import { connect, needsMe, setPresence, state, token, useChannel } from '../live'
import { Avatar, Icon, personColor } from '../ui'
import { Minimap } from './Minimap'
import { ClassicCursors, Flights, useRemoteGlide } from './motion'
import { BrowserShapeUtil, editingLiveCard, openBrowser, openTerminal, SessionActions, TerminalShapeUtil, watchLiveCards } from './live'
import { SectionShapeUtil, SessionShapeUtil } from './shapes'

const SHAPE_UTILS = [SessionShapeUtil, SectionShapeUtil, TerminalShapeUtil, BrowserShapeUtil]
/** Drawn on the canvas, in page coordinates: message dots, and `/ws` cursors from tabs still on the old React Flow canvas. */
const COMPONENTS = {
  OnTheCanvas: () => (
    <>
      <Flights />
      <ClassicCursors />
    </>
  ),
}
/** Fonts and icons from sphere-server, not tldraw's CDN. */
const ASSET_URLS = getAssetUrls({ baseUrl: '/tldraw-assets' })
/** The licence key sphere-server put in the page; none in development, where tldraw needs none. */
const LICENSE_KEY = document.querySelector<HTMLMetaElement>('meta[name="tldraw-license-key"]')?.content || undefined

/** Images and files aren't stored on the server yet, so they can't be pasted onto the canvas. */
const ASSETS: TLAssetStore = {
  upload: async () => {
    throw new Error("Images can't be added to the canvas yet.")
  },
  resolve: asset => asset.props.src,
}

/**
 * tldraw's own shortcuts, minus the ones Dyson Sphere uses (N note, F follow, / find) and the
 * drawing tools, which have no toolbar yet: a stray key would switch to a tool nobody can see.
 */
const OVERRIDES: TLUiOverrides = {
  tools(_editor, tools) {
    for (const [id, tool] of Object.entries(tools)) if (id !== 'select' && id !== 'hand') tool.kbd = undefined
    return tools
  },
  actions(_editor, actions) {
    for (const id of ['open-cursor-chat', 'toggle-focus-mode', 'toggle-grid', 'toggle-tool-lock']) if (actions[id]) actions[id].kbd = undefined
    return actions
  },
}

/** Bumped whenever a session's visibility may have changed, so tldraw asks again. */
const visibility = atom('session visibility', { showEnded: false, version: 0 })

function sessionVisible(shape: SessionShape) {
  const s = state.sessions.get(shape.props.sessionId)
  return !!s && sessionShows(s, visibility.get().showEnded)
}

/** Sessions that ended or went offline a while ago, and a repo's or ticket's section with none that show. */
function getShapeVisibility(shape: TLShape, editor: Editor) {
  if (shape.type === 'session') return sessionVisible(shape as SessionShape) ? 'inherit' : 'hidden'
  if (shape.type === 'section' && shape.id.startsWith('shape:region:')) {
    const children = editor.getSortedChildIdsForParent(shape.id).map(id => editor.getShape(id))
    const empty = children.every(c => c?.type === 'session' && !sessionVisible(c as SessionShape))
    return empty ? 'hidden' : 'inherit'
  }
  return 'inherit'
}

const canvasUri = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/canvas${token ? `?token=${encodeURIComponent(token)}` : ''}`

export function TldrawApp() {
  useEffect(connect, [])
  const conn = useChannel('conn')
  // Who this page is, as sphere-server says on /ws: the room's cursors and names use it.
  const me = useMemo(() => atom<TLUser | null>('me', null), [])
  useEffect(() => {
    const id = state.me?.identity
    if (id && me.get()?.name !== id)
      me.set({ id: createUserId(id), typeName: 'user', name: id, color: personColor(id), imageUrl: '', meta: {} } as TLUser)
  }, [conn, me])
  // useSync starts over when its options change, so they stay the same objects.
  const users = useMemo(() => ({ currentUser: me }), [me])
  const store = useSync({ uri: canvasUri, assets: ASSETS, schema: canvasSchema, users })
  const [selected, setSelected] = useState<string | null>(null)
  const editorRef = useRef<Editor | null>(null)

  return (
    <div className="app">
      <div className="stage tl-stage">
        {store.status === 'synced-remote' ? (
          <Tldraw
            store={store.store}
            shapeUtils={SHAPE_UTILS}
            hideUi
            licenseKey={LICENSE_KEY}
            assetUrls={ASSET_URLS}
            overrides={OVERRIDES}
            components={COMPONENTS}
            getShapeVisibility={getShapeVisibility}
            options={{ maxPages: 1 }}
            onMount={editor => {
              editorRef.current = editor
              watchLiveCards(editor)
              editor.user.updateUserPreferences({ colorScheme: 'system' })
              // Everything in view at first, no closer than actual size.
              editor.zoomToFit()
              if (editor.getZoomLevel() > 1) editor.resetZoom()
              Object.assign(window, { editor }) // for tests and the console
            }}
          >
            <Chrome setSelected={setSelected} />
          </Tldraw>
        ) : state.conn === 'unauthorized' ? (
          <div className="empty" role="alert">
            <h2>Sign in to Dyson Sphere</h2>
            <p>This server doesn't know who you are.</p>
            <ol>
              <li>On the team server, open it through Tailscale: your Tailscale login signs you in.</li>
              <li>On a development server, add a token to the address: <code>?token=dev-luca</code></li>
            </ol>
          </div>
        ) : (
          <div className="banner" role="status">
            {store.status === 'error' ? `The canvas couldn't connect: ${store.error.message}` : 'Loading the canvas…'}
          </div>
        )}
      </div>
      {selected && state.sessions.has(selected) && (
        <Inspector
          key={selected}
          sessionId={selected}
          onClose={() => {
            setSelected(null)
            editorRef.current?.selectNone()
          }}
        />
      )}
    </div>
  )
}

/** Everything over the canvas, inside tldraw's context: top bar, search, keyboard, presence. */
function Chrome({ setSelected }: { setSelected: (id: string | null) => void }) {
  const editor = useEditor()
  useChannel('needs')
  useRemoteGlide()
  const [showEnded, setShowEnded] = useShowEnded()
  const [searching, setSearching] = useState(false)
  const [help, setHelp] = useState(false)

  // Sessions come and go from view as they end, go offline or come back, and with Show inactive.
  const sessionsV = useChannel('sessions') + useChannel('session-states') + useChannel('clock')
  useEffect(() => void visibility.set({ showEnded, version: sessionsV }), [showEnded, sessionsV])

  // Selecting one session opens the inspector; anything else closes it.
  const selectedSession = useValue(
    'selected session',
    () => {
      const only = editor.getOnlySelectedShape()
      return only?.type === 'session' ? (only as SessionShape).props.sessionId : null
    },
    [editor],
  )
  // The editor's selection is the truth: selecting a note or a second shape closes the
  // inspector and keeps that selection.
  useEffect(() => setSelected(selectedSession), [selectedSession, setSelected])

  // This page's cursor, view and selection go on /ws too, in React Flow's coordinates (a viewport is
  // tldraw's camera times its zoom), for tabs opened before the React Flow canvas went.
  useEffect(() => {
    const send = () => {
      const p = editor.inputs.getCurrentPagePoint()
      const cam = editor.getCamera()
      setPresence({ cursor: { x: Math.round(p.x), y: Math.round(p.y) }, viewport: { x: Math.round(cam.x * cam.z), y: Math.round(cam.y * cam.z), zoom: Math.round(cam.z * 1000) / 1000 } })
    }
    editor.on('event', send)
    return () => void editor.off('event', send)
  }, [editor])
  useEffect(() => setPresence({ selected: selectedSession }), [selectedSession])

  const focusSession = useCallback(
    (id: string) => {
      const shape = editor.getShape(sessionShapeId(id))
      if (!shape) return
      editor.select(shape.id)
      const b = editor.getShapePageBounds(shape)!
      editor.zoomToBounds(Box.ExpandBy(b, 120), { targetZoom: Math.max(editor.getZoomLevel(), 1), animation: { duration: 400 } })
    },
    [editor],
  )

  const needs = needsMe()
  const queue = [...needs.permissions.map(p => p.sessionId), ...needs.suggestions.map(s => s.sessionId)]
  useEffect(() => {
    document.title = queue.length ? `(${queue.length}) Dyson Sphere` : 'Dyson Sphere'
  }, [queue.length])
  const needsIdx = useRef(0)
  const nextNeeds = useCallback(() => {
    if (queue.length) focusSession(queue[needsIdx.current++ % queue.length]!)
  }, [queue.join(','), focusSession])

  // Other people on this canvas, one per person (their newest tab).
  const people = useValue('people', () => [...new Map(editor.getCollaborators().map(c => [c.userId, c])).values()], [editor])
  const following = useValue('following', () => editor.getInstanceState().followingUserId, [editor])
  const follow = useCallback((userId: string | null) => (userId && userId !== following ? editor.startFollowingUser(userId as TLUserId) : editor.stopFollowingUser()), [editor, following])
  const followNext = useCallback(() => {
    if (!people.length) return
    const i = people.findIndex(p => p.userId === following)
    follow(people[(i + 1) % people.length]!.userId)
  }, [people, following, follow])

  /** A note in the middle of the view, ready to type in. */
  const addNote = useCallback(() => {
    const c = editor.getViewportPageBounds().center
    const id = createShapeId()
    editor.createShape({ id, type: 'note', x: c.x - 100, y: c.y - 100, props: { font: 'sans', align: 'start', verticalAlign: 'start' } })
    editor.select(id)
    editor.setEditingShape(id)
  }, [editor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // A terminal (or any live card) being typed into has every key, ⌘K and Escape included.
      if (editingLiveCard(editor)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return e.preventDefault(), setSearching(true)
      // Keys belong to whatever is being edited or typed in.
      if (editor.getEditingShapeId() || t.closest('textarea, input, [contenteditable]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const ours: Record<string, () => void> = {
        '/': () => setSearching(true),
        n: addNote,
        f: followNext,
        '.': nextNeeds,
        '?': () => setHelp(h => !h),
        t: () => selectedSession && openTerminal(editor, selectedSession),
        b: () => {
          if (selectedSession && state.sessions.get(selectedSession)?.owner === state.me?.identity) void openBrowser(editor, selectedSession)
        },
      }
      const run = ours[e.key.length === 1 ? e.key.toLowerCase() : e.key]
      if (run) {
        // Ours, not tldraw's as well.
        e.preventDefault()
        e.stopPropagation()
        run()
      } else if (e.key === 'Escape') {
        // The editor's selection is the truth: clearing it closes the inspector, and the card can
        // be opened again with a click.
        setHelp(false)
        editor.stopFollowingUser()
        editor.selectNone()
      }
    }
    // Before tldraw's own handlers, which take the keys of the canvas when it has focus.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editor, addNote, followNext, nextNeeds, setSelected, selectedSession])

  const live = [...state.sessions.values()].filter(s => s.connected && s.state !== 'ended')
  const working = live.filter(s => s.state === 'working').length
  const followedName = people.find(p => p.userId === following)?.userName

  return (
    <>
      <header className="topbar">
        <div className="chip">
          <span className="brand">Dyson Sphere</span>
          <span className="brand-sub">{live.length ? `${live.length} live${working ? ` · ${working} working` : ''}` : 'No live sessions'}</span>
        </div>
        <div className="spacer" />
        <div className="chip" aria-label="People online">
          <span className={`conn-dot ${state.conn}`} title={state.conn === 'open' ? 'Connected' : 'Reconnecting'} />
          <div className="people">
            {state.me && <Avatar name={state.me.identity} title={`${state.me.identity} (you)`} />}
            {people.map(p => (
              <button
                key={p.userId}
                className={`avatar ${following === p.userId ? 'following' : ''}`}
                style={{ ['--c' as string]: personColor(p.userName) }}
                onClick={() => follow(p.userId)}
                title={following === p.userId ? `Stop following ${p.userName}` : `Follow ${p.userName}`}
                aria-pressed={following === p.userId}
              >
                {p.userName.slice(0, 1)}
              </button>
            ))}
          </div>
          <button className="btn ghost small" onClick={() => setSearching(true)} title="Find a session (⌘K)" aria-label="Find a session">
            {Icon.search} <span className="label">Find</span>
          </button>
          <button className="btn ghost small" onClick={() => setShowEnded(v => !v)} aria-pressed={showEnded} title={showEnded ? 'Hide ended sessions and sessions offline for hours' : 'Show ended sessions and sessions offline for hours'}>
            <span className="label">{showEnded ? 'Hide inactive' : 'Show inactive'}</span>
          </button>
          <button className="btn ghost small" onClick={addNote} title="Add a note (N)">
            {Icon.note} <span className="label">Note</span>
          </button>
          <button className="btn ghost small" onClick={() => setHelp(h => !h)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-pressed={help}>
            ?
          </button>
          <button className="btn ghost small" onClick={() => editor.zoomToFit({ animation: { duration: 300 } })} title="Fit everything" aria-label="Fit everything">
            {Icon.fit}
          </button>
          <button className={`btn small needs-btn ${queue.length ? 'needs' : 'ghost'}`} data-count={queue.length} onClick={nextNeeds} disabled={!queue.length} title="Go to the next thing waiting on you (.)">
            {Icon.bell} <span className="label">{queue.length ? 'Needs you · ' : 'Nothing needs you'}</span>
            {queue.length ? <span>{queue.length}</span> : null}
          </button>
        </div>
      </header>

      <div className="tl-controls" role="group" aria-label="Zoom">
        <button className="btn ghost small" onClick={() => editor.zoomIn(undefined, { animation: { duration: 200 } })} aria-label="Zoom in">+</button>
        <button className="btn ghost small" onClick={() => editor.zoomOut(undefined, { animation: { duration: 200 } })} aria-label="Zoom out">−</button>
      </div>
      <div className="tl-minimap">
        <Minimap />
      </div>

      {followedName && (
        <div className="banner" role="status">
          Following {followedName} <button className="btn small" onClick={() => editor.stopFollowingUser()}>Stop <span className="kbd">Esc</span></button>
        </div>
      )}
      {state.loaded && state.conn !== 'open' && state.conn !== 'unauthorized' && <div className="banner" role="status">Reconnecting to the server…</div>}
      {help && (
        <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
          <h2>Keyboard shortcuts</h2>
          <dl>
            <dt><span className="kbd">⌘K</span> <span className="kbd">/</span></dt><dd>Find a session</dd>
            <dt><span className="kbd">.</span></dt><dd>Next thing that needs you</dd>
            <dt><span className="kbd">N</span></dt><dd>New note</dd>
            <dt><span className="kbd">F</span></dt><dd>Follow the next person</dd>
            <dt><span className="kbd">T</span></dt><dd>Open the selected session's terminal</dd>
            <dt><span className="kbd">B</span></dt><dd>Open a browser tab for your selected session</dd>
            <dt>Double-click a terminal or tab</dt><dd>Use it; <span className="kbd">⌘Esc</span> (Ctrl+Esc) leaves</dd>
            <dt><span className="kbd">Space</span> drag</dt><dd>Pan</dd>
            <dt><span className="kbd">⌘Z</span> <span className="kbd">⌘⇧Z</span></dt><dd>Undo, redo your own changes</dd>
            <dt><span className="kbd">⌘↵</span></dt><dd>Send a message</dd>
            <dt><span className="kbd">Esc</span></dt><dd>Close, stop following</dd>
          </dl>
        </div>
      )}
      {selectedSession && <SessionActions sessionId={selectedSession} />}
      {searching && <Search onClose={() => setSearching(false)} onPick={id => (setSearching(false), focusSession(id))} />}
      <Toasts />
    </>
  )
}

