/**
 * Single source of truth for runtime config. Every Solid call + the relay URL
 * flow through here, so retargeting (local CSS, a deployed relay) is one env
 * var. `NEXT_PUBLIC_*` values are inlined at build time — change them before
 * `next dev`/`build` and hard-reload tabs after.
 */

/**
 * OIDC issuer for pod sign-in. Prod pod by default → silent SSO across siblings.
 * Canonical env name is `NEXT_PUBLIC_SOLID_ISSUER` only — the old
 * `NEXT_PUBLIC_OIDC_ISSUER` alias was dropped before the first prod build so the
 * build-time-inlined name can't drift across images (see docs/DEPLOYMENT.md §A2).
 */
export const oidcIssuer = process.env.NEXT_PUBLIC_SOLID_ISSUER ?? "https://pods.mindpods.org/";

/** Live-collaboration relay (ephemeral y-websocket). CSS=3111, app=3110, relay=3112. */
export const relayUrl = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://localhost:3112";

/**
 * The namespace mind-whiteboard claims under each user pod. Boards live under
 * `<pod>/<namespace>/boards/`. Sibling prototypes claim their own so a
 * shared-CSS scenario has no collisions.
 */
export const whiteboardNamespace =
  process.env.NEXT_PUBLIC_WHITEBOARD_NAMESPACE ?? "mind-whiteboard";

/** Display name used by the shared login card + last-identity hint. */
export const APP_NAME = "Whiteboard";

/**
 * App-owned feedback inbox (a public-append container the app developer
 * controls). All feedback — from any user, logged in or not — is POSTed here,
 * and the dev reads it from this one place. Defaults under the issuer's pod
 * root; override with `NEXT_PUBLIC_FEEDBACK_INBOX`. See
 * `@mind-studio/core/feedback`.
 */
export const feedbackInbox =
  process.env.NEXT_PUBLIC_FEEDBACK_INBOX ?? `${ensureSlash(oidcIssuer)}alice/whiteboard-feedback/`;

/**
 * Board-path helpers — the single place that knows the on-pod layout. Every
 * board lives as a sibling `.bin` (encrypted Yjs snapshot) + `.meta.ttl`
 * (title/owner/timestamps) under `<podRoot>/<namespace>/boards/`. Callers pass
 * the owner's pod root (see `podRoot()` in lib/solid/session.ts); a FRIEND
 * opening a share link uses the full snapshot URL from the link's `pod=` param
 * instead and never calls these.
 *
 * `podRoot` must be a storage-root URL ending in `/` (e.g.
 * `http://localhost:3111/alice/`).
 */
function ensureSlash(u: string): string {
  return u.endsWith("/") ? u : `${u}/`;
}

/** `<podRoot>/<namespace>/boards/` — the container all boards live in. */
export function boardsRootFor(podRoot: string): string {
  return `${ensureSlash(podRoot)}${whiteboardNamespace}/boards/`;
}

/** Encrypted Yjs snapshot URL for a board id. */
export function boardBinUrlFor(podRoot: string, id: string): string {
  return `${boardsRootFor(podRoot)}${id}.bin`;
}

/** Turtle metadata sidecar URL for a board id. */
export function boardMetaUrlFor(podRoot: string, id: string): string {
  return `${boardsRootFor(podRoot)}${id}.meta.ttl`;
}
