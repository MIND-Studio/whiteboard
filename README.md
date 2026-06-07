# whiteboard

> Privacy-first collaborative whiteboard — **draw** in the browser, **share** a link, **live-collaborate**. Your board lives in your Solid Pod.

See [`docs/PRD.md`](docs/PRD.md) for the full plan, architecture, and decision log. Agents: read [`AGENTS.md`](AGENTS.md) before editing.

**Status:** M0–M5 built and verified end-to-end. **W1 (draw+persist)** ✅ and **W2 (share)** ✅ pass live; **W3 (live collaborate)** ✅ — viewing a shared board, live cursors, and friend-side *interactive editing* all work as of v0.1.1 (the WB-1 hit-test crash is fixed). See [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) (WB-1) for the root cause + fix; re-run the two-tab repro locally to fully close it out.

## The three wishes

1. **Draw** — freehand, shapes, text on an infinite canvas; auto-saved to your pod. ✅
2. **Share** — one link, sent to a friend, carries everything they need. ✅
3. **Live collaborate** — both draw at once, with live cursors and no lag. ✅ *cursors, read-only sync, and friend-side editing all work as of v0.1.1 (WB-1 fixed).*

## Stack at a glance

- **Canvas:** Excalidraw (MIT) · **Sync:** Yjs CRDT · **Transport:** `y-websocket` relay (ephemeral)
- **Durable copy:** debounced, E2E-encrypted snapshots to the owner's pod
- **Identity/UI:** `@mind-studio/core` (`MindLoginCard`) + `@mind-studio/ui` (Mind brand, amber accent)
- **Pod host:** CommunitySolidServer v7
- **Ports:** app `:3110` · local CSS `:3111` · relay `:3112`

The pod is the source of truth; the relay is a dumb, disposable pipe. See the PRD §3 for why.

## Develop

```bash
# Install. @mind-studio/* lives on GitHub Packages and needs a token:
NODE_AUTH_TOKEN="$(gh auth token)" npm install

# Run the app (Next.js, :3110)
npm run dev

# Run the ephemeral relay (:3112) — needed for live collaboration
npm run relay

# Seed demo personas (alice/bob) into the pods — idempotent
npm run seed:demo

# Production build (NEXT_PUBLIC_* is inlined at build time — set env first)
npm run build
```

For local live collaboration, run **both** `npm run dev` and `npm run relay`.

### Configuration

Copy `.env.example` to `.env.local` and adjust. All config flows through `src/lib/config.ts`:

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SOLID_ISSUER` | `https://pods.mindpods.org/` | OIDC issuer for pod sign-in (prod pod → silent SSO across siblings; point at `http://localhost:3111/` for fully-local dev) |
| `NEXT_PUBLIC_RELAY_URL` | `ws://localhost:3112` | Ephemeral `y-websocket` relay |
| `NEXT_PUBLIC_WHITEBOARD_NAMESPACE` | `mind-whiteboard` | Pod namespace; boards live under `<pod>/<namespace>/boards/` |

`NEXT_PUBLIC_*` values are baked in when the dev server starts — restart and hard-reload tabs after changing them.

## Notes

- This is a **sibling** prototype in `mind-prototypes/` — independent app, own ports and data. The family's ports collide by design; run one prototype at a time (or override with `npm run dev -- --port NNNN`).
- `@mind-studio/core` is consumed from the registry (`^0.1.1`), like every deployed sibling, so the prod image builds (a `file:` tarball can't be reached inside the Docker build context). See [`AGENTS.md`](AGENTS.md) hard-rule 1 and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the deploy story and the other hard-won constraints.
- **Deploying?** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the plan to ship to `whiteboard.mindpods.org` (+ the relay at `whiteboard-relay.mindpods.org`). Part A (standalone output, Dockerfiles, CI) is done in-repo; infra/DNS/deploy are the remaining steps.

## Releases

Versioning, `CHANGELOG.md`, and tags are automated with
[release-please](https://github.com/googleapis/release-please) — **don't tag or
edit `CHANGELOG.md` by hand.**

1. Commit to `main` using [Conventional Commits](https://www.conventionalcommits.org):
   `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major.
   `chore:` / `docs:` / `refactor:` / `test:` don't trigger a release.
2. release-please keeps an open **"chore(main): release X.Y.Z"** PR that rolls the
   pending commits into `CHANGELOG.md` and bumps the version.
3. Merge that PR to release: it creates the `vX.Y.Z` tag + GitHub Release, which
   fires `release.yml` to build and push the Docker image to GHCR.
4. Deploying the image to production is a separate, manual GitOps step in
   [`mindpods-infra`](https://github.com/MIND-Studio/mindpods-infra) (`mind-deploy.sh`).
