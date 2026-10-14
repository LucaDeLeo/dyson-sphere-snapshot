// The canvas document (tldraw 5): its custom shapes and the schema the browser and sphere-server
// both register. No React and no `tldraw` import, so the server can load it.
//
// The document holds only the arrangement: sections, session cards' places, notes and drawings.
// What a session is doing stays in the event log and the world (`server/src/world.ts`); a
// session shape only names its session.
import {
  createShapeId,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type RecordProps,
  type TLPageId,
  type TLRichText,
  type TLShape,
  type TLShapeId,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'
import type { NoteColor } from './protocol'

declare module '@tldraw/tlschema' {
  export interface TLGlobalShapePropsMap {
    /** A session's card. Its content comes from the world, by `sessionId`. */
    session: { w: number; h: number; sessionId: string }
    /** A frame of cards: a repo's or a ticket's, which the server keeps, or one someone made. */
    section: { w: number; h: number; title: string }
    /** A live card: a session's terminal (its tmux pane), streamed through sphere-server. */
    terminal: { w: number; h: number; sessionId: string }
    /** A live card: a tab of the server's Chrome, opened for a session, streamed by screencast. */
    browser: { w: number; h: number; sessionId: string; targetId: string }
  }
}

export type SessionShape = TLShape<'session'>
export type SectionShape = TLShape<'section'>
export type TerminalShape = TLShape<'terminal'>
export type BrowserShape = TLShape<'browser'>

export const sessionProps: RecordProps<SessionShape> = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  sessionId: T.string,
}

export const sectionProps: RecordProps<SectionShape> = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  title: T.string,
}

export const terminalProps: RecordProps<TerminalShape> = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  sessionId: T.string,
}

export const browserProps: RecordProps<BrowserShape> = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  sessionId: T.string,
  targetId: T.string,
}

// Each custom shape has a migration sequence from the start: a page and the server must agree
// on every shape's version, and a prop added later needs a migration to be read by both.
export const sessionVersions = createShapePropsMigrationIds('session', {})
export const sectionVersions = createShapePropsMigrationIds('section', {})
export const terminalVersions = createShapePropsMigrationIds('terminal', {})
export const browserVersions = createShapePropsMigrationIds('browser', {})
const sessionMigrations = createShapePropsMigrationSequence({ sequence: [] })
const sectionMigrations = createShapePropsMigrationSequence({ sequence: [] })
const terminalMigrations = createShapePropsMigrationSequence({ sequence: [] })
const browserMigrations = createShapePropsMigrationSequence({ sequence: [] })

/** The schema both ends register. tldraw's own shapes stay available for notes and drawing. */
export const canvasSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    session: { props: sessionProps, migrations: sessionMigrations },
    section: { props: sectionProps, migrations: sectionMigrations },
    terminal: { props: terminalProps, migrations: terminalMigrations },
    browser: { props: browserProps, migrations: browserMigrations },
  },
  bindings: defaultBindingSchemas,
})

/** The one room: everyone shares one canvas. */
export const CANVAS_ROOM = 'main'

/**
 * The page everything sits on: the one tldraw's room makes in an empty document. The server
 * makes sure it exists, so its own writes have a parent before any page connects.
 */
export const CANVAS_PAGE = 'page:page' as TLPageId

/** A session's card. One per session, so the id follows from the session's. */
export const sessionShapeId = (sessionId: string): TLShapeId => createShapeId(`session:${sessionId}`)

/** A region's section (`region:<repo>`, `region:ticket:<id>`, from `regionFor`). */
export const sectionShapeId = (regionId: string): TLShapeId => createShapeId(regionId)

/** Sections the server keeps, one per repo or ticket. Pages can't create or delete them. */
export const isRegionSection = (id: string) => id.startsWith('shape:region:')

// ---------- live cards ----------
// Shapes that show something running: a session's terminal, a browser tab. Pages from
// before a live card's type can't read its shapes (tldraw refuses a shape type it doesn't know and
// the page stops syncing), so the server keeps them from those pages, and saves them apart from
// the rest of the room so a server rolled back to before them doesn't load them either
// (server/src/canvas.ts). That needs to know a live card from its id alone: a deletion carries
// nothing else. So a live card's id names its type, `shape:<type>:<key>`, and nothing else may
// use that prefix.

/** The live card types, in the order they were added. */
export const LIVE_TYPES = ['terminal', 'browser'] as const
export type LiveType = (typeof LIVE_TYPES)[number]

/** A new live card's id. */
export const liveShapeId = (type: LiveType, key: string = crypto.randomUUID()): TLShapeId => createShapeId(`${type}:${key}`)

/** The live card type an id is kept for, if any. */
export function liveTypeOfId(id: string): LiveType | null {
  for (const type of LIVE_TYPES) if (id.startsWith(`shape:${type}:`)) return type
  return null
}

/** The schema's migration sequence for a shape type: a page's schema without it predates the type. */
export const shapeSequenceId = (type: string) => `com.tldraw.shape.${type}`

/** What a session id looks like, for a live card that names one. */
export const SESSION_ID = /^[\w.:-]{1,128}$/

// ---------- notes ----------
// Notes were plain text with five colours (`Note` in protocol.ts). On the canvas they're tldraw's
// note shape, with rich text. These convert both ways, for the import and for pages from before
// the canvas moved, which still send `note.*`.

/** A note's shape: its id after `shape:`, so a note keeps one id in the log and on the canvas. */
export const noteShapeId = (noteId: string): TLShapeId => `shape:${noteId}` as TLShapeId
export const noteIdOf = (shapeId: string) => shapeId.slice('shape:'.length)

const TO_TLDRAW: Record<NoteColor, string> = { yellow: 'yellow', blue: 'light-blue', green: 'light-green', pink: 'light-red', gray: 'grey' }
const FROM_TLDRAW: Record<string, NoteColor> = {
  yellow: 'yellow', orange: 'yellow',
  'light-blue': 'blue', blue: 'blue', violet: 'blue', 'light-violet': 'blue',
  'light-green': 'green', green: 'green',
  'light-red': 'pink', red: 'pink',
  grey: 'gray', black: 'gray', white: 'gray',
}
export const noteColorToTldraw = (c: NoteColor) => TO_TLDRAW[c] ?? 'yellow'
export const noteColorFromTldraw = (c: string): NoteColor => FROM_TLDRAW[c] ?? 'yellow'

type RichNode = { type: string; text?: string; content?: RichNode[] }

/** Plain text as rich text: a paragraph per line. */
export function richTextOf(text: string): TLRichText {
  return {
    type: 'doc',
    content: text.split('\n').map(line => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  } as TLRichText
}

/** Nodes whose children are words, not blocks: joined without a break. */
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'codeBlock'])

/** Rich text as plain text: its words, a line per paragraph, list item or other block. */
export function plainTextOf(rich: TLRichText | RichNode | undefined): string {
  const walk = (n: RichNode): string =>
    n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(walk).join(INLINE_PARENTS.has(n.type) ? '' : '\n')
  return rich ? walk(rich as RichNode) : ''
}

/** The most text a note holds, as the `note.*` commands take it. */
export const NOTE_TEXT_LIMIT = 4000

/** The width and height of a note shape: tldraw's notes are 200 square, scaled, and grow with their text. */
export const noteSize = (props: { scale: number; growY: number }) => ({ w: Math.round(200 * props.scale), h: Math.round((200 + props.growY) * props.scale) })
