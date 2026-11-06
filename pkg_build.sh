#!/bin/bash
# Builds the Slackware package from source/ and updates version + MD5 in the .plg
# Usage: ./pkg_build.sh [version]   (default: today's date, e.g. 2026.11.06)
set -euo pipefail
cd "$(dirname "$0")"
NAME=dashboard.hub
VERSION=${1:-$(date +%Y.%m.%d)}
PKG="$NAME-$VERSION-x86_64-1.txz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/usr/local/emhttp/plugins"
cp -r "source/$NAME" "$TMP/usr/local/emhttp/plugins/$NAME"
find "$TMP" -type d -exec chmod 755 {} +
find "$TMP" -type f -exec chmod 644 {} +

mkdir -p archive
tar --sort=name --owner=root --group=root --numeric-owner --mtime="@$(date +%s)" \
    -C "$TMP" -cJf "archive/$PKG" usr
MD5=$(md5sum "archive/$PKG" | cut -d' ' -f1)

sed -i -E -e "s|(<!ENTITY version +)\"[^\"]*\">|\1\"$VERSION\">|" \
          -e "s|(<!ENTITY md5 +)\"[^\"]*\">|\1\"$MD5\">|" "$NAME.plg"
echo "archive/$PKG  md5=$MD5"
