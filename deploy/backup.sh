#!/usr/bin/env bash
# Dumps the Dyson Sphere database into a directory, keeps the last 14 dumps, and runs
# SPHERE_BACKUP_COMMAND (if set) with the new dump's path, to copy it off the server.
# Run by the sphere-backup timer; to back up now: systemctl start sphere-backup
set -euo pipefail

DIR="${1:?usage: sphere-backup <directory>}"
FILE="$DIR/sphere-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --file="$FILE.partial" "$DATABASE_URL"
mv "$FILE.partial" "$FILE"
echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"

ls -1t "$DIR"/sphere-*.dump | tail -n +15 | xargs -r rm --

if [ -n "${SPHERE_BACKUP_COMMAND:-}" ]; then
  bash -c "$SPHERE_BACKUP_COMMAND" sphere-backup "$FILE"
  echo "copied off the server"
else
  echo "warning: SPHERE_BACKUP_COMMAND is unset in /etc/sphere/backup.env, so this backup is on this server only" >&2
fi
