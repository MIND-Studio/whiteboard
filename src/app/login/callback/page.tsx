"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { completeLoginRedirect } from "@/lib/solid/auth";
import { consumeReturnTo } from "@/lib/solid/auth";

/**
 * OIDC redirect landing. Consumes the authorization code via the single-flight
 * `completeLoginRedirect` (lib/solid/auth.ts) — shared with the session hook so
 * the code is redeemed exactly once even if a layout-mounted component checks the
 * session concurrently. Then SPA-navigates (router.replace, NOT window.location)
 * so the in-memory @inrupt session survives the hop; a hard navigation would wipe
 * it and the destination would render signed-out. Honors a remembered deep link
 * (e.g. a friend who opened a board link before signing in), defaulting to
 * /boards.
 */
export default function CallbackPage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await completeLoginRedirect();
      } catch (err) {
        console.error("OIDC callback failed", err);
      }
      if (!cancelled) {
        router.replace(consumeReturnTo());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="mx-auto max-w-md px-6 py-20 text-center text-muted-foreground">
      Finishing sign-in…
    </main>
  );
}
