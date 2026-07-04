// transports/reticulum.ts
//
// AonTransport implementation over Reticulum Network Stack (RNS).
//
// Reticulum is a cryptographic networking stack designed for reliable
// communication over high-latency, low-bandwidth links. It handles its own
// routing, encryption, path finding, and peer discovery — making it
// significantly more capable than raw LoRa or serial transports.
//
// Reticulum natively supports:
//   - LoRa (via dedicated interfaces)
//   - Serial / KISS interfaces
//   - TCP and UDP (internet-connected interfaces)
//   - I2P (anonymous routing)
//   - Existing hardware: RNode, LimeSDR, HackRF, and more
//
// This means a single Reticulum transport instance can simultaneously
// propagate AON objects over LoRa, I2P, serial, and TCP/UDP — whichever
// interfaces are configured in the Reticulum config file. AON gets all of
// Reticulum's transports for free.
//
// Architecture:
//   Since Reticulum is Python-native, this transport spawns a Python bridge
//   process (aon_rns_bridge.py) and communicates with it via stdin/stdout
//   using newline-delimited JSON. The Node.js transport manages the bridge
//   lifecycle, reconnects on crash, and translates between the AON transport
//   interface and the bridge's message protocol.
//
// Setup:
//   pip install rns
//   Copy aon_rns_bridge.py to your node directory (or set AON_RNS_BRIDGE_PATH)
//   Configure Reticulum interfaces in ~/.reticulum/config (or AON_RNS_CONFIG)
//
// Reticulum config example (~/.reticulum/config):
//   [interfaces]
//     [[RNodeInterface]]
//       type = RNodeInterface
//       interface_enabled = True
//       port = /dev/ttyUSB0
//       frequency = 868000000
//       bandwidth = 125000
//       txpower = 7
//       spreadingfactor = 8
//       codingrate = 5
//
//     [[TCPInterface]]
//       type = TCPServerInterface
//       interface_enabled = True
//       listen_ip = 0.0.0.0
//       listen_port = 4242
//
// Configuration (env vars):
//   AON_RNS_BRIDGE_PATH  — path to aon_rns_bridge.py (default: ./aon_rns_bridge.py)
//   AON_RNS_CONFIG       — Reticulum config directory (default: ~/.reticulum)
//   AON_RNS_PYTHON       — Python interpreter to use (default: python3)
//
// Usage:
//   import { ReticulumTransport } from "./transports/reticulum.js";
//   const transport: AonTransport = new ReticulumTransport();

import { spawn, type ChildProcess } from "child_process";
import { getObject } from "../store.js";
import { createInterface } from "readline";
import { randomBytes } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { AonObject } from "../object.js";
import type { AonTransport, PeerInfo } from "../transport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

type BridgeMessage =
  | { type: "ready";    peerId: string; addrs: string[] }
  | { type: "announce"; objectHash: string; peerId: string }
  | { type: "request";  objectHash: string; requestId: string; peerId: string }
  | { type: "response"; objectHash: string; object: AonObject; requestId: string }
  | { type: "peer";     peerId: string; addrs: string[] }
  | { type: "peer_list"; peers: PeerInfo[] }
  | { type: "error";    message: string };

type HostMessage =
  | { type: "announce"; objectHash: string }
  | { type: "request";  objectHash: string; requestId: string; peerId: string }
  | { type: "response"; objectHash: string; object: AonObject; requestId: string; peerId: string }
  | { type: "dial";     peerId: string }
  | { type: "get_peers" }
  | { type: "stop" };

// ── Constants ─────────────────────────────────────────────────────────────────

const RESTART_DELAY_MS   = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;  // higher than other transports — RNS path finding takes time
const SEEN_MAX           = 10_000;
const READY_TIMEOUT_MS   = 30_000;

// ── ReticulumTransport ────────────────────────────────────────────────────────

export class ReticulumTransport implements AonTransport {
  private bridge: ChildProcess | null = null;
  private started = false;
  private stopping = false;
  private ready = false;

  private selfPeerId: string | null = null;
  private selfAddrs: string[] = [];
  private peers = new Map<string, PeerInfo>();
  private seenHashes = new Set<string>();

  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (obj: AonObject) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  private readonly bridgePath: string;
  private readonly pythonBin: string;
  private readonly rnsConfig: string | null;

  constructor() {
    this.bridgePath = process.env.AON_RNS_BRIDGE_PATH
      ?? resolve(__dirname, "../../aon_rns_bridge.py");
    this.pythonBin  = process.env.AON_RNS_PYTHON ?? "python3";
    this.rnsConfig  = process.env.AON_RNS_CONFIG ?? null;
  }

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;
  }

  // ── Bridge management ──────────────────────────────────────────────────────

  private messageQueue: HostMessage[] = [];
  private readonly MAX_QUEUE = 100;

  private sendToBridge(msg: HostMessage) {
    if (!this.bridge || !this.bridge.stdin || !this.ready) {
      // M15: Queue messages during restart window instead of dropping them
      if (this.messageQueue.length < this.MAX_QUEUE) {
        this.messageQueue.push(msg);
      }
      return;
    }
    // Flush any queued messages first
    while (this.messageQueue.length > 0) {
      const queued = this.messageQueue.shift()!;
      try { this.bridge.stdin.write(JSON.stringify(queued) + "\n"); } catch {}
    }
    try {
      this.bridge.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err: any) {
      console.error("[rns] bridge write error", err?.message);
    }
  }

  private async startBridge(): Promise<void> {
    const env: Record<string, string> = { ...process.env as any };
    if (this.rnsConfig) env.AON_RNS_CONFIG = this.rnsConfig;

    console.log("[rns] spawning bridge", {
      python: this.pythonBin,
      bridge: this.bridgePath,
    });

    this.bridge = spawn(this.pythonBin, [this.bridgePath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Forward bridge stderr to our stderr for visibility
    this.bridge.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    // Parse newline-delimited JSON from bridge stdout
    const rl = createInterface({ input: this.bridge.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as BridgeMessage;
        this.handleBridgeMessage(msg).catch((err) => {
          console.error("[rns] bridge message handler error", err);
        });
      } catch {
        // ignore non-JSON lines
      }
    });

    // Wait for ready signal
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // M14: Kill the bridge process before rejecting — otherwise it keeps
        // running and the exit handler schedules a restart, creating orphan processes
        this.bridge?.kill();
        reject(new Error("RNS_BRIDGE_READY_TIMEOUT"));
      }, READY_TIMEOUT_MS);

      const onReady = () => {
        clearTimeout(timer);
        this.removeListener("ready", onReady);
        resolve();
      };

      this.once("ready", onReady);
    });

    this.bridge.on("exit", (code, signal) => {
      this.ready = false;
      console.error("[rns] bridge exited", { code, signal });

      if (!this.stopping) {
        console.log(`[rns] restarting bridge in ${RESTART_DELAY_MS}ms`);
        setTimeout(() => {
          if (!this.stopping) {
            this.startBridge().catch((err) => {
              console.error("[rns] bridge restart failed", err?.message);
            });
          }
        }, RESTART_DELAY_MS);
      }
    });
  }

  // EventEmitter-lite for ready signal
  private listeners = new Map<string, Array<() => void>>();
  private once(event: string, fn: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
  }
  private removeListener(event: string, fn: () => void) {
    const fns = this.listeners.get(event) ?? [];
    this.listeners.set(event, fns.filter((f) => f !== fn));
  }
  private emit(event: string) {
    const fns = this.listeners.get(event) ?? [];
    this.listeners.set(event, []);
    for (const fn of fns) fn();
  }

  // ── Bridge message handling ────────────────────────────────────────────────

  private async handleBridgeMessage(msg: BridgeMessage) {
    switch (msg.type) {
      case "ready":
        this.selfPeerId = msg.peerId;
        this.selfAddrs  = msg.addrs;
        this.ready      = true;
        console.log("[rns] bridge ready", { peerId: msg.peerId, addrs: msg.addrs });
        this.emit("ready");
        break;

      case "peer":
        this.peers.set(msg.peerId, { peerId: msg.peerId, addrs: msg.addrs });
        break;

      case "peer_list":
        for (const p of msg.peers) {
          this.peers.set(p.peerId, p);
        }
        break;

      case "announce":
        await this.handleAnnouncement(msg.objectHash, msg.peerId);
        break;

      case "request":
        await this.handleRequest(msg.objectHash, msg.requestId, msg.peerId);
        break;

      case "response":
        this.handleResponse(msg.objectHash, msg.object, msg.requestId);
        break;

      case "error":
        console.error("[rns] bridge error", msg.message);
        break;
    }
  }

  private async handleAnnouncement(objectHash: string, fromPeerId: string) {
    const h = objectHash?.toLowerCase();
    if (!h || this.seenHashes.has(h)) return;

    this.seenHashes.add(h);
    if (this.seenHashes.size > SEEN_MAX) {
      const first = this.seenHashes.values().next().value;
      if (first) this.seenHashes.delete(first);
    }

    console.log("[rns] received announcement", { objectHash, from: fromPeerId });

    const requestId = randomBytes(4).toString("hex");

    try {
      const obj = await new Promise<AonObject>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error("RNS_REQUEST_TIMEOUT"));
        }, REQUEST_TIMEOUT_MS);

        this.pendingRequests.set(requestId, { resolve, reject, timer });
        this.sendToBridge({ type: "request", objectHash, requestId, peerId: fromPeerId });
      });

      if (this.objectHandler) await this.objectHandler(obj);
      await this.announceObject(obj);
    } catch (err: any) {
      console.error("[rns] fetch after announcement failed", {
        objectHash,
        error: err?.message,
      });
    }
  }

  private async handleRequest(objectHash: string, requestId: string, fromPeerId: string) {
    try {
      const obj = getObject(objectHash);
      if (!obj) return;

      this.sendToBridge({ type: "response", objectHash, object: obj, requestId, peerId: fromPeerId });
    } catch (err: any) {
      console.error("[rns] request handler failed", err?.message);
    }
  }

  private handleResponse(objectHash: string, object: AonObject, requestId: string) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve(object);
  }

  // ── AonTransport interface ─────────────────────────────────────────────────

  async start() {
    if (this.started) return;
    await this.startBridge();
    this.started = true;
    console.log("[rns] started", { peerId: this.selfPeerId });
  }

  async stop() {
    this.stopping = true;
    this.ready    = false;

    if (this.bridge) {
      try {
        this.sendToBridge({ type: "stop" });
        await new Promise<void>((resolve) => {
          this.bridge!.once("exit", () => resolve());
          setTimeout(resolve, 3_000); // force after 3s
        });
        this.bridge.kill();
      } catch { /* ignore */ }
      this.bridge = null;
    }

    this.started = false;
  }

  async announceObject(obj: AonObject) {
    if (!obj.objectHash || !this.ready) return;
    this.sendToBridge({ type: "announce", objectHash: obj.objectHash });
    console.log("[rns] announced object", { objectHash: obj.objectHash });
  }

  async requestObject(hash: string, peerId: string): Promise<AonObject> {
    if (!this.ready) throw new Error("RNS_NOT_READY");

    const requestId = randomBytes(4).toString("hex");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("RNS_REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.sendToBridge({ type: "request", objectHash: hash, requestId, peerId });
    });
  }

  async dialPeer(addr: string) {
    if (!addr.startsWith("rns://")) {
      return { ok: false, reason: "RNS_UNRECOGNIZED_ADDR" };
    }

    const peerId = addr.replace("rns://", "");
    this.sendToBridge({ type: "dial", peerId });

    return { ok: true };
  }

  async exchangePeers(peerId: string) {
    this.sendToBridge({ type: "get_peers" });
    return { peers: this.peerList(), dialResults: [] };
  }

  getInfo() {
    return {
      started: this.started,
      peerId:  this.selfPeerId,
      addrs:   this.selfAddrs,
      peers:   [...this.peers.keys()],
    };
  }

  getPubsubInfo() {
    return {
      started:     this.started,
      topic:       "/aon/rns/1",
      peers:       [...this.peers.keys()],
      subscribers: [...this.peers.keys()],
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private peerList(): PeerInfo[] {
    return [...this.peers.values()];
  }
}
