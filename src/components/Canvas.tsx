"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { PresenceCursors } from "@/components/PresenceCursors";
import { type BridgeHandle, bindExcalidrawToDoc } from "@/lib/whiteboard/excalidraw-bridge";
import type { PresenceUser } from "@/lib/whiteboard/presence";
import type { WhiteboardDoc } from "@/lib/whiteboard/yjs-doc";

/**
 * The drawing surface (W1) + live-collab wiring (W3).
 *
 * Excalidraw must be loaded client-only: it touches `window`/`document` at import
 * time and has no SSR story, so we `next/dynamic(..., { ssr: false })`. Per the
 * Next 16 docs, `ssr: false` is only legal inside a Client Component — which this
 * file is ("use client") — so the dynamic() call lives here, not in the server
 * page.
 *
 * Wiring sequence (agreed with whiteboard-eng):
 *   1. BoardView creates + seeds the Yjs doc (createWhiteboardDoc, then
 *      fetchDecryptedSnapshot + seedDocFromUpdate for existing/shared boards).
 *   2. <Excalidraw excalidrawAPI={...}> fires once mounted → we bindExcalidrawToDoc
 *      (onChange ⇄ Y.Map, with the bridge's own echo guard).
 *   3. onPointerUpdate / onScrollChange publish our cursor (scene coords) +
 *      viewport into Yjs awareness so peers can render our cursor.
 *
 * `readOnly` drives Excalidraw's viewModeEnabled — a public-link viewer without
 * write access still sees live edits but can't draw (PRD §4 public tier is read).
 */

const Excalidraw = dynamic(async () => (await import("@excalidraw/excalidraw")).Excalidraw, {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-sm text-muted-foreground">
      Loading canvas…
    </div>
  ),
});

export function Canvas({
  board,
  user,
  readOnly = false,
}: {
  board: WhiteboardDoc;
  /** This client's presence identity (name + color). */
  user: PresenceUser;
  /** When true, render Excalidraw in view-only mode (no drawing). */
  readOnly?: boolean;
}) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bridgeRef = useRef<BridgeHandle | null>(null);

  // Publish our identity into awareness once (cursor positions update on move).
  // Re-runs if the resolved user changes (e.g. after the WebID loads).
  useEffect(() => {
    board.awareness.setLocalStateField("user", user);
  }, [board, user.name, user.color]);

  // Tear the bridge down on unmount (the board itself is owned by BoardView).
  useEffect(() => {
    return () => {
      bridgeRef.current?.destroy();
      bridgeRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <Excalidraw
        // Bridge binds once the imperative API is ready. The doc is already
        // seeded by BoardView, so the bridge's initial paint reflects it. The
        // bridge owns api.onChange (with its version/versionNonce echo guard), so
        // we deliberately pass NO onChange prop here — wiring both would
        // double-write the Y.Map.
        excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
          apiRef.current = api;
          bridgeRef.current = bindExcalidrawToDoc(api, board);
        }}
        viewModeEnabled={readOnly}
        // Cursor in SCENE coords → awareness. Peers convert to screen using
        // their own viewport (see PresenceCursors).
        onPointerUpdate={({ pointer }) => {
          board.awareness.setLocalStateField("cursor", {
            x: pointer.x,
            y: pointer.y,
          });
        }}
        // Keep our own viewport on the local API ref; PresenceCursors reads it
        // via getAppState() to place remote cursors. No awareness write needed —
        // a peer's viewport doesn't matter to us, only their scene-space cursor.
        UIOptions={{
          canvasActions: {
            // Excalidraw's own "Live collaboration" + "Save to..." buttons would
            // confuse the pod-backed model; hide them. Sharing is our Toolbar.
            loadScene: true,
            saveToActiveFile: false,
            export: { saveFileToDisk: true },
            toggleTheme: false,
          },
        }}
      />
      {/* Live cursors overlay — reads the same imperative API for the viewport. */}
      <PresenceCursors board={board} getApi={() => apiRef.current} />
    </div>
  );
}
