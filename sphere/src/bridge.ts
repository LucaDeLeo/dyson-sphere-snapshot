// `sphere bridge`: spawned by the mod for the life of a Claude Code session, or by a Codex
// session's first hook (see codex.ts).
//
// - Listens on a Unix socket for events the mod forwards (transcript rows, status, deliveries),
//   or for Codex's hook events.
// - Keeps them in a local outbox file and sends them to sphere-server in batches; an event
//   leaves the outbox only when the server acknowledges it.
// - Receives commands for the session and writes each one to stdout as a JSON line for the mod.
//   A Codex session's commands wait in the bridge for a hook to take them.
// - Speaks for one agent process (Claude Code, its parent; Codex, named by --pid). When another
//   process takes the session over (a move, or a second `claude --resume`), the server says so
//   and the bridge goes quiet.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { forPeer } from '../../shared/rows'
import { cleanLabels, PARTIAL_REPLIES, PROTOCOL, topics, type AgentKind, type IngestEvent, type IngestResult, type ServerMessage, type SessionCommand } from '../../shared/protocol'
import { validSize } from '../../shared/terminal'
import { Client, CmdFailure, loadConfig, OUTDATED, SPHERE_HOME } from './client'
import { createCodex } from './codex'
import { paneOf, TmuxPane } from './terminal'
import { sessionTicket } from './ticket'

type Args = { session: string; socket: string | null; cwd: string; interactive: boolean; agent: AgentKind; pid: number | null; transcript: string | null }

const log = (...a: unknown[]) => process.stderr.write(`[bridge] ${a.join(' ')}\n`)

/** The Claude Code process a bridge speaks for, as the server knows it. */
const holderFor = (agentPid: number) => `${hostname()}:${agentPid}`

/** One folder per session and Claude Code process: two processes can resume the same session. */
/**
 * One end per process: a resumed session ends again under its new process, and an
 * idempotency key shared across processes would drop that second end.
 */
const endedKey = (sessionId: string, holder: string) => `${sessionId}:${holder}:ended`

const sessionDir = (sessionId: string, agentPid: number) => join(SPHERE_HOME, 'sessions', `${sessionId}.${agentPid}`)
const out = (m: Record<string, unknown>) => process.stdout.write(JSON.stringify(m) + '\n')

/**
 * How long one `/permission/wait` poll is held, in ms: 8 s (under Bun's 10 s idle timeout),
 * or what is left of the mod's wait when it says (`timeout`; older mods send none). A wait
 * that has already run out isn't held at all.
 */
export function pollHold(timeout: unknown): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout)) return 8_000
  return Math.min(8_000, Math.max(0, timeout))
}

/** Events not yet acknowledged by the server, kept in a file so they survive a crash. */
export class Outbox {
  events: IngestEvent[] = []
  constructor(readonly file: string) {
    try {
      this.events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch {}
  }

  push(e: IngestEvent) {
    this.events.push(e)
    appendFileSync(this.file, JSON.stringify(e) + '\n')
  }

  ack(keys: string[]) {
    const done = new Set(keys)
    this.events = this.events.filter(e => !done.has(e.key))
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, this.events.map(e => JSON.stringify(e) + '\n').join(''))
    renameSync(tmp, this.file)
  }

  /**
   * Takes the server's answer to a batch. An event the server can never store (bad data) goes
   * to dead-letter.jsonl beside the outbox before it leaves, so the events behind it can go.
   * It isn't sent again, so it's logged once. One already there (sent again by a bridge that
   * stopped before it could ack, or by the reaper and another bridge's sweep) isn't repeated.
   */
  settle(r: IngestResult) {
    const refused = new Map((r.rejected ?? []).map(x => [x.key, x.error]))
    const file = join(dirname(this.file), 'dead-letter.jsonl')
    const kept = new Set<string>()
    if (refused.size && existsSync(file))
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean))
        try {
          kept.add(JSON.parse(line).event.key)
        } catch {}
    const dead = this.events.filter(e => refused.has(e.key) && !kept.has(e.key))
    if (dead.length) {
      const at = new Date().toISOString()
      appendFileSync(file, dead.map(e => JSON.stringify({ at, error: refused.get(e.key), event: e }) + '\n').join(''))
      for (const e of dead) log(`set aside ${e.type} ${JSON.stringify(e.key)} in dead-letter.jsonl: the server can't store it (${refused.get(e.key)})`)
    }
    this.ack([...r.acked, ...refused.keys()])
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Starts `sphere reap`, detached so it outlives us: Claude Code kills the bridge outright on
 * exit, before anything here or in the mod can report the end.
 */
function startReaper(sessionId: string, agentPid: number) {
  const lock = join(sessionDir(sessionId, agentPid), 'reaper')
  try {
    if (pidAlive(Number(readFileSync(lock, 'utf8')))) return // one per session, across reloads
  } catch {}
  const self = process.argv[1]?.endsWith('.ts') ? [process.argv[1]] : []
  const argv = [process.execPath, ...self, 'reap', '--session', sessionId, '--pid', String(agentPid), '--lock', lock]
  // Double fork: the shell exits at once, so the reaper is re-parented to init and is no
  // longer a descendant of Claude Code, which kills its whole process tree on exit.
  const sh = spawn('/bin/sh', ['-c', 'nohup "$@" >/dev/null 2>&1 &', 'sphere-reap', ...argv], { detached: true, stdio: 'ignore', env: process.env })
  sh.unref()
}

/**
 * Sends the start of an outbox, as the server it's connected to takes it (a server before
 * structured rows gets them without their new fields, and no thinking rows; those count as sent).
 * Returns the server's answer, or null when nothing was left to send. Clears what was sent, and
 * sets aside what the server refused (`Outbox.settle`).
 */
export async function sendFrom(client: Client, box: Outbox): Promise<IngestResult | null> {
  const batch = box.events.slice(0, 100)
  const { events, dropped } = forPeer(batch, client.serverProtocol)
  if (dropped.length) box.ack(dropped)
  if (!events.length) return dropped.length ? { acked: dropped } : null
  const r = await client.cmd<IngestResult>('ingest', { events })
  box.settle(r)
  return { ...r, acked: [...dropped, ...r.acked] }
}

/** `sphere reap`: waits for Claude Code to exit, then records the session's end. */
export async function runReaper(sessionId: string, agentPid: number, lock: string | null) {
  if (lock) writeFileSync(lock, String(process.pid))
  while (pidAlive(agentPid)) await Bun.sleep(1000)
  const box = new Outbox(join(sessionDir(sessionId, agentPid), 'outbox.jsonl'))
  // If the session moved on to another process meanwhile, the server drops this.
  const key = endedKey(sessionId, holderFor(agentPid))
  if (!box.events.some(e => e.key === key)) box.push({ key, type: 'session.ended', data: { sessionId, reason: 'exit' }, holder: holderFor(agentPid) })
  try {
    const c = new Client(await loadConfig(), 'bridge')
    await c.connect()
    while (box.events.length) if (!(await sendFrom(c, box))?.acked.length) break
    c.close()
  } catch {
    // Offline: the event stays in the outbox and the next bridge on this machine sends it.
  }
  process.exit(0)
}

/** Sends outboxes left behind by bridges that died before their events reached the server. */
async function sweepOrphans(client: Client, self: string) {
  const root = join(SPHERE_HOME, 'sessions')
  if (!existsSync(root)) return
  for (const id of readdirSync(root)) {
    if (join(root, id) === self) continue
    let pid = 0
    try {
      pid = Number(readFileSync(join(root, id, 'pid'), 'utf8').trim()) || 0
    } catch {}
    if (pid && pidAlive(pid)) continue
    const box = new Outbox(join(root, id, 'outbox.jsonl'))
    while (box.events.length) if (!(await sendFrom(client, box))?.acked.length) break
    if (!box.events.length) log(`sent orphaned outbox of ${id.slice(0, 8)}`)
  }
}

function git(cwd: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'ignore' })
  return r.success ? r.stdout.toString().trim() || null : null
}

export async function runBridge(a: Args) {
  const cfg = await loadConfig()
  let sessionId = a.session
  // Claude Code is our parent. Codex isn't: its hook started us, detached, and named it.
  const agentPid = a.pid ?? process.ppid
  const holder = holderFor(agentPid)
  const dir = (id: string) => {
    const d = sessionDir(id, agentPid)
    mkdirSync(d, { recursive: true })
    return d
  }
  let outbox = new Outbox(join(dir(sessionId), 'outbox.jsonl'))
  const claimPid = (id: string) => writeFileSync(join(dir(id), 'pid'), String(process.pid))
  claimPid(sessionId)
  startReaper(sessionId, agentPid)
  const cursorFile = (id: string) => join(dir(id), 'cursor')
  const readCursor = async (id: string) => Number((await Bun.file(cursorFile(id)).text().catch(() => '0')) || 0)
  // The cursor is the last command seq this session no longer needs replayed: one handed to
  // the mod counts only once the mod reports it (injected, observed or failed), so a bridge
  // that dies in between replays it on restart.
  let cursor = await readCursor(sessionId)
  let highest = cursor
  const unacked = new Map<string, number>() // msgId → seq
  // Commands finished past the cursor (one behind an unfinished one), kept on disk as
  // "seq msgId" lines: a restart replays from the cursor and must skip these.
  const doneFile = (id: string) => join(dir(id), 'done')
  const readDone = (id: string) =>
    new Set(
      (existsSync(doneFile(id)) ? readFileSync(doneFile(id), 'utf8') : '')
        .split('\n')
        .map(l => l.split(' '))
        .filter(([seq, msgId]) => msgId && Number(seq) > cursor)
        .map(([, msgId]) => msgId!),
    )
  const finish = (msgId: string, seq: number) => appendFileSync(doneFile(sessionId), `${seq} ${msgId}\n`)
  const advance = async () => {
    const floor = unacked.size ? Math.min(...unacked.values()) - 1 : highest
    if (floor <= cursor) return
    cursor = floor
    await Bun.write(cursorFile(sessionId), String(floor))
    // What the cursor now covers needn't be remembered.
    const keep = existsSync(doneFile(sessionId)) ? readFileSync(doneFile(sessionId), 'utf8').split('\n').filter(l => Number(l.split(' ')[0]) > floor) : []
    writeFileSync(doneFile(sessionId), keep.map(l => l + '\n').join(''))
  }
  const seen = readDone(sessionId)
  // Set when another Claude Code process took the session over: nothing more is reported.
  let supersededBy: string | null = null

  const event = (type: string, data: Record<string, unknown>, key?: string) => {
    if (!supersededBy) outbox.push({ key: key ?? crypto.randomUUID(), type, data: { sessionId, ...data }, holder })
  }

  // estra's labels reach us through the agent's environment, which we inherit.
  const labels = cleanLabels({
    ticket: process.env.ESTRA_TICKET,
    stage: process.env.ESTRA_STAGE,
    taskId: process.env.ESTRA_TASK_ID,
    provider: process.env.ESTRA_PROVIDER,
  })
  // The tmux pane the agent runs in, if any: a terminal card shows it (protocol 5).
  const pane = paneOf()
  let terminal: TmuxPane | null = null
  const started = () => {
    const repoRoot = git(a.cwd, 'rev-parse', '--show-toplevel')
    event('session.started', {
      machine: hostname(),
      cwd: a.cwd,
      repo: repoRoot ? basename(repoRoot) : null,
      branch: git(a.cwd, 'branch', '--show-current'),
      pid: agentPid,
      interactive: a.interactive,
      ...(a.agent === 'codex' && { agent: 'codex' }),
      ...(labels && { labels }),
      ticket: sessionTicket(a.cwd, labels?.ticket),
      ...(pane && { terminal: 'tmux' }),
    })
  }
  started()

  // --- connection to sphere-server, with reconnects ---
  let client: Client | null = null
  let inflight = false

  // Permission decisions: the mod keeps a request open on /permission/wait until one arrives.
  type Decision = { decision: 'allow' | 'deny' | 'pending' | 'cancelled'; by?: string; message?: string | null; msgId?: string }
  const decisions = new Map<string, Decision>()
  const waiters = new Map<string, (d: Decision) => void>()
  // Requests the mod stopped waiting for: a later decision goes to the mod, which tells the agent.
  const deferred = new Set<string>()

  /** A command the agent was handed (or that failed): no need to replay it on a restart. */
  const settled = (msgId: string) => {
    const seq = unacked.get(msgId)
    if (seq === undefined) return
    unacked.delete(msgId)
    finish(msgId, seq)
    void advance()
  }

  const codex =
    a.agent === 'codex'
      ? createCodex(
          {
            sessionId: () => sessionId,
            event,
            settled,
            connected: () => !!client?.open && !supersededBy,
            awaitDecision: async (reqId, ms) => {
              const known = decisions.get(reqId)
              if (known) return decisions.delete(reqId), known
              const d = await Promise.race([new Promise<Decision>(resolve => waiters.set(reqId, resolve)), Bun.sleep(ms).then(() => null)])
              waiters.delete(reqId)
              return d
            },
            end: reason => {
              event('session.ended', { reason }, endedKey(sessionId, holder))
              void shutdown()
            },
          },
          a.transcript,
          join(dir(sessionId), 'handed'),
        )
      : null

  const onCommand = async (seq: number, command: SessionCommand | null) => {
    highest = Math.max(highest, seq)
    if (!command || seen.has(command.msgId)) return advance()
    seen.add(command.msgId)
    if (command.kind === 'permission') {
      const d: Decision = { decision: command.decision, by: command.by, message: command.message, msgId: command.msgId }
      const wake = waiters.get(command.reqId)
      if (wake) wake(d)
      else if (deferred.has(command.reqId)) {
        unacked.set(command.msgId, seq)
        out({ ...command, sessionId })
        return advance()
      } else decisions.set(command.reqId, d)
      finish(command.msgId, seq)
      return advance()
    }
    unacked.set(command.msgId, seq)
    if (codex) {
      event('delivery', { msgId: command.msgId, state: 'at-bridge' }, `${command.msgId}:at-bridge`)
      codex.command(command)
      return advance()
    }
    out({ ...command, sessionId })
    event('delivery', { msgId: command.msgId, state: 'at-bridge' }, `${command.msgId}:at-bridge`)
    return advance()
  }

  /**
   * The server's word on the session's terminal: attach to the pane while someone watches. Only
   * this session's own pane; the server lets only the session's owner type or resize.
   */
  const onTerm = (m: Extract<ServerMessage, { t: 'term' }>) => {
    if (m.sessionId !== sessionId || supersededBy) return
    const c = client
    if (!pane) {
      if (m.op !== 'close') c?.term({ t: 'term', sessionId, op: 'closed', reason: "This session doesn't run in tmux." })
      return
    }
    if (m.op === 'close') {
      terminal?.close()
      return
    }
    terminal ??= new TmuxPane(pane, {
      send: out => client?.term({ t: 'term', sessionId, ...out }),
      buffered: () => client?.buffered ?? 0,
      log,
    })
    if (m.op === 'open') void terminal.start()
    else if (m.op === 'snapshot') void (terminal.open ? terminal.snapshot() : terminal.start())
    else if (m.op === 'in' && typeof m.d === 'string') terminal.input(m.d, { binary: m.binary === true, paste: m.paste === true })
    else if (m.op === 'fit' && validSize(m.cols, m.rows)) terminal.fit(m.cols, m.rows)
  }

  /** Another process runs the session now. Stays alive, so the mod doesn't restart it. */
  const goQuiet = (machine: string) => {
    if (supersededBy) return
    terminal?.close()
    supersededBy = machine
    codex?.quiet()
    outbox.ack(outbox.events.map(e => e.key))
    log(`session now runs on ${machine}; this terminal is no longer reported`)
    out({ kind: 'superseded', sessionId, machine })
    client?.close()
  }

  const connect = async () => {
    const c = new Client(cfg, 'bridge', {
      onEvent: ev => {
        // Commands name the process they're for; older ones were for another process. (The
        // server issues none without a holder: see `heldBy` in server/src/main.ts.)
        if (ev.type !== 'command.issued' || ev.data.sessionId !== sessionId) return
        void onCommand(ev.seq, ev.data.holder === holder ? (ev.data.command as SessionCommand) : null)
      },
      onSuperseded: (id, machine) => {
        if (id === sessionId) goQuiet(machine)
      },
      onTerm,
      onClose: () => {
        client = null
        // Nobody can watch through a closed connection; the server asks again once it's back.
        terminal?.close()
        if (supersededBy) return
        log('disconnected')
        out({ kind: 'status', text: 'offline, reconnecting' })
        setTimeout(reconnect, 1000)
      },
    })
    await c.connect()
    client = c
    try {
      await c.cmd('attach', { sessionId, holder })
    } catch (e) {
      if (e instanceof CmdFailure && e.code === 'conflict') return goQuiet(e.message.replace(/^.* now runs on /, ''))
      throw e
    }
    c.sub(topics.bridge(sessionId), cursor)
    log(`connected as ${c.identity}`)
    out({ kind: 'status', text: 'connected' })
    sweepOrphans(c, dir(sessionId)).catch(e => log(`sweep failed: ${(e as Error).message}`))
  }

  let backoff = 500
  const reconnect = async () => {
    try {
      await connect()
      backoff = 500
    } catch (e) {
      log(`connect failed: ${(e as Error).message}`)
      if ((e as Error).message === OUTDATED) {
        // Retrying can't help until it's updated; the session's status line says so.
        out({ kind: 'status', text: 'out of date: run dyson-sphere/install.sh in your 80k-coding-tools checkout, then restart this session' })
        return
      }
      backoff = Math.min(backoff * 2, 10_000)
      setTimeout(reconnect, backoff)
    }
  }

  const sendBatch = async () => {
    if (!client?.open || inflight || outbox.events.length === 0) return
    inflight = true
    try {
      const elsewhere = (await sendFrom(client, outbox))?.superseded?.[sessionId]
      if (elsewhere !== undefined) goQuiet(elsewhere || 'another machine')
    } catch (e) {
      log(`ingest failed: ${(e as Error).message}`)
    } finally {
      inflight = false
    }
  }
  setInterval(sendBatch, 150)

  // Killed when the mod unloads or Claude Code exits: try briefly to send what is left.
  // Anything still unsent stays in the outbox file for the next bridge to sweep.
  let ending = false
  const shutdown = async () => {
    if (ending) return
    ending = true
    terminal?.close()
    // A mod reload stops us while Claude Code keeps running; an exit takes Claude Code with it.
    // The mod's own session.end report doesn't survive an exit, so we record the end here.
    const settle = Date.now() + 500
    while (Date.now() < settle && pidAlive(agentPid)) await Bun.sleep(100)
    if (!pidAlive(agentPid)) event('session.ended', { reason: 'exit' }, endedKey(sessionId, holder))
    const deadline = Date.now() + 2000
    while (outbox.events.length && client?.open && Date.now() < deadline) {
      await sendBatch()
      await Bun.sleep(50)
    }
    // The next Codex hook starts a new bridge if the session goes on.
    if (codex) for (const ext of ['.secret', '.lock']) rmSync(join(SPHERE_HOME, 'run', `${a.session.slice(0, 12)}.${agentPid}${ext}`), { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // --- the mod's side: a Unix socket in a private directory, plus a secret only the mod sees ---
  const runDir = join(SPHERE_HOME, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  chmodSync(runDir, 0o700)
  // Per process, like the session folder: two processes can run one session.
  const socket = a.socket ?? join(runDir, `${a.session.slice(0, 12)}.${agentPid}.sock`)
  const secret = crypto.randomUUID()
  rmSync(socket, { force: true })
  Bun.serve({
    unix: socket,
    async fetch(req, server) {
      if (req.headers.get('x-sphere-secret') !== secret) return new Response('forbidden', { status: 403 })
      const url = new URL(req.url)
      if (url.pathname === '/codex/hook' && req.method === 'POST' && codex) {
        const { event: name, payload } = (await req.json()) as { event: string; payload: Record<string, unknown> }
        // A permission request is held for as long as its wait, past Bun's 10 s idle timeout.
        if (name === 'PermissionRequest') server.timeout(req, 0)
        const answer = await codex.hook(name, payload ?? {}, () => req.signal.aborted)
        return answer ? Response.json(answer) : new Response(null, { status: 204 })
      }
      if (url.pathname === '/partial' && req.method === 'POST') {
        // A reply in progress: passed straight on, never kept. Lost while offline, which is fine:
        // the finished row follows through the outbox.
        const p = (await req.json()) as Record<string, unknown>
        if (client?.open && client.serverProtocol >= PARTIAL_REPLIES && !supersededBy)
          void client.cmd('partial', { agentId: p.agentId, turnId: p.turnId, step: p.step, block: p.block, text: p.text, sessionId, holder }).catch(() => {})
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/events' && req.method === 'POST') {
        const body = (await req.json()) as { events: { type: string; data: Record<string, unknown>; key?: string }[] }
        for (const e of body.events) {
          // The mod doesn't know its process; its end is keyed per process here.
          const key = e.type === 'session.ended' && e.key === `${e.data.sessionId}:ended` ? endedKey(String(e.data.sessionId), holder) : e.key
          event(e.type, e.data, key)
          if (e.type === 'delivery' && ['injected', 'observed', 'failed'].includes(String(e.data.state))) settled(String(e.data.msgId))
          if (e.type === 'permission.resolved' && e.data.decision === 'deferred') {
            const reqId = String(e.data.reqId)
            deferred.add(reqId)
            // Decided just as the mod gave up waiting: pass it on now.
            const d = decisions.get(reqId)
            if (d && (d.decision === 'allow' || d.decision === 'deny')) {
              decisions.delete(reqId)
              out({ kind: 'permission', msgId: d.msgId ?? `late_${reqId}`, reqId, decision: d.decision, by: d.by, message: d.message ?? null, sessionId })
            }
          }
        }
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/permission/wait' && req.method === 'POST') {
        // Held for `pollHold`; the mod asks again on `pending`.
        // Time the mod spends awaiting this isn't charged to its hook budget.
        const { reqId, timeout } = (await req.json()) as { reqId: string; timeout?: number }
        const hold = pollHold(timeout)
        const known = decisions.get(reqId)
        if (known) {
          decisions.delete(reqId)
          return Response.json(known)
        }
        const d = await Promise.race([
          new Promise<Decision>(resolve => waiters.set(reqId, resolve)),
          Bun.sleep(hold).then((): Decision => ({ decision: 'pending' })),
        ])
        waiters.delete(reqId)
        return Response.json(d)
      }
      if (url.pathname === '/permission/cancel' && req.method === 'POST') {
        // Answered in the terminal: release the held wait now rather than at its 8 s timeout.
        const { reqId } = (await req.json()) as { reqId: string }
        waiters.get(reqId)?.({ decision: 'cancelled' })
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/rekey' && req.method === 'POST') {
        // /clear gives the conversation a new session id; the process and this bridge stay.
        const { sessionId: next } = (await req.json()) as { sessionId: string }
        if (next && next !== sessionId) {
          event('session.ended', { reason: 'clear', next })
          const old = outbox
          const pending = [...old.events]
          sessionId = next
          outbox = new Outbox(join(dir(sessionId), 'outbox.jsonl'))
          for (const e of pending) outbox.push(e)
          old.ack(pending.map(e => e.key))
          claimPid(sessionId)
          startReaper(sessionId, agentPid)
          cursor = await readCursor(sessionId)
          highest = cursor
          unacked.clear()
          seen.clear()
          for (const id of readDone(sessionId)) seen.add(id)
          started()
          client?.close() // reconnect attaches and subscribes under the new id
        }
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/health') return Response.json({ sessionId, holder, outbox: outbox.events.length, connected: !!client?.open, supersededBy })
      return new Response('not found', { status: 404 })
    },
  })

  // The agent crashed or exited without stopping us: Claude Code's bridge has been orphaned;
  // Codex's (never its child) watches the process itself.
  setInterval(() => {
    if (codex ? !pidAlive(agentPid) : process.ppid !== agentPid) {
      log('parent gone, exiting')
      void shutdown()
    }
  }, 1000)

  chmodSync(socket, 0o600)
  if (codex) {
    // Codex's hooks find the secret beside the socket, in our private run directory.
    writeFileSync(socket.replace(/\.sock$/, '.secret'), secret, { mode: 0o600 })
    codex.follow()
  } else {
    // stdout is a pipe only the mod reads, so the secret travels there.
    // `protocol`: what this bridge passes on, so a newer mod knows which rows it can send.
    out({ kind: 'ready', sessionId, socket, secret, protocol: PROTOCOL })
  }
  await reconnect()
}
