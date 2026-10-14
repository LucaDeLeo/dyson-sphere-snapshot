#!/bin/sh
# sphere-chrome's ExecStartPre, as root (deploy/chrome.sh): only these users' processes may open a
# connection to Chrome's debugging port. The port is on loopback, but anyone with an account here
# could reach loopback, and CDP lets whoever connects drive every tab and read its cookies. The
# rule matches the connecting socket's owner, in nftables' output hook, which every connection made
# on this machine passes through, and only connections to this machine: the same port elsewhere is
# anyone's. Root can always undo it. Replaced whole on every start.
#
#   sphere-chrome-firewall <port> <user>...
set -eu
port="$1"
shift
case "$port" in '' | *[!0-9]*) echo "not a port: $port" >&2; exit 1 ;; esac
uids=""
for user in "$@"; do
  uids="$uids${uids:+, }$(id -u "$user")"
done
[ -n "$uids" ] || { echo "name the users who may connect" >&2; exit 1; }
nft -f - <<EOF
table inet sphere_chrome
delete table inet sphere_chrome
table inet sphere_chrome {
  chain output {
    type filter hook output priority filter; policy accept;
    ip daddr 127.0.0.0/8 tcp dport $port meta skuid { $uids } accept
    ip daddr 127.0.0.0/8 tcp dport $port reject with tcp reset
    ip6 daddr ::1 tcp dport $port meta skuid { $uids } accept
    ip6 daddr ::1 tcp dport $port reject with tcp reset
  }
}
EOF
