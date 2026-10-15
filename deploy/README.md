# Running a public AON node

One command turns a fresh Ubuntu/Debian server into a public node. It sets
up the node as a service, HTTPS for its API and explorer (Caddy), and a
firewall. Run as root:

```bash
apt-get install -y git
git clone https://github.com/intervalplace/aon /opt/aon
/opt/aon/deploy/install.sh --name node1 --domain node1.example.org
```

Point the domain's DNS (an A record) at the server first, or soon after:
HTTPS starts as soon as it resolves. Options:
- `--alias other.example.org` also serves the node and explorer on another name.
- `--site example.com=/var/www/example` also serves a static website from that folder.

The installer prints this node's **bootnode address**. To join a network, or
to link several nodes into one, give every node the same list:

```bash
/opt/aon/deploy/set-bootnodes.sh /dns4/node1.example.org/tcp/9000/p2p/12D3Koo... /dns4/node2.example.org/tcp/9000/p2p/12D3Koo...
```

| Script | What it does |
|---|---|
| `install.sh` | Installs and starts everything; prints the bootnode address. Safe to re-run. |
| `set-bootnodes.sh` | Sets the bootnode list and restarts. |
| `update.sh` | `git pull`, reinstall dependencies, restart. |
| `status.sh` | Peers, gossip, objects at a glance. |
| `migrate.sh <url>` | Copies every object from another node into this one. |
| `deploy-site.sh <zip-or-folder> <dir>` | Publishes a static site build for Caddy to serve. |

## What it sets up

- **Node:** systemd service `aon`, running from `/opt/aon`. Data and the
  identity key are in `/var/lib/aon`, settings in `/etc/aon/aon.env`.
  - Logs: `journalctl -u aon -f`.
  - Restart: `systemctl restart aon`.
- **Caddy:** HTTPS certificates automatically once DNS points here.
  - `https://<domain>/` is the explorer, and `/v1/...` is the API.
  - `POST /v1/p2p/*` (the node's control endpoints) is refused from outside.
  - Request bodies are capped at 1 MB.
- **Firewall (ufw):** SSH (whichever port sshd uses), 80, 443 and 9000/tcp
  are open. The node's own port 8787 is reachable only through Caddy.
- **Identity:** `/var/lib/aon/peer.key` decides the peer ID, which is part
  of the bootnode address. Back it up. If it's lost, the node gets a new ID
  and its bootnode address changes.
