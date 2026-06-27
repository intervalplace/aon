# AON Node

A minimal, transport-agnostic node for the Authorization Object Network.

The node stores, indexes, and propagates content-addressed Authorization Objects across a peer-to-peer network. It has no knowledge of namespaces, execution logic, or what any object means. It does one thing: move objects faithfully between peers, the same way IP routes packets without understanding their contents.

## Quickstart

**Requirements:** Node.js 20+

```bash
git clone https://github.com/intervalplace/aon.git
cd aon
npm install
```

Create a `.env` file:

```bash
AON_PORT=8787
AON_P2P_PORT=9000
AON_PEER_KEY_PATH=./data/peer.key
AON_BOOTSTRAP=/ip4/BOOTSTRAP_IP/tcp/BOOTSTRAP_PORT/p2p/BOOTSTRAP_PEER_ID
```

Start the node:

```bash
npm run dev
```

Verify it's running:

```bash
curl http://localhost:8787/v1/health
# {"ok":true,"service":"aon-node-v0"}

curl http://localhost:8787/v1/p2p/info
# {"ok":true,"p2p":{"started":true,"peerId":"12D3KooW...","addrs":[...],"peers":[...]}}
```

Your node is now live, connected to the network, and propagating objects.

**Submit an object:**

```bash
curl -X POST http://localhost:8787/v1/objects \
  -H "Content-Type: application/json" \
  -d '{
    "objectType": "authorization",
    "schemaVersion": "1",
    "namespace": "aon:evm-spot",
    "createdAt": 1234567890000,
    "references": [],
    "payload": { "example": true }
  }'
# {"ok":true,"objectHash":"0x...","object":{...}}
```

**Fetch it back:**

```bash
curl http://localhost:8787/v1/objects/0x...
```

That object is now propagating across every connected node on the network.

---

## What it is

AON is a distributed object propagation network for authorized state transitions. Rather than embedding authorization inside institutions, applications, or intermediaries, AON externalizes authorization into independently addressable objects that can be discovered, verified, and consumed by any participant.

The node is the infrastructure layer. Everything above it — namespace logic, graph evaluation, execution — lives in [aon-sdk](https://github.com/intervalplace/aon-sdk).

## Architecture

```
src/
  server.ts              — HTTP API
  object.ts              — AonObject type, canonicalization, hashing
  store.ts               — Object storage and indexing
  graph.ts               — Inbound graph traversal
  refs.ts                — Reference index helpers
  transport.ts           — AonTransport interface
  transports/
    multi.ts             — Runs all transports simultaneously
    libp2p.ts            — TCP/IP transport (always active)
    websocket.ts         — WebSocket transport (browsers and clients)
    lora.ts              — LoRa radio transport
    bluetooth.ts         — Bluetooth Classic and BLE transport
    reticulum.ts         — Reticulum transport (LoRa, I2P, serial via RNS)
  polyfills.ts
```

The node runs `MultiTransport` by default — all configured transports run simultaneously and cross-propagate objects between each other. If the internet goes down, LoRa and Bluetooth keep the network running within radio range.

## Object model

Every object is a content-addressed `AonObject`:

```ts
type AonObject = {
  objectType: string;       // "authorization" | "proof" | "receipt" | "revocation" | "condition" | namespace-defined
  schemaVersion: "1";
  namespace: string;        // e.g. "aon:evm-spot"
  createdAt: number;        // Unix timestamp in milliseconds
  creator?: string;
  references: string[];     // hashes of objects this one depends on
  payload: Record<string, unknown>;
  objectHash?: string;      // keccak256 of canonical content, assigned on write
};
```

The node verifies hash integrity on every inbound object. It does not interpret `payload` — that is the namespace's responsibility.

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
| `AON_WS` | `true` | Set to `false` to disable WebSocket transport |
| `AON_WS_PORT` | `8788` | WebSocket server port |
| `AON_WS_PEERS` | — | Comma-separated `ws://` URLs to connect to |
| `AON_LORA_PORT` | — | Serial port for LoRa module (e.g. `/dev/ttyUSB0`) |
| `AON_LORA_BAUD` | `9600` | LoRa module baud rate |
| `AON_LORA_MODE` | `at` | `at` for AT-command modules, `raw` for binary |
| `AON_BT` | `false` | Set to `true` to enable Bluetooth transport |
| `AON_BT_MODE` | `classic` | `classic` (RFCOMM) or `ble` |
| `AON_RNS` | `false` | Set to `true` to enable Reticulum transport |
| `AON_RNS_CONFIG` | `~/.reticulum` | Reticulum config directory |
| `AON_PEX_INTERVAL_MS` | `30000` | Peer exchange interval |

To connect to the network, set `AON_BOOTSTRAP` to a bootstrap node multiaddr:

```
AON_BOOTSTRAP=/ip4/1.2.3.4/tcp/9000/p2p/12D3KooW...
```

## Transport stack

The node runs all configured transports simultaneously via `MultiTransport`. Objects arriving on any transport are propagated to all others automatically.

| Transport | Active when | Medium |
|---|---|---|
| libp2p | Always | TCP/IP internet |
| WebSocket | `AON_WS != "false"` | Browsers and lightweight clients |
| LoRa | `AON_LORA_PORT` is set | Long-range radio |
| Bluetooth | `AON_BT=true` | Local mesh |
| Reticulum | `AON_RNS=true` | LoRa, I2P, serial via RNS |

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
| `POST` | `/v1/p2p/dial` | Connect to a peer by address |
| `POST` | `/v1/p2p/request-object` | Request a specific object from a peer |
| `POST` | `/v1/p2p/gossip/:objectHash` | Announce an object to all peers |
| `POST` | `/v1/p2p/push/:objectHash` | Push an object to peers |
| `POST` | `/v1/p2p/exchange` | Exchange peer lists with a peer |

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Health check |

## Adding a transport

Implement `AonTransport` from `src/transport.ts` and add it to `buildTransports()` in `src/server.ts`:

```ts
if (process.env.AON_MY_TRANSPORT === "true") {
  transports.push(new MyTransport());
}
```

`MultiTransport` handles cross-propagation automatically. No other node code changes.

## Specification

The full protocol specification lives at [SPEC.md](./SPEC.md).

## SDK

Namespace adapters, graph evaluation, execution logic, and query helpers live in [aon-sdk](https://github.com/intervalplace/aon-sdk). Executors interact with the node exclusively through the HTTP API.
