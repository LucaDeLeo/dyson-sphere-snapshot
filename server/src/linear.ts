// Linear for Dyson Sphere: a small client for its GraphQL API, and the tickets sessions work on.
//
// `Linear` sends one query or mutation with whatever credentials it is given. The server reads
// tickets with its own key (SPHERE_LINEAR_KEY); what people do in Linear from Dyson Sphere will
// go through the same client with their own tokens (CS-2523, CS-2524).
//
// `Tickets` is what the server reads with its key: title, status, assignee and link of the
// tickets live sessions work on, about once a minute. The box is reachable only over the
// tailnet, so Linear's webhooks can't reach it. Answers are kept in memory; after a restart the
// first read refills them within seconds. A read that returns an issue also confirms a
// ticket found in a branch name (`ticket.confirmed`, recorded by the server). Without a key,
// or while Linear can't be reached, sessions show the ticket ids they have and nothing else
// changes. Each of those is logged once, not once per read.
import { isLinearId, type Ticket } from '../../shared/protocol'

export const LINEAR_URL = 'https://api.linear.app/graphql'

/** Whose access a request uses. An API key goes as-is, an OAuth token as a bearer token. */
export type LinearAuth = { apiKey: string } | { accessToken: string }

/**
 * Why Linear gave no answer: it refused the credentials (`auth`), is rate-limiting them, can't
 * be reached or answered with an HTTP error (`unavailable`), or answered with errors, such as
 * a query it doesn't accept or a change it didn't make (`rejected`).
 */
export class LinearError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate-limited' | 'unavailable' | 'rejected',
    readonly status: number | null = null,
    /** Linear's GraphQL error code, when it gave one (`AUTHENTICATION_ERROR`, `FORBIDDEN`, …). */
    readonly code: string | null = null,
  ) {
    super(message)
  }
}

const plain = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  return s || null
}

export class Linear {
  constructor(private o: { url?: string; fetch?: typeof fetch } = {}) {}

  /** One query or mutation. Any error in Linear's answer throws: a change is never taken as made when Linear reported one. */
  async request<T>(auth: LinearAuth, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(this.o.url ?? LINEAR_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'apiKey' in auth ? auth.apiKey : `Bearer ${auth.accessToken}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      throw new LinearError(`can't reach Linear (${(e as Error).message})`, 'unavailable')
    }
    const body = (await res.json().catch(() => null)) as { data?: T | null; errors?: { message?: string; extensions?: { code?: string } }[] } | null
    const error = body?.errors?.[0]
    const code = error?.extensions?.code
    if (res.status === 401 || res.status === 403 || code === 'AUTHENTICATION_ERROR' || code === 'FORBIDDEN')
      throw new LinearError(`Linear refused the credentials (HTTP ${res.status})`, 'auth', res.status, code ?? null)
    if (res.status === 429 || code === 'RATELIMITED') throw new LinearError('Linear is rate-limiting these credentials', 'rate-limited', res.status)
    if (!res.ok) throw new LinearError(`Linear answered HTTP ${res.status}`, 'unavailable', res.status)
    if (error || !body?.data) throw new LinearError(`Linear answered with an error: ${plain(error?.message, 200) ?? 'no data'}`, 'rejected', res.status)
    return body.data
  }
}

/** The issue fields a ticket is made from, for any query or mutation that returns issues. */
export const TICKET_FIELDS = 'identifier title url state { name type color } assignee { name displayName }'

/** One issue from Linear's answer, checked: nothing from it reaches a page unchecked. */
export function toTicket(n: any): Ticket | null {
  const id = plain(n?.identifier, 40)?.toUpperCase()
  const title = plain(n?.title, 300)
  if (!id || !title) return null
  const url = typeof n.url === 'string' && n.url.startsWith('https://linear.app/') ? n.url : null
  const color = typeof n.state?.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(n.state.color) ? n.state.color : '#95a2b3'
  return {
    id,
    title,
    url,
    status: { name: plain(n.state?.name, 60) ?? 'Unknown', type: plain(n.state?.type, 20) ?? 'unknown', color },
    assignee: plain(n.assignee?.name, 80) ?? plain(n.assignee?.displayName, 80),
  }
}

/** Ids per request. Each team's numbers go in one clause of the filter. */
const BATCH = 50

// A filtered list rather than `issue(id:)`: that one fails when an issue doesn't exist, and
// takes the whole request down with it.
const READ = `query Tickets($filter: IssueFilter!) {
  issues(filter: $filter, first: ${BATCH}, includeArchived: true) { nodes { ${TICKET_FIELDS} } }
}`

type Options = {
  linear: Linear
  /** SPHERE_LINEAR_KEY: the server's own key, for reads. A personal API key or an OAuth token, sent as-is like estra's and alsync's. */
  key: string | null
  /** A ticket's details changed, or it turned out not to exist (null). */
  changed: (id: string, ticket: Ticket | null) => void
  log?: (message: string) => void
}

export class Tickets {
  /** Tickets Linear has answered for. One it says doesn't exist isn't here. */
  readonly known = new Map<string, Ticket>()
  /** Ids read at least once: a new session's ticket is read at once, the rest on the minute. */
  private asked = new Set<string>()
  private soonIds = new Set<string>()
  private soonTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  /** Why the last read failed; null while reads work. */
  private failing: string | null = null
  private log: (message: string) => void

  constructor(private o: Options) {
    this.log = o.log ?? (m => console.warn(m))
    if (!o.key) this.log("Linear: SPHERE_LINEAR_KEY is not set, so sessions show the ids of tickets estra or Orca names, without titles or status, and tickets in branch names don't show.")
  }

  /** Reads these tickets now, after any read already under way. Ids that aren't Linear's are skipped. */
  refresh(ids: Iterable<string>): Promise<void> {
    const wanted = [...new Set([...ids].filter(isLinearId))]
    const run = this.queue.then(() => this.read(wanted))
    this.queue = run.catch(() => {})
    return run
  }

  /** A session started with this ticket: read it within a second, unless it has been read before. */
  soon(id: string) {
    if (!this.o.key || !isLinearId(id) || this.asked.has(id)) return
    this.soonIds.add(id)
    this.soonTimer ??= setTimeout(() => {
      this.soonTimer = null
      const ids = [...this.soonIds]
      this.soonIds.clear()
      void this.refresh(ids)
    }, 250)
  }

  /** Orders reads and changes: a read that began before a change was answered doesn't undo it. */
  private clock = 0
  private changedAt = new Map<string, number>()

  /**
   * What Linear says about a ticket now, from its answer to a change made through it (or a read
   * made as a person). It's newer than any read already under way, which won't overwrite it.
   */
  set(id: string, ticket: Ticket | null) {
    this.changedAt.set(id, ++this.clock)
    this.apply(id, ticket)
  }

  /** Canvases hear only of a change. */
  private apply(id: string, ticket: Ticket | null) {
    const before = this.known.get(id)
    if (ticket ? JSON.stringify(before) === JSON.stringify(ticket) : !before) return
    if (ticket) this.known.set(id, ticket)
    else this.known.delete(id)
    this.o.changed(id, ticket)
  }

  private async read(ids: string[]) {
    if (!this.o.key || !ids.length) return
    for (const id of ids) this.asked.add(id)
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH)
      const began = ++this.clock
      let found: Map<string, Ticket>
      try {
        found = await this.query(chunk)
      } catch (e) {
        const reason =
          e instanceof LinearError ? (e.kind === 'auth' ? `Linear refused SPHERE_LINEAR_KEY (HTTP ${e.status})` : e.message) : `can't read tickets (${(e as Error).message})`
        // Once per outage, with what went wrong; what was read before stays shown.
        if (this.failing === null) this.log(`Linear: ${reason}. Sessions show their ticket ids, with what was last read, until Linear answers again.`)
        this.failing = reason
        return
      }
      if (this.failing !== null) this.log('Linear: reading tickets again.')
      this.failing = null
      // A ticket changed through Dyson Sphere while this read was on its way keeps the change.
      for (const id of chunk) if ((this.changedAt.get(id) ?? 0) < began) this.apply(id, found.get(id) ?? null)
    }
  }

  private async query(ids: string[]): Promise<Map<string, Ticket>> {
    const byTeam = new Map<string, number[]>()
    for (const id of ids) {
      const [team, n] = id.split('-') as [string, string]
      byTeam.set(team, [...(byTeam.get(team) ?? []), Number(n)])
    }
    const filter = { or: [...byTeam].map(([key, numbers]) => ({ team: { key: { eq: key } }, number: { in: numbers } })) }
    const data = await this.o.linear.request<{ issues?: { nodes?: unknown } }>({ apiKey: this.o.key! }, READ, { filter })
    const nodes = data.issues?.nodes
    if (!Array.isArray(nodes)) throw new LinearError("Linear's answer had no issues", 'rejected')
    const found = new Map<string, Ticket>()
    for (const n of nodes) {
      const t = toTicket(n)
      if (t) found.set(t.id, t)
    }
    return found
  }
}
