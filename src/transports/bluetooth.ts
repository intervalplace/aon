// transports/bluetooth.ts
//
// AonTransport implementation over Bluetooth.
//
// Supports two Bluetooth modes:
//
//   Classic Bluetooth (RFCOMM) — "classic" mode
//     - Connection-oriented, reliable stream, like a serial cable over radio
//     - Range: ~10-100m depending on class
//     - Bandwidth: up to ~3 Mbps (Class 1)
//     - Best for: node-to-node peering in the same building or campus
//     - Requires: npm install bluetooth-serial-port
//
//   Bluetooth Low Energy (BLE) — "ble" mode
//     - Lower power, broadcast-capable, supported on most modern devices
//     - Range: ~10-30m typical
//     - Bandwidth: ~1 Mbps PHY, much less effective throughput
//     - Best for: IoT devices, phones, sensors joining the AON mesh
//     - Requires: npm install @abandonware/noble
//
// Design decisions:
//   - Classic mode uses RFCOMM streams — reliable, ordered, connection-oriented
//   - BLE mode uses a custom GATT service with announce/request/response characteristics
//   - Large objects are chunked for BLE (MTU ~512 bytes negotiated, 20 bytes default)
//   - Peer discovery uses periodic scanning in both modes
//   - AON service UUID identifies AON nodes during discovery
//   - No internet dependency — works completely offline
//
// Configuration:
//   AON_BT_MODE        — "classic" or "ble" (default: "classic")
//   AON_BT_NODE_ID     — 6-byte hex node ID (default: derived from BT address)
//   AON_BT_SCAN_INTERVAL_MS — how often to scan for new peers (default: 60000)
//
// Setup (Linux):
//   sudo apt install bluetooth bluez libbluetooth-dev
//   sudo systemctl start bluetooth
//   sudo hciconfig hci0 up
//   npm install bluetooth-serial-port   # for classic mode
//   npm install @abandonware/noble      # for BLE mode
//
// Setup (macOS):
//   BLE works natively via CoreBluetooth bindings in noble
//   Classic requires a USB Bluetooth adapter with RFCOMM support
//
// Usage:
//   import { BluetoothTransport } from "./transports/bluetooth.js";
//   const transport: AonTransport = new BluetoothTransport();

import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import { createRequire } from "module";
import type { AonObject } from "../object.js";
import type { AonTransport, PeerInfo } from "../transport.js";

const require = createRequire(import.meta.url);

// ── AON Bluetooth identifiers ─────────────────────────────────────────────────
//
// AON uses a fixed UUID to identify itself during Bluetooth discovery.
// Nodes scan for this UUID and connect automatically.

const AON_SERVICE_UUID        = "a01f0001-0000-4000-b000-000000000000";
const AON_ANNOUNCE_CHAR_UUID  = "a01f0002-0000-4000-b000-000000000000";
const AON_REQUEST_CHAR_UUID   = "a01f0003-0000-4000-b000-000000000000";
const AON_RESPONSE_CHAR_UUID  = "a01f0004-0000-4000-b000-000000000000";
const AON_RFCOMM_CHANNEL      = 23;   // fixed RFCOMM channel for classic mode
const AON_RFCOMM_SERVICE_UUID = "a01f000000000000000000000000000001";

// ── Constants ─────────────────────────────────────────────────────────────────

const BLE_MTU             = 512;    // negotiated MTU, conservative default
const BLE_CHUNK_SIZE      = 500;    // bytes per BLE write
const SCAN_INTERVAL_MS    = Number(process.env.AON_BT_SCAN_INTERVAL_MS ?? 60_000);
const REQUEST_TIMEOUT_MS  = 15_000;
const SEEN_MAX            = 10_000;

// ── Message protocol ──────────────────────────────────────────────────────────
//
// Both modes share the same JSON message protocol over their respective streams:
//
//   { type: "announce", objectHash }
//   { type: "request",  objectHash, requestId }
//   { type: "response", objectHash, object, requestId }
//   { type: "peers" }
//   { type: "peer_list", peers }
//   { type: "ping" } / { type: "pong" }

type BtMessage =
  | { type: "announce"; objectHash: string }
  | { type: "request";  objectHash: string; requestId: string }
  | { type: "response"; objectHash: string; object: AonObject; requestId: string }
  | { type: "peers" }
  | { type: "peer_list"; peers: PeerInfo[] }
  | { type: "ping" }
  | { type: "pong" };

type ConnectedPeer = {
  peerId: string;
  address: string;
  connection: any;      // RFCOMM connection or BLE peripheral
  send: (msg: BtMessage) => void;
  lastSeen: number;
};

// ── Classic Bluetooth (RFCOMM) ────────────────────────────────────────────────

class ClassicBluetooth extends EventEmitter {
  private btSerial: any = null;
  private server: any = null;

  async start(onConnection: (conn: any, address: string) => void) {
    const { BluetoothSerialPort } = require("bluetooth-serial-port");
    this.btSerial = new BluetoothSerialPort();

    // Listen for inbound connections
    this.btSerial.listen(
      (conn: any, address: string) => onConnection(conn, address),
      (err: Error) => { if (err) console.error("[bt-classic] listen error", err.message); },
      AON_RFCOMM_CHANNEL
    );

    console.log("[bt-classic] listening on RFCOMM channel", AON_RFCOMM_CHANNEL);
  }

  async stop() {
    if (this.btSerial) {
      try { this.btSerial.closeAll?.(); } catch { /* ignore */ }
      this.btSerial = null;
    }
  }

  async scan(): Promise<Array<{ address: string; name: string }>> {
    return new Promise((resolve) => {
      if (!this.btSerial) { resolve([]); return; }
      const found: Array<{ address: string; name: string }> = [];

      this.btSerial.inquire();
      this.btSerial.on("found", (address: string, name: string) => {
        found.push({ address, name });
      });
      this.btSerial.on("finished", () => resolve(found));

      // Timeout scan after 10s
      setTimeout(() => resolve(found), 10_000);
    });
  }

  async connect(address: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.btSerial) { reject(new Error("BT_NOT_STARTED")); return; }

      this.btSerial.findSerialPortChannel(
        address,
        AON_RFCOMM_CHANNEL,
        (channel: number) => {
          this.btSerial.connect(
            address,
            channel,
            (conn: any) => resolve(conn),
            (err: Error) => reject(err)
          );
        },
        () => reject(new Error("BT_CHANNEL_NOT_FOUND"))
      );
    });
  }

  // Read newline-delimited JSON messages from an RFCOMM connection
  readMessages(conn: any, onMessage: (msg: BtMessage) => void) {
    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onMessage(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
  }

  sendMessage(conn: any, msg: BtMessage) {
    try {
      conn.write(Buffer.from(JSON.stringify(msg) + "\n"), (err: any) => {
        if (err) console.error("[bt-classic] write error", err.message);
      });
    } catch { /* ignore */ }
  }
}

// ── BLE (Bluetooth Low Energy) ────────────────────────────────────────────────

class BLEBluetooth extends EventEmitter {
  private noble: any = null;
  private bleno: any = null;
  private scanning = false;

  async start(onAnnounce: (objectHash: string, peripheral: any) => void) {
    this.noble = require("@abandonware/noble");
    this.bleno = require("@abandonware/bleno");

    // Advertise AON service so other nodes can discover us
    this.bleno.on("stateChange", (state: string) => {
      if (state !== "poweredOn") return;

      const PrimaryService  = this.bleno.PrimaryService;
      const Characteristic  = this.bleno.Characteristic;

      const announceChar = new Characteristic({
        uuid: AON_ANNOUNCE_CHAR_UUID.replace(/-/g, ""),
        properties: ["notify"],
        onSubscribe: () => console.log("[ble] client subscribed to announce"),
      });

      this.emit("announceChar", announceChar);

      this.bleno.startAdvertising("AON Node", [AON_SERVICE_UUID.replace(/-/g, "")]);
      this.bleno.setServices([
        new PrimaryService({
          uuid: AON_SERVICE_UUID.replace(/-/g, ""),
          characteristics: [announceChar],
        }),
      ]);

      console.log("[ble] advertising AON service");
    });

    // Scan for other AON nodes
    this.noble.on("stateChange", (state: string) => {
      if (state === "poweredOn" && !this.scanning) {
        this.noble.startScanning([AON_SERVICE_UUID.replace(/-/g, "")], true);
        this.scanning = true;
        console.log("[ble] scanning for AON nodes");
      }
    });

    this.noble.on("discover", (peripheral: any) => {
      this.emit("peer", peripheral);
    });
  }

  async stop() {
    if (this.noble && this.scanning) {
      this.noble.stopScanning();
      this.scanning = false;
    }
    if (this.bleno) {
      this.bleno.stopAdvertising();
    }
  }

  async connect(peripheral: any): Promise<any> {
    await new Promise<void>((resolve, reject) => {
      peripheral.connect((err: Error) => (err ? reject(err) : resolve()));
    });

    const { characteristics } = await new Promise<any>((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [AON_SERVICE_UUID.replace(/-/g, "")],
        [AON_ANNOUNCE_CHAR_UUID.replace(/-/g, ""), AON_RESPONSE_CHAR_UUID.replace(/-/g, "")],
        (err: Error, _services: any, chars: any) => (err ? reject(err) : resolve({ characteristics: chars }))
      );
    });

    return { peripheral, characteristics };
  }

  // BLE chunked write — splits large payloads into BLE_CHUNK_SIZE pieces
  async writeChunked(characteristic: any, data: Buffer) {
    for (let i = 0; i < data.length; i += BLE_CHUNK_SIZE) {
      const chunk = data.subarray(i, i + BLE_CHUNK_SIZE);
      await new Promise<void>((resolve, reject) => {
        characteristic.write(chunk, true, (err: Error) => (err ? reject(err) : resolve()));
      });
      if (data.length > BLE_CHUNK_SIZE) {
        await new Promise((r) => setTimeout(r, 20)); // inter-chunk gap
      }
    }
  }

  notifyAll(announceChar: any, data: Buffer) {
    try {
      announceChar.updateValueCallback?.(data);
    } catch { /* ignore */ }
  }
}

// ── BluetoothTransport ────────────────────────────────────────────────────────

export class BluetoothTransport implements AonTransport {
  private started = false;
  private stopping = false;
  private mode: "classic" | "ble";
  private nodeId: string;

  private classic: ClassicBluetooth | null = null;
  private ble: BLEBluetooth | null = null;
  private bleAnnounceChar: any = null;

  private peers = new Map<string, ConnectedPeer>();
  private seenHashes = new Set<string>();
  private scanTimer: NodeJS.Timeout | null = null;
  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;

  private pendingRequests = new Map<
    string,
    { resolve: (obj: AonObject) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor() {
    this.mode   = (process.env.AON_BT_MODE ?? "classic") as "classic" | "ble";
    this.nodeId = (process.env.AON_BT_NODE_ID ?? randomBytes(6).toString("hex"))
      .toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 12);
  }

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async handleMessage(peerId: string, msg: BtMessage) {
    const peer = this.peers.get(peerId);
    if (peer) peer.lastSeen = Date.now();

    switch (msg.type) {
      case "announce":
        await this.handleAnnouncement(peerId, msg.objectHash);
        break;

      case "request":
        await this.handleRequest(peerId, msg.objectHash, msg.requestId);
        break;

      case "response":
        this.handleResponse(msg.objectHash, msg.object, msg.requestId);
        break;

      case "peers":
        this.peers.get(peerId)?.send({ type: "peer_list", peers: this.peerList() });
        break;

      case "ping":
        this.peers.get(peerId)?.send({ type: "pong" });
        break;

      case "pong":
        break;
    }
  }

  private async handleAnnouncement(fromPeerId: string, objectHash: string) {
    const h = objectHash?.toLowerCase();
    if (!h || this.seenHashes.has(h)) return;

    this.seenHashes.add(h);
    if (this.seenHashes.size > SEEN_MAX) {
      const first = this.seenHashes.values().next().value;
      if (first) this.seenHashes.delete(first);
    }

    console.log("[bt] received announcement", { objectHash, from: fromPeerId });

    const requestId = randomBytes(4).toString("hex");

    try {
      const obj = await new Promise<AonObject>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error("BT_REQUEST_TIMEOUT"));
        }, REQUEST_TIMEOUT_MS);

        this.pendingRequests.set(requestId, { resolve, reject, timer });

        const peer = this.peers.get(fromPeerId);
        if (!peer) { reject(new Error("BT_PEER_GONE")); return; }
        peer.send({ type: "request", objectHash, requestId });
      });

      if (this.objectHandler) await this.objectHandler(obj);
      await this.announceObject(obj);
    } catch (err: any) {
      console.error("[bt] fetch after announcement failed", {
        objectHash,
        error: err?.message,
      });
    }
  }

  private async handleRequest(fromPeerId: string, objectHash: string, requestId: string) {
    try {
      const { getObject } = await import("../store.js");
      const obj = getObject(objectHash);
      if (!obj) return;

      const peer = this.peers.get(fromPeerId);
      peer?.send({ type: "response", objectHash, object: obj, requestId });
    } catch (err: any) {
      console.error("[bt] request handler failed", err?.message);
    }
  }

  private handleResponse(objectHash: string, object: AonObject, requestId: string) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve(object);
  }

  // ── Classic peer management ────────────────────────────────────────────────

  private registerClassicPeer(conn: any, address: string): string {
    const peerId = address.replace(/:/g, "").toUpperCase();

    const send = (msg: BtMessage) => this.classic!.sendMessage(conn, msg);

    this.peers.set(peerId, {
      peerId,
      address,
      connection: conn,
      send,
      lastSeen: Date.now(),
    });

    this.classic!.readMessages(conn, (msg) => {
      this.handleMessage(peerId, msg).catch((err) =>
        console.error("[bt-classic] message handler error", err)
      );
    });

    conn.on("closed", () => {
      console.log("[bt-classic] peer disconnected", { peerId });
      this.peers.delete(peerId);
    });

    console.log("[bt-classic] peer connected", { peerId, address });
    send({ type: "peers" });

    return peerId;
  }

  private async scanAndConnectClassic() {
    if (!this.classic || this.stopping) return;

    try {
      const found = await this.classic.scan();
      for (const { address } of found) {
        const peerId = address.replace(/:/g, "").toUpperCase();
        if (this.peers.has(peerId)) continue;

        try {
          // Only connect if the device advertises the AON RFCOMM channel —
          // prevents connecting to every Bluetooth device in range
          const conn = await this.classic.connect(address);
          this.registerClassicPeer(conn, address);
        } catch (err: any) {
          // Device doesn't have AON RFCOMM channel or connection failed — skip
        }
      }
    } catch (err: any) {
      console.error("[bt-classic] scan failed", err?.message);
    }
  }

  // ── BLE peer management ────────────────────────────────────────────────────

  private async registerBlePeer(peripheral: any) {
    const peerId = peripheral.id?.replace(/:/g, "").toUpperCase() ?? randomBytes(6).toString("hex").toUpperCase();
    if (this.peers.has(peerId)) return;

    try {
      const { characteristics } = await this.ble!.connect(peripheral);

      const requestChar  = characteristics.find((c: any) => c.uuid === AON_REQUEST_CHAR_UUID.replace(/-/g, ""));
      const responseChar = characteristics.find((c: any) => c.uuid === AON_RESPONSE_CHAR_UUID.replace(/-/g, ""));

      if (!requestChar) return;

      // Subscribe to response notifications
      let responseBuffer = Buffer.alloc(0);
      const BLE_MAX_BUFFER = 1_000_000; // 1MB hard limit on BLE response buffer
      responseChar?.subscribe();
      responseChar?.on("data", (chunk: Buffer) => {
        if (responseBuffer.length + chunk.length > BLE_MAX_BUFFER) {
          console.error("[ble] response buffer exceeded max size — dropping");
          responseBuffer = Buffer.alloc(0);
          return;
        }
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        // Try to parse — responses may arrive in multiple chunks
        try {
          const msg = JSON.parse(responseBuffer.toString("utf8")) as BtMessage;
          responseBuffer = Buffer.alloc(0);
          this.handleMessage(peerId, msg).catch((err) =>
            console.error("[ble] message handler error", err)
          );
        } catch {
          // incomplete — keep buffering
        }
      });

      const send = async (msg: BtMessage) => {
        const data = Buffer.from(JSON.stringify(msg));
        await this.ble!.writeChunked(requestChar, data);
      };

      this.peers.set(peerId, {
        peerId,
        address: peripheral.address ?? peerId,
        connection: peripheral,
        send: (msg) => send(msg).catch((err) => console.error("[ble] send error", err.message)),
        lastSeen: Date.now(),
      });

      peripheral.once("disconnect", () => {
        console.log("[ble] peer disconnected", { peerId });
        this.peers.delete(peerId);
      });

      console.log("[ble] peer connected", { peerId, address: peripheral.address });
    } catch (err: any) {
      console.error("[ble] peer connection failed", { peerId, error: err?.message });
    }
  }

  // ── AonTransport interface ─────────────────────────────────────────────────

  async start() {
    if (this.started) return;

    if (this.mode === "classic") {
      this.classic = new ClassicBluetooth();
      await this.classic.start((conn, address) => {
        this.registerClassicPeer(conn, address);
      });

      // Periodic scan for new peers
      this.scanTimer = setInterval(async () => {
        if (!this.stopping) await this.scanAndConnectClassic();
      }, SCAN_INTERVAL_MS);

      // Initial scan
      await this.scanAndConnectClassic();

    } else {
      this.ble = new BLEBluetooth();

      this.ble.on("announceChar", (char: any) => {
        this.bleAnnounceChar = char;
      });

      this.ble.on("peer", (peripheral: any) => {
        this.registerBlePeer(peripheral).catch((err) =>
          console.error("[ble] peer registration failed", err)
        );
      });

      await this.ble.start((objectHash, peripheral) => {
        const peerId = peripheral.id?.replace(/:/g, "").toUpperCase() ?? "unknown";
        this.handleAnnouncement(peerId, objectHash);
      });
    }

    this.started = true;
    console.log("[bt] started", { mode: this.mode, nodeId: this.nodeId });
  }

  async stop() {
    this.stopping = true;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    for (const peer of this.peers.values()) {
      try { peer.connection?.close?.(); peer.connection?.disconnect?.(); } catch { /* ignore */ }
    }
    this.peers.clear();
    if (this.classic) { await this.classic.stop(); this.classic = null; }
    if (this.ble) { await this.ble.stop(); this.ble = null; }
    this.started = false;
  }

  async announceObject(obj: AonObject) {
    if (!obj.objectHash || this.peers.size === 0) return;

    const msg: BtMessage = { type: "announce", objectHash: obj.objectHash };

    if (this.mode === "classic") {
      for (const peer of this.peers.values()) {
        peer.send(msg);
      }
    } else if (this.bleAnnounceChar) {
      // BLE: notify all subscribed centrals
      const data = Buffer.from(JSON.stringify(msg));
      this.ble?.notifyAll(this.bleAnnounceChar, data);
    }

    console.log("[bt] announced object", {
      objectHash: obj.objectHash,
      peers: this.peers.size,
    });
  }

  async requestObject(hash: string, peerId: string): Promise<AonObject> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("BT_PEER_NOT_FOUND");

    const requestId = randomBytes(4).toString("hex");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("BT_REQUEST_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      peer.send({ type: "request", objectHash: hash, requestId });
    });
  }

  async dialPeer(addr: string) {
    // Only handle bluetooth addresses
    if (!addr.startsWith("bt://") && !addr.startsWith("ble://")) {
      return { ok: false, reason: "BT_UNRECOGNIZED_ADDR" };
    }

    const address = addr.replace(/^(bt|ble):\/\//, "");
    const peerId = address.replace(/:/g, "").toUpperCase();

    if (this.peers.has(peerId)) return { ok: true, reason: "ALREADY_CONNECTED" };

    if (this.mode === "classic" && this.classic) {
      try {
        const conn = await this.classic.connect(address);
        this.registerClassicPeer(conn, address);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, reason: err?.message ?? "BT_CONNECT_FAILED" };
      }
    }

    return { ok: false, reason: "BT_DIAL_NOT_SUPPORTED_IN_MODE" };
  }

  async exchangePeers(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("BT_PEER_NOT_FOUND");
    peer.send({ type: "peers" });
    return { peers: this.peerList(), dialResults: [] };
  }

  getInfo() {
    return {
      started: this.started,
      peerId: this.nodeId,
      addrs: [`${this.mode === "ble" ? "ble" : "bt"}://${this.nodeId}`],
      peers: [...this.peers.keys()],
    };
  }

  getPubsubInfo() {
    return {
      started: this.started,
      topic: `/aon/bt-${this.mode}/1`,
      peers: [...this.peers.keys()],
      subscribers: [...this.peers.keys()],
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private peerList(): PeerInfo[] {
    return [...this.peers.values()].map((p) => ({
      peerId: p.peerId,
      addrs: [`${this.mode === "ble" ? "ble" : "bt"}://${p.address}`],
    }));
  }
}
