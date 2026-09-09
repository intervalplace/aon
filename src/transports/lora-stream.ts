// transports/lora-stream.ts
//
// Minimal AonTransport for a *transparent-stream* LoRa module such as the
// Waveshare USB-TO-LoRa-xF (SX1262 DTU). Unlike RYLR998-style modules, these
// present a clean serial byte pipe: whatever you write is transmitted verbatim
// and delivered verbatim to every module in range on the same channel. The
// hardware handles packetization (up to 960-byte cache, auto-split at 240B),
// CRC, and (optionally) AES. So we do NOT chunk, reassemble, or run a
// hash-pull protocol — we just push whole objects as newline-delimited JSON.
//
// Configure both dongles ONCE (Waveshare tool or AT commands) to matching:
//   frequency / channel, air rate, transparent mode, and (same or disabled) AES key.
//
// Env:
//   AON_LORA_PORT=/dev/ttyUSB0     (required)
//   AON_LORA_BAUD=115200           (must match the dongle's serial-side baud)
//   AON_LORA_NODE_ID=AABBCCDDEE01  (optional label, for logs/getInfo only)
//
// Usage in server.ts:
//   import { LoRaStreamTransport } from "./transports/lora-stream.js";
//   if (process.env.AON_LORA_PORT) transports.push(new LoRaStreamTransport());

import { createRequire } from "module";
import { randomBytes } from "crypto";
import type { AonObject } from "../object.js";
import type { AonTransport } from "../transport.js";

const require = createRequire(import.meta.url);

// A single object serialized as JSON can exceed one air-packet; that's fine,
// the DTU re-splits transparently. We frame with a trailing newline and forbid
// raw newlines inside the payload by relying on JSON.stringify (which escapes
// them), so "\n" is an unambiguous message delimiter.
const DELIM = 0x0a; // "\n"

export class LoRaStreamTransport implements AonTransport {
  private port: any = null;
  private started = false;
  private peerId: string;
  private rx = Buffer.alloc(0);
  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;
  private seen = new Set<string>();

  constructor() {
    const id = process.env.AON_LORA_NODE_ID ?? randomBytes(6).toString("hex");
    this.peerId = id.replace(/[^0-9a-fA-F]/g, "").slice(0, 12).toUpperCase();
  }

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;
  }

  async start() {
    if (this.started) return;

    const path = process.env.AON_LORA_PORT;
    if (!path) throw new Error("AON_LORA_PORT not set (e.g. /dev/ttyUSB0)");
    const baudRate = Number(process.env.AON_LORA_BAUD ?? 115200);

    const { SerialPort } = require("serialport");
    this.port = new SerialPort({ path, baudRate, autoOpen: false });

    await new Promise<void>((resolve, reject) =>
      this.port.open((err: any) => (err ? reject(err) : resolve()))
    );

    this.port.on("data", (d: Buffer) => this.onData(d));
    this.port.on("error", (e: Error) => console.error("[lora-stream] serial error", e));

    this.started = true;
    console.log("[lora-stream] started", { peerId: this.peerId, port: path, baud: baudRate });
  }

  async stop() {
    if (this.port) {
      await new Promise<void>((resolve) => this.port.close(() => resolve()));
      this.port = null;
    }
    this.started = false;
  }

  // Broadcast: serialize and write. The DTU transmits to all peers in range.
  async announceObject(obj: AonObject) {
    if (!this.port) return;
    const line = Buffer.concat([Buffer.from(JSON.stringify(obj), "utf8"), Buffer.from([DELIM])]);
    await new Promise<void>((resolve, reject) =>
      this.port.write(line, (err: any) => (err ? reject(err) : resolve()))
    );
    console.log("[lora-stream] announced object", { objectHash: obj.objectHash });
  }

  // Accumulate serial bytes, split on newline, parse each complete line.
  private onData(chunk: Buffer) {
    this.rx = Buffer.concat([this.rx, chunk]);
    let nl: number;
    while ((nl = this.rx.indexOf(DELIM)) !== -1) {
      const line = this.rx.subarray(0, nl);
      this.rx = this.rx.subarray(nl + 1);
      if (line.length === 0) continue;
      this.handleLine(line).catch((e) =>
        console.error("[lora-stream] handler failed", e?.message)
      );
    }
    // Guard against a partial line growing unbounded if a delimiter is lost.
    if (this.rx.length > 64 * 1024) this.rx = Buffer.alloc(0);
  }

  private async handleLine(line: Buffer) {
    let obj: AonObject;
    try {
      obj = JSON.parse(line.toString("utf8"));
    } catch {
      return; // partial/corrupt frame — DTU CRC should mostly prevent this
    }
    const hash = (obj as any)?.objectHash;
    if (!hash || typeof hash !== "string") return;

    // Dedup: broadcast medium means we may hear the same object more than once
    // (including our own rebroadcasts echoed by relays).
    if (this.seen.has(hash)) return;
    this.seen.add(hash);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);

    console.log("[lora-stream] received object", { objectHash: hash });
    if (this.objectHandler) await this.objectHandler(obj);
  }

  // ── Broadcast medium: the connection-oriented methods are no-ops ────────────

  async requestObject(_hash: string, _peerId: string): Promise<AonObject> {
    // No pull protocol in stream mode — objects arrive whole via announce.
    throw new Error("LORA_STREAM_NO_PULL");
  }

  async dialPeer(_addr: string) {
    return { ok: true }; // nothing to dial on a broadcast medium
  }

  async exchangePeers(_peerId: string) {
    return { peers: [], dialResults: [] };
  }

  getInfo() {
    return {
      started: this.started,
      peerId: this.peerId,
      addrs: [`lora:${this.peerId}`],
      peers: [],
    };
  }

  getPubsubInfo() {
    return {
      started: this.started,
      topic: "/aon/lora-stream/1",
      peers: [],
      subscribers: [],
    };
  }
}
