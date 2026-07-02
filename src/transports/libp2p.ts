// transports/libp2p.ts
//
// AonTransport implementation over TCP/IP using libp2p.
// This is the default transport. It is one implementation of AonTransport —
// not the protocol itself. The node has no direct dependency on this file.

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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import { Uint8ArrayList } from "uint8arraylist";
import type { AonObject } from "../object.js";
import type { AonTransport, PeerInfo } from "../transport.js";

const TOPIC = "/aon/objects/1";
const OBJECT_PROTOCOL = "/aon/object/1";
const ANNOUNCE_PROTOCOL = "/aon/object-announce/1";
const PEER_PROTOCOL = "/aon/peers/1";

const MAX_P2P_JSON_BYTES = Number(process.env.AON_MAX_P2P_JSON_BYTES ?? 1_000_000);
const SEEN_ANNOUNCEMENT_MAX = Number(process.env.AON_SEEN_ANNOUNCEMENT_MAX ?? 10_000);

export class LibP2pTransport implements AonTransport {
  private node: Libp2p | null = null;
  private started = false;
  private stopping = false;
  private pexTimer: NodeJS.Timeout | null = null;
  private seenAnnouncements = new Set<string>();
  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;
  }

  // ── Serialization helpers ──────────────────────────────────────────────────

  private jsonBytes(x: unknown) {
    return fromString(JSON.stringify(x));
  }

  private yamuxBytes(x: unknown) {
    return new Uint8ArrayList(this.jsonBytes(x));
  }

  private parseJsonBytes(bytes: Uint8Array) {
    return JSON.parse(toString(bytes));
  }

  // ── Key management ─────────────────────────────────────────────────────────

  private async loadOrCreatePrivateKey() {
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

  // ── Peer helpers ───────────────────────────────────────────────────────────

  private async peerInfos(): Promise<PeerInfo[]> {
    if (!this.node) return [];
    const peers = this.node.getPeers();
    const out: PeerInfo[] = [];
    for (const peerId of peers) {
      const peerIdString = peerId.toString();
      const rawAddrs =
        this.node.peerStore && typeof this.node.peerStore.get === "function"
          ? ((await this.node.peerStore.get(peerId))?.addresses ?? []).map(
              (a: any) => a.multiaddr?.toString?.() ?? a.toString?.()
            )
          : [];
      const addrs = rawAddrs
        .filter(Boolean)
        .map((addr: string) =>
          addr.includes("/p2p/") ? addr : `${addr}/p2p/${peerIdString}`
        );
      out.push({ peerId: peerIdString, addrs });
    }
    return out;
  }

  private selfPeerInfo() {
    if (!this.node) return null;
    return {
      peerId: this.node.peerId.toString(),
      addrs: this.node.getMultiaddrs().map((a) => a.toString()),
    };
  }

  private isSelfPeer(peerIdString: string) {
    return this.node?.peerId.toString() === peerIdString;
  }

  private alreadyConnected(peerIdString: string) {
    return this.node?.getPeers().some((p) => p.toString() === peerIdString) ?? false;
  }

  private peerIdFromMultiaddrString(addr: string) {
    const marker = "/p2p/";
    const i = addr.lastIndexOf(marker);
    if (i === -1) throw new Error("BOOTSTRAP_MULTIADDR_MISSING_P2P");
    return peerIdFromString(addr.slice(i + marker.length));
  }

  private rememberAnnouncement(objectHash: string) {
    const h = objectHash.toLowerCase();
    if (this.seenAnnouncements.has(h)) return false;
    this.seenAnnouncements.add(h);
    if (this.seenAnnouncements.size > SEEN_ANNOUNCEMENT_MAX) {
      const first = this.seenAnnouncements.values().next().value;
      if (first) this.seenAnnouncements.delete(first);
    }
    return true;
  }

  // ── Stream I/O ─────────────────────────────────────────────────────────────

  private chunkToBytes(chunk: any): Uint8Array {
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk?.subarray) return chunk.subarray();
    if (chunk?.slice) return chunk.slice();
    return new Uint8Array(chunk);
  }

  private async readJsonFromStream(stream: any, timeoutMs = 10_000): Promise<any> {
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
      const bytes = this.chunkToBytes(result.value);
      if (out.length + bytes.length > MAX_P2P_JSON_BYTES) {
        throw new Error("P2P_MESSAGE_TOO_LARGE");
      }
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

  private async writeJsonToStream(stream: any, msg: unknown) {
    const bytes = this.jsonBytes(msg);
    if (bytes.length > MAX_P2P_JSON_BYTES) throw new Error("P2P_MESSAGE_TOO_LARGE");
    if (typeof stream.sink === "function") { await stream.sink([bytes]); return; }
    if (stream.sink && typeof stream.sink[Symbol.asyncIterator] === "function") { await stream.sink([bytes]); return; }
    if (typeof stream.send === "function") { await stream.send(this.yamuxBytes(msg)); return; }
    if (stream.source && typeof stream.source.sink === "function") { await stream.source.sink([bytes]); return; }
    throw new Error("P2P_STREAM_WRITE_UNSUPPORTED");
  }

  // ── Object propagation ─────────────────────────────────────────────────────

  private objectSummary(obj: AonObject) {
    return {
      objectHash: obj.objectHash,
      objectType: obj.objectType,
      namespace: obj.namespace,
      references: obj.references,
      createdAt: obj.createdAt,
    };
  }

  private async fetchObjectFromPeer(peerId: any, objectHash: string): Promise<AonObject> {
    if (!this.node) throw new Error("P2P_NOT_STARTED");
    console.log("[p2p] fetching object from peer", {
      peerId: peerId.toString?.() ?? String(peerId),
      objectHash,
    });
    const stream: any = await this.node.dialProtocol(peerId, OBJECT_PROTOCOL);
    await this.writeJsonToStream(stream, { objectHash });
    if (typeof stream.sendCloseWrite === "function") stream.sendCloseWrite();
    const response = await this.readJsonFromStream(stream.source ?? stream);
    if (typeof stream.close === "function") await stream.close();
    if (!response.ok || !response.object) {
      throw new Error(response?.error?.code ?? "P2P_OBJECT_FETCH_FAILED");
    }
    if (this.objectHandler) {
      await this.objectHandler(response.object);
    }
    console.log("[p2p] stored fetched object", response.object.objectHash);
    return response.object;
  }

  private async processObjectAnnouncement(data: any, fromPeer: any) {
    const objectHash = data.objectHash;
    console.log("[p2p] received object announcement", {
      objectHash,
      from: fromPeer?.toString?.(),
    });
    if (!objectHash || typeof objectHash !== "string") return;
    if (!this.rememberAnnouncement(objectHash)) return;
    if (!fromPeer) return;
    const obj = await this.fetchObjectFromPeer(fromPeer, objectHash);
    if (obj?.objectHash) await this.announceObject(obj);
  }

  private async handleAnnouncement(msg: any) {
    try {
      const data = this.parseJsonBytes(msg.detail.data);
      if (data.messageType !== "aon_object_announcement") return;
      const fromPeer =
        msg.detail.from ??
        (data.from?.peerId ? peerIdFromString(data.from.peerId) : null);
      await this.processObjectAnnouncement(data, fromPeer);
    } catch (err) {
      console.error("[p2p] object announcement failed", err);
    }
  }

  private async dialPeerInfo(info: any) {
    if (!this.node) throw new Error("P2P_NOT_STARTED");
    if (!info?.peerId || this.isSelfPeer(info.peerId)) {
      return { ok: false, skipped: true, reason: "SELF_OR_MISSING_PEER_ID" };
    }
    if (this.alreadyConnected(info.peerId)) {
      return { ok: true, skipped: true, reason: "ALREADY_CONNECTED", peerId: info.peerId };
    }
    const addrs = Array.isArray(info.addrs) ? info.addrs : [];
    for (const addr of addrs) {
      try {
        if (!addr || typeof addr !== "string") continue;
        await this.node.dial(multiaddr(addr));
        console.log("[p2p] dialed discovered peer", { peerId: info.peerId, addr });
        return { ok: true, peerId: info.peerId, addr };
      } catch (err: any) {
        console.error("[p2p] discovered peer dial failed", {
          peerId: info.peerId,
          addr,
          error: err?.message ?? String(err),
        });
      }
    }
    return { ok: false, peerId: info.peerId, error: "NO_DIALABLE_ADDR_WORKED" };
  }

  private async runPeerExchangeRound() {
    if (!this.node) return;
    const peers = this.node.getPeers();
    for (const peer of peers) {
      try {
        await this.exchangePeers(peer.toString());
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (
          msg.includes("stream has been reset") ||
          msg.includes("stream that is closed") ||
          msg.includes("connection is closing")
        ) {
          console.log("[p2p] peer unavailable during exchange", { peer: peer.toString(), error: msg });
          continue;
        }
        console.error("[p2p] peer exchange round failed", { peer: peer.toString(), error: msg });
      }
    }
  }

  // ── AonTransport interface ─────────────────────────────────────────────────

  async start() {
    if (this.started && this.node) return;

    const listenPort = Number(process.env.AON_P2P_PORT ?? 0);
    const bootstrapPeers = (process.env.AON_BOOTSTRAP ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const privateKey = await this.loadOrCreatePrivateKey();

    const maxPeers = Number(process.env.AON_MAX_PEERS ?? 50);

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen: [`/ip4/0.0.0.0/tcp/${listenPort}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: maxPeers,
      },
      peerDiscovery: bootstrapPeers.length ? [bootstrap({ list: bootstrapPeers })] : [],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          directPeers: bootstrapPeers.map((addr) => ({
            id: this.peerIdFromMultiaddrString(addr),
            addrs: [multiaddr(addr)],
          })) as any,
        }),
      },
    });

    await this.node.handle(ANNOUNCE_PROTOCOL, async (evt: any) => {
      const stream = evt.stream ?? evt;
      try {
        const msg = await this.readJsonFromStream(stream.source ?? stream);
        if (msg.messageType !== "aon_object_announcement") return;
        const fromPeer =
          evt.connection?.remotePeer ??
          (msg.from?.peerId ? peerIdFromString(msg.from.peerId) : null);
        await this.processObjectAnnouncement(msg, fromPeer);
      } catch (err) {
        console.error("[p2p] direct announcement failed", err);
      }
    });

    await this.node.handle(OBJECT_PROTOCOL, async (evt: any) => {
      const stream = evt.stream ?? evt;
      try {
        const msg = await this.readJsonFromStream(stream);
        const objectHash = msg.objectHash;
        if (!objectHash || typeof objectHash !== "string") {
          await this.writeJsonToStream(stream, { ok: false, error: { code: "MISSING_OBJECT_HASH" } });
          return;
        }
        // Ask the node for the object via the registered handler's store
        // We serve what we have; the node wired getObject via onObject
        const { getObject } = await import("../store.js");
        const obj = getObject(objectHash);
        if (!obj) {
          await this.writeJsonToStream(stream, { ok: false, error: { code: "OBJECT_NOT_FOUND" } });
          return;
        }
        await this.writeJsonToStream(stream, { ok: true, objectHash, object: obj });
        if (typeof stream.sendCloseWrite === "function") stream.sendCloseWrite();
        console.log("[p2p] served object", { objectHash });
      } catch (err) {
        console.error("[p2p] object request failed", err);
      }
    });

    await this.node.handle(PEER_PROTOCOL, async (evt: any) => {
      const stream = evt.stream ?? evt;
      try {
        await this.writeJsonToStream(stream, {
          ok: true,
          self: this.selfPeerInfo(),
          peers: await this.peerInfos(),
        });
      } catch (err) {
        console.error("[p2p] peer exchange failed", err);
      }
    });

    this.node.services.pubsub.addEventListener("message", (msg: any) =>
      this.handleAnnouncement(msg)
    );
    await this.node.services.pubsub.subscribe(TOPIC);

    this.pexTimer = setInterval(() => {
      if (this.stopping) return;
      this.runPeerExchangeRound().catch((err) => {
        if (this.stopping) return;
        console.error("[p2p] peer exchange interval failed", err);
      });
    }, Number(process.env.AON_PEX_INTERVAL_MS ?? 30_000));

    this.started = true;
    console.log("[p2p] peer id", this.node.peerId.toString());
    console.log("[p2p] listening", this.node.getMultiaddrs().map((a) => a.toString()));
  }

  async stop() {
    this.stopping = true;
    if (this.pexTimer) { clearInterval(this.pexTimer); this.pexTimer = null; }
    if (this.node) await this.node.stop();
    this.node = null;
    this.started = false;
  }

  async announceObject(obj: AonObject) {
    if (!this.node || !obj.objectHash) return;
    const announcement = {
      messageType: "aon_object_announcement",
      objectHash: obj.objectHash,
      summary: this.objectSummary(obj),
      from: this.selfPeerInfo(),
      announcedAt: Date.now(),
    };
    // Gossipsub handles fan-out — no need to also open direct streams to every peer.
    await this.node.services.pubsub.publish(TOPIC, this.jsonBytes(announcement));
    console.log("[p2p] announced object hash via gossipsub", {
      objectHash: obj.objectHash,
      peers: this.node.getPeers().length,
    });
  }

  async requestObject(hash: string, peerId: string): Promise<AonObject> {
    if (!this.node) throw new Error("P2P_NOT_STARTED");
    return this.fetchObjectFromPeer(peerIdFromString(peerId), hash);
  }

  async dialPeer(addr: string) {
    if (!this.node) throw new Error("P2P_NOT_STARTED");
    await this.node.dial(multiaddr(addr));
    return { ok: true };
  }

  async exchangePeers(peerIdString: string) {
    if (!this.node) throw new Error("P2P_NOT_STARTED");
    const peerId = peerIdFromString(peerIdString);
    const stream: any = await this.node.dialProtocol(peerId, PEER_PROTOCOL);
    await this.writeJsonToStream(stream, {
      messageType: "aon_peer_exchange_request",
      from: this.selfPeerInfo(),
    });
    const response = await this.readJsonFromStream(stream.source ?? stream);
    const dialResults = [];
    for (const info of response.peers ?? []) {
      dialResults.push(await this.dialPeerInfo(info));
    }
    return { ...response, dialResults };
  }

  getInfo() {
    if (!this.node) {
      return { started: false, peerId: null, addrs: [], peers: [] };
    }
    return {
      started: this.started,
      peerId: this.node.peerId.toString(),
      addrs: this.node.getMultiaddrs().map((a) => a.toString()),
      peers: this.node.getPeers().map((p) => p.toString()),
    };
  }

  getPubsubInfo() {
    if (!this.node) {
      return { started: false, topic: TOPIC, peers: [], subscribers: [] };
    }
    const pubsub: any = this.node.services.pubsub;
    return {
      started: this.started,
      topic: TOPIC,
      peers: this.node.getPeers().map((p) => p.toString()),
      subscribers:
        typeof pubsub.getSubscribers === "function"
          ? pubsub.getSubscribers(TOPIC).map((p: any) => p.toString())
          : [],
    };
  }
}
