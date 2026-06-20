"use client";

/**
 * Presence helpers shared by the live board view (PRD §3.2, W3 "see each other").
 *
 * Awareness state is ephemeral and never persisted (the relay drops it on
 * disconnect). We publish a small, fixed-shape record per peer so cursors and the
 * collaborators bar render the same identity consistently:
 *
 *   { user: { name, color }, cursor?: { x, y } }    // cursor in SCENE coords
 *
 * The `user` field name matches the convention y-websocket awareness examples use,
 * but nothing external depends on it — it's our own shape, read only by
 * PresenceCursors and CollaboratorsBar.
 */

export type PresenceUser = {
  /** Display name (WebID leaf, persona name, or "Guest"). */
  name: string;
  /** Stable hex color for this peer's cursor + avatar. */
  color: string;
};

export type PresenceCursor = {
  /** Excalidraw SCENE coordinates (not screen pixels). */
  x: number;
  y: number;
};

export type PresenceState = {
  user: PresenceUser;
  cursor?: PresenceCursor;
};

/**
 * Distinct, high-contrast cursor colors. Picked for visibility on both the light
 * and dark Excalidraw canvas; index chosen from the Yjs clientID so a peer keeps
 * the same color for the session without any coordination.
 */
const CURSOR_COLORS = [
  "#d97706", // amber (the whiteboard accent)
  "#2563eb", // blue
  "#16a34a", // green
  "#db2777", // pink
  "#9333ea", // purple
  "#0891b2", // cyan
  "#ea580c", // orange
  "#65a30d", // lime
];

/** Deterministic color for a peer from its Yjs clientID (stable per session). */
export function colorForClient(clientId: number): string {
  return CURSOR_COLORS[Math.abs(clientId) % CURSOR_COLORS.length];
}

/**
 * Best-effort display name from a WebID. CSS WebIDs look like
 * `http://localhost:3111/alice/profile/card#me` → "alice". Falls back to "Guest"
 * for anonymous viewers (public-link tier, no login).
 */
export function nameFromWebId(webId: string | null | undefined): string {
  if (!webId) return "Guest";
  try {
    const noFragment = webId.split("#")[0];
    const segments = noFragment.split("/").filter(Boolean);
    // Drop a trailing profile/card so we land on the pod segment (the username).
    const meaningful = segments.filter((s) => s !== "profile" && s !== "card" && !s.includes(":"));
    return meaningful[0] ?? "Guest";
  } catch {
    return "Guest";
  }
}

/** Two initials for an avatar fallback (e.g. "alice" → "AL", "Bob Smith" → "BS"). */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Read a typed PresenceState from a raw awareness record (defensive). */
export function asPresenceState(raw: unknown): PresenceState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const user = r.user as Record<string, unknown> | undefined;
  if (!user || typeof user.name !== "string" || typeof user.color !== "string") {
    return null;
  }
  const cursor = r.cursor as Record<string, unknown> | undefined;
  const hasCursor = cursor && typeof cursor.x === "number" && typeof cursor.y === "number";
  return {
    user: { name: user.name, color: user.color },
    cursor: hasCursor ? { x: cursor!.x as number, y: cursor!.y as number } : undefined,
  };
}
