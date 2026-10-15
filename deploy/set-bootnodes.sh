#!/usr/bin/env bash
# Point this node at the bootnodes (run on every server, same list everywhere):
#
#   /opt/aon/deploy/set-bootnodes.sh /dns4/node1.aon.network/tcp/9000/p2p/12D3Koo... /dns4/node2... ...
#   /opt/aon/deploy/set-bootnodes.sh bootnodes.txt      # or a file with one address per line
#
# Including this node's own address is fine: a node skips itself.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ $# -ge 1 ] || { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
if [ $# = 1 ] && [ -f "$1" ]; then mapfile -t ADDRS < <(grep -v '^\s*$' "$1" | tr -d '\r'); else ADDRS=("$@"); fi
for a in "${ADDRS[@]}"; do
  [[ "$a" =~ ^/(dns4|ip4|dns6|ip6)/[^/]+/tcp/[0-9]+/p2p/12D3Koo[1-9A-HJ-NP-Za-km-z]{40,}$ ]] || { echo "Not a bootnode address: $a"; exit 1; }
done
LIST=$(IFS=,; echo "${ADDRS[*]}")
ENV=/etc/aon/aon.env
sed -i -E "s#^AON_BOOTSTRAP=.*#AON_BOOTSTRAP=$LIST#; s#^AON_PUBLIC_BOOTNODES=.*#AON_PUBLIC_BOOTNODES=$LIST#" "$ENV"
systemctl restart aon
echo "Saved ${#ADDRS[@]} bootnodes. Restarted; waiting for peers..."
for _ in $(seq 1 30); do
  n=$(curl -s --noproxy '*' http://127.0.0.1:8787/v1/network 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["network"]["peers"]))' 2>/dev/null || echo 0)
  [ "$n" -ge $(( ${#ADDRS[@]} - 1 )) ] && break; sleep 1
done
echo "Connected peers: $n"
[ "$n" -gt 0 ] || echo "No peers yet. Check that the other servers are up and port 9000/tcp is open, then run /opt/aon/deploy/status.sh"
