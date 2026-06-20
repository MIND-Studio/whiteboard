"use client";

import { session } from "./session";

/**
 * CSS v7 WebSocketChannel2023 subscription — WAKE-UP ONLY (PRD §3.5).
 *
 * We do NOT route strokes or cursors through here; live editing flows through the
 * y-websocket relay + Yjs awareness. This subscription exists purely so a COLD or
 * OTHER-DEVICE client (the owner's second tab, a viewer not in the live relay)
 * learns the pod copy of `<id>.bin` changed and re-fetches the snapshot. CSS
 * notifications are change-signals ("this resource changed"), not deltas — every
 * signal forces a full re-GET — so using them for per-stroke sync is the
 * anti-pattern we avoid.
 *
 * Ported from chat/src/lib/solid/chat-subscription.ts: discover the
 * subscription endpoint → POST a JSON-LD subscription with the DPoP-bound fetch →
 * open the returned `receiveFrom` WebSocket → fire onChange on each frame, with a
 * 2-second polling fallback if the WS can't be established or drops.
 */

export type SubscriptionState = "connecting" | "connected" | "polling" | "error";

export type SubscriptionHandle = {
  disconnect: () => void;
};

const POLL_INTERVAL_MS = 2_000;

function authedFetch(): typeof fetch {
  return session().fetch as typeof fetch;
}

/**
 * Compute the WebSocketChannel2023 subscription endpoint for a topic URL by
 * reading the pod's storage description document. CSS v7 advertises the channel
 * type there; we follow that pointer rather than the
 * @inrupt/solid-client-notifications discovery walk, which expects an older
 * `solid:notificationGateway` predicate current CSS doesn't expose. Falls back
 * to the conventional `<origin>/.notifications/WebSocketChannel2023/`.
 */
async function discoverSubscriptionEndpoint(
  topicUrl: string,
  fetch: typeof globalThis.fetch,
): Promise<string> {
  const fallback = `${new URL(topicUrl).origin}/.notifications/WebSocketChannel2023/`;
  try {
    const head = await fetch(topicUrl, { method: "HEAD" });
    const link = head.headers.get("link") ?? "";
    const storageDescMatch = link.match(
      /<([^>]+)>\s*;\s*rel="http:\/\/www\.w3\.org\/ns\/solid\/terms#storageDescription"/,
    );
    if (!storageDescMatch?.[1]) return fallback;
    const descUrl = storageDescMatch[1];
    const descRes = await fetch(descUrl, {
      headers: { accept: "application/ld+json" },
    });
    if (!descRes.ok) return fallback;
    const desc = (await descRes.json()) as Array<Record<string, unknown>>;
    for (const node of desc) {
      const channelType = (node["http://www.w3.org/ns/solid/notifications#channelType"] ??
        []) as Array<{ "@id"?: string }>;
      if (
        channelType.some(
          (c) => c["@id"] === "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023",
        )
      ) {
        const id = node["@id"];
        if (typeof id === "string") return id;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Subscribe to a topic resource via WebSocketChannel2023. POSTs a JSON-LD
 * subscription request with the user's authenticated (DPoP-bound) fetch; the
 * response carries `receiveFrom` (a wss:// URL); we open that WebSocket and fire
 * `onMessage` on every notification frame.
 */
async function openSubscription(
  topicUrl: string,
  fetch: typeof globalThis.fetch,
  onMessage: () => void,
  onClose: () => void,
): Promise<{ close: () => void }> {
  const subscribeUrl = await discoverSubscriptionEndpoint(topicUrl, fetch);

  const subRes = await fetch(subscribeUrl, {
    method: "POST",
    headers: { "content-type": "application/ld+json" },
    body: JSON.stringify({
      "@context": ["https://www.w3.org/ns/solid/notification/v1"],
      type: "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023",
      topic: topicUrl,
    }),
  });
  if (!subRes.ok) {
    const body = await subRes.text();
    throw new Error(`subscription POST failed (${subRes.status}): ${body.slice(0, 200)}`);
  }
  const subBody = (await subRes.json()) as { receiveFrom?: string };
  if (!subBody.receiveFrom) {
    throw new Error("subscription response missing receiveFrom");
  }

  const ws = new WebSocket(subBody.receiveFrom);
  ws.addEventListener("message", () => onMessage());
  ws.addEventListener("close", () => onClose());
  ws.addEventListener("error", () => onClose());

  return {
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Subscribe to a board's snapshot resource (`<id>.bin`). On any change
 * notification, fire `onChange` — the caller re-GETs the snapshot, decrypts, and
 * merges it into the local Yjs doc (so an other-device write doesn't get lost).
 *
 * Falls back to 2-second polling if the WebSocket cannot be established or drops.
 * Polling is honest prior-art: every previous Solid app shipped it as the
 * fallback path.
 *
 * `topicUrl` is the full snapshot URL — `boardBinUrl(id)` for the owner, or the
 * share link's `pod=` param for a friend.
 */
export async function subscribeToBoard(
  topicUrl: string,
  onChange: () => void,
  onState?: (s: SubscriptionState) => void,
): Promise<SubscriptionHandle> {
  const fetch = authedFetch();
  onState?.("connecting");

  let subscription: { close: () => void } | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function startPolling() {
    if (pollTimer || disposed) return;
    onState?.("polling");
    pollTimer = setInterval(onChange, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  try {
    subscription = await openSubscription(
      topicUrl,
      fetch,
      () => onChange(),
      () => {
        if (!disposed) startPolling();
      },
    );
    onState?.("connected");
    // Refresh once after connect to catch a write that landed between the
    // initial GET and the subscription handshake completing.
    onChange();
  } catch {
    onState?.("error");
    startPolling();
  }

  return {
    disconnect() {
      disposed = true;
      subscription?.close();
      stopPolling();
    },
  };
}
