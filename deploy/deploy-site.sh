#!/usr/bin/env bash
# Publish a static site build (a .zip or a folder) to a directory Caddy serves.
#
#   /opt/aon/deploy/deploy-site.sh covenant-site.zip /var/www/covenant
set -euo pipefail
SRC="${1:?Usage: sudo ./deploy-site.sh <site.zip|folder> /var/www/<site>}"; DIR="${2:?target directory}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
command -v unzip >/dev/null || apt-get install -y -qq unzip >/dev/null
NEW="$DIR.new.$$"; rm -rf "$NEW"; mkdir -p "$NEW"
if [ -d "$SRC" ]; then cp -a "$SRC"/. "$NEW"/; else unzip -q "$SRC" -d "$NEW"; fi
# A zip that contains a single top-level folder: use that folder
if [ ! -f "$NEW/index.html" ] && [ "$(ls -A "$NEW" | wc -l)" = 1 ] && [ -f "$NEW/$(ls -A "$NEW")/index.html" ]; then
  inner="$NEW/$(ls -A "$NEW")"; mv "$inner" "$NEW.x"; rm -rf "$NEW"; mv "$NEW.x" "$NEW"
fi
[ -f "$NEW/index.html" ] || { echo "No index.html in $SRC"; rm -rf "$NEW"; exit 1; }
chmod -R a+rX "$NEW"
# Swap in one step, keep the previous version for rollback
[ -d "$DIR" ] && rm -rf "$DIR.previous" && mv "$DIR" "$DIR.previous"
mv "$NEW" "$DIR"
echo "Published $(find "$DIR" -type f | wc -l) files to $DIR (previous version in $DIR.previous)"
