#!/bin/sh
# sphere-chrome's ExecStartPost (deploy/chrome.sh): once Chrome answers on its debugging port,
# writes that port and its browser target's path where the server reads them, as Chrome's own
# DevToolsActivePort would say (Chrome writes one only for a port it picks itself), so the server
# never needs the profile (cookies, history and all).
#
#   sphere-chrome-port <port> <run dir>
#
# The listener must be this service's own: a process that took the port first would otherwise be
# trusted as the browser. `ss` names the process behind a socket only to its owner, so a listener
# it names is ours.
set -eu
port="$1"
dst="$2/DevToolsActivePort"
case "$port" in '' | *[!0-9]*) echo "not a port: $port" >&2; exit 1 ;; esac
i=0
path=""
while [ -z "$path" ]; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    echo "Chrome didn't answer on 127.0.0.1:$port within 30 seconds" >&2
    exit 1
  fi
  sleep 0.1
  path="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/json/version" 2>/dev/null | sed -n 's|.*"webSocketDebuggerUrl": *"ws://[^/]*\(/devtools/browser/[^"]*\)".*|\1|p' || true)"
done
if ! ss -Hltnp "sport = :$port" | grep -q 'users:(("chrome'; then
  echo "something other than this service's Chrome listens on 127.0.0.1:$port" >&2
  exit 1
fi
printf '%s\n%s\n' "$port" "$path" > "$dst.tmp"
chmod 0640 "$dst.tmp"
mv "$dst.tmp" "$dst"
