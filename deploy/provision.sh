#!/usr/bin/env bash
# Turns a fresh Ubuntu server (24.04 or 26.04) into a running Dyson Sphere. Run as root
# from the checkout, which `deploy/push.sh` copies to /opt/dyson-sphere:
#
#   /opt/dyson-sphere/deploy/provision.sh
#
# Safe to run again. It sets up:
# - Postgres, with a `sphere` database and role
# - a `sphere` system user, Bun, and the sphere-server systemd service: on 127.0.0.1:7420
#   for bridges and the CLI here, and on /run/sphere/web.sock for `tailscale serve`
# - /etc/sphere: the server's settings (env) and who may sign in (people.json)
# - nightly database backups to /var/backups/sphere, kept 14 days, plus an optional
#   command that copies each one off the server (/etc/sphere/backup.env)
# - Tailscale, and `tailscale serve` in front of the server once Tailscale is signed in
# - tmux, for Claude Code sessions people run here
# - Google Chrome and its `sphere-chrome` service, for browser cards (deploy/chrome.sh)
#
# Then add people with deploy/add-person.sh.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
SPHERE_USER=sphere
SPHERE_VAR=/var/lib/sphere
# Root owns Bun: root runs it here and in update.sh and add-person.sh, so the service
# account must not be able to replace it.
BUN_DIR=/opt/bun
BUN="$BUN_DIR/bin/bun"
ETC=/etc/sphere

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
[ "$ID" = ubuntu ] || echo "warning: tested on Ubuntu, this is $PRETTY_NAME" >&2

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql git tmux curl unzip ca-certificates python3 >/dev/null

say "The sphere user and Bun"
id "$SPHERE_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$SPHERE_VAR" --shell /usr/sbin/nologin "$SPHERE_USER"
if [ ! -x "$BUN" ]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$BUN_DIR" bash >/dev/null 2>&1
fi
chown -R root:root "$BUN_DIR"
chmod -R go-w "$BUN_DIR"
"$BUN" --version
# The checkout is shared: the service and every person's install.sh read it.
chown -R root:root "$APP"
chmod -R a+rX "$APP"
(cd "$APP" && "$BUN" install --frozen-lockfile >/dev/null)
chmod -R a+rX "$APP"

say "Postgres"
mkdir -p "$ETC"
if [ ! -f "$ETC/env" ]; then
  DB_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = 'sphere'" | grep -q 1; then
    sudo -u postgres psql -qc "alter role sphere password '$DB_PASSWORD'"
  else
    sudo -u postgres psql -qc "create role sphere login password '$DB_PASSWORD'"
  fi
  cat > "$ETC/env" <<EOF
NODE_ENV=production
SPHERE_AUTH=tailscale
SPHERE_PORT=7420
SPHERE_PEOPLE_FILE=$ETC/people.json
SPHERE_WEB_SOCKET=/run/sphere/web.sock
DATABASE_URL=postgres://sphere:$DB_PASSWORD@127.0.0.1:5432/sphere
EOF
fi
# Browsers come in through this socket only (see SPHERE_AUTH in server/src/main.ts).
grep -q '^SPHERE_WEB_SOCKET=' "$ETC/env" || echo 'SPHERE_WEB_SOCKET=/run/sphere/web.sock' >> "$ETC/env"
# Seals people's Linear tokens in the database (CS-2524): kept here, out of the database and its backups.
grep -q '^SPHERE_LINEAR_TOKEN_KEY=' "$ETC/env" || echo "SPHERE_LINEAR_TOKEN_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')" >> "$ETC/env"
sudo -u postgres psql -tAc "select 1 from pg_database where datname = 'sphere'" | grep -q 1 || sudo -u postgres createdb -O sphere sphere
[ -f "$ETC/people.json" ] || echo '{"people": []}' > "$ETC/people.json"
[ -f "$ETC/backup.env" ] || cat > "$ETC/backup.env" <<'EOF'
# A command that copies each nightly backup off this server. It runs with the dump's path
# as $1. Without one, backups stay on this server only, so a lost server loses them too.
# Examples:
#   SPHERE_BACKUP_COMMAND='rclone copy "$1" r2:sphere-backups/'
#   SPHERE_BACKUP_COMMAND='scp "$1" backup@other-host:sphere/'
SPHERE_BACKUP_COMMAND=
EOF
chown root:"$SPHERE_USER" "$ETC" "$ETC"/*
chmod 750 "$ETC"
chmod 640 "$ETC"/*

say "Chrome, for browser cards"
# A browser that won't start doesn't stop the rest: the server runs without browser cards.
"$APP/deploy/chrome.sh" || echo "warning: sphere-chrome isn't running, so browser cards are off; see: journalctl -u sphere-chrome -n 50" >&2

say "Services"
cat > /etc/systemd/system/sphere-server.service <<EOF
[Unit]
Description=Dyson Sphere server
After=network-online.target postgresql.service sphere-chrome.service
Wants=network-online.target sphere-chrome.service
Requires=postgresql.service

[Service]
User=$SPHERE_USER
WorkingDirectory=$APP
EnvironmentFile=$ETC/env
ExecStart=$BUN run server/src/main.ts
# /run/sphere holds the socket tailscale serve forwards to; no one else may open it.
RuntimeDirectory=sphere
RuntimeDirectoryMode=0750
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$SPHERE_VAR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

install -m 755 "$APP/deploy/backup.sh" /usr/local/sbin/sphere-backup
mkdir -p /var/backups/sphere
chown "$SPHERE_USER": /var/backups/sphere
chmod 700 /var/backups/sphere
cat > /etc/systemd/system/sphere-backup.service <<EOF
[Unit]
Description=Back up the Dyson Sphere database
Requires=postgresql.service
After=postgresql.service

[Service]
Type=oneshot
User=$SPHERE_USER
EnvironmentFile=$ETC/env
EnvironmentFile=$ETC/backup.env
ExecStart=/usr/local/sbin/sphere-backup /var/backups/sphere
EOF
cat > /etc/systemd/system/sphere-backup.timer <<EOF
[Unit]
Description=Back up the Dyson Sphere database nightly

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now sphere-backup.timer >/dev/null
systemctl enable sphere-server >/dev/null
systemctl restart sphere-server

for _ in $(seq 1 30); do
  curl -fs -o /dev/null http://127.0.0.1:7420/ && break
  sleep 1
done
if curl -fs -o /dev/null http://127.0.0.1:7420/; then
  echo "sphere-server is up on 127.0.0.1:7420"
else
  echo "sphere-server didn't start; see: journalctl -u sphere-server -n 50" >&2
  exit 1
fi

say "Tailscale"
command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
if tailscale status --json 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("BackendState") == "Running" else 1)'; then
  tailscale serve --bg unix:/run/sphere/web.sock >/dev/null
  echo "Serving at https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/"
else
  cat <<'EOF'
Tailscale isn't signed in yet. Sign in, with SSH so people can reach their sessions here,
then put the server behind it:

  tailscale up --ssh
  tailscale serve --bg unix:/run/sphere/web.sock

Then, so nothing but SSH and Tailscale is reachable from the internet:

  ufw allow OpenSSH && ufw allow in on tailscale0 && ufw --force enable
EOF
fi

say "Done"
echo "Add people with: $APP/deploy/add-person.sh <their login email>"
