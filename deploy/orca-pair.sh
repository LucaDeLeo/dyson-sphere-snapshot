#!/usr/bin/env bash
# Prints a link that pairs one device with your Orca on this server:
#
#   orca-pair           for the Orca desktop app: Settings → Remote Orca Servers → Add Server
#   orca-pair mobile    for the Orca phone app: Pair, then scan the code or paste the link
#
# It restarts your Orca to make the link. Your terminals keep running, and devices you
# paired before stay paired. add-orca.sh installs this as ~/.local/bin/orca-pair.
set -euo pipefail
# Sessions without a login (cron, su) may not set it, and systemd's user tools need it.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

case "${1:-desktop}" in
  desktop) flags= scope=runtime ;;
  mobile) flags=--mobile-pairing scope=mobile ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

# One run at a time: two would share ORCA_SERVE_FLAGS and read the same journal lines.
exec 9>"$XDG_RUNTIME_DIR/orca-pair.lock"
flock -n 9 || { echo "Waiting for your other orca-pair to finish..." >&2; flock 9; }

# Read only what this start logs: an earlier start's link may be for the other kind of
# device. Orca's own process logs under its own scope, so look it up by name, not unit.
cursor="$(journalctl --user -n 0 --show-cursor -o cat | sed -n 's/^-- cursor: //p')"
# Only this start gets the flag, even when it fails: systemd restarts a failed Orca
# by itself, and that start should print a desktop link again.
trap 'systemctl --user unset-environment ORCA_SERVE_FLAGS' EXIT
systemctl --user set-environment "ORCA_SERVE_FLAGS=$flags"
systemctl --user restart orca-serve
systemctl --user unset-environment ORCA_SERVE_FLAGS
trap - EXIT

line=
for _ in $(seq 120); do
  line="$(journalctl --user -t orca-ide --after-cursor "$cursor" -o cat | grep '"type":"orca_server_ready"' | tail -1 || true)"
  [ -n "$line" ] && break
  sleep 1
done
[ -n "$line" ] || { echo "Orca didn't start. See: journalctl --user -t orca-ide" >&2; exit 1; }
url="$(printf '%s' "$line" | python3 -c '
import json, sys
try:
    pairing = json.load(sys.stdin)["pairing"]
    got, url = pairing.get("scope", "runtime"), pairing["url"]
    if not isinstance(url, str) or not url:
        raise ValueError(url)
except (ValueError, KeyError, TypeError, AttributeError):
    sys.exit("Orca started without a pairing link. See: journalctl --user -t orca-ide")
if got != sys.argv[1]:
    sys.exit("Orca printed a " + got + " link, not a " + sys.argv[1] + " one")
print(url)' "$scope")"
if [ "${1:-desktop}" = mobile ] && command -v qrencode >/dev/null; then
  qrencode -t ansiutf8 "$url"
fi
echo "$url"
# Orca keeps a link's access until a device has used it, and doesn't replace it with a
# new one, so a link someone else has seen stays good until it is revoked.
echo "The link is a password for your Orca: use it on your own device only."
