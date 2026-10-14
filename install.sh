#!/usr/bin/env bash
# Sets up Dyson Sphere for one person on one machine (a laptop, or their user on the
# server), from a checkout of 80k-coding-tools:
#
#   dyson-sphere/install.sh --url wss://sphere.example.ts.net/ws --token sph_...
#
# - builds the `sphere` CLI into ~/.sphere/bin (where the mod looks for it) and links it
#   into ~/.local/bin
# - writes ~/.sphere/config.json with the server's address and your token
# - installs the mod into Claude Code from this checkout, so every session reports
# - if Codex is installed, adds Dyson Sphere's hooks to ~/.codex/hooks.json and trusts them
# - checks that the server answers
#
# Run it again after `git pull` to update; --url and --token can then be left out.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SPHERE_HOME="${SPHERE_HOME:-$HOME/.sphere}"
URL=""
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# --- requirements ---
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    say "Installing Bun"
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "couldn't install Bun: see https://bun.sh"
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
command -v claude >/dev/null 2>&1 || die "Claude Code isn't installed: https://docs.claude.com/en/docs/claude-code"
CLAUDE_VERSION="$(claude --version | awk '{print $1}')"
# The mod needs the function-hook API from 2.1.287.
if [ "$(printf '%s\n2.1.287\n' "$CLAUDE_VERSION" | sort -V | head -1)" != "2.1.287" ]; then
  die "Claude Code $CLAUDE_VERSION is too old; 2.1.287 or newer is needed (claude update)"
fi

# --- the CLI, built on this machine for this machine ---
say "Building the sphere CLI"
# On the server the checkout is shared and belongs to root, who installs its dependencies.
if [ -O "$ROOT" ]; then (cd "$ROOT" && bun install --frozen-lockfile >/dev/null); fi
mkdir -p "$SPHERE_HOME/bin"
chmod 700 "$SPHERE_HOME"
# Built in SPHERE_HOME (bun leaves temporary files in the working directory), beside the
# target and then renamed: a running bridge keeps its old binary.
(cd "$SPHERE_HOME" && bun build --compile "$ROOT/sphere/src/cli.ts" --outfile "$SPHERE_HOME/bin/sphere.new" >/dev/null && rm -f .*.bun-build)
mv -f "$SPHERE_HOME/bin/sphere.new" "$SPHERE_HOME/bin/sphere"
mkdir -p "$HOME/.local/bin"
ln -sf "$SPHERE_HOME/bin/sphere" "$HOME/.local/bin/sphere"

# --- config ---
CONFIG="$SPHERE_HOME/config.json"
if [ -n "$URL" ] || [ -n "$TOKEN" ]; then
  [ -n "$URL" ] && [ -n "$TOKEN" ] || die "pass both --url and --token"
  [ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.bak"
  umask 077
  printf '{"url": "%s", "token": "%s"}\n' "$URL" "$TOKEN" > "$CONFIG"
  umask 022
elif [ ! -f "$CONFIG" ]; then
  die "no $CONFIG yet: pass --url and --token (ask whoever runs the server for a token)"
fi

# --- the mod ---
say "Installing the mod into Claude Code"
if claude plugin marketplace list 2>/dev/null | grep -q 'dyson-sphere'; then
  claude plugin marketplace update dyson-sphere >/dev/null
else
  claude plugin marketplace add "$ROOT" >/dev/null
fi
if claude plugin list 2>/dev/null | grep -q 'sphere@dyson-sphere'; then
  claude plugin update sphere@dyson-sphere >/dev/null
else
  claude plugin install sphere@dyson-sphere >/dev/null
fi

# --- Codex hooks ---
# Codex sessions report through hooks (sphere/src/codex.ts). Ours are added beside any others
# without moving them, and trusted the way Codex's /hooks does. Nothing here can fail the install:
# without the hooks, Codex works as before.
if command -v codex >/dev/null 2>&1; then
  say "Adding Dyson Sphere's hooks to Codex"
  "$SPHERE_HOME/bin/sphere" codex-install </dev/null \
    || echo "Couldn't add the Codex hooks; Codex works as before. Run install.sh again to retry."
fi

# --- check ---
say "Checking the server"
if "$SPHERE_HOME/bin/sphere" status >/dev/null; then
  echo "Connected to $(sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "$CONFIG")."
else
  echo "The server didn't answer. Check the URL and token in $CONFIG; your sessions will report once it does."
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use the sphere command." ;; esac
echo "Done. New Claude Code sessions report to Dyson Sphere; restart running ones to include them."
