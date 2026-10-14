// For tests of the canvas room: sphere-server as a process, tldraw pages as tldraw's own sync
// client (no browser), and a bridge that starts sessions.
import { atom } from '@tldraw/state'
import { Store } from '@tldraw/store'
import * as sync from '@tldraw/sync-core'
import { TLSyncClient, type TLPersistentClientSocket } from '@tldraw/sync-core'
import type { TLRecord, TLShape } from '@tldraw/tlschema'
import type { Subprocess } from 'bun'
import { canvasSchema } from '../shared/canvas'
import { Client } from '../sphere/src/client'

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/sphere_test'

// The socket tldraw's own pages use: exported, but left out of the published types.
const { ClientWebSocketAdapter } = sync as unknown as { ClientWebSocketAdapter: new (uri: () => string) => TLPersistentClientSocket<any, any> & { close(): void } }

// ClientWebSocketAdapter listens for the window going on- and offline and the tab being shown,
// the store reads the screen's pixel ratio and batches its effects into frames.
;(globalThis as any).window ??= globalThis
;(globalThis as any).devicePixelRatio ??= 1
;(globalThis as any).document ??= Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false })
;(globalThis as any).requestAnimationFrame ??= (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16)
;(globalThis as any).cancelAnimationFrame ??= (t: ReturnType<typeof setTimeout>) => clearTimeout(t)

/** sphere-server on `port`, against DATABASE_URL. */
export function sphereServer(port: number, env: Record<string, string> = {}) {
  let proc: Subprocess | null = null
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    http: `http://127.0.0.1:${port}`,
    async start() {
      proc = Bun.spawn(['bun', 'run', 'server/src/main.ts'], {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, DATABASE_URL, SPHERE_PORT: String(port), NODE_ENV: 'test', ...env },
        stdout: 'ignore',
        stderr: 'inherit',
      })
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return
        } catch {}
        await Bun.sleep(100)
      }
      throw new Error('sphere-server did not start')
    },
    /** As systemd stops it: SIGTERM, then the server saves the canvas and exits. */
    async stop() {
      proc?.kill('SIGTERM')
      await proc?.exited
      proc = null
    },
  }
}

export type Page = { store: Store<TLRecord>; shape(id: string): TLShape | undefined; close(): void }

/** A tldraw page signed in with this token, synced with the room. */
export async function openPage(port: number, token = 'dev-luca', schema: typeof canvasSchema = canvasSchema): Promise<Page> {
  const store = new Store<TLRecord, any>({ schema, props: {} })
  const socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${port}/canvas?token=${token}`)
  let client!: TLSyncClient<TLRecord>
  await new Promise<void>((resolve, reject) => {
    client = new TLSyncClient({ store, socket, presence: atom('presence', null), onLoad: () => resolve(), onSyncError: reject })
  })
  return { store, shape: id => store.get(id as any) as TLShape | undefined, close: () => (client.close(), socket.close()) }
}

/** Waits until `check` passes, for changes that travel through the server. */
export async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

/** A bridge's connection, and a session started on it in `repo`. */
export async function startSession(url: string, opts: { token?: string; repo?: string; branch?: string } = {}) {
  const client = new Client({ url, token: opts.token ?? 'dev-luca' }, 'bridge')
  await client.connect()
  const id = crypto.randomUUID()
  await client.cmd('ingest', {
    events: [
      {
        key: crypto.randomUUID(),
        type: 'session.started',
        holder: 'laptop:1',
        data: { sessionId: id, machine: 'laptop', cwd: '/tmp/x', repo: opts.repo ?? 'api', branch: opts.branch ?? 'main', pid: 1, interactive: true },
      },
    ],
  })
  return { id, client }
}
