// Each person's Linear account (CS-2524): the OAuth flow against a stand-in for Linear, how tokens
// are kept, refreshed and ended. No database: the grants live in a map here.
import { afterAll, expect, test } from 'bun:test'
import { linearStub, STUB_CLIENT } from '../scripts/linear-stub'
import { Linear } from '../server/src/linear'
import { LinearAccounts, NotConnected, oauthFromEnv, seal, tokenKey, unseal, type GrantStore } from '../server/src/linear-accounts'

const stub = linearStub({ 'CS-1': { title: 'One', status: 'Todo' } })
afterAll(() => stub.stop())

const KEY = 'k'.repeat(40)
const REDIRECT = 'http://127.0.0.1:7999/linear/callback'

function setup(opts: { now?: () => number; fetch?: typeof fetch; secret?: string } = {}, shared?: Map<string, string>) {
  const rows = shared ?? new Map<string, string>()
  const store: GrantStore = {
    get: async id => rows.get(id) ?? null,
    put: async (id, sealed) => void rows.set(id, sealed),
    delete: async id => void rows.delete(id),
    replace: async (id, from, to) => {
      if (rows.get(id) !== from) return false
      if (to === null) rows.delete(id)
      else rows.set(id, to)
      return true
    },
  }
  const logs: string[] = []
  const env = { SPHERE_LINEAR_CLIENT_ID: STUB_CLIENT.id, SPHERE_LINEAR_CLIENT_SECRET: opts.secret ?? STUB_CLIENT.secret, SPHERE_LINEAR_TOKEN_KEY: KEY, SPHERE_LINEAR_REDIRECT_URL: REDIRECT }
  const accounts = new LinearAccounts({ linear: new Linear({ url: stub.url }), store, ...oauthFromEnv(env, { origin: 'http://unused', linearUrl: stub.url }), log: m => logs.push(m), ...opts })
  return { accounts, rows, logs }
}

/** What a browser does: open Linear's page, say yes as this person, and follow it back. */
async function consent(authorizeUrl: string, as: string): Promise<{ state: string | null; code: string | null; error: string | null }> {
  const res = await fetch(`${authorizeUrl}&as=${as}`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const back = new URL(res.headers.get('location')!)
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
  return { state: back.searchParams.get('state'), code: back.searchParams.get('code'), error: back.searchParams.get('error') }
}

async function connect(a: LinearAccounts, identity: string, as = 'user-luca') {
  return a.finish(await consent(a.start(identity), as), null)
}

test('the connect link asks Linear for read and write, with PKCE and a state bound to the person', () => {
  const { accounts } = setup()
  const url = new URL(accounts.start('luca'))
  expect(url.origin + url.pathname).toBe(new URL(stub.url).origin + '/oauth/authorize')
  const q = url.searchParams
  expect(Object.fromEntries(q)).toMatchObject({ client_id: STUB_CLIENT.id, redirect_uri: REDIRECT, response_type: 'code', scope: 'read,write', code_challenge_method: 'S256', actor: 'user', prompt: 'consent' })
  expect(q.get('state')!.length).toBeGreaterThanOrEqual(40)
  expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  // Every link is new.
  expect(new URL(accounts.start('luca')).searchParams.get('state')).not.toBe(q.get('state'))
})

test("connecting stores the person's Linear account, sealed, and pages see who, never a token", async () => {
  const { accounts, rows } = setup()
  expect(await accounts.account('luca')).toEqual({ enabled: true, connected: false })
  expect(await connect(accounts, 'luca')).toEqual({ identity: 'luca', user: { id: 'user-luca', name: 'Luca De Leo', email: 'luca@example.org' } })
  const account = await accounts.account('luca')
  expect(account).toMatchObject({ enabled: true, connected: true, user: { id: 'user-luca', name: 'Luca De Leo' } })
  expect(JSON.stringify(account)).not.toContain('stub_')
  // Stored sealed: no token in the row, and it opens only as luca's.
  const row = rows.get('luca')!
  expect(row).toStartWith('v1.')
  expect(row).not.toContain('stub_')
  expect(unseal<{ accessToken: string }>(tokenKey(KEY), 'luca', row).accessToken).toStartWith('stub_at_')
  expect(() => unseal(tokenKey(KEY), 'jp', row)).toThrow()
  expect(() => unseal(tokenKey('x'.repeat(40)), 'luca', row)).toThrow()
  // Changes go as luca, with luca's token as a bearer token.
  const before = stub.requests.length
  expect(await accounts.request<{ viewer: { id: string } }>('luca', 'query { viewer { id } }')).toMatchObject({ viewer: { id: 'user-luca' } })
  expect(stub.requests.slice(before).map(r => r.authorization)).toEqual([expect.stringMatching(/^Bearer stub_at_/)])
  // Someone who hasn't connected can't act.
  await expect(accounts.request('jp', 'query { viewer { id } }')).rejects.toBeInstanceOf(NotConnected)
})

test('a connect link works once, for ten minutes, and only for whoever started it', async () => {
  let now = Date.now()
  const { accounts } = setup({ now: () => now })
  const answer = await consent(accounts.start('luca'), 'user-luca')
  // Signed in as someone else (behind Tailscale): refused, and the link stays good for its owner.
  await expect(accounts.finish(answer, 'jp')).rejects.toThrow(/started by luca; you're signed in as jp/)
  expect(await accounts.finish(answer, 'luca')).toMatchObject({ identity: 'luca' })
  await expect(accounts.finish(answer, 'luca')).rejects.toThrow(/expired or was already used/)
  await expect(accounts.finish({ state: 'made-up', code: 'x', error: null }, null)).rejects.toThrow(/expired or was already used/)

  const late = await consent(accounts.start('jp'), 'user-jp')
  now += 11 * 60_000
  await expect(accounts.finish(late, null)).rejects.toThrow(/expired/)

  // Saying no in Linear.
  const denied = await consent(accounts.start('jp'), 'deny')
  expect(denied.error).toBe('access_denied')
  await expect(accounts.finish(denied, null)).rejects.toThrow('Linear access was not granted.')
  expect(await accounts.account('jp')).toEqual({ enabled: true, connected: false })
})

test('a code is useless without the verifier only this server holds (PKCE)', async () => {
  const { accounts } = setup()
  const answer = await consent(accounts.start('luca'), 'user-luca')
  const res = await fetch(new URL(stub.url).origin + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: answer.code!, redirect_uri: REDIRECT, client_id: STUB_CLIENT.id, client_secret: STUB_CLIENT.secret, code_verifier: 'guess' }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'invalid_grant' })
})

test('an expiring token is refreshed before use, once for requests at the same time, and the new refresh token kept', async () => {
  let now = Date.now()
  const { accounts, rows } = setup({ now: () => now })
  await connect(accounts, 'luca')
  const first = unseal<{ accessToken: string; refreshToken: string }>(tokenKey(KEY), 'luca', rows.get('luca')!)
  now += 24 * 3600_000 // a day later: expired by the server's clock
  const before = stub.requests.length
  await Promise.all([1, 2, 3].map(() => accounts.request('luca', 'query { viewer { id } }')))
  const second = unseal<{ accessToken: string; refreshToken: string }>(tokenKey(KEY), 'luca', rows.get('luca')!)
  expect(second.accessToken).not.toBe(first.accessToken)
  expect(second.refreshToken).not.toBe(first.refreshToken) // rotated
  expect(new Set(stub.requests.slice(before).map(r => r.authorization))).toEqual(new Set([`Bearer ${second.accessToken}`]))

  // Linear refuses a token early (its clock, not ours): refreshed once and the request sent again.
  stub.expireAccess('user-luca')
  expect(await accounts.request('luca', 'query { viewer { id } }')).toMatchObject({ viewer: { id: 'user-luca' } })
  expect(unseal<{ accessToken: string }>(tokenKey(KEY), 'luca', rows.get('luca')!).accessToken).not.toBe(second.accessToken)
})

test('revoked in Linear: the connection ends, and the person is told to connect again', async () => {
  const { accounts, rows, logs } = setup()
  await connect(accounts, 'jp', 'user-jp')
  stub.revokeAll('user-jp')
  await expect(accounts.request('jp', 'query { viewer { id } }')).rejects.toThrow(/connection has ended.*Connect again/)
  expect(rows.has('jp')).toBe(false)
  expect(await accounts.account('jp')).toEqual({ enabled: true, connected: false })
  expect(logs).toEqual([expect.stringContaining("jp's connection ended")])
})

test('disconnecting revokes the tokens at Linear and forgets them', async () => {
  const { accounts, rows } = setup()
  await connect(accounts, 'luca')
  const g = unseal<{ accessToken: string; refreshToken: string }>(tokenKey(KEY), 'luca', rows.get('luca')!)
  expect(await accounts.disconnect('luca')).toEqual({ disconnected: true, revoked: true })
  expect(rows.has('luca')).toBe(false)
  expect(stub.revoked.slice(-2)).toEqual([g.refreshToken, g.accessToken])
  expect(await accounts.disconnect('luca')).toEqual({ disconnected: false, revoked: false })
  // A token Linear has revoked is refused.
  const res = await fetch(stub.url, { method: 'POST', headers: { authorization: `Bearer ${g.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { viewer { id } }' }) })
  expect(res.status).toBe(401)
})

test('a changed SPHERE_LINEAR_TOKEN_KEY reads as not connected, not as an error', async () => {
  const { accounts, rows, logs } = setup()
  await connect(accounts, 'luca')
  rows.set('luca', seal(tokenKey('other'.repeat(10)), 'luca', { accessToken: 'x' }))
  expect(await accounts.account('luca')).toEqual({ enabled: true, connected: false })
  expect(logs.at(-1)).toContain("can't be opened")
})

test('without the settings the feature is off, and says why', async () => {
  const off = (env: Record<string, string>) => oauthFromEnv(env, { origin: 'https://sphere.example.ts.net', linearUrl: null })
  expect(off({}).reason).toContain('SPHERE_LINEAR_CLIENT_ID and SPHERE_LINEAR_CLIENT_SECRET are not set')
  expect(off({ SPHERE_LINEAR_CLIENT_ID: 'a', SPHERE_LINEAR_CLIENT_SECRET: 'b' }).reason).toContain('SPHERE_LINEAR_TOKEN_KEY must be at least 32 characters')
  const on = off({ SPHERE_LINEAR_CLIENT_ID: 'a', SPHERE_LINEAR_CLIENT_SECRET: 'b', SPHERE_LINEAR_TOKEN_KEY: KEY })
  // Linear's own endpoints, and the callback on the page's origin.
  expect(on.oauth).toEqual({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://sphere.example.ts.net/linear/callback' })
  // Linear's own API named explicitly keeps Linear's OAuth addresses; only a stand-in serves its own.
  const all0 = { SPHERE_LINEAR_CLIENT_ID: 'a', SPHERE_LINEAR_CLIENT_SECRET: 'b', SPHERE_LINEAR_TOKEN_KEY: KEY }
  expect(oauthFromEnv(all0, { origin: 'https://x', linearUrl: 'https://api.linear.app/graphql' }).oauth?.authorizeUrl).toBeUndefined()
  expect(oauthFromEnv(all0, { origin: 'https://x', linearUrl: 'http://127.0.0.1:9/graphql' }).oauth?.authorizeUrl).toBe('http://127.0.0.1:9/oauth/authorize')
  // A production server must be told its address: Linear sends people back to it.
  const all = { SPHERE_LINEAR_CLIENT_ID: 'a', SPHERE_LINEAR_CLIENT_SECRET: 'b', SPHERE_LINEAR_TOKEN_KEY: KEY }
  expect(oauthFromEnv(all, { origin: null, linearUrl: null }).reason).toContain('set SPHERE_ORIGIN')
  expect(oauthFromEnv({ ...all, SPHERE_LINEAR_REDIRECT_URL: 'https://x.ts.net/linear/callback' }, { origin: null, linearUrl: null }).oauth?.redirectUri).toBe('https://x.ts.net/linear/callback')

  const accounts = new LinearAccounts({ linear: new Linear(), store: { get: async () => null, put: async () => {}, delete: async () => {}, replace: async () => false }, ...off({}) })
  expect(accounts.enabled).toBe(false)
  expect(await accounts.account('luca')).toEqual({ enabled: false, reason: expect.stringContaining('off on this server') })
  expect(() => accounts.start('luca')).toThrow(NotConnected)
  await expect(accounts.request('luca', 'query { viewer { id } }')).rejects.toBeInstanceOf(NotConnected)
})

test("a server with a wrong client secret keeps people's connections, and says what to fix", async () => {
  let now = Date.now()
  const { accounts, rows } = setup({ now: () => now })
  await connect(accounts, 'luca')
  const misconfigured = setup({ now: () => now, secret: 'wrong' }, rows)
  now += 24 * 3600_000 // a refresh is due, and Linear refuses the client (invalid_client)
  await expect(misconfigured.accounts.request('luca', 'query { viewer { id } }')).rejects.toThrow(/refused Dyson Sphere's OAuth app \(invalid_client\)/)
  expect(rows.has('luca')).toBe(true)
  expect(misconfigured.logs).toEqual([expect.stringContaining('check SPHERE_LINEAR_CLIENT_ID, SPHERE_LINEAR_CLIENT_SECRET')])
  // Fixed: the same connection works.
  expect(await accounts.request('luca', 'query { viewer { id } }')).toMatchObject({ viewer: { id: 'user-luca' } })
})

test('a disconnect stays done when a refresh or a connection was under way', async () => {
  let now = Date.now()
  let hold: Promise<void> | null = null
  const slow = (async (url: string, init: RequestInit) => {
    if (hold && String(url).endsWith('/oauth/token')) await hold
    return fetch(url, init)
  }) as unknown as typeof fetch
  const { accounts, rows } = setup({ now: () => now, fetch: slow })
  await connect(accounts, 'luca')

  // A refresh waits on Linear while luca disconnects.
  now += 24 * 3600_000
  const release = Promise.withResolvers<void>()
  hold = release.promise
  const asking = accounts.request('luca', 'query { viewer { id } }')
  await Bun.sleep(50)
  const disconnecting = accounts.disconnect('luca')
  release.resolve()
  await expect(asking).rejects.toBeInstanceOf(NotConnected)
  expect(await disconnecting).toMatchObject({ revoked: true })
  expect(rows.has('luca')).toBe(false)
  hold = null
  const revokedBefore = stub.revoked.length

  // A connection whose callback is still on its way when luca disconnects isn't saved.
  const answer = await consent(accounts.start('luca'), 'user-luca')
  await accounts.disconnect('luca')
  await expect(accounts.finish(answer, null)).rejects.toThrow(/disconnected Linear while this link was open/)
  expect(rows.has('luca')).toBe(false)
  expect(stub.revoked.length).toBe(revokedBefore + 2) // what it got was revoked
})

test("a disconnect that Linear can't be asked about says so, and is logged", async () => {
  const failing = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/oauth/revoke')) throw new Error('connection reset')
    return fetch(url, init)
  }) as unknown as typeof fetch
  const { accounts, rows, logs } = setup({ fetch: failing })
  await connect(accounts, 'luca')
  expect(await accounts.disconnect('luca')).toEqual({ disconnected: true, revoked: false })
  expect(rows.has('luca')).toBe(false)
  expect(logs.filter(l => l.includes("couldn't revoke luca's"))).toHaveLength(2)
  expect(logs.join('\n')).not.toContain('stub_') // no token in the logs
})

test('a disconnect deletes a connection it cannot open, so it never comes back with the settings', async () => {
  const { accounts, rows } = setup()
  await connect(accounts, 'luca')
  // The feature switched off (a setting removed): the row is still deleted, and not revoked.
  const off = new LinearAccounts({ linear: new Linear(), store: { get: async id => rows.get(id) ?? null, put: async () => {}, delete: async id => void rows.delete(id), replace: async () => false }, oauth: null, key: null, reason: 'off' })
  expect(await off.disconnect('luca')).toEqual({ disconnected: true, revoked: false })
  expect(rows.has('luca')).toBe(false)
  // Sealed with another key.
  rows.set('luca', seal(tokenKey('other'.repeat(10)), 'luca', { accessToken: 'x' }))
  expect(await accounts.disconnect('luca')).toEqual({ disconnected: true, revoked: false })
  expect(rows.has('luca')).toBe(false)
})

test('a refresh Linear refuses ends only the grant it read: a connection made meanwhile stays', async () => {
  let now = Date.now()
  let hold: Promise<void> | null = null
  const slow = (async (url: string, init: RequestInit) => {
    if (hold && String(url).endsWith('/oauth/token')) await hold
    return fetch(url, init)
  }) as unknown as typeof fetch
  const { accounts, rows } = setup({ now: () => now, fetch: slow })
  await connect(accounts, 'luca')
  stub.revokeAll('user-luca') // the old grant is dead at Linear
  now += 24 * 3600_000
  const release = Promise.withResolvers<void>()
  hold = release.promise
  const asking = accounts.request('luca', 'query { viewer { id } }')
  await Bun.sleep(50)
  // Meanwhile luca connects again in another tab (the token endpoint is held only for the refresh).
  hold = null
  await connect(accounts, 'luca')
  const fresh = rows.get('luca')
  hold = release.promise
  release.resolve()
  await expect(asking).rejects.toBeInstanceOf(NotConnected)
  expect(rows.get('luca')).toBe(fresh)
})

test("FORBIDDEN (a good token without the access) isn't refreshed: it's Linear's answer", async () => {
  const { accounts, rows } = setup()
  await connect(accounts, 'luca')
  const before = rows.get('luca')
  const forbidding = new LinearAccounts({
    linear: new Linear({ fetch: (async () => Response.json({ errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] }, { status: 200 })) as unknown as typeof fetch }),
    store: { get: async id => rows.get(id) ?? null, put: async () => {}, delete: async () => {}, replace: async () => false },
    ...oauthFromEnv({ SPHERE_LINEAR_CLIENT_ID: STUB_CLIENT.id, SPHERE_LINEAR_CLIENT_SECRET: STUB_CLIENT.secret, SPHERE_LINEAR_TOKEN_KEY: KEY, SPHERE_LINEAR_REDIRECT_URL: REDIRECT }, { origin: null, linearUrl: stub.url }),
  })
  await expect(forbidding.request('luca', 'mutation { x }')).rejects.toMatchObject({ kind: 'auth', code: 'FORBIDDEN' })
  expect(rows.get('luca')).toBe(before) // no refresh: the same grant
})

test('a connection started while a disconnect waits on Linear is kept, after it', async () => {
  let hold: Promise<void> | null = null
  const slowRevoke = (async (url: string, init: RequestInit) => {
    if (hold && String(url).endsWith('/oauth/revoke')) await hold
    return fetch(url, init)
  }) as unknown as typeof fetch
  const { accounts, rows } = setup({ fetch: slowRevoke })
  await connect(accounts, 'luca')
  const release = Promise.withResolvers<void>()
  hold = release.promise
  const disconnecting = accounts.disconnect('luca')
  await Bun.sleep(30)
  // Another tab connects again: its link starts after the disconnect did.
  const reconnecting = connect(accounts, 'luca', 'user-jp')
  await Bun.sleep(100)
  release.resolve()
  expect(await disconnecting).toEqual({ disconnected: true, revoked: true })
  expect(await reconnecting).toMatchObject({ user: { id: 'user-jp' } })
  expect(await accounts.account('luca')).toMatchObject({ connected: true, user: { id: 'user-jp' } })
  expect(rows.has('luca')).toBe(true)
})
