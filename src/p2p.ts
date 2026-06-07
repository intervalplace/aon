//p2p.ts
import { peerIdFromString } from "@libp2p/peer-id";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { bootstrap } from "@libp2p/bootstrap";
import { identify } from "@libp2p/identify";
import { fromString, toString } from "uint8arrays";
import { multiaddr } from "@multiformats/multiaddr";
import { getObject, putObject } from "./store.js";
import type { AonObject } from "./object.js";

import { Uint8ArrayList } from "uint8arraylist";

const TOPIC = "/aon/objects/1";
const OBJECT_PROTOCOL = "/aon/object/1";
const PUSH_PROTOCOL = "/aon/object-push/1";

let node: Libp2p | null = null;
let started = false;

function jsonBytes(x: unknown) {
  return fromString(JSON.stringify(x));
}

function yamuxBytes(x: unknown) {
  return new Uint8ArrayList(jsonBytes(x));
}

function parseJsonBytes(bytes: Uint8Array) {
  return JSON.parse(toString(bytes));
}

function peerIdFromMultiaddrString(addr: string) {
  const marker = "/p2p/";
  const i = addr.lastIndexOf(marker);

  if (i === -1) {
    throw new Error("BOOTSTRAP_MULTIADDR_MISSING_P2P");
  }

return peerIdFromString(addr.slice(i + marker.length));
}

function objectSummary(obj: AonObject) {
  return {
    objectHash: obj.objectHash,
    objectType: obj.objectType,
    namespace: obj.namespace,
    references: obj.references,
    createdAt: obj.createdAt,
  };
}


function chunkToBytes(chunk: any): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk?.subarray) return chunk.subarray();
  if (chunk?.slice) return chunk.slice();
  return new Uint8Array(chunk);
}

async function readJsonFromStream(stream: any, timeoutMs = 10_000): Promise<any> {
  const iterator = stream[Symbol.asyncIterator]();

  let out = new Uint8Array();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());

    const result = await Promise.race([
      iterator.next(),
      new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error("P2P_READ_TIMEOUT")), remaining)
      ),
    ]);

    if (result.done) break;

    const bytes = chunkToBytes(result.value);
    const next = new Uint8Array(out.length + bytes.length);
    next.set(out, 0);
    next.set(bytes, out.length);
    out = next;

    try {
      return JSON.parse(toString(out));
    } catch {
      // message may be split; keep reading
    }
  }

  throw new Error("P2P_JSON_MESSAGE_INCOMPLETE");
}

async function pushObjectToPeer(peerId: any, obj: AonObject) {
  if (!node || !obj.objectHash) return;

  const stream: any = await node.dialProtocol(peerId, PUSH_PROTOCOL);

  await stream.send(yamuxBytes({
    messageType: "aon_object",
    object: obj,
  }));

  if (typeof stream.sendCloseWrite === "function") {
    stream.sendCloseWrite();
  }

  console.log("[p2p] pushed object", {
    objectHash: obj.objectHash,
    peer: peerId.toString(),
  });
}

async function fetchObjectFromPeer(peerId: any, objectHash: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  console.log("[p2p] fetching object from peer", {
    peerId: peerId.toString?.() ?? String(peerId),
    objectHash,
  });

  const stream: any = await node.dialProtocol(peerId, OBJECT_PROTOCOL);

await stream.send(yamuxBytes({ objectHash }));

if (typeof stream.sendCloseWrite === "function") {
  stream.sendCloseWrite();
}

const response = await readJsonFromStream(stream);

if (typeof stream.close === "function") {
  await stream.close();
}

  if (!response.ok || !response.object) {
    throw new Error(response?.error?.code ?? "P2P_OBJECT_FETCH_FAILED");
  }

  const saved = await putObject(response.object);

  console.log("[p2p] stored fetched object", saved.objectHash);

  return saved;
}

async function handleAnnouncement(msg: any) {
  try {
    const data = parseJsonBytes(msg.detail.data);

    if (data.messageType !== "aon_object") return;

    const obj = data.object as AonObject;
    const objectHash = obj?.objectHash;

    console.log("[p2p] received object gossip", {
      objectHash,
      from: msg.detail.from?.toString?.(),
    });

    if (!objectHash) return;
    if (getObject(objectHash)) return;

    const saved = await putObject(obj);

    console.log("[p2p] stored gossiped object", saved.objectHash);

    if (saved.objectHash) {
      await announceObject(saved);
    }
  } catch (err) {
    console.error("[p2p] object gossip failed", err);
  }
}

export async function startP2p() {
  if (started && node) return node;

  const listenPort = Number(process.env.AON_P2P_PORT ?? 0);
  const bootstrapPeers = (process.env.AON_BOOTSTRAP ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  node = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${listenPort}`],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: bootstrapPeers.length
      ? [
          bootstrap({
            list: bootstrapPeers,
          }),
        ]
      : [],
    services: {
      identify: identify(),
pubsub: gossipsub({
  allowPublishToZeroTopicPeers: true,
directPeers: bootstrapPeers.map((addr) => ({
  id: peerIdFromMultiaddrString(addr),
  addrs: [multiaddr(addr)],
})) as any,
}),
    },
  });

await node.handle(PUSH_PROTOCOL, async ({ stream }) => {
  try {
    const msg = await readJsonFromStream(stream);

    if (msg.messageType !== "aon_object") return;

    const obj = msg.object as AonObject;
    if (!obj?.objectHash) return;

    if (getObject(obj.objectHash)) {
      console.log("[p2p] already have pushed object", obj.objectHash);
      return;
    }

    const saved = await putObject(obj);

    console.log("[p2p] stored pushed object", saved.objectHash);
  } catch (err) {
    console.error("[p2p] object push failed", err);
  }
});

    const response = object
      ? { ok: true, object }
      : { ok: false, error: { code: "OBJECT_NOT_FOUND" } };

    await (stream as any).send(jsonBytes(response));

    if (typeof (stream as any).sendCloseWrite === "function") {
      (stream as any).sendCloseWrite();
    }
  } catch (err) {
    console.error("[p2p] object request failed", err);
  }
});

  node.services.pubsub.addEventListener("message", handleAnnouncement);
  await node.services.pubsub.subscribe(TOPIC);

  started = true;

  console.log("[p2p] peer id", node.peerId.toString());
  console.log("[p2p] listening", node.getMultiaddrs().map((a) => a.toString()));

  return node;
}

export async function announceObject(obj: AonObject) {
  if (!node || !obj.objectHash) return;

  const peers = node.getPeers();

  console.log("[p2p] pushing object", {
    objectHash: obj.objectHash,
    peers: peers.map((p) => p.toString()),
  });

  for (const peer of peers) {
    pushObjectToPeer(peer, obj).catch((err) => {
      console.error("[p2p] push failed", {
        peer: peer.toString(),
        objectHash: obj.objectHash,
        error: err?.message ?? String(err),
      });
    });
  }
}

export function getPubsubInfo() {
  if (!node) {
    return {
      started: false,
      topic: TOPIC,
      subscribers: [],
    };
  }

  const pubsub: any = node.services.pubsub;

  return {
    started,
    topic: TOPIC,
    peers: node.getPeers().map((p) => p.toString()),
    topics:
      typeof pubsub.getTopics === "function"
        ? pubsub.getTopics()
        : [],
    subscribers:
      typeof pubsub.getSubscribers === "function"
        ? pubsub.getSubscribers(TOPIC).map((p: any) => p.toString())
        : [],
  };
}

export function getP2pInfo() {
  if (!node) {
    return {
      started: false,
      peerId: null,
      multiaddrs: [],
      peers: [],
    };
  }

  return {
    started,
    peerId: node.peerId.toString(),
    multiaddrs: node.getMultiaddrs().map((a) => a.toString()),
    peers: node.getPeers().map((p) => p.toString()),
  };
}

export async function requestObjectFromPeer(_peerIdString: string, _objectHash: string) {
  throw new Error("P2P_REQUEST_RESPONSE_DISABLED_USE_GOSSIP_V0");
}

export async function dialPeer(addr: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  const ma = multiaddr(addr);
  await node.dial(ma);

  return getP2pInfo();
}
