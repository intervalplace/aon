// transports/websocket.ts
//
// AonTransport implementation over WebSocket.
//
// This transport serves two distinct roles simultaneously:
//
//   1. Server — listens for inbound WebSocket connections from browsers,
//      lightweight clients, and other nodes. Any connected client receives
//      object announcements in real time and can submit objects back.
//
//   2. Client — connects outbound to other AON WebSocket nodes as a peer,
//      enabling node-to-node propagation over WebSocket in addition to libp2p.
//
// Why this matters:
//   - Browsers can connect directly — no libp2p, no node.js required
//   - Executors get real-time object delivery instead of polling
//   - Lightweight IoT devices can participate with minimal dependencies
//   - WebSocket works through most firewalls and proxies that block raw TCP
//   - Runs over TLS (wss://) for encrypted transport
//
// Message protocol:
//   All messages are JSON with a "type" field:
//
//   { type: "announce", objectHash, summary }
//     — sent by node when a new object arrives from any transport
//
//   { type: "object", objectHash, object }
//     — full object, sent in response to a request or on push
//
//   { type: "request", objectHash, requestId }
//     — client asks for a specific object by hash
//
//   { type: "response", objectHash, object, requestId }
//     — node responds with the requested object
//
//   { type: "submit", object }
//     — client submits a new object to the node
//
//   { type: "peers" }
//     — request peer list
//
//   { type: "peer_list", peers }
//     — response with known peers
//
//   { type: "ping" } / { type: "pong" }
//     — keepalive
//
// Configuration:
//   AON_WS_PORT         — WebSocket server port (default: 8788)
//   AON_WS_PEERS        — comma-separated ws:// or wss:// URLs to connect to
//   AON_WS_MAX_CLIENTS  — max simultaneous client connections (default: 100)
//
// Usage:
//   import { WebSocketTransport } from "./transports/websocket.js";
//   const transport: AonTransport = new WebSocketTransport();
//
// In browser (no node required):
//   const ws = new WebSocket("ws://localhost:8788");
//   ws.onmessage = (e) => {
//     const msg = JSON.parse(e.data);
//     if (msg.type === "announce") console.log("new object:", msg.objectHash);
//   };
//   ws.send(JSON.stringify({ type: "submit", object: myAuthObject }));

import { createServer, type IncomingMessage, type Server } from "http";
import { getObject } from "../store.js";
import { randomBytes } from "crypto";
import { createRequire } from "module";
import type { AonObject } from "../object.js";
import type { AonTransport, PeerInfo } from "../transport.js";

// ws is a runtime dependency — install with: npm install ws
const require = createRequire(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────────────

type WsMessage =
  | { type: "announce"; objectHash: string; summary: ObjectSummary }
  | { type: "object"; objectHash: string; object: AonObject }
  | { type: "request"; objectHash: string; requestId: string }
  | { type: "response"; objectHash: string; object: AonObject; requestId: string }
  | { type: "submit"; object: AonObject }
  | { type: "peers" }
  | { type: "peer_list"; peers: PeerInfo[] }
  | { type: "ping" }
  | { type: "pong" };

type ObjectSummary = {
  objectHash: string;
  objectType: string;
  namespace: string;
  createdAt: number;
  references: string[];
};

type ConnectedPeer = {
  peerId: string;
  ws: any;
  url?: string;           // set for outbound connections
  connectedAt: number;
  lastSeen: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS    = 30_000;
const REQUEST_TIMEOUT_MS  = 10_000;
const RECONNECT_DELAY_MS  = 5_000;
const SEEN_MAX            = 10_000;

// ── WebSocketTransport ────────────────────────────────────────────────────────

export class WebSocketTransport implements AonTransport {
  private server: Server | null = null;
  private wss: any = null;
  private started = false;
  private stopping = false;

  private peers = new Map<string, ConnectedPeer>();
  private seenHashes = new Set<string>();
  private pingTimer: NodeJS.Timeout | null = null;
  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;

  // Pending request/response state
  private pendingRequests = new Map<
    string,
    { resolve: (obj: AonObject) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  private readonly wsPort: number;
  private readonly peerUrls: string[];
  private readonly maxClients: number;
  private readonly nodeId: string;

  constructor() {
    this.wsPort    = Number(process.env.AON_WS_PORT ?? 8788);
    this.peerUrls  = (process.env.AON_WS_PEERS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    this.maxClients = Number(process.env.AON_WS_MAX_CLIENTS ?? 100);
    this.nodeId    = randomBytes(6).toString("hex").toUpperCase();
  }

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;
  }

  // ── Send helpers ───────────────────────────────────────────────────────────

  private send(ws: any, msg: WsMessage) {
    if (ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore — peer disconnected
    }
  }

  private broadcast(msg: WsMessage, except?: any) {
    for (const peer of this.peers.values()) {
      if (peer.ws === except) continue;
      this.send(peer.ws, msg);
    }
  }

  private objectSummary(obj: AonObject): ObjectSummary {
    return {
      objectHash: obj.objectHash!,
      objectType: obj.objectType,
      namespace:  obj.namespace,
      createdAt:  obj.createdAt,
      references: obj.references,
    };
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async handleMessage(ws: any, peerId: string, raw: string) {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // malformed — ignore
    }

    // Update last seen
    const peer = this.peers.get(peerId);
    if (peer) peer.lastSeen = Date.now();

    switch (msg.type) {
      case "submit":
        await this.handleSubmit(ws, msg.object);
        break;

      case "request":
        await this.handleRequest(ws, msg.objectHash, msg.requestId);
        break;

      case "response":
        this.handleResponse(msg.objectHash, msg.object, msg.requestId);
        break;

      case "announce":
        await this.handleAnnouncement(ws, msg.objectHash);
        break;

      case "peers":
        this.send(ws, { type: "peer_list", peers: this.peerList() });
        break;

      case "peer_list":
        // Peer discovery — we don't auto-connect here, just log
        console.log("[ws] received peer list", {
          from: peerId,
          count: (msg as any).peers?.length ?? 0,
        });
        break;

      case "ping":
        this.send(ws, { type: "pong" });
        break;

      case "pong":
        break; // keepalive acknowledged
    }
  }

  private async handleSubmit(ws: any, object: AonObject) {
    if (!object || !this.objectHandler) return;

    try {
      await this.objectHandler(object);
      // Cross-propagate to all peers including the submitter
      // (submitter may be a browser that doesn't need it back, but other
      // peers should receive it — the node's deduplication handles the rest)
      await this.announceObject(object);
    } catch (err: any) {
      console.error("[ws] submit failed", err?.message);
    }
  }

  private async handleRequest(ws: any, objectHash: string, requestId: string) {
    try {
      const obj = getObject(objectHash);
      if (!obj) return; // we don't have it — no response
      this.send(ws, { type: "response", objectHash, object: obj, requestId });
    } catch (err: any) {
      console.error("[ws] request handler failed", err?.message);
    }
  }

  private handleResponse(objectHash: string, object: AonObject, requestId: string) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve(object);
  }

  private async handleAnnouncement(ws: any, objectHash: string) {
    const h = objectHash?.toLowerCase();
    if (!h || this.seenHashes.has(h)) return;

    this.seenHashes.add(h);
    if (this.seenHashes.size > SEEN_MAX) {
      const first = this.seenHashes.values().next().value;
      if (first) this.seenHashes.delete(first);
    }

    // Request the full object from the announcing peer
    const requestId = randomBytes(4).toString("hex");

    try {
      const obj = await new Promise<AonObject>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error("WS_REQUEST_TIMEOUT"));
        }, REQUEST_TIMEOUT_MS);

        this.pendingRequests.set(requestId, { resolve, reject, timer });
        this.send(ws, { type: "request", objectHash, requestId });
      });

      if (this.objectHandler) {
        await this.objectHandler(obj);
      }

      // Propagate to other peers
      await this.announceObject(obj);
    } catch (err: any) {
      console.error("[ws] fetch after announcement failed", {
        objectHash,
        error: err?.message,
      });
    }
  }

  // ── Connection management ──────────────────────────────────────────────────

  private registerPeer(ws: any, url?: string): string {
    const peerId = randomBytes(6).toString("hex").toUpperCase();
    this.peers.set(peerId, {
      peerId,
      ws,
      url,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    });
    return peerId;
  }

  private removePeer(peerId: string) {
    this.peers.delete(peerId);
  }

  private attachHandlers(ws: any, peerId: string) {
    ws.on("message", (data: any) => {
      const raw = typeof data === "string" ? data : data.toString();
      this.handleMessage(ws, peerId, raw).catch((err) => {
        console.error("[ws] message handler error", err);
      });
    });

    ws.on("close", () => {
      console.log("[ws] peer disconnected", { peerId });
      this.removePeer(peerId);
    });

    ws.on("error", (err: Error) => {
      console.error("[ws] peer error", { peerId, error: err.message });
      this.removePeer(peerId);
    });
  }

  private async connectToPeer(url: string, backoffMs = RECONNECT_DELAY_MS) {
    if (this.stopping) return;

    console.log("[ws] connecting to peer", { url });

    try {
      const { WebSocket } = require("ws");
      const ws = new WebSocket(url);

      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        setTimeout(() => reject(new Error("WS_CONNECT_TIMEOUT")), 10_000);
      });

      const peerId = this.registerPeer(ws, url);
      this.attachHandlers(ws, peerId);

      // Exchange peers on connect
      this.send(ws, { type: "peers" });

      console.log("[ws] connected to peer", { url, peerId });

      // Reconnect on close with exponential backoff — pass current backoff
      // as parameter so it actually increases across reconnect attempts
      ws.once("close", () => {
        if (!this.stopping) {
          const next = Math.min(backoffMs * 2, 60_000);
          setTimeout(() => this.connectToPeer(url, next), backoffMs);
        }
      });
    } catch (err: any) {
      console.error("[ws] peer connection failed", { url, error: err?.message });
      if (!this.stopping) {
        const next = Math.min(backoffMs * 2, 60_000);
        setTimeout(() => this.connectToPeer(url, next), backoffMs);
      }
    }
  }

  // ── AonTransport interface ─────────────────────────────────────────────────

  async start() {
    if (this.started) return;

    const { WebSocketServer } = require("ws");

    this.server = createServer();
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: Number(process.env.AON_WS_MAX_PAYLOAD ?? 1_000_000), // 1MB default
    });

    this.wss.on("connection", (ws: any, req: IncomingMessage) => {
      if (this.peers.size >= this.maxClients) {
        ws.close(1013, "Too many clients");
        return;
      }

      const peerId = this.registerPeer(ws);
      this.attachHandlers(ws, peerId);

      console.log("[ws] client connected", {
        peerId,
        ip: req.socket.remoteAddress,
        totalPeers: this.peers.size,
      });

      // Send peer list to newly connected client
      this.send(ws, { type: "peer_list", peers: this.peerList() });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.wsPort, resolve);
    });

    // Keepalive ping loop
    this.pingTimer = setInterval(() => {
      if (this.stopping) return;
      for (const peer of this.peers.values()) {
        this.send(peer.ws, { type: "ping" });
      }
    }, PING_INTERVAL_MS);

    // Connect to configured peer URLs
    for (const url of this.peerUrls) {
      this.connectToPeer(url);
    }

    this.started = true;
    console.log("[ws] started", {
      nodeId: this.nodeId,
      port: this.wsPort,
      peers: this.peerUrls,
    });
  }

  async stop() {
    this.stopping = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    for (const peer of this.peers.values()) {
      try { peer.ws.close(); } catch { /* ignore */ }
    }
    this.peers.clear();
    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.started = false;
  }

  async announceObject(obj: AonObject) {
    if (!obj.objectHash || this.peers.size === 0) return;

    this.broadcast({
      type: "announce",
      objectHash: obj.objectHash,
      summary: this.objectSummary(obj),
    });

    console.log("[ws] announced object", {
      objectHash: obj.objectHash,
      peers: this.peers.size,
    });
  }

  async requestObject(hash: string, peerId: string): Promise<AonObject> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("WS_PEER_NOT_FOUND");

    const requestId = randomBytes(4).toString("hex");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("WS_REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.send(peer.ws, { type: "request", objectHash: hash, requestId });
    });
  }

  async dialPeer(addr: string) {
    // Only handle ws:// or wss:// addresses
    if (!addr.startsWith("ws://") && !addr.startsWith("wss://")) {
      return { ok: false, reason: "WS_UNRECOGNIZED_ADDR" };
    }

    // Already connected
    const existing = [...this.peers.values()].find((p) => p.url === addr);
    if (existing) return { ok: true, reason: "ALREADY_CONNECTED" };

    this.connectToPeer(addr);
    return { ok: true };
  }

  async exchangePeers(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("WS_PEER_NOT_FOUND");

    // Send peer list request and wait for the response
    const remotePeers = await new Promise<PeerInfo[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WS_PEER_EXCHANGE_TIMEOUT")), 5_000);
      const handler = (msg: WsMessage) => {
        if (msg.type === "peer_list") {
          clearTimeout(timeout);
          peer.ws.off("message", rawHandler);
          resolve(msg.peers ?? []);
        }
      };
      const rawHandler = (data: any) => {
        try { handler(JSON.parse(data.toString())); } catch {}
      };
      peer.ws.on("message", rawHandler);
      this.send(peer.ws, { type: "peers" });
    }).catch(() => [] as PeerInfo[]);

    // Dial up to 10 returned peers
    const toTry = remotePeers.slice(0, 10);
    const dialResults = await Promise.allSettled(
      toTry.map((info: any) => {
        const addr = (info.addrs ?? []).find(
          (a: string) => a.startsWith("ws://") || a.startsWith("wss://")
        );
        return addr
          ? this.dialPeer(addr)
          : Promise.resolve({ ok: false, reason: "NO_WS_ADDR" });
      })
    );

    return {
      peers: remotePeers,
      dialResults: dialResults.map(r => r.status === "fulfilled" ? r.value : null),
    };
  }

  getInfo() {
    return {
      started: this.started,
      peerId: this.nodeId,
      addrs: [`ws://0.0.0.0:${this.wsPort}`],
      peers: [...this.peers.keys()],
    };
  }

  getPubsubInfo() {
    return {
      started: this.started,
      topic: "/aon/ws/1",
      peers: [...this.peers.keys()],
      subscribers: [...this.peers.keys()],
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private peerList(): PeerInfo[] {
    return [...this.peers.values()].map((p) => ({
      peerId: p.peerId,
      addrs: p.url ? [p.url] : [`ws://peer:${p.peerId}`],
    }));
  }
}
