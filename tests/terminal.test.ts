// A session's terminal as its bridge relays it (sphere/src/terminal.ts): against a real tmux, on
// a server of its own, when tmux is installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TermFromBridge } from '../shared/terminal'
import { keysOf, paneOf, screenOf, TmuxPane, unescapeOutput } from '../sphere/src/terminal'

const tmuxVersion = Bun.spawnSync(['tmux', '-V'], { stderr: 'ignore' })
const haveTmux = tmuxVersion.success

describe('pieces', () => {
  test('the pane comes from what tmux puts in the environment', () => {
    expect(paneOf({ TMUX: '/tmp/tmux-1000/default,1234,0', TMUX_PANE: '%3' })).toEqual({ socket: '/tmp/tmux-1000/default', pane: '%3' })
    expect(paneOf({ TMUX_PANE: '%3' })).toBeNull()
    expect(paneOf({ TMUX: 'default,1,0', TMUX_PANE: '%3' })).toBeNull()
    expect(paneOf({ TMUX: '/tmp/x,1,0', TMUX_PANE: '%3; kill-server' })).toBeNull()
  })

  test("control mode's escapes come back as bytes", () => {
    const enc = new TextEncoder()
    expect(new TextDecoder().decode(unescapeOutput(enc.encode('a\\015\\012b\\134c é')))).toBe('a\r\nb\\c é')
    // A backslash without three octal digits after it is itself.
    expect(new TextDecoder().decode(unescapeOutput(enc.encode('x\\9 \\01')))).toBe('x\\9 \\01')
  })

  test('keys go in byte for byte, a few hundred to a command', () => {
    expect(keysOf('%1', 'é\x1b[A')).toEqual(['send-keys -t %1 -H c3 a9 1b 5b 41'])
    const lines = keysOf('%1', 'x'.repeat(600))
    expect(lines).toHaveLength(3)
    expect(lines.every(l => /^send-keys -t %1 -H( [0-9a-f]{2})+$/.test(l))).toBe(true)
    // xterm's binary input (an old-style mouse report past column 95) stays bytes, not UTF-8.
    expect(keysOf('%1', '\x1b[M \xa0!', true)).toEqual(['send-keys -t %1 -H 1b 5b 4d 20 a0 21'])
  })

  test('the screen carries the modes and the cursor', () => {
    const info = { pane_id: '%1', pane_width: '80', pane_height: '3', window_width: '80', window_height: '3', cursor_x: '4', cursor_y: '1', cursor_flag: '0', alternate_on: '1', keypad_cursor_flag: '1', keypad_flag: '0', mouse_standard_flag: '0', mouse_button_flag: '0', mouse_any_flag: '0', mouse_sgr_flag: '1', scroll_region_upper: '0', scroll_region_lower: '2', origin_flag: '0' }
    // A blank last row is a row.
    const s = screenOf(info, 'one\ntwo\n')
    expect(s).toMatchObject({ cols: 80, rows: 3 })
    expect(s.d).toBe('\x1b[?1049hone\r\ntwo\r\n\x1b[0m\x1b[?1h\x1b[?1006h\x1b[2;5H\x1b[?25l')
    // A scroll region short of the screen, and origin mode in it.
    const vim = screenOf({ ...info, scroll_region_upper: '0', scroll_region_lower: '1', origin_flag: '0' }, 'a\nb\nstatus')
    expect(vim.d).toContain('\x1b[1;2r\x1b[2;5H')
    const origin = screenOf({ ...info, scroll_region_upper: '1', scroll_region_lower: '2', origin_flag: '1', cursor_y: '2' }, 'a\nb\nc')
    expect(origin.d).toContain('\x1b[2;3r\x1b[?6h\x1b[2;5H')
    // Origin mode over the whole screen: kept too, with no region to set.
    const whole = screenOf({ ...info, origin_flag: '1' }, 'a\nb\nc')
    expect(whole.d).toContain('\x1b[?6h\x1b[2;5H')
    expect(whole.d).not.toMatch(/\x1b\[\d+;\d+r/)
  })
})

describe.skipIf(!haveTmux)(`against tmux (${tmuxVersion.stdout?.toString().trim() || 'none'})`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sphere-term-'))
  const socket = join(dir, 'tmux.sock')
  const typed = join(dir, 'typed')
  const tmux = (...args: string[]) => {
    const r = Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket, ...args], { stderr: 'pipe' })
    if (!r.success) throw new Error(`tmux ${args.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  let pane = ''
  let other = ''

  beforeAll(() => {
    // The pane under test runs a shell; a second window, current, shows the pane's window isn't switched to.
    tmux('new-session', '-d', '-s', 'agent', '-x', '80', '-y', '24', 'env -i PS1="$ " TERM=xterm-256color bash --noprofile --norc')
    pane = tmux('display-message', '-p', '-t', 'agent', '#{pane_id}')
    tmux('new-window', '-t', 'agent', `stty raw -echo; cat > ${typed}`)
    other = tmux('display-message', '-p', '-t', 'agent', '#{window_id}')
  })
  afterAll(() => {
    try {
      tmux('kill-server')
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  })

  const relay = (target = { socket, pane }) => {
    const got: TermFromBridge[] = []
    let backlog = 0
    const t = new TmuxPane(target, { send: m => void got.push(m), buffered: () => backlog })
    return { t, got, setBacklog: (n: number) => void (backlog = n), text: () => got.map(m => (m.op === 'closed' ? '' : m.d)).join('') }
  }
  const until = async (check: () => boolean, what: string, ms = 4000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await Bun.sleep(20)
    }
  }
  const clients = () => tmux('list-clients', '-F', '#{client_control_mode}').split('\n').filter(Boolean).length

  test("sends the pane's screen, then its output; the owner's keys reach it", async () => {
    const { t, got, text } = relay()
    await t.start()
    const state = got.find(m => m.op === 'state')
    expect(state).toMatchObject({ op: 'state', cols: 80, rows: 24 })
    // Attached without switching the owner's window, or resizing it.
    expect(tmux('display-message', '-p', '-t', 'agent', '#{window_id} #{window_width}x#{window_height}')).toBe(`${other} 80x24`)

    t.input('echo "hi $((6*7)) é"\r')
    await until(() => text().includes('hi 42 é'), 'the output')
    expect(got.filter(m => m.op === 'out').length).toBeGreaterThan(0)

    // The screen again: what was printed is in it.
    got.length = 0
    await t.snapshot()
    expect(got[0]).toMatchObject({ op: 'state', cols: 80, rows: 24 })
    expect((got[0] as { d: string }).d).toContain('hi 42 é')
    t.close()
    await until(() => clients() === 0, 'the client to detach')
  })

  test('keys arrive byte for byte', async () => {
    const target = { socket, pane: tmux('display-message', '-p', '-t', other, '#{pane_id}') }
    const { t } = relay(target)
    await t.start()
    t.input('aé\x1b[A\x03')
    const bytes = () => [...readFileSync(typed)].map(b => b.toString(16).padStart(2, '0'))
    await until(() => bytes().length >= 7, 'the bytes')
    expect(bytes()).toEqual(['61', 'c3', 'a9', '1b', '5b', '41', '03'])
    t.close()
  })

  test("fitting resizes the pane's window, and the new screen follows", async () => {
    const { t, got } = relay()
    await t.start()
    got.length = 0
    t.fit(100, 30)
    await until(() => got.some(m => m.op === 'state' && m.cols === 100), 'the new size')
    expect(got.find(m => m.op === 'state' && m.cols === 100)).toMatchObject({ rows: 30 })
    expect(tmux('display-message', '-p', '-t', pane, '#{pane_width}x#{pane_height}')).toBe('100x30')
    t.close()
  })

  test('a backed-up connection drops output, then gets the whole screen', async () => {
    const { t, got, setBacklog } = relay()
    await t.start()
    got.length = 0
    setBacklog(10 * 1024 * 1024)
    t.input('echo dropped-$((1+1))\r')
    await Bun.sleep(400)
    expect(got.filter(m => m.op === 'out')).toHaveLength(0)
    setBacklog(0)
    await until(() => got.some(m => m.op === 'state' && m.d.includes('dropped-2')), 'the screen')
    t.close()
  })

  test('detached in the middle of a screen and attached again, it carries on', async () => {
    const { t, got, text } = relay()
    await t.start()
    // A screen asked for and the client gone before its answer is read.
    void t.snapshot()
    t.close()
    got.length = 0
    await t.start()
    expect(got[0]).toMatchObject({ op: 'state', cols: expect.any(Number) })
    t.input('echo again-$((3*3))\r')
    await until(() => text().includes('again-9'), 'the output after reattaching')
    await t.snapshot()
    expect(got.at(-1)).toMatchObject({ op: 'state' })
    t.close()
  })

  test('a paste goes in as a paste: with the markers when the program asked for them', async () => {
    const pasted = join(dir, 'pasted')
    const plain = join(dir, 'plain')
    tmux('new-window', '-t', 'agent', `printf '\\033[?2004h'; stty raw -echo; cat > ${pasted}`)
    const asked = tmux('display-message', '-p', '-t', 'agent', '#{pane_id}')
    tmux('new-window', '-t', 'agent', `stty raw -echo; cat > ${plain}`)
    const notAsked = tmux('display-message', '-p', '-t', 'agent', '#{pane_id}')
    await Bun.sleep(200)
    for (const [pane, file] of [[asked, pasted], [notAsked, plain]] as const) {
      const { t } = relay({ socket, pane })
      await t.start()
      t.input('one\rtwo', { paste: true })
      await until(() => readFileSync(file, 'utf8').includes('two'), `the paste in ${pane}`)
      t.close()
    }
    expect(readFileSync(pasted, 'utf8')).toBe('\x1b[200~one\rtwo\x1b[201~')
    expect(readFileSync(plain, 'utf8')).toBe('one\rtwo')
  })

  test('a pane that goes away is reported', async () => {
    tmux('split-window', '-t', pane, 'sleep 30')
    const doomed = tmux('display-message', '-p', '-t', 'agent', '#{pane_id}')
    const { t, got } = relay({ socket, pane: doomed })
    await t.start()
    expect(got[0]).toMatchObject({ op: 'state' })
    tmux('kill-pane', '-t', doomed)
    await until(() => got.some(m => m.op === 'closed'), 'closed')
    const gone = relay({ socket, pane: doomed })
    await gone.t.start()
    expect(gone.got).toEqual([{ op: 'closed', reason: "The session's tmux pane is gone." }])
  })
})
