// transport.ts
//
// The AonTransport interface is the only transport contract the node depends on.
// The node has no knowledge of TCP, libp2p, multiaddrs, or any networking
// primitive. Those details live entirely in transport implementations.
//
// Current implementations:
//   src/transports/libp2p.ts  — TCP/IP via libp2p (default)
//
// To add a new transport (LoRa, Bluetooth, radio, etc.), implement this
// interface and instantiate it in server.ts. The node code changes nothing.

import type { AonObject } from "./object.js";

export interface PeerInfo {
  peerId: string;
  addrs: string[];
}

export interface AonTransport {
  // Start the transport and begin listening for peers
  start(): Promise<void>;

  // Stop the transport cleanly
  stop(): Promise<void>;

  // Broadcast an object to all known peers
  announceObject(obj: AonObject): Promise<void>;

  // Fetch a specific object from a specific peer by hash
  requestObject(hash: string, peerId: string): Promise<AonObject>;

  // Establish a connection to a peer by address string
  dialPeer(addr: string): Promise<{ ok: boolean; reason?: string }>;

  // Exchange known peers with a specific peer
  exchangePeers(peerId: string): Promise<{ peers: PeerInfo[]; dialResults: any[] }>;

  // Return info about this node and its current peers
  getInfo(): {
    started: boolean;
    peerId: string | null;
    addrs: string[];
    peers: string[];
  };

  // Return pubsub/topic info if the transport supports it
  getPubsubInfo(): {
    started: boolean;
    topic: string;
    peers: string[];
    subscribers: string[];
  };

  // Register a handler that fires whenever an object arrives from the network.
  // The node calls this once at startup to wire in its store logic.
  onObject(handler: (obj: AonObject) => Promise<void>): void;

  // ── Optional sync primitives ────────────────────────────────────────────────
  // Implemented by transports that can support object synchronization
  // (see src/sync.ts). All are optional so existing transports compile
  // unchanged; sync silently no-ops over transports that lack them.
  //
  // Transports never touch the store. The node injects read access via the
  // on* registration hooks below, mirroring the onObject pattern.

  // Fires when a new peer connection is established. peerId is opaque —
  // whatever identifier requestObject/listPeerHashes accept for this
  // transport.
  onPeerConnect?(handler: (peerId: string) => void): void;

  // Ask a specific peer for a page of the object hashes it holds.
  // Keyset pagination: return hashes strictly greater than `after`
  // (hash-ordered), at most `limit` of them. done=true on the last page.
  // Optional namespaces filter scopes the listing (namespace-subscribed
  // sync); an empty/absent list means all namespaces.
  listPeerHashes?(
    peerId: string,
    page: { after?: string | null; limit?: number; namespaces?: string[] }
  ): Promise<{ hashes: string[]; done: boolean }>;

  // Node injects: how to serve a single object to a requesting peer.
  onObjectRequest?(handler: (hash: string) => AonObject | null): void;

  // Node injects: how to serve a page of our own hashes to a syncing peer.
  // Same keyset + namespaces contract as listPeerHashes.
  onListHashes?(
    handler: (
      after: string | null,
      limit: number,
      namespaces?: string[]
    ) => { hashes: string[]; done: boolean }
  ): void;

  // Node injects: policy for whether to fetch an announced object. The
  // transport applies it mechanically to incoming announcements (which
  // carry a summary: hash, namespace, objectType) without interpreting it.
  // Absent handler means fetch everything. Used by namespace subscription.
  onWantObject?(
    handler: (summary: { objectHash: string; namespace?: string; objectType?: string }) => boolean
  ): void;
}
