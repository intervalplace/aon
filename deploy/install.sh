#!/usr/bin/env bash
# AON node installer (Ubuntu 22.04/24.04, Debian 12). As root:
#
#   git clone https://github.com/intervalplace/aon /opt/aon
#   /opt/aon/deploy/install.sh --name node1 --domain node1.aon.network \
#        [--peers node2.aon.network,node3.aon.network] \
#        [--alias explorer.aon.network] [--site covenant.market,www.covenant.market=/var/www/covenant]
#        [--proxy example.org,www.example.org=127.0.0.1:3000] [--http-port 8790] [--no-firewall]
#
# --peers: the other nodes' domains. The node connects to them by itself as
# soon as they're up (checked every 2 minutes), in any install order.
# --proxy: keep serving another app on this server through Caddy (HTTPS).
# --http-port: the node's local API port (default 8787) if another app uses it.
# --no-firewall: don't touch the firewall at all. Without it, the installer
#   only adds AON's ports to a firewall that is already on; it never turns one on.
#
# Sets up: Node.js 22, the node as a systemd service (aon) running from this
# clone, Caddy for HTTPS (API + explorer on the domain), and the firewall.
# Safe to re-run. Updates: /opt/aon/deploy/update.sh
set -euo pipefail

NAME=""; DOMAIN=""; ALIASES=(); SITES=(); PROXIES=(); PEERS=""; P2P_PORT=9000; HTTP_PORT=8787; FIREWALL=1
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --alias) ALIASES+=("$2"); shift 2 ;;
    --site) SITES+=("$2"); shift 2 ;;
    --peers) PEERS="$2"; shift 2 ;;
    --proxy) PROXIES+=("$2"); shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    --p2p-port) P2P_PORT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done
[ -n "$NAME" ] && [ -n "$DOMAIN" ] || usage
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO/src/server.ts" ] || { echo "Can't find the node code next to this script ($REPO)."; exit 1; }
case "$REPO" in /root/*|/home/*)
  echo "The node runs as its own user and can't read $REPO. Clone the repo to /opt/aon instead:"
  echo "  git clone https://github.com/intervalplace/aon /opt/aon && /opt/aon/deploy/install.sh ..."; exit 1 ;;
esac
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ── 0. Ports must be free (an old node or web server would block them) ─────
say "Checking ports"
busy=""
for p in 80 443 "$HTTP_PORT" "$P2P_PORT"; do
  if ss -ltnH "( sport = :$p )" 2>/dev/null | grep -q .; then
    owner=$(ss -ltnpH "( sport = :$p )" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//; s/"//')
    # A previous run of this script is fine
    if [ "$p" = "$HTTP_PORT" ] || [ "$p" = "$P2P_PORT" ]; then systemctl is-active --quiet aon && continue; fi
    if [ "$p" = 80 ] || [ "$p" = 443 ]; then [ "$owner" = caddy ] && continue; fi
    busy="$busy\n  port $p is used by: ${owner:-unknown}"
  fi
done
if [ -n "$busy" ]; then
  printf "These ports are already in use:$busy\n\n"
  echo "Stop whatever is using them first (e.g. an old AON node or nginx: 'systemctl stop nginx',"
  echo "or 'pm2 stop all' / Ctrl+C on a node started by hand), then run this again."
  exit 1
fi
echo "ok"

# ── 1. Packages ─────────────────────────────────────────────────────────────
say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw build-essential python3 >/dev/null

# One Node.js (22+) for everything: the dependencies are built with it and
# the service runs it. A system install is used if it's new enough (not one
# under /root or /home, which the service user can't read). If the server
# already has an older Node.js for other apps, a separate Node 22 goes into
# /opt/node22 and the system one is left alone.
pick_node() {
  for n in /opt/node22/bin/node /usr/bin/node /usr/local/bin/node; do
    [ -x "$n" ] && [ -x "$(dirname "$n")/npm" ] || continue
    [ "$("$n" -p 'process.versions.node.split(".")[0]')" -ge 22 ] && { echo "$n"; return 0; }
  done
  return 1
}
private_node22() {
  local a base sums file sum
  case "$(uname -m)" in x86_64) a=x64 ;; aarch64|arm64) a=arm64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
  apt-get install -y -qq xz-utils >/dev/null
  base=https://nodejs.org/dist/latest-v22.x
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  file=$(awk -v s="-linux-$a.tar.xz" 'substr($2, length($2)-length(s)+1) == s {print $2; exit}' <<<"$sums")
  sum=$(awk -v f="$file" '$2 == f {print $1}' <<<"$sums")
  [ -n "$file" ] && [ -n "$sum" ] || { echo "Couldn't find Node 22 for linux-$a"; exit 1; }
  curl -fsSL -o "/tmp/$file" "$base/$file"
  echo "$sum  /tmp/$file" | sha256sum -c --quiet - || { echo "Node download failed its checksum"; exit 1; }
  rm -rf /opt/node22 && mkdir -p /opt/node22 && tar -xJf "/tmp/$file" -C /opt/node22 --strip-components=1 && rm -f "/tmp/$file"
}
NODE_BIN=$(pick_node || true)
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null || [ -x /usr/bin/node ]; then
    echo "This server has Node.js $(node -v 2>/dev/null || /usr/bin/node -v) for other apps; installing a separate Node 22 in /opt/node22"
    private_node22
  else
    echo "Installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  NODE_BIN=$(pick_node) || { echo "Couldn't set up Node.js 22."; exit 1; }
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "node $("$NODE_BIN" -v) at $NODE_BIN"

if ! command -v caddy >/dev/null; then
  echo "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "caddy $(caddy version | cut -d' ' -f1)"

# ── 2. The node ─────────────────────────────────────────────────────────────
say "Installing the AON node"
id aon >/dev/null 2>&1 || useradd --system --home /var/lib/aon --shell /usr/sbin/nologin aon
mkdir -p /var/lib/aon /etc/aon
chown -R aon:aon /var/lib/aon
# The code stays where it was cloned (owned by root, readable by the node)
(cd "$REPO" && rm -rf node_modules && npm ci --omit=optional --no-audit --no-fund --loglevel=error)
chmod -R a+rX "$REPO"

ENV=/etc/aon/aon.env
if [ ! -f "$ENV" ]; then
  cat > "$ENV" <<EOF
AON_NODE_NAME=$NAME
AON_PORT=$HTTP_PORT
AON_P2P_PORT=$P2P_PORT
AON_ANNOUNCE=/dns4/$DOMAIN/tcp/$P2P_PORT
AON_DATA_DIR=/var/lib/aon
AON_PEER_KEY_PATH=/var/lib/aon/peer.key
AON_WS=false
AON_MAX_PEERS=100
# Filled in by set-bootnodes.sh
AON_BOOTSTRAP=
AON_PUBLIC_BOOTNODES=
EOF
else
  # Re-run: take the name, domain and port from this run (identity, data and
  # bootnodes are kept)
  sed -i -E "s#^AON_NODE_NAME=.*#AON_NODE_NAME=$NAME#; s#^AON_PORT=.*#AON_PORT=$HTTP_PORT#; s#^AON_P2P_PORT=.*#AON_P2P_PORT=$P2P_PORT#; s#^AON_ANNOUNCE=.*#AON_ANNOUNCE=/dns4/$DOMAIN/tcp/$P2P_PORT#" "$ENV"
fi
chmod 640 "$ENV"; chown root:aon "$ENV"

cat > /etc/systemd/system/aon.service <<'EOF'
[Unit]
Description=AON node
After=network-online.target
Wants=network-online.target

[Service]
User=aon
Group=aon
WorkingDirectory=__REPO__
EnvironmentFile=/etc/aon/aon.env
ExecStart=__NODE__ --import tsx src/server.ts
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/aon
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sed -i "s#__REPO__#$REPO#; s#__NODE__#$NODE_BIN#" /etc/systemd/system/aon.service
systemctl daemon-reload
systemctl enable aon >/dev/null 2>&1
systemctl restart aon

# ── 3. HTTPS (Caddy) ────────────────────────────────────────────────────────
say "Configuring HTTPS"
HOSTS="$DOMAIN"; for a in "${ALIASES[@]}"; do HOSTS="$HOSTS, $a"; done
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "Managed by aon" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-aon.$(date +%s)"
  echo "Saved the existing Caddyfile next to it (.before-aon.*)"
fi
{
  cat <<EOF
# Managed by aon/deploy/install.sh
$HOSTS {
	encode zstd gzip
	request_body {
		max_size 1MB
	}
	# Node control endpoints are local only
	@admin {
		path /v1/p2p/*
		not method GET HEAD OPTIONS
	}
	respond @admin "local only" 403
	reverse_proxy 127.0.0.1:$HTTP_PORT
}
EOF
  for p in "${PROXIES[@]}"; do
    phosts="${p%%=*}"; upstream="${p#*=}"
    cat <<EOF

${phosts//,/, } {
	encode zstd gzip
	reverse_proxy $upstream
}
EOF
  done
  for s in "${SITES[@]}"; do
    host="${s%%=*}"; host="${host//,/, }"; dir="${s#*=}"
    mkdir -p "$dir"
    [ -n "$(ls -A "$dir" 2>/dev/null)" ] || echo "<!doctype html><title>$host</title><p>Coming soon." > "$dir/index.html"
    cat <<EOF

$host {
	encode zstd gzip
	root * $dir
	try_files {path} {path}/index.html {path}.html
	file_server
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
	handle_errors 404 {
		rewrite * /404.html
		file_server
	}
}
EOF
  done
} > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ── 4. Firewall ─────────────────────────────────────────────────────────────
say "Firewall"
# Never close anything that was reachable before: if the firewall is off, it
# stays off (other apps on this server may depend on that). If it's on, only
# the ports AON needs are added to it.
if [ "$FIREWALL" = 1 ] && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow "$P2P_PORT"/tcp >/dev/null
  echo "Firewall is on; opened 80, 443, $P2P_PORT/tcp for AON ($HTTP_PORT stays private behind Caddy)."
  echo "If your provider also has a cloud firewall, open the same ports there."
else
  echo "Firewall left as it is. Peers need port $P2P_PORT/tcp reachable (and 80/443 for HTTPS)."
fi

# ── 5. Peers (find the other nodes by domain, keep checking) ────────────────
if [ -n "$PEERS" ]; then
  say "Peers"
  { echo "$DOMAIN"; tr ',' '\n' <<<"$PEERS"; } | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort -u > /etc/aon/peers
  cat > /etc/systemd/system/aon-peers.service <<UNIT
[Unit]
Description=Connect the AON node to its peers (by domain)
After=aon.service

[Service]
Type=oneshot
ExecStart=$REPO/deploy/set-bootnodes.sh --if-changed /etc/aon/peers
UNIT
  cat > /etc/systemd/system/aon-peers.timer <<'UNIT'
[Unit]
Description=Check the AON node's peers every 2 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now aon-peers.timer >/dev/null 2>&1
  echo "Peers: $(paste -sd' ' /etc/aon/peers). Connecting automatically as each comes online."
fi

# ── 6. Result ───────────────────────────────────────────────────────────────
say "Waiting for the node"
PEER=""
for _ in $(seq 1 30); do
  PEER=$(curl -s --noproxy '*' "http://127.0.0.1:$HTTP_PORT/v1/network" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["network"]["peerId"] or "")' 2>/dev/null || true)
  [ -n "$PEER" ] && break; sleep 1
done
[ -n "$PEER" ] || { echo "The node didn't start. See: journalctl -u aon -n 50"; exit 1; }
ADDR="/dns4/$DOMAIN/tcp/$P2P_PORT/p2p/$PEER"
echo "$ADDR" > /etc/aon/bootnode.txt

MYIP=$(curl -s -4 --max-time 5 https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)

cat <<EOF

────────────────────────────────────────────────────────────
 $NAME is running.

 Bootnode address (copy this):
   $ADDR

 Explorer and API:  https://$DOMAIN
EOF
for a in "${ALIASES[@]}"; do echo "                    https://$a"; done
for s in "${SITES[@]}"; do echo " Website:           https://${s%%=*}  (files in ${s#*=})"; done
for p in "${PROXIES[@]}"; do echo " Proxied:           https://${p%%=*} -> ${p#*=}"; done
if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
  echo
  echo " ⚠ DNS: $DOMAIN points to '${DNSIP:-nothing}', but this server is $MYIP."
  echo "   Add an A record: $DOMAIN -> $MYIP (and the same for any alias/site)."
  echo "   HTTPS starts working by itself once DNS is right."
fi
echo "────────────────────────────────────────────────────────────"
