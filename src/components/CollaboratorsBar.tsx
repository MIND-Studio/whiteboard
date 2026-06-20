"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@mind-studio/ui";
import { useEffect, useState } from "react";
import { asPresenceState, initialsFor, type PresenceState } from "@/lib/whiteboard/presence";
import type { WhiteboardDoc } from "@/lib/whiteboard/yjs-doc";

/**
 * Who's here right now (W3 presence). Renders an avatar per peer present in
 * awareness — including ourselves, marked "(you)" — using the same name+color
 * each peer publishes for its cursor, so the bar and the cursors agree.
 *
 * Awareness is ephemeral: when a peer disconnects, the relay drops their state
 * and they vanish from this bar automatically (no explicit "leave" needed).
 */

type Peer = {
  clientId: number;
  state: PresenceState;
  isSelf: boolean;
};

export function CollaboratorsBar({ board }: { board: WhiteboardDoc }) {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const { awareness } = board;
    const localId = awareness.clientID;

    function refresh() {
      const next: Peer[] = [];
      for (const [clientId, raw] of awareness.getStates()) {
        const state = asPresenceState(raw);
        if (!state) continue;
        next.push({ clientId, state, isSelf: clientId === localId });
      }
      // Self first, then by name for a stable order.
      next.sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        return a.state.user.name.localeCompare(b.state.user.name);
      });
      setPeers(next);
    }

    awareness.on("change", refresh);
    refresh();
    return () => {
      awareness.off("change", refresh);
    };
  }, [board]);

  if (peers.length === 0) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <AvatarGroup data-testid="collaborators">
        {peers.map(({ clientId, state, isSelf }) => (
          <Tooltip key={clientId}>
            <TooltipTrigger asChild>
              <Avatar
                className="size-7 ring-2"
                style={{ ["--tw-ring-color" as string]: state.user.color }}
                data-testid={`collaborator-${state.user.name}`}
              >
                <AvatarFallback
                  className="text-[10px] font-semibold text-white"
                  style={{ background: state.user.color }}
                >
                  {initialsFor(state.user.name)}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>
              {state.user.name}
              {isSelf ? " (you)" : ""}
            </TooltipContent>
          </Tooltip>
        ))}
      </AvatarGroup>
    </TooltipProvider>
  );
}
