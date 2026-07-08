// sync.ts
//
// Transport-agnostic object synchronization.
//
// Sync is protocol logic, not transport logic. It lives here — once — and
// works over any AonTransport that implements the two optional sync
// primitives (onPeerConnect + listPeerHashes). Transports stay dumb pipes:
// they move bytes and signal "a peer appeared". This module owns the policy:
// list → diff against our own store → fetch missing → verify → ingest.
//
// The syncing node keeps NO knowledge of which peers hold which objects.
// A peer's hash list is transient: used for the diff, then discarded. The
// only state consulted is our own store ("do I have this hash?"). Because
// objects are content-addressed, any copy is as good as any other, so the
// node never needs routing knowledge — the bootnode is just the first peer
// we happen to sync from, not an authority.
//
// Future: when a low-bandwidth transport (LoRa) makes "send me your full
// hash list" too expensive, replace the opening exchange with a set
// fingerprint (Merkle root / Bloom filter) and fetch only the diff. That
// change lives entirely in this file — no transport needs to know.

import { hashObject, type AonObject } from "./object.js";
import type { AonTransport } from "./transport.js";

export interface SyncOptions {
  // Answered by the node's own store — the single source of truth.
  hasObject: (hash: string) => boolean;

  // How a verified object enters the node (typically putObject).
  ingest: (obj: AonObject) => Promise<unknown>;

  // Namespace subscription: when set, only these namespaces are synced.
  // Empty/absent means the node syncs everything. Namespaces are opaque
  // routing keys here — no interpretation, matching the node's purity rule.
  namespaces?: string[];

  // Hashes per page when listing a peer's set. Bounds each stream.
  batchSize?: number;

  // Grace period after connect before syncing, so the remote peer's
  // protocol handlers are registered. One retry after the same delay.
  initialDelayMs?: number;
}

export interface SyncResult {
  peerId: string;
  fetched: number;   // objects we were missing and successfully ingested
  failed: number;    // objects that errored or failed verification
  skipped: number;   // hashes we already had
}

export function attachSync(transport: AonTransport, opts: SyncOptions) {
  const batchSize = opts.batchSize ?? 200;
  const initialDelayMs = opts.initialDelayMs ?? 2_000;

  // One sync per peer at a time. Reconnect churn or overlapping
  // peer:connect events collapse into a single pass.
  const inFlight = new Set<string>();

  async function syncFromPeer(peerId: string, namespacesOverride?: string[]): Promise<SyncResult | null> {
    if (typeof transport.listPeerHashes !== "function") return null;
    if (inFlight.has(peerId)) return null;
    inFlight.add(peerId);

    // Per-call namespace override takes precedence over node-level subscription.
    const effectiveNamespaces = namespacesOverride ?? (opts.namespaces?.length ? opts.namespaces : undefined);
    const result: SyncResult = { peerId, fetched: 0, failed: 0, skipped: 0 };

    try {
      // Keyset pagination: pages are ordered by hash and anchored on the
      // last hash seen, so objects arriving mid-sync can't shift pages
      // under us (no skips, no repeats).
      let after: string | null = null;

      while (true) {
        const page = await transport.listPeerHashes(peerId, {
          after,
          limit: batchSize,
          namespaces: effectiveNamespaces,
        });
        if (!page || !Array.isArray(page.hashes)) break;

        for (const hash of page.hashes) {
          if (typeof hash !== "string" || hash.length === 0) continue;

          if (opts.hasObject(hash)) {
            result.skipped++;
            continue;
          }

          try {
            const obj = await transport.requestObject(hash, peerId);

            // Verify content against the hash we asked for — never trust
            // a peer's claim. canonicalize() excludes objectHash, so we
            // can recompute directly on the received object.
            const computed = hashObject(obj);
            if (computed.toLowerCase() !== hash.toLowerCase()) {
              console.error("[sync] hash mismatch, discarding", {
                peerId,
                requested: hash,
                computed,
              });
              result.failed++;
              continue;
            }

            await opts.ingest(obj);
            result.fetched++;
          } catch (err: any) {
            result.failed++;
            console.error("[sync] object fetch failed", {
              peerId,
              hash,
              error: err?.message ?? String(err),
            });
          }
        }

        if (page.done || page.hashes.length === 0) break;
        after = page.hashes[page.hashes.length - 1];
      }
    } finally {
      inFlight.delete(peerId);
    }

    console.log("[sync] peer sync complete", result);
    return result;
  }

  // Backfill trigger: every new peer connection runs the same dumb loop.
  // The node converges on the union of what its peers hold.
  transport.onPeerConnect?.((peerId: string) => {
    setTimeout(() => {
      syncFromPeer(peerId).catch((err: any) => {
        // Peer may not support the sync protocol (older node) — fine.
        const msg = err?.message ?? String(err);
        if (msg.includes("protocol") || msg.includes("unsupported")) {
          console.log("[sync] peer does not support sync", { peerId });
          return;
        }
        // Transient startup failure: retry once after the same delay.
        setTimeout(() => {
          syncFromPeer(peerId).catch((err2: any) => {
            console.error("[sync] sync failed", {
              peerId,
              error: err2?.message ?? String(err2),
            });
          });
        }, initialDelayMs);
      });
    }, initialDelayMs);
  });

  // Exposed for manual triggering (HTTP endpoint, tests).
  return { syncFromPeer };
}
