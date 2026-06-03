# Known issues — `mind-whiteboard-v1`

Status of the three wishes after the M0–M5 build + end-to-end verification (2026-06-02/03).

| Wish | Status |
|---|---|
| **W1 — Draw + auto-save to pod** | ✅ Verified live (signed-in alice on local CSS: drew shapes → encrypted `.bin` `PUT` 201 to `…/alice/mind-whiteboard/boards/<id>.bin`, with `.meta.ttl`). |
| **W2 — Share** | ✅ Verified live (public-link tier: `setBoardPublicAccess` on the real drawn `.bin` → anonymous `GET` 200 → decrypt with the `#k=` fragment key → decoded the owner's exact elements). |
| **W3 — Live collaborate** | ⚠️ **Partial — see WB-1 below.** Opening a shared board, seeing the drawing, and bidirectional live cursors/presence all work. Friend-side *interactive editing* is broken. |

---

## WB-1 — Friend-side interactive editing crashes Excalidraw hit-test (W3) — OPEN

**Severity:** high for W3 (live two-way editing); does not affect W1/W2 or read-only viewing of a shared board.

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

**Fix (localized, known).** In `excalidraw-bridge.ts`, when materializing elements from the `Y.Map` for `updateScene`, run them through Excalidraw's **`restoreElements()`** first — it fills every required field with the correct defaults (the crash is hit-testing reading e.g. `backgroundColor`/array fields that are `undefined` on a partial element). Don't pass raw reconstructed objects to `updateScene`. Validate against Excalidraw 0.18's API (`node_modules/@excalidraw/excalidraw`). Then re-run the two-tab interactive test below.

**Repro / acceptance test.**
1. Start stack: `docker compose up -d` (CSS :3111), `npm run relay` (:3112), `npm run dev` (:3110). Seed: `npm run seed:demo`.
2. **Fresh incognito** context, sign in as seeded local **alice** with issuer `http://localhost:3111/` (a stale `pod.mindpods.org` cookie in a non-incognito context will silently auth against prod — see N-1).
3. Use **in-app navigation only** (click "New board") — not a hard `goto` (see N-2). Draw a couple shapes.
4. Share → Create public link → open the link in a **second** context (no login).
5. Friend hovers/draws over the synced shapes → today: 25× the TypeError above; friend can't draw. After the fix: no crash, friend draws, friend→owner sync lands.

---

## Notes (NOT bugs — by-design, documented to prevent re-investigation)

**N-1 — Sign-in can hit the prod pod from a shared/non-incognito browser.** `src/lib/config.ts` keeps `https://pod.mindpods.org/` as the *fallback* default issuer; `.env.local` overrides it to `http://localhost:3111/` and the app correctly uses the local value. But if the browser already holds a `pod.mindpods.org` session cookie, the OIDC provider auto-completes against **prod** before the local issuer takes effect. For local verification always use a **fresh incognito** context. Not a code defect.

**N-2 — OIDC session is in-memory; survives SPA nav, not a hard page load.** `restorePreviousSession` is deliberately **off** (`src/lib/solid/auth.ts` / `session.ts`) — turning it on caused an infinite `/login/callback ↔ /boards` redirect loop on CSS (same tradeoff ported from `mind-drive-v0`). So the session survives in-app `router.push/replace` navigation but **not** a hard reload / typed URL / deep-link cold load (those land signed-out). This is expected. If hard-nav/deep-link session survival is wanted later, enable `restorePreviousSession: true` on normal page loads **only** (keep it off on the `/login/callback` route to avoid the loop), and verify against CSS before trusting it.
