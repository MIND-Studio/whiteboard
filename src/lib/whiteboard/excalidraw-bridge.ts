"use client";

import * as Y from "yjs";
import type { CaptureUpdateActionType } from "@excalidraw/excalidraw/store";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { WhiteboardDoc } from "./yjs-doc";

/**
 * We intentionally do NOT `import { CaptureUpdateAction } from
 * "@excalidraw/excalidraw"`. That is a *value* import, and pulling it into this
 * module's top level drags the entire browser-only `@excalidraw/excalidraw`
 * bundle into the static module graph — which (a) defeats the `ssr:false`
 * dynamic import of the Excalidraw component in Canvas.tsx, and (b) throws
 * `window is not defined` at module-eval time during SSR, breaking the client
 * wiring so the bridge's onChange never registers (the "draw produces no Yjs
 * update" bug). The enum value is just a string literal union, so we use the
 * literal directly, typed against `CaptureUpdateActionType` (a type-only import,
 * erased at build, no runtime dependency on the package).
 */
const CAPTURE_NEVER: CaptureUpdateActionType = "NEVER";

/**
 * `restoreElements` normalizes partial/foreign elements, backfilling every
 * default field Excalidraw's renderer + hit-tester assume are present (most
 * importantly `backgroundColor` — Excalidraw's `shouldTestInside` → `isTransparent`
 * reads `color.length` and crashes on `undefined`; also `points`, `groupIds`,
 * `roundness`, etc.). Elements that arrive over the relay / from a pod snapshot
 * are reconstructed by Yjs from a binary update on the *peer's* side and can be
 * missing fields the local Excalidraw version requires (different versions emit
 * different field sets; undefined-valued fields don't round-trip). Running them
 * through Excalidraw's own restorer before `updateScene` guarantees well-formed
 * elements — this is exactly what Excalidraw does when importing external scenes.
 *
 * Like `CaptureUpdateAction`, `restoreElements` is a *value* in
 * `@excalidraw/excalidraw`, so we MUST NOT static-import it (that re-introduces
 * the `window is not defined` SSR crash). We dynamic-import it lazily and cache
 * the promise; the import only runs in the browser (bindExcalidrawToDoc is
 * called from the client-only Excalidraw mount).
 */
type RestoreElementsFn = (
  elements: readonly ExcalidrawElement[],
  localElements: readonly ExcalidrawElement[] | null,
) => ExcalidrawElement[];

let restoreElementsPromise: Promise<RestoreElementsFn> | null = null;
function loadRestoreElements(): Promise<RestoreElementsFn> {
  if (!restoreElementsPromise) {
    restoreElementsPromise = import("@excalidraw/excalidraw").then(
      (m) => m.restoreElements as unknown as RestoreElementsFn,
    );
  }
  return restoreElementsPromise;
}

/**
 * The Excalidraw ⇄ Yjs bridge (PRD §3.2).
 *
 * Excalidraw is not natively a CRDT. We own a thin, per-element bridge:
 *   • `Y.Map` keyed by element `id`, each value the full element object.
 *   • Excalidraw `onChange` → diff against last-seen versions → write only the
 *     changed elements into the Y.Map (so we don't rewrite the whole scene on
 *     every pointer move).
 *   • Y.Map `observe` → rebuild the merged element set → `updateScene`.
 *
 * Echo-loop guard. Both directions touch the same data, so a naive bridge would
 * loop forever (onChange → Y.Map → observer → updateScene → onChange → ...).
 * Two defenses:
 *   1. A transaction *origin* tag (`BRIDGE_ORIGIN`): the observer ignores any
 *      Y.Map event whose transaction originated from this bridge's own writes.
 *      (We still apply *remote* changes, whose origin is the relay/provider.)
 *   2. Per-element version coalescing: Excalidraw bumps `version` (and a random
 *      `versionNonce`) on every real mutation. We remember the last version we
 *      wrote per id and skip writing when unchanged; on the read side we skip
 *      elements whose incoming version is <= the version already on canvas.
 *      This is exactly the field Excalidraw's own `reconcileElements` keys on.
 */

/** Transaction origin marking writes that came from the local canvas. */
const BRIDGE_ORIGIN = Symbol("excalidraw-bridge");

/** A stored element is just the Excalidraw element object (structured-cloneable). */
type StoredElement = ExcalidrawElement;

export type BridgeHandle = {
  /** Detach all listeners. Safe to call once. */
  destroy: () => void;
};

/**
 * Wire an Excalidraw imperative API instance to a board's Y.Doc. Call once the
 * Excalidraw `excalidrawAPI` callback has fired and the doc has been seeded
 * (from pod snapshot and/or IndexedDB).
 */
export function bindExcalidrawToDoc(
  api: ExcalidrawImperativeAPI,
  board: WhiteboardDoc,
): BridgeHandle {
  const { elements: ymap, doc } = board;

  // Last element version we have reflected, per id, used by BOTH directions to
  // decide whether an incoming change is newer than what we already have.
  const seenVersion = new Map<string, number>();

  // `restoreElements`, once its dynamic import resolves. Until then we DEFER
  // painting rather than fall back to raw elements (see applyFromYMap's
  // invariant — a partial element crashes Excalidraw's hit-tester). `pendingPaint`
  // records that a paint was requested while the restorer was still loading, so
  // we can run it the instant the import resolves. In practice the import is
  // already cached by the time the bridge binds (Canvas.tsx dynamic-imports the
  // same package to mount Excalidraw), so this window is sub-millisecond.
  let restoreElements: RestoreElementsFn | null = null;
  let pendingPaint = false;
  void loadRestoreElements().then((fn) => {
    restoreElements = fn;
    // Run the paint that was deferred while the restorer was still loading.
    if (pendingPaint) {
      pendingPaint = false;
      applyFromYMap();
    }
  });

  // --- canvas → Y.Map -------------------------------------------------------

  function pushToYMap(elements: readonly ExcalidrawElement[]) {
    // Collect the writes first, then apply in a single transaction tagged with
    // our origin so the observer can ignore them.
    const liveIds = new Set<string>();
    const writes: Array<[string, StoredElement]> = [];

    for (const el of elements) {
      liveIds.add(el.id);
      const prev = seenVersion.get(el.id);
      // Excalidraw deletes are soft: element stays with isDeleted=true and a
      // bumped version, so the version check below handles deletes too.
      if (prev === undefined || el.version > prev) {
        writes.push([el.id, el]);
      }
    }

    // Elements that vanished entirely from the scene (rare — Excalidraw usually
    // soft-deletes) get tombstoned so peers drop them.
    const removals: string[] = [];
    for (const id of ymap.keys()) {
      if (!liveIds.has(id)) removals.push(id);
    }

    if (writes.length === 0 && removals.length === 0) return;

    doc.transact(() => {
      for (const [id, el] of writes) {
        ymap.set(id, el as unknown);
        seenVersion.set(id, el.version);
      }
      for (const id of removals) {
        ymap.delete(id);
        seenVersion.delete(id);
      }
    }, BRIDGE_ORIGIN);
  }

  const unsubOnChange = api.onChange((elements) => {
    pushToYMap(elements);
  });

  // --- Y.Map → canvas -------------------------------------------------------

  function applyFromYMap() {
    // INVARIANT (WB-1): never hand Excalidraw an un-normalized element. A peer-
    // or snapshot-reconstructed element can be missing fields the local
    // Excalidraw version requires; the hit-tester then throws the instant the
    // pointer is over it (`TypeError: Cannot read properties of undefined
    // (reading 'length')` — e.g. isTransparent reading an undefined
    // backgroundColor). So if the restorer hasn't resolved yet, DEFER the whole
    // paint — never paint raw as a stopgap. A friend opening a share link
    // typically has the pointer already resting over a shape, so the very first
    // paint would hit-test a malformed element and throw repeatedly. The
    // loadRestoreElements() callback re-invokes applyFromYMap once ready.
    if (!restoreElements) {
      pendingPaint = true;
      return;
    }

    // Rebuild the full element set from the Y.Map. Excalidraw's updateScene
    // expects the complete elements array; it diffs internally.
    const merged: ExcalidrawElement[] = [];
    for (const value of ymap.values()) {
      const el = value as StoredElement;
      merged.push(el);
      seenVersion.set(el.id, el.version);
    }

    // Normalize peer-reconstructed elements so Excalidraw's renderer + hit-test
    // never see a missing required field. localElements = current canvas
    // elements, so restore can preserve any local-only ordering/version info
    // while backfilling defaults.
    const elements = restoreElements(
      merged,
      api.getSceneElementsIncludingDeleted(),
    );

    api.updateScene({
      elements,
      // NEVER → remote merges don't enter the local undo/redo history, which is
      // the correct behavior for collaborative edits (PRD W3).
      captureUpdate: CAPTURE_NEVER,
    });
  }

  const observer = (_event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    // Ignore our own writes (origin === BRIDGE_ORIGIN); apply everything else
    // (remote relay updates, pod-snapshot seeds, IndexedDB loads).
    if (txn.origin === BRIDGE_ORIGIN) return;
    applyFromYMap();
  };

  ymap.observe(observer);

  // Initial paint: if the doc was seeded before binding (pod snapshot / idb),
  // reflect it onto the canvas now.
  if (ymap.size > 0) applyFromYMap();

  return {
    destroy() {
      unsubOnChange();
      ymap.unobserve(observer);
    },
  };
}

/**
 * Seed a freshly-created Y.Doc from a decrypted pod snapshot update. Applied
 * with a non-bridge origin so, if the canvas is already bound, the observer
 * paints it. Use this BEFORE `bindExcalidrawToDoc` when possible (cleaner), or
 * after (the observer will catch it).
 */
export function seedDocFromUpdate(board: WhiteboardDoc, update: Uint8Array) {
  Y.applyUpdate(board.doc, update, "pod-snapshot");
}
