// transports/multi.ts
//
// A composite AonTransport that runs multiple transports simultaneously.
// Objects announced on any transport are propagated to all others.
// Incoming objects from any transport are delivered to the node once.
//
// Usage:
//
//   import { MultiTransport } from "./transports/multi.js";
//   import { LibP2pTransport } from "./transports/libp2p.js";
//   import { LoRaTransport } from "./transports/lora.js";
//
//   const transport = new MultiTransport([
//     new LibP2pTransport(),
//     new LoRaTransport(),
//   ]);
//
// An object arriving on LoRa is stored by the node and re-announced on
// libp2p, and vice versa. The network boundary between radio and internet
// dissolves at the node level.

import type { AonObject } from "../object.js";
import type { AonTransport, PeerInfo } from "../transport.js";

export class MultiTransport implements AonTransport {
  private transports: AonTransport[];
  private objectHandler: ((obj: AonObject) => Promise<void>) | null = null;
  private seenHashes = new Set<string>();

  constructor(transports: AonTransport[]) {
    if (transports.length === 0) throw new Error("MULTI_TRANSPORT_EMPTY");
    this.transports = transports;
  }

  onObject(handler: (obj: AonObject) => Promise<void>) {
    this.objectHandler = handler;

    // Wire each transport to the deduplicating handler
    for (const transport of this.transports) {
      transport.onObject(async (obj: AonObject) => {
        const hash = obj.objectHash?.toLowerCase();
        if (!hash) return;

        // Deliver to node once regardless of which transport it arrived on
        if (!this.seenHashes.has(hash)) {
          this.seenHashes.add(hash);
          if (this.seenHashes.size > 10_000) {
            const first = this.seenHashes.values().next().value;
            if (first) this.seenHashes.delete(first);
          }
          if (this.objectHandler) {
            await this.objectHandler(obj);
          }
        }

        // Cross-propagate to all other transports
        for (const other of this.transports) {
          if (other === transport) continue;
          try {
            await other.announceObject(obj);
          } catch (err: any) {
            console.error("[multi] cross-propagation failed", {
              error: err?.message,
            });
          }
        }
      });
    }
  }

  async start() {
    await Promise.all(this.transports.map((t) => t.start()));
  }

  async stop() {
    await Promise.all(this.transports.map((t) => t.stop()));
  }

  async announceObject(obj: AonObject) {
    await Promise.allSettled(this.transports.map((t) => t.announceObject(obj)));
  }

  async requestObject(hash: string, peerId: string): Promise<AonObject> {
    // Try each transport in order until one succeeds
    const errors: string[] = [];

    for (const transport of this.transports) {
      try {
        return await transport.requestObject(hash, peerId);
      } catch (err: any) {
        errors.push(err?.message ?? String(err));
      }
    }

    throw new Error(`MULTI_REQUEST_FAILED: ${errors.join(", ")}`);
  }

  async dialPeer(addr: string) {
    // Try all transports — each decides if it understands the address
    const results = await Promise.allSettled(
      this.transports.map((t) => t.dialPeer(addr))
    );

    const succeeded = results.find(
      (r) => r.status === "fulfilled" && r.value?.ok
    );

    if (succeeded) {
      return (succeeded as PromiseFulfilledResult<any>).value;
    }

    return { ok: false, reason: "NO_TRANSPORT_ACCEPTED_ADDR" };
  }

  async exchangePeers(peerId: string) {
    const results = await Promise.allSettled(
      this.transports.map((t) => t.exchangePeers(peerId))
    );

    const peers: PeerInfo[] = [];
    const dialResults: any[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        peers.push(...(result.value.peers ?? []));
        dialResults.push(...(result.value.dialResults ?? []));
      }
    }

    return { peers, dialResults };
  }

  getInfo() {
    const infos = this.transports.map((t) => t.getInfo());
    return {
      started: infos.some((i) => i.started),
      peerId: infos.find((i) => i.peerId)?.peerId ?? null,
      addrs: infos.flatMap((i) => i.addrs),
      peers: [...new Set(infos.flatMap((i) => i.peers))],
    };
  }

  getPubsubInfo() {
    const infos = this.transports.map((t) => t.getPubsubInfo());
    return {
      started: infos.some((i) => i.started),
      topic: infos.map((i) => i.topic).join(", "),
      peers: [...new Set(infos.flatMap((i) => i.peers))],
      subscribers: [...new Set(infos.flatMap((i) => i.subscribers))],
    };
  }
}
