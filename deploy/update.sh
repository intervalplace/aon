#!/usr/bin/env bash
# Update this node to the latest code from GitHub and restart it.
#   /opt/aon/deploy/update.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
# Build with the same Node.js the service runs
NODE_BIN=$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' /etc/systemd/system/aon.service)
[ -x "$NODE_BIN" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"
before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)
npm ci --omit=optional --no-audit --no-fund --loglevel=error
chmod -R a+rX "$REPO"
systemctl restart aon
echo "Updated $before -> $after. Restarted."
sleep 5; "$REPO/deploy/status.sh"
