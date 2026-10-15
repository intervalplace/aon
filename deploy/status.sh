#!/usr/bin/env bash
# Quick health check of the node on this server.
set -uo pipefail
PORT=$(grep -E "^AON_PORT=" /etc/aon/aon.env 2>/dev/null | cut -d= -f2); PORT=${PORT:-8787}
J=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/v1/network") || { echo "Node not answering. See: journalctl -u aon -n 50"; exit 1; }
S=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/v1/stats")
G=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/v1/p2p/pubsub")
python3 - "$J" "$S" "$G" <<'PY'
import json, sys
n = json.loads(sys.argv[1])["network"]; s = json.loads(sys.argv[2])["stats"]; g = json.loads(sys.argv[3])["pubsub"]
print(f"Node        {n.get('name') or '-'}")
print(f"Peer ID     {n['peerId']}")
print(f"Address     {next((a for a in n['addrs'] if '/dns4/' in a or ('/ip4/' in a and '/ip4/127.' not in a)), '-')}")
print(f"Peers       {len(n['peers'])} connected, {len(g.get('subscribers', []))} on gossip")
print(f"Objects     {s['total']}  " + ", ".join(f"{x['key']}: {x['count']}" for x in s['namespaces'][:6]))
print(f"Bootnodes   {len(n['bootnodes'])} configured")
PY
(systemctl is-active --quiet caddy 2>/dev/null && echo "HTTPS       caddy running ($(grep -m1 -oE '^[a-z0-9.-]+\.[a-z]+' /etc/caddy/Caddyfile 2>/dev/null || true))") || true
if [ -f /etc/aon/peers ]; then
  echo "Peer list   (checked every 2 min)"
  MYIP=$(curl -s -4 --max-time 5 https://api.ipify.org || true)
  SELF=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["network"]["peerId"])' "$J")
  while read -r d; do
    [ -n "$d" ] || continue
    ip=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')
    id=$(curl -fsS --max-time 8 "https://$d/v1/network" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["network"]["peerId"])' 2>/dev/null || true)
    if [ -z "$ip" ]; then msg="no DNS record"
    elif [ -z "$id" ]; then msg="DNS -> $ip, no answer over HTTPS (not installed there yet, certificate pending, or firewall)"
    elif [ "$id" = "$SELF" ]; then msg="this node ($ip)"
    else msg="ok ($ip, ${id:0:20}...)"; fi
    if [ -n "$MYIP" ] && [ "$ip" = "$MYIP" ] && [ -n "$id" ] && [ "$id" != "$SELF" ]; then msg="$msg  <- points at this server but a different node answers"; fi
    printf "  %-22s %s\n" "$d" "$msg"
  done < /etc/aon/peers
fi
true
