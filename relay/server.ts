/**
 * mind-whiteboard relay — an EPHEMERAL y-websocket room broker (PRD §3.3).
 *
 * What it is:
 *   • A bare `ws` server speaking the y-websocket wire protocol (sync +
 *     awareness). One in-memory Y.Doc + Awareness per room (= board id, taken
 *     from the WS path). Peers in the same room sync deltas through it.
 *
 * What it deliberately is NOT (the privacy story depends on these):
 *   • NO persistence. Nothing is written to disk or a database. Kill the relay
 *     and the pod copy is untouched; restart and clients re-sync from each
 *     other + their pod snapshot. The room doc is GC'd when the last peer
 *     leaves.
 *   • NO pod credentials. The relay never talks to any Solid pod.
 *   • NO decryption. Board contents are end-to-end encrypted by the clients;
 *     even if the relay COULD read the Yjs structs, the canvas payload it
 *     relays for snapshotting is opaque — the relay is a dumb pipe.
 *
 * y-websocket v3 no longer ships a server (`y-websocket/bin/utils` is gone), so
 * we implement the minimal protocol here against y-protocols/sync,
 * y-protocols/awareness and lib0 — exactly what the client WebsocketProvider
 * speaks. Message framing (verified against node_modules/y-websocket/src):
 *   byte 0 = messageType: 0=sync, 1=awareness, 3=queryAwareness
 *   sync sub-protocol handled by y-protocols/sync.readSyncMessage
 */

import http from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const PORT = Number(process.env.RELAY_PORT ?? 3112);
const HOST = process.env.RELAY_HOST ?? "0.0.0.0";

// Message type tags — must match y-websocket's client constants.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** Awareness states are dropped if not refreshed within this window. */
const AWARENESS_PING_TIMEOUT = 30_000;

type Room = {
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>; // conn -> the awareness clientIDs it owns
};

const rooms = new Map<string, Room>();

function getRoom(name: string): Room {
  let room = rooms.get(name);
  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the relay itself is not a peer

  room = { name, doc, awareness, conns: new Map() };

  // Fan out doc updates to every peer except the originator.
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    for (const conn of room!.conns.keys()) {
      if (conn !== origin) send(conn, msg);
    }
  });

  // Fan out awareness changes to every peer. Echo to everyone (including the
  // originating conn): y-websocket clients de-dupe by clock, and this matches
  // the reference server, which also lets a peer's own state round-trip.
  awareness.on(
    "update",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      const msg = encoding.toUint8Array(encoder);
      for (const conn of room!.conns.keys()) {
        send(conn, msg);
      }
    },
  );

  rooms.set(name, room);
  return room;
}

function maybeDropRoom(room: Room) {
  if (room.conns.size === 0) {
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(room.name);
  }
}

function send(conn: WebSocket, data: Uint8Array) {
  if (conn.readyState !== WebSocket.OPEN && conn.readyState !== WebSocket.CONNECTING) {
    return;
  }
  try {
    conn.send(data, (err) => {
      if (err) conn.close();
    });
  } catch {
    conn.close();
  }
}

function onMessage(room: Room, conn: WebSocket, data: Uint8Array) {
  const decoder = decoding.createDecoder(data);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // readSyncMessage applies SyncStep2/Update to room.doc (which fires the
      // doc 'update' fan-out for the deltas) and, for SyncStep1, writes the
      // reply (SyncStep2) into `encoder`. We tag the transaction with `conn`
      // so the fan-out skips echoing back to the sender.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
      break;
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        conn,
      );
      break;
    }
    case MESSAGE_QUERY_AWARENESS: {
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          room.awareness,
          Array.from(room.awareness.getStates().keys()),
        ),
      );
      send(conn, encoding.toUint8Array(encoder));
      break;
    }
    default:
      // Unknown (e.g. messageAuth=2) — ignore; the relay does no auth.
      break;
  }
}

function setupConnection(conn: WebSocket, roomName: string) {
  const room = getRoom(roomName);
  room.conns.set(conn, new Set());

  conn.binaryType = "arraybuffer";

  conn.on("message", (message: ArrayBuffer | Buffer) => {
    const bytes =
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    onMessage(room, conn, bytes);
  });

  // Track which awareness clientIDs this conn owns so we can clear them on
  // disconnect (so the peer's cursor vanishes immediately).
  const trackAwareness = ({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    const owned = room.conns.get(conn);
    if (!owned) return;
    for (const id of added) owned.add(id);
    for (const id of updated) owned.add(id);
    for (const id of removed) owned.delete(id);
  };
  room.awareness.on("update", trackAwareness);

  // Liveness ping/pong: drop dead peers.
  let alive = true;
  conn.on("pong", () => {
    alive = true;
  });
  const pingTimer = setInterval(() => {
    if (!alive) {
      closeConn();
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch {
      closeConn();
    }
  }, AWARENESS_PING_TIMEOUT);

  function closeConn() {
    const owned = room.conns.get(conn);
    if (owned && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(owned), "relay-cleanup");
    }
    room.conns.delete(conn);
    room.awareness.off("update", trackAwareness);
    clearInterval(pingTimer);
    try {
      conn.close();
    } catch {
      /* ignore */
    }
    maybeDropRoom(room);
  }

  conn.on("close", closeConn);
  conn.on("error", closeConn);

  // Handshake: send SyncStep1 so the client replies with its state, and send
  // current awareness so the new peer sees existing cursors. (Mirrors the
  // reference y-websocket server.)
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(conn, encoding.toUint8Array(encoder));

    const states = room.awareness.getStates();
    if (states.size > 0) {
      const awEncoder = encoding.createEncoder();
      encoding.writeVarUint(awEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awEncoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())),
      );
      send(conn, encoding.toUint8Array(awEncoder));
    }
  }
}

// --- HTTP + WS bootstrap ----------------------------------------------------

const server = http.createServer((req, res) => {
  // A tiny health endpoint so deploys/monitors can probe the relay.
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("mind-whiteboard relay — ephemeral y-websocket broker. No data stored.\n");
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (conn, req) => {
  // The client (y-websocket WebsocketProvider) appends "/" + roomname to the
  // base URL, so the board id arrives as the path. Strip the leading slash and
  // any query string.
  const url = req.url ?? "/";
  const roomName = decodeURIComponent(url.slice(1).split("?")[0]) || "default";
  setupConnection(conn, roomName);
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[relay] mind-whiteboard ephemeral relay on ws://${HOST}:${PORT} (no persistence, no pod creds)`,
  );
});

function shutdown() {
  // eslint-disable-next-line no-console
  console.log("[relay] shutting down");
  for (const room of rooms.values()) {
    room.awareness.destroy();
    room.doc.destroy();
  }
  rooms.clear();
  wss.close();
  server.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
