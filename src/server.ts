// server.ts
import "./polyfills.js";
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadStore, putObject, getObject, listObjects } from "./store.js";
import { getInboundReferences, getGraph } from "./refs.js";
import type { AonObject } from "./object.js";
import type { AonTransport } from "./transport.js";
import { LibP2pTransport } from "./transports/libp2p.js";
import { walkInboundGraph } from "./graph.js";

const app = Fastify({ logger: true });
const port = Number(process.env.AON_PORT ?? 8787);

// ── Transport ─────────────────────────────────────────────────────────────────
// To use a different transport, swap this import and instantiation.
// The rest of this file never changes.
//
// import { LoRaTransport } from "./transports/lora.js";
// const transport: AonTransport = new LoRaTransport();

const transport: AonTransport = new LibP2pTransport();

transport.onObject(async (obj: AonObject) => {
  await putObject(obj);
});

await app.register(cors, { origin: true });
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
  return {
    ok: true,
    objects: listObjects({
      objectType: q.objectType,
      namespace: q.namespace,
      references: q.references,
    }),
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
  const objects = listObjects();
  return {
    ok: true,
    target: hash,
    inbound: getInboundReferences(objects, hash),
  };
});

// ── Graphs ────────────────────────────────────────────────────────────────────

app.get("/v1/graphs/:hash", async (req) => {
  const hash = (req.params as any).hash;
  const objects = listObjects();
  return {
    ok: true,
    graph: getGraph(objects, hash),
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
    return { ok: true, ...result };
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
    return { ok: true, objectHash: object.objectHash, object };
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
