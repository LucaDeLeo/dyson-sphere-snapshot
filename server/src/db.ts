import type { RoomSnapshot } from '@tldraw/sync-core'
import type { StoredEvent } from '../../shared/protocol'
import { connect } from './pg'

export const sql = connect(process.env.DATABASE_URL ?? 'postgres://localhost/sphere')

export async function migrate() {
  await sql`
    create table if not exists events (
      seq bigserial primary key,
      key text unique,
      topic text not null,
      type text not null,
      actor text not null,
      at timestamptz not null default now(),
      data jsonb not null
    )`
  await sql`create index if not exists events_topic_seq on events (topic, seq)`
  await sql`
    create table if not exists bodies (
      id text primary key,
      text text not null
    )`
  // The canvas document (tldraw), one row per room: its latest snapshot (server/src/canvas.ts).
  await sql`
    create table if not exists canvas_rooms (
      id text primary key,
      snapshot jsonb not null,
      saved_at timestamptz not null default now()
    )`
  // The last event the room had followed (server/src/arrangement.ts). Older servers ignore it.
  await sql`alter table canvas_rooms add column if not exists log_seq bigint`
  // Each person's Linear connection (server/src/linear-accounts.ts), encrypted. Kept out of the
  // event log, which every page can read. Older servers ignore it.
  await sql`
    create table if not exists linear_accounts (
      identity text primary key,
      sealed text not null,
      updated_at timestamptz not null default now()
    )`
}

/** Where people's Linear connections are kept, sealed (see linear-accounts.ts). */
export const linearGrants = {
  async get(identity: string): Promise<string | null> {
    const rows: { sealed: string }[] = await sql`select sealed from linear_accounts where identity = ${identity}`
    return rows[0]?.sealed ?? null
  },
  async put(identity: string, sealed: string) {
    await sql`
      insert into linear_accounts (identity, sealed) values (${identity}, ${sealed})
      on conflict (identity) do update set sealed = excluded.sealed, updated_at = now()`
  },
  async delete(identity: string) {
    await sql`delete from linear_accounts where identity = ${identity}`
  },
  /** Replaces (or with null deletes) the row only if it still holds `from`: false if it changed meanwhile. */
  async replace(identity: string, from: string, to: string | null): Promise<boolean> {
    const rows: unknown[] =
      to === null
        ? await sql`delete from linear_accounts where identity = ${identity} and sealed = ${from} returning identity`
        : await sql`update linear_accounts set sealed = ${to}, updated_at = now() where identity = ${identity} and sealed = ${from} returning identity`
    return rows.length > 0
  },
}

/**
 * A value Postgres can store. jsonb refuses U+0000 ("unsupported Unicode escape sequence") and
 * a UTF-16 surrogate without its pair; a text column refuses U+0000. A tool's output can hold
 * a NUL, and cutting a string by length (`slice`) can split an emoji's pair. So every string,
 * keys included, loses its NULs and has a lone surrogate replaced with U+FFFD. Walks the
 * value rather than its JSON, where `\\u0000` (an escaped backslash) must stay as it is.
 */
export function storable<T>(v: T): T {
  if (typeof v === 'string') return v.replaceAll('\0', '').toWellFormed() as T
  if (Array.isArray(v)) return v.map(storable) as T
  if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k), storable(x)])) as T
  return v
}

/**
 * Postgres refused this data and always will: a data exception (SQLSTATE class 22). Anything
 * else, such as a lost connection, may pass on a retry.
 */
export const refusedData = (e: unknown): e is Error & { errno: string } =>
  e instanceof Error && (e as { code?: unknown }).code === 'ERR_POSTGRES_SERVER_ERROR' && String((e as { errno?: unknown }).errno).startsWith('22')

type Row = { seq: string | number; topic: string; type: string; actor: string; at: Date; data: Record<string, unknown> }

const toEvent = (r: Row): StoredEvent => ({
  seq: Number(r.seq),
  topic: r.topic,
  type: r.type,
  actor: r.actor,
  at: r.at.toISOString(),
  data: r.data,
})

/** Appends an event. Returns null when `key` was already stored (idempotent ingest). */
export async function append(
  e: { key?: string; topic: string; type: string; actor: string; data: Record<string, unknown> },
): Promise<StoredEvent | null> {
  const rows: Row[] = await sql`
    insert into events (key, topic, type, actor, data)
    values (${e.key ?? null}, ${e.topic}, ${e.type}, ${e.actor}, ${storable(e.data)}::jsonb)
    on conflict (key) do nothing
    returning seq, topic, type, actor, at, data`
  return rows[0] ? toEvent(rows[0]) : null
}

export async function since(topic: string, seq: number): Promise<StoredEvent[]> {
  const rows: Row[] = await sql`
    select seq, topic, type, actor, at, data from events
    where topic = ${topic} and seq > ${seq} order by seq`
  return rows.map(toEvent)
}

/** The last `limit` events of a topic, oldest first; with `before`, the last ones before that seq. */
export async function tail(topic: string, limit: number, before: number | null = null): Promise<StoredEvent[]> {
  const rows: Row[] =
    before === null
      ? await sql`
          select seq, topic, type, actor, at, data from events
          where topic = ${topic} order by seq desc limit ${limit}`
      : await sql`
          select seq, topic, type, actor, at, data from events
          where topic = ${topic} and seq < ${before} order by seq desc limit ${limit}`
  return rows.map(toEvent).reverse()
}

/**
 * The seqs of a topic's transcript rows whose text or tool inputs contain `query` (any case), newest
 * first, at most `limit`. Attachment rows (injected context) aren't shown, so aren't searched.
 */
export async function search(topic: string, query: string, limit: number): Promise<number[]> {
  const pattern = `%${query.replace(/[\\%_]/g, m => `\\${m}`)}%`
  const rows: { seq: string | number }[] = await sql`
    select seq from events
    where topic = ${topic} and type = 'session.row' and coalesce(data->>'kind', '') <> 'attachment'
      and ((data->>'text') ilike ${pattern} or (data->'calls')::text ilike ${pattern})
    order by seq desc limit ${limit}`
  return rows.map(r => Number(r.seq))
}

/** Every event in log order, a batch at a time, so a long log needn't fit in memory at once. */
export async function* all(batch = 5000): AsyncGenerator<StoredEvent> {
  for (let after = 0; ; ) {
    const rows: Row[] = await sql`
      select seq, topic, type, actor, at, data from events
      where seq > ${after} order by seq limit ${batch}`
    for (const r of rows) yield toEvent(r)
    if (rows.length < batch) return
    after = Number(rows.at(-1)!.seq)
  }
}

export async function putBody(raw: string): Promise<string> {
  const text = storable(raw)
  const id = new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 32)
  await sql`insert into bodies (id, text) values (${id}, ${text}) on conflict (id) do nothing`
  return id
}

export async function getBody(id: string): Promise<string | null> {
  const rows: { text: string }[] = await sql`select text from bodies where id = ${id}`
  return rows[0]?.text ?? null
}

/** Transcript rows per session per 30 s over the last `minutes`, oldest first. */
export async function activityBuckets(minutes: number): Promise<Record<string, number[]>> {
  const n = minutes * 2
  const rows: { topic: string; slot: number; count: string }[] = await sql`
    select topic,
           floor(extract(epoch from (now() - at)) / 30)::int as slot,
           count(*)::int as count
    from events
    where type = 'session.row' and at > now() - make_interval(mins => ${minutes})
    group by 1, 2`
  const out: Record<string, number[]> = {}
  for (const r of rows) {
    const id = r.topic.slice('session:'.length)
    const buckets = (out[id] ??= new Array(n).fill(0))
    const i = n - 1 - r.slot
    if (i >= 0 && i < n) buckets[i] = Number(r.count)
  }
  return out
}

export async function loadRoom(id: string): Promise<{ snapshot: RoomSnapshot; logSeq: number | null } | null> {
  const rows: { snapshot: RoomSnapshot; log_seq: string | number | null }[] = await sql`select snapshot, log_seq from canvas_rooms where id = ${id}`
  return rows[0] ? { snapshot: rows[0].snapshot, logSeq: rows[0].log_seq === null ? null : Number(rows[0].log_seq) } : null
}

/** Made storable: a note's text could hold a NUL, and one refused save would leave every later edit unsaved. */
export async function saveRoom(id: string, { snapshot, logSeq }: { snapshot: RoomSnapshot; logSeq: number | null }) {
  await sql`
    insert into canvas_rooms (id, snapshot, log_seq) values (${id}, ${storable(snapshot)}::jsonb, ${logSeq})
    on conflict (id) do update set snapshot = excluded.snapshot, log_seq = excluded.log_seq, saved_at = now()`
}

/** Events of these types after `seq`, in log order: what the canvas room may have missed. */
export async function* eventsAfter(seq: number, types: string[], batch = 2000): AsyncGenerator<StoredEvent> {
  for (let after = seq; ; ) {
    const rows: Row[] = await sql`
      select seq, topic, type, actor, at, data from events
      where seq > ${after} and type in ${sql(types)} order by seq limit ${batch}`
    for (const r of rows) yield toEvent(r)
    if (rows.length < batch) return
    after = Number(rows.at(-1)!.seq)
  }
}

export async function lastSeq(): Promise<number> {
  const rows: { seq: string | number | null }[] = await sql`select max(seq) as seq from events`
  return Number(rows[0]?.seq ?? 0)
}
