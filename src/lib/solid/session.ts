"use client";

import { useEffect, useState } from "react";
import {
  login,
  logout,
  type Session,
} from "@inrupt/solid-client-authn-browser";
import { APP_NAME, boardsRootFor, boardBinUrlFor, boardMetaUrlFor } from "@/lib/config";
import { solid, DEFAULT_ISSUER } from "./client";
import { ensureSession } from "./auth";

/**
 * Session + issuer memory now live in the shared {@link solid} client (see
 * `client.ts` and `@mind-studio/core/solid`); these are thin shims that keep the
 * app's existing import paths stable. The board-path helpers, WebID → pod-root
 * derivation, and the `useSession` hook below are whiteboard-specific and stay
 * here.
 */
export function session(): Session {
  return solid.session();
}

/** Default OIDC issuer (config single-source). Re-exported for convenience. */
export { DEFAULT_ISSUER };

export function storedIssuer(): string {
  return solid.storedIssuer();
}

export function rememberIssuer(issuer: string) {
  solid.rememberIssuer(issuer);
}

/**
 * Derive the owner's pod storage root from their WebID. CSS WebIDs look like
 * `http://localhost:3111/alice/profile/card#me`; the storage root is the pod
 * segment `http://localhost:3111/alice/`. We strip a trailing `profile/card`
 * (with or without the `#me` fragment) and keep the path up to it.
 *
 * Returns null when signed out (no WebID). Board URLs are built from this; a
 * FRIEND opening a share link does NOT use it — their snapshot URL comes from
 * the link's `pod=` param (a different pod's origin).
 */
export function podRoot(): string | null {
  const webId = session().info.webId;
  if (!webId) return null;
  return podRootFromWebId(webId);
}

/** Pure helper — also used by the seed script's webId derivation. */
export function podRootFromWebId(webId: string): string {
  // Drop the fragment, then strip a trailing `profile/card`.
  const noFragment = webId.split("#")[0];
  const stripped = noFragment.replace(/profile\/card$/, "");
  return stripped.endsWith("/") ? stripped : `${stripped}/`;
}

/**
 * `<podRoot>/<namespace>/boards/`. Throws if signed out (no pod root) unless an
 * explicit root is passed — callers building a friend's board URL should pass
 * the root parsed from the share link instead.
 */
export function boardsContainerUrl(root?: string): string {
  const r = root ?? podRoot();
  if (!r) throw new Error("boardsContainerUrl: not signed in (no pod root)");
  return boardsRootFor(r);
}

/** Full URL of a board's encrypted snapshot (`<id>.bin`). */
export function boardBinUrl(id: string, root?: string): string {
  const r = root ?? podRoot();
  if (!r) throw new Error("boardBinUrl: not signed in (no pod root)");
  return boardBinUrlFor(r, id);
}

/** Full URL of a board's Turtle metadata sidecar (`<id>.meta.ttl`). */
export function boardMetaUrl(id: string, root?: string): string {
  const r = root ?? podRoot();
  if (!r) throw new Error("boardMetaUrl: not signed in (no pod root)");
  return boardMetaUrlFor(r, id);
}

/**
 * Client-side Inrupt session hook. Stable signature (consumed by LandingLogin,
 * BoardsList, and the board view components) — do not change without updating
 * call sites.
 *
 * On mount it runs the single-flight `ensureSession()` (lib/solid/auth.ts):
 * consumes an OIDC code if the URL has one, but does NOT trigger
 * `restorePreviousSession` (which is a full IdP redirect, not a silent restore,
 * and loops on CSS — see auth.ts). The exposed DPoP-bound `fetch` is what every
 * pod read/write goes through.
 */
export function useSession(): {
  webid: string | null;
  loggedIn: boolean;
  loading: boolean;
  fetch: typeof globalThis.fetch | null;
  signIn: (issuer: string) => Promise<void>;
  signOut: () => Promise<void>;
} {
  const [current, setCurrent] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureSession();
      } catch {
        // Signed-out is a valid state; the caller renders the login surface.
      }
      if (!cancelled) {
        setCurrent(session());
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn(issuer: string) {
    rememberIssuer(issuer);
    await login({
      oidcIssuer: issuer,
      redirectUrl:
        typeof window !== "undefined"
          ? `${window.location.origin}/login/callback`
          : "",
      clientName: APP_NAME,
    });
  }

  async function signOut() {
    await logout();
    // `getDefaultSession()` returns the same singleton every call, so re-setting
    // it is a no-op for React (Object.is) and consumers never see signed-out.
    // Set `null` (a real reference change) so `loggedIn` flips and pages route.
    setCurrent(null);
  }

  return {
    webid: current?.info?.webId ?? null,
    loggedIn: !!current?.info?.isLoggedIn,
    loading,
    fetch: current?.fetch ?? null,
    signIn,
    signOut,
  };
}
