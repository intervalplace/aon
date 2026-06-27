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
}
