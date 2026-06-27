# Authorization Object Network: Technical Specification

**Version:** 1.0  
**Date:** 2026-06-27  
**Status:** Draft

---

## 1. Introduction

This document defines the Authorization Object Network (AON) protocol. It is the original reference for anyone implementing a node, a transport, a namespace, or an executor.

AON is a distributed object propagation network. Its purpose is to make authorization independently addressable; to externalize permission from the institutions that currently retain it, and make it propagatable across systems that do not share trust.

The protocol has three layers:

1. **The object model** — the four primitive object types and their content-addressing scheme
2. **The node** — the minimal infrastructure that stores and propagates objects
3. **The transport interface** — the contract between the node and whatever physical medium carries objects

Everything above these layers such as namespace semantics, graph evaluation, and execution logic is application-level and explicitly out of scope for the protocol itself.

---

## 2. Core Concepts

### 2.1 Authorization vs Authority

Authorization is permission for a bounded action. It identifies what may occur and the conditions under which it may occur.

Authority emerges when authorization persists independently of the action for which it was granted. Modern coordination systems accumulate authority because they retain authorization on behalf of participants.

AON addresses this structurally. Authorization is externalized into independently addressable objects. The network propagates these objects. No participant needs to retain authorization on behalf of another for coordination to occur.

### 2.2 Content Addressing

Every object in AON is identified by the keccak256 hash of its canonical serialization. Identity derives from content, not from location or assignment.

Consequences:

- Identical objects always produce identical identities
- Modification produces a new object, not a modified version of an existing one
- An object's identity is stable across nodes, transports, and time
- Validity is independently verifiable without trusting the propagating party

### 2.3 Local Truth

The network propagates objects. It does not determine what those objects mean, whether their claims are correct, or whether the external systems they reference are trustworthy.

Truth remains local to namespaces. A namespace defines the rules under which its objects are valid. The network carries namespace-tagged objects without interpreting them.

---

## 3. Object Model

### 3.1 AonObject

Every object in the network is an `AonObject`. The schema is:

```
AonObject {
  objectType:    AonObjectType      // required
  schemaVersion: "1"                // required, currently only "1"
  namespace:     string             // required, e.g. "aon:evm-spot"
  createdAt:     number             // required, Unix timestamp in milliseconds
  creator?:      string             // optional, address or identifier of creator
  references:    string[]           // required, hashes of referenced objects (may be empty)
  payload:       object             // required, namespace-defined content
  objectHash?:   string             // assigned on finalization, excluded from hash input
}
```

### 3.2 Object Types

`objectType` is a free string. The protocol does not restrict what values namespaces may use. Any namespace may define as many object types as it needs — the node stores and propagates them without interpretation.

The protocol defines five primitive types:

```
authorization  — permission for a bounded state transition
condition      — requirement that must be satisfied before execution
proof          — evidence that a condition has been satisfied
receipt        — record of completed execution
revocation     — cancellation of a prior object
```

Namespaces may define additional types. Examples:

```
reserve        — aon:csd-usdc specific (USDC locked on-chain pending proof)
order          — aon:evm-spot specific (signed order parameters)
fill           — aon:evm-spot specific (proposed match between two orders)
```

These are namespace conventions, not protocol primitives. The node has no knowledge of them.

### 3.3 Canonicalization

The canonical serialization of an `AonObject` is a deterministic JSON-like encoding used as input to the hash function. Rules:

1. `objectHash` is excluded from the canonical form
2. Fields with `undefined` values are excluded
3. Object keys are sorted lexicographically at every level
4. Arrays preserve their order
5. Primitive values are JSON-encoded

Reference implementation:

```typescript
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined && k !== "objectHash")
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
```

### 3.4 Object Hash

```
objectHash = keccak256(toBytes(canonicalize(object)))
```

The hash is computed after all other fields are set. It is stored on the object for convenience but excluded from the hash input.

### 3.5 Structural Validation

A node MUST accept an object if and only if:

- `objectType` is a non-empty string
- `schemaVersion` is `"1"`
- `namespace` is a non-empty string
- `references` is an array (elements must be strings if present)
- `payload` is a non-null object
- If `objectHash` is present, it matches the computed hash

A node MUST NOT apply semantic validation. Whether the payload is meaningful, whether a signature is valid for its domain, whether a proof is correct — these are namespace concerns, not protocol concerns.

### 3.6 References

`references` is an ordered array of `objectHash` values identifying other objects this object depends on or relates to. The semantic meaning of each reference position is defined by the namespace and object type.

References form a directed acyclic graph (DAG). The node maintains an inbound reference index: for each object hash, the set of hashes of objects that reference it.

---

## 4. The Node

### 4.1 Responsibilities

A node has exactly five responsibilities:

1. Accept, validate (structurally), store, and serve `AonObject` instances by hash
2. Maintain the inbound reference index
3. Propagate objects to and from peers via the configured transport
4. Assign `objectHash` on receipt (recomputing from content regardless of submitted value)
5. Serve the HTTP API

A node MUST NOT:

- Interpret payload content
- Validate signatures
- Evaluate graph executability
- Perform or trigger execution
- Maintain balances, ownership records, or application state

### 4.2 Storage

Objects are stored content-addressed in a sharded file system:

```
data/objects/{first_2_hex_chars}/{next_2_hex_chars}/{full_hash}.json
```

A flat index file (`data/index.json`) maintains:

- `objects` — map of hash → index entry (type, namespace, createdAt, references, path)
- `inbound` — map of hash → array of hashes of objects that reference it
- `byType` — map of objectType → array of hashes
- `byNamespace` — map of namespace → array of hashes
- `byTypeNamespace` — map of `type::namespace` → array of hashes

Index writes are serialized via a write lock to prevent concurrent corruption.

### 4.3 HTTP API

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/objects` | Submit an object |
| `GET` | `/v1/objects` | List objects (`objectType`, `namespace`, `references` query params) |
| `GET` | `/v1/objects/:hash` | Fetch object by hash |
| `GET` | `/v1/objects/:hash/references` | Inbound references to an object |
| `GET` | `/v1/graphs/:hash` | Assembled graph rooted at hash (nodes + edges) |
| `GET` | `/v1/graph/walk/:hash` | BFS inbound graph walk (`maxDepth`, `maxObjects` params) |
| `GET` | `/v1/p2p/info` | Node identity and peer list |
| `GET` | `/v1/p2p/pubsub` | Pubsub topic and subscriber info |
| `POST` | `/v1/p2p/dial` | Connect to a peer by address |
| `POST` | `/v1/p2p/request-object` | Request a specific object from a specific peer |
| `POST` | `/v1/p2p/gossip/:objectHash` | Broadcast an object to all peers |
| `POST` | `/v1/p2p/push/:objectHash` | Push an object to peers |
| `POST` | `/v1/p2p/exchange` | Exchange peer lists with a peer |
| `GET` | `/v1/health` | Health check |

`POST /v1/objects` always recomputes `objectHash` from content. The submitted hash field, if present, is ignored.

---

## 5. Transport Interface

The node has no knowledge of TCP, IP, libp2p, radio, or any physical medium. It depends only on the `AonTransport` interface. The transport is injected at startup.

### 5.1 Interface Definition

```typescript
interface PeerInfo {
  peerId: string;
  addrs: string[];
}

interface AonTransport {
  start(): Promise<void>;
  stop(): Promise<void>;

  // Broadcast an object to all known peers
  announceObject(obj: AonObject): Promise<void>;

  // Fetch a specific object from a specific peer by hash
  requestObject(hash: string, peerId: string): Promise<AonObject>;

  // Establish a connection to a peer by address
  dialPeer(addr: string): Promise<{ ok: boolean; reason?: string }>;

  // Exchange known peers with a specific peer
  exchangePeers(peerId: string): Promise<{ peers: PeerInfo[]; dialResults: any[] }>;

  // Return node identity and peer info
  getInfo(): { started: boolean; peerId: string | null; addrs: string[]; peers: string[] };

  // Return pubsub/topic info (if supported)
  getPubsubInfo(): { started: boolean; topic: string; peers: string[]; subscribers: string[] };

  // Register a handler called when an object arrives from the network
  onObject(handler: (obj: AonObject) => Promise<void>): void;
}
```

### 5.2 Implementing a Transport

A transport implementation receives objects from the network and delivers them to the node via the handler registered with `onObject`. It propagates objects outward via `announceObject`.

The transport is responsible for:

- Peer discovery and connection management
- Serialization and framing of objects for the physical medium
- Deduplication of received announcements
- Peer exchange

The transport is NOT responsible for:

- Object validation (the node validates on receipt)
- Storage (the node stores via `onObject`)
- Knowing what objects mean

### 5.3 MultiTransport

The node always runs `MultiTransport` — a composite transport that wraps any number of `AonTransport` implementations simultaneously. Objects arriving on any transport are delivered to the node once (deduplicated by hash) and cross-propagated to all other transports. An object arriving over LoRa is automatically announced to libp2p peers and WebSocket clients, and vice versa.

`MultiTransport` is assembled from environment variables at startup. Transports are independent — if any transport fails, the others continue unaffected.

### 5.4 Current Implementations

| Transport | File | Medium | Enabled when |
|---|---|---|---|
| libp2p | `src/transports/libp2p.ts` | TCP/IP internet | Always |
| WebSocket | `src/transports/websocket.ts` | WebSocket (browsers, clients) | `AON_WS != "false"` (default on) |
| LoRa | `src/transports/lora.ts` | LoRa radio (serial module) | `AON_LORA_PORT` is set |
| Bluetooth | `src/transports/bluetooth.ts` | Bluetooth Classic or BLE | `AON_BT=true` |
| Reticulum | `src/transports/reticulum.ts` | LoRa, I2P, serial, TCP via RNS | `AON_RNS=true` |

**libp2p** — gossipsub broadcast plus direct stream protocols for object fetch and peer exchange. Default internet transport.

**WebSocket** — runs a WebSocket server on port 8788 (configurable via `AON_WS_PORT`). Browsers and lightweight clients connect directly and receive object announcements in real time. Also connects outbound to other AON WebSocket nodes via `AON_WS_PEERS`.

**LoRa** — communicates with a serial-connected LoRa module (RYLR998, SX1276, E32, etc.). Objects are chunked into 200-byte frames. Announcements carry only the 32-byte hash — the full object is fetched on demand. Works completely offline. Requires `npm install serialport`.

**Bluetooth** — supports Classic Bluetooth (RFCOMM) and BLE. Classic mode uses RFCOMM streams for reliable ordered delivery. BLE mode uses GATT characteristics with chunked writes. Periodic scanning discovers nearby AON nodes automatically. Requires `npm install bluetooth-serial-port` (classic) or `npm install @abandonware/noble @abandonware/bleno` (BLE).

**Reticulum** — wraps the Reticulum Network Stack via a Python bridge process (`aon_rns_bridge.py`). Reticulum handles its own routing, encryption, and path finding across whatever interfaces are configured in `~/.reticulum/config` — LoRa via RNode, I2P, serial, TCP, and more. A single Reticulum transport gives AON access to all of them simultaneously. Requires `pip install rns`.

### 5.5 Address Formats

Each transport uses a distinct address prefix so `MultiTransport` can route `dialPeer` calls to the correct implementation:

| Transport | Address format | Example |
|---|---|---|
| libp2p | multiaddr | `/ip4/1.2.3.4/tcp/9000/p2p/12D3KooW...` |
| WebSocket | `ws://` or `wss://` | `ws://1.2.3.4:8788` |
| LoRa | `lora:{peerId}` | `lora:AABBCCDDEEAA` |
| Bluetooth | `bt://` or `ble://` | `bt://AA:BB:CC:DD:EE:FF` |
| Reticulum | `rns://{hash}` | `rns://a1b2c3d4e5f6...` |

### 5.6 Adding a Transport

1. Create `src/transports/{name}.ts` implementing `AonTransport`
2. Add it to `buildTransports()` in `src/server.ts`:

```typescript
if (process.env.AON_MY_TRANSPORT === "true") {
  transports.push(new MyTransport());
}
```

No other node code changes. MultiTransport handles cross-propagation automatically.

---

## 6. Network Resilience

AON is designed to continue operating when parts of the network infrastructure fail. This resilience is a structural consequence of the architecture rather than a bolted-on feature.

### 6.1 No Global State

The network does not maintain shared mutable state. There is no canonical chain, no global ledger, no authoritative server. Every node that holds an object is equally authoritative about that object. Hash identity is derived from content — it does not live anywhere and cannot be destroyed.

### 6.2 Transport Independence

Each transport is an independent failure domain. If TCP/IP connectivity is lost, LoRa and Bluetooth continue propagating objects within their physical range. If a LoRa module fails, libp2p and WebSocket continue over the internet. No single transport failure stops the network.

The network survives as long as any two nodes can reach each other through any transport.

### 6.3 Recovery

Objects stored locally during a network partition are propagated automatically when connectivity resumes. No manual intervention is required. The node stores objects persistently and announces them to newly connected peers.

### 6.4 Transport Stack at Runtime

A fully configured node runs all transports simultaneously:

```
libp2p      — internet peers (always active)
WebSocket   — browsers and lightweight clients (default active)
LoRa        — long-range radio mesh (when hardware present)
Bluetooth   — local building/campus mesh (when enabled)
Reticulum   — LoRa, I2P, serial via RNS (when enabled)
```

Each transport cross-propagates to all others via MultiTransport. An object arriving over LoRa is forwarded to internet peers and WebSocket clients in the same operation.

---

## 7. Namespaces

A namespace defines the semantic rules for a category of authorization objects. It is identified by a string in the form `aon:{name}`.

### 7.1 NamespaceAdapter Interface

```typescript
type NamespaceAdapter = {
  namespace: string;
  authorizationType: string;
  proofType: string;
  reserveType: string;

  // Normalize raw authorization data into canonical form
  normalizeAuthorization(auth: any): any;

  // Return EIP-712 type definitions (or equivalent for the namespace's scheme)
  types(): any;

  // Summarize an authorization object for display
  summarizeAuthorization(auth: AonObject): any;

  // Compute the executor reward for a graph
  reward(graph: any): any;

  // Verify a graph is valid for execution
  verify(graph: any): { ok: boolean; reason?: string };

  // Execute a graph
  execute(graph: any): Promise<any>;

  // Lock resources for an authorization (if the namespace requires a reserve)
  lock(args: { authorization: any }): Promise<any>;
};
```

### 7.2 Registered Namespaces

#### `aon:csd-usdc`

Coordinates atomic settlement between CSD (a custom settlement layer) and USDC on EVM.

Flow:
```
authorization (buyer signs USDC release)
  → reserve (USDC locked on-chain)
    → proof (CSD payment txid with confirmations)
      → receipt (USDC released to seller)
```

Key types: `CsdUsdcAuthorization`, `evm_usdc_lock`, `csd_payment`

#### `aon:evm-spot`

Coordinates spot trading on EVM without a reserve step.

Flow:
```
makerAuthorization + takerAuthorization (trading session grants)
  → makerOrder + takerOrder (signed order parameters)
    → fill (proposed match with amounts and nonce)
      → receipt (settled on-chain via settlement contract)
```

Key types: `TradingSessionAuthorization`, `evm_spot_order`, `evm_spot_fill`

Partial fills are supported. A fill references specific orders. The graph evaluator tracks cumulative filled base amount per order across all receipted fills to detect overfill conditions.

---

## 8. Executors

An executor is a permissionless participant that discovers executable authorization graphs and consumes them.

### 8.1 Properties

- **Permissionless** — no registration, no node operator approval required
- **Stateless** — an executor reads from the network and writes receipts back as objects
- **Namespace-scoped** — an executor is configured for one namespace
- **Not a node** — executors do not participate in object propagation

### 8.2 Execution Loop

```
1. Fetch objects from node (filtered by namespace)
2. Find executable graphs (findExecutableGraphs or namespace-specific variant)
3. For each executable graph:
   a. Verify via namespace adapter
   b. Execute via namespace adapter (mode: contract | simulate | off)
   c. Submit receipt object to node via POST /v1/objects
4. Wait pollIntervalMs, then repeat
```

On poll failure the executor applies exponential backoff:

```
delay = min(initialMs × factor^consecutiveFailures, maxMs)
```

Default: initialMs=1000, factor=2, maxMs=60000. Resets to `pollIntervalMs` on success.

### 8.3 Execution Modes

| Mode | Behavior |
|---|---|
| `contract` | Submits real on-chain transactions |
| `simulate` | Dry run — returns a simulated result, no on-chain effect |
| `off` | Verifies only — no execution, no receipt |

### 8.4 Graph Executability

A graph is executable when:

- All required objects are present and referenced correctly
- No required object is revoked
- Authorization validity windows are satisfied
- For `aon:evm-spot`: fill amounts do not exceed order amounts accounting for prior receipted fills
- No receipt already exists for this fill (not yet completed)

---

## 9. Graph Structure

An Executable Authorization Graph consists of an authorization object and the dependent objects required to satisfy its execution conditions. The specific structure is namespace-defined.

### 9.1 `aon:csd-usdc` Graph

```
{
  authorization: AonObject     // objectType: "authorization"
  reserve: AonObject           // objectType: "reserve", references authorization
  proof: AonObject             // objectType: "proof", references reserve
  receipt?: AonObject          // objectType: "receipt", references proof (if completed)
  status: "executable" | "completed"
}
```

### 9.2 `aon:evm-spot` Graph

```
{
  makerAuthorization: AonObject   // objectType: "authorization"
  takerAuthorization: AonObject   // objectType: "authorization"
  makerOrder: AonObject           // objectType: "order", references makerAuthorization
  takerOrder: AonObject           // objectType: "order", references takerAuthorization
  fill: AonObject                 // objectType: "fill", references both auths + both orders
  receipt?: AonObject             // objectType: "receipt", references fill (if completed)
  status: "executable" | "completed" | "overfilled"
  partialFill: {
    fillBaseAmount: string
    makerOrderBaseAmount: string
    takerOrderBaseAmount: string
    makerAlreadyFilled: string
    takerAlreadyFilled: string
    makerRemaining: string
    takerRemaining: string
    wouldOverfillMaker: boolean
    wouldOverfillTaker: boolean
  }
}
```

---

## 10. Security Model

### 10.1 What the protocol guarantees

- **Content integrity** — an object's identity is derived from its content. Modification changes identity.
- **Independent verifiability** — any party with the object can verify its hash. No trusted intermediary required.
- **Attribution** — objects carry `creator` and namespace-level signature information in payload. The protocol does not enforce who may create objects, but namespaces may.

### 10.2 What the protocol does not guarantee

- **Semantic correctness** — the node does not validate signatures, check authorization expiry, or verify proofs. These are namespace responsibilities.
- **Execution** — a valid executable graph may remain unexecuted if no executor acts on it.
- **Uniqueness** — multiple receipts for the same fill may exist. Canonicalization (taking the earliest) is a convention enforced by executors and applications, not the protocol.
- **Namespace correctness** — the protocol carries namespace-tagged objects faithfully. It does not verify that a namespace is correctly implemented.

### 10.3 Revocation

Revocation is an object, not a protocol-level mechanism. A revocation object references its target. The protocol propagates it. Executors and namespace adapters are responsible for checking revocation status before execution.

---

## 11. Schema Version

The current schema version is `"1"`. The node rejects objects with any other value.

Future schema versions will be introduced via a new `schemaVersion` string. Nodes may support multiple schema versions simultaneously. Schema migration is out of scope for this document.

---

## 12. Implementation Notes

### Node repository
`https://github.com/intervalplace/aon`

### SDK repository
`https://github.com/intervalplace/aon-sdk`

### Key files

| File | Purpose |
|---|---|
| `aon/src/object.ts` | AonObject type, canonicalization, hashing |
| `aon/src/store.ts` | Object storage, indexing, write lock |
| `aon/src/transport.ts` | AonTransport interface |
| `aon/src/transports/multi.ts` | MultiTransport — runs all transports simultaneously |
| `aon/src/transports/libp2p.ts` | TCP/IP transport via libp2p |
| `aon/src/transports/websocket.ts` | WebSocket transport for browsers and clients |
| `aon/src/transports/lora.ts` | LoRa radio transport |
| `aon/src/transports/bluetooth.ts` | Bluetooth Classic and BLE transport |
| `aon/src/transports/reticulum.ts` | Reticulum transport (LoRa, I2P, serial via RNS) |
| `aon/aon_rns_bridge.py` | Python bridge process for Reticulum |
| `aon/src/server.ts` | HTTP API and transport assembly |
| `aon-sdk/src/namespaces/index.ts` | NamespaceAdapter interface and implementations |
| `aon-sdk/src/executableEvmSpot.ts` | EVM spot graph evaluation |
| `aon-sdk/src/executor.ts` | Executor loop with backoff |
| `aon-sdk/src/helpers.ts` | Query and construction helpers |
| `aon-sdk/src/client.ts` | HTTP client for nodes |
