"use client";

import { MindLoginCard, writeLastIdentity } from "@mind-studio/core";
import { Button, Spinner } from "@mind-studio/ui";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Toolbar } from "@/components/Toolbar";
import { APP_NAME, oidcIssuer } from "@/lib/config";
import { rememberSignedOutPath } from "@/lib/solid/auth";
import type { SubscriptionHandle } from "@/lib/solid/notifications";
import { ensureBoardsContainer, readFileBlob } from "@/lib/solid/pod-fs";
import { boardBinUrl, boardMetaUrl, useSession } from "@/lib/solid/session";
import { exportKey, generateKey, importKey, type SnapshotKey } from "@/lib/whiteboard/crypto";
import { seedDocFromUpdate } from "@/lib/whiteboard/excalidraw-bridge";
import { colorForClient, nameFromWebId, type PresenceUser } from "@/lib/whiteboard/presence";
import { keyFromLocationHash } from "@/lib/whiteboard/share-link";
import {
  createSnapshotWriter,
  fetchDecryptedSnapshot,
  type SnapshotStatus,
  type SnapshotWriter,
} from "@/lib/whiteboard/snapshot";
import { startBoardWakeup } from "@/lib/whiteboard/wake-up";
import {
  type ConnectionStatus,
  createWhiteboardDoc,
  type WhiteboardDoc,
} from "@/lib/whiteboard/yjs-doc";

// Canvas is dynamically imported with ssr:false because Excalidraw is browser-
// only (touches window at module load) and has no SSR path. Even though BoardView
// is "use client", Next still SSRs client components, so loading Canvas (which
// imports "@excalidraw/excalidraw/index.css" and lazy-loads the <Excalidraw>
// component) behind one ssr:false boundary keeps the whole Excalidraw subtree out
// of the server render. (The bridge no longer drags Excalidraw's runtime in — it
// uses type-only imports — but the component itself still must not SSR.)
const Canvas = dynamic(() => import("@/components/Canvas").then((m) => m.Canvas), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-sm text-muted-foreground">
      Loading canvas…
    </div>
  ),
});

/**
 * Live board view (W1 draw + W3 collaborate). The server page passes the route
 * `id`; everything else — owner vs friend, the E2E key, pod URLs — is resolved
 * here on the client.
 *
 * Two entry modes (PRD §4):
 *   • OWNER  — signed in, no `#k=`/`pod=` in the URL. We derive the snapshot URL
 *     from the user's pod (boardBinUrl), generate a key for a NEW board (or, for
 *     an existing board they own, the key isn't recoverable from the pod — see
 *     note below), seed from the pod snapshot if present, and run the debounced
 *     snapshot writer.
 *   • FRIEND — opened a capability link with `?pod=<bin>#k=<key>`. We import the
 *     key from the fragment, GET+decrypt the snapshot at `pod=`, seed the doc,
 *     and join the live room. A friend never writes the owner's pod (no snapshot
 *     writer) unless they have write access — v1 keeps friends read/collab-live
 *     and lets the owner be the durable writer (PRD §3.4).
 *
 * Key handling note (v1 scope, PRD §6): the AES key lives only in the share-link
 * fragment, never in the pod. For an OWNER reopening their OWN existing board in a
 * fresh session (no fragment), we cannot recover the original key. Rather than
 * silently generate a fresh key and let the snapshot writer clobber the existing
 * `.bin` (data loss for the old board + any outstanding share link), we probe
 * whether the `.bin` already exists: if it does, we refuse and show a "needs-key"
 * screen pointing the owner at their share link; if it doesn't, this id is brand
 * new and we mint a key. (Key escrow in the owner's pod is the real fix and is
 * deferred per PRD §6.)
 */

type Phase =
  | { kind: "booting" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "needs-key" }
  | {
      kind: "ready";
      board: WhiteboardDoc;
      user: PresenceUser;
      isOwner: boolean;
      readOnly: boolean;
      title: string;
      snapshotUrl: string;
      exportedKey: string;
      origin: string;
    };

export function BoardView({ id }: { id: string }) {
  const { webid, loggedIn, loading, signIn } = useSession();
  const searchParams = useSearchParams();
  const podParam = searchParams.get("pod");

  const [phase, setPhase] = useState<Phase>({ kind: "booting" });
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [saveStatus, setSaveStatus] = useState<SnapshotStatus | undefined>();

  // Hold the live resources so cleanup can tear them down exactly once.
  const boardRef = useRef<WhiteboardDoc | null>(null);
  const writerRef = useRef<SnapshotWriter | null>(null);
  const subRef = useRef<SubscriptionHandle | null>(null);

  // The `#k=` fragment is only readable on the client and never sent to a server.
  const fragmentKey = useMemo(
    () => (typeof window === "undefined" ? null : keyFromLocationHash(window.location.hash)),
    [],
  );
  const isFriend = Boolean(podParam && fragmentKey);

  useEffect(() => {
    // Wait for the session probe to settle.
    if (loading) return;

    // A friend with a capability link can open without signing in (public tier).
    // An owner (no link) must be signed in.
    if (!isFriend && !loggedIn) {
      rememberSignedOutPath();
      setPhase({ kind: "signed-out" });
      return;
    }

    let cancelled = false;
    let localBoard: WhiteboardDoc | null = null;
    let localWriter: SnapshotWriter | null = null;
    let localSub: SubscriptionHandle | null = null;

    (async () => {
      try {
        // Resolve the snapshot URL + key + role.
        let snapshotUrl: string;
        let key: SnapshotKey;
        let isOwner: boolean;
        let readOnly: boolean;

        if (isFriend) {
          snapshotUrl = podParam!;
          key = await importKey(fragmentKey!);
          isOwner = false;
          // A signed-in friend with write access could edit; v1 treats the
          // public-link friend as a live collaborator but never the durable
          // writer. They can still draw locally + over the relay; only the
          // owner persists. Read-only (view) is reserved for a future tier.
          readOnly = false;
        } else {
          // Owner. Ensure the boards container exists, then derive URLs.
          // ensureBoardsContainer is idempotent (checks-then-creates; tolerant
          // of CSS v7's 409-on-existing-container), so this is safe on every open.
          await ensureBoardsContainer();
          snapshotUrl = boardBinUrl(id);
          isOwner = true;
          readOnly = false;

          // The key lives ONLY in the share-link fragment (PRD §6). Opening an
          // owned board from the boards list carries no fragment, so we have no
          // key. We must NOT generate a fresh one for a board that already has a
          // `.bin` — the snapshot writer would re-encrypt under the new key and
          // clobber the old board + any outstanding share link (data loss). So:
          //   • `.bin` already exists, no key  → refuse: tell the owner to open
          //     it from its share link (which holds the key). [option A]
          //   • no `.bin` yet (brand-new id)   → this is a create: mint a key.
          if (await snapshotExists(snapshotUrl)) {
            if (!cancelled) setPhase({ kind: "needs-key" });
            return;
          }
          key = await generateKey();
        }

        const exportedKey = await exportKey(key);

        // Build the Yjs doc (connects to the relay eagerly).
        const board = createWhiteboardDoc(id);
        localBoard = board;
        boardRef.current = board;

        // Relay status → Toolbar badge.
        const unsubStatus = board.onStatus(setConnection);
        void unsubStatus; // unsubscribed via board.destroy in cleanup

        // Seed from an existing snapshot. For a friend this is required (their
        // canvas must show the durable board). For an owner we only reach here
        // for a brand-new board (existing-board-without-key was handled above),
        // so the GET is expected to 404 — that's fine, start blank. We always
        // wait for IndexedDB first so a cold reload paints the local cache
        // instantly before the pod/relay round-trips.
        try {
          await board.whenIdbSynced; // local cache first (instant cold load)
          const update = await fetchDecryptedSnapshot(snapshotUrl, key);
          if (!cancelled) seedDocFromUpdate(board, update);
        } catch (err) {
          // 404 / not-found is expected for a new owner board. A friend hitting
          // this means the link is stale or access was revoked — surface it but
          // still let them into an (empty) live room.
          if (isFriend) {
            console.warn("Could not load shared snapshot:", err);
          }
        }

        // Owner persists; friend does not (PRD §3.4).
        if (isOwner) {
          const writer = createSnapshotWriter(board, {
            snapshotUrl,
            metaUrl: boardMetaUrl(id),
            key,
            meta: { title: defaultTitle(id), created: new Date().toISOString() },
            onStatus: setSaveStatus,
          });
          localWriter = writer;
          writerRef.current = writer;
        }

        // M4 wake-up (PRD §3.5): subscribe to the pod `.bin` via CSS
        // WebSocketChannel2023 so a COLD / OTHER-DEVICE client (the owner's second
        // tab, a viewer not in the live relay room) learns the durable copy
        // changed and re-seeds. The live relay stays the hot path — strokes and
        // cursors NEVER flow through here. solid-eng's startBoardWakeup owns the
        // subscribe → GET+decrypt → Y.applyUpdate(idempotent merge) chain and the
        // 2s polling fallback; we just mount it and disconnect on unmount.
        // Best-effort: it resolves to a no-op handle if the subscription can't be
        // established, so this never blocks opening the board.
        void startBoardWakeup({ board, snapshotUrl, key }).then((handle) => {
          if (cancelled) {
            handle.disconnect();
            return;
          }
          localSub = handle;
          subRef.current = handle;
        });

        if (cancelled) return;

        const user: PresenceUser = {
          name: nameFromWebId(webid),
          color: colorForClient(board.awareness.clientID),
        };

        setPhase({
          kind: "ready",
          board,
          user,
          isOwner,
          readOnly,
          title: defaultTitle(id),
          snapshotUrl,
          exportedKey,
          origin: typeof window !== "undefined" ? window.location.origin : "",
        });
      } catch (err) {
        if (!cancelled) {
          setPhase({ kind: "error", message: String(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
      // Flush the last edits before tearing down (best-effort), then destroy.
      localWriter?.flush().catch(() => {});
      localWriter?.destroy();
      localSub?.disconnect();
      localBoard?.destroy();
      writerRef.current = null;
      subRef.current = null;
      boardRef.current = null;
    };
    // Re-run if identity or role inputs change. `id` is stable per route.
  }, [id, loading, loggedIn, isFriend, podParam, fragmentKey, webid]);

  // Persist the last-identity hint so a returning user sees "Continue as …".
  useEffect(() => {
    if (webid) {
      writeLastIdentity(APP_NAME, {
        webId: webid,
        displayName: nameFromWebId(webid),
      });
    }
  }, [webid]);

  if (phase.kind === "booting") {
    return (
      <Centered>
        <Spinner className="size-5" />
        <p className="text-sm text-muted-foreground">Opening board…</p>
      </Centered>
    );
  }

  if (phase.kind === "signed-out") {
    return (
      <Centered>
        <div className="w-full max-w-sm">
          <p className="mb-4 text-center text-sm text-muted-foreground">
            Sign in with your pod to open this board.
          </p>
          <MindLoginCard
            appName={APP_NAME}
            defaultIssuer={oidcIssuer}
            onLogin={async ({ issuer }) => {
              await signIn(issuer);
            }}
          />
        </div>
      </Centered>
    );
  }

  if (phase.kind === "needs-key") {
    return (
      <Centered>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          This board needs its link
        </p>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          This board is encrypted, and its key lives in the share link — not in your pod. Open it
          from the link you created when you shared it (the part after{" "}
          <code className="font-mono">#k=</code> is the key). Creating a new board instead won’t
          touch this one.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/boards">Back to boards</Link>
        </Button>
      </Centered>
    );
  }

  if (phase.kind === "error") {
    return (
      <Centered>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-destructive">
          Could not open board
        </p>
        <p className="max-w-md break-all text-center font-mono text-sm">{phase.message}</p>
        <Button variant="outline" size="sm" onClick={() => location.reload()}>
          Retry
        </Button>
      </Centered>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        board={phase.board}
        boardId={id}
        title={phase.title}
        connection={connection}
        saveStatus={saveStatus}
        isOwner={phase.isOwner}
        snapshotUrl={phase.snapshotUrl}
        exportedKey={phase.exportedKey}
        origin={phase.origin}
      />
      <div className="relative min-h-0 flex-1">
        <Canvas board={phase.board} user={phase.user} readOnly={phase.readOnly} />
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-6">
      {children}
    </main>
  );
}

/** A friendly default title until the user renames (rename is out of v1 scope). */
function defaultTitle(id: string): string {
  return `Board ${id.slice(0, 8)}`;
}

/**
 * Does the owner's `.bin` already exist? A successful GET means the board is real
 * (and its key lives in a share link, not the pod). A 404 / fetch error means
 * this id is brand-new and safe to create. We GET rather than HEAD because
 * pod-fs exposes `readFileBlob`; the body is small and only fetched once.
 */
async function snapshotExists(snapshotUrl: string): Promise<boolean> {
  try {
    await readFileBlob(snapshotUrl);
    return true;
  } catch {
    return false;
  }
}
