"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mind-studio/ui";
import { Check, Copy, Globe, UserPlus } from "lucide-react";
import { useState } from "react";
import { setBoardAgentAccess, setBoardPublicAccess } from "@/lib/solid/access";
import { composeShareLink } from "@/lib/whiteboard/share-link";

/**
 * Share dialog (W2). Pure presentational: it takes the board id, the snapshot
 * URL, and the ALREADY-EXPORTED base64url key (so no crypto dependency leaks in
 * here — the board view exports the CryptoKey once and passes the string down).
 * It owns only the two access-tier flows and clipboard copy.
 *
 * Drop-in for ui-eng's Toolbar Share button: render it controlled with
 * `open`/`onOpenChange`; everything else is props.
 *
 *   <ShareDialog
 *     open={shareOpen} onOpenChange={setShareOpen}
 *     boardId={id}
 *     snapshotUrl={boardBinUrl(id)}
 *     exportedKey={exportedKey}
 *   />
 */
export type ShareDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boardId: string;
  /** Absolute URL of the `.bin` snapshot (boardBinUrl(boardId)). */
  snapshotUrl: string;
  /** base64url AES key from `exportKey(boardKey)` — goes in the link `#k=`. */
  exportedKey: string;
  /** App origin for the link; defaults to window.location.origin. */
  origin?: string;
};

type Tier = "public" | "webid";

export function ShareDialog({
  open,
  onOpenChange,
  boardId,
  snapshotUrl,
  exportedKey,
  origin,
}: ShareDialogProps) {
  const [tier, setTier] = useState<Tier>("public");
  const [friendWebId, setFriendWebId] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function appOrigin(): string {
    return origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  }

  function buildLink(): string {
    return composeShareLink(appOrigin(), {
      boardId,
      snapshotUrl,
      key: exportedKey,
    });
  }

  async function sharePublic() {
    setBusy(true);
    setError(null);
    try {
      await setBoardPublicAccess(boardId, true);
      const url = buildLink();
      setLink(url);
      await copy(url);
    } catch (e) {
      setError(grantError(e));
    } finally {
      setBusy(false);
    }
  }

  async function shareWithWebId() {
    setBusy(true);
    setError(null);
    try {
      await setBoardAgentAccess(boardId, friendWebId.trim(), {
        read: true,
        write: true,
      });
      const url = buildLink();
      setLink(url);
      await copy(url);
    } catch (e) {
      setError(grantError(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) — the field is selectable.
      setCopied(false);
    }
  }

  // Reset transient state when the tier changes so a stale link/err doesn't
  // carry across tiers.
  function switchTier(next: string) {
    setTier(next as Tier);
    setLink(null);
    setError(null);
    setCopied(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this board</DialogTitle>
          <DialogDescription>
            The link carries an encryption key in its fragment — anyone you send it to can open and
            decrypt the board. The relay and the pod only ever see ciphertext.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tier} onValueChange={switchTier} className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="public">
              <Globe className="size-4" />
              Public link
            </TabsTrigger>
            <TabsTrigger value="webid">
              <UserPlus className="size-4" />
              Invite a WebID
            </TabsTrigger>
          </TabsList>

          <TabsContent value="public" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Anyone with the link can view and decrypt — no sign-in needed.
            </p>
            <Button onClick={sharePublic} disabled={busy} className="w-full">
              {busy ? "Setting access…" : "Create public link"}
            </Button>
          </TabsContent>

          <TabsContent value="webid" className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="friend-webid">Friend’s WebID</Label>
              <Input
                id="friend-webid"
                placeholder="https://their-pod.example/profile/card#me"
                value={friendWebId}
                onChange={(e) => setFriendWebId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Only this person’s pod can read and edit the board. They sign in with their own pod
                (silent SSO if already in a Mind app).
              </p>
            </div>
            <Button
              onClick={shareWithWebId}
              disabled={busy || friendWebId.trim().length === 0}
              className="w-full"
            >
              {busy ? "Granting access…" : "Grant access & copy link"}
            </Button>
          </TabsContent>
        </Tabs>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {link ? (
          <div className="space-y-1.5">
            <Label htmlFor="share-link">Share link</Label>
            <div className="flex items-center gap-2">
              <Input
                id="share-link"
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button variant="outline" size="sm" onClick={() => copy(link)} aria-label="Copy link">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            {copied ? <p className="text-xs text-emerald-600">Copied to clipboard.</p> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function grantError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/WebID/i.test(msg)) return msg;
  return `Couldn’t set sharing access: ${msg}`;
}
