# Changes

## Live propagation between nodes (fix)
`@chainsafe/libp2p-gossipsub` 14 targets libp2p 2, but the node runs libp2p 3:
peers connected and synced stored objects on connect, but new objects never
spread live between nodes. Replaced with `@libp2p/gossipsub` 17 (libp2p 3).
Objects posted to one node now reach its peers within seconds.

## Bootnodes
- `AON_ANNOUNCE`: public addresses to advertise (e.g. `/dns4/node1.example.org/tcp/9000`).
  Previously a node advertised only its interface IPs, which behind NAT or on
  many cloud hosts are private, so peers couldn't dial it back.
- A node drops its own entry from `AON_BOOTSTRAP`, so all nodes can share one list.

## Explorer
- Every node serves the explorer at `/` (`explorer/index.html`), in the
  original explorer's style, using only that node's read API:
  - Tabs by object type, rows that expand into the object's graph or raw JSON,
    hash search and `?hash=0x…` links (same as before).
  - A Network tab with this node's peers, namespaces and the bootnode list
    (copyable as `AON_BOOTSTRAP`).
  - Live refresh.
- EIP-712 signatures are checked in the browser. Objects with an invalid
  signature are hidden, with a count and a "show" toggle. Only the namespaces
  in `AON_EXPLORER_NAMESPACES` are listed by default, with a "show all"
  toggle. Spam stays out of view, visibly rather than silently.
- No third-party scripts: the signature checker is bundled from the node's own
  pinned viem (`npm run build:explorer` → `explorer/verify.js`) and served by
  the node. The old explorer loaded React, Babel and ethers from CDNs at
  floating versions. Untrusted object data is rendered as text only, under a
  strict Content-Security-Policy.
- New read-only endpoints: `GET /v1/stats`, `GET /v1/network`.
  `GET /v1/objects` accepts comma-separated `namespace` / `objectType` lists.
- `GET /v1/graphs/:hash` and `/v1/graph/walk/:hash` cap `maxObjects` at 1000
  (it was unbounded, so one request could walk the whole store).

## Security
- `POST /v1/p2p/*` (dial, sync, push, gossip, exchange, request-object) only
  answer the local machine by default, and refuse requests relayed by a
  reverse proxy. These made the node dial arbitrary addresses or do work for
  anyone. `AON_ADMIN_OPEN=true` restores the old behaviour.
- Request logging is off by default (`AON_LOG_REQUESTS=true` to enable).

## Other
- `npm start` uses `node --import tsx` (`--loader tsx` fails on current Node).
- `package-lock.json` was out of sync with `package.json` (`npm ci` failed); regenerated.
