import { SQL } from 'bun'

/**
 * A Postgres connection from a URL. `?host=/run/postgresql`, as libpq writes it, connects over that
 * directory's Unix socket (peer authentication, no password); Bun's URL parsing doesn't read it.
 */
export function connect(url: string): SQL {
  const u = new URL(url)
  const dir = u.searchParams.get('host')
  if (!dir?.startsWith('/')) return new SQL(url)
  u.searchParams.delete('host')
  return new SQL({ url: u.toString(), path: `${dir.replace(/\/$/, '')}/.s.PGSQL.${u.port || 5432}` })
}
