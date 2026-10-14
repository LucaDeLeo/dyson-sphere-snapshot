#!/usr/bin/env bash
# The Chrome whose tabs browser cards show (docs/architecture.md, "Browser cards"). Run as root;
# provision.sh and update.sh run it, and it's safe to run again. It sets up:
# - Google Chrome stable, from Google's signed apt repository (not Ubuntu's chromium, a snap);
# - a `sphere-chrome` system user, with no login, that owns the browser's profile in
#   /var/lib/sphere-chrome and can't read /etc/sphere;
# - the `sphere-chrome` service: headless, its sandbox on, its debugging port on loopback only and
#   open only to the server's user (an nftables rule on the connecting socket's owner: CDP has no
#   authentication, and anyone with an account here can reach loopback);
# - /run/sphere-chrome/DevToolsActivePort, Chrome's port and browser path for the server, which reads
#   it through the `sphere-chrome` group (that folder: read, not write), and
#   SPHERE_BROWSER_PROFILE pointing there in /etc/sphere/env.
#
# The service is restarted only when its definition changes, so an update doesn't close tabs.
# The server must restart afterwards to pick up the setting and its new group (both scripts do).
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
CHROME=/opt/google/chrome/chrome
CHROME_USER=sphere-chrome
CHROME_HOME=/var/lib/sphere-chrome
# Fixed, so the firewall rule names it (deploy/chrome-firewall.sh).
CHROME_PORT=19222
SPHERE_USER=sphere
ETC=/etc/sphere
UNIT=/etc/systemd/system/sphere-chrome.service

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

if [ ! -x "$CHROME" ]; then
  echo "Installing Google Chrome stable from Google's apt repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq curl gpg ca-certificates >/dev/null
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
  chmod 644 /etc/apt/keyrings/google-chrome.gpg
  # The package adds its own copy of the repository unless told not to, without `signed-by`,
  # which apt then refuses as a conflicting duplicate.
  printf 'repo_add_once="false"\nrepo_reenable_on_distupgrade="false"\n' > /etc/default/google-chrome
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable >/dev/null
fi
command -v nft >/dev/null 2>&1 || apt-get install -y -qq nftables >/dev/null
command -v curl >/dev/null 2>&1 || apt-get install -y -qq curl >/dev/null
"$CHROME" --version

# Its own user: the server's user (`sphere`) reads every secret in /etc/sphere, which a browser
# that runs other people's pages must not.
getent group "$CHROME_USER" >/dev/null || groupadd --system "$CHROME_USER"
id "$CHROME_USER" >/dev/null 2>&1 || useradd --system --gid "$CHROME_USER" --home-dir "$CHROME_HOME" --create-home --shell /usr/sbin/nologin "$CHROME_USER"
install -d -m 700 -o "$CHROME_USER" -g "$CHROME_USER" "$CHROME_HOME" "$CHROME_HOME/profile"
# The server reads the browser's port from /run/sphere-chrome through this group.
if ! id -nG "$SPHERE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$CHROME_USER"; then
  usermod -aG "$CHROME_USER" "$SPHERE_USER"
fi
install -m 755 "$APP/deploy/chrome-port.sh" /usr/local/sbin/sphere-chrome-port
install -m 755 "$APP/deploy/chrome-firewall.sh" /usr/local/sbin/sphere-chrome-firewall

# Hardening that leaves Chrome's own sandbox working. Chrome sandboxes its renderers in user
# namespaces, which this kernel allows only to programs AppArmor names (/etc/apparmor.d/chrome).
# NoNewPrivileges would keep the exec from moving Chrome into that profile, so it's left off, and
# so is every setting that implies it for a service with User= (SystemCallFilter, RestrictNamespaces,
# PrivateDevices, ProtectKernelTunables, ProtectKernelModules, ProtectKernelLogs, ProtectClock,
# MemoryDenyWriteExecute, RestrictRealtime, RestrictSUIDSGID, LockPersonality, RestrictAddressFamilies).
# CapabilityBoundingSet is left alone too: the sandbox needs capabilities inside its namespaces.
unit="$(cat <<EOF
[Unit]
Description=Chrome for Dyson Sphere's browser cards
After=network-online.target
Wants=network-online.target
Before=sphere-server.service

[Service]
User=$CHROME_USER
Group=$CHROME_USER
Environment=HOME=$CHROME_HOME
# Only the server's user (and this service's own, for the hand-off below) may connect to the
# debugging port; as root (+), before Chrome listens.
ExecStartPre=+/usr/local/sbin/sphere-chrome-firewall $CHROME_PORT $SPHERE_USER $CHROME_USER
# The debugging port listens on 127.0.0.1 only (headless Chrome's default).
ExecStart=$CHROME --headless=new --remote-debugging-port=$CHROME_PORT --user-data-dir=$CHROME_HOME/profile --no-first-run --no-default-browser-check --window-size=1280,800 --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows --force-device-scale-factor=2 about:blank
# The port, and the browser's path, where the server reads them (fresh each run: systemd makes the
# folder anew).
ExecStartPost=/usr/local/sbin/sphere-chrome-port $CHROME_PORT /run/sphere-chrome
RuntimeDirectory=sphere-chrome
RuntimeDirectoryMode=0750
Restart=always
RestartSec=2
UMask=0077
ProtectSystem=strict
ReadWritePaths=$CHROME_HOME
ProtectHome=true
PrivateTmp=true
InaccessiblePaths=-$ETC
ProtectControlGroups=true
MemoryMax=4G
TasksMax=1024

[Install]
WantedBy=multi-user.target
EOF
)"
if [ ! -f "$UNIT" ] || [ "$(cat "$UNIT")" != "$unit" ]; then
  printf '%s\n' "$unit" > "$UNIT"
  systemctl daemon-reload
  systemctl enable sphere-chrome >/dev/null
  systemctl restart sphere-chrome
else
  systemctl enable sphere-chrome >/dev/null
  systemctl is-active --quiet sphere-chrome || systemctl restart sphere-chrome
fi

# The server finds the browser's port here.
if [ -f "$ETC/env" ] && ! grep -q '^SPHERE_BROWSER_PROFILE=' "$ETC/env"; then
  echo 'SPHERE_BROWSER_PROFILE=/run/sphere-chrome' >> "$ETC/env"
fi

for _ in $(seq 1 30); do
  [ -s /run/sphere-chrome/DevToolsActivePort ] && break
  sleep 1
done
if [ -s /run/sphere-chrome/DevToolsActivePort ] && nft list table inet sphere_chrome >/dev/null 2>&1; then
  echo "sphere-chrome is up, its debugging port on 127.0.0.1:$(head -n1 /run/sphere-chrome/DevToolsActivePort), open to $SPHERE_USER only"
else
  echo "sphere-chrome didn't start; see: journalctl -u sphere-chrome -n 50" >&2
  exit 1
fi
