#!/usr/bin/env bash
# Copies this checkout to the server and updates it there:
#
#   deploy/push.sh root@sphere-box            first time: then run deploy/provision.sh there
#   deploy/push.sh root@sphere-box --update   afterwards: restarts the server, updates everyone
#
# The server needs no access to GitHub: the code goes from here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${1:?usage: deploy/push.sh <user@host> [--update]}"
APP=/opt/dyson-sphere

ssh "$HOST" "mkdir -p $APP"
rsync -az --delete --no-owner --no-group \
  --exclude .git --exclude node_modules --exclude dist --exclude .sphere-dev \
  --exclude 'mod/.claude-plugin/types' --exclude '*.bun-build' \
  "$ROOT/" "$HOST:$APP/"
echo "Copied to $HOST:$APP"
if [ "${2:-}" = --update ]; then
  ssh "$HOST" "$APP/deploy/update.sh"
fi
