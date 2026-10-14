#!/usr/bin/env bash
# Installs or updates Orca on the server, for everyone's `orca-ide serve`. Run as root:
#
#   deploy/install-orca.sh            the version below
#   deploy/install-orca.sh 1.4.230    another release
#
# It installs the .deb from Orca's GitHub release after checking it against the release's
# own checksum, so apt keeps track of it. Orca doesn't update itself from a .deb, and a
# headless `orca serve` has no updater, so updates happen here. Then give each person their
# Orca with deploy/add-orca.sh.
set -euo pipefail

VERSION="${1:-1.4.224}"
RELEASE="https://github.com/stablyai/orca/releases/download/v$VERSION"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
case "$(dpkg --print-architecture)" in
  amd64) DEB="orca-ide_${VERSION}_amd64.deb" MANIFEST=latest-linux.yml ;;
  arm64) DEB="orca-ide_${VERSION}_arm64.deb" MANIFEST=latest-linux-arm64.yml ;;
  *) echo "Orca has no .deb for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/manifest.yml" "$RELEASE/$MANIFEST"
curl -fsSL -o "$WORK/$DEB" "$RELEASE/$DEB"
# The manifest lists each file's sha512 in base64; compare it in hex, with coreutils only.
WANT="$(awk -v f="$DEB" '$0 ~ "url: "f"$" {getline; print $2; exit}' "$WORK/manifest.yml" |
  base64 -d | od -An -v -tx1 | tr -d ' \n' || true)"
GOT="$(sha512sum "$WORK/$DEB" | cut -d' ' -f1)"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "$DEB doesn't match the release's checksum" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
# Orca's .deb doesn't declare libasound2, which its Electron needs even without a window.
# add-orca.sh runs each person's display with xvfb and xauth, and loads its port rules
# with nftables (installing it leaves nftables.service disabled); qrencode shows phone
# pairing links as QR codes (orca-pair.sh).
apt-get install -y -qq --no-install-recommends "$WORK/$DEB" libasound2t64 xvfb xauth nftables qrencode >/dev/null
missing="$(ldd /opt/Orca/orca-ide | grep 'not found' || true)"
[ -z "$missing" ] || { echo "Orca is missing libraries:"; echo "$missing"; exit 1; } >&2
echo "Orca $(dpkg-query -W -f '${Version}' orca-ide) is installed: /usr/bin/orca-ide"

# A running serve keeps the old version until it restarts. Restarting keeps its terminals
# (they live in Orca's terminal daemon), but say so rather than restart people's Orca here.
for env in /home/*/.config/orca-serve/env; do
  [ -f "$env" ] || continue
  person="$(stat -c %U "$env")"
  echo "$person's Orca picks this up when restarted: systemctl --user -M $person@ restart orca-serve"
done
