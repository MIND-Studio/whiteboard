"use client";

/**
 * Compose and parse the capability-URL share link (PRD §4).
 *
 *   https://<app>/board/<boardId>?pod=<encoded-pod-snapshot-URL>#k=<e2e-key>
 *
 *   • boardId  → the live relay room id (path segment).
 *   • pod=     → where the durable encrypted snapshot lives, so a friend can
 *                seed the canvas before going live. URL-encoded because it is
 *                itself an absolute https URL.
 *   • #k=      → the AES key (base64url, from crypto.exportKey). It lives in the
 *                URL *fragment* so browsers never transmit it to the relay or
 *                pod — they only ever see ciphertext. Possession of the full
 *                link is the capability to decrypt.
 *
 * This module is pure string/URL work: it does NOT set pod access (that is the
 * Share dialog calling the solid access layer) and does NOT touch crypto keys
 * beyond carrying the already-exported base64url string.
 */

export type ShareLinkParts = {
  /** Relay room id and pod path segment. */
  boardId: string;
  /** Absolute URL of the `.bin` snapshot in the owner's pod. */
  snapshotUrl: string;
  /** base64url AES key from `crypto.exportKey`. */
  key: string;
};

/**
 * Build the capability URL.
 *
 * @param appOrigin e.g. `https://whiteboard.mindpods.org` or
 *   `window.location.origin` in the browser. No trailing slash required.
 */
export function composeShareLink(
  appOrigin: string,
  { boardId, snapshotUrl, key }: ShareLinkParts,
): string {
  const origin = appOrigin.replace(/\/+$/, "");
  const id = encodeURIComponent(boardId);
  // `pod` is a query param whose value is a full URL — encode it so its own
  // `?`/`#`/`/` don't corrupt the outer URL.
  const pod = encodeURIComponent(snapshotUrl);
  // The fragment key is already base64url (no chars needing escaping), but
  // encode defensively in case a caller passes a non-canonical value.
  const k = encodeURIComponent(key);
  return `${origin}/board/${id}?pod=${pod}#k=${k}`;
}

/**
 * Parse a capability URL back into its parts. Returns `null` if the URL is not
 * a well-formed board link (missing board id, `pod=`, or `#k=`).
 *
 * Accepts either a full URL string or, in the browser, can be called with
 * `window.location.href`.
 */
export function parseShareLink(href: string): ShareLinkParts | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  // Path: /board/<boardId>
  const segments = url.pathname.split("/").filter(Boolean);
  const boardIdx = segments.indexOf("board");
  const rawBoardId =
    boardIdx >= 0 && segments.length > boardIdx + 1 ? segments[boardIdx + 1] : undefined;
  if (!rawBoardId) return null;
  const boardId = decodeURIComponent(rawBoardId);

  const rawPod = url.searchParams.get("pod");
  if (!rawPod) return null;
  // `URLSearchParams.get` already percent-decodes once; guard against a value
  // that isn't an absolute URL.
  let snapshotUrl: string;
  try {
    snapshotUrl = new URL(rawPod).toString();
  } catch {
    return null;
  }

  // Fragment: #k=<key>. `url.hash` includes the leading "#".
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const frag = new URLSearchParams(hash);
  const rawKey = frag.get("k");
  if (!rawKey) return null;
  const key = rawKey; // URLSearchParams already decoded it

  return { boardId, snapshotUrl, key };
}

/**
 * Read just the fragment key from the current location (browser). Convenience
 * for a board page that already knows its `boardId` from the route and reads
 * `pod` from `searchParams`, but still needs the never-sent-to-server `#k=`.
 */
export function keyFromLocationHash(hash: string): string | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const frag = new URLSearchParams(h);
  return frag.get("k");
}
