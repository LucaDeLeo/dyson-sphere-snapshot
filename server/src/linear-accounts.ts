// Each person's own Linear account (CS-2524): connected from Dyson Sphere with Linear's OAuth 2
// authorization-code flow and PKCE, so what they change in Linear from here is done as them.
//
// - `start` makes a single-use `state` (10 minutes) bound to the person, and the PKCE verifier;
//   Linear sends the browser back to the callback with a code, which `finish` exchanges.
// - Tokens are kept in Postgres encrypted (AES-256-GCM with SPHERE_LINEAR_TOKEN_KEY), so a
//   database backup alone gives nobody a usable token. They never leave the server: pages and
//   the CLI see only whether a person is connected, and as whom.
// - Access tokens last 24 hours. One about to expire is refreshed first; Linear rotates the
//   refresh token each time. A token Linear refuses is refreshed once and the request retried.
//   A refresh Linear refuses (`invalid_grant`: the person revoked the app, or it was removed)
//   ends the connection, and the person is told to connect again.
// - Disconnecting revokes the token at Linear (best effort) and deletes it here.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { LinearAccount, LinearUser } from '../../shared/protocol'
import { Linear, LINEAR_URL, LinearError, type LinearAuth } from './linear'

/** Read for tickets, write for changing them. Linear's scopes are comma-separated. */
export const LINEAR_SCOPES = 'read,write'
/** How long a connect link stays good. */
const STATE_MS = 10 * 60_000
/** A token this close to expiring is refreshed before it's used. */
const REFRESH_EARLY_MS = 2 * 60_000

/** What's stored per person, encrypted. */
type Grant = {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms; null when Linear gave no lifetime (apps from before refresh tokens). */
  expiresAt: number | null
  scope: string
  user: LinearUser
  connectedAt: string
}


/** Where encrypted grants are kept: Postgres in the server (db.ts), a map in tests. */
export type GrantStore = {
  get(identity: string): Promise<string | null>
  put(identity: string, sealed: string): Promise<void>
  delete(identity: string): Promise<void>
  /** Replaces (null: deletes) the row only if it still holds `from`; false if it changed meanwhile. */
  replace(identity: string, from: string, to: string | null): Promise<boolean>
}

/** Why a change in Linear can't be made as this person: they haven't connected, or their connection ended. */
export class NotConnected extends Error {}

export type OAuthConfig = {
  clientId: string
  clientSecret: string
  /** Exactly as registered in Linear's OAuth app: `<Dyson Sphere origin>/linear/callback`. */
  redirectUri: string
  /** Defaults: Linear's own. A stand-in serves all three under one origin. */
  authorizeUrl?: string
  tokenUrl?: string
  revokeUrl?: string
}

/**
 * SPHERE_LINEAR_TOKEN_KEY as a 256-bit key. Any string of 32 or more characters; hashed, so
 * `openssl rand -base64 32` works as it comes.
 */
export function tokenKey(raw: string): Buffer {
  if (raw.length < 32) throw new Error('SPHERE_LINEAR_TOKEN_KEY must be at least 32 characters (try `openssl rand -base64 32`)')
  return createHash('sha256').update(raw).digest()
}

/** AES-256-GCM, bound to the person it belongs to: one person's row copied to another's doesn't open. */
export function seal(key: Buffer, identity: string, value: unknown): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(`linear-grant:${identity}`))
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${c.getAuthTag().toString('base64url')}`
}

export function unseal<T>(key: Buffer, identity: string, sealed: string): T {
  const [v, iv, body, tag] = sealed.split('.')
  if (v !== 'v1' || !iv || !body || !tag) throw new Error('unknown token format')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(`linear-grant:${identity}`))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')) as T
}

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')

/** `era`: the person's disconnect count when the link was made (see `eras`). */
type Pending = { identity: string; verifier: string; expires: number; era: number }

type Options = {
  linear: Linear
  /** Null: the feature is off, for `reason`. */
  oauth: OAuthConfig | null
  key: Buffer | null
  store: GrantStore
  reason?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (m: string) => void
}

export class LinearAccounts {
  private pending = new Map<string, Pending>()
  /** One refresh at a time per person: Linear rotates refresh tokens, so two at once would lose one. */
  private refreshing = new Map<string, Promise<Grant>>()
  /**
   * Disconnects per person. A connection or refresh that was under way when the person
   * disconnected doesn't save what it got: it revokes it instead, so a disconnect stays done.
   */
  private eras = new Map<string, number>()
  private now: () => number
  private log: (m: string) => void

  constructor(private o: Options) {
    this.now = o.now ?? Date.now
    this.log = o.log ?? (m => console.warn(m))
  }

  get enabled(): boolean {
    return !!(this.o.oauth && this.o.key)
  }

  /** Why it's off, for pages and the CLI. */
  get reason(): string {
    return this.o.reason ?? 'Linear accounts are not set up on this server.'
  }

  async account(identity: string): Promise<LinearAccount> {
    if (!this.enabled) return { enabled: false, reason: this.reason }
    const g = await this.grant(identity)
    return g ? { enabled: true, connected: true, user: g.user, connectedAt: g.connectedAt } : { enabled: true, connected: false }
  }

  /** The address that asks Linear for this person's consent. Linear sends them back to the callback. */
  start(identity: string): string {
    const oauth = this.need()
    const now = this.now()
    for (const [s, p] of this.pending) if (p.expires < now) this.pending.delete(s)
    const state = b64url(randomBytes(32))
    const verifier = b64url(randomBytes(32))
    this.pending.set(state, { identity, verifier, expires: now + STATE_MS, era: this.era(identity) })
    const url = new URL(oauth.authorizeUrl ?? 'https://linear.app/oauth/authorize')
    url.search = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      response_type: 'code',
      scope: LINEAR_SCOPES,
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      actor: 'user',
      // Asks every time, so a person can pick another workspace or account on reconnecting.
      prompt: 'consent',
    }).toString()
    return url.toString()
  }

  /**
   * Linear's answer at the callback. `signedIn` is who the browser is signed in as, when the
   * server knows (behind Tailscale): it must be who started, so a link someone else started
   * can't connect their Linear to this person. Returns who was connected, and to whom.
   */
  async finish(q: { state: string | null; code: string | null; error: string | null }, signedIn: string | null): Promise<{ identity: string; user: LinearUser }> {
    const oauth = this.need()
    const p = q.state ? this.pending.get(q.state) : undefined
    if (!p || p.expires < this.now()) throw new NotConnected('This link to connect Linear has expired or was already used. Start again from Dyson Sphere.')
    if (signedIn !== null && signedIn !== p.identity) throw new NotConnected(`This link was started by ${p.identity}; you're signed in as ${signedIn}.`)
    this.pending.delete(q.state!)
    if (q.error) throw new NotConnected(q.error === 'access_denied' ? 'Linear access was not granted.' : `Linear answered: ${q.error.slice(0, 100)}`)
    if (!q.code) throw new NotConnected('Linear sent no code.')
    const token = await this.token({ grant_type: 'authorization_code', code: q.code, redirect_uri: oauth.redirectUri, code_verifier: p.verifier })
    const user = await this.viewer({ accessToken: token.accessToken })
    const grant: Grant = { ...token, user, connectedAt: new Date(this.now()).toISOString() }
    // Checked and saved under the person's lock, so a disconnect can't come between the two.
    const saved = await this.locked(p.identity, async () => {
      if (this.era(p.identity) !== p.era) return false
      await this.save(p.identity, grant)
      return true
    })
    if (!saved) {
      await this.revoke(p.identity, grant)
      throw new NotConnected('You disconnected Linear while this link was open. Connect again if you meant to.')
    }
    return { identity: p.identity, user }
  }

  /**
   * Forgets the person's connection and asks Linear to revoke its tokens. `revoked` is false when
   * Linear couldn't be asked or refused; the person can revoke the app in Linear's settings.
   */
  async disconnect(identity: string): Promise<{ disconnected: boolean; revoked: boolean }> {
    this.eras.set(identity, this.era(identity) + 1)
    // A refresh under way finishes first (or gives up, seeing the new era), so the tokens revoked are the latest.
    await this.refreshing.get(identity)?.catch(() => {})
    // Under the person's lock: no connection or refresh saves between reading the row and
    // deleting it. One whose link started after this disconnect saves once it's done.
    return this.locked(identity, async () => {
      // Deleted even when it can't be opened (the key changed, or the feature is off), so a
      // disconnect never comes back when the settings do; revoked only when it can be.
      const stored = await this.read(identity)
      if (!stored) return { disconnected: false, revoked: false }
      const revoked = stored.grant && this.o.oauth ? await this.revoke(identity, stored.grant) : false
      await this.o.store.delete(identity)
      return { disconnected: true, revoked }
    })
  }

  /** Per person, one at a time: saving a connection, saving or ending a refresh, disconnecting. */
  private locks = new Map<string, Promise<unknown>>()
  private locked<T>(identity: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(identity) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => {})
    this.locks.set(identity, tail)
    void tail.then(() => this.locks.get(identity) === tail && this.locks.delete(identity))
    return run
  }

  private era = (identity: string) => this.eras.get(identity) ?? 0

  /** Asks Linear to revoke a grant's tokens. One Linear says is already revoked (400) counts as revoked. */
  private async revoke(identity: string, g: Pick<Grant, 'accessToken' | 'refreshToken'>): Promise<boolean> {
    let ok = true
    for (const [token, hint] of [[g.refreshToken, 'refresh_token'], [g.accessToken, 'access_token']] as const) {
      if (!token) continue
      try {
        const res = await this.fetch(this.o.oauth?.revokeUrl ?? 'https://api.linear.app/oauth/revoke', { token, token_type_hint: hint })
        if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`)
      } catch (e) {
        ok = false
        this.log(`Linear: couldn't revoke ${identity}'s ${hint} (${(e as Error).message}); it stays valid at Linear until it expires or is revoked in Linear's settings.`)
      }
    }
    return ok
  }

  /**
   * One query or mutation as this person. Throws NotConnected when they have no connection, or
   * it has ended; LinearError for anything Linear refuses.
   */
  async request<T>(identity: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.enabled) throw new NotConnected(this.reason)
    let g = await this.grant(identity)
    if (!g) throw new NotConnected(`${identity} hasn't connected a Linear account to Dyson Sphere.`)
    if (g.expiresAt !== null && g.expiresAt - REFRESH_EARLY_MS < this.now()) g = await this.refresh(identity, g)
    try {
      return await this.o.linear.request<T>({ accessToken: g.accessToken }, query, variables)
    } catch (e) {
      // The token refused (401, AUTHENTICATION_ERROR): perhaps revoked, perhaps expired early, and
      // one refresh tells which. FORBIDDEN (403) is a good token without the access; a refresh
      // wouldn't change that, and would spend a rotation of the refresh token.
      if (!(e instanceof LinearError && e.kind === 'auth' && e.status !== 403 && e.code !== 'FORBIDDEN')) throw e
      const fresh = await this.refresh(identity, g)
      return this.o.linear.request<T>({ accessToken: fresh.accessToken }, query, variables)
    }
  }

  private refresh(identity: string, g: Grant): Promise<Grant> {
    const running = this.refreshing.get(identity)
    if (running) return running
    const era = this.era(identity)
    const run = (async () => {
      // Another request may have refreshed while this one waited.
      const stored = await this.read(identity)
      const now = stored?.grant
      if (!stored || !now) throw new NotConnected(`${identity}'s Linear connection has ended. Connect again from Dyson Sphere.`)
      if (now.accessToken !== g.accessToken) return now
      // What changes the row is conditional on what was read here: a new connection saved
      // meanwhile (by `finish`) is neither deleted nor overwritten.
      if (!now.refreshToken) return this.end(identity, stored.sealed, 'Linear refused the token and gave no way to renew it')
      let token: Omit<Grant, 'user' | 'connectedAt'>
      try {
        token = await this.token({ grant_type: 'refresh_token', refresh_token: now.refreshToken })
      } catch (e) {
        if (e instanceof OAuthRefused) return this.end(identity, stored.sealed, e.message)
        throw e
      }
      const next = { ...now, ...token, refreshToken: token.refreshToken ?? now.refreshToken }
      const saved = await this.locked(identity, async () => this.era(identity) === era && (await this.o.store.replace(identity, stored.sealed, seal(this.o.key!, identity, next))))
      if (!saved) {
        // Disconnected, or connected anew, meanwhile: what Linear just gave is revoked, not saved.
        await this.revoke(identity, next)
        const current = this.era(identity) === era ? await this.grant(identity) : null
        if (current) return current
        throw new NotConnected(`${identity} disconnected Linear.`)
      }
      return next
    })()
    this.refreshing.set(identity, run)
    void run.finally(() => this.refreshing.delete(identity)).catch(() => {})
    return run
  }

  private async end(identity: string, sealed: string, why: string): Promise<never> {
    // Only the grant that failed: a connection made meanwhile stays.
    if (!(await this.o.store.replace(identity, sealed, null))) {
      const current = await this.grant(identity)
      if (current) throw new NotConnected(`${identity}'s Linear connection changed while it was being renewed; try again.`)
    }
    this.log(`Linear: ${identity}'s connection ended (${why}).`)
    throw new NotConnected(`${identity}'s Linear connection has ended (it was revoked or expired). Connect again from Dyson Sphere.`)
  }

  private async grant(identity: string): Promise<Grant | null> {
    return (await this.read(identity))?.grant ?? null
  }

  /** The stored row and what it opens to: null if there's no row; `grant` null if it can't be opened. */
  private async read(identity: string): Promise<{ sealed: string; grant: Grant | null } | null> {
    const sealed = await this.o.store.get(identity)
    if (!sealed) return null
    if (!this.o.key) return { sealed, grant: null }
    try {
      return { sealed, grant: unseal<Grant>(this.o.key, identity, sealed) }
    } catch {
      // Sealed with another key (SPHERE_LINEAR_TOKEN_KEY changed): as good as not connected.
      this.log(`Linear: ${identity}'s stored token can't be opened with SPHERE_LINEAR_TOKEN_KEY; they need to connect again.`)
      return { sealed, grant: null }
    }
  }

  private save(identity: string, g: Grant) {
    return this.o.store.put(identity, seal(this.o.key!, identity, g))
  }

  private need(): OAuthConfig {
    if (!this.o.oauth || !this.o.key) throw new NotConnected(this.reason)
    return this.o.oauth
  }

  /** Linear's token endpoint: an authorization code or a refresh token for an access token. */
  private async token(params: Record<string, string>): Promise<Omit<Grant, 'user' | 'connectedAt'>> {
    const oauth = this.need()
    const res = await this.fetch(oauth.tokenUrl ?? 'https://api.linear.app/oauth/token', { ...params, client_id: oauth.clientId, client_secret: oauth.clientSecret })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const error = typeof body?.error === 'string' ? body.error.slice(0, 80) : null
    // Only `invalid_grant` is about this grant (a used or wrong code, a revoked refresh token). Any
    // other refusal, such as `invalid_client` after a wrong secret is deployed, is the server's
    // setup: the person's connection stays, to work again once the setup is fixed.
    if (error === 'invalid_grant') throw new OAuthRefused(`Linear refused the ${params.grant_type === 'refresh_token' ? 'refresh token' : 'code'} (invalid_grant)`)
    if (res.status === 400 || res.status === 401) {
      this.log(`Linear: the token endpoint refused this server (${error ?? `HTTP ${res.status}`}); check SPHERE_LINEAR_CLIENT_ID, SPHERE_LINEAR_CLIENT_SECRET and the redirect URL.`)
      throw new LinearError(`Linear refused Dyson Sphere's OAuth app (${error ?? `HTTP ${res.status}`}); the server's Linear settings need fixing`, 'unavailable', res.status)
    }
    if (!res.ok || typeof body?.access_token !== 'string') throw new LinearError(`Linear's token endpoint answered HTTP ${res.status}`, 'unavailable', res.status)
    const expiresIn = Number(body.expires_in)
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? this.now() + expiresIn * 1000 : null,
      scope: Array.isArray(body.scope) ? body.scope.join(' ') : String(body.scope ?? ''),
    }
  }

  private async fetch(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await (this.o.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      throw new LinearError(`can't reach Linear (${(e as Error).message})`, 'unavailable')
    }
  }

  private async viewer(auth: LinearAuth): Promise<LinearUser> {
    const d = await this.o.linear.request<{ viewer?: { id?: unknown; name?: unknown; displayName?: unknown; email?: unknown } }>(auth, 'query Viewer { viewer { id name displayName email } }')
    const v = d.viewer
    if (typeof v?.id !== 'string') throw new LinearError("Linear's answer had no viewer", 'rejected')
    const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : null)
    return { id: v.id, name: text(v.name) ?? text(v.displayName) ?? 'Linear user', email: text(v.email) }
  }
}

/** Linear's token endpoint refused the grant (`invalid_grant`): a bad code, or a refresh token that no longer works. */
class OAuthRefused extends NotConnected {}

/** The settings, from the server's environment. Off, with the reason, when any is missing. */
export function oauthFromEnv(env: Record<string, string | undefined>, defaults: { origin: string | null; linearUrl: string | null }): { oauth: OAuthConfig | null; key: Buffer | null; reason?: string } {
  const clientId = env.SPHERE_LINEAR_CLIENT_ID?.trim()
  const clientSecret = env.SPHERE_LINEAR_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return { oauth: null, key: null, reason: 'Linear accounts are off on this server: SPHERE_LINEAR_CLIENT_ID and SPHERE_LINEAR_CLIENT_SECRET are not set.' }
  let key: Buffer
  try {
    key = tokenKey(env.SPHERE_LINEAR_TOKEN_KEY ?? '')
  } catch (e) {
    return { oauth: null, key: null, reason: `Linear accounts are off on this server: ${(e as Error).message}.` }
  }
  const redirectUri = env.SPHERE_LINEAR_REDIRECT_URL?.trim() || (defaults.origin && `${defaults.origin}/linear/callback`)
  if (!redirectUri) return { oauth: null, key: null, reason: "Linear accounts are off on this server: set SPHERE_ORIGIN (the canvas's address), which Linear sends people back to." }
  // A stand-in for Linear (SPHERE_LINEAR_URL) serves OAuth under its own origin too. Linear's own
  // API, named explicitly, keeps Linear's OAuth addresses (consent is on linear.app, not api.).
  const origin = defaults.linearUrl ? new URL(defaults.linearUrl).origin : null
  const base = origin && origin !== new URL(LINEAR_URL).origin ? origin : null
  return {
    key,
    oauth: {
      clientId,
      clientSecret,
      redirectUri,
      ...(base && { authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`, revokeUrl: `${base}/oauth/revoke` }),
    },
  }
}
