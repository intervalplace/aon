// transports/lora.ts
//
// AonTransport implementation over LoRa radio using a serial-connected
// LoRa module (e.g. RYLR998, SX1276, E32, or any AT-command compatible module).
//
// LoRa constraints that shape this implementation:
//   - Low bandwidth: ~250 bytes/sec at SF7, much less at higher spreading factors
//   - No internet dependency: works completely offline
//   - Broadcast medium: all nodes in range receive all transmissions
//   - No guaranteed delivery: packets may be lost silently
//   - Max payload: typically 222 bytes at SF7 (varies by module and region)
//
// Design decisions:
//   - Objects are serialized to compact JSON then chunked into MAX_CHUNK_SIZE frames
//   - Each frame carries: peerId(6) | msgId(4) | chunkIdx(1) | totalChunks(1) | payload
//   - Announcement frames carry only the objectHash (32 bytes) — object body fetched separately
//   - Object fetch uses a request/response pattern over broadcast with peerId filtering
//   - Peer discovery uses periodic beacon broadcasts
//   - No encryption at this layer — add at the application layer if needed
//
// Hardware setup:
//   Connect LoRa module to serial port (USB-to-serial or GPIO UART)
//   Set AON_LORA_PORT=/dev/ttyUSB0 (or COM3 on Windows)
//   Set AON_LORA_BAUD=9600 (match your module's baud rate)
//   Set AON_LORA_NODE_ID=AABBCCDDEEAA (6-byte hex peer ID, unique per node)
//
// Example wiring (RYLR998):
//   VCC → 3.3V
//   GND → GND
//   TX  → RX on USB-serial adapter
//   RX  → TX on USB-serial adapter
//
// Usage:
//   import { LoRaTransport } from "./transports/lora.js";
//   const transport: AonTransport = new LoRaTransport();

import { createRequire } from "module";
import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import type { AonObject } from "../object.js";
import type { AonTransport, PeerInfo } from "../transport.js";

// SerialPort is a runtime dependency — only needed when LoRa transport is used.
// Install with: npm install serialport
const require = createRequire(import.meta.url);

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CHUNK_SIZE     = 200;   // bytes per LoRa frame payload
const HEADER_SIZE        = 12;    // peerId(6) + msgId(4) + chunkIdx(1) + totalChunks(1)
const MAX_PAYLOAD        = MAX_CHUNK_SIZE - HEADER_SIZE;  // 188 bytes usable per frame
const BEACON_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SEEN_MAX           = 10_000;

const MSG_ANNOUNCE  = 0x01;  // objectHash announcement
const MSG_REQUEST   = 0x02;  // request object by hash
const MSG_RESPONSE  = 0x03;  // object response chunk
const MSG_BEACON    = 0x04;  // peer discovery beacon
const MSG_PEER_LIST = 0x05;  // peer list exchange

// ── Framing ───────────────────────────────────────────────────────────────────
//
// Frame layout (all fields big-endian):
//
//   Byte 0-5:   peerId       (6 bytes, sender's node ID)
//   Byte 6:     msgType      (1 byte)
//   Byte 7-10:  msgId        (4 bytes, random per logical message)
//   Byte 11:    chunkIdx     (1 byte, 0-indexed)
//   Byte 12:    totalChunks  (1 byte)
//   Byte 13+:   payload      (up to 188 bytes)

function encodePeerId(hex: string): Buffer {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").slice(0, 12).padStart(12, "0");
  return Buffer.from(clean, "hex");
}

function decodePeerId(buf: Buffer, offset: number): string {
  return buf.subarray(offset, offset + 6).toString("hex").toUpperCase();
}

function buildFrames(
  peerId: Buffer,
  msgType: number,
  msgId: Buffer,
  data: Buffer
): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += MAX_PAYLOAD) {
    chunks.push(data.subarray(i, i + MAX_PAYLOAD));
  }

  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  if (chunks.length > 255) throw new Error("LORA_MESSAGE_TOO_LARGE");

  return chunks.map((chunk, idx) => {
    const frame = Buffer.alloc(HEADER_SIZE + 1 + chunk.length);
    peerId.copy(frame, 0);
    frame[6] = msgType;
    msgId.copy(frame, 7);
    frame[11] = idx;
    frame[12] = chunks.length;
    chunk.copy(frame, 13);
    return frame;
  });
}

function newMsgId(): Buffer {
  return randomBytes(4);
}

// ── Reassembly buffer ─────────────────────────────────────────────────────────

type IncomingMessage = {
  peerId: string;
  msgType: number;
  chunks: (Buffer | null)[];
  totalChunks: number;
  receivedAt: number;
};

// ── LoRa serial interface ─────────────────────────────────────────────────────
//
// Wraps a SerialPort in an async send/receive interface.
// Handles AT-command style modules (RYLR998) as well as raw binary modules.

class LoRaSerial extends EventEmitter {
  private port: any = null;
  private buffer = Buffer.alloc(0);
  private mode: "at" | "raw";

  constructor(
    private portPath: string,
    private baudRate: number,
    mode: "at" | "raw" = "at"
  ) {
    super();
    this.mode = mode;
  }

  async open() {
    const { SerialPort } = require("serialport");

    this.port = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      this.port.open((err: any) => (err ? reject(err) : resolve()));
    });

    this.port.on("data", (data: Buffer) => this.onData(data));
    this.port.on("error", (err: Error) => this.emit("error", err));

    console.log("[lora] serial port opened", { port: this.portPath, baud: this.baudRate });
  }

  async close() {
    if (!this.port) return;
    await new Promise<void>((resolve) => this.port.close(() => resolve()));
    this.port = null;
  }

  // Send raw bytes over serial.
  // For AT-command modules (RYLR998), wraps in: AT+SEND=0,<len>,<hex>\r\n
  async send(data: Buffer) {
    if (!this.port) throw new Error("LORA_SERIAL_NOT_OPEN");

    let out: Buffer;
    if (this.mode === "at") {
      const hex = data.toString("hex").toUpperCase();
      out = Buffer.from(`AT+SEND=0,${data.length},${hex}\r\n`);
    } else {
      out = data;
    }

    await new Promise<void>((resolve, reject) => {
      this.port.write(out, (err: any) => (err ? reject(err) : resolve()));
    });
  }

  // Parse incoming serial data into frames.
  // AT mode: parses "+RCV=<addr>,<len>,<data>,<rssi>,<snr>\r\n"
  // Raw mode: emits each fixed-size frame directly
  private onData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);

    if (this.mode === "at") {
      this.parseAtBuffer();
    } else {
      this.parseRawBuffer();
    }
  }

  private parseAtBuffer() {
    while (true) {
      const nl = this.buffer.indexOf("\r\n");
      if (nl === -1) break;

      const line = this.buffer.subarray(0, nl).toString("ascii");
      this.buffer = this.buffer.subarray(nl + 2);

      if (!line.startsWith("+RCV=")) continue;

      // +RCV=<addr>,<len>,<data_hex>,<rssi>,<snr>
      const parts = line.slice(5).split(",");
      if (parts.length < 4) continue;

      try {
        const hexData = parts[2];
        const frame = Buffer.from(hexData, "hex");
        if (frame.length >= HEADER_SIZE + 1) {
          this.emit("frame", frame);
        }
      } catch {
        // malformed frame — ignore
      }
    }
  }

  private parseRawBuffer() {
    // For raw binary modules, frames are length-prefixed: [2-byte length][data]
    while (this.buffer.length >= 2) {
      const frameLen = this.buffer.readUInt16BE(0);
      if (this.buffer.length < 2 + frameLen) break;

      const frame = this.buffer.subarray(2, 2 + frameLen);
      this.buffer = this.buffer.subarray(2 + frameLen);

      if (frame.length >= HEADER_SIZE + 1) {
        this.emit("frame", frame);
      }
    }
  }
}

// ── LoRaTransport ─────────────────────────────────────────────────────────────

export class LoRaTransport implements AonTransport {
  private serial: LoRaSerial | null = null;
  private started = false;
  private stopping = false;
  private peerId: string;
  private peerIdBuf: Buffer;
  private peers = new Map<string, { addrs: string[]; lastSeen: number }>();
  private seenMessages = new Set<string>();
  private incoming = new Map<string, IncomingMessage>();
  private beaconTimer:  NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;

  // Pending request/response state
  private pendingRequests = new Map<
    string,
    { resolve: (obj: AonObject) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor() {
    const nodeId = process.env.AON_LORA_NODE_ID ?? randomBytes(6).toString("hex").toUpperCase();
    this.peerId = nodeId.replace(/[^0-9a-fA-F]/g, "").slice(0, 12).toUpperCase();
    this.peerIdBuf = encodePeerId(this.peerId);
  }

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;
  }

  // ── Send helpers ───────────────────────────────────────────────────────────

  private async sendFrames(msgType: number, data: Buffer) {
    if (!this.serial) throw new Error("LORA_NOT_STARTED");
    const msgId = newMsgId();
    const frames = buildFrames(this.peerIdBuf, msgType, msgId, data);

    for (const frame of frames) {
      await this.serial.send(frame);
      // Brief inter-frame gap to avoid collisions on shared medium
      if (frames.length > 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  // ── Receive handling ───────────────────────────────────────────────────────

  private onFrame(frame: Buffer) {
    if (frame.length < HEADER_SIZE + 1) return;

    const fromPeerId = decodePeerId(frame, 0);
    if (fromPeerId === this.peerId) return; // our own broadcast

    const msgType    = frame[6];
    const msgId      = frame.subarray(7, 11).toString("hex");
    const chunkIdx   = frame[11];
    const totalChunks = frame[12];
    const payload    = frame.subarray(13);

    // Deduplicate completed messages
    const msgKey = `${fromPeerId}:${msgId}`;

    // Reassemble multi-chunk messages
    let msg = this.incoming.get(msgKey);
    if (!msg) {
      msg = {
        peerId: fromPeerId,
        msgType,
        chunks: new Array(totalChunks).fill(null),
        totalChunks,
        receivedAt: Date.now(),
      };
      this.incoming.set(msgKey, msg);
    }

    if (chunkIdx < msg.chunks.length) {
      msg.chunks[chunkIdx] = payload;
    }

    const complete = msg.chunks.every((c) => c !== null);
    if (!complete) return;

    // All chunks received — reassemble
    this.incoming.delete(msgKey);

    if (this.seenMessages.has(msgKey)) return;
    this.seenMessages.add(msgKey);
    if (this.seenMessages.size > SEEN_MAX) {
      const first = this.seenMessages.values().next().value;
      if (first) this.seenMessages.delete(first);
    }

    const data = Buffer.concat(msg.chunks as Buffer[]);
    this.handleMessage(fromPeerId, msgType, data).catch((err) => {
      console.error("[lora] message handler failed", err);
    });
  }

  private async handleMessage(fromPeerId: string, msgType: number, data: Buffer) {
    // Update peer registry
    this.peers.set(fromPeerId, {
      addrs: [`lora:${fromPeerId}`],
      lastSeen: Date.now(),
    });

    switch (msgType) {
      case MSG_ANNOUNCE:
        await this.handleAnnouncement(fromPeerId, data);
        break;

      case MSG_REQUEST:
        await this.handleObjectRequest(fromPeerId, data);
        break;

      case MSG_RESPONSE:
        await this.handleObjectResponse(fromPeerId, data);
        break;

      case MSG_BEACON:
        // Peer already registered above — optionally send our peer list back
        await this.handleBeacon(fromPeerId, data);
        break;

      case MSG_PEER_LIST:
        await this.handlePeerList(data);
        break;
    }
  }

  private async handleAnnouncement(fromPeerId: string, data: Buffer) {
    // Announcement: 32-byte objectHash
    if (data.length < 32) return;
    const objectHash = "0x" + data.subarray(0, 32).toString("hex");

    console.log("[lora] received announcement", { objectHash, from: fromPeerId });

    // Fetch the object from the announcing peer
    try {
      const obj = await this.fetchFromPeer(fromPeerId, objectHash);
      if (obj && this.objectHandler) {
        await this.objectHandler(obj);
        // Rebroadcast to propagate further
        await this.announceObject(obj);
      }
    } catch (err: any) {
      console.error("[lora] fetch after announcement failed", {
        objectHash,
        from: fromPeerId,
        error: err?.message,
      });
    }
  }

  private async handleObjectRequest(fromPeerId: string, data: Buffer) {
    // Request: 32-byte objectHash we're being asked to serve
    if (data.length < 32) return;
    const objectHash = "0x" + data.subarray(0, 32).toString("hex");

    console.log("[lora] received object request", { objectHash, from: fromPeerId });

    try {
      const { getObject } = await import("../store.js");
      const obj = getObject(objectHash);
      if (!obj) {
        console.log("[lora] requested object not found", { objectHash });
        return;
      }

      // Respond with the serialized object
      const payload = Buffer.from(JSON.stringify({ objectHash, object: obj }));
      await this.sendFrames(MSG_RESPONSE, payload);
    } catch (err: any) {
      console.error("[lora] object request handler failed", err?.message);
    }
  }

  private async handleObjectResponse(fromPeerId: string, data: Buffer) {
    try {
      const msg = JSON.parse(data.toString("utf8"));
      const { objectHash, object } = msg;
      if (!objectHash || !object) return;

      console.log("[lora] received object response", { objectHash, from: fromPeerId });

      // Resolve any pending request for this hash
      // Find any pending request for this objectHash (may have unique reqId suffix)
      const hashLower = objectHash.toLowerCase();
      const pendingKey = [...this.pendingRequests.keys()].find(k => k.startsWith(hashLower));
      const pending = pendingKey ? this.pendingRequests.get(pendingKey) : undefined;
      if (pending && pendingKey) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(pendingKey);
        pending.resolve(object);
      }

      // Also store via handler in case we get an unsolicited response
      if (this.objectHandler) {
        await this.objectHandler(object);
      }
    } catch {
      // malformed response — ignore
    }
  }

  private async handleBeacon(fromPeerId: string, data: Buffer) {
    // Beacon carries the sender's peer list as compact JSON
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (Array.isArray(msg.peers)) {
        for (const p of msg.peers) {
          if (p.peerId && p.peerId !== this.peerId && !this.peers.has(p.peerId)) {
            this.peers.set(p.peerId, { addrs: p.addrs ?? [], lastSeen: 0 });
          }
        }
      }
    } catch {
      // ignore malformed beacon
    }
  }

  private async handlePeerList(data: Buffer) {
    try {
      const list = JSON.parse(data.toString("utf8"));
      if (!Array.isArray(list)) return;
      for (const p of list) {
        if (p.peerId && p.peerId !== this.peerId) {
          this.peers.set(p.peerId, { addrs: p.addrs ?? [], lastSeen: 0 });
        }
      }
    } catch {
      // ignore
    }
  }

  private requestCounter = 0;

  private async fetchFromPeer(peerId: string, objectHash: string): Promise<AonObject> {
    return new Promise((resolve, reject) => {
      // Use a unique request ID so concurrent requests for the same hash
      // don't overwrite each other's callbacks
      const reqId = `${objectHash.toLowerCase()}-${++this.requestCounter}`;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error("LORA_REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(reqId, { resolve, reject, timer });

      // Send the request — 32-byte hash as binary
      const hashBuf = Buffer.from(objectHash.toLowerCase().replace("0x", ""), "hex");
      this.sendFrames(MSG_REQUEST, hashBuf).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        reject(err);
      });
    });
  }

  // ── AonTransport interface ─────────────────────────────────────────────────

  async start() {
    if (this.started) return;

    const portPath = process.env.AON_LORA_PORT;
    if (!portPath) throw new Error("AON_LORA_PORT not set — set to your serial port (e.g. /dev/ttyUSB0)");

    const baudRate = Number(process.env.AON_LORA_BAUD ?? 9600);
    const mode = (process.env.AON_LORA_MODE ?? "at") as "at" | "raw";

    this.serial = new LoRaSerial(portPath, baudRate, mode);
    this.serial.on("frame", (frame: Buffer) => this.onFrame(frame));
    this.serial.on("error", (err: Error) => console.error("[lora] serial error", err));

    await this.serial.open();

    // Periodic beacon for peer discovery
    this.beaconTimer = setInterval(async () => {
      if (this.stopping) return;
      try {
        await this.sendBeacon();
      } catch (err: any) {
        console.error("[lora] beacon failed", err?.message);
      }
    }, BEACON_INTERVAL_MS);

    // Evict incomplete reassembly buffers — prevents memory exhaustion when
    // chunks are lost (common on LoRa). Any incomplete message older than 60s
    // is discarded.
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      for (const [key, msg] of this.incoming) {
        if (msg.receivedAt < cutoff) {
          this.incoming.delete(key);
        }
      }
    }, 30_000);

    this.started = true;
    console.log("[lora] started", {
      peerId: this.peerId,
      port: portPath,
      baud: baudRate,
      mode,
    });

    // Initial beacon
    await this.sendBeacon();
  }

  async stop() {
    this.stopping = true;
    if (this.beaconTimer)  { clearInterval(this.beaconTimer);  this.beaconTimer  = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    if (this.serial) { await this.serial.close(); this.serial = null; }
    this.started = false;
  }

  async announceObject(obj: AonObject) {
    if (!this.serial || !obj.objectHash) return;

    const hashHex = obj.objectHash.toLowerCase().replace("0x", "");
    const hashBuf = Buffer.from(hashHex.padStart(64, "0"), "hex");

    await this.sendFrames(MSG_ANNOUNCE, hashBuf);

    console.log("[lora] announced object", {
      objectHash: obj.objectHash,
      peers: this.peers.size,
    });
  }

  async requestObject(hash: string, peerId: string): Promise<AonObject> {
    if (!this.started) throw new Error("LORA_NOT_STARTED");
    return this.fetchFromPeer(peerId, hash);
  }

  async dialPeer(addr: string) {
    // LoRa is a broadcast medium — there's no connection to dial.
    // "Dialing" a LoRa peer just registers them as known and sends a beacon.
    // addr format: "lora:{peerId}" or just the 12-hex-char peerId
    const peerId = addr.replace("lora:", "").toUpperCase();
    this.peers.set(peerId, { addrs: [`lora:${peerId}`], lastSeen: 0 });

    try {
      await this.sendBeacon();
    } catch {
      // non-fatal
    }

    console.log("[lora] registered peer", { peerId });
    return { ok: true };
  }

  async exchangePeers(peerId: string) {
    if (!this.started) throw new Error("LORA_NOT_STARTED");

    // Broadcast our peer list — all nodes in range will receive it
    const list = this.peerList();
    const data = Buffer.from(JSON.stringify(list));
    await this.sendFrames(MSG_PEER_LIST, data);

    return {
      ok: true,
      self: { peerId: this.peerId, addrs: [`lora:${this.peerId}`] },
      peers: list,
      dialResults: [],
    };
  }

  getInfo() {
    return {
      started: this.started,
      peerId: this.peerId,
      addrs: [`lora:${this.peerId}`],
      peers: [...this.peers.keys()],
    };
  }

  getPubsubInfo() {
    // LoRa uses broadcast — there's no pubsub topic in the libp2p sense.
    // Report as a single shared topic.
    return {
      started: this.started,
      topic: "/aon/lora/1",
      peers: [...this.peers.keys()],
      subscribers: [...this.peers.keys()],
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private peerList(): PeerInfo[] {
    return [...this.peers.entries()].map(([peerId, info]) => ({
      peerId,
      addrs: info.addrs,
    }));
  }

  private async sendBeacon() {
    // Truncate peer list — a large peer list can exceed the 255-chunk LoRa limit
    const beacon = {
      peerId: this.peerId,
      peers: this.peerList().slice(0, 20),
      ts: Date.now(),
    };
    const data = Buffer.from(JSON.stringify(beacon));
    await this.sendFrames(MSG_BEACON, data);
  }
}
