// Codex sessions, through Codex's own hooks (~/.codex/hooks.json).
//
// Each hook runs `sphere codex-hook <Event>`, which hands the event to the session's bridge over
// its Unix socket and prints what the bridge answers. The first hook of a session (or of a
// bridge that died) starts the bridge, detached, and exits. The bridge follows the session's
// rollout file for prompts and replies, and answers from its hooks:
//
// - PreToolUse / PostToolUse report the tool call and carry messages sent mid-turn
//   (`additionalContext`), from the main agent's hooks only, never a subagent's.
// - Stop carries messages still waiting as the turn ends (`decision: "block"`), so Codex
//   carries on with them.
// - PermissionRequest asks Dyson Sphere and waits briefly; with no answer it returns no
//   decision, and Codex shows its own prompt (or its auto-reviewer decides).
//
// Hooks can't reach an idle Codex session, fill its prompt box or interrupt it; the server
// refuses those (CODEX_CANNOT in shared/protocol.ts).
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SessionCommand } from '../../shared/protocol'
import { firstLine, redact } from '../../shared/redact'
import { cutFields, redactValue, sourceValue, type CutField, type FieldPath } from '../../shared/rows'
import { SPHERE_HOME } from './client'

/** Where a Codex session's bridge listens, per session and Codex process (like Claude's). */
export const codexBase = (sessionId: string, pid: number) => join(SPHERE_HOME, 'run', `${sessionId.slice(0, 12)}.${pid}`)

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// The hook command. It must never fail or hold up a turn: every error ends in exit 0 with no
// output, and a hook that only reports or delivers gives the bridge half a second at most.
// ---------------------------------------------------------------------------------------------

/**
 * The longest string in a tool input or output passed to the bridge; a longer one is cut, and
 * listed in the payload's `sphere_cut` so the row says so. An input or output still larger than
 * PAYLOAD_TOTAL goes as one cut string, as before structured rows, and is named in the payload's
 * `sphere_whole` (the bridge then sends only text). Every payload carries `sphere_whole`, so the
 * bridge can tell it from one sent by an older hook. Each is redacted before any of it is cut,
 * since a secret cut short no longer matches its pattern.
 */
const PAYLOAD_CAP = 20_000
const PAYLOAD_TOTAL = 200_000
const capped = (raw: unknown, field: string, cut: CutField[], whole: string[]) => {
  if (raw === undefined || raw === null) return raw
  const v = redactValue(raw)
  if (typeof v !== 'string') {
    const mine: CutField[] = []
    const small = cutFields(v, [field], mine, PAYLOAD_CAP)
    if (JSON.stringify(small).length <= PAYLOAD_TOTAL) {
      cut.push(...mine)
      return small
    }
    whole.push(field)
  }
  if (typeof v === 'string' && v.length > PAYLOAD_CAP) cut.push({ path: [field], fullLength: v.length })
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > PAYLOAD_CAP ? s.slice(0, PAYLOAD_CAP) : v
}

export async function runCodexHook(event: string, pidArg: number | null): Promise<void> {
  try {
    const p = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
    const sessionId = typeof p.session_id === 'string' ? p.session_id : ''
    if (!/^[A-Za-z0-9-]{8,}$/.test(sessionId)) return
    // The hook's shell execs us, so our parent is Codex.
    const pid = pidArg ?? process.ppid
    const base = codexBase(sessionId, pid)
    const cut: CutField[] = []
    const whole: string[] = []
    const payload = {
      ...p,
      tool_input: capped(p.tool_input, 'tool_input', cut, whole),
      tool_response: capped(p.tool_response, 'tool_response', cut, whole),
      ...(cut.length && { sphere_cut: cut }),
      sphere_whole: whole,
    }
    let secret = ''
    try {
      secret = readFileSync(`${base}.secret`, 'utf8').trim()
    } catch {}
    // A session that's ending needs no bridge started for it.
    const restart = () => event !== 'SessionEnd' && startBridge(sessionId, pid, p)
    if (!secret) return void restart()
    // A permission request waits as long as the bridge says (it bounds the wait); others get 500 ms.
    const deadline = event === 'PermissionRequest' ? 600_000 : 500
    let res: Response
    try {
      res = await fetch('http://bridge/codex/hook', {
        unix: `${base}.sock`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sphere-secret': secret },
        body: JSON.stringify({ event, payload }),
        signal: AbortSignal.timeout(deadline),
      } as RequestInit)
    } catch (err) {
      // No bridge behind the socket: it died. Start another; this event goes unreported.
      if ((err as Error)?.name !== 'TimeoutError') restart()
      return
    }
    const body = res.ok ? await res.text() : ''
    if (body) process.stdout.write(body)
  } catch {
    // Never a failed hook: Codex carries on as if there were none.
  }
}

/** A bridge has this long to answer on its socket before its lock no longer counts. */
const LOCK_FRESH_MS = 30_000

/**
 * Starts the session's bridge, detached so it outlives this hook (and Codex's cancelling of
 * unfinished hooks), unless one is already starting. The lock file names whoever holds it:
 * this hook while it spawns, then the bridge. We only get here when no bridge answered, so an
 * old lock names a bridge that died (its pid perhaps reused since), and is replaced.
 */
function startBridge(sessionId: string, pid: number, p: Record<string, unknown>) {
  const base = codexBase(sessionId, pid)
  const runDir = join(SPHERE_HOME, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const lock = `${base}.lock`
  const held = () => {
    try {
      const fresh = Date.now() - statSync(lock).mtimeMs < LOCK_FRESH_MS
      const owner = Number(readFileSync(lock, 'utf8').trim() || 0)
      // Empty: its creator hasn't written its pid yet.
      return fresh && (!owner || pidAlive(owner))
    } catch {
      return false
    }
  }
  const take = () => {
    try {
      return openSync(lock, 'wx', 0o600)
    } catch {
      return null
    }
  }
  let fd = take()
  if (fd === null) {
    if (held()) return // starting, or running
    // Replacing a stale lock, one hook at a time: two at once could each remove the other's
    // new lock. One left behind by a hook that died there is cleared after a minute.
    const takeover = `${lock}.takeover`
    let t: number
    try {
      t = openSync(takeover, 'wx', 0o600)
    } catch {
      try {
        if (Date.now() - statSync(takeover).mtimeMs > 60_000) rmSync(takeover, { force: true })
      } catch {}
      return
    }
    try {
      if (held()) return // replaced while we looked
      rmSync(lock, { force: true })
      fd = take()
    } finally {
      closeSync(t)
      rmSync(takeover, { force: true })
    }
    if (fd === null) return // a first start got there in between
  }
  writeFileSync(fd, String(process.pid))
  closeSync(fd)
  const self = process.argv[1]?.endsWith('.ts') ? [process.argv[1]] : []
  const argv = [...self, 'bridge', '--agent', 'codex', '--session', sessionId, '--pid', String(pid), '--cwd', String(p.cwd ?? process.cwd())]
  if (typeof p.transcript_path === 'string') argv.push('--transcript', p.transcript_path)
  const logDir = join(SPHERE_HOME, 'sessions', `${sessionId}.${pid}`)
  mkdirSync(logDir, { recursive: true })
  const log = openSync(join(logDir, 'bridge.log'), 'a')
  const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', log, log], env: process.env })
  // Swapped in whole, so the lock never reads empty or half-written.
  const tmp = `${lock}.${process.pid}`
  writeFileSync(tmp, String(child.pid ?? process.pid), { mode: 0o600 })
  renameSync(tmp, lock)
  closeSync(log)
  child.unref()
}

// ---------------------------------------------------------------------------------------------
// The bridge's side
// ---------------------------------------------------------------------------------------------

type Deliver = Extract<SessionCommand, { kind: 'deliver' }>
type Decision = { decision: string; by?: string; message?: string | null }

/** What the Codex side needs from the bridge it runs in. */
export type CodexBridge = {
  sessionId: () => string
  event: (type: string, data: Record<string, unknown>, key?: string) => void
  /** A message handed over or failed: the bridge stops replaying its command. */
  settled: (msgId: string) => void
  /** Whether the server can see this session now; a request nobody can see isn't held. */
  connected: () => boolean
  awaitDecision: (reqId: string, ms: number) => Promise<Decision | null>
  /** SessionEnd: the session is over though Codex may run on (`/new`). */
  end: (reason: string) => void
}

/**
 * How long a permission request waits in Dyson Sphere before Codex shows its own prompt.
 * SPHERE_PERMISSION_WAIT_MINUTES, when whoever started the session set it (estra does for its
 * unattended agents; 0: don't wait); otherwise briefly, since nobody sees Codex's prompt while
 * a hook waits. Below the hook's 600 s timeout either way.
 */
export const CODEX_ATTENDED_WAIT_MS = 10_000
export function codexPermissionWait(env = process.env): number {
  const raw = env.SPHERE_PERMISSION_WAIT_MINUTES?.trim()
  if (!raw) return CODEX_ATTENDED_WAIT_MS
  const minutes = Number(raw)
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes * 60_000, 570_000) : 0
}

const frame = (m: Deliver) => `[From ${m.author}${m.approvedBy ? `, approved by ${m.approvedBy}` : ''}, via Dyson Sphere] ${m.text}`
/**
 * A message mid-turn reaches Codex as developer context, not as a user turn, so the owner's own
 * words say whose they are (in a Claude session they arrive as the user's turn).
 */
const midTurnText = (m: Deliver) => (m.asUser ? `Message from the user, sent while you work: ${m.text}` : frame(m))

type Given = 'mid' | 'end'

const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n')
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (o.content !== undefined) return textOf(o.content)
    if (o.fragments !== undefined) return textOf(o.fragments)
  }
  return ''
}

/** The separate texts of a message's content or a hook prompt's fragments. */
const blocks = (v: unknown) => (Array.isArray(v) ? v.map(textOf) : [textOf(v)]).filter(Boolean)

/** A message handed to a hook: what Codex was given, how, and where in which rollout it can show. */
type Handed = { msgId: string; given: string; how: Given; path: string | null; from: number }

/** Complete JSON lines of a file from byte `from` on, each with the offset it starts at. */
function linesFrom(file: string, from: number): { text: string; at: number }[] {
  let buf: Uint8Array
  try {
    const size = statSync(file).size
    if (size <= from) return []
    buf = new Uint8Array(size - from)
    const fd = openSync(file, 'r')
    readSync(fd, buf, 0, buf.length, from)
    closeSync(fd)
  } catch {
    return []
  }
  const out: { text: string; at: number }[] = []
  for (let i = 0, start = 0; i < buf.length; i++) {
    if (buf[i] !== 10) continue
    out.push({ text: new TextDecoder().decode(buf.subarray(start, i)), at: from + start })
    start = i + 1
  }
  return out
}

/**
 * `handedFile` records each hand-off (one JSON line per message), so that a bridge started
 * after this one died can tell a replayed command Codex may already have from a new one.
 */
export function createCodex(b: CodexBridge, transcript: string | null, handedFile: string | null = null) {
  const inbox: Deliver[] = []
  // Handed over, waiting to show up in the rollout, oldest first.
  const observing = new Map<string, Handed>()
  // Handed over by this bridge or one before it, from handedFile.
  const handedBefore = new Map<string, Handed>()
  // Arrivals already matched to a message, by rollout, line offset and text: an occurrence
  // counts for one message only, across the live follower, rechecks and earlier bridges.
  const claimed = new Map<string, number>()
  const claimKey = (file: string | null, at: number, given: string) => `${file}\n${at}\n${given}`
  // Messages an earlier bridge saw arrive, whether or not it lived to mark them done.
  const arrived = new Set<string>()
  if (handedFile)
    for (const l of existsSync(handedFile) ? readFileSync(handedFile, 'utf8').split('\n') : []) {
      try {
        const r = JSON.parse(l) as Handed | { claimed: string; msgId?: string }
        if ('claimed' in r) {
          claimed.set(r.claimed, (claimed.get(r.claimed) ?? 0) + 1)
          if (r.msgId) arrived.add(r.msgId)
        } else handedBefore.set(r.msgId, r)
      } catch {}
    }
  let quiet = false // another process runs the session now: its messages aren't for this one
  const calls = new Set<string>() // tool calls reported, by tool_use_id
  let permissions = 0
  let over = false // SessionEnd: nothing after it is this session's
  let path = transcript
  let offset = 0
  let rest = new Uint8Array(0)

  const row = (key: string, data: Record<string, unknown>) => {
    const clean = redact(String(data.text ?? ''))
    if (!clean.trim()) return
    b.event('session.row', { origin: 'codex', door: data.kind, agentId: null, ...data, summary: firstLine(clean), text: clean }, key)
  }

  // A message counts as delivered (and isn't replayed after a restart) only once the rollout
  // shows Codex has it: a hook's answer can be lost on the way (the hook gave up waiting, or
  // the bridge died). One handed over but never seen comes back with the next bridge.
  const delivered = (m: Deliver, given: string, how: Given) => {
    // Codex records what it got after this point of its rollout.
    let from = 0
    try {
      from = path ? statSync(path).size : 0
    } catch {}
    const h: Handed = { msgId: m.msgId, given, how, path, from }
    observing.set(m.msgId, h)
    if (handedFile)
      try {
        appendFileSync(handedFile, JSON.stringify(h) + '\n')
      } catch {}
    b.event('delivery', { msgId: m.msgId, state: 'injected', detail: how === 'mid' ? 'next tool call' : 'as the turn ended' }, `${m.msgId}:injected`)
  }
  /** What Codex is given for a message: mid-turn (developer context), or as the turn ends. */
  const givenAs = (m: Deliver, how: Given) => (how === 'mid' ? midTurnText(m) : m.asUser ? m.text : frame(m))

  /**
   * A tool input or output as a row carries it, under `root`: redacted per field, with what the
   * hook cut (`sphere_cut`, under `from`) and what's cut here listed in `cut`. An object as it is;
   * a list, or a plain string (apply_patch's patch, say), under `wrap` when given, and otherwise a
   * list as it is. An object the hook cut whole to a string (too large to send by field) shows
   * only in the row's text: the hook names it in `sphere_whole`. A hook from before
   * `sphere_whole` sends none, and cut such an object to PAYLOAD_CAP characters of JSON, so from
   * one of those a string that long that starts like JSON is taken as one.
   */
  const structured = (p: Record<string, any>, from: string, root: FieldPath, cut: CutField[], wrap?: string) => {
    let v = p[from]
    const whole = typeof v === 'string' && (Array.isArray(p.sphere_whole) ? p.sphere_whole.includes(from) : v.length >= PAYLOAD_CAP && /^\s*[{[]/.test(v))
    if (whole) return undefined
    const wrapped = !!wrap && (Array.isArray(v) || typeof v === 'string')
    if (wrapped) v = { [wrap!]: v }
    else if (v === null || typeof v !== 'object') return undefined
    for (const c of Array.isArray(p.sphere_cut) ? (p.sphere_cut as CutField[]) : [])
      if (Array.isArray(c?.path) && c.path[0] === from) cut.push({ path: [...root, ...(wrapped ? [wrap!] : []), ...c.path.slice(1)], fullLength: c.fullLength })
    return sourceValue(v, root, cut)
  }

  const reportCall = (p: Record<string, any>) => {
    const id = String(p.tool_use_id ?? '')
    if (!id || calls.has(id)) return
    calls.add(id)
    const input = typeof p.tool_input === 'string' ? p.tool_input : JSON.stringify(p.tool_input ?? {})
    const name = String(p.tool_name ?? 'tool')
    const cut: CutField[] = []
    // A call's input is an object: a string or a list goes under `input`.
    const value = structured(p, 'tool_input', ['calls', 0, 'input'], cut, 'input')
    const asObject = value === undefined || value === null ? null : (value as Record<string, unknown>)
    row(`codex:${b.sessionId()}:tool:${id}:call`, {
      kind: 'tool-call',
      agentId: p.agent_id ?? null,
      text: `${name} ${redact(input).slice(0, 2000)}`,
      tools: [{ name, id }],
      ...(asObject && { calls: [{ id, name, input: asObject }] }),
      ...(cut.length && { cut }),
    })
  }

  function hookOutput(event: string, context: string | null) {
    return context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : null
  }

  /** Mid-turn messages, from the main agent's tool hooks. */
  function midTurn(event: string, p: Record<string, any>, gone: () => boolean) {
    if (p.agent_id || gone() || quiet) return null // a subagent's is for the main agent; a hook that gave up gets none
    const now = inbox.filter(m => m.mode === 'steer')
    if (!now.length) return null
    for (const m of now) inbox.splice(inbox.indexOf(m), 1)
    const given = now.map(midTurnText).join('\n\n')
    for (const m of now) delivered(m, midTurnText(m), 'mid')
    return hookOutput(event, given)
  }

  async function permission(p: Record<string, any>) {
    const wait = codexPermissionWait()
    if (!wait || !b.connected()) return null
    const reqId = `p_${b.sessionId().slice(0, 8)}_${Date.now().toString(36)}_${++permissions}`
    const input = typeof p.tool_input === 'string' ? p.tool_input : JSON.stringify(p.tool_input ?? {})
    const tool = String(p.tool_name ?? 'tool')
    b.event('permission.requested', { reqId, tool, input: redact(input).slice(0, 2000) }, `${reqId}:requested`)
    const d = await b.awaitDecision(reqId, wait)
    const decided = d && (d.decision === 'allow' || d.decision === 'deny')
    // Unanswered: Codex's own prompt (or its reviewer) takes it from here.
    b.event('permission.resolved', { reqId, decision: decided ? d.decision : 'answered-locally', by: d?.by ?? null }, `${reqId}:resolved`)
    if (!decided) return null
    const decision = d.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: d.message ?? `Denied by ${d.by ?? 'the owner'} in Dyson Sphere` }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
  }

  // --- the rollout: prompts, replies, turn state, and proof that messages arrived ---

  function line(text: string, at: number) {
    let r: { type?: string; payload?: Record<string, any> }
    try {
      r = JSON.parse(text)
    } catch {
      return
    }
    const p = r.payload ?? {}
    const key = `codex:${b.sessionId()}:${basename(path ?? '')}:${at}`
    if (r.type === 'event_msg') {
      // Keyed like rows, so a bridge that reads the rollout again doesn't replay old turns.
      if (p.type === 'task_started') b.event('session.status', { state: 'working', turnId: p.turn_id ?? null }, `${key}:status`)
      else if (p.type === 'task_complete') b.event('session.status', { state: 'idle', turnId: null, reason: 'completed' }, `${key}:status`)
      else if (p.type === 'turn_aborted') b.event('session.status', { state: 'idle', turnId: null, reason: p.reason ?? 'aborted' }, `${key}:status`)
      else if (p.type === 'item_completed') {
        const item = (p.item ?? {}) as Record<string, any>
        if (item.type === 'Reasoning') {
          // Its summary when Codex writes one (raw reasoning only where the model exposes it);
          // usually both are empty and the reasoning itself is encrypted, so there's no row.
          const t = textOf(item.summary_text?.length ? item.summary_text : item.raw_content)
          return row(key, { kind: 'thinking', text: t, uuid: item.id ?? null })
        }
        const kind = item.type === 'AgentMessage' ? 'assistant' : item.type === 'UserMessage' || item.type === 'HookPrompt' ? 'prompt' : null
        if (!kind) return
        const t = textOf(item.type === 'HookPrompt' ? item.fragments : item.content)
        if (item.type === 'HookPrompt') observed(blocks(item.fragments), 'end', at)
        row(key, { kind, text: t, uuid: item.id ?? null })
      }
    } else if (r.type === 'response_item' && p.type === 'message' && p.role === 'developer') {
      // Mid-turn messages arrive as developer context; only ours are shown.
      const t = textOf(p.content)
      if (observed(blocks(p.content), 'mid', at)) row(key, { kind: 'note', text: t, uuid: p.id ?? null })
    }
  }

  /**
   * Marks the handed-over messages these blocks of text carry as observed: developer context
   * ('mid') for mid-turn messages, a Stop hook's prompt ('end') for turn-end ones, in a line at
   * offset `at` of the rollout. A message has to fill a whole paragraph of a block, so a short
   * one ("ok") isn't found inside other text, and each occurrence accounts for one message:
   * the latest of those handed over before it, since Codex records what it gets right after
   * the hand-off (an older one that never showed up is the one whose answer was lost). The same
   * words sent twice are two messages. True if the blocks carried any.
   */
  function observed(texts: string[], how: Given, at: number, file = path): boolean {
    // Neighbouring paragraphs share a separator ("ok\n\nok" holds two), so a match is searched
    // for again from the separator after it.
    const count = (given: string) =>
      texts.reduce((n, t) => {
        const hay = `\n\n${t}\n\n`
        const needle = `\n\n${given}\n\n`
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 2 + given.length)) n++
        return n
      }, 0)
    const left = new Map<string, number>() // occurrences not yet accounted for, by text
    let any = false
    const latestFirst = [...observing].sort(([, x], [, y]) => y.from - x.from)
    for (const [msgId, h] of latestFirst) {
      if (h.how !== how || h.path !== file || h.from > at) continue
      const k = claimKey(file, at, h.given)
      if (!left.has(h.given)) left.set(h.given, count(h.given) - (claimed.get(k) ?? 0))
      if (!(left.get(h.given)! > 0)) continue
      left.set(h.given, left.get(h.given)! - 1)
      claimed.set(k, (claimed.get(k) ?? 0) + 1)
      if (handedFile)
        try {
          appendFileSync(handedFile, JSON.stringify({ claimed: k, msgId }) + '\n')
        } catch {}
      observing.delete(msgId)
      b.event('delivery', { msgId, state: 'observed', detail: 'in the transcript' }, `${msgId}:observed`)
      b.settled(msgId)
      any = true
    }
    return any
  }

  /** Looks for messages' arrival in the rollout from the earliest of their hand-offs. */
  function recheck(file: string, from: number) {
    for (const { text, at } of linesFrom(file, from)) {
      let r: { type?: string; payload?: Record<string, any> }
      try {
        r = JSON.parse(text)
      } catch {
        continue
      }
      const p = r.payload ?? {}
      if (r.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'HookPrompt') observed(blocks(p.item.fragments), 'end', at, file)
      else if (r.type === 'response_item' && p.type === 'message' && p.role === 'developer') observed(blocks(p.content), 'mid', at, file)
    }
  }

  function poll() {
    if (over || !path || !existsSync(path)) return
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < offset) (offset = 0), (rest = new Uint8Array(0)) // replaced: read it again
    if (size === offset) return
    let chunk: Uint8Array
    try {
      const fd = openSync(path, 'r')
      chunk = new Uint8Array(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      closeSync(fd)
    } catch {
      return
    }
    // Rows are keyed by where their line starts, so a restarted bridge doesn't repeat them.
    let start = offset - rest.length
    const buf = rest.length ? new Uint8Array([...rest, ...chunk]) : chunk
    offset = size
    let from = 0
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 10) continue
      line(new TextDecoder().decode(buf.subarray(from, i)), start + from)
      from = i + 1
    }
    rest = buf.slice(from)
  }

  return {
    follow() {
      setInterval(poll, 300)
    },

    /**
     * Another Codex process took the session over (`codex exec resume`, a move). What waits
     * here was sent to this one, which is no longer reported: it isn't handed to its hooks.
     */
    quiet() {
      quiet = true
      inbox.length = 0
    },

    /** A command for this session. Codex takes messages only from its hooks, so they wait here. */
    command(c: SessionCommand) {
      if (c.kind === 'deliver') {
        if (c.mode === 'interrupt') return failed(c.msgId, 'Codex sessions cannot be interrupted')
        // Seen arriving by a bridge that died before it marked the message done.
        if (arrived.has(c.msgId)) {
          b.event('delivery', { msgId: c.msgId, state: 'observed', detail: 'in the transcript' }, `${c.msgId}:observed`)
          return b.settled(c.msgId)
        }
        // Replayed after a restart, though a bridge before this one handed it over: whether
        // Codex has it is in the rollout after that hand-off, however far we've read since.
        const before = handedBefore.get(c.msgId)
        if (before?.path) {
          observing.set(c.msgId, before)
          recheck(before.path, before.from)
          if (!observing.has(c.msgId)) return
          observing.delete(c.msgId) // never arrived: send it again
        }
        inbox.push(c)
        return
      }
      if (c.kind === 'interrupt') return failed(c.msgId, 'Codex sessions cannot be interrupted')
      if (c.kind === 'fill') return failed(c.msgId, 'Codex sessions have no prompt box Dyson Sphere can reach')
    },

    /**
     * One hook event; returns the hook's output, or null for none. `gone`: the hook stopped
     * waiting for the answer, so no message is handed to it.
     */
    async hook(event: string, p: Record<string, any>, gone: () => boolean = () => false): Promise<unknown> {
      if (typeof p.transcript_path === 'string' && p.transcript_path !== path && !p.agent_id) {
        // Resumed or compacted into another rollout: follow that one.
        path = p.transcript_path
        offset = 0
        rest = new Uint8Array(0)
      }
      switch (event) {
        case 'PreToolUse':
          reportCall(p)
          return midTurn(event, p, gone)
        case 'PostToolUse': {
          reportCall(p)
          const id = String(p.tool_use_id ?? '')
          const out = p.tool_response
          const cut: CutField[] = []
          const output = structured(p, 'tool_response', ['results', 0, 'output'], cut)
          const text = typeof out === 'string' ? out : JSON.stringify(out ?? '')
          row(`codex:${b.sessionId()}:tool:${id}:result`, {
            kind: 'tool-result',
            agentId: p.agent_id ?? null,
            // A result with nothing in it still gets its row, which says the call finished.
            text: text.trim() ? text : '(no output)',
            ...(id && { toolUseIds: [id] }),
            // Every finished call has its entry, as from the mod; a plain-text output is the text.
            ...(id && { results: [{ id, ...(output !== undefined && { output }) }] }),
            ...(cut.length && { cut }),
          })
          return midTurn(event, p, gone)
        }
        case 'Stop': {
          // Everything still waiting goes now, so Codex carries on with it. Only new messages
          // block, and each is taken once, so this can't loop.
          if (!inbox.length || gone() || quiet) return null
          const now = inbox.splice(0)
          const given = now.map(m => givenAs(m, 'end'))
          now.forEach((m, i) => delivered(m, given[i]!, 'end'))
          return { decision: 'block', reason: given.join('\n\n') }
        }
        case 'PermissionRequest':
          return permission(p)
        case 'SubagentStart':
          b.event('session.agent', { agentId: p.agent_id, state: 'running', description: p.agent_type ?? 'Subagent', subagentType: p.agent_type ?? 'agent', background: false }, `agent:${p.agent_id}:start`)
          return null
        case 'SubagentStop':
          if (typeof p.last_assistant_message === 'string')
            row(`codex:${b.sessionId()}:agent:${p.agent_id}:last`, { kind: 'assistant', agentId: p.agent_id, text: p.last_assistant_message })
          b.event('session.agent', { agentId: p.agent_id, state: 'done' }, `agent:${p.agent_id}:done`)
          return null
        case 'SessionEnd':
          // What Codex wrote last (its final reply, the turn's end) comes before the end.
          poll()
          over = true
          b.end(String(p.reason ?? 'other'))
          return null
        default:
          return null
      }
    },
  }

  function failed(msgId: string, detail: string) {
    b.event('delivery', { msgId, state: 'failed', detail }, `${msgId}:failed`)
    b.settled(msgId)
  }
}

// ---------------------------------------------------------------------------------------------
// Installing the hooks: `sphere codex-install`, run by install.sh
// ---------------------------------------------------------------------------------------------

/** Marks our entries in hooks.json, so an update finds and replaces them. */
const MARK = ': dyson-sphere-hook=1;'

/** Ours, in Codex's terms. Hooks that only report run in the background. */
const CODEX_HOOKS: { event: string; async?: boolean; timeout: number }[] = [
  { event: 'SessionStart', async: true, timeout: 10 },
  { event: 'PreToolUse', timeout: 5 },
  { event: 'PostToolUse', timeout: 5 },
  { event: 'PermissionRequest', timeout: 600 },
  { event: 'Stop', timeout: 5 },
  { event: 'SubagentStart', async: true, timeout: 10 },
  { event: 'SubagentStop', async: true, timeout: 10 },
  { event: 'SessionEnd', timeout: 3 },
]

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** One entry: with the sphere binary gone, it drains its input and exits 0, as if absent. */
export const codexHookCommand = (event: string, bin: string, home: string) =>
  `${MARK} if [ -x ${sh(bin)} ]; then SPHERE_HOME=${sh(home)} exec ${sh(bin)} codex-hook ${event}; else cat >/dev/null; fi`

/**
 * Adds or updates our entries in `<codexHome>/hooks.json`. Codex keys a hook's trust by its
 * position, so ours are replaced where they stand and new ones go last: no one else's entry
 * moves. Other keys and entries are kept as they are.
 */
export function writeCodexHooks(codexHome: string, bin: string, home: string): { file: string; changed: boolean } {
  const file = join(codexHome, 'hooks.json')
  let doc: Record<string, any> = {}
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (existsSync(file)) throw new Error(`${file} isn't valid JSON; fix or move it, then run install.sh again (${(err as Error).message})`)
  }
  const before = JSON.stringify(doc)
  doc.hooks ??= {}
  const ours = (x: any) => typeof x?.command === 'string' && x.command.startsWith(MARK)
  for (const h of CODEX_HOOKS) {
    const handler = { type: 'command', command: codexHookCommand(h.event, bin, home), timeout: h.timeout, ...(h.async && { async: true }) }
    const list: any[] = (doc.hooks[h.event] ??= [])
    // Ours is replaced where it is, beside anything someone put in the same group.
    const group = list.find(g => Array.isArray(g?.hooks) && g.hooks.some(ours))
    if (group) group.hooks = group.hooks.map((x: any) => (ours(x) ? handler : x))
    else list.push({ hooks: [handler] })
  }
  const changed = JSON.stringify(doc) !== before
  if (changed) {
    mkdirSync(codexHome, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
    renameSync(tmp, file)
  }
  return { file, changed }
}

/**
 * Trusts our entries the way Codex's `/hooks` does: `hooks/list` from `codex app-server` names
 * each hook's current hash, and `config/batchWrite` records it under `hooks.state`. Only
 * entries carrying our mark are touched. Returns how many are trusted now.
 */
export async function trustCodexHooks(codexHome: string, codex = 'codex'): Promise<{ trusted: number; total: number }> {
  const proc = Bun.spawn([codex, 'app-server'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { ...process.env, CODEX_HOME: codexHome } })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let n = 0
  const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++n
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        const m = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (m.id !== id) continue
        if (m.error) throw new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)
        return m.result
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('codex app-server exited')
      buf += decoder.decode(value)
    }
  }
  const timer = setTimeout(() => proc.kill(), 30_000)
  try {
    await call('initialize', { clientInfo: { name: 'sphere', title: 'Dyson Sphere', version: '0.1.0' }, capabilities: null })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
    const list = async () => {
      const r = await call('hooks/list', { cwds: [homedir()] })
      return ((r?.data ?? []).flatMap((d: any) => d.hooks ?? []) as any[]).filter(h => typeof h.command === 'string' && h.command.startsWith(MARK))
    }
    const ours = await list()
    const todo = ours.filter(h => h.trustStatus !== 'trusted')
    if (todo.length) {
      const value = Object.fromEntries(todo.map(h => [h.key, { trusted_hash: h.currentHash }]))
      await call('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }], filePath: null, expectedVersion: null, reloadUserConfig: true })
    }
    const after = await list()
    return { trusted: after.filter(h => h.trustStatus === 'trusted').length, total: after.length }
  } finally {
    clearTimeout(timer)
    proc.kill()
  }
}

export const defaultCodexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')
