"use client";

import {
  type SubscriptionHandle,
  type SubscriptionState,
  subscribeToBoard,
} from "@/lib/solid/notifications";
import type { SnapshotKey } from "@/lib/whiteboard/crypto";
import { fetchDecryptedSnapshot } from "@/lib/whiteboard/snapshot";
import type { WhiteboardDoc } from "@/lib/whiteboard/yjs-doc";

/**
 * Board wake-up reload (PRD §3.5) — the cold/other-device re-seed path,
 * extracted into one reusable call so the board view mounts it in a single line.
 *
 * This is NOT the live hot path. Strokes and cursors flow through the y-websocket
 * relay + Yjs awareness; this only subscribes to the pod `.bin` via CSS
 * WebSocketChannel2023 so a client that ISN'T in the live relay room (the owner's
 * second tab, a viewer who joined cold) learns the durable snapshot changed and
 * re-fetches it. CSS notifications are change-signals, not deltas — every signal
 * triggers a full GET+decrypt+merge, which is exactly why we keep them off the
 * per-stroke path.
 *
 * On each change-signal: GET the snapshot → decrypt with the board key →
 * Y.applyUpdate into the live doc. Yjs merges are idempotent and commutative, so
 * re-applying a snapshot the local client itself just wrote is a no-op, and a
 * write from another device is absorbed without clobbering in-flight local edits.
 * Falls back to 2s polling if the WebSocket can't be established (handled inside
 * subscribeToBoard).
 *
 * SSR note: `seedDocFromUpdate` lives in excalidraw-bridge.ts, which value-imports
 * Excalidraw's `CaptureUpdateAction`. A static import would drag Excalidraw's
 * runtime into the server module graph and throw "window is not defined" during
 * SSR. So we lazy-import it here, inside this browser-only async flow — never at
 * module top level. (Mirrors how the board view seeds its initial snapshot.)
 */

export type BoardWakeupOptions = {
  /** The live Yjs board to merge re-fetched snapshots into. */
  board: WhiteboardDoc;
  /**
   * Full URL of the encrypted `.bin` snapshot to watch — `boardBinUrl(id)` for
   * the owner, or the share-link `pod=` param for a friend.
   */
  snapshotUrl: string;
  /** AES key for decrypting the snapshot (owner-generated or from the `#k=` link). */
  key: SnapshotKey;
  /** Optional subscription-state callback (connecting / connected / polling / error). */
  onState?: (s: SubscriptionState) => void;
};

/**
 * Start watching a board's pod snapshot for cold/other-device changes and merge
 * them into the live doc. Returns a handle whose `disconnect()` tears down the
 * subscription (and any polling fallback). Best-effort: if the subscription
 * can't be established it resolves to a no-op handle — the live relay remains the
 * collaboration path; only cross-device wake-up is lost.
 *
 * One-line mount in the board view:
 *   const wake = await startBoardWakeup({ board, snapshotUrl, key });
 *   // …on unmount: wake.disconnect();
 */
export async function startBoardWakeup(opts: BoardWakeupOptions): Promise<SubscriptionHandle> {
  const { board, snapshotUrl, key, onState } = opts;
  let disposed = false;

  // Lazy-import the bridge's seeder so Excalidraw's runtime never enters SSR.
  const { seedDocFromUpdate } = await import("@/lib/whiteboard/excalidraw-bridge");

  async function reseed(): Promise<void> {
    if (disposed) return;
    try {
      const update = await fetchDecryptedSnapshot(snapshotUrl, key);
      if (!disposed) seedDocFromUpdate(board, update);
    } catch {
      // Transient (e.g. a 404 mid-write, or a momentary auth hiccup) — the next
      // change-signal or the polling fallback will catch us up.
    }
  }

  let handle: SubscriptionHandle;
  try {
    handle = await subscribeToBoard(snapshotUrl, () => void reseed(), onState);
  } catch {
    // Subscription couldn't be established at all (e.g. an anonymous viewer with
    // no auth fetch for the owner's pod). Return a no-op handle; the relay still
    // carries same-session collaboration.
    return { disconnect() {} };
  }

  if (disposed) {
    handle.disconnect();
    return { disconnect() {} };
  }

  return {
    disconnect() {
      disposed = true;
      handle.disconnect();
    },
  };
}
