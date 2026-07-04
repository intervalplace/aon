#!/usr/bin/env python3
"""
aon_rns_bridge.py

Reticulum bridge process for the AON node.
Spawned by the Node.js Reticulum transport as a child process.
Communicates via stdin/stdout using newline-delimited JSON.

Messages from Node.js → bridge (stdin):
  { "type": "announce", "objectHash": "0x..." }
  { "type": "request",  "objectHash": "0x...", "requestId": "..." }
  { "type": "response", "objectHash": "0x...", "object": {...}, "requestId": "..." }
  { "type": "stop" }

Messages from bridge → Node.js (stdout):
  { "type": "announce",   "objectHash": "0x...", "peerId": "..." }
  { "type": "request",    "objectHash": "0x...", "requestId": "...", "peerId": "..." }
  { "type": "response",   "objectHash": "0x...", "object": {...}, "requestId": "..." }
  { "type": "peer",       "peerId": "...", "addrs": [...] }
  { "type": "ready",      "peerId": "...", "addrs": [...] }
  { "type": "error",      "message": "..." }
"""

import sys
import json
import threading
import time
import os
import RNS

AON_APP_NAME = "aon"
AON_ASPECT   = "node"
AON_VERSION  = "1"

# ── Helpers ───────────────────────────────────────────────────────────────────

# Thread safety for stdout — RNS fires callbacks from its own threads;
# concurrent send() calls without locking would interleave JSON writes.
_stdout_lock = threading.Lock()

def send(msg: dict):
    """Send a JSON message to Node.js via stdout."""
    try:
        with _stdout_lock:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"[rns-bridge] send error: {e}\n")

def log(msg: str, error: bool = False):
    sys.stderr.write(f"[rns-bridge] {msg}\n")
    sys.stderr.flush()
    if error:
        send({"type": "error", "message": msg})

# ── Announce handler ──────────────────────────────────────────────────────────

class AonAnnounceHandler:
    """
    Handles incoming Reticulum announces from other AON nodes.
    The aspect_filter ensures we only receive announces for AON destinations.
    """
    aspect_filter = f"{AON_APP_NAME}.{AON_ASPECT}"

    def received_announce(self, destination_hash, announced_identity, app_data, *args):
        if not app_data:
            return

        try:
            data = json.loads(app_data.decode("utf-8"))
            object_hash = data.get("objectHash")
            if not object_hash:
                return

            peer_id = destination_hash.hex()
            send({
                "type": "announce",
                "objectHash": object_hash,
                "peerId": peer_id,
            })

            # Register peer
            send({
                "type": "peer",
                "peerId": peer_id,
                "addrs": [f"rns://{peer_id}"],
            })

        except Exception as e:
            log(f"announce handler error: {e}")

# ── Link management ───────────────────────────────────────────────────────────

class LinkManager:
    def __init__(self, destination):
        self.destination = destination
        self.links = {}   # peerId → link
        self.lock = threading.Lock()

    def on_link_established(self, link):
        """Called when an inbound link is established."""
        remote_id = link.get_remote_identity()
        peer_id   = link.get_remote_identity().hash.hex() if remote_id else "unknown"

        with self.lock:
            self.links[peer_id] = link

        link.set_packet_callback(lambda message, packet: self.on_packet(peer_id, message, packet))
        link.set_link_closed_callback(lambda l: self.on_link_closed(peer_id))

        send({"type": "peer", "peerId": peer_id, "addrs": [f"rns://{peer_id}"]})
        log(f"inbound link from {peer_id}")

    def on_link_closed(self, peer_id):
        with self.lock:
            self.links.pop(peer_id, None)
        log(f"link closed: {peer_id}")

    def on_packet(self, peer_id: str, message: bytes, packet):
        """Handle a packet received over a link."""
        try:
            msg = json.loads(message.decode("utf-8"))
            msg_type = msg.get("type")

            if msg_type == "announce":
                send({
                    "type": "announce",
                    "objectHash": msg["objectHash"],
                    "peerId": peer_id,
                })

            elif msg_type == "request":
                send({
                    "type": "request",
                    "objectHash": msg["objectHash"],
                    "requestId": msg["requestId"],
                    "peerId": peer_id,
                })

            elif msg_type == "response":
                send({
                    "type": "response",
                    "objectHash": msg["objectHash"],
                    "object": msg["object"],
                    "requestId": msg["requestId"],
                })

        except Exception as e:
            log(f"packet handler error: {e}")

    def send_to_peer(self, peer_id: str, msg: dict):
        with self.lock:
            link = self.links.get(peer_id)
        if not link or link.status != RNS.Link.ACTIVE:
            raise Exception(f"RNS_PEER_NOT_CONNECTED: {peer_id}")
        data = json.dumps(msg).encode("utf-8")
        RNS.Packet(link, data).send()

    def connect_to(self, peer_id_hex: str) -> RNS.Link:
        """Establish an outbound link to an AON destination."""
        destination_hash = bytes.fromhex(peer_id_hex)

        if not RNS.Transport.has_path(destination_hash):
            RNS.Transport.request_path(destination_hash)
            # Wait up to 15s for path
            for _ in range(150):
                if RNS.Transport.has_path(destination_hash):
                    break
                time.sleep(0.1)

        if not RNS.Transport.has_path(destination_hash):
            raise Exception(f"RNS_NO_PATH: {peer_id_hex}")

        identity = RNS.Identity.recall(destination_hash)
        if identity is None:
            raise Exception(f"RNS_IDENTITY_UNKNOWN: {peer_id_hex} — wait for announce from target node")
        destination  = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, AON_APP_NAME, AON_ASPECT)
        link         = RNS.Link(destination)

        established = threading.Event()

        def on_established(l):
            peer_id = peer_id_hex
            with self.lock:
                self.links[peer_id] = l
            l.set_packet_callback(lambda msg, pkt: self.on_packet(peer_id, msg, pkt))
            l.set_link_closed_callback(lambda l: self.on_link_closed(peer_id))
            established.set()

        link.set_link_established_callback(on_established)

        if not established.wait(timeout=30):
            raise Exception(f"RNS_LINK_TIMEOUT: {peer_id_hex}")

        return link

    def broadcast_announce(self, destination, object_hash: str):
        """Send an announce with objectHash as app_data."""
        app_data = json.dumps({"objectHash": object_hash}).encode("utf-8")
        destination.announce(app_data=app_data)

# ── Main bridge ───────────────────────────────────────────────────────────────

def main():
    config_dir = os.environ.get("AON_RNS_CONFIG", None)

    log("starting Reticulum...")
    reticulum = RNS.Reticulum(configdir=config_dir)

    # Persist identity so restarts don't invalidate this node's RNS address.
    # Without this, every restart produces a new destination hash and all
    # peers that knew the old hash lose reachability until rediscovery.
    identity_path = os.path.join(
        config_dir or os.path.expanduser("~/.reticulum"),
        "aon_identity"
    )
    if os.path.exists(identity_path):
        identity = RNS.Identity.from_file(identity_path)
        log(f"loaded persisted RNS identity from {identity_path}")
    else:
        identity = RNS.Identity()
        identity.to_file(identity_path)
        log(f"created new RNS identity at {identity_path}")
    destination = RNS.Destination(
        identity,
        RNS.Destination.IN,
        RNS.Destination.SINGLE,
        AON_APP_NAME,
        AON_ASPECT,
    )
    destination.set_proof_strategy(RNS.Destination.PROVE_ALL)

    link_manager = LinkManager(destination)
    destination.set_link_established_callback(link_manager.on_link_established)

    announce_handler = AonAnnounceHandler()
    RNS.Transport.register_announce_handler(announce_handler)

    peer_id = identity.hash.hex()
    addrs   = [f"rns://{peer_id}"]

    log(f"ready — peer id: {peer_id}")
    send({"type": "ready", "peerId": peer_id, "addrs": addrs})

    # Initial announce so other nodes can find us
    destination.announce(app_data=b"{}")

    # Read commands from Node.js via stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except Exception as e:
            log(f"invalid JSON from host: {e}")
            continue

        msg_type = msg.get("type")

        if msg_type == "stop":
            log("stopping")
            break

        elif msg_type == "announce":
            # Broadcast via Reticulum announce
            object_hash = msg.get("objectHash", "")
            link_manager.broadcast_announce(destination, object_hash)
            # Also send directly to connected peers
            with link_manager.lock:
                peer_ids = list(link_manager.links.keys())
            for peer_id in peer_ids:
                try:
                    link_manager.send_to_peer(peer_id, msg)
                except Exception as e:
                    log(f"direct announce to {peer_id} failed: {e}")

        elif msg_type == "request":
            peer_id_target = msg.get("peerId")
            if peer_id_target:
                try:
                    link_manager.send_to_peer(peer_id_target, msg)
                except Exception as e:
                    log(f"request to {peer_id_target} failed: {e}")

        elif msg_type == "response":
            peer_id_target = msg.get("peerId")
            if peer_id_target:
                try:
                    link_manager.send_to_peer(peer_id_target, msg)
                except Exception as e:
                    log(f"response to {peer_id_target} failed: {e}")

        elif msg_type == "dial":
            peer_id_target = msg.get("peerId", "").replace("rns://", "")
            def do_dial(pid):
                try:
                    link_manager.connect_to(pid)
                    send({"type": "peer", "peerId": pid, "addrs": [f"rns://{pid}"]})
                except Exception as e:
                    log(f"dial {pid} failed: {e}")
            threading.Thread(target=do_dial, args=(peer_id_target,), daemon=True).start()

        elif msg_type == "get_peers":
            with link_manager.lock:
                peers = [
                    {"peerId": pid, "addrs": [f"rns://{pid}"]}
                    for pid in link_manager.links.keys()
                ]
            send({"type": "peer_list", "peers": peers})

if __name__ == "__main__":
    main()
