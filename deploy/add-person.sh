#!/usr/bin/env bash
# Adds a person to Dyson Sphere on the server. Run as root:
#
#   deploy/add-person.sh luca.deleo@80000hours.org [--as luca] [--linux-user]
#   deploy/add-person.sh ops-bot --agent
#
# The login is the one they sign in to Tailscale with; their name in Dyson Sphere comes from
# it (luca.deleo@… → luca) unless --as gives another. It prints the command that sets up
# their laptop. --linux-user also gives them an account here with Claude Code and the mod,
# for sessions that run on the server (they sign in to Claude Code once, over SSH).
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
BUN=/opt/bun/bin/bun # root-owned; see provision.sh
export SPHERE_PEOPLE_FILE=/etc/sphere/people.json
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ $# -ge 1 ] || { sed -n '2,11p' "$0"; exit 1; }

LINUX_USER=0
ARGS=()
for a in "$@"; do
  if [ "$a" = --linux-user ]; then LINUX_USER=1; else ARGS+=("$a"); fi
done

field() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
ADDED="$("$BUN" "$APP/deploy/people.ts" add "${ARGS[@]}")"
IDENTITY="$(echo "$ADDED" | field identity)"
TOKEN="$(echo "$ADDED" | field token)"
systemctl restart sphere-server
echo "Added $IDENTITY."

# This server's Tailscale name, once Tailscale is signed in.
HOST="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; n = json.load(sys.stdin)["Self"]["DNSName"].rstrip("."); print(n) if n else sys.exit(1)' 2>/dev/null || echo '<this server>.<tailnet>.ts.net')"

if [ "$LINUX_USER" = 1 ]; then
  if ! id "$IDENTITY" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$IDENTITY"
  elif [ ! -d "/home/$IDENTITY/.sphere" ]; then
    # An account this script didn't make (a system or admin account): don't take it over.
    echo "A Linux user called $IDENTITY already exists. Skipped the server account; they're set up for their laptop below." >&2
    LINUX_USER=0
  fi
fi
if [ "$LINUX_USER" = 1 ]; then
  # Their own token here, so this machine can be cut off alone.
  SERVER_TOKEN="$("$BUN" "$APP/deploy/people.ts" token "$IDENTITY" | field token)"
  systemctl restart sphere-server
  sudo -iu "$IDENTITY" bash -c 'command -v claude >/dev/null || [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
  # The token reaches their config on standard input, never on a command line others could
  # see, and the file is written as them: root never follows a path they control.
  printf '{"url": "ws://127.0.0.1:7420/ws", "token": "%s"}\n' "$SERVER_TOKEN" |
    sudo -u "$IDENTITY" -H sh -c 'umask 077 && mkdir -p "$HOME/.sphere" && cat > "$HOME/.sphere/config.json"'
  sudo -iu "$IDENTITY" bash -lc "PATH=\$HOME/.local/bin:\$PATH '$APP/install.sh'"
  echo
  echo "$IDENTITY has an account here. They reach it with: ssh $IDENTITY@$HOST"
  echo "(Tailscale SSH: allow it for them in the tailnet's access controls.)"
  echo "Their first time, they run 'claude' there once to sign in."
fi

WHERE="$IDENTITY's laptop"
case " $* " in *" --agent "*) WHERE="the machine $IDENTITY runs on" ;; esac
cat <<EOF

On $WHERE, from a checkout of the 80k-coding-tools repository:

  dyson-sphere/install.sh --url wss://$HOST/ws --token $TOKEN

The token is a password: send it privately.
EOF
