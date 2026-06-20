"use client";

import { Button } from "@mind-studio/ui";
import { Clock, LogOut, PencilRuler, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { rememberSignedOutPath } from "@/lib/solid/auth";
import { type BoardSummary, ensureBoardsContainer, listBoards } from "@/lib/solid/pod-fs";
import { useSession } from "@/lib/solid/session";

/**
 * "My boards" — the real pod-backed list (PRD §6). Reads the signed-in user's
 * `<ns>/boards/` container via the solid layer (listBoards → readdir + each
 * `.meta.ttl`), renders a card per board, and offers "New board" (mint an id,
 * ensure the container exists, route to /board/<id> where ui-eng's canvas
 * scaffolds the `.bin` on first draw).
 *
 * RSC-safe: this is the "use client" island; boards/page.tsx (a server
 * component) just renders it. All @mind-studio/ui usage stays in here.
 */
export function BoardsList() {
  const { webid, loggedIn, loading, signOut } = useSession();
  const router = useRouter();

  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Signed-out → remember where we were and bounce to the login surface.
  useEffect(() => {
    if (!loading && !loggedIn) {
      rememberSignedOutPath();
      router.replace("/");
    }
  }, [loading, loggedIn, router]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setBoards(await listBoards());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t load your boards.");
      setBoards([]);
    }
  }, []);

  useEffect(() => {
    if (!loading && loggedIn && webid) void refresh();
  }, [loading, loggedIn, webid, refresh]);

  async function newBoard() {
    setCreating(true);
    setError(null);
    try {
      // Ensure the container exists so the board view's first snapshot PUT
      // doesn't 404 on a missing parent.
      await ensureBoardsContainer();
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      router.push(`/board/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t create a board.");
      setCreating(false);
    }
  }

  if (loading || (!loggedIn && boards === null)) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Your boards</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every board lives in your pod. Only you can see it until you share a link.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={newBoard} disabled={creating}>
            <Plus className="size-4" />
            {creating ? "Creating…" : "New board"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => signOut()} aria-label="Sign out">
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </header>

      {error ? (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {boards === null ? (
        <p className="mt-10 text-sm text-muted-foreground">Loading your boards…</p>
      ) : boards.length === 0 ? (
        <EmptyState onCreate={newBoard} creating={creating} />
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((b) => (
            <li key={b.id}>
              <BoardCard board={b} onOpen={() => router.push(`/board/${b.id}`)} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function BoardCard({ board, onOpen }: { board: BoardSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
        <PencilRuler className="size-5" />
      </span>
      <span className="line-clamp-2 font-medium">{board.title}</span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" />
        {board.modified ? relativeTime(board.modified) : "Not edited yet"}
      </span>
    </button>
  );
}

function EmptyState({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <PencilRuler className="size-6" />
      </span>
      <h2 className="mt-4 text-lg font-medium">No boards yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Create your first board — it saves straight to your pod, and you can share a live link
        whenever you’re ready.
      </p>
      <Button className="mt-6" onClick={onCreate} disabled={creating}>
        <Plus className="size-4" />
        {creating ? "Creating…" : "New board"}
      </Button>
    </div>
  );
}

/** Compact relative-time label (no i18n dep; good enough for the prototype). */
function relativeTime(d: Date): string {
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString();
}
