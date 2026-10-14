# Dyson Sphere

A shared, live canvas of every Claude Code and Codex session on the team. Open it in a browser to
see what every agent is doing, answer the ones waiting on you, steer your own, suggest
messages to anyone else's, and leave notes. External agents use the same system through
the `sphere` CLI.

Dyson Sphere is the team's dashboard and its connection to Claude Code and Codex sessions. estra
(`../estra`) stays the pipeline that takes tickets to pull requests; the sessions it starts
show up here like any other.

- **Design and architecture:** [`docs/architecture.md`](docs/architecture.md)
- **Product brief:** [`PRODUCT.md`](PRODUCT.md)

## How it fits together

```
claude + mod ──▶ sphere bridge ──WebSocket──▶ sphere-server (Bun, Postgres) ◀── browser canvas
                 (local outbox)                                              ◀── sphere CLI (people, agents)
```

- **The mod** (`mod/`) is a Claude Code plugin. It reports every transcript row, applies
  steering (mid-turn notes, prompts, interrupts, prompt-box text) and answers permission
  requests decided in the browser.
- **The bridge** (`sphere bridge`) is started by the mod for each session. It buffers
  events on disk, so nothing is lost while offline.
- **The server** (`server/`) keeps an event log in Postgres and the live world in memory,
  and serves the canvas.
- **The canvas** (`web/`) is the shared infinite canvas.

## Run it locally

Requirements: [Bun](https://bun.sh) 1.4+, Postgres, Claude Code 2.1.287+.

```sh
createdb sphere
bun install
bun run server/src/main.ts            # http://127.0.0.1:7420/?token=dev-luca
```

Point the CLI and bridge at it. `SPHERE_HOME` defaults to `~/.sphere`:

```sh
mkdir -p ~/.sphere
echo '{"url": "ws://127.0.0.1:7420/ws", "token": "dev-luca"}' > ~/.sphere/config.json
```

Start Claude Code with the mod:

```sh
claude --plugin-dir ./mod
```

No Claude Code at hand? Simulated sessions stream realistic activity for three people:

```sh
bun run simulate -- --sessions 18
```

For a demo, one command starts a fresh database, the server and nine realistic simulated
sessions, and prints the URLs for two people's views:

```sh
bun run demo
```

Dev tokens: `dev-luca`, `dev-jp`, `dev-bot`. The server refuses them in production.

The canvas runs on tldraw (CS-2554). The React Flow canvas it replaced has been removed; an old
`?canvas=classic` link opens the tldraw canvas.

## Terminal cards

Select a session's card and press T (or its Terminal button) to put its terminal on the canvas:
the tmux pane the session runs in, live. Everyone can watch it; only the session's owner can
type into it. Double-click the card to type (or, for anyone else, to scroll and copy); ⌘Esc
(Ctrl+Esc elsewhere) leaves it, and every other key, Escape included, goes to the terminal. The
owner's Fit pane makes the pane as big as the card (tmux then keeps that size for its window;
`tmux resize-window -A` undoes it).

For now a terminal card shows sessions on the team server (`SPHERE_TERMINAL_MACHINES`) that run
in tmux, and whose sphere is up to date; for any other it says why it has nothing to show. A
laptop's terminal isn't offered yet. Nobody gets a shell from it: it's the session's own pane,
reached through its owner's bridge. Design: `docs/architecture.md`, "Terminal cards".

## Browser cards

Select one of your sessions and press B (or its Browser button) to open a tab of the server's own
Chrome for it, as a card: type an address in its bar (http and https only). Everyone can watch the
tab; only the session's owner can use it. Double-click the card to click, scroll and type in the
tab; ⌘Esc (Ctrl+Esc) leaves. No site is ever put in an iframe: the tab runs on the server and the
card shows its screencast. A page streams at most four browser cards at a time, the one in use and
the biggest in view first; the others, and any off screen or too small to read, show their last
frame. Removing a card closes its tab.

The tabs are Google Chrome's, in the `sphere-chrome` service that `provision.sh` sets up
(`deploy/chrome.sh`): Chrome stable from Google's signed apt repository, headless, with its sandbox
on, run by a `sphere-chrome` user of its own that can't read `/etc/sphere`. Its debugging port
(19222) listens on loopback only, and a firewall rule lets only the server's user connect to it:
CDP has no password, and anyone with an account on the server can reach loopback. The server learns
the port from `/run/sphere-chrome` (`SPHERE_BROWSER_PROFILE`). Without it, browser cards say no browser is set up.

A tab can reach anything the server can: the internet, but also services on the server's own
loopback (Orca, estra's dashboard, sphere-server itself, Postgres) and the tailnet. That's a
decision, Luca's (13 October 2026): only people who own sessions can send a tab anywhere, and
they, and their agents, can reach those already. The one place a tab can never go is the browser's
own debugging port. Design: `docs/architecture.md`, "Browser cards".

## Set up the server

On a fresh Ubuntu 24.04 or 26.04 server you can SSH into as root:

```sh
deploy/push.sh root@<server>                       # copies this checkout to /opt/dyson-sphere
ssh root@<server> /opt/dyson-sphere/deploy/provision.sh
```

`provision.sh` installs Postgres, Bun, tmux, Tailscale and Google Chrome. It runs `sphere-server`
as a systemd service, and Chrome for browser cards as `sphere-chrome`, and backs up the database every night to `/var/backups/sphere`, keeping
14 days. The server listens in two places: 127.0.0.1:7420 for bridges and the CLI on the
server, and `/run/sphere/web.sock` for `tailscale serve`. It's safe to run again. Then,
on the server:

```sh
tailscale up --ssh                                   # sign the server in to your tailnet
tailscale serve --bg unix:/run/sphere/web.sock       # https://<server>.<tailnet>.ts.net
ufw allow OpenSSH && ufw allow in on tailscale0 && ufw --force enable
```

Backups stay on the server until you set `SPHERE_BACKUP_COMMAND` in
`/etc/sphere/backup.env` to a command that copies each one elsewhere.

To restore a backup:

```sh
systemctl stop sphere-server
sudo -u postgres dropdb sphere && sudo -u postgres createdb -O sphere sphere
sudo -u postgres pg_restore --no-owner --role=sphere -d sphere < /var/backups/sphere/<file>.dump
systemctl start sphere-server
```

To ship new code: `deploy/push.sh root@<server> --update`. This restarts the server and
updates everyone's CLI and mod on the server.

## Add people

On the server, as root:

```sh
/opt/dyson-sphere/deploy/add-person.sh jp@example.org                 # their Tailscale login
/opt/dyson-sphere/deploy/add-person.sh jp@example.org --linux-user    # plus an account on the server
/opt/dyson-sphere/deploy/add-person.sh ops-bot --agent                # an agent: a token, no login
```

A person's name in Dyson Sphere comes from their login (`jp.smith@…` becomes `jp`)
unless `--as` gives another. Their browser sign-in and their sessions always get the
same name, because both come from `/etc/sphere/people.json`. The script prints the
command that sets up their laptop. With `--linux-user` they also get an account on the
server, with Claude Code and the mod installed. They sign in to Claude Code there once,
over Tailscale SSH. Adding someone restarts the server; open canvases and bridges
reconnect within seconds.

## Give people their own Orca

People with an account on the server can run their own Orca there, so their terminals
keep running when their laptop sleeps. On the server, as root:

```sh
/opt/dyson-sphere/deploy/install-orca.sh             # Orca's .deb, checksum-checked; again to update
/opt/dyson-sphere/deploy/add-orca.sh jp              # jp's `orca-ide serve`, as a systemd user service
```

Each person's Orca runs as them on its own port (6800 + uid − 1000), keeps running after
they log out and starts at boot. Restarting it keeps their terminals. They pair their
laptop's Orca and phone over the tailnet with `orca-pair` (or `orca-pair mobile`) on the
server. The tailnet's access controls must let only their devices reach that port: the
script prints the rule.

## Install on a laptop

From a checkout of 80k-coding-tools, with the token from `add-person.sh`:

```sh
dyson-sphere/install.sh --url wss://<server>.<tailnet>.ts.net/ws --token sph_...
```

It needs Claude Code 2.1.287 or newer, and installs Bun if it's missing. It builds the
`sphere` CLI into `~/.sphere/bin` (where the mod looks for it) and writes
`~/.sphere/config.json`. It then installs the mod into Claude Code from this checkout, so
every new session reports. After `git pull`, run `./install.sh` again.

If Codex is installed, `install.sh` also adds Dyson Sphere's hooks to `~/.codex/hooks.json`
(or `$CODEX_HOME/hooks.json`) and trusts them, the way Codex's `/hooks` does, so `codex exec`
runs them too. Entries already in that file stay where they are. If Codex later asks you to
review hooks, that's for hooks other than Dyson Sphere's. To remove them, delete the entries
whose command starts with `: dyson-sphere-hook=1;` and check `/hooks` for the others.

A Codex session shows its transcript, takes messages while it works (at its next tool call,
or as its turn ends, when Codex carries on with it), and its permission requests can be
answered from the canvas. Codex's hooks can't reach a Codex session that is idle at its
prompt, put text in its prompt box or interrupt it, so the canvas doesn't offer those.

## Server settings

`provision.sh` writes these to `/etc/sphere/env`.

| Variable | Meaning |
|---|---|
| `SPHERE_AUTH=tailscale` | People in a browser are signed in as their Tailscale login, from the header `tailscale serve` adds. The header is trusted only on `SPHERE_WEB_SOCKET`; the TCP port needs a token, since anyone with an account on the server can reach it. |
| `SPHERE_WEB_SOCKET` | The Unix socket `tailscale serve` forwards to. Only the server's user and root can open it. |
| `SPHERE_ORIGIN` | Optional: the page's origin, such as `https://sphere.example.ts.net`. The server refuses WebSocket connections from other sites' pages; by default it compares a page's origin with the host the request was sent to. |
| `SPHERE_PEOPLE_FILE` | Who may use it: each person's name, Tailscale logins and tokens. Kept by `deploy/people.ts`; `add-person.sh` uses it. |
| `SPHERE_LOGIN_DOMAIN` | Optional: logins in this domain sign in as the part before `@`, without being listed. |
| `SPHERE_LOGINS`, `SPHERE_TOKENS`, `SPHERE_TOKENS_FILE` | Older ways to list logins (`login:identity,…`) and tokens (`token:identity,…` or a JSON file). |
| `SPHERE_TRUST` | `owner:agent,…`: agents whose messages skip approval on that owner's sessions. |
| `SPHERE_PORT`, `SPHERE_HOST` | Default `7420` on `127.0.0.1`. |
| `DATABASE_URL` | Default `postgres://localhost/sphere`. `?host=/var/run/postgresql` connects over that Unix socket (peer authentication), as libpq does. |
| `SPHERE_LINEAR_KEY` | Optional, added by hand: a Linear API key, ideally a personal key limited to the Read permission and the teams whose tickets sessions work on. With it, cards show their ticket's title, status and assignee; without it, just the id of a ticket estra or Orca names, and no ticket found in a branch name. |
| `SPHERE_LINEAR_POLL_SECONDS` | How often Linear is read for the tickets of live sessions. Default `60`. |
| `SPHERE_LINEAR_URL` | Linear's GraphQL endpoint. Tests and the demo point it at a stand-in, which also serves OAuth at its `/oauth/authorize`, `/oauth/token` and `/oauth/revoke`. |
| `SPHERE_LINEAR_CLIENT_ID`, `SPHERE_LINEAR_CLIENT_SECRET` | Optional, added by hand: the OAuth app people connect their own Linear accounts through (see "Linear accounts" below). Without both, nobody can connect an account, and the canvas says connecting accounts is off. |
| `SPHERE_LINEAR_TOKEN_KEY` | The key people's Linear tokens are encrypted with in the database: 32 or more characters. `provision.sh` writes a random one. It lives here, not in the database, so a database backup holds no usable token. Changing it disconnects everyone, who then connect again. |
| `SPHERE_LINEAR_REDIRECT_URL` | Optional: where Linear sends people back to. Default `SPHERE_ORIGIN` + `/linear/callback`, which a production server needs one of. |
| `SPHERE_BROWSER_PROFILE` | The folder with the `DevToolsActivePort` of the Chrome whose tabs browser cards show. `provision.sh` sets `/run/sphere-chrome`, where the `sphere-chrome` service copies it from its profile; elsewhere, a Chrome's own profile directory (`--user-data-dir`, started with `--remote-debugging-port=0`). The server uses the port only while that browser names the same browser target. Unset: no browser cards. |
| `SPHERE_TERMINAL_MACHINES` | Optional: the machines, as sessions name them, whose sessions' terminals the canvas shows. Default: this server's hostname. |
| `SPHERE_TLDRAW_LICENSE_KEY` | Required in production, added by hand: tldraw's licence key (CS-2554). Production means served over https to a host other than the server itself; there is no other canvas to fall back to. tldraw checks it in the browser, so the server puts it in the page it serves; it isn't secret, but it stays out of the repo. Development (plain http, or localhost) needs none. tldraw's documentation says the canvas stops drawing without a valid key, and after the key expires: 30 days after for a paid key, at once for a trial. |

### Linear accounts

Each person connects their own Linear account, so what they change in Linear from Dyson Sphere is
done as them (CS-2524). Once, in Linear (Settings → API → OAuth applications → New), a workspace
admin creates the app:

- **Name** Dyson Sphere, with any icon; **Developer URL** the canvas's address.
- **Callback URL**: `https://<server>.<tailnet>.ts.net/linear/callback`, exactly the canvas's
  address (`SPHERE_ORIGIN`) followed by `/linear/callback`. Linear only redirects the browser
  there, so the server needn't be reachable from the internet.
- **Public**: off (only this workspace). Webhooks: off. Client credentials: not needed.

Then put its client ID and secret in `/etc/sphere/env` as `SPHERE_LINEAR_CLIENT_ID` and
`SPHERE_LINEAR_CLIENT_SECRET`, with `SPHERE_ORIGIN=https://<server>.<tailnet>.ts.net`, and restart
`sphere-server`. People then press **Connect Linear** in any session's inspector (or run
`sphere linear connect` and open the link), say yes in Linear, and land back on the canvas. Dyson
Sphere asks for `read,write`, uses PKCE, keeps the tokens encrypted on the server and never sends
them to a page; **Disconnect** forgets them and asks Linear to revoke them (and says if Linear
couldn't be asked). Revoking the app in Linear's own settings
works too: the next change asks the person to connect again.

With it, the inspector's Linear line edits the session's ticket (status, assignee, title) and
makes new tickets, optionally as the session's ticket, all as the viewer. An agent uses
`sphere ticket`: it acts through its own person's account, or, if it's an agent the session's
owner trusts (`SPHERE_TRUST`), through the owner's, for that session only.

`SPHERE_PERMISSION_WAIT_MINUTES`, set in a Claude Code session's environment, is how long
its permission requests wait before the agent carries on without them; `0` means not at
all. `sphere move --launch` sets 10 minutes, and estra sets it for its background stages.
A headless session without it doesn't hold its requests. See "Scope limits" in
`docs/architecture.md`.

estra labels the agents it starts with `ESTRA_STAGE` and `ESTRA_PROVIDER`, and the ones it
starts for a task also with `ESTRA_TICKET` and `ESTRA_TASK_ID`. The bridge reports them, and
the canvas puts a session with a ticket in that ticket's frame.

Every other session gets a ticket too when it can be found: from a ticket id in its branch
name (`lucadeleo/cs-2488-…` is CS-2488), or else from the Linear issue Orca links to the
worktree of the Orca pane it runs in. Each session's card shows its ticket, and sessions on the
same ticket share a frame. With `SPHERE_LINEAR_KEY` set, the server reads those tickets'
titles, statuses and assignees from Linear once a minute, and the ticket's id opens it in
Linear. A ticket found in a branch name shows once Linear has it, so `deps/react-19` doesn't
make a REACT-19 frame. A bridge from before tickets reports as before, without a ticket.

## The CLI

```
sphere status                          live sessions
sphere sessions --ticket CS-2488       the sessions working on that ticket
sphere show <session> [--tail N]       transcript rows and deliveries (--before SEQ: older ones)
sphere watch [<session>|--all]         NDJSON stream
sphere wait <session> --until idle     block until something happens
sphere send | suggest <session> <text> message an agent (others' sessions: suggest)
sphere interrupt <session>
sphere permissions | allow | deny      permission requests on your sessions
sphere approvals | approve | reject    suggestions on your sessions
sphere move <session> --to <dir>       hand a session to another checkout
sphere linear [connect|disconnect]     your own Linear account, for changes made as you
sphere ticket set [<id>] --session <s> --status "In Review" --assignee me
sphere ticket new --team CS --title <text> [--description <text|->] [--session <s>]
sphere ticket attach <id> --session <s> make an existing ticket that session's (owner or trusted agent;
                                       not on a session estra started for a ticket, which keeps estra's)
sphere ticket comment [<id>] --session <s> --body <text|->
sphere guide                           how agents should use it
```

Output is JSON when piped. Exit codes: 0 ok, 1 user error, 2 network, 3 auth, 4 other,
5 conflict.

## Develop

```sh
bunx tsc -p .                          # type-check server, CLI, canvas, simulator
claude plugin validate mod             # check the mod the way Claude Code loads it
claude plugin test mod                 # the mod's tests, against Claude Code's test kit
DATABASE_URL=postgres://localhost/sphere_test bun test   # server tests; empties that database
```

Where Postgres takes only Unix-socket connections, add `?host=/var/run/postgresql` to
`DATABASE_URL`, and set `PGHOST=/var/run/postgresql` for `bun run demo` (`--db` and `--port`
keep it apart from another demo on the same machine). `bun run demo --history 5000` gives the first
session 5,000 rows of history, for long transcripts; the last simulated session runs as
Codex.

Browser checks and a frame-time benchmark, not run in CI (no browser there):

```sh
bunx playwright install chromium                             # once
bun run check:canvas http://127.0.0.1:7430                   # against `bun run demo`: two people, and an older client
bun run check:terminal http://127.0.0.1:7430                 # terminal cards, against `bun run demo` on a machine with tmux
bun run check:browser http://127.0.0.1:7430                  # browser cards: the demo starts a Chromium of its own for them
bun run scripts/bench-canvas.ts http://127.0.0.1:7432 --sessions 2000   # its header says how to start that server
```
