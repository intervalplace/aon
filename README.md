# AON Node

A minimal, transport-agnostic node for the Authorization Object Network.

The node stores, indexes, and propagates content-addressed Authorization Objects across a peer-to-peer network. It has no knowledge of namespaces, execution logic, or what any object means. It does one thing: move objects faithfully between peers, the same way IP routes packets without understanding their contents.

## What it is

AON is a distributed object propagation network for authorized state transitions. Rather than embedding authorization inside institutions, applications, or intermediaries, AON externalizes authorization into independently addressable objects that can be discovered, verified, and consumed by any participant.

The node is the infrastructure layer. Everything above it, such as namespace logic, graph evaluation, and execution lives in [aon-sdk](https://github.com/intervalplace/aon-sdk).

## Architecture

```
src/
  server.ts              — HTTP API (15 endpoints)
  object.ts              — AonObject type, canonicalization, hashing
  store.ts               — Object storage and indexing
  graph.ts               — Inbound graph traversal
  refs.ts                — Reference index helpers
  transport.ts           — AonTransport interface
  transports/
    libp2p.ts            — TCP/IP transport (default implementation)
  polyfills.ts
  utils/canonical.ts
```

The node depends only on the `AonTransport` interface. The libp2p/TCP implementation is one transport, it is not the protocol. Alternative transports (LoRa, Bluetooth mesh, radio) implement the same interface and require no changes to the node.

## Object model

Every object is a content-addressed `AonObject`:

```ts
type AonObject = {
  objectType: "authorization" | "condition" | "proof" | "receipt" | "revocation" | ...;
  schemaVersion: "1";
  namespace: string;
  createdAt: number;
  creator?: string;
  references: string[];   // hashes of other objects this one depends on
  payload: Record<string, unknown>;
  objectHash?: string;    // keccak256 of canonical content, assigned on write
};
```

The node verifies hash integrity on every inbound object. It does not interpret `payload`. That is the namespace's responsibility.

## Running a node

```bash
npm install
cp .env.example .env   # configure as needed
npm run dev
```

The node starts on port `8787` by default and begins listening for peers.

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|---|---|---|
| `AON_PORT` | `8787` | HTTP API port |
| `AON_P2P_PORT` | `0` (random) | libp2p TCP listen port |
| `AON_BOOTSTRAP` | — | Comma-separated bootstrap peer multiaddrs |
| `AON_PEER_KEY_PATH` | — | Path to persist peer identity key |
| `AON_DATA_DIR` | `data` | Directory for object storage |
| `AON_PEX_INTERVAL_MS` | `30000` | Peer exchange interval |
| `AON_MAX_P2P_JSON_BYTES` | `1000000` | Max object size over p2p |
| `AON_SEEN_ANNOUNCEMENT_MAX` | `10000` | Announcement deduplication cache size |

To connect to existing nodes, set `AON_BOOTSTRAP` to a comma-separated list of multiaddrs:

```
AON_BOOTSTRAP=/ip4/1.2.3.4/tcp/9000/p2p/12D3KooW...
```

## API

### Objects

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/objects` | Submit an object |
| `GET` | `/v1/objects` | List objects (filter by `objectType`, `namespace`, `references`) |
| `GET` | `/v1/objects/:hash` | Fetch object by hash |
| `GET` | `/v1/objects/:hash/references` | Inbound references to this object |

### Graphs

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/graphs/:hash` | Assembled graph rooted at hash |
| `GET` | `/v1/graph/walk/:hash` | Inbound graph walk (params: `maxDepth`, `maxObjects`) |

### Transport

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/p2p/info` | Node identity and connected peers |
| `GET` | `/v1/p2p/pubsub` | Pubsub topic and subscriber info |
| `POST` | `/v1/p2p/dial` | Connect to a peer by multiaddr |
| `POST` | `/v1/p2p/request-object` | Request a specific object from a peer |
| `POST` | `/v1/p2p/gossip/:objectHash` | Announce an object to all peers |
| `POST` | `/v1/p2p/push/:objectHash` | Push an object to peers |
| `POST` | `/v1/p2p/exchange` | Exchange peer lists with a peer |

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Node health check |

## Adding a transport

Implement `AonTransport` from `src/transport.ts` and swap the instantiation in `server.ts`:

```ts
// src/transports/lora.ts
import type { AonTransport } from "../transport.js";

export class LoRaTransport implements AonTransport {
  // ... implement the interface
}
```

```ts
// src/server.ts — change these two lines only
import { LoRaTransport } from "./transports/lora.js";
const transport: AonTransport = new LoRaTransport();
```

The node code changes nothing. The transport interface is the only contract.

## SDK

Namespace adapters, graph evaluation, execution logic, and example scripts live in [aon-sdk](https://github.com/intervalplace/aon-sdk). Executors interact with the node exclusively through the HTTP API, submitting objects via `POST /v1/objects` and reading them back via `GET /v1/objects`.
