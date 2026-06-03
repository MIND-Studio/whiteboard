import { BoardsList } from "@/components/BoardsList";

/**
 * "My boards" route. Server component delegating to the client island
 * (RSC-safe: all @mind-studio/ui + session-hook usage lives in BoardsList).
 */
export default function BoardsPage() {
  return <BoardsList />;
}
