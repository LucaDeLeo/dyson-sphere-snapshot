// Dyson Sphere mod: reports this session to sphere-server and applies steering from it.
//
// The mod stays thin. It starts `sphere bridge` for the life of the session, forwards
// transcript rows and status to the bridge's Unix socket, and acts on the commands the
// bridge writes to stdout. All networking and buffering live in the bridge.
import type { EngineInterface, Register } from 'claude-code'

type Deliver = { kind: 'deliver'; msgId: string; text: string; mode: 'queue' | 'steer' | 'interrupt'; author: string; approvedBy: string | null; asUser: boolean }
type BridgeLine =
  /** `protocol`: what the bridge passes on (3 and up: structured rows); bridges before it name none. */
  | { kind: 'ready'; sessionId: string; socket: string; secret: string; protocol?: number }
  | Deliver
  | { kind: 'interrupt'; msgId: string; author: string }
  | { kind: 'fill'; msgId: string; text: string; author: string }
  /** The owner decided a request the agent stopped waiting for. */
  | { kind: 'permission'; msgId: string; reqId: string; decision: 'allow' | 'deny'; by: string; message: string | null }
  /** Another Claude Code process runs this session now (it was moved or resumed elsewhere). */
  | { kind: 'superseded'; machine: string }
  /** The bridge's connection to the server, for the status line. */
  | { kind: 'status'; text: string }

type E = EngineInterface
type Out = { type: string; data: Record<string, unknown>; key?: string }

const SECRETS: [RegExp, string][] = [
  // To its end marker, or to the end of the text when it was cut short.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[redacted]'],
  [/((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi, '$1[redacted]'],
]
const redact = (s: string) => SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), s)

const firstLine = (s: string) => {
  const line = s.split('\n').find(l => l.trim()) ?? ''
  return line.length > 140 ? line.slice(0, 139) + '…' : line
}

// Structured rows: copies of shared/rows.ts (redactValue, cutFields, sourceValue, forPeer), since a
// mod can't import from outside its folder. Change both together.
const STRUCTURED_ROWS = 3
const SOURCE_FIELD_LIMIT = 100_000
const SOURCE_VALUE_LIMIT = 400_000
type FieldPath = (string | number)[]
type CutField = { path: FieldPath; fullLength: number }
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key|credentials?)(?:$|[_-])/i
const secretKey = (k: string) => SECRET_KEY.test(k.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))

function redactValue(v: unknown, key?: string | number, depth = 0): unknown {
  if (typeof v === 'string') return typeof key === 'string' && secretKey(key) && /^\S{8,}$/.test(v.trim()) ? '[redacted]' : redact(v)
  if (v === null || typeof v !== 'object') return v
  if (depth > 32) return '[too deep]'
  if (Array.isArray(v)) return v.map((x, i) => redactValue(x, i, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = redactValue(x, k, depth + 1)
  return out
}

function cutFields(v: unknown, root: FieldPath, cut: CutField[], depth = 0): unknown {
  if (typeof v === 'string') {
    if (v.length <= SOURCE_FIELD_LIMIT) return v
    cut.push({ path: root, fullLength: v.length })
    return v.slice(0, SOURCE_FIELD_LIMIT)
  }
  if (depth > 32 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x, i) => cutFields(x, [...root, i], cut, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = cutFields(x, [...root, k], cut, depth + 1)
  return out
}

function sourceValue(v: unknown, root: FieldPath, cut: CutField[]): unknown {
  const value = cutFields(redactValue(v), root, cut)
  const size = JSON.stringify(value)?.length ?? 0
  if (size <= SOURCE_VALUE_LIMIT) return value
  for (let i = cut.length - 1; i >= 0; i--) if (root.every((k, j) => cut[i]!.path[j] === k)) cut.splice(i, 1)
  cut.push({ path: root, fullLength: size })
  return null
}

/** Events as a bridge that speaks `protocol` takes them: an older one gets rows as they were. */
function forPeer(events: Out[], protocol: number): Out[] {
  if (protocol >= STRUCTURED_ROWS) return events
  return events
    .filter(e => !(e.type === 'session.row' && e.data.kind === 'thinking'))
    .map(e => {
      if (e.type !== 'session.row') return e
      const { calls: _c, results: _r, cut: _x, ...data } = e.data
      return { ...e, data }
    })
}

/**
 * What a tool's structured result adds to the row, which already has the text the model read:
 * the whole file before an Edit or Write, a Read's content and image data are left out.
 */
function slimOutput(tool: string, result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const { originalFile: _o, ...r } = result as Record<string, unknown>
  if (tool === 'Write') delete r.content // the call's input has it
  if (tool === 'TodoWrite') delete r.oldTodos
  if (tool === 'Read' && r.file && typeof r.file === 'object') {
    const { content: _c, base64: _b, ...file } = r.file as Record<string, unknown>
    r.file = file
  }
  return r
}

// Tool results by tool_use_id, from tool.call, for the row that records them. The engine writes
// that row after the tool.call hooks return, so the result is here by then.
const results = new Map<string, { tool: string; output: unknown }>()

/**
 * A row's kind and plain text, its thinking, and its tool calls and results as structured data.
 * `text` is what rows always had (tool inputs as "<Name> <json>" cut at 2,000 characters), for
 * pages and CLIs from before structured rows.
 */
type Described = {
  kind: string
  text: string
  thinking: string
  tools: { name: string; id: string }[]
  toolUseIds: string[]
  calls: { id: string; name: string; input: unknown }[]
  results: { id: string; isError: boolean; output?: unknown; text?: unknown }[]
  cut: CutField[]
}

function describe(message: { type: string; role?: string; content: any[] }, door: string): Described {
  const parts: string[] = []
  const thinking: string[] = []
  const tools: { name: string; id: string }[] = []
  const toolUseIds: string[] = []
  const calls: Described['calls'] = []
  const done: Described['results'] = []
  const texts: string[] = []
  const cut: CutField[] = []
  let kind: string = message.type === 'assistant' ? 'assistant' : door
  for (const b of message.content ?? []) {
    if (b.type === 'text') parts.push(b.text)
    else if (b.type === 'thinking' && typeof b.thinking === 'string') thinking.push(b.thinking)
    else if (b.type === 'tool_use') {
      // Redacted before it's cut: a cut secret no longer matches its pattern.
      parts.push(`${b.name} ${redact(JSON.stringify(b.input ?? {})).slice(0, 2000)}`)
      tools.push({ name: String(b.name), id: String(b.id) })
      const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {}
      calls.push({ id: String(b.id), name: String(b.name), input: sourceValue(input, ['calls', calls.length, 'input'], cut) ?? {} })
      if (kind === 'assistant') kind = 'tool-call'
    } else if (b.type === 'tool_result') {
      const c = b.content
      const out = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : ''
      // A result with nothing in it still gets its row, which says the call finished.
      const own = out.trim() ? out : '(no output)'
      parts.push(own)
      texts.push(own)
      kind = b.is_error ? 'tool-error' : 'tool-result'
      if (b.tool_use_id) {
        const id = String(b.tool_use_id)
        toolUseIds.push(id)
        const r = results.get(id)
        results.delete(id)
        const output = r && !b.is_error ? slimOutput(r.tool, r.output) : undefined
        done.push({ id, isError: !!b.is_error, ...(output !== undefined && { output: sourceValue(output, ['results', done.length, 'output'], cut) }) })
      }
    } else if (b.type === 'image' || b.type === 'document') parts.push(`[${b.type}]`)
  }
  // Results of calls run together share the row's text: each also keeps its own, to show apart.
  if (done.length > 1) done.forEach((r, i) => (r.text = sourceValue(texts[i] ?? '', ['results', i, 'text'], cut)))
  return { kind, text: parts.join('\n'), thinking: thinking.join('\n\n'), tools, toolUseIds, calls, results: done, cut }
}

// Session state. A reload runs the module again, so these start over with it.
let sessionId: string | null = null
let socket: string | null = null
let secret = ''
let bridgeProtocol = 2 // what the bridge passes on, from its ready line
let turnId: string | null = null
let cleared = false
let restarts = 0
let bridged = false // a bridge has been ready before: the next one replaces it
let superseded = false
let link = 'connecting' // the bridge's connection, as the status line shows it
let interactive = true // whether a person is at the prompt (false for `claude -p` and the SDK)
const outbox: Out[] = []
let flushing = false
// Prompts submitted for a message, waiting to show up in the transcript.
const awaiting = new Map<string, string>()

/** Throws unless the bridge accepted it: a refused batch must stay in the outbox. */
async function post($: E, path: string, body: unknown) {
  const res = await $.http.fetch(`http://bridge${path}`, {
    method: 'POST',
    socketPath: socket!,
    headers: { 'content-type': 'application/json', 'x-sphere-secret': secret },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`bridge answered ${res.status} to ${path}`)
  return res
}

async function flush($: E) {
  if (!socket || flushing || outbox.length === 0) return
  flushing = true
  try {
    while (outbox.length && socket) {
      const batch = outbox.splice(0, 50)
      try {
        // Thinking rows an older bridge can't take are left out with it.
        const events = forPeer(batch, bridgeProtocol)
        if (events.length) await post($, '/events', { events })
      } catch {
        outbox.unshift(...batch)
        break
      }
    }
  } finally {
    flushing = false
  }
}

// Never awaited by a hook: the session must not wait on us.
function emit($: E, type: string, data: Record<string, unknown>, key?: string) {
  outbox.push({ type, data: { sessionId, ...data }, key })
  void flush($)
}

// Replies in progress (protocol 4): the main agent's and subagents' text, passed on a paragraph at a time and
// never stored. The finished message still arrives as its row. Copies of PARTIAL_REPLIES and
// PARTIAL_TEXT_LIMIT in shared/protocol.ts.
const PARTIAL_REPLIES = 4
const PARTIAL_TEXT_LIMIT = 20_000
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * The completed paragraphs at the start of a reply so far: everything before its last blank line
 * outside a code fence, so a code block counts as one paragraph. The line still being written
 * isn't looked at.
 */
function completedParagraphs(text: string): string {
  const lines = text.split('\n')
  let fence: string | null = null
  let at = 0
  let done = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    const mark = line.match(FENCE)?.[1]
    if (fence === null && mark) fence = mark
    else if (fence !== null && mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim()) fence = null
    else if (fence === null && !line.trim() && at > 0) done = at
    at += line.length + 1
  }
  return text.slice(0, done).trimEnd()
}

/** Never awaited: the reply mustn't wait on us, and a lost one is made good by the next. */
function partial($: E, agentId: string | undefined, turn: string, step: number, block: number, text: string) {
  if (!socket || superseded) return
  void post($, '/partial', { agentId, turnId: turn, step, block, text: redact(text) }).catch(() => {})
}

async function rekeyIfCleared($: E) {
  if (!cleared) return
  const id = await $.session.id()
  if (id === sessionId) return
  cleared = false
  sessionId = id
  if (socket) await post($, '/rekey', { sessionId: id }).catch(() => {})
}

const delivery = ($: E, msgId: string, state: string, detail?: string) =>
  emit($, 'delivery', { msgId, state, detail: detail ?? null }, `${msgId}:${state}`)

async function deliver($: E, c: Deliver) {
  // Attribution goes in front, inline: a trailing colon and blank line read as a cut-off message.
  const framed = c.asUser ? c.text : `[From ${c.author}${c.approvedBy ? `, approved by ${c.approvedBy}` : ''}, via Dyson Sphere] ${c.text}`
  try {
    if (c.mode === 'interrupt' && turnId) await $.turn.abort({ turnId })
    if (c.mode === 'steer' && turnId) {
      // Read by the model at the next step of the running turn, without interrupting it.
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: framed }] } })
      if (r.deny) return delivery($, c.msgId, 'failed', r.deny)
      delivery($, c.msgId, 'injected', 'mid-turn note')
      return delivery($, c.msgId, 'observed', `row ${r.uuid}`)
    }
    awaiting.set(framed, c.msgId)
    await $.prompt.submit(c.asUser ? { text: framed, asUser: true } : { text: framed })
    delivery($, c.msgId, 'injected', 'prompt submitted')
  } catch (err) {
    delivery($, c.msgId, 'failed', String((err as Error)?.message ?? err))
  }
}

async function handle($: E, line: string) {
  let m: BridgeLine
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.kind === 'ready') {
    const again = bridged
    bridged = true
    socket = m.socket
    secret = m.secret
    bridgeProtocol = typeof m.protocol === 'number' ? m.protocol : 2
    restarts = 0
    link = 'connecting'
    $.ui.status(link)
    // A restarted bridge's session.started clears the session's subagents: report the running ones
    // again.
    if (again) {
      agentStatus.clear()
      void reconcileAgents($)
    }
    return flush($)
  }
  if (m.kind === 'status') {
    link = m.text
    if (!superseded) $.ui.status(link)
    return
  }
  if (m.kind === 'superseded') {
    superseded = true
    $.ui.status(`now runs on ${m.machine}; not reported from here`)
    $.ui.toast(`sphere: this session was resumed on ${m.machine}, so this terminal is no longer reported`)
    return
  }
  if (m.kind === 'permission') return decidedLater($, m)
  if (m.kind === 'deliver') return deliver($, m)
  if (m.kind === 'interrupt') {
    if (!turnId) return delivery($, m.msgId, 'failed', 'no turn running')
    try {
      await $.turn.abort({ turnId })
      delivery($, m.msgId, 'observed', 'turn aborted')
    } catch (err) {
      delivery($, m.msgId, 'failed', String((err as Error)?.message ?? err))
    }
    return
  }
  if (m.kind === 'fill') {
    const r = await $.prompt.fill({ text: m.text, mode: 'append' })
    if (r.isFilled) {
      $.ui.toast(`sphere: ${m.author} put a message in your prompt box`)
      delivery($, m.msgId, 'observed', 'in prompt box')
    } else delivery($, m.msgId, 'failed', r.refusal ?? 'no prompt box')
  }
}

/**
 * How long a permission request waits for an answer before the agent is told to carry on
 * without it, from SPHERE_PERMISSION_WAIT_MINUTES. Set by whatever starts a session nobody
 * watches (estra sets it for its background stages); 0 means don't wait at all. Unset (null),
 * the request waits for the terminal dialog as Claude Code always does.
 */
async function permissionWait($: E): Promise<number | null> {
  const raw = (await $.env.get('SPHERE_PERMISSION_WAIT_MINUTES'))?.trim()
  const minutes = raw ? Number(raw) : NaN
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : null
}

// Requests the agent stopped waiting for, and one-shot grants for the ones allowed later.
const deferred = new Map<string, { tool: string; input: string }>()
const grants = new Map<string, number>() // tool + input → expiry
/** A retried call matches on what it does; the model rewords `description` freely. */
const grantKey = (tool: string, input: unknown) => {
  const { description: _, ...rest } = (input ?? {}) as Record<string, unknown>
  return `${tool}\n${JSON.stringify(rest)}`
}

/** The owner allowed or declined a deferred request: the agent hears about it as a message. */
async function decidedLater($: E, m: Extract<BridgeLine, { kind: 'permission' }>) {
  const req = deferred.get(m.reqId)
  if (!req) return delivery($, m.msgId, 'failed', 'the session restarted since the request; the agent can ask again')
  deferred.delete(m.reqId)
  const shown = redact(req.input).slice(0, 500)
  let text: string
  if (m.decision === 'allow') {
    grants.set(grantKey(req.tool, JSON.parse(req.input)), (await $.clock.now()) + 60 * 60_000)
    text = `I've now allowed the ${req.tool} call you asked for earlier, which nobody answered in time: ${shown}. If you still need it, run it again exactly as before and it will go through without asking.`
  } else {
    text = `I've declined the ${req.tool} call you asked for earlier: ${shown}.${m.message ? ` ${m.message}` : ''} Don't run it; find another way, or say what you need.`
  }
  return deliver($, { kind: 'deliver', msgId: m.msgId, text, mode: 'queue', author: m.by, approvedBy: null, asUser: false })
}

let permissionCount = 0
// Requests waiting on Dyson Sphere, by tool name. The PermissionRequest input has no
// tool_use_id, so a finished call of the same tool settles them (approximate when the
// model runs the same tool in parallel).
const waitingByTool = new Map<string, Set<{ reqId: string; settled: boolean }>>()
type Decided = { decision: 'allow' | 'deny'; by?: string; message?: string | null; deferred?: boolean }

/**
 * Waits for the owner to allow or deny a tool call in Dyson Sphere.
 * Returns null when nobody decided remotely: the request expired, the bridge went
 * away, or the person answered the terminal dialog first (the dispatch was abandoned).
 */
async function awaitPermission($: E, tool: string, input: unknown, signal: AbortSignal, wait: number | null): Promise<Decided | null> {
  // Unique across sessions too: the server keeps every session's requests in one place.
  const reqId = `p_${sessionId?.slice(0, 8)}_${(await $.clock.now()).toString(36)}_${++permissionCount}`
  emit($, 'permission.requested', { reqId, tool, input: redact(JSON.stringify(input ?? {})).slice(0, 2000) }, `${reqId}:requested`)
  $.ui.status('waiting for approval here or in Dyson Sphere')
  const entry = { reqId, settled: false }
  const set = waitingByTool.get(tool) ?? new Set()
  waitingByTool.set(tool, set.add(entry))
  const deadline = (await $.clock.now()) + (wait ?? 30 * 60_000)
  let outcome: Decided | null = null
  while (!signal.aborted && !entry.settled && socket && (await $.clock.now()) < deadline) {
    let d: { decision: string; by?: string; message?: string | null }
    try {
      // The bridge holds each poll for at most the time left, so the wait ends on time.
      const res = await post($, '/permission/wait', { reqId, timeout: deadline - (await $.clock.now()) })
      d = JSON.parse(res.text)
    } catch {
      break
    }
    if (d.decision === 'allow' || d.decision === 'deny') {
      outcome = d as Decided
      break
    }
  }
  set.delete(entry)
  const local = entry.settled || signal.aborted
  if (!outcome && !local && wait !== null && socket && (await $.clock.now()) >= deadline) {
    // Nobody is answering. The agent carries on without it; the owner can still allow it.
    deferred.set(reqId, { tool, input: JSON.stringify(input ?? {}) })
    const minutes = Math.round(wait / 60_000)
    const waited = minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${Math.round(wait / 1000)} seconds`
    // A headless run may end with this turn (`claude -p`), so no later answer is promised.
    const after = interactive
      ? "It is waiting for the session owner's approval in Dyson Sphere, and you will get a message if they allow it. Meanwhile, carry on with work that doesn't need it. If nothing else can be done, finish your turn and say what is blocked."
      : "Treat it as denied: carry on with work that doesn't need it, and if your task can't be finished without it, say so in your final answer. If the owner allows it while this session is still running, you will get a message."
    outcome = {
      decision: 'deny',
      deferred: true,
      message: `Nobody answered this permission request within ${waited}, so it was not run. ${after}`,
    }
  }
  const final = outcome?.deferred ? 'deferred' : outcome ? outcome.decision : local ? 'answered-locally' : 'expired'
  emit($, 'permission.resolved', { reqId, decision: final, by: outcome?.by ?? null }, `${reqId}:resolved`)
  $.ui.status(link)
  return local ? null : outcome
}

/** A call of `tool` finished: whoever answered its dialog did so in the terminal. */
async function settleLocally($: E, tool: string) {
  for (const entry of waitingByTool.get(tool) ?? []) {
    if (entry.settled) continue
    entry.settled = true
    if (socket) await post($, '/permission/cancel', { reqId: entry.reqId }).catch(() => {})
  }
}

/**
 * The sphere binary, from fixed places only (never a PATH search, which would run whatever
 * `sphere` comes first): SPHERE_BRIDGE if set, else the install location under SPHERE_HOME
 * (~/.sphere/bin/sphere), else this repo's source when running from a checkout.
 */
async function bridgeCommand($: E): Promise<string[]> {
  const override = await $.env.get('SPHERE_BRIDGE')
  if (override) return override.split(' ')
  const home = (await $.env.get('SPHERE_HOME')) ?? `${await $.env.get('HOME')}/.sphere`
  if (await $.fs.exists(`${home}/bin/sphere`)) return [`${home}/bin/sphere`]
  return ['bun', `${$.plugin.root}/../sphere/src/cli.ts`]
}

// Subagents and teammates as last reported, by id → status.
const agentStatus = new Map<string, string>()

/**
 * Reconciles with the engine's own list. Catches what hooks miss: teammates, whose loops
 * don't pass through this session's turn.complete, and agents that were killed.
 */
async function reconcileAgents($: E) {
  let list: Awaited<ReturnType<E['agent']['list']>>
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const seen = new Set<string>()
  for (const a of list) {
    seen.add(a.id)
    const running = a.status === 'running'
    if (agentStatus.get(a.id) === a.status) continue
    const was = agentStatus.get(a.id)
    agentStatus.set(a.id, a.status)
    // A finished agent we never saw running isn't news.
    if (!running && (was === undefined || was !== 'running')) continue
    emit($, 'session.agent', {
      agentId: a.id,
      state: running ? 'running' : 'done',
      status: a.status,
      description: a.description,
      subagentType: a.type,
      background: true,
    })
  }
  for (const [id, status] of agentStatus) {
    if (seen.has(id)) continue
    agentStatus.delete(id)
    if (status === 'running') emit($, 'session.agent', { agentId: id, state: 'done', status: 'gone' })
  }
}

async function runBridge($: E, cwd: string, interactive: boolean) {
  const base = await bridgeCommand($)
  const argv = [...base, 'bridge', '--session', sessionId!, '--cwd', cwd, ...(interactive ? ['--interactive'] : [])]
  let buf = ''
  try {
    for await (const chunk of $.process.spawn({ argv })) {
      if (chunk.stream === 'stderr') {
        $.ui.log(chunk.text.trimEnd(), { to: 'debug' })
        continue
      }
      buf += chunk.text
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        void handle($, line)
      }
    }
    if (superseded) return // the session runs elsewhere now; nothing to restart for
    $.ui.status('bridge stopped, restarting')
  } catch (err) {
    $.ui.log(`sphere: bridge failed to start: ${(err as Error)?.message ?? err}`, { to: 'transcript' })
    $.ui.status('offline, retrying')
  }
  socket = null
  // Restart with backoff. A reload drops this timer along with the module.
  restarts++
  $.clock.after(Math.min(1000 * 2 ** restarts, 30_000), () => void runBridge($, cwd, interactive))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()
    interactive = e.isInteractive
    void runBridge($, e.cwd, e.isInteractive)
    $.clock.every(3000, () => void reconcileAgents($))
    return started
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    try {
      if (!sessionId) sessionId = await $.session.id()
      void rekeyIfCleared($)
      const { kind, text, thinking, tools, toolUseIds, calls, results, cut } = describe(e.message as any, e.door)
      const base = { uuid: stored.uuid ?? e.uuid, door: e.door, origin: e.origin.kind, agentId: e.agentId ?? null }
      // Its own row, before what the model wrote after it. Only a bridge that passes thinking on
      // gets it (see forPeer), and a thinking block the engine keeps without its text has none.
      if (thinking.trim()) {
        const clean = redact(thinking)
        emit($, 'session.row', { ...base, kind: 'thinking', summary: firstLine(clean), text: clean }, `row:${e.uuid}:thinking`)
      }
      if (text.trim()) {
        const clean = redact(text)
        emit($, 'session.row', {
          ...base,
          kind,
          summary: firstLine(clean),
          text: clean,
          ...(tools.length && { tools }),
          ...(toolUseIds.length && { toolUseIds }),
          ...(calls.length && { calls }),
          ...(results.length && { results }),
          ...(cut.length && { cut }),
        }, `row:${e.uuid}`)
      }
      if (e.door === 'prompt' && e.origin.kind === 'plugin') {
        // The engine may frame a plugin's prompt, so match on containment.
        for (const [sent, msgId] of awaiting) {
          if (!text.includes(sent)) continue
          awaiting.delete(sent)
          delivery($, msgId, 'observed', `row ${e.uuid}`)
          break
        }
      }
    } catch (err) {
      $.ui.log(`sphere: ${(err as Error)?.message ?? err}`, { to: 'debug' })
    }
    return stored
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    turnId = r.turnId
    await rekeyIfCleared($)
    emit($, 'session.status', { state: 'working', turnId })
    return r
  })

  // A reply as it streams, the main agent's or a subagent's: each time a paragraph completes, all
  // completed so far go to the bridge. Every chunk passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    const live = bridgeProtocol >= PARTIAL_REPLIES
    // `sent` is -1 once a block is past the limit: nothing more of it is sent.
    const blocks = new Map<number, { text: string; sent: number }>()
    for await (const c of stream) {
      yield c
      if (!live || c.kind !== 'text') continue
      try {
        const b = blocks.get(c.index) ?? { text: '', sent: 0 }
        blocks.set(c.index, b)
        if (b.sent < 0) continue
        b.text += c.text
        // A paragraph completes only at a line break.
        if (c.text.includes('\n')) {
          const done = completedParagraphs(b.text)
          if (done.length <= PARTIAL_TEXT_LIMIT && done.length > b.sent) {
            b.sent = done.length
            partial($, e.agentId, e.turnId, e.index, c.index, done)
          }
        }
        // Past the limit no more can be sent: the block is let go.
        if (b.text.length > PARTIAL_TEXT_LIMIT) Object.assign(b, { text: '', sent: -1 })
      } catch {}
    }
    return await stream.result
  })

  // Subagents: started here, finished by their own turn.complete (which carries agentId).
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) agentStatus.set(r.agentId, 'running')
    if (r.agentId)
      emit($, 'session.agent', {
        agentId: r.agentId,
        state: 'running',
        description: e.description,
        subagentType: e.subagentType,
        background: e.background,
        parentAgentId: e.parentAgentId ?? null,
      }, `agent:${r.agentId}:start`)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      // A subagent's run ended. The main loop's state and turn are untouched.
      agentStatus.set(e.agentId, 'completed')
      emit($, 'session.agent', { agentId: e.agentId, state: 'done', reason: e.reason })
      return r
    }
    turnId = null
    emit($, 'session.status', { state: 'idle', turnId: null, reason: e.reason })
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (waitingByTool.get(e.tool)?.size) await settleLocally($, e.tool)
    // Kept for the row that records the result; a call whose row never comes is forgotten later.
    if (e.tool_use_id && 'result' in r && r.result !== undefined && !r.isError) {
      results.set(e.tool_use_id, { tool: e.tool, output: r.result })
      if (results.size > 200) results.delete(results.keys().next().value!)
    }
    return r
  })

  // Fires where Claude Code would ask for permission. The dialog and this wait run side by
  // side if the engine allows it; whichever answers first decides.
  on('classic.PermissionRequest', async ($, e, next) => {
    const base = await next(e)
    if (base.decision || !socket || superseded) return base
    // Allowed in Dyson Sphere after the agent stopped waiting: the retry goes through once.
    const key = grantKey(e.tool_name, e.tool_input)
    const grant = grants.get(key)
    if (grant !== undefined) {
      grants.delete(key)
      if (grant > (await $.clock.now())) return { ...base, decision: { behavior: 'allow' as const } }
    }
    const wait = await permissionWait($)
    // Nobody can answer a headless session's dialog, so its request is held only as long as
    // whoever started it asked, and only while Dyson Sphere can show it to someone. Otherwise
    // Claude Code handles it as it would without the mod (a `claude -p` run denies it).
    if (wait === 0 || (!interactive && (wait === null || link !== 'connected'))) return base
    const d = await awaitPermission($, e.tool_name, e.tool_input, next.signal, wait)
    if (!d) return base
    return d.decision === 'allow'
      ? { ...base, decision: { behavior: 'allow' as const } }
      : { ...base, decision: { behavior: 'deny' as const, message: d.message ?? `Denied by ${d.by ?? 'the owner'} in Dyson Sphere` } }
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'clear') cleared = true
    else {
      emit($, 'session.ended', { reason: e.reason }, `${sessionId}:ended`)
      await flush($)
    }
    return r
  })
}
