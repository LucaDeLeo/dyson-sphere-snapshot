#!/usr/bin/env bash
# Run on the server as root after new code arrives (deploy/push.sh --update does it):
# installs dependencies, restarts the server, and rebuilds the CLI and mod for everyone with
# an account here. Running sessions keep their old mod until they restart.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
BUN=/opt/bun/bin/bun # root-owned; see provision.sh
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# Servers set up before Bun moved to /opt/bun need provisioning again first: it installs
# Bun there and points the service at it.
if [ ! -x "$BUN" ]; then
  echo "Bun isn't at $BUN yet; running provision.sh first"
  "$APP/deploy/provision.sh"
# Servers set up before browser cards had a browser: provisioning again sets up Chrome and its
# service, and has the server start after it.
elif ! grep -q 'sphere-chrome.service' /etc/systemd/system/sphere-server.service 2>/dev/null; then
  echo "No browser for browser cards yet; running provision.sh first"
  "$APP/deploy/provision.sh"
fi

chown -R root:root "$APP"
chmod -R a+rX "$APP"
(cd "$APP" && "$BUN" install --frozen-lockfile >/dev/null)
chmod -R a+rX "$APP"
install -m 755 "$APP/deploy/backup.sh" /usr/local/sbin/sphere-backup
# Chrome's service as this checkout defines it (restarted only if that changed: tabs stay open).
# A browser that won't start doesn't stop the update: the server runs without browser cards.
"$APP/deploy/chrome.sh" || echo "warning: sphere-chrome isn't running, so browser cards are off; see: journalctl -u sphere-chrome -n 50" >&2
systemctl restart sphere-server
for _ in $(seq 1 30); do
  curl -fs -o /dev/null http://127.0.0.1:7420/ && break
  sleep 1
done
curl -fs -o /dev/null http://127.0.0.1:7420/ || { echo "sphere-server didn't come back; see: journalctl -u sphere-server -n 50" >&2; exit 1; }
echo "sphere-server restarted"

for home in /home/*; do
  user="$(basename "$home")"
  [ -f "$home/.sphere/config.json" ] || continue
  echo "Updating $user"
  sudo -iu "$user" bash -lc "PATH=\$HOME/.local/bin:\$PATH '$APP/install.sh'" | sed 's/^/  /'
done
