#!/usr/bin/env bash
# Point this node at the network's bootnodes. Same list on every server; a
# node skips itself. Give full addresses or just domains (each domain's
# peer ID is looked up at https://<domain>/v1/network):
#
#   /opt/aon/deploy/set-bootnodes.sh node1.aon.network node2.aon.network node3.aon.network
#   /opt/aon/deploy/set-bootnodes.sh /dns4/node1.aon.network/tcp/9000/p2p/12D3Koo...
#
# --if-changed  only restart the node when the list actually changed (used by
#               the aon-peers timer that install.sh --peers sets up)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
IF_CHANGED=0
if [ "${1:-}" = "--if-changed" ]; then IF_CHANGED=1; shift; fi
[ $# -ge 1 ] || { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
if [ $# = 1 ] && [ -f "$1" ]; then mapfile -t ARGS < <(grep -v '^\s*$' "$1" | tr -d '\r'); else ARGS=("$@"); fi

ADDRS=(); MISSING=()
for a in "${ARGS[@]}"; do
  if [[ "$a" == /* ]]; then
    [[ "$a" =~ ^/(dns4|ip4|dns6|ip6)/[^/]+/tcp/[0-9]+/p2p/12D3Koo[1-9A-HJ-NP-Za-km-z]{40,}$ ]] || { echo "Not a bootnode address: $a"; exit 1; }
    ADDRS+=("$a")
  else
    host="${a%%:*}"; port=9000; [[ "$a" == *:* ]] && port="${a##*:}"
    [[ "$host" =~ ^[A-Za-z0-9.-]+$ && "$port" =~ ^[0-9]+$ ]] || { echo "Not a domain: $a"; exit 1; }
    id=$(curl -fsS --max-time 8 "https://$host/v1/network" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["network"]["peerId"] or "")' 2>/dev/null || true)
    if [[ "$id" =~ ^12D3Koo[1-9A-HJ-NP-Za-km-z]{40,}$ ]]; then ADDRS+=("/dns4/$host/tcp/$port/p2p/$id"); else MISSING+=("$host"); fi
  fi
done
[ ${#MISSING[@]} = 0 ] || echo "Not reachable yet (will connect once they're up): ${MISSING[*]}"
[ ${#ADDRS[@]} -gt 0 ] || { echo "No bootnodes found yet."; exit 0; }

LIST=$(IFS=,; echo "${ADDRS[*]}")
ENV=/etc/aon/aon.env
PORT=$(grep -E "^AON_PORT=" /etc/aon/aon.env 2>/dev/null | cut -d= -f2); PORT=${PORT:-8787}
CURRENT=$(grep -E '^AON_BOOTSTRAP=' "$ENV" | cut -d= -f2-)
if [ "$IF_CHANGED" = 1 ] && [ "$CURRENT" = "$LIST" ]; then exit 0; fi
sed -i -E "s#^AON_BOOTSTRAP=.*#AON_BOOTSTRAP=$LIST#; s#^AON_PUBLIC_BOOTNODES=.*#AON_PUBLIC_BOOTNODES=$LIST#" "$ENV"
systemctl restart aon
echo "Bootnodes: ${#ADDRS[@]}. Restarted; waiting for peers..."
n=0
for _ in $(seq 1 30); do
  n=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/v1/network" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["network"]["peers"]))' 2>/dev/null || echo 0)
  [ "$n" -ge $(( ${#ADDRS[@]} - 1 )) ] && break; sleep 1
done
echo "Connected peers: $n"
