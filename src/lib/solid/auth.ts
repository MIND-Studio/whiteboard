"use client";

import type { ISessionInfo } from "@inrupt/solid-client-authn-browser";
import { solid } from "./client";

/**
 * Thin re-exports over the shared {@link solid} client (see `client.ts`). The
 * return-to memory and the single-flight `handleIncomingRedirect` wrapper all
 * live in `@mind-studio/core/solid` now; these shims keep the app's existing
 * import paths stable. Whiteboard has no broker, but core's `ensureSession`
 * falls through to the normal OIDC path when not embedded.
 */
export function rememberReturnTo(url: string): void {
  solid.rememberReturnTo(url);
}

export function rememberReturnToDefault(url: string): void {
  solid.rememberReturnToDefault(url);
}

export function rememberSignedOutPath(): void {
  solid.rememberSignedOutPath();
}

export function consumeReturnTo(): string {
  return solid.consumeReturnTo();
}

export function ensureSession(): Promise<ISessionInfo> {
  return solid.ensureSession();
}

export function completeLoginRedirect(): Promise<ISessionInfo> {
  return solid.completeLoginRedirect();
}
