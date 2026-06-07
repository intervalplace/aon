//p2p.ts
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

const TOPIC = "/aon/objects/1";
const OBJECT_PROTOCOL = "/aon/object/1";

let node: Libp2p | null = null;
let started = false;

function jsonBytes(x: unknown) {
  return fromString(JSON.stringify(x));
}

function parseJsonBytes(bytes: Uint8Array) {
  return JSON.parse(toString(bytes));
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

  await stream.send(jsonBytes({ objectHash }));

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
    const objectHash = data.objectHash as string;

console.log("[p2p] received announcement", {
  objectHash,
  from: msg.detail.from?.toString?.(),
});

    if (!objectHash) return;
    if (getObject(objectHash)) return;

    const from = msg.detail.from;
    if (!from) return;

    const saved = await fetchObjectFromPeer(from, objectHash);

    if (saved.objectHash) {
      await announceObject(saved);
    }
  } catch (err) {
    console.error("[p2p] announcement failed", err);
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
      }),
    },
  });

await node.handle(OBJECT_PROTOCOL, async ({ stream }) => {
  try {
const req = await readJsonFromStream(stream);
    const objectHash = req.objectHash as string;
    const object = objectHash ? getObject(objectHash) : null;

    console.log("[p2p] object request", {
      objectHash,
      found: !!object,
    });

    const response = object
      ? { ok: true, object }
      : { ok: false, error: { code: "OBJECT_NOT_FOUND" } };

    await (stream as any).send(jsonBytes(response));

if (typeof (stream as any).close === "function") {
  await (stream as any).close();
}

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
console.log("[p2p] announcing object", obj.objectHash);
  await node.services.pubsub.publish(
    TOPIC,
    jsonBytes({
      ...objectSummary(obj),
      announcedAt: Date.now(),
    })
  );
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

  const peer = node.getPeers().find((p) => p.toString() === peerIdString);

  if (!peer) {
    throw new Error("PEER_NOT_CONNECTED");
  }

  return await fetchObjectFromPeer(peer, objectHash);
}

export async function dialPeer(addr: string) {
  if (!node) throw new Error("P2P_NOT_STARTED");

  const ma = multiaddr(addr);
  await node.dial(ma);

  return getP2pInfo();
}
