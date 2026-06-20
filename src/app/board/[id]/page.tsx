import { Suspense } from "react";
import { BoardView } from "@/components/BoardView";

/**
 * Board route (W1/W3). Server component: it only unwraps the route param and
 * delegates to the client <BoardView> — all @mind-studio/* + Excalidraw + Yjs +
 * Inrupt usage is client-only (RSC gotcha + browser APIs). In Next 16 `params`
 * is a Promise, so we await it.
 *
 * BoardView reads `?pod=` and the `#k=` fragment on the client to tell owner from
 * friend; the fragment never reaches this server component (browsers don't send
 * URL fragments), which is exactly the privacy property we want.
 *
 * Wrapped in <Suspense> because BoardView uses `useSearchParams()`, which Next
 * requires to be inside a Suspense boundary.
 */
export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <BoardView id={id} />
    </Suspense>
  );
}
