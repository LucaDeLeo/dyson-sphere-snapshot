// A stand-in for Linear, for the tests and the demo: its GraphQL API, as far as sphere-server uses
// it, and its OAuth 2 endpoints (authorize, token, revoke) under /oauth, as Linear's own behave.
//
// GraphQL: the server's read (issues by team key and number) answers any API key. Everything
// else needs a person's OAuth token, as a bearer token, and acts as that person.
//
// POST /_set {"id": "CS-1", "status": "In Review"} moves an issue, so a running demo can show
// a card following Linear. With a title, it adds an issue the table doesn't have.
//
// OAuth: /oauth/authorize lists the stand-in's people to sign in as (`&as=<user id>` skips the
// list), then sends the browser to the redirect URI with a code. The token endpoint checks the
// client, the redirect URI and PKCE, and rotates refresh tokens as Linear does.
import { createHash } from 'node:crypto'

export type StubIssue = { title: string; status: string; assignee?: string | null; description?: string | null }
export type StubUser = { id: string; name: string; displayName: string; email: string }

/** Linear's default statuses, with their types and colors. */
export const STATUSES: Record<string, { type: string; color: string }> = {
  Triage: { type: 'triage', color: '#fc7840' },
  Backlog: { type: 'backlog', color: '#bec2c8' },
  Todo: { type: 'unstarted', color: '#e2e2e2' },
  'In Progress': { type: 'started', color: '#f2c94c' },
  'In Review': { type: 'started', color: '#0f783c' },
  Done: { type: 'completed', color: '#5e6ad2' },
  Canceled: { type: 'canceled', color: '#95a2b3' },
}

/** The OAuth app the stand-in knows. */
export const STUB_CLIENT = { id: 'stub-client-id', secret: 'stub-client-secret' }

export const STUB_USERS: StubUser[] = [
  { id: 'user-luca', name: 'Luca De Leo', displayName: 'luca', email: 'luca@example.org' },
  { id: 'user-jp', name: 'JP Addison', displayName: 'jp', email: 'jp@example.org' },
]

type Grant = { user: StubUser; scope: string }

export function linearStub(issues: Record<string, StubIssue> = {}, opts: { tokenSeconds?: number } = {}) {
  const table = new Map(Object.entries(issues))
  const requests: { authorization: string | null; query: string; variables: any }[] = []
  let failing: number | null = null
  const users = STUB_USERS
  /** Codes waiting to be exchanged, access tokens and refresh tokens, each to its grant. */
  const codes = new Map<string, Grant & { challenge: string; method: string; redirectUri: string; clientId: string }>()
  const access = new Map<string, Grant & { expires: number }>()
  const refresh = new Map<string, Grant>()
  const revoked: string[] = []
  let n = 0
  const tokenSeconds = () => opts.tokenSeconds ?? 86399

  const node = (id: string, i: StubIssue) => ({
    identifier: id,
    title: i.title,
    url: `https://linear.app/80000-hours/issue/${id}/${i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
    state: { name: i.status, ...(STATUSES[i.status] ?? { type: 'started', color: '#f2c94c' }) },
    assignee: i.assignee ? { name: i.assignee, displayName: i.assignee.split(' ')[0]!.toLowerCase() } : null,
  })

  const issueTokens = (g: Grant) => {
    const at = `stub_at_${++n}`
    const rt = `stub_rt_${n}`
    access.set(at, { ...g, expires: Date.now() + tokenSeconds() * 1000 })
    refresh.set(rt, g)
    return Response.json({ access_token: at, token_type: 'Bearer', expires_in: tokenSeconds(), scope: g.scope.replaceAll(',', ' '), refresh_token: rt })
  }
  const oauthError = (error: string, status = 400) => Response.json({ error }, { status })
  const gqlError = (message: string, code: string, status = 400) => Response.json({ errors: [{ message, extensions: { code } }] }, { status })

  async function oauth(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/oauth/authorize') {
      const q = url.searchParams
      if (q.get('client_id') !== STUB_CLIENT.id) return new Response('unknown client', { status: 400 })
      if (q.get('response_type') !== 'code' || !q.get('redirect_uri')) return new Response('bad request', { status: 400 })
      const as = q.get('as')
      if (as === null) {
        // A page to pick who signs in, as Linear's consent screen would ask.
        const link = (extra: string) => `${url.pathname}?${q}&${extra}`
        const items = users.map(u => `<li><a href="${link(`as=${u.id}`)}">Allow, as ${u.name}</a></li>`).join('')
        return new Response(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stand-in Linear</title><body style="font:15px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1 style="font-size:20px">Stand-in Linear</h1><p>Dyson Sphere asks for access to your Linear account (${q.get('scope')}).</p><ul>${items}</ul><p><a href="${link('as=deny')}">Deny</a></p>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      }
      const back = new URL(q.get('redirect_uri')!)
      if (q.get('state')) back.searchParams.set('state', q.get('state')!)
      const user = users.find(u => u.id === as)
      if (!user) back.searchParams.set('error', 'access_denied')
      else {
        const code = `stub_code_${++n}`
        codes.set(code, { user, scope: q.get('scope') ?? 'read', challenge: q.get('code_challenge') ?? '', method: q.get('code_challenge_method') ?? '', redirectUri: q.get('redirect_uri')!, clientId: q.get('client_id')! })
        back.searchParams.set('code', code)
      }
      return Response.redirect(back.toString(), 302)
    }
    if (req.method !== 'POST' || req.headers.get('content-type') !== 'application/x-www-form-urlencoded') return oauthError('invalid_request')
    const f = new URLSearchParams(await req.text())
    if (url.pathname === '/oauth/token') {
      if (f.get('client_id') !== STUB_CLIENT.id || f.get('client_secret') !== STUB_CLIENT.secret) return oauthError('invalid_client', 401)
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') ?? '')
        codes.delete(f.get('code') ?? '')
        if (!c || c.redirectUri !== f.get('redirect_uri') || c.clientId !== f.get('client_id')) return oauthError('invalid_grant')
        const verifier = f.get('code_verifier') ?? ''
        const ok = c.method === 'S256' ? createHash('sha256').update(verifier).digest('base64url') === c.challenge : c.method === '' || verifier === c.challenge
        if (!ok) return oauthError('invalid_grant')
        return issueTokens(c)
      }
      if (f.get('grant_type') === 'refresh_token') {
        const g = refresh.get(f.get('refresh_token') ?? '')
        if (!g) return oauthError('invalid_grant')
        refresh.delete(f.get('refresh_token')!) // rotated
        return issueTokens(g)
      }
      return oauthError('unsupported_grant_type')
    }
    if (url.pathname === '/oauth/revoke') {
      const token = f.get('token') ?? ''
      revoked.push(token)
      if (!access.delete(token) && !refresh.delete(token)) return oauthError('invalid_token')
      return new Response(null, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }

  /** The person a bearer token acts as; null for an API key; 'refused' for a token Linear doesn't know or that expired. */
  const caller = (authorization: string | null): StubUser | null | 'refused' => {
    if (!authorization?.startsWith('Bearer ')) return null
    const g = access.get(authorization.slice('Bearer '.length))
    return g && g.expires > Date.now() ? g.user : 'refused'
  }

  // ---------- teams, statuses and people, and changes ----------

  const teamKeys = () => [...new Set([...table.keys()].map(id => id.split('-')[0]!))].sort()
  const team = (key: string) => ({ id: `team-${key}`, key, name: key === 'CS' ? 'Coding Systems' : `Team ${key}` })
  const states = () => Object.entries(STATUSES).map(([name, s], position) => ({ id: `state-${name.toLowerCase().replace(/\s+/g, '-')}`, name, ...s, position }))
  const members = () => users.map(u => ({ id: u.id, name: u.name, displayName: u.displayName, active: true }))
  const teamWithOptions = (key: string) => ({ ...team(key), states: { nodes: states() }, members: { nodes: members() } })
  const issueId = (id: unknown) => {
    const key = String(id).toUpperCase()
    if (!table.has(key)) throw new Error(`Entity not found: Issue - ${id}`)
    return key
  }
  /** Changes made, in order, for tests: who made them and what. */
  const changes: { by: string; op: string; id: string; input: Record<string, unknown> }[] = []
  /** Comments, under who made them. */
  const comments: { by: string; id: string; body: string }[] = []

  function asPerson(op: string, who: StubUser, v: any): unknown {
    switch (op) {
      case 'Viewer':
        return { viewer: who }
      case 'Teams':
        return { teams: { nodes: teamKeys().map(team) } }
      case 'TicketOptions': {
        const id = issueId(v.id)
        return { viewer: { id: who.id }, issue: { ...node(id, table.get(id)!), team: teamWithOptions(id.split('-')[0]!) } }
      }
      case 'TeamOptions': {
        const key = teamKeys().find(k => team(k).id === v.id)
        if (!key) throw new Error(`Entity not found: Team - ${v.id}`)
        return { viewer: { id: who.id }, team: teamWithOptions(key) }
      }
      case 'Ticket': {
        const id = `${v.filter?.team?.key?.eq}-${v.filter?.number?.eq}`
        const issue = table.get(id)
        return { issues: { nodes: issue ? [node(id, issue)] : [] } }
      }
      case 'TicketUpdate': {
        const id = issueId(v.id)
        const issue = table.get(id)!
        const input = v.input ?? {}
        if ('stateId' in input) {
          const state = states().find(s => s.id === input.stateId)
          if (!state) throw new Error(`Entity not found: WorkflowState - ${input.stateId}`)
          issue.status = state.name
        }
        if ('assigneeId' in input) {
          if (input.assigneeId === null) issue.assignee = null
          else {
            const u = users.find(x => x.id === input.assigneeId)
            if (!u) throw new Error(`Entity not found: User - ${input.assigneeId}`)
            issue.assignee = u.name
          }
        }
        if ('title' in input) issue.title = input.title
        changes.push({ by: who.id, op, id, input })
        return { issueUpdate: { success: true, issue: node(id, issue) } }
      }
      case 'TicketCreate': {
        const input = v.input ?? {}
        const key = teamKeys().find(k => team(k).id === input.teamId)
        if (!key) throw new Error(`Entity not found: Team - ${input.teamId}`)
        const n = Math.max(0, ...[...table.keys()].filter(id => id.startsWith(`${key}-`)).map(id => Number(id.split('-')[1]))) + 1
        const id = `${key}-${n}`
        table.set(id, { title: input.title, status: 'Todo', assignee: null, description: input.description ?? null })
        changes.push({ by: who.id, op, id, input })
        return { issueCreate: { success: true, issue: node(id, table.get(id)!) } }
      }
      case 'TicketComment': {
        const input = v.input ?? {}
        const id = issueId(input.issueId)
        const comment = { id: `comment-${++n}`, url: `https://linear.app/80000-hours/issue/${id}#comment-${n}` }
        comments.push({ by: who.id, id, body: input.body })
        changes.push({ by: who.id, op, id, input })
        return { commentCreate: { success: true, comment } }
      }
      default:
        throw new Error(`the stand-in doesn't answer ${op}`)
    }
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/oauth/')) return oauth(req, url)
      if (url.pathname === '/_set') {
        const { id, ...change } = (await req.json()) as { id: string } & Partial<StubIssue>
        const issue = table.get(id)
        if (issue) Object.assign(issue, change)
        else if (change.title) table.set(id, { status: 'Todo', ...change, title: change.title })
        else return new Response('no such issue (send a title to add it)', { status: 404 })
        return new Response(null, { status: 204 })
      }
      const body = (await req.json()) as { query?: string; variables?: any }
      const query = body.query ?? ''
      const authorization = req.headers.get('authorization')
      requests.push({ authorization, query, variables: body.variables })
      if (failing) return Response.json({ errors: [{ message: 'unavailable' }] }, { status: failing })
      const who = caller(authorization)
      if (who === 'refused') return gqlError('Authentication required, not authenticated', 'AUTHENTICATION_ERROR', 401)
      const op = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? (/\bviewer\b/.test(query) ? 'Viewer' : 'Tickets')
      if (op !== 'Tickets') {
        // Everything but the server's read acts as a person.
        if (!who) return gqlError('This stand-in answers only the ticket read for an API key', 'FORBIDDEN', 403)
        try {
          return Response.json({ data: asPerson(op, who, body.variables ?? {}) })
        } catch (e) {
          return Response.json({ data: null, errors: [{ message: (e as Error).message, extensions: { code: 'INVALID_INPUT' } }] })
        }
      }
      const nodes = []
      for (const clause of body.variables?.filter?.or ?? [])
        for (const n of clause.number?.in ?? []) {
          const id = `${clause.team?.key?.eq}-${n}`
          const issue = table.get(id)
          if (issue) nodes.push(node(id, issue))
        }
      return Response.json({ data: { issues: { nodes } } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/graphql`,
    table,
    requests,
    users,
    /** Changes people made through it, in order. */
    changes,
    comments,
    /** Tokens revoked through /oauth/revoke, in order. */
    revoked,
    /** Ends every token of this person, as revoking the app in Linear's settings does. */
    revokeAll(userId: string) {
      for (const m of [access, refresh] as Map<string, Grant>[]) for (const [t, g] of m) if (g.user.id === userId) m.delete(t)
    },
    /** Expires this person's access tokens now; their refresh tokens still work. */
    expireAccess(userId: string) {
      for (const [, g] of access) if (g.user.id === userId) g.expires = 0
    },
    /** Answers every query with this HTTP status until called with null. */
    fail(status: number | null) {
      failing = status
    },
    stop: () => server.stop(true),
  }
}
