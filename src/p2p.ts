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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";

import { Uint8ArrayList } from "uint8arraylist";

const TOPIC = "/aon/objects/1";
const OBJECT_PROTOCOL = "/aon/object/1";
const ANNOUNCE_PROTOCOL = "/aon/object-announce/1";

const PEER_PROTOCOL = "/aon/peers/1";

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

async function loadOrCreatePrivateKey() {
  const keyPath = process.env.AON_PEER_KEY_PATH;

  if (!keyPath) return undefined;

  if (existsSync(keyPath)) {
    return privateKeyFromProtobuf(readFileSync(keyPath));
  }

  mkdirSync(dirname(keyPath), { recursive: true });

  const privateKey = await generateKeyPair("Ed25519");
  writeFileSync(keyPath, privateKeyToProtobuf(privateKey));

  return privateKey;
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

async function fetchObjectFromPeer(peerId: any, objectHash: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  console.log("[p2p] fetching object from peer", {
    peerId: peerId.toString?.() ?? String(peerId),
    objectHash,
  });

const stream: any = await node.dialProtocol(peerId, OBJECT_PROTOCOL);

await stream.sink([jsonBytes({ objectHash })]);

if (typeof stream.sendCloseWrite === "function") {
  stream.sendCloseWrite();
}

const response = await readJsonFromStream(stream.source ?? stream);

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

async function processObjectAnnouncement(data: any, fromPeer: any) {
  const objectHash = data.objectHash;

  console.log("[p2p] received object announcement", {
    objectHash,
    from: fromPeer?.toString?.(),
  });

  if (!objectHash || typeof objectHash !== "string") return;
  if (getObject(objectHash)) return;
  if (!fromPeer) return;

  const saved = await fetchObjectFromPeer(fromPeer, objectHash);

  if (saved.objectHash) {
    await announceObject(saved);
  }
}

async function handleAnnouncement(msg: any) {
  try {
    const data = parseJsonBytes(msg.detail.data);

    if (data.messageType !== "aon_object_announcement") return;

    await processObjectAnnouncement(data, msg.detail.from);
  } catch (err) {
    console.error("[p2p] object announcement failed", err);
  }
}

function knownPeerAddrs() {
  if (!node) return [];

  return node.getPeers().map((peerId) => ({
    peerId: peerId.toString(),
    addrs: node!
      .getMultiaddrs()
      .map((a) => a.toString()),
  }));
}

function selfPeerInfo() {
  if (!node) return null;

  return {
    peerId: node.peerId.toString(),
    addrs: node.getMultiaddrs().map((a) => a.toString()),
  };
}

export async function startP2p() {
  if (started && node) return node;

  const listenPort = Number(process.env.AON_P2P_PORT ?? 0);
  const bootstrapPeers = (process.env.AON_BOOTSTRAP ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const privateKey = await loadOrCreatePrivateKey();

  node = await createLibp2p({
privateKey,
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

await node.handle(ANNOUNCE_PROTOCOL, async (evt: any) => {
  const stream = evt.stream ?? evt;

  try {
    console.log("[p2p] incoming direct hash announcement");

    const msg = await readJsonFromStream(stream.source ?? stream);

    if (msg.messageType !== "aon_object_announcement") return;

    const fromPeer = evt.connection?.remotePeer ?? null;

    await processObjectAnnouncement(msg, fromPeer);
  } catch (err) {
    console.error("[p2p] direct announcement failed", err);
  }
});

await node.handle(OBJECT_PROTOCOL, async (evt: any) => {
  const stream = evt.stream ?? evt;

  try {
    console.log("[p2p] incoming object request");

    const msg = await readJsonFromStream(stream);
    const objectHash = msg.objectHash;

    if (!objectHash || typeof objectHash !== "string") {

await stream.sink([jsonBytes({
        ok: false,
        error: { code: "MISSING_OBJECT_HASH" },
})]);
      return;
    }

    const obj = getObject(objectHash);

    if (!obj) {

await stream.sink([jsonBytes({
  ok: false,
  error: { code: "OBJECT_NOT_FOUND" },
})]);

      return;
    }

await stream.sink([jsonBytes({
  ok: true,
  objectHash,
  object: obj,
})]);

    if (typeof stream.sendCloseWrite === "function") {
      stream.sendCloseWrite();
    }

    console.log("[p2p] served object", { objectHash });
  } catch (err) {
    console.error("[p2p] object request failed", err);
  }
});


await node.handle(PEER_PROTOCOL, async (evt: any) => {
  const stream = evt.stream ?? evt;

  try {
    console.log("[p2p] incoming peer exchange request");

    await stream.sink([jsonBytes({
      ok: true,
      self: selfPeerInfo(),
      peers: node?.getPeers().map((p) => p.toString()) ?? [],
    })]);
  } catch (err) {
    console.error("[p2p] peer exchange failed", err);
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

  const announcement = {
    messageType: "aon_object_announcement",
    objectHash: obj.objectHash,
    summary: objectSummary(obj),
    announcedAt: Date.now(),
  };

  await node.services.pubsub.publish(TOPIC, jsonBytes(announcement));

  const peers = node.getPeers();

  for (const peer of peers) {
    try {
      const stream: any = await node.dialProtocol(peer, ANNOUNCE_PROTOCOL);

      await stream.sink([jsonBytes(announcement)]);

      if (typeof stream.close === "function") {
        await stream.close();
      }
    } catch (err: any) {
      console.error("[p2p] direct hash announce failed", {
        peer: peer.toString(),
        objectHash: obj.objectHash,
        error: err?.message ?? String(err),
      });
    }
  }

  console.log("[p2p] announced object hash", {
    objectHash: obj.objectHash,
    peers: peers.map((p) => p.toString()),
  });
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

export async function requestObjectFromPeer(peerIdString: string, objectHash: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  const peerId = peerIdFromString(peerIdString);

  return await fetchObjectFromPeer(peerId, objectHash);
}

export async function exchangePeersWith(peerIdString: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  const peerId = peerIdFromString(peerIdString);
  const stream: any = await node.dialProtocol(peerId, PEER_PROTOCOL);

  await stream.sink([jsonBytes({
    messageType: "aon_peer_exchange_request",
    from: selfPeerInfo(),
  })]);

  const response = await readJsonFromStream(stream.source ?? stream);

  return response;
}

export async function dialPeer(addr: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  const ma = multiaddr(addr);
  await node.dial(ma);

  return getP2pInfo();
}
