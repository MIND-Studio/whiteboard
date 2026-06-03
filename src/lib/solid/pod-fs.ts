"use client";

import {
  getSolidDataset,
  getContainedResourceUrlAll,
  getThing,
  getDatetime,
  getInteger,
  getStringNoLocale,
  deleteFile,
  deleteContainer,
  overwriteFile,
  getFile,
  createContainerAt,
  getSourceUrl,
} from "@inrupt/solid-client";
import { session, boardsContainerUrl } from "./session";

/**
 * POSIX-shaped wrappers around the Solid LDP HTTP API, ported from
 * mind-drive-v0. The whiteboard's snapshot layer (snapshot.ts, Task #3) and the
 * boards-list UI (Task #4) both call through here. Signatures are deliberately
 * identical to mind-drive-v0/src/lib/solid/pod-fs.ts — whiteboard-eng's
 * snapshot.ts imports writeFileBlob/readFileBlob/writeFileText against this
 * exact contract.
 *
 * Limits we accept (Solid-protocol-level, not ours to fix):
 *   - LDP PUT replaces the whole resource. Write is whole-file only — which is
 *     exactly what a debounced full-doc Yjs snapshot wants.
 *   - readdir() is one level deep.
 */

export type PodEntry = {
  url: string;
  name: string;
  kind: "container" | "resource";
  modified?: Date;
  /** Server-reported size in bytes if exposed via posix:size; else undefined. */
  size?: number;
};

function authedFetch(): typeof fetch {
  return session().fetch as typeof fetch;
}

function ensureSlash(u: string) {
  return u.endsWith("/") ? u : u + "/";
}

function basename(url: string, parent: string): string {
  const tail = url.slice(parent.length);
  if (tail.endsWith("/")) return tail.slice(0, -1);
  return tail;
}

/**
 * Wrap the authenticated fetch with `cache: 'no-store'` so CSS containment
 * triples aren't served from the browser cache after a write. Without this,
 * readdir() right after a snapshot write would see a stale listing — the
 * "My boards" list would miss a board just created.
 */
function noCacheFetch(): typeof fetch {
  const inner = session().fetch as typeof fetch;
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    inner(url, { ...init, cache: "no-store" })) as typeof fetch;
}

export async function readdir(containerUrl: string): Promise<PodEntry[]> {
  const parent = ensureSlash(containerUrl);
  const dataset = await getSolidDataset(parent, { fetch: noCacheFetch() });
  const urls = getContainedResourceUrlAll(dataset);
  return urls
    .map((url): PodEntry => {
      const isContainer = url.endsWith("/");
      const thing = getThing(dataset, url);
      const modified = thing
        ? getDatetime(thing, "http://purl.org/dc/terms/modified") ?? undefined
        : undefined;
      const size = thing
        ? getInteger(thing, "http://www.w3.org/ns/posix/stat#size") ?? undefined
        : undefined;
      return {
        url,
        name: basename(url, parent),
        kind: isContainer ? "container" : "resource",
        modified: modified ?? undefined,
        size: size ?? undefined,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "container" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export async function readFileText(url: string): Promise<string> {
  const blob = await getFile(url, { fetch: authedFetch() });
  return await blob.text();
}

export async function readFileBlob(url: string): Promise<Blob> {
  return await getFile(url, { fetch: authedFetch() });
}

export async function writeFileText(
  url: string,
  contents: string,
  contentType = "text/plain"
): Promise<void> {
  await overwriteFile(url, new Blob([contents], { type: contentType }), {
    contentType,
    fetch: authedFetch(),
  });
}

export async function writeFileBlob(
  url: string,
  blob: Blob,
  contentType?: string
): Promise<string> {
  const type = contentType ?? blob.type ?? "application/octet-stream";
  const result = await overwriteFile(url, blob, {
    contentType: type,
    fetch: authedFetch(),
  });
  return getSourceUrl(result) ?? url;
}

export async function unlink(url: string): Promise<void> {
  if (url.endsWith("/")) {
    await deleteContainer(url, { fetch: authedFetch() });
  } else {
    await deleteFile(url, { fetch: authedFetch() });
  }
}

/**
 * Create a container. NOTE: CSS v7 rejects a PUT to an already-existing
 * container with 409 "Existing containers cannot be updated via PUT", so this is
 * NOT safe to call when the container may already exist — use
 * `ensureBoardsContainer` (which checks first) for the idempotent path.
 */
export async function mkdir(url: string): Promise<string> {
  const target = ensureSlash(url);
  const result = await createContainerAt(target, { fetch: authedFetch() });
  return getSourceUrl(result) ?? target;
}

/** True if a container already exists (a successful GET of its listing). */
async function containerExists(url: string): Promise<boolean> {
  try {
    await getSolidDataset(ensureSlash(url), { fetch: noCacheFetch() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `<podRoot>/<namespace>/boards/` exists so the owner's first snapshot
 * PUT doesn't 404 on a missing parent. Genuinely idempotent — safe to call on
 * every board open/create: it checks for the container first and only creates it
 * when absent (CSS v7 409s on a PUT to an existing container, so we must not
 * blindly re-create — a regression caught in end-to-end verify against a seeded
 * pod). A late-create race (two tabs) is swallowed: if the create 409s because
 * someone else just made it, that's success too. Pass an explicit `root` only
 * when acting on a non-default pod (rare).
 */
export async function ensureBoardsContainer(root?: string): Promise<string> {
  const container = boardsContainerUrl(root);
  if (await containerExists(container)) return container;
  try {
    return await mkdir(container);
  } catch (err) {
    // Lost a create race (or it appeared between the check and the PUT) — fine
    // as long as it now exists; otherwise the error is real.
    if (await containerExists(container)) return container;
    throw err;
  }
}

// ── Boards list ──────────────────────────────────────────────────────────────

export type BoardSummary = {
  /** Board id (the `<id>` in `<id>.bin`) — the relay room + route segment. */
  id: string;
  /** Absolute URL of the encrypted snapshot. */
  binUrl: string;
  /** Absolute URL of the metadata sidecar. */
  metaUrl: string;
  /** Human title from the `.meta.ttl` (falls back to the id). */
  title: string;
  /** Last-modified — from the meta's dcterms:modified, else the `.bin`'s. */
  modified?: Date;
};

const DCTERMS_TITLE = "http://purl.org/dc/terms/title";
const DCTERMS_MODIFIED = "http://purl.org/dc/terms/modified";

/**
 * Read a board's `.meta.ttl` for its title + modified time. Returns nulls (not
 * throws) on a missing/garbled sidecar — a board with a `.bin` but no readable
 * meta still lists, titled by its id.
 */
export async function readBoardMeta(
  metaUrl: string
): Promise<{ title: string | null; modified: Date | null }> {
  try {
    const dataset = await getSolidDataset(metaUrl, { fetch: noCacheFetch() });
    // The sidecar describes itself with a `<>` (empty) subject → its own URL.
    const thing = getThing(dataset, metaUrl);
    if (!thing) return { title: null, modified: null };
    return {
      title: getStringNoLocale(thing, DCTERMS_TITLE),
      modified: getDatetime(thing, DCTERMS_MODIFIED),
    };
  } catch {
    return { title: null, modified: null };
  }
}

/**
 * List the signed-in user's boards. A board "exists" if it has EITHER a
 * `<id>.bin` snapshot OR a `<id>.meta.ttl` — the union, keyed by id. (A freshly
 * created/seeded board may have only its metadata before the owner's first draw
 * writes the encrypted `.bin`; a board mid-draw before metadata is flushed has
 * only the `.bin`. Both should appear.) Each is enriched with title/modified
 * from its `.meta.ttl`, sorted most-recent first. Pass an explicit `root` to
 * list a different pod (rare). Returns [] if the container doesn't exist yet.
 */
export async function listBoards(root?: string): Promise<BoardSummary[]> {
  const container = boardsContainerUrl(root);
  let entries: PodEntry[];
  try {
    entries = await readdir(container);
  } catch {
    // 404 — container not created yet. A fresh user simply has no boards.
    return [];
  }

  // Collect board ids from .bin and .meta.ttl, remembering the .bin entry's
  // modified time as a fallback when the meta has none.
  const ids = new Map<string, { binModified?: Date }>();
  for (const e of entries) {
    if (e.kind !== "resource") continue;
    if (e.name.endsWith(".bin")) {
      const id = e.name.slice(0, -".bin".length);
      ids.set(id, { ...ids.get(id), binModified: e.modified });
    } else if (e.name.endsWith(".meta.ttl")) {
      const id = e.name.slice(0, -".meta.ttl".length);
      if (!ids.has(id)) ids.set(id, {});
    }
  }

  const summaries = await Promise.all(
    Array.from(ids.entries()).map(
      async ([id, info]): Promise<BoardSummary> => {
        const metaUrl = `${container}${id}.meta.ttl`;
        const meta = await readBoardMeta(metaUrl);
        return {
          id,
          binUrl: `${container}${id}.bin`,
          metaUrl,
          title: meta.title ?? id,
          modified: meta.modified ?? info.binModified,
        };
      }
    )
  );

  return summaries.sort((a, b) => {
    const am = a.modified?.getTime() ?? 0;
    const bm = b.modified?.getTime() ?? 0;
    return bm - am;
  });
}
