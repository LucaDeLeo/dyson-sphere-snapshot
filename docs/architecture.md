# Dyson Sphere: architecture

Status: canvas, steering, moves within a machine, server setup, estra labels and structured
transcript rows built. Moved into 80k-coding-tools on 2026-10-09. Updated 2026-10-10.

A shared, live view of every Claude Code session across the team, on an infinite
canvas in the browser. Anyone on the team logs in,
sees everyone's cursor on a shared canvas, watches any agent's live
transcript, and steers agents. External agents take part through a CLI built for
agents. Sessions run on devs' laptops or on a shared bare-metal server. Moving a session
between checkouts on one machine works; moving it between laptop and server is planned.

## Decisions

| Topic | Decision |
|---|---|
| Agents supported | Claude Code through the mod; Codex through its hooks (see "Codex sessions"), which can't reach an idle session, its prompt box or an interrupt |
| Pipeline | estra. Dyson Sphere doesn't take tickets to pull requests; it shows and steers the sessions estra (or anyone) starts |
| Team | Up to 5 devs. Three main devs (two in Boston, one in London) on M5 Max laptops with 128 GB |
| Where agents run | Laptops for interactive work. A shared server for agents that keep running after the lid closes, long autonomous jobs, and handed-off work. Sessions can move both ways. |
| Sessions covered | Interactive `claude` started by devs, plus sessions launched on the server |
| Backend | Our own server on the bare-metal box. No Convex, no Vercel. |
| Interface | A 2D infinite canvas (Figma-style), clean look, with event-driven motion. Not 3D. No built-in voice; an external service covers calls |
| Visibility | Public to the whole team by default |
| Steering | Owner steers their own sessions directly. Anyone else (human or external agent) suggests; the owner sends as-is, edits, or rejects. An owner can mark specific agents as trusted, which skips approval. |
| Prompt injection | Not a design concern for now |

## Architecture

```
 laptop (macOS)                          server (EPYC 9555, Linux, on Tailscale)
┌───────────────────────────────┐       ┌─────────────────────────────────────────────┐
│ claude + mod                  │       │ per-dev containers (Incus)                  │
│   └─ sphere bridge ───────────┼─WS────┼─▶  claude + mod                             │
│        (local outbox)         │ over  │      └─ sphere bridge ──┐                   │
└───────────────────────────────┘ Tail- │                         ▼                   │
                                  scale │ server container: sphere-server (Bun)       │
 browser (canvas) ────────────────WS────┼─▶   world state in memory                   │
 sphere CLI (humans, ext. agents) ─WS───┼─▶   Postgres (event log, bodies)            │
                                        └──────────────┬──────────────────────────────┘
                                                       └─ backups ─▶ object storage (off-box)
 estra sidecar ──pipeline state──▶ sphere-server
```

External services: Tailscale and an off-box backup bucket. Everything else runs on
the server.

### 1. Server

Hardware: 1 × AMD EPYC 9555 (64 Zen 5 cores, 4.4 GHz boost), 2 × 3.84 TB NVMe in
RAID 1. 256 GB RAM is enough to start: about 2–4 GB per worktree running its dev
stack, times ~25 worktrees, plus 10–15 GB for `claude` processes.

Per thread the server is slower than an M5 Max, so interactive work stays on
laptops. The server's job is throughput and staying on.

Layout:
- **Host:** Linux, provisioned from config kept in git (Ansible or NixOS, to be
  decided), so the box can be rebuilt from scratch. Tailscale on the host. No public
  ports.
- **Server container:** `sphere-server` and Postgres. Reserved CPU and memory
  through cgroup limits, so agent builds can't stall the world.
- **One Incus system container per dev:** root inside, Docker allowed (nesting), the
  dev's own credentials and their own Claude login. Worktrees live at the same
  absolute paths as on their laptop (`/Users/luca/dev/...`) so sessions can move
  between machines (see "Moving sessions").
- **Backups:** Postgres WAL archiving and base backups (pgBackRest or wal-g) to object
  storage outside the box. Recovery means rebuilding the host from config and
  restoring the database.

### 2. `sphere-server`

One Bun/TypeScript process.

- **Event log:** every change is an event appended to Postgres with a global sequence
  number: transcript rows, session lifecycle, suggestions, approvals, board posts,
  session moves.
- **Bodies:** large tool output is stored once, keyed by content hash, and loaded on
  demand. Transcript rows carry a one-line summary and a `bodyId`.
- **World state:** kept in memory and built from the event log, with periodic
  snapshots for fast restarts. It holds sessions and their status, what needs
  attention, saved layout and notes, and who is online.
- **Protocol:** one WebSocket protocol for the browser, the CLI, and bridges.
  - `subscribe(topic, sinceSeq)` with topics such as `world`, `session:<id>`,
    `board:<id>`, `presence`. The server replays from `sinceSeq` and then streams.
    This handles reconnects, sleeping laptops, and `sphere watch`/`wait`.
  - Commands are request/response with an idempotency key and, where state is
    checked, an expected revision.
  - Cursors, viewports and per-row activity go over the same socket as short-lived
    messages that are not written to the log.
- **Auth:**
  - Humans: `tailscale serve` passes the Tailscale identity in request headers. The
    server trusts that header only on a Unix socket that `tailscale serve` forwards to
    and that only the server's user and root can open. People with accounts on the
    server can reach its TCP port, so that port needs a token.
  - Bridges and external agents: per-identity tokens (`SPHERE_TOKEN`), issued by a
    human and attributed to them ("ops-bot (for luca)").
- **Schema and migrations:** Drizzle.

### 4. The mod (Claude Code plugin)

Installed once per machine (laptop or dev container) from a private GitHub plugin
marketplace. It stays thin: all networking and durability live in the bridge.

- `session.start`: spawns the bridge with `$.process.spawn` (types L3291-3328; the
  session-lifetime child is the documented example). Not awaited, so the first
  prompt isn't delayed.
- `session.append`: calls `next(e)` first, then forwards a redacted copy of the row (with tool
  inputs and results as objects, and thinking as its own row: see "Transcript rows")
  to the bridge over its Unix socket (`$.http.fetch` with `socketPath`) without
  awaiting. Never rewrite the stored row: that would hide the agent's own tool
  output from it.
- `turn.start`: records `turnId` for `$.turn.abort`.
- `turn.step`: a reply as it streams, the main agent's or a subagent's, passed on a paragraph at a time (see
  "Replies in progress"). Every chunk passes through untouched.
- `$.tool.register`: board tools (`board_read`, `board_post`, …) shown to the model as
  `mcp__<plugin>__<name>`.
- One loop reads bridge stdout (JSON lines) and dispatches:
  - owner message → `$.prompt.submit({ text, asUser: true })` when idle, or a
    `$.session.append` user note mid-turn
  - approved suggestion → the same calls, with attribution in the text
    ("jp suggested, luca approved: …")
  - interrupt → `$.turn.abort({ turnId })`
  - "edit in my terminal" → `$.prompt.fill({ mode: 'append' })` (interactive sessions only)
  - move → see "Moving sessions"
- A pane or band lists pending suggestions in the owner's terminal.
- `/sphere move`, `/sphere status` slash commands.

The bridge carries ingest as well as commands because `$.http.fetch` has no
WebSocket, no timeout, and is refused under
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Child processes are not affected by
that setting.

### 5. `sphere`: bridge and CLI (one binary)

TypeScript on Bun, compiled with `bun build --compile` so the plugin is the only
host dependency.

- `sphere reap`: started by the bridge, double-forked so it survives Claude Code killing
  its process tree. It waits for the Claude Code process to exit, then records
  `session.ended`. Without it, sessions closed with `/exit` stayed "offline" forever:
  neither the mod's `session.end` hook nor the bridge's signal handler gets to run.
- `sphere bridge --session <id>`: holds the WebSocket to `sphere-server`. Buffers rows
  in a local outbox, sends them in batches, and drops entries only after the server
  acknowledges them (Paperclip's PRP outbox pattern). Emits commands as JSON lines on
  stdout.
- **Events Postgres refuses** (CS-2573): a NUL in a tool's output once held up a session's
  outbox for hours, because the bridge resent the event Postgres refused ahead of all the
  others. The server now removes NULs, and replaces lone surrogates with U+FFFD, in every
  string before storing it. An event Postgres still refuses (SQLSTATE class 22, a data
  exception) is acknowledged and listed in the answer's `rejected`; the bridge writes it to
  `dead-letter.jsonl` beside its outbox, logs it once and sends the rest. Any other failure,
  such as the database being down, fails the whole batch, and the bridge sends it again.
  Bridges from before `rejected` drop such an event, as they drop malformed ones.
- Commands for humans and external agents:

```
sphere status                          # every live session: owner, machine, repo, state, last action
sphere sessions [--ticket CS-123] [--repo x]   # the same, filtered; JSON carries each ticket's title and status
sphere show s_7fk2 [--tail 50] [--full]
sphere watch [s_7fk2|--all] [--events tool,turn,board]   # NDJSON stream
sphere wait s_7fk2 --until idle|turn-end|needs-input [--timeout 30m]
sphere suggest s_7fk2 "..."            # goes to owner for approval
sphere send s_7fk2 "..."               # owner or trusted agent only
sphere interrupt s_7fk2
sphere move s_7fk2 --to server|laptop
sphere board read <board> --since 1h | sphere board post <board> "..."
sphere approvals | approve a_31 [--edit "..."] | reject a_31
sphere spawn --repo api "..."          # new session in the caller's server container
sphere guide                           # usage guide for agents, one read
```

CLI conventions:
- JSON on stdout when piped or with `--json`; tables on a TTY. JSON errors on stderr.
- Typed exit codes: 0 ok, 1 user error, 2 network, 3 auth, 4 other, 5 conflict
  (re-read before retrying).
- No interactive prompts. Auth from `SPHERE_TOKEN`.
- Short stable IDs. Small output by default; `--full` to see everything.
- `--help` prints the full command tree in one call. Bodies can come from stdin (`-`).
- Mutations take a revision and are idempotent.
- `wait` and `watch` block on subscriptions. Agents never poll.

### 6. Browser client: the canvas

A shared infinite canvas in the style of Figma, with live cursors. It replaced the
3D solar system: almost everything people read here is text, and a 2D canvas keeps it
sharp at every zoom. Design brief and principles: `PRODUCT.md`.

Stack: React 19 and tldraw 5 (pinned; a licence key in production, `SPHERE_TLDRAW_LICENSE_KEY`),
bundled by `sphere-server` itself
when it starts (`Bun.build` with code splitting; no separate build step), so the transcript
and the diff and highlighting code load only when first needed. `SPHERE_DEV=1` serves Bun's
HTML imports instead, with hot reloading and without splitting. Code: `web/src/`. The old
debug page is at `/debug`.

**On tldraw 5 (CS-2554).** The canvas moved to tldraw in steps, with the React Flow canvas
(`@xyflow/react`) working throughout; once tldraw was the default, the React Flow canvas was
removed (see "Removing the React Flow canvas" below). Plan and evidence: the spike reports on branches
`lucadeleo/canvas-tldraw-spike` and `lucadeleo/canvas-gpu-layer-spike`. The pieces:

- **The canvas document** is one tldraw sync room (`TLSocketRoom`) inside sphere-server
  (`server/src/canvas.ts`), on the `/canvas` socket. It holds only the arrangement: sections,
  session cards' places, notes and drawings. What sessions do stays in the event log and the
  world; a session shape names its session and nothing else.
- **Schema** (`shared/canvas.ts`, loaded by the server and the page): tldraw's own shapes, a
  `session` shape `{ w, h, sessionId }` and a `section` shape `{ w, h, title }`, each with a
  migration sequence. A session's shape is `shape:session:<id>`; a repo's or ticket's section is
  `shape:<region id>` (`regionFor`). tldraw is pinned to one exact version in every
  `package.json`: its client and server must match, and the page is served by the server, so a
  deploy changes both.
- **Saved** to Postgres (`canvas_rooms`, one row per room) about a second after a change, and on
  shutdown (SIGTERM, SIGINT): pages are disconnected first, so nothing changes after the last
  save, and a failed save is tried again for 3 seconds. Pages reconnect to the next server. A
  crash loses at most that second of canvas edits while saves succeed; while Postgres refuses
  them, it loses everything since the last save that did (each failure is logged). The event
  log has no such window. Strings are made storable first, as in the log.
- **Server writes** (`Canvas.write`) check every record against the schema and every shape's
  parent, all or nothing: the room's storage would take an invalid record and pass it to pages.
  The server keeps its own rules too: it never removes a session card, and a card is always in
  its session's section (`regionFor`), under the session's own shape id.
- **Who may do what.** The socket takes the same Origin check as `/ws`, and its identity comes
  before the upgrade, since tldraw's protocol has no hello: the Tailscale login, or a token in
  the URL. The room's session id is the server's, not the page's. Pages may move session cards
  and the repo and ticket sections, but not create, delete or reparent them, nor rename a
  repo's or ticket's section; the server owns those. A shape a page creates is stamped with its
  author (`meta.author`), which nobody can change. Ids of the form `shape:session:<id>` are kept
  for session cards, and a note holds at most 4,000 characters, as the log does. tldraw checks
  each record a page writes, not the document, so after each page commit any shape left without
  its parent is put on the page. Presence (cursors, names) isn't checked: tldraw doesn't pass it
  to the room's checks.
- **Licence key:** `SPHERE_TLDRAW_LICENSE_KEY`, put in the served page as
  `<meta name="tldraw-license-key">` (README, "Server settings").

- **The room and the log in step** (`server/src/arrangement.ts`). The log's `layout.set` and
  `note.*` events stay the arrangement's record for everything that isn't the room: the
  `canvas` command, a server rolled back to before the room, and React Flow tabs opened before
  that canvas was removed (they keep running until they reload). Each side sees the other's changes:
  - From the log to the room: a session's card goes in its region's section, at the slot the
    world gave it. A section is made, and placed in the first free spot in rows 2,400 wide, the
    first time its region has a card. That place is recorded as a `layout.set`, so readers of the
    log have the frame there too. `layout.set` and `note.*` commands from any `/ws` client move
    and change the room's shapes. Notes become tldraw notes with the same id after `shape:`; their
    text becomes rich text, and their five colours map to tldraw's.
  - From the room to the log: what pages change is recorded as the same events, about
    300 ms later (one per drag, not one per frame), with `source: 'canvas'` so they aren't
    applied to the room again. Old React Flow tabs, the `canvas` command and a server rolled back
    to before the room all see it.
  - Each direction changes only what its change concerns, so a drag in progress isn't undone by
    an unrelated event. A section's size follows its cards and notes; one that grows into others
    pushes them right, as the React Flow canvas laid unsaved frames out again, and those moves are
    recorded too.
  - **Notes:** the log places notes on the page; a note inside a section is placed by the
    section's corner, so positions are converted both ways, and a section's move records its
    notes' new places. A note's width in the log (the React Flow canvas's notes were any size) is a
    tldraw note's scale (they're 200 wide and square), and the log keeps its exact size: the room
    records a note's size only when it changes on the canvas (resized, or grown or shrunk with its
    text), against the size it last agreed with the log (`meta.sizeSeen`). A colour change from a
    `note.update` keeps the note's formatting.
  - **Startup:** the snapshot records the last event the room had followed (`log_seq`, saved
    within a minute of any event, and within a second of a change to the room). After a crash
    the two can disagree, so startup brings them back in step: the arrangement events logged
    after the snapshot are applied again; every session that still shows, and every note, gets
    its shape if it has none (the first start after this deploy builds the whole room from the
    log's layout and notes); then what the room has and the log doesn't, such as a page's change
    whose event was lost, is recorded. A note the room remembers removing (tldraw's tombstones)
    is recorded as deleted rather than made again. Each step logs what fails and goes on, so a
    bad shape can't keep the server from starting. An event the room fails to follow stops
    `log_seq` there, so the next start replays it. On shutdown, pages' last changes are recorded
    before the last save.
  - **Retiring:** every hour, the cards of sessions ended or unseen for a week leave the room,
    and so do the server's sections left empty, so the page doesn't grow with every session
    there ever was (tldraw's default limit is 4,000 shapes a page). This is the one way a
    session card leaves; nobody can delete one, and a session heard from again (its bridge
    attaches, or it reports anything) gets its card back. "Show inactive" will therefore reach
    back a week. The log keeps everything.

- **The canvas on tldraw** (`web/src/tldraw/`), loaded after the page's first script (tldraw is
  most of the bundle).
  - **Shapes:** a session's card and a section are thin tldraw shapes (`shapes.tsx`) around
    a card and label that know nothing of the canvas (`web/src/cards/`). A card can't be
    resized, edited or dragged out of its section. A section is frame-like: it clips its cards,
    carries them when it moves, and takes notes dropped into it. Its heading grows as the camera
    zooms out, up to 8×, so it stays readable, and Tidy packs its cards. Notes are tldraw's own.
  - **Visibility:** cards of sessions that ended over 15 minutes ago or went offline hours
    ago, and sections with no card showing, are hidden per viewer (`getShapeVisibility`);
    "Show inactive" shows them.
  - **Presence:** tldraw's cursors and names, from the room, named after the server's
    identity for the page. Follow is tldraw's (F, or a person's avatar). The page also sends
    its cursor, view and selection on `/ws` (selection gives cards their viewers), in the React
    Flow canvas's coordinates, and its `/ws` presence says `canvas: 'tldraw'`. Pages draw `/ws`
    cursors without that field beside the room's own: they come from React Flow tabs opened
    before that canvas was removed (see "Removing the React Flow canvas").
  - **Keys:** tldraw's UI is hidden; ⌘K and / find, N makes a note, F follows, `.` goes to the
    next thing that needs you, `?` lists them, captured before tldraw's handlers and never while
    a shape is being edited or a text field has focus. tldraw's drawing-tool and cursor-chat
    shortcuts are removed, since there's no toolbar for them yet. Undo and redo are tldraw's,
    per person.
  - **Assets:** fonts, icons and translations come from sphere-server
    (`/tldraw-assets/<folder>/<file>`, from `@tldraw/assets`), not tldraw's CDN. The bundle sets
    `NODE_ENV` as the server runs, which React and tldraw's licence check read.
  - **Room for a GPU layer** (the GPU-layer spike's report): card contents are plain React that
    imports neither canvas library (`web/src/cards/`); a live card's frames will go through one
    hub per card (`cards/frames.ts`), so an `<img>` and a layer can both draw them; and each card
    shape renders HTML or nothing by a per-card presentation value (`setPresentation`), so a
    layer can take a card over while tldraw still selects and moves it. The fourth, a frame size
    per viewer for the stream server, came with browser cards: each card sends its width on screen.
  - **Motion and minimap:** a card someone else moved glides there (changes from the room only;
    none with reduced motion), a message or suggestion flies from its sender to its card, and
    the minimap colours cards by state: red for what waits on the viewer,
    the accent for working sessions.
  - **Many cards** (`scripts/bench-canvas.ts`): a card re-renders only on what it shows. Its
    viewers come from `viewers:<session>`, not every presence message; far out it skips what a
    tile doesn't draw and ticks on a 30 s clock; off screen (culled) it hears nothing until it's
    back. 2,000 cards on this Linux server (EPYC 9555, headless Chromium with software rendering,
    production bundle): pan and zoom at p95 16.8 ms, 1-3% of frames dropped, at the 60 Hz that
    headless Chromium paces to. The React Flow canvas took 118 s to mount the same cards, then
    ran at p50 50 ms panning and 233 ms zooming. The 120 Hz figure needs a headed run on a
    120 Hz display.
  - **Checks:** `bun run check:canvas` drives two people in Chromium against a demo (README,
    "Develop"), with a `/ws` client standing in for an old React Flow tab (its cursor, its
    `layout.set`, and the `canvas` command), and checks that `?canvas=classic` opens the canvas.
    CI has no browser, so they're run by hand.

Mixed versions: the room only adds to what the log records. A server rolled back to before the
room finds the arrangement in the log; it loses only what the log can't express: drawings and
other tldraw shapes, and notes' formatting.

### Terminal cards

A session's terminal on the canvas: the tmux pane it runs in, live (`shared/terminal.ts`).

```
page's card ──/term──▶ sphere-server ──bridge's /ws──▶ sphere bridge ──tmux -C──▶ the session's pane
 (xterm.js)            (who may do what)               (the owner, on the session's machine)
```

- **Where the terminal comes from.** The session's own bridge, which runs as the session's owner
  on its machine, so it reaches the owner's tmux and nothing else. A bridge started in tmux (from
  `TMUX`, `TMUX_PANE`) says so in `session.started` (`terminal: 'tmux'`). While anyone watches, it
  attaches with tmux's control mode (`sphere/src/terminal.ts`): to the pane's tmux session by id,
  with `ignore-size`, so the owner's windows keep their size and the window they show. It sends
  the pane's screen (`capture-pane` with its history, the cursor, and the keyboard and mouse modes
  the program asked for), then its output as tmux reports it, in order with command answers, so a
  screen and the output after it never overlap. Only the pane, not the window around it.
- **Who may do what** (`server/src/terminals.ts`), checked on the server for every message: anyone
  signed in may watch, as anyone can read a transcript; only the session's owner types or resizes.
  Trusted agents send messages, not keys. Keys go to the pane byte for byte (`send-keys -H`) and
  nowhere else: nobody gets a shell, the owner included; the card is the session's pane. A bridge's
  terminal messages count only from the session's current process, signed in as its owner. The
  `/term` socket takes the same Origin check and sign-in as `/canvas` (the Tailscale login, or a
  token), and a person has at most 24 open.
- **Which sessions.** Those on `SPHERE_TERMINAL_MACHINES` (this server, by default) that run in tmux
  under a bridge of protocol 5 or later. For any other session the card says why: a laptop's
  terminal isn't offered yet (it would expose a laptop's tmux to the tailnet, a decision of its
  own), a session outside tmux has no pane to show, an older bridge gets one once updated. One
  stream per session, however many cards and pages show it.
- **Backpressure.** Output is never queued without bound. The bridge batches it (about 60 a
  second); while its socket to the server is backed up (1 MB) it drops output and sends the whole
  screen once it drains. The server does the same per page: a page whose socket is behind misses
  output and gets the screen once it catches up. A card off screen, or too small to read, asks the
  server to hold its output back (`pause`) and gets the screen when it's back.
- **Lifetime.** The bridge attaches when the first viewer arrives and detaches 15 seconds after
  the last leaves (a card removed, a page closed; a reload within that keeps it), when its
  connection drops, and when the session ends. The tmux client is the only process it starts.
- **On the canvas** (`web/src/tldraw/live.tsx`, content in `web/src/cards/terminal.ts`): a
  `terminal` shape `{ w, h, sessionId }`, under the id `shape:terminal:<uuid>`. Its xterm.js
  terminal is an app-owned element (`getAppOwnedElement`): tldraw never remounts it, culling only
  hides it, and while the shape is unmounted (a page change) it waits in a parking lot, still
  connected (`moveElementInto`, `Node.moveBefore`), so it never reconnects or redraws. The terminal
  is the pane's size, scaled to fit the card. In edit mode every key, the wheel, pointer and
  clipboard events stay in the card, and the exit chord (⌘Esc, Ctrl+Esc) is caught before xterm
  sees it; the canvas's own shortcuts ignore a live card being edited. Mouse events are sent
  again with coordinates corrected for the camera's and the card's scale (the spike's fix), so a
  click lands on its cell at any zoom. The terminal stays dark in both color schemes; its chrome
  follows the page's.
- **Live cards in the room.** A live card's id names its type (`shape:terminal:…`; nothing else may
  use that prefix), and a page may add, move, resize and remove one but not change the session it
  shows; no arrow binds to one. Pages from before a live card type can't read its shapes (their
  store refuses a shape type it doesn't know, and their sync client starts over and over), so the
  room leaves the type's records out of everything it sends a page whose schema doesn't name it
  (`withoutLive`), and saves live cards in a row of their own, `<room>:live`: a server rolled back
  to before them reads only the room's row, never sees one, and its pages keep working. When a
  newer server opens the room again, it puts the live row back (a card whose section went in the
  meantime goes on the page). Each live type has its migration sequence from the start.
- **Mixed versions.** Protocol 5. An older bridge never hears of terminals and its sessions' cards
  say it needs updating; a newer bridge under an older server is never asked. Older CLIs and
  pages are unaffected: `SessionSummary.terminal` is optional, and old pages don't get the shapes.
- **Checks (terminals):** `tests/terminal.test.ts` (the bridge's side against a real tmux), `terminals.test.ts`
  (the relay's rules), `term-socket.test.ts` (`/term` end to end, with a real bridge in tmux),
  `canvas.test.ts` (live cards in the room, and a page from before them); `bun run check:terminal`
  in Chromium against a demo, whose luca and jp sessions run in tmux panes of the simulator's own.

### Browser cards

A tab of the server's own Chrome on the canvas, streamed by screencast (`shared/browser.ts`). No
page ever iframes a site.

```
page's card ──/browser──▶ sphere-server ──CDP (loopback)──▶ the server's Chrome, one tab
 (<img>)                  (who may do what, the screencast)
```

- **Which Chrome.** The one whose `DevToolsActivePort` is in `SPHERE_BROWSER_PROFILE`. Its port is
  used only while the browser there names the same browser target, so another program's debugging
  port is never trusted (the spike met one). Pages never see CDP; the server passes on only the
  inputs listed in `shared/browser.ts`.
- **On the team server** (`deploy/chrome.sh`, run by `provision.sh` and `update.sh`):
  - **Which Chrome:** Google Chrome stable from Google's signed apt repository. Ubuntu's
    `chromium` is a snap.
  - **Which user:** it runs as `sphere-chrome`, a system user with no login. Its profile is in
    `/var/lib/sphere-chrome` (0700), and `/etc/sphere` is inaccessible to it. The server's own
    user, `sphere`, can read every secret there, which a browser that runs other people's pages
    must not.
  - **The `sphere-chrome` service:** headless (`--headless=new`), with the debugging port on
    127.0.0.1:19222. `Restart=always`, and sphere-server starts after it.
  - **Only the server may connect to that port.** CDP has no authentication, and anyone with an
    account on the server can reach loopback; whoever connects drives every tab and can read its
    cookies. Before Chrome starts, `sphere-chrome-firewall` (`deploy/chrome-firewall.sh`, run as
    root) replaces an nftables table, `inet sphere_chrome`. In the output hook, which every
    connection made on the machine passes through, it accepts connections to 127.0.0.1:19222 (or
    ::1) from sockets owned by `sphere`'s or `sphere-chrome`'s uid, and resets the rest. The same
    port on other hosts is untouched. Root can always undo the rule.
  - **How the server finds the port:** once Chrome answers on 19222, `sphere-chrome-port`
    (`deploy/chrome-port.sh`) writes a `DevToolsActivePort` (the port, and the browser target's
    path from `/json/version`) to `/run/sphere-chrome`. Chrome writes that file itself only for a
    port it picks. Before writing, it checks that the listener is this service's own Chrome: `ss`
    names the process behind a socket only to that process's owner. So a user who took 19222 first
    is never trusted as the browser; they only stop Chrome from starting. `/run/sphere-chrome` is
    0750 in the `sphere-chrome` group, and `sphere` is in that group. The server can therefore read
    the port but not the profile, and can write neither. sphere-server's own hardening (`ProtectSystem=strict`,
    `PrivateTmp`) leaves `/run` readable and loopback reachable.
  - **The sandbox stays on.** Chrome sandboxes renderers in user namespaces, which this kernel
    (`apparmor_restrict_unprivileged_userns=1`) allows only to programs AppArmor names. Ubuntu's
    `/etc/apparmor.d/chrome` names `/opt/google/chrome/chrome`; Google's package also installs a
    setuid sandbox helper as a fallback.
  - **The hardening is what doesn't defeat the sandbox:** `ProtectSystem=strict` with only its
    home writable, `ProtectHome`, `PrivateTmp`, `InaccessiblePaths=/etc/sphere`,
    `ProtectControlGroups`, `UMask=0077`, and memory and task limits.
  - **What's left off, and why.** `NoNewPrivileges` would stop the exec from entering the
    AppArmor profile (and the setuid helper from working). So is every option that implies it
    for a service with `User=`: `SystemCallFilter`, `RestrictNamespaces`, `PrivateDevices`,
    `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectClock`,
    `MemoryDenyWriteExecute`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality` and
    `RestrictAddressFamilies`. The capability bounding set is left alone too.
  - **Updates:** the service restarts only when its definition changes, so updates keep tabs open.
    A restart of Chrome (or the server's machine) closes them, and their cards say so.
- **Its debugging port is off limits to tabs.** CDP there has no authentication, so a tab that
  reached it could list and close other tabs. A tab opens blank, the server connects to it and
  fails its requests to that port on any host (CDP `Fetch`), and only then sends it to its
  address; that connection stays while the tab does, watched or not, and is made again after a
  restart. The port is refused as an address too. At most 8 tabs per session, 40 in all.
- **Whose tab.** A browser card belongs to a session: its owner opens it (`browser.open`, a `/ws`
  command), the server opens the tab, records `browser.opened { targetId, sessionId, url }` and
  writes the card into the room itself, through the validated write. Pages can't make a browser
  card, nor point one at another tab; they move, resize and remove them. Removing the last card of
  a tab closes the tab (`browser.closed`). A tab Dyson Sphere didn't open (an agent's) isn't shown.
  Older servers ignore both events.
- **Who may do what**, checked on the server for every message: anyone signed in may watch; only
  the owner of the tab's session clicks, scrolls, types, pastes or navigates, as only the owner
  types into the session's terminal. Navigation takes http and https only: not `file:`, `chrome:`,
  `javascript:` or `data:`.
- **Where a tab can go: anywhere the server can.** That includes the internet, and also the
  server's own loopback (Orca on 6800, estra's dashboard, sphere-server, Postgres) and the tailnet.
  This is Luca's decision (13 October 2026). A guard that kept tabs to the internet (an egress
  proxy that resolves names itself and refuses private addresses) was built and then dropped: only
  people who own sessions can send a tab anywhere, and they, and their agents, can reach those
  services already. Dev servers on the box are one point of the cards. The exception is the
  browser's own debugging port, above.
- **The screencast.** It runs only while some page's card wants frames, at most 30 a second (the
  server acknowledges each frame no sooner than that, and Chrome sends the next only then), and no
  wider than the widest card that wants them, in steps (each restart costs a frame and stops the
  running screencast first: Chrome keeps a running one's size), as JPEG at quality 85. Frames go to
  pages as binary messages; a page whose socket is backed up misses frames, and the next one
  replaces them. Each card keeps its last frame; one that has none asks for a still
  (`Page.captureScreenshot`).
- **Crisp frames.** Each card sends its own size in CSS pixels (the canvas's zoom doesn't change
  it) and its screen's device pixel ratio, and the tab is laid out at that size
  (`Emulation.setDeviceMetricsOverride`, `viewportOf` in `shared/browser.ts`).
  - **Whose card sets the layout:** the owner's live card, since the owner is the one using the
    page. Without one, the biggest live card. Within 320–2560 × 200–1600 CSS pixels.
  - **Ratio:** the page's `devicePixelRatio` is the viewer's, rounded up to a half and at most 2.
  - **Pixels:** an emulated ratio adds no pixels to a screencast, so Chrome runs with
    `--force-device-scale-factor=2` and always draws at twice the page's size. Frames are then
    scaled down to the widest card on screen, up to 3200 pixels.
  - **What changes what:** resizing a card lays the page out again, once its size has held for
    300 ms. Zooming the canvas only changes the frame size. A new CDP connection (after a restart)
    lays the page out again.
  - **Pages from before this** send no size: the tab keeps the layout it has (1280×800 for a new
    tab). Their cards still map clicks right, from each frame's own metadata.
  - **Cost on the demo's sample page** (a clock repainting ten times a second, 1024×688 card):
    before, 34 KB a frame (1280×657 at quality 70, the page squeezed into the card). Now, on a 2×
    screen at zoom 1, 101 KB a frame (2048×1376, the card's own layout). On a 1× screen, or 2× at
    zoom 0.5, 39 KB a frame (1040×699). A still page sends no frames at all.
- **A budget of live cards.** A page streams at most four browser cards: the one being used, then
  selected ones, then the biggest on screen, among those on screen and at least 160 pixels wide.
  The rest show their last frame. A card without frames for a minute closes its socket.
- **On the canvas** (`web/src/tldraw/live.tsx`, content in `web/src/cards/browser.ts`): a `browser`
  shape `{ w, h, sessionId, targetId }`, under `shape:browser:<uuid>`, an app-owned element like a
  terminal's. Frames go through the card's frame hub (`cards/frames.ts`), so a layer behind the
  canvas could draw them too; the card's on-screen width goes to the server as the frame-size hint,
  the GPU-layer spike's fourth hook. Keys go through a transparent textarea, which also takes IME
  composition and paste; a click maps to the tab's page from where it lands in the drawn frame.
- **Mixed versions.** A live card type of its own: pages from before it (the terminal cards' ones
  included) never get browser cards, and they're saved in the live row, so a server from before
  them never loads one.
- **Checks:** `tests/browser.test.ts`, against a stand-in Chrome (`tests/fake-chrome.ts`): who may
  open, watch and drive a tab, what reaches Chrome, the screencast's start, stop, size and rate,
  the cards in the room, and a page from before them. `bun run check:browser` in Chromium against a
  demo, which starts a Chromium of its own (`scripts/chrome.ts`).

**Removing the React Flow canvas.** Once tldraw was the default, the React Flow canvas
(`web/src/App.tsx`, `nodes.tsx`, `@xyflow/react`) was removed. What stays, for clients that
may still be running:

- **Old links and choices:** `?canvas=classic`, and a browser that remembered choosing it
  (`localStorage` `sphere-canvas`), open the tldraw canvas; the page clears the remembered key.
- **Tabs still on React Flow** keep running their old bundle until they reload. The server is
  unchanged for them: `layout.set`, `note.*` and the `canvas` command work as before and reach
  the room, and tldraw pages still draw `/ws` cursors without `canvas: 'tldraw'`. That drawing
  costs nothing when there are none, so it stays rather than make the removal depend on every
  old tab having reloaded. The presence field stays optional, and pages keep sending it, so
  tldraw pages from before the removal don't draw them twice.
- **The log's arrangement** (`layout.set`, `note.*`) is unchanged: the `canvas` command and a
  rolled-back server read it.

- **Layout:** one frame per repo, session cards inside. A new session takes the next
  free slot, so nothing moves on its own. Cards, frames and notes can be dragged;
  positions are saved as `layout.set` events and synced to everyone.
- **Cards** are titled by the session's task (its first prompt). The frame names the repo,
  or the ticket its sessions work on (see "Tickets").
- **Semantic zoom:** far out (< 0.7) a card is a tile with its task and state; normal
  shows state, the latest action, a track of recent tool calls colored by kind, and a
  10-minute activity sparkline; close in (≥ 1.5) shows the latest transcript rows.
- **Inspector:** selecting a card opens a side panel with the live transcript, pending
  permission requests and suggestions, delivery progress and the compose box. It can be
  made wider (remembered per browser).
- **Transcript** (`web/src/transcript/`, CS-2563): a plain React component that takes a
  `TranscriptSource` (a page of rows, new rows as they arrive, bodies, search) and knows
  nothing of the canvas, so it works in the inspector before and after the canvas moves to
  tldraw. It turns rows into one model for Claude Code and Codex (`model.ts`): calls paired
  with their results, runs of three or more calls grouped ("Read 4 files, ran 2 commands"),
  a subagent's rows under the call that started it, permission requests and their answers at
  their calls, turns numbered. Each tool has its renderer (`tools.tsx`): Bash with output and
  exit, Edit, Write and Codex patches as diffs (`@pierre/diffs`, loaded on first use), Read,
  Grep and Glob, web fetches and searches, to-do lists and plans, subagents. Thinking is
  collapsed; replies are GitHub Markdown. The list is virtualised (`@legendapp/list`) and
  loads older rows as the reader scrolls up. Find (⌘F) searches the loaded rows and asks the
  server (`search`) for matches further back; turns can be stepped through or picked from the
  marks down the right edge. Rows from before structured rows are read from their text.
  Code copied or adapted from T3 Code and claude-code-viewer is listed in
  `web/THIRD_PARTY_NOTICES.md`.
- **Multiplayer:** live cursors and viewports (`presence` messages, never stored),
  follow mode, avatars of who is looking at each card, sticky notes.
- **"Needs you":** permission requests and suggestions waiting on you, counted in the
  top bar; `.` flies to the next one.
- **Motion comes from events only** (estra's accuracy contract):

| Event | Visual |
|---|---|
| Transcript row | The ticker slides in; the sparkline's current bar grows |
| Tool call starts / finishes | A tick on the track; a running call fills until its result arrives; errors are outlined |
| Working, active in the last 8 s | A sweep runs along the card border, then stops |
| Message or suggestion sent | A dot flies from the sender's cursor to the card; delivery steps fill in |
| Permission request | Red ring, pulses once on arrival, stays red until decided |
| Session offline / ended | Hatched / desaturated |
| Someone else moves a card | It glides to its new place |

- **Light and dark** follow the system. Reduced motion turns every animation into an
  instant change.
- **Keyboard:** `⌘K` or `/` find a session, `N` new note, `F` follow the next person,
  `.` next thing that needs you, `?` shortcuts, `Esc` close; Tab moves between cards,
  Enter opens one, arrow keys nudge the selected one.
- **Stable layout:** the server gives each session the first free slot in its repo's
  frame when it starts (slots of sessions that ended over 15 minutes ago are reused).
  Every canvas draws the same layout, and cards never shift when another drops out.
  Frames are placed so they never overlap.
- **Ended sessions** disappear after 15 minutes; "Show ended" (remembered per browser)
  brings them back. Sessions offline for a day are hidden.
- **Subagents:** the mod reports each subagent's start (`agent.spawn`) and end (its own
  `turn.complete`, which carries `agentId`; a subagent raises no `turn.start`), and checks
  `$.agent.list()` every 3 seconds to catch teammates and killed agents. A session counts
  as working while any subagent runs, even when its main loop is idle (background agents).
  Cards show a subagent badge and shorter ticks for subagent tool calls; the inspector
  labels subagent rows with their task. Teammates (named agents with agent teams on)
  report status, but their transcript rows don't pass through the session's hooks.
- **Errors** show as toasts; the tab title carries the "Needs you" count; new requests
  are announced to screen readers.

To develop without running Claude Code: `bun scripts/simulate.ts --sessions 18` streams
simulated sessions for three owners, with permission requests, and answers steering and
permission commands like the real mod.

### 7. estra

estra stays the pipeline: Linear intake, plan, code, review, babysit, merge, and the
recovery from the states that go wrong along the way. Dyson Sphere is the shared
dashboard over it and the live connection to each Claude Code session. A session estra
starts loads the mod like any other, so it shows up on the canvas and can be steered.

The integration, in order:

1. **Ticket and stage on each card** (built, CS-2488). Next to `ESTRA_AGENT_CONTEXT`,
   estra sets `ESTRA_STAGE` and `ESTRA_PROVIDER` on every agent it starts, and
   `ESTRA_TICKET` and `ESTRA_TASK_ID` on the ones a workflow run starts for a task: in a
   background process's environment, and in an Orca pane's `env …` prefix or `export`
   line. The bridge inherits the agent's environment and sends them with
   `session.started` as `labels`. The server gives a session with a ticket label a slot in
   its ticket's frame (one without stays in its repo's), and the card is titled by its
   stage. Agents a stage starts itself
   (review seats) inherit the stage's labels. Every side reads them as optional: an older
   estra or bridge gives an unlabelled card, and an older server stores them unread with
   the event, so they appear once it updates.
2. **Codex sessions** through Codex's own hooks (built, CS-2488): see "Codex sessions".
3. **Ready reads Dyson Sphere,** so the macOS app can show what's waiting on JP across
   machines.

estra's commander can use the `sphere` CLI as an external agent. Changes on either side
follow the repository's mixed-version rule (`CLAUDE.md`): old and new versions keep
working together while they both run.

## Transcript rows

Each transcript row is a `session.row` event on `session:<id>`. Its `text` is plain text: a tool
call is `"<Name> <json>"`, cut at 2,000 characters, and text over 4,000 characters is stored as a
body (`bodyId`, `fullLength`). Since protocol 3 (CS-2563, `shared/rows.ts`) rows also carry:

| Field | What it holds |
|---|---|
| `calls` | Each tool call's input as an object: `{ id, name, input }`. |
| `results` | Each finished call: `{ id, isError, output }`. `output` is the tool's structured result: Claude Code's from the mod's `tool.call` hook (Bash `stdout`/`stderr`/`interrupted`, Edit and Write `structuredPatch`, TodoWrite `newTodos`, Read's line numbers, …; the file before an edit and a Read's content are left out), and Codex's `tool_response` when it's an object. |
| `cut` | Fields the source cut before sending (strings over 100,000 characters; a value over 400,000 as JSON is sent as null). The rest was never sent. |
| `capped` | Set by the server only: fields it cut and stored whole as bodies. A string over 8,000 characters keeps its start; a value still over 48,000 as JSON is null, and its body is its JSON. `body` fetches either. |

and a `thinking` kind: Claude Code's thinking blocks, and Codex's reasoning summaries from the
rollout (`item_completed` → `Reasoning`; usually empty, as the reasoning itself is encrypted).

- **Redaction per field.** The mod and bridge redact every string of an input or output
  before cutting it, and redact a credential-like value under a secret-named key
  (`token`, `GITHUB_TOKEN`, `clientSecret`), whose key no longer sits next to it in one string.
  The mod keeps its own copy of these helpers (a mod can't import from outside its folder); a
  test checks the copies match.
- **Mixed versions.** Each hop sends the new fields only to a peer that said it takes them: the
  server names its protocol in `welcome`, and the bridge in its `ready` line to the mod. Toward
  an older bridge or server, rows lose `calls`, `results` and `cut`, and thinking rows are left
  out (counted as sent, so outboxes drain). Rows always keep `text` as before, so older pages and
  CLIs read them unchanged, and a new page draws a row without `calls` from its text. The
  server's floor for bridges stays at protocol 2: protocol 3 adds, it doesn't require.
- **Paging.** `show` returns the last `tail` rows (at most 1,000), or with `before: <seq>` the
  last `tail` rows before that one, and `more` when older rows remain (`sphere show --before`).

### Replies in progress

Since protocol 4 (`PartialReply` in `shared/protocol.ts`), a reply shows a paragraph at a time
while Claude Code writes it, not only once the message is done:

- The mod's `turn.step` hook watches the reply's text as it streams, the main agent's or a
  subagent's (named by `agentId`). Each time a paragraph completes (a blank line outside a code
  fence; a code block counts as one), it posts all the block's completed paragraphs so far,
  redacted, to the bridge's `/partial`. Each carries all of
  them, so one lost or late doesn't garble the text. Past 20,000 characters it stops; the
  finished row follows.
- The bridge passes it straight to the server (`partial`), and the server publishes it on the
  session's topic to whoever has it open. Nothing is stored or replayed: a page that opens
  mid-reply sees the next paragraph.
- One that arrives late is dropped: the server passes on the main agent's only for the current
  turn of a working session, and a subagent's only while that subagent runs (one in the
  background outlives the turn). The page does the same, and ignores any once the reply's row is
  in.
- The transcript draws it last in its agent's rows, under "writing…": the main agent's at the
  end, a subagent's inside its run. It goes when a row of the same agent as recent arrives (the
  finished message), or the session stops working.
- Each hop sends it only to a peer that said it takes it: a bridge's `ready` line and a server's
  `welcome` name protocol 4. Older mods, bridges, servers and pages are unaffected.
- Not covered: thinking, and Codex, whose hooks and rollout see only finished
  items.

## Codex sessions

Codex has no plugin API like the mod's, but it has hooks: commands it runs at points in a
session, in `codex exec` as well as interactively. `install.sh` adds ours to
`~/.codex/hooks.json`. Each runs `sphere codex-hook <Event>`, which hands the event to the
session's bridge over its Unix socket and prints what the bridge answers. Code:
`sphere/src/codex.ts`.

| Hook | What it does |
|---|---|
| SessionStart (async) | Starts the session's bridge, detached so it outlives the hook; a lock in `~/.sphere/run` keeps it to one per session and process. Any later hook that finds no bridge starts one too. |
| PreToolUse, PostToolUse | Report the tool call and its result. Messages sent mid-turn go to the model as `additionalContext`, from the main agent's hooks only, never a subagent's. |
| Stop | A message still waiting as the turn ends goes out as `decision: "block"` with the message as `reason`: Codex carries on with it as if the user had sent it. It blocks only for a new message, so it can't loop. |
| PermissionRequest | Raised in Dyson Sphere and held for an answer, then `allow` or `deny`. While a hook waits, Codex shows no prompt of its own, so the wait is short: `SPHERE_PERMISSION_WAIT_MINUTES` when whoever started the session set it (estra does: 3 s by default), otherwise 10 s. Unanswered, the hook returns no decision and Codex's prompt (or its auto-reviewer) takes over. |
| SubagentStart, SubagentStop (async) | Show Codex subagents like Claude Code's. Their tool calls carry `agent_id`, so their rows are labelled with them. |
| SessionEnd | The session is over, though Codex may run on (`/new` starts another in the same process). |

- **Transcript:** the bridge follows the session's rollout file (`transcript_path`): prompts,
  replies, `task_started` / `task_complete` / `turn_aborted` for working and idle, and the
  messages it delivered (developer context, or a `HookPrompt` item), which mark them as
  observed. Rows are keyed by rollout file and offset, so a restarted bridge doesn't repeat
  them.
- **Which process holds it:** the hook's parent is Codex, so a session is held by
  `<machine>:<codex pid>`, and the same fence applies as for Claude Code (`codex exec resume`
  is a new process).
- **Not possible through hooks:** messaging a Codex session that is idle at its prompt, putting
  text in its prompt box, and interrupting it. The server refuses those for Codex sessions
  with the reason (`CODEX_CANNOT` in `shared/protocol.ts`), and the inspector leaves them out
  and says why. `codex queue --thread <id> --message <text>` can reach an idle session; using
  it is a follow-up.
- **Trust:** Codex runs a hook only once it's trusted, recorded in `config.toml` under
  `hooks.state."<file>:<event>:<group>:<handler>"` as a hash of the hook's definition;
  `codex exec` skips untrusted hooks silently. `sphere codex-install` trusts ours through
  `codex app-server` (`hooks/list`, then `config/batchWrite`), the calls `/hooks` makes.
  Trust is keyed by position, so ours are updated where they stand and new ones go last.
- **Never in the way:** a hook that fails or finds no bridge exits 0 with no output. The
  tool hooks give the bridge 500 ms at most and cost about 16 ms each (median, compiled
  binary). With the `sphere` binary gone, each entry drains its input and exits.

Tested 2026-10-10 with Codex CLI 0.155.1 and 0.162.1: `codex exec` with trusted hooks (no
trust bypass) reported with estra's labels; a mid-turn message reached it at its next tool
call and one sent near the end made it carry on; permission requests were allowed, denied
with a message, and handed to the auto-reviewer when unanswered; the interactive TUI took a
mid-turn message, and `/new` ended the old session. estra's own quiescence proof still
passed in 0.27 s after a `codex exec` with the hooks installed.

## Moving sessions

`sphere move s_7fk2 --to server` (or `/sphere move` inside Claude Code). Claude
Code's built-in teleport only moves between claude.ai cloud and a laptop, so this is
ours.

1. **Quiet point:** the mod waits for the current turn to end, or interrupts it if
   asked.
2. **Code state:** the bridge pushes the branch, with uncommitted changes as a WIP
   commit, to a remote the server container can fetch.
3. **Transcript:** the bridge uploads the session `.jsonl` and subagent transcripts
   (`<sid>/subagents/agent-<id>.jsonl` with `.meta.json`).
4. **Same paths:** the dev's server container has the worktree at the same absolute
   path. Claude Code names the transcript folder after the path (realpath,
   non-alphanumerics → `-`), and earlier tool calls in the transcript reference
   absolute paths, so both stay valid.
5. **Resume:** the server runs `claude --resume <id>` in a tmux pane in the dev's
   container, under their own Claude login. Event: `session.moved`.
6. **Detach:** the laptop session exits. The dev reattaches from the browser terminal
   or SSH, or moves it back the same way.

Before moving, the command lists what won't carry over: background processes the
session started (dev servers, Monitor watches), local-only secrets and MCP servers
missing from the container, and anything that needs macOS.

Built so far: moves between two checkouts on one machine (`sphere move --to <dir>`).
Steps 2 and 3 across machines, through the server, are not built yet.

**Which process holds a session.** After a move the old Claude Code process often keeps
running, and `claude --resume` can open one session in two terminals. A session belongs
to the process that started it last, named `<machine>:<pid>`:

- Every event a bridge sends carries its process. The server drops events from any
  process but the current one, and every command names the process it is for.
- When a new process starts the session, the old process's bridges are told and go
  quiet: the old terminal's status line says where the session runs now, and turns
  typed there aren't reported. Exiting it doesn't end the session.
- A process that has been replaced can't take the session back, even if its mod
  reloads. Another `claude --resume` (a new process) can.
- Each process keeps its own outbox under `~/.sphere/sessions/<session>.<pid>/`.

Tested 2026-10-09 with real sessions: after a move, a message went only to the new
process, the old terminal's turns weren't recorded, exiting the old one left the
session live, and exiting the new one ended it.

## Tickets

Most work starts from a Linear ticket, so each session shows the ticket it works on, with the
ticket's title, status and assignee (CS-2519).

- **Finding it:** the bridge sends `ticket: { id, source }` with `session.started`, from the
  first of: estra's `ESTRA_TICKET` label; a ticket id in the branch name, in Linear's branch
  format (`lucadeleo/cs-2488-…`; any team key, so a branch like `deps/react-19` reads as
  REACT-19, which is why such a ticket waits for Linear, below); the Linear issue Orca links
  to the worktree. Orca doesn't put that link in a
  pane's environment, so the bridge asks `orca worktree show --worktree id:$ORCA_WORKTREE_ID`,
  only for the pane's own worktree, for 2 seconds at most. Code: `sphere/src/ticket.ts`,
  `findTicket` in `shared/protocol.ts`.
- **On the server:** estra's label wins wherever it came from (it is the ticket of sessions
  whose bridges predate tickets but not labels), then the bridge's ticket, then the one the
  session had: a resume that finds none keeps it. A bridge from before tickets sends none,
  so its session has no ticket even on a `cs-` branch. An older server stores the field unread
  and picks it up from the log once it updates.
- **A ticket from a branch name waits for Linear.** The world keeps each session's ticket as
  found (`World.found`), but `SessionSummary.ticket` holds one from a branch name only once
  Linear has an issue with that id. The server records that once per id, as
  `ticket.confirmed { id }` (actor `linear`, key `ticket.confirmed:<id>`), the first time a
  read returns the issue while a session waits for it. The world then shows the ticket and
  moves those sessions to its frame, and later sessions on that branch go straight there. It
  is in the log because frames and slots are: canvases, the CLI and a replay after a restart
  all agree, and a restart while Linear is down keeps what it confirmed. A ticket Linear
  later drops stays confirmed and shows its id alone. Older servers ignore the event. estra's
  and Orca's tickets show at once: they name a ticket on purpose.
- **Frames:** every session with a ticket it shows sits in its ticket's frame, wherever it
  was started, so a session started by hand and estra's stages on the same ticket sit
  together. One rule, `regionFor` in `shared/protocol.ts`, used by the world and the canvas.
- **Linear:** the box is reachable only over the tailnet, so Linear's webhooks can't reach it.
  The server reads the tickets of live sessions itself, once a minute
  (`SPHERE_LINEAR_POLL_SECONDS`) and a new session's ticket within a second, in one request:
  `issues(filter: { or: [{ team: { key }, number: { in } }] }, includeArchived: true)`.
  (`issue(id:)` fails on a missing issue and takes the whole request down.) Only Linear-shaped
  ids are read; estra's can be Asana or Todoist ids. The answers stay out of the world and the
  log: they live in memory (`Tickets` in `server/src/linear.ts`), go to canvases as `ticket`
  messages, and come with `status` and `show`. Titles, statuses and links are checked before
  any page sees them: a link has to be on linear.app.
- **When Linear can't answer:** without `SPHERE_LINEAR_KEY`, with a refused key, or with
  Linear down, sessions show their ticket ids (and whatever was last read), and the server
  logs one warning when it starts failing and one line when it recovers, not one per read.
  A ticket from a branch name that Linear hasn't confirmed yet doesn't show until it does;
  without a key, none does.
- **Key:** the server's own key is for reads. Recommended is a personal API key limited to
  the Read permission and to the teams whose tickets sessions work on. An OAuth app with
  client credentials would not be tied to a person, but needs a token minted every 30 days,
  as alsync does for its own app; the server sends either as-is.
- **Changes in Linear (CS-2523).** People and agents change a ticket's status, assignee and
  title, comment on tickets, make tickets, and attach a ticket to a session, each through a
  person's own Linear account (below). Code: `server/src/linear-changes.ts`; commands
  `ticket.options`, `ticket.teams`, `ticket.update`, `ticket.comment`, `ticket.create`,
  `ticket.attach`. Ticket views and live changes from Linear (CS-2525, CS-2526) come later. Each goes through
  `Linear.request` with that person's token (the server's key is only for reads), any error in
  Linear's answer throws, so a change is never taken as made when Linear reported one, and the
  answer goes to `Tickets.set`, which tells canvases at once instead of at the next read.
  - **Whose account:** the asker's own, once connected; any person can change any ticket their
    Linear account can. An agent has no browser to connect with, so one the session's owner
    trusts (`SPHERE_TRUST`, as for `send`) acts through the owner's account, but only on that
    session: its ticket, or a ticket made for it or attached to it. Anyone else, and an agent
    whose owner hasn't connected, is refused (`auth`, exit 3) with what to do. An agent running
    inside a person's session uses that person's token, so it acts as that person.
  - **From the canvas:** the inspector's Linear line has Edit <ticket> (status and assignee from
    the ticket's team's own lists, and the title; only what changed is sent) and New ticket
    (team, title, Markdown description, and for the viewer's own session, "Make it this
    session's ticket"). From the CLI: `sphere ticket set|new|comment|attach|options`, by name
    (`--status "In Review"`, `--assignee me|none|<name>`), looked up in the ticket's team.
  - **Attaching** records `session.ticket { sessionId, id }` (source `sphere`) once Linear, asked
    as the person, has the ticket. Only the owner or an agent they trust attaches, and never over
    estra's label. It comes after estra's label and before the bridge's ticket, so a resume on a
    branch naming another ticket keeps it; the card moves to its ticket's frame, in the room too.
  - **Mixed versions:** all new commands; an older server answers `unknown op`, which the CLI
    reports as a server that needs updating, and an older page never sends them. An older server
    replaying the log ignores `session.ticket`, so such a session goes back to the ticket its
    bridge found; nothing else changes. `TicketSource` gains `sphere`, which older pages and
    CLIs show like any other source.
- **Each person's Linear account (CS-2524).** Changes go to Linear as the person who makes
  them, never with the server's key. Code: `server/src/linear-accounts.ts`.
  - **Connecting:** `linear.connect` gives a link to Linear's consent page (authorization code
    with PKCE, `scope=read,write`, `actor=user`, `prompt=consent`) whose `state` is random,
    single-use, ten minutes long and bound to the person who asked. Linear sends the browser to
    `/linear/callback` on the canvas's own origin (`SPHERE_ORIGIN`), so the tailnet-only box
    needs no inbound access. Behind Tailscale the callback must come from the same person's
    login; a link started by someone else is refused. The server exchanges the code with the
    verifier only it holds, reads `viewer` to learn whom it's connected as, and goes back to the
    canvas (`/?linear=connected`, or `failed` with why).
  - **Storage:** one row per person in `linear_accounts`, outside the event log (every page reads
    the log). Each row is AES-256-GCM sealed with `SPHERE_LINEAR_TOKEN_KEY`, which is in
    `/etc/sphere/env`, not the database, so database backups hold no usable token; the seal is
    bound to the person, so a row copied to another person doesn't open. Pages and the CLI get
    `linear.account`: whether it's on, connected, and as which Linear user.
  - **Expiry and revocation:** access tokens last 24 hours. One about to expire is refreshed
    first, one refresh at a time per person, since Linear rotates refresh tokens. A token Linear
    refuses anyway is refreshed once and the request sent again. A refresh Linear refuses with
    `invalid_grant` (the person revoked the app, or an admin removed it) deletes the row, and the
    person is asked to connect again; any other refusal (`invalid_client` after a wrong secret is
    deployed) is logged as the server's setup and keeps the row. `linear.disconnect` deletes the
    row and asks Linear to revoke both tokens, saying when Linear couldn't (it's logged; the
    person can revoke the app in Linear's settings). A connection or refresh under way when the
    person disconnects revokes what it got instead of saving it, so a disconnect stays done.
  - **Off** without `SPHERE_LINEAR_CLIENT_ID`, `SPHERE_LINEAR_CLIENT_SECRET` and the key (and, in
    production, `SPHERE_ORIGIN` or `SPHERE_LINEAR_REDIRECT_URL`): `linear.account` says why, and
    the inspector shows it. Reads with `SPHERE_LINEAR_KEY` are unaffected either way.
  - **Mixed versions:** an older server answers `unknown op` to the new commands, so the page
    offers nothing and the CLI says the server needs updating; it ignores the new table. An
    older page never asks.
- **Canvas:** a card has a line with the ticket's status (Linear's glyph and color), its id,
  which opens it in Linear, and its title. Zoomed out, a ticket's frame shows its id and
  status; closer, its title, status, assignee and repos on two lines. ⌘K finds sessions by
  ticket id or title, and the inspector shows the ticket.

## Steering model

Paperclip and Buzz arrived at the same model independently:

- Messages that arrive mid-turn are queued per author. The author can edit, discard,
  or reorder them before delivery.
- Delivery modes: **queue** (deliver when idle), **steer** (inject mid-turn), and
  **interrupt** (abort the turn, then deliver).
- A gate per session decides who may message the agent: owner only, an allowlist,
  or anyone. Messages from anyone except the owner and trusted agents need approval.

Delivery states, shown to the sender (estra, Paperclip, and Buzz all separate these):

```
queued → awaiting approval → approved → at bridge → injected → observed in transcript
                           ↘ rejected                ↘ expired (session offline too long)
```

"Observed in transcript" is the only state that confirms the agent received the
message.

## Location

Agents barely care where the server is. Each model request already goes to
Anthropic's US infrastructure, and an extra ~80 ms per request is small next to
generation time. Location matters for people:

- Interactive terminals: ~80 ms transatlantic round trip is usable over mosh (local
  echo), noticeable in a browser terminal.
- Dev-server previews served from the server: Vite's dev mode loads hundreds of
  separate modules, so 80 ms per round trip adds seconds to page loads.
- Voice through the server: Boston-to-Boston calls through a London server add
  ~80 ms each way. Acceptable, not ideal.
- GitHub is US-hosted, so pushes and clones are faster from the US East coast.

Two of the three main devs are in Boston, so US East (New York or Ashburn) is the
default if the provider has the 9555 there. London is fine if it doesn't.

## Scope limits

- **Anthropic-hosted cloud sessions:** out. They don't load user plugins.
- **Desktop Code tab:** unverified. `$.process` is documented as "CLI only".
- **Mod disabled by:** `--bare`, `--safe-mode`, `disableAllHooks`,
  `allowManagedModsOnly`, or a remote kill switch from Anthropic. The mod API is
  early access and changes between releases.
- **Approving permission prompts from the browser:** works (tested 2026-10-05). The
  mod hooks `classic.PermissionRequest`, which runs alongside the terminal dialog, and
  waits on the bridge for the owner's decision. Whichever answers first decides. In
  headless sessions there is no dialog, so the browser is the only way to answer. Only
  the session's owner can decide; trusted agents cannot.
- **Nobody answering a permission request:** a session started where nobody watches
  (`sphere move --launch` sets this; the server's launcher will too) has
  `SPHERE_PERMISSION_WAIT_MINUTES`. When it runs out, the agent is told the request
  was not run and is waiting for the owner, and carries on with other work. The
  request stays in "Needs you". If the owner allows it later, the agent gets a message
  and its retry of the same call goes through once without asking. Unset, a request
  waits for the terminal dialog as usual. Tested 2026-10-09 with a real session.
- **Headless sessions** (`claude -p`, the SDK) have no dialog, and a `-p` run ends with
  its turn. Their requests are held only when `SPHERE_PERMISSION_WAIT_MINUTES` is above 0
  and the bridge is connected, so Dyson Sphere can show them to someone; otherwise Claude
  Code handles them as it would without the mod (`-p` denies them). The agent is told to
  treat an unanswered request as denied. estra sets 0.05 minutes for its background
  stages by default: mods from before 2026-10-09 read 0 as unset and held each request
  for up to 30 minutes. Tested 2026-10-09 with `claude -p` runs.
- **Server sessions** run without a prompt box when started headless, so
  `prompt.fill` and `prompt.suggest` do nothing there. Sessions resumed in tmux keep
  the box. The browser is the main approval UI either way.
- **macOS-only work** stays on laptops.

## Spike results (2026-10-02)

Branch `spike/session-link`. Everything ran on one Mac, with Claude Code 2.1.287 and
Haiku 4.5 test sessions. Code: `server/`, `sphere/` (CLI and bridge), `mod/`, `web/`,
`shared/protocol.ts`.

| Check | Result |
|---|---|
| Mod loads via `--plugin-dir`, interactive | Works. The very first launch didn't load it; not reproduced since |
| Mod loads in `claude -p --input-format stream-json` | Works; idle headless session took a message and answered |
| Transcript rows stream to the server | Works: prompts, model output, tool calls and results |
| Steer a running turn (`$.session.append`) | Works. 68 ms from command to stored row; the model read it at its next step |
| Owner message when idle (`$.prompt.submit`, `asUser`) | Works |
| Suggest → approve (with edit) → deliver with attribution | Works from the CLI and the browser |
| Permission checks | Non-owner send or approve: exit 3. Approving twice: exit 5 |
| Interrupt (`$.turn.abort`) | Works. 69 ms; turn ends `aborted`, partial output kept |
| Put text in the prompt box (`$.prompt.fill`) | Works |
| Hot reload | Bridge restarts and reconnects; commands sent while it was down are delivered after |
| `/clear` | Old session marked ended; new session id continues on the same bridge |
| Server outage | Outbox held the events and replayed them in order. Reconnect took ~12 s (backoff too long) |
| Headless process exits before sending | Events stay on disk; the next bridge on the machine sends them |
| Move a session to another checkout | Works: code (including untracked files) and transcript moved; resumed with the same id, kept its context, steering works |
| Desktop Code tab | Not tested |
| Permission prompts from the browser (2026-10-05) | Works. The terminal dialog stays up while the request waits in Dyson Sphere; a remote Allow closed it and the tool ran ~1 s later. Deny passes its message to the model. Answering in the terminal marks the request answered-locally. Headless sessions wait until the owner decides |

The move test used a checkout at a different path. Rewriting the old path in the
transcript was enough, so identical paths on the server are a convenience, not a
requirement.

Bugs found and fixed during the spike:
- Event data was stored as a JSON string (Bun SQL encodes a pre-stringified value again).
- Concurrent outbox saves raced on one temp file and crashed the bridge.
- Delivery reports arriving out of order moved a message's state backwards.
- Stored XSS: a bridge could set `bodyId` on a row and the page put it in HTML unescaped.
  The server now strips client-set body fields and the page escapes them.
- The CLI stayed alive until its `wait` timeout fired after printing.

Open issues:
- **Attachment rows** (system reminders, injected context) are forwarded. They can contain
  environment details. The mod should send only their type, not their text.
- **Auto memory:** a test session wrote to the project's real memory folder. Server
  sessions need a decision on auto memory.
- **Reconnect backoff** caps at 10 s; it should retry within 1–2 s for the first minute.
- **"Observed" detection for submitted prompts** matches on text containment, which is
  fragile. Better: tag the prompt and match the tag.
- **Subagent turns:** unknown whether `turn.start`/`turn.complete` fire for subagents and
  confuse the working/idle state.
- **The mod's bridge path** is `bun <repo>/sphere/src/cli.ts`. Distribution needs the
  compiled binary.
- **Permission requests carry no tool call id.** A pending request is settled locally
  when a call of the same tool finishes, which is approximate if the model runs that
  tool in parallel.
- **"Always allow" options** from the dialog (`permission_suggestions`) aren't offered
  remotely yet; the browser can only allow once or deny.

Running it:

```
createdb sphere
bun install
bun run server/src/main.ts                        # http://127.0.0.1:7420/?token=dev-luca
SPHERE_HOME=$PWD/.sphere-dev claude --plugin-dir $PWD/mod
SPHERE_HOME=$PWD/.sphere-dev bun sphere/src/cli.ts status
```

Create `.sphere-dev/config.json` (gitignored) with `{"url": "ws://127.0.0.1:7420/ws", "token": "dev-luca"}`.
Dev tokens: `dev-luca`, `dev-jp`, `dev-bot`.

## Sources

- Mod API types for Claude Code 2.1.287: bundled `plugin-authoring/types/claude-code.d.ts`
- Claude Code docs: code.claude.com/docs/en/ (plugins/mods, cross-session-messaging, channels-reference, remote-control, monitoring-usage, headless)
- Paperclip: `doc/execution-semantics.md` (steering), `packages/paperclip-runner/runner/DURABLE_TRANSPORT.md` (outbox)
- Buzz: `docs/nips/NIP-AO.md` (observer frames), `crates/buzz-acp/src/config.rs` (steer modes), `crates/buzz-cli`
- estra: `estra/design/factory-view.md` (accuracy contract), `estra/estra/live.py` (transcript rules), `factory-web/`
- Nearest product: Agent Office (github.com/AgentSystemLabs/agent-office). It runs agents on its own machine and doesn't collect sessions from devs' laptops or other machines.
