"use client";

import { FeedbackWidget } from "@mind-studio/core/feedback";
import { feedbackInbox } from "@/lib/config";
import { useSession } from "@/lib/solid/session";

/**
 * Mounts the floating 💬 feedback widget on every Whiteboard page. Bridges the
 * app's pod session to the storage-agnostic widget: `webId` and the DPoP-bound
 * `fetch` come from `useSession()`. Both are optional — until the session
 * resolves (or for signed-out users, incl. friends opening a share link) the
 * widget submits anonymously, which the public-append inbox accepts.
 *
 * RSC note (AGENTS hard rule 3): this is a "use client" island, so the
 * `@mind-studio/ui` components inside the widget never render on the server.
 */
export function FeedbackLauncher() {
  const { webid, fetch } = useSession();
  return (
    <FeedbackWidget
      appKey="whiteboard"
      inbox={feedbackInbox}
      fetch={fetch ?? undefined}
      webId={webid}
      variant="floating"
    />
  );
}
