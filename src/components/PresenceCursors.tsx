"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState } from "react";
import { asPresenceState, type PresenceState } from "@/lib/whiteboard/presence";
import type { WhiteboardDoc } from "@/lib/whiteboard/yjs-doc";

/**
 * Live cursors overlay (W3 "see each other"). Renders one labelled cursor per
 * remote peer that is publishing a `cursor` in awareness.
 *
 * Awareness carries cursor positions in Excalidraw SCENE coordinates (canvas
 * space, independent of pan/zoom). To draw an HTML cursor we convert to SCREEN
 * pixels using *our own* viewport — so a peer's cursor lands on the same logical
 * point even though our pan/zoom differs:
 *
 *   screenX = (sceneX + scrollX) * zoom
 *   screenY = (sceneY + scrollY) * zoom
 *
 * (Excalidraw's appState `scrollX/scrollY` are additive offsets; `zoom.value` is
 * the scale.) We re-read the viewport on an animation frame so cursors track our
 * own panning/zooming smoothly, and re-render on every awareness change.
 */

type RemoteCursor = {
  clientId: number;
  state: PresenceState;
};

export function PresenceCursors({
  board,
  getApi,
}: {
  board: WhiteboardDoc;
  getApi: () => ExcalidrawImperativeAPI | null;
}) {
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  // Bump to force a re-read of our viewport (pan/zoom) each frame.
  const [, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Subscribe to awareness changes → collect every OTHER peer with a cursor.
  useEffect(() => {
    const { awareness } = board;
    const localId = awareness.clientID;

    function refresh() {
      const next: RemoteCursor[] = [];
      for (const [clientId, raw] of awareness.getStates()) {
        if (clientId === localId) continue; // never render our own cursor
        const state = asPresenceState(raw);
        if (state?.cursor) next.push({ clientId, state });
      }
      setCursors(next);
    }

    awareness.on("change", refresh);
    refresh();
    return () => {
      awareness.off("change", refresh);
    };
  }, [board]);

  // Keep remote cursors glued to scene points as WE pan/zoom: re-read viewport
  // every frame while there are cursors to show.
  useEffect(() => {
    if (cursors.length === 0) return;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      setTick((t) => (t + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      alive = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [cursors.length]);

  const api = getApi();
  if (!api || cursors.length === 0) return null;

  const app = api.getAppState();
  const { scrollX, scrollY } = app;
  const zoom = app.zoom?.value ?? 1;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {cursors.map(({ clientId, state }) => {
        const c = state.cursor!;
        // Excalidraw's sceneCoordsToViewportCoords is
        //   (sceneX + scrollX) * zoom + offsetLeft.
        // This overlay is absolute-inset-0 inside the SAME container as
        // <Excalidraw>, so the canvas's offsetLeft/offsetTop relative to us is 0
        // and we can drop those terms. (Excalidraw's toolbars float over a
        // full-bleed canvas, so the canvas fills the container.)
        const screenX = (c.x + scrollX) * zoom;
        const screenY = (c.y + scrollY) * zoom;
        return (
          <div
            key={clientId}
            className="absolute left-0 top-0 will-change-transform"
            style={{ transform: `translate(${screenX}px, ${screenY}px)` }}
            data-testid={`cursor-${state.user.name}`}
          >
            <CursorGlyph color={state.user.color} />
            <span
              className="ml-3 -mt-1 inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm"
              style={{ background: state.user.color }}
            >
              {state.user.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Classic arrow cursor, tinted to the peer's color. */
function CursorGlyph({ color }: { color: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      className="absolute left-0 top-0 drop-shadow"
      aria-hidden
    >
      <path
        d="M5 3l14 7-6 2-2 6-6-15z"
        fill={color}
        stroke="white"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
