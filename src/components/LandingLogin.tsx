"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { MindLoginCard, writeLastIdentity } from "@mind-studio/core";
import { useSession } from "@/lib/solid/session";
import { oidcIssuer, APP_NAME } from "@/lib/config";

/**
 * Client-side sign-in surface for the landing page. Renders the shared
 * MindLoginCard on the Mind brand, and once a session exists routes on to the
 * boards list. Kept as a "use client" island so the page.tsx RSC stays clean.
 */
export function LandingLogin() {
  const { webid, loggedIn, loading, signIn } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && loggedIn && webid) {
      writeLastIdentity(APP_NAME, {
        webId: webid,
        displayName: webid.split("/").filter(Boolean).pop(),
      });
      router.replace("/boards");
    }
  }, [loading, loggedIn, webid, router]);

  return (
    <>
      <MindLoginCard
        appName={APP_NAME}
        defaultIssuer={oidcIssuer}
        onLogin={async ({ issuer }) => {
          await signIn(issuer);
        }}
      />
      <p className="mt-3 text-center text-xs text-muted-foreground">
        {loading
          ? "Getting things ready…"
          : webid
            ? "You’re signed in — opening your boards…"
            : "Sign in safely with your own pod. No new password to remember."}
      </p>
    </>
  );
}
