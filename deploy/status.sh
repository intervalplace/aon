#!/usr/bin/env bash
# Quick health check of the node on this server.
set -uo pipefail
J=$(curl -s --noproxy '*' http://127.0.0.1:8787/v1/network) || { echo "Node not answering. See: journalctl -u aon -n 50"; exit 1; }
S=$(curl -s --noproxy '*' http://127.0.0.1:8787/v1/stats)
G=$(curl -s --noproxy '*' http://127.0.0.1:8787/v1/p2p/pubsub)
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
[ -f /etc/aon/peers ] && echo "Peer list   $(paste -sd' ' /etc/aon/peers) (auto-connect every 2 min)"
true
