// A session's terminal, as its bridge relays it (shared/terminal.ts): the tmux pane the agent runs
// in, read through tmux's control mode (`tmux -C`). The bridge runs as the session's owner, so it
// reaches the owner's tmux and nothing else, and it shows the pane, not the whole window.
//
// - Attached to the pane's session by id, with `ignore-size`: the owner's windows keep their size
//   and the window they're on.
// - The screen is `capture-pane` plus the cursor and the terminal modes the pane has set; output
//   follows as tmux reports it (`%output`), in order with command answers.
// - Keys go in with `send-keys -H`, byte for byte, as the owner's terminal sent them.
// - Output is batched (about 60 a second). While the socket to the server is backed up, output is
//   dropped instead of queued, and the whole screen is sent once it drains.
import type { Subprocess } from 'bun'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TERM, type TermFromBridge } from '../../shared/terminal'

/** Where a pane is: tmux's socket and the pane's id (`%3`). */
export type PaneTarget = { socket: string; pane: string }

/** The pane this process runs in, from what tmux puts in its environment. */
export function paneOf(env: Record<string, string | undefined> = process.env): PaneTarget | null {
  const pane = env.TMUX_PANE ?? ''
  const socket = (env.TMUX ?? '').split(',')[0] ?? ''
  return /^%\d+$/.test(pane) && socket.startsWith('/') ? { socket, pane } : null
}

export type PaneIO = {
  send(m: TermFromBridge): void
  /** Bytes the connection to the server hasn't sent yet. */
  buffered(): number
  log?(line: string): void
}

/** tmux's `display` fields for a screen, in this order. */
const FIELDS = [
  'pane_id',
  'pane_width',
  'pane_height',
  'window_width',
  'window_height',
  'cursor_x',
  'cursor_y',
  'cursor_flag',
  'alternate_on',
  'keypad_cursor_flag',
  'keypad_flag',
  'mouse_standard_flag',
  'mouse_button_flag',
  'mouse_any_flag',
  'mouse_sgr_flag',
  'scroll_region_upper',
  'scroll_region_lower',
  'origin_flag',
] as const
type Info = Record<(typeof FIELDS)[number], string>

/** The output tmux sends a control client, `\ooo` escapes and all, as bytes. */
export function unescapeOutput(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  let n = 0
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!
    if (b === 0x5c && i + 3 < data.length && isOctal(data[i + 1]) && isOctal(data[i + 2]) && isOctal(data[i + 3])) {
      out[n++] = ((data[i + 1]! - 48) << 6) | ((data[i + 2]! - 48) << 3) | (data[i + 3]! - 48)
      i += 3
    } else out[n++] = b
  }
  return out.subarray(0, n)
}
const isOctal = (b: number | undefined) => b !== undefined && b >= 48 && b <= 55

/**
 * The whole screen as a terminal draws it: written into a fresh terminal of `cols` × `rows`, `d`
 * leaves it showing what the pane shows, with its history above, the cursor where it is, and the
 * keyboard and mouse modes and the scroll region the program in it asked for. `captured` is the
 * captured rows joined by newlines, none after the last: a blank last row is a row.
 */
export function screenOf(info: Info, captured: string): { cols: number; rows: number; d: string } {
  const lines = captured.split('\n')
  const on = (f: keyof Info) => info[f] === '1'
  let d = ''
  if (on('alternate_on')) d += '\x1b[?1049h'
  d += lines.join('\r\n') + '\x1b[0m'
  if (on('keypad_cursor_flag')) d += '\x1b[?1h'
  if (on('keypad_flag')) d += '\x1b='
  if (on('mouse_standard_flag')) d += '\x1b[?1000h'
  if (on('mouse_button_flag')) d += '\x1b[?1002h'
  if (on('mouse_any_flag')) d += '\x1b[?1003h'
  if (on('mouse_sgr_flag')) d += '\x1b[?1006h'
  // The scroll region (a program like vim keeps its status line out of it), then the cursor:
  // setting a region moves the cursor home, and in origin mode the cursor counts from the region.
  const [top, bottom, rows] = [Number(info.scroll_region_upper), Number(info.scroll_region_lower), Number(info.pane_height)]
  const region = Number.isInteger(top) && Number.isInteger(bottom) && bottom > top && (top > 0 || bottom < rows - 1)
  if (region) d += `\x1b[${top + 1};${bottom + 1}r`
  // Origin mode whether or not the region is short: output that sets a region later relies on it.
  const origin = on('origin_flag')
  if (origin) d += '\x1b[?6h'
  d += `\x1b[${Number(info.cursor_y) - (origin && region ? top : 0) + 1};${Number(info.cursor_x) + 1}H`
  if (!on('cursor_flag')) d += '\x1b[?25l'
  return { cols: Number(info.pane_width), rows: Number(info.pane_height), d }
}

/** Keys as `send-keys -H` commands: every byte as it was typed, a few hundred to a command. */
export function keysOf(pane: string, d: string, binary = false): string[] {
  // xterm's binary input (old-style mouse reports) is bytes as characters: sent as they are, not as UTF-8.
  const bytes = binary ? Uint8Array.from(d, c => c.charCodeAt(0) & 0xff) : new TextEncoder().encode(d)
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 256) {
    const hex = [...bytes.subarray(i, i + 256)].map(b => b.toString(16).padStart(2, '0')).join(' ')
    lines.push(`send-keys -t ${pane} -H ${hex}`)
  }
  return lines
}

type Reply = { ok: boolean; lines: Uint8Array[] }

const FLUSH_MS = 16
/** Over this unsent to the server, output is dropped until it drains below `RESUME_AT`. */
const BACKED_UP = 1024 * 1024
const RESUME_AT = 256 * 1024

export class TmuxPane {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  /** Answers awaited from tmux, in the order the commands went. */
  private waiting: ((r: Reply) => void)[] = []
  /** The answer being read: tmux's `%begin` line's numbers, whether it's ours, and its lines. */
  private block: { tag: string; ours: boolean; lines: Uint8Array[] } | null = null
  private pending = ''
  private decoder = new TextDecoder()
  private flushing: ReturnType<typeof setTimeout> | null = null
  /** Output was dropped: the whole screen goes once the connection drains. */
  private behind = false
  private watch: ReturnType<typeof setInterval> | null = null
  private relayout: ReturnType<typeof setTimeout> | null = null
  private size = { paneW: 0, paneH: 0, windowW: 0, windowH: 0 }
  private closed = false

  constructor(
    private readonly target: PaneTarget,
    private readonly io: PaneIO,
  ) {}

  get open() {
    return !!this.proc
  }

  /** Attaches, if not attached, and sends the whole screen. */
  async start() {
    this.closed = false
    if (!this.proc) {
      const session = await this.sessionOfPane()
      if (!session) return this.fail("The session's tmux pane is gone.")
      const env = { ...process.env }
      delete env.TMUX
      delete env.TMUX_PANE
      // Attached to the pane's tmux session, not the pane: attaching to a pane would switch the
      // owner's window to it. `ignore-size`: this client never resizes the owner's windows.
      this.block = null
      this.proc = Bun.spawn(['tmux', '-S', this.target.socket, '-C', 'attach-session', '-t', session, '-f', 'ignore-size'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      })
      const proc = this.proc
      void this.read(proc)
      void proc.exited.then(() => {
        if (this.proc !== proc) return
        this.proc = null
        this.stop()
        if (!this.closed) this.io.send({ op: 'closed', reason: "The session's tmux pane is gone." })
      })
      this.watch = setInterval(() => this.catchUp(), 250)
    }
    await this.snapshot()
  }

  /** Detaches. */
  close() {
    this.closed = true
    if (this.pasteDir) rmSync(this.pasteDir, { recursive: true, force: true })
    this.pasteDir = null
    this.stop()
    const proc = this.proc
    this.proc = null
    proc?.kill()
  }

  /** A screen being taken, and whether another was asked for meanwhile: one at a time. */
  private snapshotting: Promise<void> | null = null
  private again = false
  /** Output after the screen's place in the stream waits for the screen to go first. */
  private holding = false

  /** Sends the whole screen. */
  snapshot(): Promise<void> {
    if (this.snapshotting) {
      this.again = true
      // Settled once the screen taken after this one has gone.
      return this.snapshotting.then(() => this.snapshotting ?? undefined)
    }
    this.snapshotting = this.takeSnapshot().finally(() => {
      this.snapshotting = null
      this.holding = false
      if (this.again) {
        this.again = false
        void this.snapshot()
      } else if (this.pending) this.flushing ??= setTimeout(() => this.flush(), FLUSH_MS)
    })
    return this.snapshotting
  }

  private async takeSnapshot() {
    const proc = this.proc
    if (!proc) return
    const fmt = FIELDS.map(f => `#{${f}}`).join(' ')
    // Two commands on one line run together, so nothing is drawn between the cursor and the screen.
    // Where the screen's answer ends in tmux's stream is where the screen stands: output before it
    // is in the screen, output after follows it. That's settled as the answer is read, not later.
    const [display, capture] = this.commands(`display-message -p -t ${this.target.pane} '${fmt}' ; capture-pane -p -e -t ${this.target.pane} -S -${TERM.history}`, 2, () => {
      if (this.flushing) clearTimeout(this.flushing)
      this.flushing = null
      this.pending = ''
      this.decoder = new TextDecoder()
      this.behind = false
      this.holding = true
    })
    const [d, c] = await Promise.all([display, capture])
    // Its client went meanwhile (closed, or replaced): this screen is nobody's.
    if (this.proc !== proc) return
    const values = d.ok ? new TextDecoder().decode(d.lines[0] ?? new Uint8Array()).split(' ') : []
    const info = Object.fromEntries(FIELDS.map((f, i) => [f, values[i] ?? ''])) as Info
    // tmux answers for its current pane when the one asked for is gone.
    if (!d.ok || !c.ok || info.pane_id !== this.target.pane) return this.fail("The session's tmux pane is gone.")
    this.size = { paneW: Number(info.pane_width), paneH: Number(info.pane_height), windowW: Number(info.window_width), windowH: Number(info.window_height) }
    const screen = screenOf(info, c.lines.map(l => new TextDecoder().decode(l)).join('\n'))
    this.io.send({ op: 'state', ...screen })
  }

  /** The owner's keys. */
  input(d: string, how: { binary?: boolean; paste?: boolean } = {}) {
    if (!this.proc) return
    if (how.paste && !how.binary) return void this.paste(d)
    for (const line of keysOf(this.target.pane, d, how.binary)) void this.command(line)
  }

  private pasteDir: string | null = null

  /**
   * Pasted text, through a tmux buffer: tmux adds bracketed-paste markers when the program in the
   * pane asked for them, which only tmux knows (a screen doesn't say).
   */
  private async paste(d: string) {
    let file: string | null = null
    try {
      this.pasteDir ??= mkdtempSync(join(tmpdir(), 'sphere-paste-'))
      const name = `sphere-paste-${crypto.randomUUID().slice(0, 8)}`
      file = join(this.pasteDir, name)
      writeFileSync(file, d, { mode: 0o600 })
      await Promise.all(this.commands(`load-buffer -b ${name} '${file}' ; paste-buffer -p -d -b ${name} -t ${this.target.pane}`, 2))
    } catch (e) {
      // A full disk, say: the paste is lost, the bridge goes on.
      this.io.log?.(`terminal: a paste failed (${(e as Error).message})`)
    } finally {
      if (file) rmSync(file, { force: true })
    }
  }

  /** The owner asked for the pane to be this size: its window grows or shrinks by the difference. */
  fit(cols: number, rows: number) {
    if (!this.proc || !this.size.paneW) return
    const x = Math.max(1, cols + this.size.windowW - this.size.paneW)
    const y = Math.max(1, rows + this.size.windowH - this.size.paneH)
    void this.command(`resize-window -t ${this.target.pane} -x ${x} -y ${y}`)
  }

  private async sessionOfPane(): Promise<string | null> {
    const r = Bun.spawnSync(['tmux', '-S', this.target.socket, 'display-message', '-p', '-t', this.target.pane, '#{pane_id} #{session_id}'], { stderr: 'ignore' })
    const [pane, session] = r.stdout.toString().trim().split(' ')
    return r.success && pane === this.target.pane && session?.startsWith('$') ? session : null
  }

  private fail(reason: string) {
    this.io.log?.(`terminal: ${reason}`)
    this.close()
    this.io.send({ op: 'closed', reason })
  }

  private stop() {
    // Whatever was half read belonged to the client that stopped.
    this.block = null
    this.decoder = new TextDecoder()
    if (this.flushing) clearTimeout(this.flushing)
    if (this.watch) clearInterval(this.watch)
    if (this.relayout) clearTimeout(this.relayout)
    this.flushing = this.watch = this.relayout = null
    this.pending = ''
    for (const w of this.waiting.splice(0)) w({ ok: false, lines: [] })
  }

  private command(line: string): Promise<Reply> {
    return this.commands(line, 1)[0]!
  }

  /** Writes a line of `n` commands; each answer comes in order. `atLast` runs as the last answer is read. */
  private commands(line: string, n: number, atLast?: () => void): Promise<Reply>[] {
    const answers = Array.from({ length: n }, (_, i) => new Promise<Reply>(resolve => this.waiting.push(i === n - 1 && atLast ? r => (r.ok && atLast(), resolve(r)) : resolve)))
    if (!this.proc) {
      for (const w of this.waiting.splice(0)) w({ ok: false, lines: [] })
      return answers
    }
    this.proc.stdin.write(line + '\n')
    void this.proc.stdin.flush()
    return answers
  }

  private async read(proc: Subprocess<'pipe', 'pipe', 'pipe'>) {
    let buf = new Uint8Array(0)
    const reader = proc.stdout.getReader()
    for (;;) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      const joined = new Uint8Array(buf.length + chunk.length)
      joined.set(buf)
      joined.set(chunk, buf.length)
      let start = 0
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] !== 0x0a) continue
        // A client that has gone (closed, or replaced by a new one) is read no further: its
        // half-read answers mustn't be taken for the new client's.
        if (this.proc !== proc) return void reader.cancel().catch(() => {})
        this.line(joined.subarray(start, i))
        start = i + 1
      }
      buf = joined.slice(start)
    }
  }

  private line(line: Uint8Array) {
    const head = new TextDecoder().decode(line.subarray(0, Math.min(line.length, 64)))
    if (this.block) {
      // An answer ends with the numbers it began with: a line of output can't pass for its end.
      if ((head.startsWith('%end ') || head.startsWith('%error ')) && head.slice(head.indexOf(' ') + 1).trimEnd() === this.block.tag) {
        const done = this.block
        this.block = null
        if (done.ours) this.waiting.shift()?.({ ok: head.startsWith('%end '), lines: done.lines })
      } else this.block.lines.push(line.slice())
      return
    }
    if (head.startsWith('%begin ')) {
      const tag = head.slice('%begin '.length).trimEnd()
      // The last number says whether this client sent the command (the attach's own answer doesn't count).
      this.block = { tag, ours: tag.endsWith(' 1'), lines: [] }
      return
    }
    const prefix = `%output ${this.target.pane} `
    if (head.startsWith(prefix)) return this.output(unescapeOutput(line.subarray(prefix.length)))
    // Panes resized or closed: the screen again (and the pane checked), once they settle.
    if (head.startsWith('%layout-change') || head.startsWith('%window-close') || head.startsWith('%unlinked-window-close')) {
      if (this.relayout) clearTimeout(this.relayout)
      this.relayout = setTimeout(() => ((this.relayout = null), void this.snapshot()), 50)
      return
    }
    if (head.startsWith('%exit')) this.proc?.kill()
  }

  private output(bytes: Uint8Array) {
    if (this.behind) return
    this.pending += this.decoder.decode(bytes, { stream: true })
    if (this.pending.length > 64 * 1024) this.flush()
    else this.flushing ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush() {
    if (this.flushing) clearTimeout(this.flushing)
    this.flushing = null
    if (!this.pending || this.holding) return
    if (this.io.buffered() > BACKED_UP) {
      // Behind: drop it all, and send the screen once the connection drains.
      this.behind = true
      this.pending = ''
      return
    }
    const d = this.pending
    this.pending = ''
    this.io.send({ op: 'out', d })
  }

  private catchUp() {
    if (this.behind && this.io.buffered() < RESUME_AT) void this.snapshot()
  }
}
