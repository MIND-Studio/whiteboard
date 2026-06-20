"use client";

import { createSolidClient } from "@mind-studio/core/solid";
import { APP_NAME, oidcIssuer } from "@/lib/config";

/**
 * The Solid issuer used when the user hasn't picked one. Read from the app's
 * config here (core stays framework-agnostic) and handed to the shared client.
 */
export const DEFAULT_ISSUER = oidcIssuer;

/**
 * The one shared Solid foundation for Mind Whiteboard — session, the issuer +
 * return-to memory, the single-flight OIDC redirect handler, and a pod fs.
 * Whiteboard runs standalone (no shell broker), but core wires a broker
 * internally and `ensureSession()` falls through to the normal OIDC path when
 * not embedded — which is exactly what we want.
 *
 * `auth.ts` and the session shims forward to this instance. The storage keys
 * core derives from `appName` (`mind-whiteboard:oidc-issuer` /
 * `mind-whiteboard:return-to`) match the keys the old hand-rolled code used, so
 * already-signed-in users keep their remembered issuer + session.
 */
export const solid = createSolidClient({
  appName: "whiteboard",
  clientName: APP_NAME,
  defaultReturnPath: "/boards",
  defaultIssuer: DEFAULT_ISSUER,
});
