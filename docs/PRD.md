# PRD — `whiteboard`

**A privacy-first collaborative whiteboard. Draw in the browser, share a link, live-collaborate — your board lives in your pod.**

- **Status:** Draft v1 (PRD only — no code yet)
- **Author:** synthesized from 4 research streams (internal prototype patterns, `@mind-studio/ui` + `@mind-studio/core` API surface, web research on whiteboard/CRDT tech, web research on Solid + real-time collaboration)
- **Date:** 2026-06-02
- **Sibling of:** the `mind-prototypes/` family (Next.js 16 / React 19 / Solid Pods)
- **Ports:** app `:3110`, local CSS `:3111` (311x band — 300x–310x are all taken; 310x is `shell`)

---

## 1. The three wishes (what we are shipping)

This prototype exists to grant exactly three user wishes. Everything in scope serves one of them; everything that does not is out of scope.

| # | Wish | One-line definition of done |
|---|------|------------------------------|
| **W1** | **Draw** | I open the app, sign in with my pod, and freehand-draw + place shapes/text/arrows on an infinite canvas. My board auto-saves to my pod. |
| **W2** | **Share** | I click "Share", get a link, and send it to a friend. The link carries everything the friend needs to open the board. |
| **W3** | **Live collaborate** | My friend opens the link and we both draw on the same board at the same time, seeing each other's strokes and live cursors with no perceptible lag. |

If a build decision does not make one of W1/W2/W3 demonstrably better, it is deferred.

---

## 2. Why this fits the Mind thesis

The `mind-prototypes` family explores *privacy-first apps where the user owns the data in their Solid Pod*. A whiteboard is a sharp test of that thesis because real-time collaboration is exactly where "user-owned data" usually breaks down — most whiteboards (Figma, Miro, even Excalidraw's hosted version) put the durable document on the vendor's servers.

`whiteboard` keeps the **durable, canonical board in the owner's pod** while making the **live editing session fast** via an ephemeral relay that never persists anything. The pod is the source of truth; the relay is a dumb, disposable pipe. This is the same "division of labour" the Solid+CRDT community (m-ld) converged on, and it lets us honor the Mind invariant *without* a laggy whiteboard.

It also reuses the family's shared identity layer: one `MindLoginCard`, one default OIDC issuer (`pods.mindpods.org`), so a friend who is already signed into another Mind app joins via silent SSO.

---

## 3. Recommended architecture (the decision)

The research produced one clear, defensible stack. This section is the architectural commitment; §11 records the alternatives we rejected and why.

```
 Owner browser ─┐                                      ┌─ debounced snapshot (PUT, ~2–5s idle / beforeunload)
 Friend browser ┼─ Yjs doc (in-memory CRDT) ───────────┤
                │   • y-websocket relay (ephemeral)     └─ POD: /mind-whiteboard/boards/<id>.bin   (Y.encodeStateAsUpdate, E2E-encrypted)
                │     - strokes/shapes deltas                  /mind-whiteboard/boards/<id>.meta.ttl (title, owner, created, last-modified)
                │     - awareness = live cursors/presence
                └─ y-indexeddb (offline / local cache)

 CSS WebSocketChannel2023 ── topic: <id>.bin ── "the pod copy changed" → cold/other-device clients reload the snapshot
```

### 3.1 Canvas engine — **Excalidraw** (`@excalidraw/excalidraw`, MIT)

- **Why:** MIT-licensed, no watermark, no license key, no per-user fee. Ships freehand (via `perfect-freehand`), shapes, arrows, text, and the hand-drawn aesthetic out of the box — i.e. all of W1 for free. Exposes `<Excalidraw>` + an imperative API (`updateScene`, `onChange(elements, appState, files)`) so we can drive it from our own sync layer.
- **Why not tldraw:** tldraw is the better SDK *engineering*, but as of 2026 it is source-available, **not** open-source, and **not free in production** (watermark on the free tier; ~$6k/yr to remove it; every redistributor needs their own key). That conflicts head-on with a privacy-first, user-owned, self-hostable prototype. Rejected on licensing, not merit.

### 3.2 Real-time sync — **Yjs** (CRDT)

- **Why:** de-facto standard for collaborative canvases in 2026; largest provider ecosystem; small, fast. Conflict-free merge means the relay can stay dumb (and can't read the data — enabling E2E encryption).
- **Mapping:** Excalidraw is *not* natively CRDT, so we own a thin bridge: Excalidraw `elements` ⇄ a `Y.Map` keyed by element id. `onChange` → write changed elements into the Y.Map; Y.Map observer → `updateScene` with the merged set. (Excalidraw already carries `version`/`versionNonce` per element, which makes a clean per-element CRDT key.)
- **Presence/cursors:** Yjs **awareness** protocol — ephemeral, **never persisted**. Each peer publishes `{ cursor:{x,y}, name, color, selection }`; peers render avatars/cursors; on disconnect the state auto-clears and cursors vanish. This is W3's "see each other" half.

### 3.3 Transport — **single WebSocket relay** (`y-websocket`)

- **Why not WebRTC/P2P:** "send a friend a link" sounds like a P2P use case, but `y-webrtc` still needs a signaling server *and* usually a TURN relay (~10–20% of peers behind strict NAT fail without it), and a pure-P2P doc has no server-side anchor to snapshot from. So WebRTC doesn't actually save infra here.
- **Why WebSocket:** one connection, no NAT traversal, trivial auth, and the relay is the natural coordination point. For 2–5 collaborators this is the simplest robust option. The relay holds **no durable state** — kill it and the pod copy is untouched.

### 3.4 Persistence — **debounced encrypted snapshots to the pod**

- On a debounce/idle timer (~2–5s) and on `beforeunload`, the **owner's client** encodes the Yjs doc (`Y.encodeStateAsUpdate`), **encrypts it client-side**, and `PUT`s it to `/mind-whiteboard/boards/<id>.bin` in the owner's pod. Metadata (title, `dcterms:creator`, created/last-modified, AS2.0 type) goes to a sibling `.meta.ttl`.
- Client-side snapshotting by the owner keeps the relay **credential-free** (it never touches the pod), which is the simplest correct privacy story for a prototype. Server-side snapshotting (Y-Sweet style) is deferred — it needs delegated pod auth and a trusted relay.

### 3.5 CSS notifications — **wake-up only, not the hot path**

- We subscribe to `WebSocketChannel2023` on `<id>.bin` purely so a **cold or other-device client** (owner's second device; a viewer not in the live relay) learns the pod copy changed and re-fetches.
- We do **not** route strokes/cursors through CSS notifications. CSS notifications are *change-signals* (Activity Streams 2.0 "this resource changed"), not deltas — every signal forces a full re-GET, and there's no presence concept. Using the pod as a per-stroke message queue is explicitly the anti-pattern the Solid+CRDT community warns against. This reuses the proven discover→POST-subscription→open-WS flow already implemented in `chat/src/lib/solid/chat-subscription.ts`, including its 2s polling fallback.

---

## 4. Sharing & access model (W2 in detail)

The share link must let a friend (a) open the durable board and (b) join the live session.

**Link shape (capability-URL, Excalidraw-style):**
```
https://<app>/board/<boardId>?pod=<encoded-pod-snapshot-URL>#k=<e2e-key>
```
- `boardId` → the live relay room id.
- `pod=` → where the durable snapshot lives (so the friend can seed the canvas before going live).
- `#k=` → the AES key in the **URL fragment**. Browsers never send the fragment to a server, so the relay and the pod only ever see ciphertext. Possession of the link = ability to decrypt.

**Two access tiers (both supported; owner picks in the Share dialog):**

| Tier | Pod access | Friend needs | Mechanism |
|------|-----------|--------------|-----------|
| **Public link** (default, simplest) | `setPublicAccess(snapshot, { read: true })` | nothing (no login) | anyone with the full link can read + decrypt |
| **WebID grant** (controlled) | `setAgentAccess(snapshot, friendWebID, { read, write })` | their own pod login (silent SSO if already signed into a Mind app) | named-agent WAC/ACP rule |

- Use the **Inrupt Universal Access API** (`universalAccess.setAgentAccess` / `setPublicAccess`) so the same code works whether CSS serves WAC or ACP. Set access on the `.bin`, the `.meta.ttl`, **and** the containing folder.
- WebID-grant tier mirrors `chat/src/lib/solid/chat-acl.ts` (re-write the authoritative ACL on every add-member; `acl:Read`+`acl:Append`/`Write`).

---

## 5. User flows

**W1 — Draw (solo owner)**
1. Land on `/` → `MindLoginCard` (accent color reserved for whiteboard; default issuer `pods.mindpods.org`).
2. Sign in → OIDC redirect → `/login/callback` → land on `/board/<newId>`.
3. New board scaffolds in the pod (`<id>.bin` + `<id>.meta.ttl`); Excalidraw canvas mounts; draw freely.
4. Edits debounce-save to the pod; a quiet "Saved to your pod" affordance confirms.

**W2 — Share**
1. Click **Share** → dialog (from `@mind-studio/ui` `Dialog`).
2. Choose **Public link** or **Invite a WebID**; app sets pod access accordingly.
3. App composes the capability URL (with `#k=` fragment) and copies it to clipboard.

**W3 — Live collaborate**
1. Friend opens the link → (public: straight in; WebID: `MindLoginCard` → silent SSO if possible).
2. Friend's client GETs `<id>.bin`, decrypts, seeds the Yjs doc, then joins the `y-websocket` room.
3. Both draw live: strokes merge via Yjs; cursors/presence via awareness. Owner's client keeps snapshotting to the pod.

---

## 6. Scope

### In scope (v1)
- Pod sign-in via `MindLoginCard` + the `drive` single-flight redirect guard.
- Excalidraw canvas: freehand, shapes, arrows, text, select/move/delete, color/stroke controls (Excalidraw built-ins).
- Yjs ⇄ Excalidraw bridge; `y-websocket` relay; awareness cursors with name+color.
- Debounced encrypted snapshot persistence to the owner's pod + `.meta.ttl`.
- Share dialog: public-link and WebID-grant tiers; capability URL with fragment key.
- CSS `WebSocketChannel2023` wake-up subscription for cold/other-device reload.
- A "My boards" list (read the owner's `/mind-whiteboard/boards/` container).
- Local CSS via `docker compose` (port 3111) + a `seed:demo` script (alice/bob personas).
- `@mind-studio/ui` Mind brand theming; RSC-safe component usage.

### Out of scope (v1 — explicitly deferred)
- tldraw / paid SDKs.
- Server-side (relay-driven) pod snapshotting with delegated credentials.
- WebRTC/P2P transport, TURN infrastructure.
- More than ~5 simultaneous collaborators / horizontal relay scaling.
- Per-element WAC (whole-board access only).
- Comments, version history/time-travel, export to PNG/SVG beyond Excalidraw defaults, embedding, mobile-native.
- Offline-merge conflict UX beyond what Yjs + `y-indexeddb` give for free.
- E2E encryption key rotation / revocation (link possession is the capability).

---

## 7. The stack (concrete)

| Concern | Choice |
|---|---|
| Framework | Next.js 16.2.6 / React 19.2.4 (Turbopack — read `node_modules/next/dist/docs/`, not training data) |
| Canvas | `@excalidraw/excalidraw` (MIT) |
| CRDT | `yjs` + `y-protocols` (awareness) |
| Transport | `y-websocket` (single relay; small Node WS server or Next route handler) |
| Local cache | `y-indexeddb` |
| Pod I/O | `@inrupt/solid-client` ^3 (`getFile`/`overwriteFile`/`getSolidDataset`/`universalAccess`) |
| Auth | `@inrupt/solid-client-authn-browser` ^4 |
| Identity UI | `@mind-studio/core` → `MindLoginCard` (+ `/launcher` app grid) |
| Design system | `@mind-studio/ui` (Mind brand) |
| Notifications | CSS v7 `WebSocketChannel2023` (wake-up only) |
| Pod host (local) | CommunitySolidServer v7 via Docker, `:3111` |
| Scripts | `tsx scripts/*.ts` |

---

## 8. Library integration notes (from the API research)

**`@mind-studio/core` — consume as a tarball, NOT `file:`** (Turbopack panics on out-of-root symlinks):
```jsonc
// package.json
"@mind-studio/core": "file:../mind-shared-ui/mind-studio-core-0.1.1.tgz"
```
```ts
// next.config.ts
export default { transpilePackages: ["@mind-studio/core"] };
```
- After editing shared-ui: `cd ../mind-shared-ui && ./scripts/sync.sh` (build → pack → reinstall into every consumer).
- `MindLoginCard` props we use: `appName="Whiteboard"`, `defaultIssuer`, `accent` (reserve an unused color — e.g. amber/`#d97706`), `onLogin={browserOidcLogin(login, { callbackPath: "/login/callback", clientName: "Mind Whiteboard" })}`. It ships its own CSS; no Tailwind `@source` needed for the card.

**`@mind-studio/ui` — components for the whiteboard chrome:**
- `Button`/`DropdownMenu` (toolbar, menus), `Dialog`+`Input`+`Select` (Share dialog), `Avatar`/`AvatarGroup` (presence), `Tooltip` (tool hints), `Tabs`/`Sidebar` (panels), `Badge` (live/offline status).
- Setup: wrap root in `<ThemeProvider theme={mind}>`; `globals.css` does `@import "tailwindcss"; @import ".../@mind-studio/ui/dist/styles.css"; @source ".../@mind-studio/ui/dist";`.
- **RSC gotcha:** `Badge`/`Card`/`cn` break in Server Components. Keep all `@mind-studio/ui` usage inside `"use client"` components; server pages delegate to client components. (Matches the workspace auto-memory.)

---

## 9. Proposed layout (mirrors `drive`)

```
whiteboard/
├── package.json            # next 16.2.6, react 19.2.4, excalidraw, yjs, y-websocket, y-indexeddb, inrupt SDKs, @mind-studio/*
├── next.config.ts          # transpilePackages: ["@mind-studio/core"]
├── tsconfig.json           # strict, @/* alias
├── postcss.config.mjs      # @tailwindcss/postcss
├── .npmrc / .env.example   # @mind-studio registry; NEXT_PUBLIC_SOLID_ISSUER, NEXT_PUBLIC_RELAY_URL
├── docker-compose.yml      # CSS v7 on :3111
├── README.md / AGENTS.md
├── infra/css/seed.json     # alice, bob
├── scripts/seed-demo.ts
├── relay/                  # tiny y-websocket server (Node) — ephemeral, no persistence
└── src/
    ├── lib/solid/          # session.ts, auth.ts (single-flight), pod-fs.ts, access.ts, notifications.ts
    ├── lib/whiteboard/     # yjs-doc.ts, excalidraw-bridge.ts, snapshot.ts, crypto.ts (E2E), share-link.ts
    ├── components/         # Canvas, Toolbar, PresenceCursors, CollaboratorsBar, ShareDialog  ("use client")
    └── app/                # layout.tsx, page.tsx (MindLoginCard), login/callback, board/[id], boards (list)
```

**Build-time env gotcha:** `NEXT_PUBLIC_*` (issuer, relay URL) is inlined at build time — set before `next dev`/`build` and hard-reload tabs after changing it.

---

## 10. Milestones

1. **M0 — Scaffold:** clone `drive` shape, wire `@mind-studio/ui` + `@mind-studio/core`, sign in, blank `/board/[id]`. *(W1 shell)*
2. **M1 — Draw + persist (solo):** Excalidraw mounts; `onChange` → debounced encrypted snapshot to pod; reload restores board. *(W1 ✅)*
3. **M2 — Live (relay):** Yjs⇄Excalidraw bridge over `y-websocket`; two tabs draw together; awareness cursors. *(W3 mechanics)*
4. **M3 — Share:** Share dialog, capability URL + fragment key, public + WebID-grant tiers via Universal Access. *(W2 ✅)*
5. **M4 — Wake-up + boards list:** CSS `WebSocketChannel2023` cold-reload; "My boards" container view. *(W3 polish)*
6. **M5 — Demo seed + verify:** `seed:demo`; two-persona (alice/bob) end-to-end live-collab walkthrough.

---

## 11. Rejected alternatives (decision log)

| Option | Rejected because |
|---|---|
| **tldraw SDK** | Source-available, not OSS; watermark on free tier, ~$6k/yr to remove; every redistributor needs a key — incompatible with privacy-first / self-hostable. |
| **WebRTC / `y-webrtc`** | Still needs signaling + TURN; flaky behind NAT; no server anchor to snapshot from. No real infra savings for "share a link." |
| **Sync through CSS notifications / pod writes only** | Change-signals not deltas (full re-GET per change); no presence; write amplification/contention; "pod as message queue" anti-pattern. Fine only for low-frequency boards. |
| **Automerge / Loro instead of Yjs** | Yjs has the larger ecosystem + canvas precedent. Automerge only wins if we needed Git-like history (out of scope). |
| **Build a custom canvas** | Excalidraw already ships every W1 feature MIT-licensed; custom canvas is wasted effort. |
| **Server-side relay snapshotting (Y-Sweet style)** | Needs delegated pod credentials + trusted relay. Deferred; owner-client snapshotting keeps the relay credential-free. |

---

## 12. Open questions for sign-off

1. **Accent color** for `MindLoginCard` / Mind theme tint — proposing amber `#d97706` (unused by siblings). OK?
2. **Default share tier** — public-link (frictionless) vs. WebID-grant (controlled) as the default in the Share dialog? Proposing **public-link** for demo-ability.
3. **Relay hosting** — local Node `relay/` for dev is assumed; do we need a deployed relay (mindpods.org infra) in v1, or is local-only fine for the prototype?
4. **E2E encryption in v1** — include client-side encryption from the start (proposed, it's the privacy payoff), or ship plaintext-in-pod first and layer crypto in M4?
5. **Port confirmation** — `:3110` app / `:3111` CSS (311x band). Confirm no collision with anything you're running.
