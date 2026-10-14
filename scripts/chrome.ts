// A Chrome of the demo's (or a test's) own, for browser cards: Playwright's Chromium, headless,
// with remote debugging on a port it picks and a profile in a scratch folder, which is what
// sphere-server is given as SPHERE_BROWSER_PROFILE. Never anyone else's browser. Plus a small page
// to open in it, with a button, a text field and a clock that repaints, so a screencast has frames.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Playwright's Chromium, if it's installed (`bunx playwright install chromium`). */
export async function chromiumPath(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright')
    const path = chromium.executablePath()
    return (await Bun.file(path).exists()) ? path : null
  } catch {
    return null
  }
}

export async function startChrome(): Promise<{ profile: string; stop(): Promise<void> } | null> {
  const exe = await chromiumPath()
  if (!exe) return null
  const profile = mkdtempSync(join(tmpdir(), 'sphere-chrome-'))
  const proc = Bun.spawn(
    // As Playwright starts it: without Chrome's sandbox, which this machine may not allow (this one
    // runs for the demo and the checks, never as the team's browser).
    [exe, '--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=2', 'about:blank'],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  /** Stops Chrome, then removes its profile once it has let go of it. */
  const stop = async () => {
    proc.kill()
    await Promise.race([proc.exited, Bun.sleep(3000)])
    rmSync(profile, { recursive: true, force: true })
  }
  for (let i = 0; i < 100; i++) {
    if (await Bun.file(join(profile, 'DevToolsActivePort')).exists()) return { profile, stop }
    await Bun.sleep(100)
  }
  // It never said where it listens: no browser, rather than one nobody can reach.
  console.error("Chromium didn't start, so there are no browser cards.")
  await stop()
  return null
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sample tab</title>
<style>
body { font: 16px/1.4 system-ui, sans-serif; margin: 24px; color: #1f2328; background: #fff; }
.bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
button { font-size: 18px; padding: 10px 18px; } input { font-size: 18px; padding: 8px; width: 320px; }
#clock { font-variant-numeric: tabular-nums; color: #57606a; } li { padding: 6px 0; border-bottom: 1px solid #eee; }
</style></head><body>
<h1>A tab of the server's browser</h1>
<div class="bar"><button id="btn">Clicked 0 times</button><input id="q" placeholder="Type here" autocomplete="off"><span id="clock"></span></div>
<ol id="list"></ol>
<script>
let n = 0
btn.onclick = () => ((btn.textContent = 'Clicked ' + ++n + ' times'), (location.hash = 'clicked-' + n))
q.oninput = () => (location.hash = 'typed-' + encodeURIComponent(q.value))
// Where a click landed, in the page's CSS pixels, and how wide the page is laid out: the checks map clicks with them.
document.addEventListener('click', e => { if (e.detail > 0) location.hash = 'at-' + e.clientX + '-' + e.clientY + '-w' + innerWidth + '-r' + devicePixelRatio })
for (let i = 1; i <= 100; i++) list.insertAdjacentHTML('beforeend', '<li>Row ' + i + '</li>')
setInterval(() => (clock.textContent = new Date().toISOString().slice(11, 22)), 100)
</script></body></html>`

/** The sample page, on a port of its own on loopback. */
export function samplePage(): { url: string; stop(): void } {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}
