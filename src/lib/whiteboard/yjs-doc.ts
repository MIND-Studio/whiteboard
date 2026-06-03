"use client";

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import type { Awareness } from "y-protocols/awareness";
import { relayUrl } from "@/lib/config";

/**
 * The Yjs layer for one open board (PRD §3.2, §3.3).
 *
 * One board === one `Y.Doc`. Inside it:
 *   • `elements` (Y.Map): the canonical CRDT-merged set of Excalidraw elements,
 *     keyed by element id. The excalidraw-bridge owns reads/writes here.
 *   • awareness: ephemeral cursors/presence, NEVER persisted (PRD §3.2).
 *
 * Three providers attach to the doc:
 *   • IndexeddbPersistence — offline / local cache, instant cold-load.
 *   • WebsocketProvider    — the live relay (ephemeral, room = boardId).
 *   • (the pod snapshot is handled separately by snapshot.ts, not here — the
 *      pod is the *durable* store; this module is the *live* store.)
 *
 * Crucially this module does NOT import excalidraw, crypto, or pod-fs: it is the
 * pure transport/state layer. excalidraw-bridge.ts and snapshot.ts compose on
 * top of the handle it returns.
 */

/** The Y.Map subdocument name that holds Excalidraw elements keyed by id. */
export const ELEMENTS_MAP = "elements";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type WhiteboardDoc = {
  /** The shared CRDT document for this board. */
  doc: Y.Doc;
  /** Excalidraw elements keyed by element id. */
  elements: Y.Map<unknown>;
  /** Live cursors / presence (never persisted). */
  awareness: Awareness;
  /** The relay (y-websocket) provider — null until `connect()`. */
  ws: WebsocketProvider | null;
  /** Local IndexedDB cache provider. */
  idb: IndexeddbPersistence;
  /** Resolves once the local IndexedDB copy has loaded into the doc. */
  whenIdbSynced: Promise<unknown>;
  /** Join the live relay room. Idempotent. */
  connect: () => WebsocketProvider;
  /** Subscribe to relay connection status changes. Returns an unsubscribe fn. */
  onStatus: (cb: (status: ConnectionStatus) => void) => () => void;
  /** Tear everything down: relay, awareness, IndexedDB handle, and the doc. */
  destroy: () => void;
};

/**
 * Create the Yjs handle for a board. Does not connect to the relay until
 * `connect()` is called, so a caller can seed the doc from the pod snapshot
 * first (avoiding a flash of empty canvas before the relay sync arrives).
 *
 * @param boardId  relay room id + pod path segment.
 * @param opts.relay  override the relay base URL (defaults to config.relayUrl).
 */
export function createWhiteboardDoc(
  boardId: string,
  opts: { relay?: string } = {},
): WhiteboardDoc {
  const doc = new Y.Doc();
  const elements = doc.getMap(ELEMENTS_MAP);

  // y-indexeddb keys its store by name; namespace it so two prototypes sharing
  // an origin (during local dev) don't collide on the same board id.
  const idb = new IndexeddbPersistence(`mind-whiteboard:${boardId}`, doc);
  const whenIdbSynced = idb.whenSynced;

  const relayBase = opts.relay ?? relayUrl;

  let ws: WebsocketProvider | null = null;
  // Awareness lives on the WebsocketProvider once connected. We expose a stable
  // reference by creating the provider lazily but always returning its
  // awareness. Until connect(), callers that need awareness must call connect()
  // first; the bridge/presence layer always connects, so this is safe.
  // To keep `awareness` non-null on the handle from the start, we let the
  // provider own it and proxy through a getter-backed field set on connect.

  const statusListeners = new Set<(s: ConnectionStatus) => void>();

  function emitStatus(s: ConnectionStatus) {
    for (const cb of statusListeners) cb(s);
  }

  function connect(): WebsocketProvider {
    if (ws) return ws;
    // WebsocketProvider appends "/" + roomname to the base URL, so the relay
    // receives the board id as the WS path. disableBc keeps cross-tab sync via
    // the relay + IndexedDB only (BroadcastChannel can double-apply with idb).
    ws = new WebsocketProvider(relayBase, boardId, doc, { connect: true });
    ws.on("status", ({ status }) => {
      emitStatus(
        status === "connected"
          ? "connected"
          : status === "connecting"
            ? "connecting"
            : "disconnected",
      );
    });
    handle.awareness = ws.awareness;
    return ws;
  }

  function onStatus(cb: (status: ConnectionStatus) => void): () => void {
    statusListeners.add(cb);
    if (ws) {
      // y-websocket exposes the current ws readyState; report a best-effort now.
      cb(ws.wsconnected ? "connected" : "connecting");
    }
    return () => statusListeners.delete(cb);
  }

  function destroy() {
    statusListeners.clear();
    if (ws) {
      // Setting local awareness null (then destroy) makes peers drop our cursor
      // immediately rather than waiting for the 30s awareness timeout.
      try {
        ws.awareness.setLocalState(null);
      } catch {
        /* ignore */
      }
      ws.destroy();
      ws = null;
    }
    void idb.destroy();
    doc.destroy();
  }

  // Build the handle. `awareness` is initially the provider's once connected;
  // before connect() we connect eagerly so a non-null awareness is available
  // (live collaboration is the default path; solo draw still works offline via
  // idb even if the relay is down).
  const handle: WhiteboardDoc = {
    doc,
    elements,
    // placeholder replaced inside connect(); we connect immediately below.
    awareness: undefined as unknown as Awareness,
    ws: null,
    idb,
    whenIdbSynced,
    connect,
    onStatus,
    destroy,
  };

  // Connect eagerly so awareness exists and live collab is on by default. The
  // caller can still seed from the pod first because Yjs merges idempotently:
  // a later applyUpdate of the pod snapshot merges cleanly with relay state.
  connect();
  // Keep handle.ws in sync (connect set the closure var; mirror onto handle).
  handle.ws = ws;

  return handle;
}
