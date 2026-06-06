"use client";

import { universalAccess } from "@inrupt/solid-client";
import { session, boardBinUrl, boardMetaUrl, boardsContainerUrl } from "./session";

/**
 * Sharing for a board (W2). We use the Inrupt **Universal Access** API
 * (`universalAccess.setPublicAccess` / `setAgentAccess`) rather than the WAC- or
 * ACP-specific helpers so the same code works whether CSS serves WAC or ACP, and
 * whether we later move to a hosted ESS pod (PRD §4).
 *
 * Two tiers, both applied to THREE targets — the `.bin`, the `.meta.ttl`, and
 * the containing `boards/` folder — because a friend needs to read the snapshot,
 * its metadata, and (for the boards list / container traversal) the folder
 * itself. WAC grants don't propagate from a container to its members, so each
 * resource is granted explicitly.
 *
 * Conceptually this mirrors chat's chat-acl "re-write the authoritative
 * grant on every change" pattern: `setBoardAgentAccess` always writes the
 * desired flags for that agent on all three targets, so calling it again is the
 * idempotent way to add/keep a collaborator (pass `{ read:false, write:false }`
 * to revoke). We don't hand-write Turtle ACLs here — universalAccess is the
 * cross-config-safe path, and it sidesteps chat-acl's brittle regex ACL parser.
 *
 * v1 tradeoffs we accept (PRD §6 out-of-scope): whole-board access only (no
 * per-element WAC); no time-bounded/expiring grants (WAC has no expiry); for the
 * public tier the capability is link possession + the `#k=` fragment key.
 */

export type AccessFlags = {
  read?: boolean;
  append?: boolean;
  write?: boolean;
  controlRead?: boolean;
  controlWrite?: boolean;
};

function authedFetch(): typeof fetch {
  return session().fetch as typeof fetch;
}

/** The three resources that make up a board, in grant order (container last). */
function boardTargets(id: string): [string, string, string] {
  return [boardBinUrl(id), boardMetaUrl(id), boardsContainerUrl()];
}

// ── Public tier ────────────────────────────────────────────────────────────

export async function getPublicAccess(
  resourceUrl: string
): Promise<AccessFlags | null> {
  try {
    const access = await universalAccess.getPublicAccess(resourceUrl, {
      fetch: authedFetch(),
    });
    return access ?? null;
  } catch {
    return null;
  }
}

/** Set public read on a single resource. */
export async function setPublicRead(
  resourceUrl: string,
  read: boolean
): Promise<void> {
  await universalAccess.setPublicAccess(
    resourceUrl,
    { read },
    { fetch: authedFetch() }
  );
}

/**
 * Public-link tier: anyone with the link can read (and decrypt, via the `#k=`
 * fragment). Grants/revokes public `read` on the `.bin`, `.meta.ttl`, AND the
 * containing folder. `read:false` turns the board private again.
 */
export async function setBoardPublicAccess(
  id: string,
  read: boolean
): Promise<void> {
  for (const url of boardTargets(id)) {
    await universalAccess.setPublicAccess(
      url,
      { read },
      { fetch: authedFetch() }
    );
  }
}

// ── WebID-grant tier ─────────────────────────────────────────────────────────

export async function getAgentAccess(
  resourceUrl: string,
  webId: string
): Promise<AccessFlags | null> {
  try {
    // Signature: (resourceUrl, webId, options) — argument order is webId BEFORE
    // options; see node_modules/@inrupt/solid-client/dist/universal/
    // getAgentAccess.d.ts.
    const access = await universalAccess.getAgentAccess(resourceUrl, webId, {
      fetch: authedFetch(),
    });
    return access ?? null;
  } catch {
    return null;
  }
}

/** Set a named agent's read/write on a single resource. */
export async function setAgentAccess(
  resourceUrl: string,
  webId: string,
  flags: AccessFlags
): Promise<void> {
  // Signature: (resourceUrl, webId, access, options). webId comes BEFORE access
  // — flipping them makes the SDK throw a confusing "Expected a valid URL".
  await universalAccess.setAgentAccess(resourceUrl, webId, flags, {
    fetch: authedFetch(),
  });
}

/**
 * WebID-grant tier: grant a specific friend access by their WebID. `read` makes
 * the board viewable; `write` lets them edit the durable snapshot too. Applied
 * to the `.bin`, `.meta.ttl`, AND the containing folder. Idempotent — re-running
 * re-asserts the same grant (the chat-acl "authoritative re-write" idea). Pass
 * `{ read:false, write:false }` to revoke.
 */
export async function setBoardAgentAccess(
  id: string,
  webId: string,
  flags: { read: boolean; write?: boolean }
): Promise<void> {
  if (!isLikelyWebId(webId)) {
    throw new Error(
      "Not a WebID URL (expected http(s)://…/profile/card#me or similar)"
    );
  }
  const access: AccessFlags = {
    read: flags.read,
    write: flags.write ?? false,
    // Read access to a board needs append on the snapshot for nothing here
    // (snapshots are whole-file PUTs), but a collaborating editor needs write.
  };
  for (const url of boardTargets(id)) {
    await universalAccess.setAgentAccess(url, webId, access, {
      fetch: authedFetch(),
    });
  }
}

function isLikelyWebId(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
