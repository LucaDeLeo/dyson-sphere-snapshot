// The ticket a session works on, which the bridge sends with session.started: estra's label,
// a ticket id in the branch name, or the Linear issue Orca links to the worktree, in that order.
import { join } from 'node:path'
import { findTicket, type SessionTicket } from '../../shared/protocol'

function git(cwd: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'ignore' })
  return r.success ? r.stdout.toString().trim() || null : null
}

/**
 * The Linear issue Orca links to the worktree an Orca pane was opened in. Orca keeps it in its
 * own records, not in the pane's environment, so its CLI is asked: only for the pane's own
 * worktree (ORCA_WORKTREE_ID is `<repo id>::<path>`), and for 2 seconds at most.
 */
export function orcaLink(root: string, env: Record<string, string | undefined> = process.env): string | null {
  const worktree = env.ORCA_WORKTREE_ID
  const path = worktree?.slice(worktree.indexOf('::') + 2)
  // Orca keeps some paths in lower case; macOS paths aren't case-sensitive.
  if (!worktree || !path || path.toLowerCase() !== root.toLowerCase()) return null
  try {
    const orca = env.ORCA_CLI_BIN_DIR ? join(env.ORCA_CLI_BIN_DIR, 'orca') : 'orca'
    const r = Bun.spawnSync([orca, 'worktree', 'show', '--worktree', `id:${worktree}`, '--json'], { stdin: 'ignore', stderr: 'ignore', timeout: 2000, env })
    if (!r.success) return null
    const id = JSON.parse(r.stdout.toString())?.result?.worktree?.linkedLinearIssue
    return typeof id === 'string' ? id : null
  } catch {
    return null // no orca here
  }
}

export function sessionTicket(cwd: string, estraTicket: string | null | undefined): SessionTicket | null {
  return findTicket({
    estra: estraTicket,
    branch: git(cwd, 'branch', '--show-current'),
    orca: () => {
      const root = git(cwd, 'rev-parse', '--show-toplevel')
      return root ? orcaLink(root) : null
    },
  })
}
