import { LandingLogin } from "@/components/LandingLogin";

/**
 * Server component. All @mind-studio/* + Inrupt usage lives in the client
 * <LandingLogin> (Badge/Card/cn from @mind-studio/ui break in RSC, and the
 * login card needs browser APIs), so this page just delegates.
 */
export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 pb-16">
      <header className="flex items-center gap-2.5 py-7">
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
        >
          W
        </span>
        <span className="text-lg font-semibold tracking-tight">Mind Whiteboard</span>
      </header>

      <section className="grid flex-1 items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Privacy-first collaborative whiteboard
          </p>
          <h1 className="mt-4 text-[2.9rem] font-semibold leading-[1.02] tracking-tight sm:text-6xl">
            Draw together.
            <br />
            <span className="text-primary">Your board, in your pod.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground sm:text-lg">
            Freehand-draw on an infinite canvas, share a link, and collaborate live with cursors and
            presence. The durable board lives in your Solid Pod — the live relay never persists a
            thing.
          </p>

          <div className="mt-8 max-w-md">
            <LandingLogin />
          </div>
        </div>
      </section>
    </main>
  );
}
