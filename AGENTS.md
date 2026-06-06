# AGENTS.md — whiteboard

Orientation rules for agents working in this prototype. **Read this before editing any file here.**

## Orientation

This is a privacy-first **collaborative whiteboard** built on Solid Pods: draw on an infinite canvas, share a link, live-collaborate. It is a **sibling** of `mind-drive-v0`, `mind-market-v0`, `mind-chat-v0`, `mind-codespaces-v0`, `mind-dock-v0`, and the rest of the `mind-prototypes/` family — independent app, own ports, own data, own docs. Do not unify with sibling prototypes.

The full plan, architecture, and decision log live in [`docs/PRD.md`](docs/PRD.md) — read it for the *why* behind the stack choices (Excalidraw over tldraw, Yjs, ephemeral relay, owner-client snapshots).

The grandparent workspace `CLAUDE.md` describes Mind Cube (a Raspberry Pi AI assistant). It is **not** relevant to anything here.

## NOT the Next.js you know

This prototype uses **Next.js 16.2.6** with **React 19.2.4** (Turbopack). APIs have shifted from training-cutoff knowledge. Before relying on what you "know" about `app/`, server components, Turbopack, `cookies()`, etc., read `node_modules/next/dist/docs/` for the actual current API.

## Hard-won constraints — read before editing

1. **`@mind-studio/core` is consumed from the REGISTRY (`^0.1.1`), not a `file:` tarball.** It was switched off the local tarball (`file:../mind-shared-ui/…tgz`) onto the published GitHub Packages dep so the prod Docker image can resolve it — a `file:` path outside the build context breaks `npm ci` in Docker (see `docs/DEPLOYMENT.md` §A3). This matches every deployed sibling (dock/drive/builder). Registry installs need a token (hard-rule 2). **To test an *unpublished* `mind-shared-ui` change locally, temporarily repoint the dep at the tarball and run `../mind-shared-ui/scripts/sync.sh` — but publish + bump `core` before building any image; never ship a `file:` dep.** (Historical: the tarball existed to dodge a Turbopack panic on `file:` *symlinks* outside the root; the registry dep avoids the symlink entirely.)

2. **Registry installs need a GitHub token.** `@mind-studio/ui` (and the `@mind-studio` scope generally) is hosted on GitHub Packages and requires auth. `NODE_AUTH_TOKEN` is not in the environment by default, but a `gh` token works:
   ```bash
   NODE_AUTH_TOKEN="$(gh auth token)" npm install
   ```
   Use the same prefix for any build/install that has to resolve `@mind-studio/*` fresh. `.npmrc` reads the token from `${NODE_AUTH_TOKEN}`.

3. **RSC gotcha: `@mind-studio/ui` `Badge`/`Card`/`cn` break in React Server Components.** Keep **all** `@mind-studio/ui` usage inside `"use client"` islands; server pages (`page.tsx`) delegate to a client component. The pattern is already established: `app/page.tsx` (RSC) → `components/LandingLogin.tsx` (`"use client"`), and `app/boards/page.tsx` → `components/BoardsPlaceholder.tsx`. Follow it. `MindLoginCard` ships its own `login-card.css` (imported by the component), so the card needs no extra Tailwind `@source`.

4. **`NEXT_PUBLIC_*` is inlined at build time.** The issuer (`NEXT_PUBLIC_SOLID_ISSUER`) and relay URL (`NEXT_PUBLIC_RELAY_URL`) are baked in when `next dev`/`next build` starts — **set them before starting the dev server and hard-reload tabs after changing them.** Changing `.env` mid-session without a restart does nothing.

5. **Ports — run one prototype at a time.** App `:3110`, local CSS `:3111`, relay `:3112`. The family's ports collide by design across prototypes; if you need another prototype running too, override with `npm run dev -- --port NNNN`. Within this prototype the three ports are distinct on purpose (relay deliberately on `:3112` so it never clashes with CSS on `:3111`).

6. **The relay is ephemeral — no persistence, no pod credentials.** `relay/` is a dumb `y-websocket` pipe: it forwards Yjs deltas + awareness (live cursors) between connected peers and holds **no durable state**. Kill it and the pod copy is untouched. **The pod is the source of truth.** The owner's *client* (never the relay) encodes the Yjs doc, encrypts it, and snapshots it to the pod. Do not give the relay pod credentials or make it write anything to disk — that breaks the privacy story (server-side snapshotting is explicitly deferred; see PRD §3.4).

7. **`src/lib/config.ts` is the single config source.** Every Solid URL, the relay URL, the app name, and the accent flow through it (`oidcIssuer`, `relayUrl`, `whiteboardNamespace`, `APP_NAME`, `ACCENT`). Do not read `process.env.NEXT_PUBLIC_*` directly elsewhere — add a derived value to `config.ts` and import it. Boards live under `<pod>/<whiteboardNamespace>/boards/`.

## Privacy invariants — hard rules

1. **The durable board never leaves the owner's pod in plaintext.** Snapshots are E2E-encrypted client-side before the `PUT`; the relay and the pod only ever see ciphertext. The AES key travels in the share link's URL **fragment** (`#k=`), which browsers never send to a server.
2. **The relay holds no durable state and no credentials.** It is a disposable coordination pipe, not a store.
3. **No central database of boards or board contents.** The pod container (`/<whiteboardNamespace>/boards/`) is the index; any local cache (`y-indexeddb`) is per-browser, not server-shared. If you find yourself adding a Postgres for "user boards," stop and ask.
4. **Live cursors/presence are ephemeral.** Yjs *awareness* is never persisted; on disconnect it auto-clears.

## Stack & layout

- `package.json` — Next.js 16.2.6 + React 19.2.4, `@excalidraw/excalidraw` (canvas), `yjs` + `y-protocols` (CRDT + awareness) + `y-websocket` (relay transport) + `y-indexeddb` (offline cache), `@inrupt/solid-client` ^3 + `@inrupt/solid-client-authn-browser` ^4 (+ `-authn-node` for scripts), `@mind-studio/core` (tarball) + `@mind-studio/ui`, `lucide-react`. devDeps: `ws` + `@types/ws` (relay), `tsx`, Tailwind v4.
- `next.config.ts` — `transpilePackages: ["@mind-studio/core", "@mind-studio/ui"]` (both ship untranspiled ESM the consumer must compile).
- **Design system:** built on `@mind-studio/ui` (shadcn-native) on the default **Mind brand**, tinted with the whiteboard accent (amber `#d97706`). `layout.tsx` wraps the app in `<ThemeProvider theme={mind} defaultTheme="dark" storageKey="mind-whiteboard-theme">` and sets `data-mind-theme="mind"` on `<html>`. `globals.css` imports `@mind-studio/ui/dist/styles.css` + `@source`s the dist; use semantic Tailwind tokens (`bg-background`, `text-muted-foreground`, `bg-primary`, …), not a bespoke palette.
- `src/lib/config.ts` — single config source (see hard rule 7).
- `src/lib/solid/` — pod I/O wrappers (`session.ts` today; `auth.ts`, `pod-fs.ts`, `access.ts`, `notifications.ts` as the Solid layer fills in). OIDC, snapshot read/write, Universal Access ACLs, CSS `WebSocketChannel2023` wake-up subscription.
- `src/lib/whiteboard/` — the CRDT layer (`yjs-doc.ts`, `excalidraw-bridge.ts`, `snapshot.ts`, `crypto.ts`, `share-link.ts`).
- `src/app/` — App Router: `/` (landing + `MindLoginCard`), `/login/callback`, `/boards` (list), `/board/[id]` (canvas).
- `relay/` — the ephemeral `y-websocket` server (`npm run relay`, port `:3112`).
- `scripts/seed-demo.ts` — idempotent demo personas (alice/bob).

## Commands

```bash
NODE_AUTH_TOKEN="$(gh auth token)" npm install   # registry auth (see hard rule 2)
npm run dev        # Next.js on :3110
npm run relay      # ephemeral y-websocket relay on :3112
npm run build      # production build (NEXT_PUBLIC_* inlined — set env first)
npm run seed:demo  # populate pods with demo personas (idempotent)
```

For live collaboration locally you need **both** `npm run dev` and `npm run relay` running.

## Never commit

- `.css-data/` — pod contents written by CSS
- `.next/` — Next.js cache (wipe with `rm -rf .next` if Turbopack serves stale CSS)
- `.indexer-data/`, `.cache/` — local caches
- `node_modules/`

## Ask before doing

- Giving the relay pod credentials or making it persist anything. The relay is a dumb pipe; the pod is the only store (server-side snapshotting is deferred — PRD §3.4).
- Introducing a server-side persistence layer (DB, Redis, S3) for boards. The pod is the source of truth.
- Routing strokes/cursors through CSS notifications. CSS notifications are wake-up *change-signals*, not a delta/message queue — that's the explicit anti-pattern (PRD §3.5).
- Swapping in tldraw or any paid/source-available SDK (licensing — PRD §3.1, §11).
- Touching sibling prototypes — they have their own `AGENTS.md`.
