// `sphere move`: hands a session to another checkout, carrying its code state and transcript.
//
// Spike scope: source and target are on this machine (the target stands in for the
// server's dev container). The real version uploads the WIP ref and transcript through
// sphere-server and resumes inside the owner's container.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary } from '../../shared/protocol'
import { CmdFailure, type Client } from './client'

/** Claude Code names a project's transcript folder after its path: realpath, non-alphanumerics → `-`. */
export const projectSlug = (dir: string) => realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-')

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...env }, stderr: 'pipe' })
  if (!r.success) throw new CmdFailure(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`, 'other')
  return r.stdout.toString().trim()
}

/** Commits the working tree (tracked and untracked, minus ignored) without touching the index or branch. */
function snapshot(src: string, sessionId: string): { commit: string; head: string; branch: string | null } {
  const head = git(src, ['rev-parse', 'HEAD'])
  const branch = git(src, ['branch', '--show-current']) || null
  const index = join(tmpdir(), `sphere-index-${sessionId}`)
  copyFileSync(git(src, ['rev-parse', '--path-format=absolute', '--git-path', 'index']), index)
  try {
    git(src, ['add', '-A'], { GIT_INDEX_FILE: index })
    const tree = git(src, ['write-tree'], { GIT_INDEX_FILE: index })
    const commit = git(src, ['commit-tree', tree, '-p', head, '-m', `sphere: work in progress of session ${sessionId}`])
    git(src, ['update-ref', `refs/sphere/move/${sessionId}`, commit])
    return { commit, head, branch }
  } finally {
    rmSync(index, { force: true })
  }
}

/** Copies a transcript file or folder, rewriting the old absolute path to the new one. */
function copyTranscript(from: string, to: string, srcPath: string, dstPath: string) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) copyTranscript(join(from, name), join(to, name), srcPath, dstPath)
    return
  }
  if (srcPath === dstPath || !/\.(jsonl|json)$/.test(from)) return cpSync(from, to)
  // Paths appear inside JSON strings, so swap their JSON-escaped forms: a path with a quote
  // or backslash in it stays valid JSON.
  const escaped = (p: string) => JSON.stringify(p).slice(1, -1)
  writeFileSync(to, readFileSync(from, 'utf8').replaceAll(escaped(srcPath), escaped(dstPath)))
}

export async function move(c: Client, ref: string, to: string, opts: { launch: boolean; pluginDir: string | null }) {
  const { session } = await c.cmd<{ session: SessionSummary }>('show', { sessionId: ref, tail: 0 })
  if (session.owner !== c.identity) throw new CmdFailure(`only ${session.owner} can move this session`, 'auth')
  // Before anything changes: what's moved is a Claude Code transcript.
  if (session.agent === 'codex') throw new CmdFailure("Codex sessions can't be moved yet: move carries a Claude Code session's transcript", 'user')
  if (session.machine !== hostname()) throw new CmdFailure(`run move on ${session.machine}, where the session runs`, 'user')
  if (session.state === 'working') throw new CmdFailure('the session is working; wait for idle or interrupt it first', 'conflict')
  if (session.subagents?.length) throw new CmdFailure(`${session.subagents.length} subagent${session.subagents.length > 1 ? 's are' : ' is'} still running; wait for them to finish first`, 'conflict')
  if (!existsSync(to)) throw new CmdFailure(`no directory ${to}`, 'user')

  const src = realpathSync(session.cwd)
  const dst = realpathSync(to)
  const notes: string[] = []

  // 1. Code state: a WIP commit on a private ref, fetched into the target.
  const snap = snapshot(src, session.id)
  git(dst, ['fetch', '--quiet', src, `refs/sphere/move/${session.id}`])
  git(dst, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'])
  git(dst, ['reset', '--quiet', '--soft', 'HEAD~1']) // WIP changes stay staged on top of the source HEAD
  if (snap.branch) {
    // Reuse the target's branch only when that loses nothing: it must not exist there yet,
    // or must already be part of the source's history.
    const exists = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${snap.branch}`], { cwd: dst }).success
    const behind = exists && Bun.spawnSync(['git', 'merge-base', '--is-ancestor', `refs/heads/${snap.branch}`, snap.head], { cwd: dst }).success
    if (exists && !behind) {
      notes.push(`branch ${snap.branch} in the target has commits the source doesn't, so it was left alone and the target is detached at ${snap.head.slice(0, 8)}`)
    } else {
      try {
        git(dst, ['checkout', '--quiet', '-B', snap.branch])
      } catch {
        notes.push(`branch ${snap.branch} is checked out in another worktree, so the target is detached at ${snap.head.slice(0, 8)}`)
      }
    }
  }

  // 2. Transcript, under the target's project folder.
  const projects = join(homedir(), '.claude', 'projects')
  const from = join(projects, projectSlug(src))
  const dest = join(projects, projectSlug(dst))
  mkdirSync(dest, { recursive: true })
  copyTranscript(join(from, `${session.id}.jsonl`), join(dest, `${session.id}.jsonl`), src, dst)
  if (existsSync(join(from, session.id))) copyTranscript(join(from, session.id), join(dest, session.id), src, dst)

  await c.cmd('moved', { sessionId: session.id, to: { machine: hostname(), cwd: dst }, wip: snap.commit })

  const resume = ['claude', '--resume', session.id, ...(opts.pluginDir ? ['--plugin-dir', opts.pluginDir] : [])]
  // tmux runs it through a shell, so each word is quoted.
  const command = resume.map(w => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(' ')
  let launched: string | null = null
  if (opts.launch) {
    launched = `sphere-${session.id.slice(0, 8)}`
    // A running tmux server starts sessions with its own environment, not ours: pass ours on.
    // Nobody watches a launched session, so its permission requests stop waiting after a while.
    const env = Object.entries(process.env).filter(([k]) => k.startsWith('SPHERE_'))
    if (!process.env.SPHERE_PERMISSION_WAIT_MINUTES) env.push(['SPHERE_PERMISSION_WAIT_MINUTES', '10'])
    const r = Bun.spawnSync(['tmux', 'new-session', '-d', '-s', launched, '-c', dst, ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`]), command], { stderr: 'pipe' })
    if (!r.success) notes.push(`tmux failed: ${r.stderr.toString().trim()}`)
  }
  notes.push('background processes the session started (dev servers, Monitor watches) do not move')
  return { sessionId: session.id, from: src, to: dst, wip: snap.commit, resume: command, tmux: launched, notes }
}
