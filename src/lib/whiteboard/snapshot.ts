"use client";

import * as Y from "yjs";
import { readFileBlob, writeFileBlob, writeFileText } from "@/lib/solid/pod-fs";
import { session } from "@/lib/solid/session";
import { decryptBytes, encryptBytes, type SnapshotKey } from "./crypto";
import type { WhiteboardDoc } from "./yjs-doc";

/**
 * Debounced, end-to-end-encrypted snapshot persistence to the owner's pod
 * (PRD §3.4). The pod is the *durable, canonical* board; the relay is a dumb
 * disposable pipe. Only the owner's client snapshots, which keeps the relay
 * credential-free (PRD's "simplest correct privacy story").
 *
 * What gets written, per board:
 *   <snapshotUrl>            — IV||AES-GCM ciphertext of Y.encodeStateAsUpdate
 *   <metaUrl> (.meta.ttl)    — plaintext RDF: title, creator, created/modified,
 *                              AS2.0 type. Metadata is NOT secret (it's there so
 *                              a boards-list can show titles without the key).
 *
 * Trigger policy:
 *   • ~2s idle debounce after the doc changes (coalesces bursts of strokes).
 *   • a hard max-wait so a continuously-edited board still flushes (~5s).
 *   • `beforeunload` flush so closing the tab doesn't lose the last edits.
 *
 * This module imports pod I/O from src/lib/solid/pod-fs.ts (owned by the solid
 * layer) — it never does its own LDP HTTP. The caller supplies FULL pod URLs
 * (built via the solid layer's boardBinUrl / boardMetaUrl); snapshot.ts is
 * pod-path-agnostic, exactly mirroring the agreed contract.
 */

const DEBOUNCE_MS = 2_000; // idle quiet period before a write
const MAX_WAIT_MS = 5_000; // hard cap so a busy board still flushes

const BIN_CONTENT_TYPE = "application/octet-stream";
const TTL_CONTENT_TYPE = "text/turtle";

export type SnapshotMeta = {
  /** Human title shown in the boards list. */
  title: string;
  /** ISO timestamp the board was created. Preserved across writes by caller. */
  created?: string;
};

export type SnapshotWriterOptions = {
  /** Full pod URL of the `.bin` snapshot resource. */
  snapshotUrl: string;
  /** Full pod URL of the sibling `.meta.ttl`. */
  metaUrl: string;
  /** The board's AES key (already imported via crypto.importKey). */
  key: SnapshotKey;
  /** Board metadata for the `.meta.ttl`. */
  meta: SnapshotMeta;
  /** Optional callback for UI ("Saving…" / "Saved to your pod"). */
  onStatus?: (status: SnapshotStatus) => void;
};

export type SnapshotStatus = "idle" | "pending" | "saving" | "saved" | "error";

export type SnapshotWriter = {
  /** Force an immediate flush (e.g. on explicit "Save" or before navigating). */
  flush: () => Promise<void>;
  /** Stop watching the doc and remove the beforeunload handler. */
  destroy: () => void;
};

/**
 * Encode + encrypt the current doc state. Exposed for tests and for a one-shot
 * "save now" path that doesn't need the debounce machinery.
 */
export async function encodeEncryptedSnapshot(doc: Y.Doc, key: SnapshotKey): Promise<Blob> {
  const update = Y.encodeStateAsUpdate(doc);
  const ciphertext = await encryptBytes(key, update);
  return new Blob([ciphertext as BlobPart], { type: BIN_CONTENT_TYPE });
}

/**
 * Fetch + decrypt a board snapshot from a pod URL. Used to seed the Y.Doc when
 * opening an existing board (owner) or a shared link (friend). The friend case
 * passes the `pod=` URL straight from the share link — a different pod origin —
 * and `readFileBlob` just GETs it with the current session's authed fetch
 * (or anonymously for a public link).
 *
 * Returns the raw Yjs update bytes; the caller applies them with
 * `Y.applyUpdate` (see excalidraw-bridge.seedDocFromUpdate).
 */
export async function fetchDecryptedSnapshot(
  snapshotUrl: string,
  key: SnapshotKey,
): Promise<Uint8Array> {
  const blob = await readFileBlob(snapshotUrl);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return decryptBytes(key, bytes);
}

function turtleEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Build the `.meta.ttl` body. Plaintext on purpose: it carries no stroke data,
 * just enough for a boards list (title, owner, timestamps) and an AS2.0 type so
 * the resource is self-describing.
 */
export function buildMetaTurtle(
  meta: SnapshotMeta,
  creatorWebId: string | null,
  modifiedIso: string,
): string {
  const created = meta.created ?? modifiedIso;
  const creatorLine = creatorWebId ? `    dcterms:creator <${creatorWebId}> ;\n` : "";
  return `@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<>
    a as:Document ;
    dcterms:title "${turtleEscape(meta.title)}" ;
${creatorLine}    dcterms:created "${created}"^^xsd:dateTime ;
    dcterms:modified "${modifiedIso}"^^xsd:dateTime .
`;
}

/**
 * One-shot write of both resources. Encrypts + PUTs the `.bin`, then writes the
 * `.meta.ttl`. Returns the snapshot URL `writeFileBlob` resolved to.
 */
export async function writeSnapshotOnce(
  doc: Y.Doc,
  opts: { snapshotUrl: string; metaUrl: string; key: SnapshotKey; meta: SnapshotMeta },
): Promise<void> {
  const blob = await encodeEncryptedSnapshot(doc, opts.key);
  await writeFileBlob(opts.snapshotUrl, blob, BIN_CONTENT_TYPE);

  const modifiedIso = new Date().toISOString();
  const creator = session().info.webId ?? null;
  const ttl = buildMetaTurtle(opts.meta, creator, modifiedIso);
  await writeFileText(opts.metaUrl, ttl, TTL_CONTENT_TYPE);
}

/**
 * Attach a debounced snapshot writer to a board. Returns a handle; call
 * `destroy()` on unmount. Only the *owner* should create one of these (a
 * read-only friend never writes back to the owner's pod).
 */
export function createSnapshotWriter(
  board: WhiteboardDoc,
  opts: SnapshotWriterOptions,
): SnapshotWriter {
  const { doc } = board;
  const { snapshotUrl, metaUrl, key, meta, onStatus } = opts;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let inFlight: Promise<void> | null = null;
  let destroyed = false;

  function setStatus(s: SnapshotStatus) {
    onStatus?.(s);
  }

  function clearTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  async function doWrite() {
    clearTimers();
    if (!dirty) return;
    dirty = false;
    setStatus("saving");
    try {
      await writeSnapshotOnce(doc, { snapshotUrl, metaUrl, key, meta });
      setStatus("saved");
    } catch (err) {
      // Mark dirty again so the next change (or flush) retries; surface error.
      dirty = true;
      setStatus("error");
      throw err;
    }
  }

  async function flush(): Promise<void> {
    // Serialize: if a write is already running, wait for it, then write again
    // only if something changed in the meantime.
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    if (!dirty) return;
    inFlight = doWrite().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  function scheduleWrite() {
    if (destroyed) return;
    dirty = true;
    setStatus("pending");
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void flush().catch(() => {}), DEBOUNCE_MS);
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => void flush().catch(() => {}), MAX_WAIT_MS);
    }
  }

  // Watch every doc mutation. We snapshot the WHOLE doc state, so any update
  // (local or remote) marks the board dirty — the owner is the durable writer
  // for the shared board, including a collaborator's strokes.
  const updateHandler = () => scheduleWrite();
  doc.on("update", updateHandler);

  // beforeunload: synchronous best-effort flush. We can't await an async PUT in
  // beforeunload reliably, so we fire it and also use sendBeacon-less direct
  // write; modern browsers keep the fetch alive briefly with keepalive. The
  // pod-fs layer doesn't expose keepalive, so this is best-effort: the 2s
  // debounce + max-wait already cover the common case.
  const beforeUnload = () => {
    if (dirty) void flush().catch(() => {});
  };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", beforeUnload);
    // pagehide is more reliable than beforeunload on mobile Safari.
    window.addEventListener("pagehide", beforeUnload);
  }

  return {
    flush,
    destroy() {
      destroyed = true;
      clearTimers();
      doc.off("update", updateHandler);
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", beforeUnload);
        window.removeEventListener("pagehide", beforeUnload);
      }
    },
  };
}
