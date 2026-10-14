// Structured transcript rows: tool inputs and results as JSON, with redaction and caps per field.
//
// A row always keeps its plain `text` (for tool calls, "<Name> <json>" cut at 2,000 characters),
// which is all an older page or CLI reads. Newer sources add `calls`, `results` and `cut`, and a
// `thinking` kind; each hop sends them only to a peer that said it understands them
// (`forPeer`), so an older bridge or server never sees them. The Claude Code mod keeps its own
// copy of `redactValue`, `cutFields` and `forPeer` in mod/hooks/register.ts, since a mod can't
// import from outside its folder: change both together.
import { redact } from './redact'

/** The protocol from which bridges and servers carry structured rows. */
export const STRUCTURED_ROWS = 3

/** A field inside a row's data, as keys from the row down: `['calls', 0, 'input', 'old_string']`. */
export type FieldPath = (string | number)[]

/** A tool call a row starts, with its input as the tool got it, redacted per field. */
export type RowCall = { id: string; name: string; input: Record<string, unknown> }

/**
 * A tool call a row finishes. `output` is the tool's structured result where the source has one;
 * `text`, what this call returned, when the row finishes several (their texts share the row's).
 */
export type RowResult = { id: string; isError?: boolean; output?: unknown; text?: string }

/** A field the source cut short before sending: the rest was never sent. */
export type CutField = { path: FieldPath; fullLength: number }

/**
 * A field the server cut short and stored whole as a body (`body` fetches it). A string keeps
 * its first `FIELD_TEXT_LIMIT` characters; a structure too large as a whole (`json`) is null in
 * the row, and its body is its JSON.
 */
export type CappedField = { path: FieldPath; bodyId: string; fullLength: number; json?: true }

/** What a `session.row` event's data holds. Everything after `text` is optional on the wire. */
export type RowData = {
  sessionId: string
  /** prompt, assistant, tool-call, tool-result, tool-error, thinking, note, attachment, ... */
  kind: string
  summary: string
  text: string
  uuid?: string | null
  door?: string
  origin?: string
  agentId?: string | null
  tools?: { name: string; id: string }[]
  toolUseIds?: string[]
  /** Set by the server when `text` was cut short: the whole text is this body. */
  bodyId?: string
  fullLength?: number
  calls?: RowCall[]
  results?: RowResult[]
  cut?: CutField[]
  capped?: CappedField[]
}

/** The longest string a source sends in a structured field; longer ones are cut and listed in `cut`. */
export const SOURCE_FIELD_LIMIT = 100_000
/** The largest structured value (one call's input, one result's output) a source sends, as JSON. */
export const SOURCE_VALUE_LIMIT = 400_000
/** Strings longer than this in a structured field are stored as a body by the server. */
export const FIELD_TEXT_LIMIT = 8_000
/** A structured value larger than this as JSON, after its strings are capped, is stored whole as a body. */
export const VALUE_JSON_LIMIT = 48_000

/**
 * Keys whose string values are secrets whatever they look like: a secret word as one part of the
 * key, in snake, kebab or camel case (`token`, `GITHUB_TOKEN`, `clientSecret`; not `max_tokens`).
 */
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key|credentials?)(?:$|[_-])/i
const secretKey = (k: string) => SECRET_KEY.test(k.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))

/**
 * Redacts every string in a value. A string under a secret-named key is redacted whole when it
 * looks like a credential (8+ characters, no spaces once trimmed), since its key no longer sits
 * next to it in one string for `redact`'s `token: …` pattern to find. Anything nested deeper than
 * 32 levels is dropped for a marker, not sent unredacted.
 */
export function redactValue(v: unknown, key?: string | number, depth = 0): unknown {
  if (typeof v === 'string') return typeof key === 'string' && secretKey(key) && /^\S{8,}$/.test(v.trim()) ? '[redacted]' : redact(v)
  if (v === null || typeof v !== 'object') return v
  if (depth > 32) return '[too deep]'
  if (Array.isArray(v)) return v.map((x, i) => redactValue(x, i, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = redactValue(x, k, depth + 1)
  return out
}

/** Cuts every string longer than `limit` in a value, recording each in `cut` under `root`. */
export function cutFields(v: unknown, root: FieldPath, cut: CutField[], limit = SOURCE_FIELD_LIMIT, depth = 0): unknown {
  if (typeof v === 'string') {
    if (v.length <= limit) return v
    cut.push({ path: root, fullLength: v.length })
    return v.slice(0, limit)
  }
  if (depth > 32 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x, i) => cutFields(x, [...root, i], cut, limit, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = cutFields(x, [...root, k], cut, limit, depth + 1)
  return out
}

/**
 * A structured value as a source sends it: redacted per field (before any cut, since a cut secret
 * no longer matches its pattern), long strings cut, and dropped whole when it's still too large.
 */
export function sourceValue(v: unknown, root: FieldPath, cut: CutField[]): unknown {
  const value = cutFields(redactValue(v), root, cut)
  const size = JSON.stringify(value)?.length ?? 0
  if (size <= SOURCE_VALUE_LIMIT) return value
  for (let i = cut.length - 1; i >= 0; i--) if (startsWith(cut[i]!.path, root)) cut.splice(i, 1)
  cut.push({ path: root, fullLength: size })
  return null
}

const startsWith = (path: FieldPath, root: FieldPath) => root.every((k, i) => path[i] === k)

/**
 * Events as a peer that speaks `protocol` takes them. Below STRUCTURED_ROWS, rows lose their
 * structured fields and thinking rows are left out: `dropped` lists their keys, for the sender to
 * clear from its outbox as if they'd been acknowledged.
 */
export function forPeer<E extends { key?: string; type: string; data: Record<string, unknown> }>(events: E[], protocol: number): { events: E[]; dropped: string[] } {
  if (protocol >= STRUCTURED_ROWS) return { events, dropped: [] }
  const out: E[] = []
  const dropped: string[] = []
  for (const e of events) {
    if (e.type !== 'session.row') out.push(e)
    else if (e.data.kind === 'thinking') {
      if (e.key) dropped.push(e.key)
    } else {
      const { calls: _c, results: _r, cut: _x, ...data } = e.data
      out.push({ ...e, data })
    }
  }
  return { events: out, dropped }
}

// ---------------------------------------------------------------------------------------------
// The server's side: checking what a source sent, and capping fields into bodies.
// ---------------------------------------------------------------------------------------------

const isPath = (p: unknown): p is FieldPath => Array.isArray(p) && p.length > 0 && p.length <= 40 && p.every(k => typeof k === 'string' || (typeof k === 'number' && Number.isInteger(k) && k >= 0))
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Keeps only well-formed structured fields, and removes the ones only the server may set. A row
 * from an older source has none, and passes through as it came.
 */
export function cleanRow(data: Record<string, unknown>): void {
  delete data.capped
  if (data.calls !== undefined) {
    const calls = Array.isArray(data.calls)
      ? data.calls
          .filter((c): c is RowCall => plainObject(c) && typeof c.id === 'string' && typeof c.name === 'string' && plainObject(c.input))
          .slice(0, 64)
          .map(c => ({ id: c.id.slice(0, 200), name: c.name.slice(0, 200), input: c.input }))
      : []
    if (calls.length) data.calls = calls
    else delete data.calls
  }
  if (data.results !== undefined) {
    const results = Array.isArray(data.results)
      ? data.results
          .filter((r): r is RowResult => plainObject(r) && typeof r.id === 'string')
          .slice(0, 64)
          .map(r => ({ id: r.id.slice(0, 200), ...(typeof r.isError === 'boolean' && { isError: r.isError }), ...(r.output !== undefined && { output: r.output }), ...(typeof r.text === 'string' && { text: r.text }) }))
      : []
    if (results.length) data.results = results
    else delete data.results
  }
  if (data.cut !== undefined) {
    const cut = Array.isArray(data.cut) ? data.cut.filter((c): c is CutField => plainObject(c) && isPath(c.path) && Number.isFinite(c.fullLength)).slice(0, 200) : []
    if (cut.length) data.cut = cut.map(c => ({ path: c.path, fullLength: Math.round(c.fullLength) }))
    else delete data.cut
  }
}

/**
 * Caps the structured fields of a row in place: strings over FIELD_TEXT_LIMIT keep their start and
 * go whole to a body, and a value still over VALUE_JSON_LIMIT goes whole to a body as JSON. Which
 * of the two applies is decided before any body is written, so none is left unreferenced.
 */
export async function capRow(data: Record<string, unknown>, putBody: (text: string) => Promise<string>): Promise<void> {
  const capped: CappedField[] = []
  const capValue = async (v: unknown, root: FieldPath): Promise<unknown> => {
    const long: { path: FieldPath; text: string }[] = []
    const walk = (x: unknown, path: FieldPath, depth: number): unknown => {
      if (typeof x === 'string') {
        if (x.length <= FIELD_TEXT_LIMIT) return x
        long.push({ path, text: x })
        return x.slice(0, FIELD_TEXT_LIMIT)
      }
      if (depth > 32 || x === null || typeof x !== 'object') return x
      if (Array.isArray(x)) return x.map((y, i) => walk(y, [...path, i], depth + 1))
      const out: Record<string, unknown> = {}
      for (const [k, y] of Object.entries(x)) out[k] = walk(y, [...path, k], depth + 1)
      return out
    }
    const small = walk(v, root, 0)
    if ((JSON.stringify(small)?.length ?? 0) <= VALUE_JSON_LIMIT) {
      for (const f of long) capped.push({ path: f.path, bodyId: await putBody(f.text), fullLength: f.text.length })
      return small
    }
    const whole = JSON.stringify(v)
    capped.push({ path: root, bodyId: await putBody(whole), fullLength: whole.length, json: true })
    return null
  }
  for (const [field, key] of [['calls', 'input'], ['results', 'output'], ['results', 'text']] as const) {
    const list = data[field] as Record<string, unknown>[] | undefined
    if (!list) continue
    for (let i = 0; i < list.length; i++) if (list[i]![key] !== undefined) list[i]![key] = await capValue(list[i]![key], [field, i, key])
  }
  if (capped.length) data.capped = capped
}

/** The value at `path` in a row's data, or undefined. */
export function fieldAt(data: unknown, path: FieldPath): unknown {
  let v = data
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string | number, unknown>)[k]
  }
  return v
}
