#!/usr/bin/env bun
// sphere: the CLI for people and agents, and the bridge the mod spawns.
import { labelTicket, topics, type SessionSummary, type SessionTicket, type StoredEvent, type Ticket } from '../../shared/protocol'
import { runBridge, runReaper } from './bridge'
import { Client, CmdFailure, loadConfig, SPHERE_HOME } from './client'
import { defaultCodexHome, runCodexHook, trustCodexHooks, writeCodexHooks } from './codex'
import { move } from './move'

const EXIT = { ok: 0, user: 1, network: 2, auth: 3, other: 4, conflict: 5 } as const

const TREE = `sphere — watch and steer Claude Code sessions across the team

  status [--all]                          live sessions: owner, machine, repo, state, ticket, last action
  sessions [--ticket <id>] [--repo <name>] [--all]
                                          the same, only those working on that ticket or in that repo
  show <session> [--tail N] [--before SEQ] [--full]   recent transcript rows (or those before row SEQ) and deliveries
  watch [<session>|--all]                 stream events as NDJSON until interrupted
  wait <session> --until idle|turn-end    block until the session reaches that state
  wait --msg <msgId> --until observed     block until a message reaches that delivery state
       [--timeout 30m]
  send <session> <text|-> [--mode queue|steer|interrupt]   owner or trusted agent only
  suggest <session> <text|-> [--mode ...] goes to the owner for approval
  interrupt <session>                     cancel the running turn (owner or trusted)
  fill <session> <text|->                 put text in the owner's prompt box
  approvals [--all]                       pending suggestions on your sessions
  approve <suggestion> [--edit <text|->]  send it, optionally edited
  reject <suggestion>
  permissions [--all]                     tool calls waiting for your permission
  allow <reqId> | deny <reqId> [--message <text>]   decide one (owner only)
  delivery <msgId>                        delivery state of one message
  linear [connect|disconnect]             your Linear account: whether it's connected, a link to
                                          connect it (open it in your browser), or disconnect it
  ticket set [<id>] [--session <s>] [--status <name>] [--assignee <name|me|none>] [--title <text|->]
                                          change a ticket in Linear, as you (or, for an agent the
                                          session's owner trusts, as the owner: that session's ticket only)
  ticket new --team <key> --title <text> [--description <text|->] [--session <s>]
                                          make a ticket; with --session, it becomes that session's
  ticket attach <id> --session <s>        make an existing ticket that session's (owner or trusted;
                                          not a session estra started for a ticket)
  ticket comment [<id>] [--session <s>] --body <text|->   comment on a ticket, as for set
  ticket options [<id>] [--session <s>]   the statuses and people a ticket can be set to
  move <session> --to <dir> [--launch] [--plugin-dir <dir>]
                                          hand an idle session to another checkout
  guide                                   how agents should use sphere
  bridge --session <id> --cwd <dir>      (started by the mod, or by a Codex hook with --agent codex)
  codex-hook <Event>                      (run by Codex's hooks)
  codex-install [--codex-home <dir>]      add Dyson Sphere's hooks to Codex and trust them

Sessions accept a unique id prefix of 4+ characters.
Output is JSON when stdout is not a terminal or with --json.
Exit codes: 0 ok, 1 user error, 2 network, 3 auth, 4 other, 5 conflict (re-read, then retry).
Config: SPHERE_URL, SPHERE_TOKEN, or ~/.sphere/config.json {"url","token"}.`

const GUIDE = `How to use sphere as an agent

1. Look before acting: \`sphere status\` lists every live session. Each has an id, owner,
   state (working, idle, ended), the ticket it works on and its last action.
   \`sphere sessions --ticket CS-123\` lists only the sessions on that ticket; in JSON, each
   session's \`ticket\` carries the ticket's title, status and assignee from Linear.
2. Read a session with \`sphere show <id> --tail 20\`. Long tool output is truncated;
   add --full only when you need it.
3. Never poll. Use \`sphere wait <id> --until idle\` or \`--until turn-end\` to block until
   something changes, and \`sphere watch <id>\` for a stream.
4. To message a session you don't own, use \`sphere suggest\`. The owner approves, edits or
   rejects it. \`sphere send\` works only on your own sessions or where the owner trusts you.
5. Every message gets a msgId. \`sphere wait --msg <msgId> --until observed\` blocks until the
   agent has it in its transcript. "queued" or "at-bridge" means it has not arrived yet.
6. Modes: queue (deliver when idle), steer (inject into the running turn), interrupt
   (cancel the turn, then deliver).
7. Exit code 5 means the state changed under you: re-read, then decide again.
8. Tickets: \`sphere ticket set --session <id> --status "In Review"\` moves your session's ticket in
   Linear; \`sphere ticket new --team CS --title "..." --session <id>\` makes one for it. Changes are
   made through a person's own Linear account: yours if you're a person who has connected one,
   otherwise your session owner's, if they trust you (SPHERE_TRUST), and then only for that
   session. Exit code 3 means nobody suitable has connected Linear: ask the owner to.`

type Flags = Record<string, string | boolean>

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) pos.push(a)
    else {
      const name = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--') && !['all', 'json', 'full', 'interactive', 'launch'].includes(name)) (flags[name] = next), i++
      else flags[name] = true
    }
  }
  return { pos, flags }
}

const asJson = (f: Flags) => f.json === true || !process.stdout.isTTY
const print = (f: Flags, data: unknown, human: () => string) => console.log(asJson(f) ? JSON.stringify(data) : human())

async function bodyText(t: string | undefined): Promise<string | undefined> {
  return t === '-' ? (await Bun.stdin.text()).trimEnd() : t
}

const ago = (iso: string | null) => {
  if (!iso) return 'unknown'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

function table(rows: string[][]) {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)))
  return rows.map(r => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n')
}

type Tickets = Record<string, Ticket>

/** A session's ticket. A server from before tickets knows only estra's label. */
const ticketRef = (s: SessionSummary): SessionTicket | null => s.ticket ?? labelTicket(s.labels)

/** A session as agents read it: its ticket with what Linear says about it, when the server knows. */
const withTicket = (s: SessionSummary, tickets: Tickets) => {
  const ref = ticketRef(s)
  return { ...s, ticket: ref && { ...ref, ...tickets[ref.id] } }
}

const HEAD = ['ID', 'OWNER', 'MACHINE', 'REPO', 'STATE', 'TICKET', 'ASKS', 'ACTIVE', 'LAST ACTION']
const sessionRow = (s: SessionSummary, tickets: Tickets) => {
  const ref = ticketRef(s)
  const status = ref && tickets[ref.id]?.status.name
  return [
    s.id.slice(0, 8),
    s.owner,
    s.machine,
    s.repo ?? '-',
    s.connected ? s.state : `${s.state} (offline)`,
    ref ? `${ref.id}${status ? ` ${status}` : ''}` : '-',
    [s.pendingPermissions ? `${s.pendingPermissions} perm` : '', s.pendingSuggestions ? `${s.pendingSuggestions} sugg` : ''].filter(Boolean).join(', '),
    ago(s.lastActivityAt),
    (s.lastSummary ?? '').slice(0, 60),
  ]
}

function duration(s: string | boolean | undefined): number {
  if (typeof s !== 'string') return 30 * 60_000
  const m = s.match(/^(\d+)(s|m|h)?$/)
  if (!m) throw new CmdFailure(`bad duration ${s}`, 'user')
  return Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 's' | 'm' | 'h'])
}

/** A server from before a command answers `unknown op`: say what that means. */
const newerServer = (op: string) => (e: unknown) => {
  if (e instanceof CmdFailure && /^unknown op /.test(e.message)) throw new CmdFailure(`this Dyson Sphere server is older than ${op}; it needs updating`, 'user')
  throw e
}

const DELIVERY_ORDER = ['queued', 'at-bridge', 'injected', 'observed']

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parse(rest)

  if (!cmd || cmd === '--help' || cmd === 'help') return console.log(TREE)
  if (cmd === 'guide') return console.log(GUIDE)
  if (cmd === 'reap') return runReaper(String(flags.session), Number(flags.pid), typeof flags.lock === 'string' ? flags.lock : null)
  if (cmd === 'bridge') {
    if (typeof flags.session !== 'string') throw new CmdFailure('bridge needs --session', 'user')
    return runBridge({
      session: flags.session,
      socket: typeof flags.socket === 'string' ? flags.socket : null,
      cwd: String(flags.cwd ?? process.cwd()),
      interactive: flags.interactive === true,
      agent: flags.agent === 'codex' ? 'codex' : 'claude',
      pid: typeof flags.pid === 'string' ? Number(flags.pid) || null : null,
      transcript: typeof flags.transcript === 'string' ? flags.transcript : null,
    })
  }
  if (cmd === 'codex-hook') {
    await runCodexHook(pos[0] ?? '', typeof flags.pid === 'string' ? Number(flags.pid) || null : null)
    process.exit(0) // a hook never fails
  }
  if (cmd === 'codex-install') {
    const home = typeof flags['codex-home'] === 'string' ? flags['codex-home'] : defaultCodexHome()
    const bin = typeof flags.bin === 'string' ? flags.bin : process.execPath
    const { file, changed } = writeCodexHooks(home, bin, SPHERE_HOME)
    let trust = 'not checked'
    try {
      const t = await trustCodexHooks(home)
      trust = `${t.trusted} of ${t.total} trusted`
    } catch (err) {
      trust = `couldn't be set (${(err as Error).message}); open Codex and approve the Dyson Sphere hooks in /hooks`
    }
    print(flags, { file, changed, trust }, () => `${changed ? 'Updated' : 'Checked'} ${file}; hooks ${trust}.`)
    return
  }

  const cfg = await loadConfig()
  let closing = false
  const events: ((ev: StoredEvent) => void)[] = []
  const states: ((s: SessionSummary) => void)[] = []
  const c = new Client(cfg, 'cli', {
    onEvent: ev => events.forEach(f => f(ev)),
    onState: s => states.forEach(f => f(s)),
    onClose: () => closing || process.exit(EXIT.network),
  })
  await c.connect()

  switch (cmd) {
    case 'status':
    case 'sessions': {
      const r = await c.cmd<{ sessions: SessionSummary[]; tickets?: Tickets }>('status', { all: flags.all === true })
      const tickets = r.tickets ?? {}
      if (flags.ticket === true) throw new CmdFailure('--ticket needs a ticket id, such as CS-2488', 'user')
      // Filtered here, so it works with a server from before tickets too.
      const ticket = typeof flags.ticket === 'string' ? flags.ticket.toUpperCase() : null
      const sessions = r.sessions.filter(s => (!ticket || ticketRef(s)?.id.toUpperCase() === ticket) && (typeof flags.repo !== 'string' || s.repo === flags.repo))
      const about = ticket && tickets[ticket]
      print(flags, sessions.map(s => withTicket(s, tickets)), () =>
        [
          ...(about ? [`${about.id} ${about.title} (${[about.status.name, about.assignee].filter(Boolean).join(', ')})`, ''] : []),
          sessions.length ? table([HEAD, ...sessions.map(s => sessionRow(s, tickets))]) : ticket ? `No live sessions on ${ticket}.` : 'No live sessions.',
        ].join('\n'),
      )
      break
    }
    case 'show': {
      // `--before` with no seq after it parses as true.
      const before = flags.before === undefined ? undefined : typeof flags.before === 'string' ? Number(flags.before) : NaN
      if (before !== undefined && !(Number.isSafeInteger(before) && before > 0)) throw new CmdFailure('--before takes a row seq', 'user')
      const r = await c.cmd('show', { sessionId: pos[0], tail: Number(flags.tail ?? 50), ...(before !== undefined && { before }) })
      if (flags.full) for (const row of r.rows) if (row.data.bodyId) row.data.text = (await c.cmd('body', { id: row.data.bodyId })).text
      const tickets: Tickets = r.tickets ?? {}
      r.session = withTicket(r.session, tickets)
      delete r.tickets
      print(flags, r, () =>
        [
          table([HEAD, sessionRow(r.session, tickets)]),
          '',
          ...(r.more && r.rows.length ? [`(older rows: sphere show ${pos[0]} --before ${r.rows[0].seq})`] : []),
          ...r.rows.map((e: StoredEvent) => `${e.at.slice(11, 19)} ${String(e.data.kind).padEnd(11)} ${flags.full ? e.data.text : e.data.summary}`),
          ...(r.deliveries.length ? ['', 'Messages:', ...r.deliveries.map((d: any) => `  ${d.msgId} ${d.state.padEnd(9)} from ${d.author}: ${(d.text ?? d.kind).slice(0, 60)}`)] : []),
        ].join('\n'),
      )
      break
    }
    case 'watch': {
      const id = pos[0]
      if (id) {
        const { session } = await c.cmd('show', { sessionId: id, tail: 0 })
        c.sub(topics.session(session.id))
        states.push(s => s.id === session.id && console.log(JSON.stringify({ state: s })))
      } else states.push(s => console.log(JSON.stringify({ state: s })))
      events.push(ev => console.log(JSON.stringify(ev)))
      c.sub(topics.world)
      return // stream until interrupted
    }
    case 'wait': {
      const timeout = duration(flags.timeout)
      const until = String(flags.until ?? (flags.msg ? 'observed' : 'idle'))
      const done = new Promise<unknown>((resolve, reject) => {
        setTimeout(() => reject(new CmdFailure(`timed out waiting for ${until}`, 'other')), timeout)
        if (typeof flags.msg === 'string') {
          const target = DELIVERY_ORDER.indexOf(until)
          const check = (d: any) => {
            if (d.state === 'failed') reject(new CmdFailure(`message ${d.msgId} failed: ${d.detail ?? ''}`, 'other'))
            else if (DELIVERY_ORDER.indexOf(d.state) >= target) resolve(d)
          }
          events.push(ev => ev.type === 'delivery' && ev.data.msgId === flags.msg && c.cmd('delivery', { msgId: flags.msg }).then(check, reject))
          c.cmd('delivery', { msgId: flags.msg }).then(check, reject)
          return
        }
        if (!pos[0]) return reject(new CmdFailure('wait needs a session or --msg', 'user'))
        c.cmd('show', { sessionId: pos[0], tail: 0 }).then(({ session }) => {
          let sawWorking = session.state === 'working'
          if (until === 'idle' && session.state !== 'working') return resolve(session)
          if (session.state === 'ended') return resolve(session)
          states.push(s => {
            if (s.id !== session.id) return
            if (s.state === 'working') sawWorking = true
            if (s.state === 'ended' || (s.state === 'idle' && (until === 'idle' || sawWorking))) resolve(s)
          })
        }, reject)
      })
      c.sub(topics.world)
      const r = await done
      print(flags, r, () => JSON.stringify(r, null, 2))
      break
    }
    case 'send':
    case 'suggest': {
      const r = await c.cmd(cmd, { sessionId: pos[0], text: await bodyText(pos[1]), mode: flags.mode })
      print(flags, r, () => (r.suggestionId ? `Suggestion ${r.suggestionId} is waiting for ${r.owner} to approve.` : `Message ${r.msgId}: ${r.state}`))
      break
    }
    case 'interrupt':
    case 'fill': {
      const r = await c.cmd(cmd, { sessionId: pos[0], text: await bodyText(pos[1]) })
      print(flags, r, () => `Message ${r.msgId}: ${r.state}`)
      break
    }
    case 'approvals': {
      const { suggestions } = await c.cmd('approvals', { all: flags.all === true })
      print(flags, suggestions, () =>
        suggestions.length
          ? table([['ID', 'SESSION', 'FROM', 'MODE', 'TEXT'], ...suggestions.map((s: any) => [s.id, s.sessionId.slice(0, 8), s.author, s.mode, s.text.slice(0, 70)])])
          : 'No pending suggestions.',
      )
      break
    }
    case 'approve':
    case 'reject': {
      const r = await c.cmd(cmd, { id: pos[0], text: await bodyText(typeof flags.edit === 'string' ? flags.edit : undefined) })
      print(flags, r, () => (r.msgId ? `Approved; message ${r.msgId}: ${r.state}` : `Rejected ${r.suggestionId}.`))
      break
    }
    case 'permissions': {
      const { permissions } = await c.cmd('permissions', { all: flags.all === true })
      print(flags, permissions, () =>
        permissions.length
          ? table([['ID', 'SESSION', 'TOOL', 'STATE', 'WAITING', 'INPUT'], ...permissions.map((p: any) => [p.reqId, p.sessionId.slice(0, 8), p.tool, p.state === 'deferred' ? 'agent moved on' : 'agent waiting', ago(p.requestedAt), p.input.slice(0, 60)])])
          : 'Nothing is waiting for permission.',
      )
      break
    }
    case 'allow':
    case 'deny': {
      const r = await c.cmd('decide', { reqId: pos[0], decision: cmd, message: typeof flags.message === 'string' ? flags.message : undefined })
      print(flags, r, () => `${cmd === 'allow' ? 'Allowed' : 'Denied'} ${r.reqId}.`)
      break
    }
    case 'delivery': {
      const r = await c.cmd('delivery', { msgId: pos[0] })
      print(flags, r, () => `${r.msgId} ${r.state}${r.detail ? ` (${r.detail})` : ''}`)
      break
    }
    case 'linear': {
      const sub = pos[0] ?? 'status'
      const op = { status: 'linear.account', connect: 'linear.connect', disconnect: 'linear.disconnect' }[sub]
      if (!op) throw new CmdFailure('linear takes status, connect or disconnect', 'user')
      const r = await c.cmd(op).catch(newerServer(op))
      print(flags, r, () =>
        sub === 'connect'
          ? `Open this in your browser, signed in to Dyson Sphere as ${c.identity}, within 10 minutes:\n${r.url}`
          : sub === 'disconnect'
            ? !r.disconnected
              ? 'No Linear account was connected.'
              : r.revoked === false
                ? "Disconnected your Linear account, but Linear couldn't be asked to revoke its access: revoke Dyson Sphere in Linear's settings."
                : 'Disconnected your Linear account; Linear revoked its access.'
            : !r.enabled
              ? r.reason
              : r.connected
                ? `Connected to Linear as ${r.user.name}${r.user.email ? ` (${r.user.email})` : ''}.`
                : 'No Linear account connected. Run `sphere linear connect`, or use Connect Linear in the canvas.',
      )
      break
    }
    case 'ticket': {
      const [sub, id] = pos
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
      const sessionId = str(flags.session)
      const show = (r: any, verb: string) =>
        `${verb} ${r.ticket.id} ${r.ticket.title} (${[r.ticket.status.name, r.ticket.assignee].filter(Boolean).join(', ')}), as ${r.as}${r.attachedTo ? `; now ${r.attachedTo.slice(0, 8)}'s ticket` : ''}.${r.ticket.url ? `\n${r.ticket.url}` : ''}`
      if (sub === 'set') {
        const args: Record<string, unknown> = { id, sessionId, status: str(flags.status), title: await bodyText(str(flags.title)) }
        if (typeof flags.assignee === 'string') args.assignee = flags.assignee
        const r = await c.cmd('ticket.update', args).catch(newerServer('ticket changes'))
        print(flags, r, () => show(r, 'Changed'))
      } else if (sub === 'new') {
        if (typeof flags.team !== 'string' || typeof flags.title !== 'string') throw new CmdFailure('ticket new needs --team <key> and --title <text>', 'user')
        const r = await c.cmd('ticket.create', { team: flags.team, title: await bodyText(flags.title), description: await bodyText(str(flags.description)), sessionId }).catch(newerServer('ticket changes'))
        print(flags, r, () => show(r, 'Made'))
      } else if (sub === 'attach') {
        if (!id || !sessionId) throw new CmdFailure('ticket attach needs a ticket id and --session <session>', 'user')
        const r = await c.cmd('ticket.attach', { id, sessionId }).catch(newerServer('ticket changes'))
        print(flags, r, () => show(r, 'Attached'))
      } else if (sub === 'comment') {
        const body = await bodyText(str(flags.body))
        if (!body) throw new CmdFailure('ticket comment needs --body <text|->', 'user')
        const r = await c.cmd('ticket.comment', { id, sessionId, body }).catch(newerServer('ticket changes'))
        print(flags, r, () => `Commented on ${r.id}, as ${r.as}.${r.comment.url ? `\n${r.comment.url}` : ''}`)
      } else if (sub === 'options') {
        const r = await c.cmd('ticket.options', { id, sessionId }).catch(newerServer('ticket changes'))
        print(flags, r, () =>
          [`${r.team.key} ${r.team.name}`, `Statuses: ${r.statuses.map((x: any) => x.name).join(', ')}`, `People: ${r.members.map((m: any) => m.name).join(', ')}`].join('\n'),
        )
      } else throw new CmdFailure('ticket takes set, new, comment, attach or options; see sphere --help', 'user')
      break
    }
    case 'move': {
      if (typeof flags.to !== 'string') throw new CmdFailure('move needs --to <dir>', 'user')
      const r = await move(c, pos[0] ?? '', flags.to, { launch: flags.launch === true, pluginDir: typeof flags['plugin-dir'] === 'string' ? flags['plugin-dir'] : null })
      print(flags, r, () => [`Moved ${r.sessionId.slice(0, 8)} to ${r.to} (WIP ${r.wip.slice(0, 8)}).`, r.tmux ? `Resumed in tmux session ${r.tmux}.` : `Resume with: ${r.resume}`, ...r.notes.map(n => `Note: ${n}`)].join('\n'))
      break
    }
    default:
      throw new CmdFailure(`unknown command ${cmd}; run sphere --help`, 'user')
  }
  closing = true
  c.close()
  process.exit(EXIT.ok) // don't wait on timers such as wait's timeout
}

main().catch(err => {
  const code = err instanceof CmdFailure ? err.code : 'other'
  const msg = { error: (err as Error).message, code }
  if (process.stdout.isTTY) process.stderr.write(`sphere: ${msg.error}\n`)
  else process.stderr.write(JSON.stringify(msg) + '\n')
  process.exit(EXIT[code as keyof typeof EXIT] ?? EXIT.other)
})
