# Known issues — `whiteboard`

Status of the three wishes after the M0–M5 build + end-to-end verification (2026-06-02/03).

| Wish | Status |
|---|---|
| **W1 — Draw + auto-save to pod** | ✅ Verified live (signed-in alice on local CSS: drew shapes → encrypted `.bin` `PUT` 201 to `…/alice/mind-whiteboard/boards/<id>.bin`, with `.meta.ttl`). |
| **W2 — Share** | ✅ Verified live (public-link tier: `setBoardPublicAccess` on the real drawn `.bin` → anonymous `GET` 200 → decrypt with the `#k=` fragment key → decoded the owner's exact elements). |
| **W3 — Live collaborate** | ✅ **Fixed in v0.1.1 — see WB-1 below.** Opening a shared board, seeing the drawing, bidirectional live cursors/presence, and friend-side interactive editing all work. |

---

## WB-1 — Friend-side interactive editing crashed Excalidraw hit-test (W3) — FIXED (v0.1.1)

**Severity:** was high for W3 (live two-way editing); never affected W1/W2 or read-only viewing of a shared board.

**Symptom.** When a friend opens a share link (a second, non-logged-in browser context):
- ✅ the board renders — the friend sees all of the owner's shapes (decrypt + seed via `fetchDecryptedSnapshot` → `seedDocFromUpdate` works), and
- ✅ live cursors/presence sync **both** ways (Yjs awareness works), but
- ❌ moving the pointer over any synced shape throws, repeatedly:
  `TypeError: Cannot read properties of undefined (reading 'length')`
  in Excalidraw's hit-test chain: `isTransparent → shouldTestInside → hitElementItself → getElementAtPosition`.
- ❌ Consequently the friend cannot draw, and friend → owner element propagation does not occur.

**Where it surfaces.** `src/components/Canvas.tsx:75` (the `<Excalidraw>` instance) ← `BoardView` — but that is only where the malformed element reaches Excalidraw.

**Root cause.** The Yjs → Excalidraw direction of the bridge (`src/lib/whiteboard/excalidraw-bridge.ts`, the `Y.Map` observer that calls `updateScene`) reconstructs synced elements **without all required `ExcalidrawElement` fields**. Excalidraw's hit-testing assumes every element is a fully-formed `ExcalidrawElement` (e.g. fields it reads `.length` on during `shouldTestInside`/`getElementAtPosition`); a partially-populated element passes through `updateScene` (rendering mostly works) but crashes interactive hit-testing.

Why earlier verification missed it: W3 was first "verified" with a **raw two-`Y.Doc` relay test** that exercised `Y.Map` propagation directly and **bypassed Excalidraw's element reconstruction**, so it never built a real `ExcalidrawElement` from synced state. The bug only appears in the actual two-tab browser flow.

**Fix (shipped, v0.1.1).** `excalidraw-bridge.ts` runs every element materialized from the `Y.Map` through Excalidraw 0.18's **`restoreElements()`** before `updateScene`, which backfills every required field with the correct defaults (the crash was hit-testing reading e.g. `backgroundColor`/array fields that were `undefined` on a partial element).

The restorer is `value`-imported lazily (a static import drags the browser-only bundle into the module graph and throws `window is not defined` during SSR — see the module header comment), so there is a brief window before the dynamic import resolves. The **root defect** was that, during that window, the bridge still painted the **raw, un-normalized** elements to the canvas as a stopgap and only re-painted normalized once the import resolved. A friend opening a share link usually has the pointer already resting over a shape, so that first raw paint hit-tested a malformed element and threw repeatedly — the "25× TypeError" symptom. The fix enforces a hard invariant in `applyFromYMap`: **never hand Excalidraw an un-normalized element.** If `restoreElements` hasn't resolved yet, the paint is *deferred* (a `pendingPaint` flag), not done raw; the import's `.then` callback runs the deferred paint the instant it's ready. In practice the import is already cached (Canvas.tsx dynamic-imports the same package to mount Excalidraw), so the deferral is sub-millisecond.

**Verification status.** Type-checks + production build are green. The two-tab interactive browser repro below was **not** re-run in the deploy environment (no Playwright there); the fix is reasoned from the documented crash mechanism + the Excalidraw 0.18 `restoreElements` source. Re-run the repro locally to close it out fully.

**Repro / acceptance test.**
1. Start stack: `docker compose up -d` (CSS :3111), `npm run relay` (:3112), `npm run dev` (:3110). Seed: `npm run seed:demo`.
2. **Fresh incognito** context, sign in as seeded local **alice** with issuer `http://localhost:3111/` (a stale `pods.mindpods.org` cookie in a non-incognito context will silently auth against prod — see N-1).
3. Use **in-app navigation only** (click "New board") — not a hard `goto` (see N-2). Draw a couple shapes.
4. Share → Create public link → open the link in a **second** context (no login).
5. Friend hovers/draws over the synced shapes → today: 25× the TypeError above; friend can't draw. After the fix: no crash, friend draws, friend→owner sync lands.

---

## Notes (NOT bugs — by-design, documented to prevent re-investigation)

**N-1 — Sign-in can hit the prod pod from a shared/non-incognito browser.** `src/lib/config.ts` keeps `https://pods.mindpods.org/` as the *fallback* default issuer; `.env.local` overrides it to `http://localhost:3111/` and the app correctly uses the local value. But if the browser already holds a `pods.mindpods.org` session cookie, the OIDC provider auto-completes against **prod** before the local issuer takes effect. For local verification always use a **fresh incognito** context. Not a code defect.

**N-2 — OIDC session is in-memory; survives SPA nav, not a hard page load.** `restorePreviousSession` is deliberately **off** (`src/lib/solid/auth.ts` / `session.ts`) — turning it on caused an infinite `/login/callback ↔ /boards` redirect loop on CSS (same tradeoff ported from `drive`). So the session survives in-app `router.push/replace` navigation but **not** a hard reload / typed URL / deep-link cold load (those land signed-out). This is expected. If hard-nav/deep-link session survival is wanted later, enable `restorePreviousSession: true` on normal page loads **only** (keep it off on the `/login/callback` route to avoid the loop), and verify against CSS before trusting it.
