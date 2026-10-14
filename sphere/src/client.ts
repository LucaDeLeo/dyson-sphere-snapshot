import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL, type ClientMessage, type ErrorCode, type PartialReply, type Role, type ServerMessage, type SessionSummary, type StoredEvent } from '../../shared/protocol'

export const SPHERE_HOME = process.env.SPHERE_HOME ?? join(homedir(), '.sphere')

export type Config = { url: string; token: string }

export async function loadConfig(): Promise<Config> {
  let file: Partial<Config> = {}
  try {
    file = await Bun.file(join(SPHERE_HOME, 'config.json')).json()
  } catch {}
  return {
    url: process.env.SPHERE_URL ?? file.url ?? 'ws://127.0.0.1:7420/ws',
    token: process.env.SPHERE_TOKEN ?? file.token ?? '',
  }
}

/** Why the server turned this client away: it speaks an older protocol. */
export const OUTDATED = 'this sphere is older than the server; update it by running dyson-sphere/install.sh in your 80k-coding-tools checkout'

export class CmdFailure extends Error {
  constructor(message: string, readonly code: ErrorCode | 'network') {
    super(message)
  }
}

type Handlers = {
  onEvent?: (ev: StoredEvent) => void
  onState?: (s: SessionSummary) => void
  onLive?: (topic: string, seq: number) => void
  /** A reply in progress, on a session topic this client subscribes to. */
  onPartial?: (p: PartialReply) => void
  /** Another Claude Code process took the session over. */
  onSuperseded?: (sessionId: string, machine: string) => void
  /** What to do with a session's terminal (bridges of protocol 5). */
  onTerm?: (m: Extract<ServerMessage, { t: 'term' }>) => void
  onClose?: () => void
}

/** One WebSocket connection to sphere-server. */
export class Client {
  private ws!: WebSocket
  private pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void }>()
  private n = 0
  identity = ''
  /** The server's protocol, from its welcome. Servers before 3 name none. */
  serverProtocol = 2

  constructor(private cfg: Config, private role: Role, private h: Handlers = {}) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.url)
      this.ws = ws
      let welcomed = false
      ws.onopen = () => this.raw({ t: 'hello', token: this.cfg.token, role: this.role, protocol: PROTOCOL })
      ws.onerror = () => {
        if (!welcomed) reject(new CmdFailure(`cannot reach ${this.cfg.url}`, 'network'))
      }
      ws.onclose = ev => {
        for (const p of this.pending.values()) p.reject(new CmdFailure('connection closed', 'network'))
        this.pending.clear()
        if (!welcomed)
          reject(
            ev.code === 4001
              ? new CmdFailure('unknown token', 'auth')
              : ev.code === 4002
                ? new CmdFailure(OUTDATED, 'other')
                : new CmdFailure(`connection closed (${ev.code})`, 'network'),
          )
        else this.h.onClose?.()
      }
      ws.onmessage = msg => {
        const m: ServerMessage = JSON.parse(String(msg.data))
        if (m.t === 'welcome') {
          welcomed = true
          this.identity = m.identity
          this.serverProtocol = m.protocol ?? 2
          resolve()
        } else if (m.t === 'res') {
          const p = this.pending.get(m.id)
          this.pending.delete(m.id)
          if (m.ok) p?.resolve(m.data)
          else p?.reject(new CmdFailure(m.error, m.code))
        } else if (m.t === 'ev') this.h.onEvent?.(m.ev)
        else if (m.t === 'state') this.h.onState?.(m.session)
        else if (m.t === 'live') this.h.onLive?.(m.topic, m.seq)
        else if (m.t === 'partial') this.h.onPartial?.(m.partial)
        else if (m.t === 'superseded') this.h.onSuperseded?.(m.sessionId, m.machine)
        else if (m.t === 'term') this.h.onTerm?.(m)
        else if (m.t === 'error') process.stderr.write(`server: ${m.error}\n`)
      }
    })
  }

  cmd<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = String(++this.n)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.raw({ t: 'cmd', id, op, args })
    })
  }

  sub(topic: string, since?: number) {
    this.raw({ t: 'sub', topic, since })
  }

  /** Relays a session's terminal to the server (bridges, protocol 5). */
  term(m: Extract<ClientMessage, { t: 'term' }>) {
    if (this.open) this.raw(m)
  }

  /** Bytes queued on the socket and not yet sent. */
  get buffered() {
    return this.ws?.bufferedAmount ?? 0
  }

  close() {
    this.ws.close()
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private raw(m: ClientMessage) {
    this.ws.send(JSON.stringify(m))
  }
}
