// server.ts
import "./polyfills.js";
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadStore, putObject, getObject, hasObject, listObjects, listHashes, getInboundObjects } from "./store.js";
import { attachSync } from "./sync.js";
import { getGraph } from "./refs.js";
import type { AonObject } from "./object.js";
import type { AonTransport } from "./transport.js";
import { LibP2pTransport } from "./transports/libp2p.js";
import { LoRaTransport } from "./transports/lora.js";
import { WebSocketTransport } from "./transports/websocket.js";
import { BluetoothTransport } from "./transports/bluetooth.js";
import { ReticulumTransport } from "./transports/reticulum.js";
import { MultiTransport } from "./transports/multi.js";
import { walkInboundGraph } from "./graph.js";

const app = Fastify({ logger: true });
const port = Number(process.env.AON_PORT ?? 8787);

// ── Transport ─────────────────────────────────────────────────────────────────
// MultiTransport is always used. Transports are assembled from environment
// variables — any configured transport runs, others are skipped silently.
//
// libp2p (TCP/IP) is always included.
// LoRa is included when AON_LORA_PORT is set.
//
// This means every node survives independently of which transports are
// available. If the internet goes down, LoRa keeps running. If the radio
// is absent, libp2p runs alone. No code change required — just config.

function buildTransports(): AonTransport[] {
  const transports: AonTransport[] = [];

  // Always include libp2p
  transports.push(new LibP2pTransport());

  // Include WebSocket if enabled (always on by default — disable with AON_WS=false)
  if (process.env.AON_WS !== "false") {
    transports.push(new WebSocketTransport());
    console.log("[node] WebSocket transport enabled", { port: process.env.AON_WS_PORT ?? 8788 });
  }

  // Include LoRa if a serial port is configured
  if (process.env.AON_LORA_PORT) {
    transports.push(new LoRaTransport());
    console.log("[node] LoRa transport enabled", { port: process.env.AON_LORA_PORT });
  }

  // Include Bluetooth if enabled
  if (process.env.AON_BT === "true") {
    transports.push(new BluetoothTransport());
    console.log("[node] Bluetooth transport enabled", { mode: process.env.AON_BT_MODE ?? "classic" });
  }

  // Include Reticulum if enabled (gives LoRa, I2P, serial, TCP — via RNS config)
  if (process.env.AON_RNS === "true") {
    transports.push(new ReticulumTransport());
    console.log("[node] Reticulum transport enabled", { config: process.env.AON_RNS_CONFIG ?? "~/.reticulum" });
  }

  return transports;
}

const transport: AonTransport = new MultiTransport(buildTransports());

transport.onObject(async (obj: AonObject) => {
  await putObject(obj);
});

// Namespace subscription: AON_NAMESPACES="aon:evm-spot,aon:csd-usdc" scopes
// both sync and gossip fetching to those namespaces. Unset = full node.
// The node treats namespaces as opaque strings — routing, not semantics.
const subscribedNamespaces = (process.env.AON_NAMESPACES ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
if (subscribedNamespaces.length) {
  console.log("[node] namespace subscription active", subscribedNamespaces);
}

// Transports never import the store — the node injects read access here,
// mirroring the onObject pattern above.
transport.onObjectRequest?.((hash: string) => getObject(hash));
transport.onListHashes?.((after, limit, namespaces) => listHashes({ after, limit, namespaces }));

// Gossip-side namespace policy: skip fetching announced objects outside our
// subscription. Announcement summaries are untrusted, so this is a bandwidth
// policy, not a security boundary — verification still happens on ingest.
if (subscribedNamespaces.length) {
  const wanted = new Set(subscribedNamespaces);
  transport.onWantObject?.((summary) =>
    summary.namespace === undefined ? true : wanted.has(summary.namespace)
  );
}

// Object synchronization (src/sync.ts): every new peer connection triggers
// list → diff → fetch → verify → ingest. New nodes backfill automatically
// from whichever peer they connect to first (usually the bootnode).
const sync = attachSync(transport, {
  hasObject,
  ingest: putObject,
  namespaces: subscribedNamespaces,
});

// Allow configuring CORS origin via env — defaults to open for p2p nodes
await app.register(cors, { origin: process.env.AON_CORS_ORIGIN ?? true });
await loadStore();
await transport.start();

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/v1/health", async () => ({
  ok: true,
  service: "aon-node-v0",
}));

// ── Objects ───────────────────────────────────────────────────────────────────

app.post("/v1/objects", async (req, reply) => {
  try {
    const obj = await putObject(req.body as any);
    const objectHash = (obj as any).objectHash ?? (obj as any).hash;

    if (!objectHash) {
      return reply.code(500).send({
        ok: false,
        error: { code: "OBJECT_HASH_MISSING" },
        object: obj,
      });
    }

    await transport.announceObject(obj);

    return { ok: true, objectHash, object: obj };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "OBJECT_REJECTED" },
    });
  }
});

app.get("/v1/objects", async (req) => {
  const q = req.query as any;
  const limit = q.limit ? Math.min(Number(q.limit), 1000) : undefined;
  const result = listObjects({
    objectType: q.objectType,
    namespace:  q.namespace,
    references: q.references,
    limit,
    offset:     q.offset ? Number(q.offset) : undefined,
  });
  return {
    ok: true,
    objects: result.objects,
    total:   result.total,
    offset:  result.offset,
    limit:   result.limit,
  };
});

app.get("/v1/objects/:hash", async (req, reply) => {
  const hash = (req.params as any).hash;
  const obj = getObject(hash);

  if (!obj) {
    return reply.code(404).send({
      ok: false,
      error: { code: "OBJECT_NOT_FOUND" },
    });
  }

  return { ok: true, object: obj };
});

app.get("/v1/objects/:hash/references", async (req) => {
  const hash = (req.params as any).hash;
  return {
    ok: true,
    target: hash,
    inbound: getInboundObjects(hash),
  };
});

// ── Graphs ────────────────────────────────────────────────────────────────────

app.get("/v1/graphs/:hash", async (req) => {
  const hash = (req.params as any).hash;
  const q = req.query as any;
  return {
    ok: true,
    graph: getGraph(hash, {
      maxObjects: q.maxObjects ? Number(q.maxObjects) : undefined,
    }),
  };
});

app.get("/v1/graph/walk/:hash", async (req, reply) => {
  const hash = (req.params as any).hash;

  const graph = walkInboundGraph(hash, {
    maxDepth: Number((req.query as any).maxDepth ?? 8),
    maxObjects: Number((req.query as any).maxObjects ?? 1000),
  });

  if (!graph) {
    return reply.code(404).send({
      ok: false,
      error: { code: "GRAPH_ROOT_NOT_FOUND" },
    });
  }

  return { ok: true, graph };
});

// ── P2P ───────────────────────────────────────────────────────────────────────

app.get("/v1/p2p/info", async () => ({
  ok: true,
  p2p: transport.getInfo(),
}));

app.get("/v1/p2p/pubsub", async () => ({
  ok: true,
  pubsub: transport.getPubsubInfo(),
}));

app.post("/v1/p2p/dial", async (req, reply) => {
  try {
    const body = req.body as any;
    if (!body.addr) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_MULTIADDR" } });
    }
    const result = await transport.dialPeer(body.addr);
    return result;
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_DIAL_FAILED" },
    });
  }
});

app.post("/v1/p2p/request-object", async (req, reply) => {
  try {
    const body = req.body as any;
    if (!body.peerId) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PEER_ID" } });
    }
    if (!body.objectHash) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_OBJECT_HASH" } });
    }
    const object = await transport.requestObject(body.objectHash, body.peerId);
    // requestObject no longer stores as a side-effect; ingest explicitly.
    const stored = await putObject(object);
    return { ok: true, objectHash: stored.objectHash, object: stored };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_REQUEST_OBJECT_FAILED" },
    });
  }
});

app.post("/v1/p2p/gossip/:objectHash", async (req, reply) => {
  try {
    const objectHash = (req.params as any).objectHash as string;
    const obj = getObject(objectHash);
    if (!obj) {
      return reply.code(404).send({ ok: false, error: { code: "OBJECT_NOT_FOUND" } });
    }
    await transport.announceObject(obj);
    return { ok: true, objectHash, status: "announced" };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "GOSSIP_FAILED" },
    });
  }
});

app.post("/v1/p2p/push/:objectHash", async (req, reply) => {
  try {
    const objectHash = (req.params as any).objectHash as string;
    const obj = getObject(objectHash);
    if (!obj) {
      return reply.code(404).send({ ok: false, error: { code: "OBJECT_NOT_FOUND" } });
    }
    await transport.announceObject(obj);
    return { ok: true, objectHash, status: "push_attempted" };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "PUSH_FAILED" },
    });
  }
});

app.post("/v1/p2p/sync", async (req, reply) => {
  try {
    const body = req.body as any;

    // No peerId → sync from all currently connected peers in parallel.
    if (!body?.peerId) {
      const peers = transport.getInfo().peers;
      if (peers.length === 0) {
        return { ok: true, status: "NO_PEERS", results: [] };
      }
      const results = await Promise.allSettled(peers.map(p => sync.syncFromPeer(p)));
      return {
        ok: true,
        results: results.map((r, i) => ({
          peerId: peers[i],
          ...(r.status === "fulfilled"
            ? { status: "OK", result: r.value ?? { status: "SKIPPED" } }
            : { status: "ERROR", error: (r.reason as any)?.message ?? String(r.reason) }),
        })),
      };
    }

    const result = await sync.syncFromPeer(body.peerId);
    if (!result) {
      return { ok: true, status: "SKIPPED", reason: "SYNC_UNSUPPORTED_OR_IN_FLIGHT" };
    }
    return { ok: true, result };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_SYNC_FAILED" },
    });
  }
});

app.post("/v1/p2p/exchange", async (req, reply) => {
  try {
    const body = req.body as any;
    if (!body.peerId) {
      return reply.code(400).send({ ok: false, error: { code: "MISSING_PEER_ID" } });
    }
    const result = await transport.exchangePeers(body.peerId);
    return { ok: true, result };
  } catch (err: any) {
    return reply.code(400).send({
      ok: false,
      error: { code: err?.message ?? "P2P_EXCHANGE_FAILED" },
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

await app.listen({ port, host: "0.0.0.0" });

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  console.log("[server] shutting down...");
  try { await transport.stop(); } catch {}
  try { await app.close(); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
