"use client";

import { Badge, Button } from "@mind-studio/ui";
import { ArrowLeft, Cloud, CloudOff, Share2, Wifi, WifiOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CollaboratorsBar } from "@/components/CollaboratorsBar";
import { ShareDialog } from "@/components/ShareDialog";
import type { SnapshotStatus } from "@/lib/whiteboard/snapshot";
import type { ConnectionStatus, WhiteboardDoc } from "@/lib/whiteboard/yjs-doc";

/**
 * The board chrome (the bar above the canvas). Carries:
 *   • back link to the boards list + the board title,
 *   • a live/offline relay badge (board.onStatus → ConnectionStatus),
 *   • a "Saved to your pod" affordance (createSnapshotWriter onStatus) — owner only,
 *   • the collaborators avatars (presence),
 *   • the Share button → ShareDialog (owned by solid-eng; we just mount + control it).
 *
 * All @mind-studio/ui usage is here in a client island (RSC gotcha). The Share
 * tier defaults to Public link inside ShareDialog (PRD §12 Q2).
 */

export function Toolbar({
  board,
  boardId,
  title,
  connection,
  saveStatus,
  isOwner,
  snapshotUrl,
  exportedKey,
  origin,
}: {
  board: WhiteboardDoc;
  boardId: string;
  title: string;
  connection: ConnectionStatus;
  /** undefined for a non-owner (read/collab friend doesn't snapshot). */
  saveStatus?: SnapshotStatus;
  isOwner: boolean;
  /** Owner's `.bin` URL; threaded to ShareDialog for the capability link. */
  snapshotUrl: string;
  /** base64url AES key (from exportKey) for the share link's #k= fragment. */
  exportedKey: string;
  /** window.location.origin — where the share link points back. */
  origin: string;
}) {
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <header className="flex items-center gap-3 border-b bg-card px-4 py-2.5">
      <Button asChild variant="ghost" size="icon-sm" aria-label="Back to boards">
        <Link href="/boards">
          <ArrowLeft className="size-4" />
        </Link>
      </Button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold tracking-tight" data-testid="board-title">
          {title}
        </p>
      </div>

      <ConnectionBadge status={connection} />
      {isOwner ? <SaveBadge status={saveStatus} /> : null}

      <CollaboratorsBar board={board} />

      {isOwner ? (
        <>
          <Button size="sm" onClick={() => setShareOpen(true)} data-testid="share-button">
            <Share2 className="size-4" /> Share
          </Button>
          <ShareDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            boardId={boardId}
            snapshotUrl={snapshotUrl}
            exportedKey={exportedKey}
            origin={origin}
          />
        </>
      ) : null}
    </header>
  );
}

/** Live / offline relay status. */
function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  if (status === "connected") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="connection-badge">
        <Wifi className="size-3" /> Live
      </Badge>
    );
  }
  if (status === "connecting") {
    return (
      <Badge variant="outline" className="gap-1" data-testid="connection-badge">
        <Wifi className="size-3 animate-pulse" /> Connecting…
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid="connection-badge">
      <WifiOff className="size-3" /> Offline
    </Badge>
  );
}

/** "Saved to your pod" affordance, driven by the snapshot writer status. */
function SaveBadge({ status }: { status?: SnapshotStatus }) {
  switch (status) {
    case "saving":
      return (
        <Badge variant="outline" className="gap-1" data-testid="save-badge">
          <Cloud className="size-3 animate-pulse" /> Saving…
        </Badge>
      );
    case "saved":
      return (
        <Badge variant="secondary" className="gap-1" data-testid="save-badge">
          <Cloud className="size-3" /> Saved to your pod
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className="gap-1" data-testid="save-badge">
          <CloudOff className="size-3" /> Save failed
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid="save-badge">
          <Cloud className="size-3" /> Unsaved changes
        </Badge>
      );
    default:
      return null;
  }
}
