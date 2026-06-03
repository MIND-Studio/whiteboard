"use client";

import {
  handleIncomingRedirect,
  type ISessionInfo,
} from "@inrupt/solid-client-authn-browser";
import { session } from "./session";

const RETURN_TO_KEY = "mind-whiteboard:return-to";

/** Where the user lands when no deep link was remembered. */
const DEFAULT_RETURN_TO = "/boards";

/**
 * The URL users should land on after the OIDC dance — set right before
 * triggering login(), read by /login/callback once the code is consumed.
 *
 * We deliberately do NOT use `restorePreviousSession: true` anywhere. In the
 * @inrupt browser SDK that flag is not a token-based silent restore — it is a
 * full-page redirect to the IdP. On CSS, calling it on every page load creates
 * an infinite /login/callback ↔ /boards loop, and even in the happy path it
 * round-trips through the IdP and discards the deep link. The price is that a
 * hard refresh (or a deep link without an OIDC code in the URL) lands on the
 * signed-out prompt. We soften that by remembering the attempted path (see
 * `rememberSignedOutPath`) so reconnecting returns there. (Ported verbatim from
 * mind-drive-v0; the loop was re-verified there 2026-06-01.)
 */
export function rememberReturnTo(url: string) {
  if (typeof window === "undefined") return;
  if (url.startsWith("/login/callback")) return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, url);
  } catch {}
}

/**
 * Set the post-login destination ONLY if one isn't already remembered. A
 * signed-out view on a deep link (e.g. /board/<id>) records that path; a generic
 * sign-in surface then uses this to fall back to /boards without clobbering it,
 * so the user returns to the board they actually wanted.
 */
export function rememberReturnToDefault(url: string) {
  if (typeof window === "undefined") return;
  try {
    if (!sessionStorage.getItem(RETURN_TO_KEY)) rememberReturnTo(url);
  } catch {}
}

/**
 * Called by signed-out screens on mount to capture where the user was trying to
 * go, so a subsequent "Sign in" → login returns them there (e.g. a friend who
 * opened a WebID-grant board link before signing in).
 */
export function rememberSignedOutPath() {
  if (typeof window === "undefined") return;
  rememberReturnTo(window.location.pathname + window.location.search);
}

export function consumeReturnTo(): string {
  if (typeof window === "undefined") return DEFAULT_RETURN_TO;
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    if (v && v.startsWith("/") && !v.startsWith("//")) return v;
  } catch {}
  return DEFAULT_RETURN_TO;
}

/**
 * Single-flight wrapper around `handleIncomingRedirect`. The OIDC authorization
 * code is one-time-use: redeeming it twice makes the token endpoint return
 * `invalid_grant`, which resets the @inrupt session back to signed-out. In
 * mind-drive that bit prod — the `/login/callback` page redeemed the code, but a
 * layout-mounted component fired its own session check concurrently and redeemed
 * the same code a second time; whichever call lost the race wiped the session,
 * so users landed signed-out nondeterministically.
 *
 * Memoizing the call to a module-level promise guarantees the redirect is
 * handled exactly once per page load no matter how many components ask for the
 * session, so the code is redeemed once and the resulting session sticks.
 */
let redirectHandled: Promise<void> | null = null;

function handleRedirectOnce(): Promise<void> {
  if (!redirectHandled) {
    redirectHandled = handleIncomingRedirect({
      url: typeof window !== "undefined" ? window.location.href : undefined,
    })
      .then(() => undefined)
      // Swallow: a stale/replayed code rejects here, but the first (winning)
      // call already established the session. Callers re-read session().info.
      .catch(() => undefined);
  }
  return redirectHandled;
}

/**
 * Idempotent session check on page load. Consumes an OIDC code if the URL has
 * one (from a fresh redirect), but does NOT trigger silent re-auth. Returns the
 * current session info — caller is responsible for handling signed-out.
 */
export async function ensureSession(): Promise<ISessionInfo> {
  const s = session();
  if (s.info.isLoggedIn) return s.info;
  await handleRedirectOnce();
  return session().info;
}

/**
 * Completes the OIDC redirect on the /login/callback route. Shares the same
 * single-flight redemption as `ensureSession`, so the callback page and any
 * concurrently-mounted component never redeem the code twice. Returns the
 * session info so the caller can route accordingly.
 */
export async function completeLoginRedirect(): Promise<ISessionInfo> {
  await handleRedirectOnce();
  return session().info;
}
