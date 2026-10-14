#!/usr/bin/env bash
# Gives a person their own Orca on the server: `orca-ide serve` running as their Linux
# user, on a port of their own, as a systemd user service that keeps running after they
# log out and starts again after a reboot. Run as root, after deploy/install-orca.sh and
# deploy/add-person.sh --linux-user:
#
#   deploy/add-orca.sh luca [--port 6800]
#
# Their laptop's Orca and their phone pair with it over the tailnet (`orca-pair` on the
# server prints a link). Safe to run again. On this machine, only their own processes can
# connect to the port (an nftables table, orca-ports-firewall.service). It prints the
# tailnet access rule that lets only their devices reach the port: the tailnet's policy
# is edited by hand.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ $# -ge 1 ] || { sed -n '2,12p' "$0"; exit 1; }
PERSON="$1"; shift
PORT=
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

id "$PERSON" >/dev/null 2>&1 || { echo "no Linux user $PERSON: run add-person.sh --linux-user first" >&2; exit 1; }
UID_="$(id -u "$PERSON")"
HOME_="$(getent passwd "$PERSON" | cut -d: -f6)"
[ "$UID_" -ge 1000 ] || { echo "$PERSON is a system account" >&2; exit 1; }
for tool in /usr/bin/orca-ide Xvfb xauth mcookie; do
  command -v "$tool" >/dev/null || { echo "$tool is missing: run deploy/install-orca.sh" >&2; exit 1; }
done

# Ports and displays follow the uid, so two people never get the same one. The
# tailnet policy keeps 6800-6899 for Orca, so only each port's owner reaches it.
PORT="${PORT:-$((6800 + UID_ - 1000))}"
DISPLAY_NUM="$((100 + UID_ - 1000))"
[ "$PORT" -ge 6800 ] && [ "$PORT" -le 6899 ] ||
  { echo "port $PORT is outside 6800-6899, the range the tailnet policy keeps for Orca: pass --port" >&2; exit 1; }
# Who owns which port, kept by root: the firewall below is built from it.
PORTS=/etc/orca-serve/ports
mkdir -p "$(dirname "$PORTS")"
touch "$PORTS"
OWNER="$(awk -v p="$PORT" '$3 == p {print $1}' "$PORTS")"
if [ -n "$OWNER" ] && [ "$OWNER" != "$PERSON" ]; then
  echo "port $PORT belongs to $OWNER's Orca" >&2; exit 1
fi
ADDRESS="$(tailscale ip -4 2>/dev/null | head -1)"
[ -n "$ADDRESS" ] || { echo "Tailscale isn't signed in here: Orca needs the address devices reach it at" >&2; exit 1; }
HOST="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

# Without lingering, systemd stops a person's services when their last session ends and
# starts them only when they log in.
loginctl enable-linger "$PERSON"

# Orca listens on every address, and the tailnet's rules don't cover connections made
# on this machine: anyone with an account here could open one to anyone's Orca. So each
# Orca port takes new local connections only from its owner's processes. The rules only
# cover this machine's own addresses: connections to other machines' ports are left
# alone. A separate nftables table, loaded by its own unit: ufw's rules are left alone.
{ grep -v "^$PERSON " "$PORTS" || true; echo "$PERSON $UID_ $PORT"; } | sort -n -k3 > "$PORTS.new"
mv "$PORTS.new" "$PORTS"
OWNERS="$(awk '{printf "%s%s . %s", (NR > 1 ? ", " : ""), $2, $3}' "$PORTS")"
cat > /etc/orca-serve/ports.nft <<EOF
# Written by add-orca.sh from $PORTS (name, uid, port). Each person's Orca port
# takes new connections made on this machine only from their own processes.
# Connections from the tailnet arrive from outside and aren't affected: the
# tailnet policy decides those. Nor are connections to other machines.
table inet orca_ports
delete table inet orca_ports
table inet orca_ports {
	chain output {
		type filter hook output priority filter; policy accept;
		tcp dport 6800-6899 fib daddr type local ct state new meta skuid . tcp dport { $OWNERS } accept
		tcp dport 6800-6899 fib daddr type local ct state new reject with tcp reset
	}
}
EOF
cat > /etc/systemd/system/orca-ports-firewall.service <<'EOF'
[Unit]
Description=Orca ports take local connections only from their owners (add-orca.sh)
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/orca-serve/ports.nft
ExecReload=/usr/sbin/nft -f /etc/orca-serve/ports.nft
ExecStop=/usr/sbin/nft delete table inet orca_ports

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable orca-ports-firewall.service >/dev/null 2>&1
# Reloading swaps the table in one step, so no port is open in between.
systemctl reload-or-restart orca-ports-firewall.service

# Everything below is written as them, from standard input, so root never follows a path
# they control.
as_person() { sudo -u "$PERSON" -H "$@"; }
write() { as_person sh -c 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"' sh "$1"; }

write "$HOME_/.config/orca-serve/env" <<EOF
ORCA_SERVE_PORT=$PORT
ORCA_SERVE_ADDRESS=$ADDRESS
DISPLAY=:$DISPLAY_NUM
XAUTHORITY=$HOME_/.config/orca-serve/Xauthority
EOF

# On a server, Orca's Electron starts its own Xvfb on :99, and reuses one that's already
# there, even another person's. Each person gets a display of their own instead, with a
# cookie only they can read, so no one else's Orca or agents can see or type into it.
write "$HOME_/.config/systemd/user/orca-xvfb.service" <<'EOF'
[Unit]
Description=A private X display for Orca

[Service]
EnvironmentFile=%h/.config/orca-serve/env
ExecStartPre=/bin/sh -c 'umask 077 && rm -f "$$XAUTHORITY" && xauth -q -f "$$XAUTHORITY" add "$$DISPLAY" . "$$(mcookie)"'
ExecStart=/usr/bin/Xvfb ${DISPLAY} -screen 0 1280x1024x24 -nolisten tcp -auth ${XAUTHORITY}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

# KillMode=process: stopping or restarting stops only `orca-ide serve`. Orca's terminal
# daemon, which it starts, keeps running with everyone's terminals in it, and the next
# start reconnects to it. The default would end every terminal on each restart.
write "$HOME_/.config/systemd/user/orca-serve.service" <<'EOF'
[Unit]
Description=Orca (orca-ide serve) for the Orca apps on this person's devices
Requires=orca-xvfb.service
After=orca-xvfb.service

[Service]
EnvironmentFile=%h/.config/orca-serve/env
# Wait for the display, and make sure it is this person's: a display someone else started
# first under the same number would see everything Orca shows.
ExecStartPre=/bin/sh -c 's=/tmp/.X11-unix/X$${DISPLAY#:}; for i in $$(seq 50); do [ -S "$$s" ] && break; sleep 0.1; done; [ "$$(stat -c %%u "$$s")" = "$$(id -u)" ]'
ExecStart=/usr/bin/orca-ide serve --port ${ORCA_SERVE_PORT} --pairing-address ${ORCA_SERVE_ADDRESS} --json $ORCA_SERVE_FLAGS
KillMode=process
Restart=always
RestartSec=5
TimeoutStopSec=90

[Install]
WantedBy=default.target
EOF

as_person sh -c 'umask 022 && mkdir -p "$HOME/.local/bin" && cat > "$HOME/.local/bin/orca-pair" && chmod 755 "$HOME/.local/bin/orca-pair"' < "$APP/deploy/orca-pair.sh"

user_ctl() { systemctl --user -M "$PERSON@" "$@"; }
# The user manager starts with lingering; give it a moment the first time.
for _ in $(seq 50); do user_ctl is-system-running >/dev/null 2>&1 && break || sleep 0.1; done
user_ctl daemon-reload
user_ctl enable orca-xvfb.service orca-serve.service >/dev/null 2>&1
# Picks up a changed port or address; terminals keep running (see KillMode above).
user_ctl restart orca-xvfb.service orca-serve.service

for _ in $(seq 120); do
  ss -ltnH "sport = :$PORT" | grep -q . && break
  sleep 1
done
ss -ltnH "sport = :$PORT" | grep -q . || { echo "Orca didn't start. As $PERSON: journalctl --user -t orca-ide" >&2; exit 1; }

cat <<EOF

$PERSON's Orca is running on port $PORT ($ADDRESS:$PORT on the tailnet).

To pair their laptop's Orca, they run this on the server and paste the link into Orca's
Settings → Remote Orca Servers → Add Server:

  ssh $PERSON@$HOST orca-pair

For their phone: 'orca-pair mobile', then Pair in the Orca app and scan the code.

The tailnet must let only $PERSON's devices reach port $PORT on this server. Add to the
"acls" in the tailnet's policy:

  {"action": "accept", "src": ["<$PERSON's Tailscale login>"], "dst": ["tag:sphere:$PORT"]},

and a test that someone else's device is refused. No other rule may open 6800-6899 on
this server to anyone else.
EOF
