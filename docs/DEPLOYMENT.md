# Deploying whiteboard to `whiteboard.mindpods.org`

Plan to take `whiteboard` from a dev-only prototype to a shipped app in the
[`mindpods-infra`](https://github.com/MIND-Studio/mindpods-infra) fleet, alongside dock / drive / builder /
codespaces. The app half mirrors what those four already do — copy from
`drive` (Dockerfile + `release.yml`) and follow
[`mindpods-infra/docs/APP-DOCKERFILE.md`](https://github.com/MIND-Studio/mindpods-infra/blob/main/docs/APP-DOCKERFILE.md).

**What makes whiteboard different from every sibling: it ships TWO containers.**
The Next.js app *and* an ephemeral `y-websocket` **relay**. The relay is a second
GHCR image, a second compose service, and a second vhost (`wss://`). Everything
below that mentions "the relay" is the part the chat/drive playbooks don't cover.

Status (2026-06-03): **Part A done in this repo** (standalone output, both
Dockerfiles, both-image CI, env de-drift, registry dep — all built & smoke-tested
locally). **Parts B–F (infra repo, DNS, deploy, seed) are the remaining to-do.**

---

## Architecture note — two deployables, one privacy boundary

mind-whiteboard is a **client-only SPA** (no API routes; all components are
`'use client'`, server pages delegate to client islands). It talks to three things:

| Endpoint | Who serves it | Carries |
|---|---|---|
| `pods.mindpods.org` | CSS (already in the fleet) | OIDC + the durable, **E2E-encrypted** board snapshots (`.bin` + `.meta.ttl`) |
| `whiteboard.mindpods.org` | this app image (standalone Next on `:3000`) | the SPA itself |
| `whiteboard-relay.mindpods.org` | **the relay image** (`:3112`) | live Yjs deltas + awareness (cursors) over **WebSocket** |

The relay is a **dumb, credential-free, persistence-free pipe** (AGENTS.md
hard-rule 6, PRD §3.3): in-memory `Y.Doc` per room, GC'd when the last peer
leaves. The pod is the only source of truth; the owner's *client* encrypts and
snapshots. So the relay image:

- holds **no pod credentials**, has **no `@mind-studio` deps**, needs **no GHCR
  secret** to build (all deps are public npm),
- mounts **no volumes** and writes nothing to disk,
- only ever sees ciphertext-bearing Yjs structs it can't read.

**Consequence for Caddy:** the relay vhost is a plain `reverse_proxy` — Caddy
auto-handles the WebSocket `Upgrade`, exactly like the pod vhost already does for
CSS notifications. No special block is needed; just don't buffer.

---

## Blockers to resolve before shipping (design)

Real decisions, not mechanics — settle these first.

1. **W3 (live collaborate) is partial — `WB-1` is open.** Per
   [`docs/KNOWN-ISSUES.md`](KNOWN-ISSUES.md): a friend can open a shared board,
   see the drawing, and exchange live cursors, but **friend-side interactive
   editing crashes** Excalidraw's hit-test (partial `ExcalidrawElement` from the
   Yjs→Excalidraw bridge; fix is localized — run reconstructed elements through
   `restoreElements()` in `excalidraw-bridge.ts`). **Decide:** ship v0.1.0 as
   "draw + share + *view* live (read-only collab + cursors)" with WB-1 as a
   fast-follow, or fix WB-1 first. This plan assumes **ship-with-WB-1-open**,
   advertised honestly as W1✅/W2✅/W3⚠️ (matches `README.md`).

2. **No room/board discovery decision needed — there's no baked room.** Unlike
   chat (which bakes a single `NEXT_PUBLIC_ROOM_URL`), whiteboard discovers boards
   at runtime from the signed-in pod (`<pod>/<namespace>/boards/`) and mints share
   links client-side. The image is already user-agnostic. Nothing to defer here.

3. **The relay is unauthenticated by design.** Anyone who knows a board id (a
   random UUID) can join its relay room and receive its Yjs deltas — but those
   deltas are **opaque** without the AES key, which lives only in the share link's
   URL `#fragment` (never sent to any server). This is the intended threat model
   (PRD privacy invariants), **but confirm it's acceptable for a public alpha**
   before exposing the relay on the internet. A rate-limit / origin-check on the
   relay vhost is a reasonable hardening fast-follow, not a v0.1.0 blocker.

4. **Launcher cross-listing.** Whiteboard renders only `MindLoginCard` (it does
   **not** show the shared app-launcher), so its own image needs **no**
   `NEXT_PUBLIC_APP_*_URL` build-args. But for whiteboard to appear in the *other*
   apps' launchers, add a `NEXT_PUBLIC_APP_WHITEBOARD_URL` entry to the
   `@mind-studio/core` launcher catalog, bump `core`, and re-release the siblings
   that show the launcher (dock/drive/builder). Fast-follow, not a blocker for
   whiteboard's own deploy. (See the `launcher_catalog_production` pattern.)

---

## Part A — Productionize the app repo (`whiteboard`) — ✅ DONE

All committed in this repo; each was built and smoke-tested locally.

### A1. Standalone output — ✅

`next.config.ts` now sets `output: "standalone"` (emits
`.next/standalone/server.js`). Verified: `npm run build` produces it.

### A2. Canonical env names — ✅

`src/lib/config.ts` dropped the `NEXT_PUBLIC_OIDC_ISSUER` alias; the only issuer
env name is now `NEXT_PUBLIC_SOLID_ISSUER`. (`NEXT_PUBLIC_*` is build-time-inlined,
so a lingering alias would bake drift permanently per image.) `.env.example`
already uses the canonical name.

### A3. Registry dependency (the Docker blocker) — ✅

`@mind-studio/core` was pinned to `file:../mind-shared-ui/…tgz` — a path **outside
the Docker build context**, so `npm ci` would fail in the image. Switched to the
registry dep `"@mind-studio/core": "^0.1.1"` (identical integrity hash; the exact
artifact every deployed sibling already uses) and regenerated the lockfile.

> **Local-dev tradeoff:** `../mind-shared-ui/scripts/sync.sh` packs a fresh tarball
> into consumers; whiteboard now ignores that and uses the published `^0.1.1`. If
> you need to test an *unpublished* `mind-shared-ui` change here, temporarily point
> the dep back at the tarball — but **publish + bump before building the image**,
> never ship a `file:` dep.

### A4. Prod Dockerfiles (app + relay) — ✅

- **`Dockerfile`** (app): two-stage `node:22-bookworm-slim`, `.npmrc` +
  `NODE_AUTH_TOKEN` BuildKit secret for `@mind-studio/*`, standalone runtime as
  `node` on `:3000`. Bakes **only** the three vars `config.ts` reads (no
  `NEXT_PUBLIC_APP_*` — see design blocker 4):

  ```dockerfile
  ARG NEXT_PUBLIC_SOLID_ISSUER
  ARG NEXT_PUBLIC_RELAY_URL
  ARG NEXT_PUBLIC_WHITEBOARD_NAMESPACE
  ```

- **`relay/Dockerfile`**: single-stage `node:22-bookworm-slim`, **no secret, no
  `.npmrc`** (public deps only), `npm install` + `npx tsx server.ts` on `:3112`,
  runs as `node`. Build context is `./relay`.

- **`.dockerignore`**: keeps `.env.local` (localhost issuer + `ws://localhost`
  relay) **out of the build context** — otherwise it would override the prod
  build-args and bake localhost URLs into the image.

Verified locally: both images build; relay `/health` → `{"ok":true,"rooms":0}`;
app `/` → `200`.

### A5. Release CI (one workflow, two images) — ✅

`.github/workflows/release.yml` builds **both** images on a `v*` tag (jobs `app`
and `relay`) and prints **two** digests:

- `app` job → `IMAGE_NAME: mind-whiteboard`, build-args:
  ```yaml
  NEXT_PUBLIC_SOLID_ISSUER=https://pods.mindpods.org/
  NEXT_PUBLIC_RELAY_URL=wss://whiteboard-relay.mindpods.org
  NEXT_PUBLIC_WHITEBOARD_NAMESPACE=mind-whiteboard
  ```
  → emits `MIND_WHITEBOARD_IMAGE=…@sha256:…`
- `relay` job → `IMAGE_NAME: mind-whiteboard-relay`, `context: ./relay`, no
  build-args, no secrets → emits `MIND_WHITEBOARD_RELAY_IMAGE=…@sha256:…`

> **Repo settings:** Actions → Workflow permissions → **read+write** (so
> `GITHUB_TOKEN` can push the GHCR packages and install `@mind-studio/*`).

### A6. Build + verify locally, then tag

```bash
cd whiteboard
npx tsc --noEmit
NODE_AUTH_TOKEN=$(gh auth token) npm run build      # confirm .next/standalone/server.js

# Optional: reproduce the CI image builds locally
printf '%s' "$(gh auth token)" > /tmp/tok
docker build --secret id=node_auth_token,src=/tmp/tok \
  --build-arg NEXT_PUBLIC_SOLID_ISSUER=https://pods.mindpods.org/ \
  --build-arg NEXT_PUBLIC_RELAY_URL=wss://whiteboard-relay.mindpods.org \
  --build-arg NEXT_PUBLIC_WHITEBOARD_NAMESPACE=mind-whiteboard \
  -t mind-whiteboard:test .
docker build -t mind-whiteboard-relay:test ./relay
rm -f /tmp/tok
```

Then cut the release:

```bash
git tag v0.1.0 && git push --tags                   # or: gh workflow run release.yml
```

Copy **both** printed digests from the job summaries (app + relay).

---

## Part B — Wire into the fleet (`mindpods-infra`) — TODO

Edits in the infra repo. Commit the config; the real digests are box-only.
(Infra commits use that repo's configured identity — `huhn511 <sehe89@gmail.com>`.)

### B1. `.env.example` + `.env` — two new domains

```
MIND_DOMAIN_WHITEBOARD=whiteboard.mindpods.org
MIND_DOMAIN_WHITEBOARD_RELAY=whiteboard-relay.mindpods.org
```

### B2. `compose.yml` — two new services

Add alongside dock/drive/builder. The app is the standard Next standalone shape;
the relay is a bare service with **no volumes, no secrets**:

```yaml
  whiteboard:
    image: ${MIND_WHITEBOARD_IMAGE:?set MIND_WHITEBOARD_IMAGE in images.env}
    container_name: mind-whiteboard
    restart: unless-stopped
    environment:
      NODE_ENV: production
      HOSTNAME: "0.0.0.0"
      PORT: "3000"
    expose: ["3000"]
    networks: [mind]

  whiteboard-relay:
    image: ${MIND_WHITEBOARD_RELAY_IMAGE:?set MIND_WHITEBOARD_RELAY_IMAGE in images.env}
    container_name: mind-whiteboard-relay
    restart: unless-stopped
    environment:
      RELAY_PORT: "3112"
      RELAY_HOST: "0.0.0.0"
    expose: ["3112"]
    networks: [mind]
```

Then add both `whiteboard` and `whiteboard-relay` to caddy's `depends_on: [...]`
list, and add the two env passthroughs under the `caddy:` service:

```yaml
      MIND_DOMAIN_WHITEBOARD:       ${MIND_DOMAIN_WHITEBOARD}
      MIND_DOMAIN_WHITEBOARD_RELAY: ${MIND_DOMAIN_WHITEBOARD_RELAY}
```

### B3. `caddy/Caddyfile` — two new vhosts

The app vhost is the standard reverse-proxy. The relay vhost is also a plain
reverse-proxy — Caddy upgrades the WebSocket automatically — but disable response
buffering so Yjs deltas/cursors flush immediately:

```caddy
{$MIND_DOMAIN_WHITEBOARD} {
	encode zstd gzip
	reverse_proxy whiteboard:3000
}

# Ephemeral y-websocket relay. Plain reverse_proxy = automatic WS upgrade;
# flush_interval -1 so deltas/cursors are not buffered. No persistence, no creds.
{$MIND_DOMAIN_WHITEBOARD_RELAY} {
	reverse_proxy whiteboard-relay:3112 {
		flush_interval -1
	}
}
```

### B4. `images.env.example` — two digest-pin placeholders

```
MIND_WHITEBOARD_IMAGE=ghcr.io/mind-studio/mind-whiteboard@sha256:REPLACE_ME
MIND_WHITEBOARD_RELAY_IMAGE=ghcr.io/mind-studio/mind-whiteboard-relay@sha256:REPLACE_ME
```

### B5. Box `images.env` (NOT rsynced by `deploy.sh`)

Paste the two real digests from A6 into `/opt/mindpods-infra/images.env`:

```
MIND_WHITEBOARD_IMAGE=ghcr.io/mind-studio/mind-whiteboard@sha256:<digest>
MIND_WHITEBOARD_RELAY_IMAGE=ghcr.io/mind-studio/mind-whiteboard-relay@sha256:<digest>
```

---

## Part C — DNS — TODO

Two A records (and AAAA if the box has stable IPv6), both → the VM:

| Type | Name | Value |
|---|---|---|
| A | `whiteboard` | 37.27.80.161 |
| A | `whiteboard-relay` | 37.27.80.161 |

Wait for propagation **before** deploy — Caddy issues each LE cert on first
request per host, and a failed challenge counts against the rate limit. The relay
host needs its own cert too (it's a distinct hostname).

---

## Part D — Deploy — TODO

From an infra checkout (after C has propagated and B5 is on the box):

```bash
cd mindpods-infra
./scripts/deploy.sh        # rsyncs compose+Caddyfile, GHCR-auths, pulls, up -d
```

> **Caddyfile gotcha:** a Caddyfile change is NOT picked up by `up -d` alone (it's
> a single-file bind mount pinned to the start-time inode). Force-recreate caddy:
> ```bash
> ssh mind-codespaces 'cd /opt/mindpods-infra && \
>   docker compose --env-file .env --env-file images.env up -d --force-recreate --no-deps caddy'
> ```

---

## Part E — Verify — TODO

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://whiteboard.mindpods.org          # 200
curl -s https://whiteboard-relay.mindpods.org/health                              # {"ok":true,"rooms":N}
```

Then the real tests:

1. **SSO:** sign in at `dock.mindpods.org`, open `whiteboard.mindpods.org` — one
   consent, no second password (shared OIDC issuer at `pods.mindpods.org`).
2. **W1 draw + persist:** draw on a board → confirm an encrypted `.bin` + `.meta.ttl`
   `PUT` lands under `…/<me>/mind-whiteboard/boards/<id>` on the live pod.
3. **W2 share:** create a public link, open it in a second (logged-out) browser →
   the drawing renders (decrypt via the `#k=` fragment key).
4. **W3 live (partial):** with the relay live, open the same board in two contexts
   → live cursors + read-only sync work over `wss://whiteboard-relay…`. Friend-side
   *editing* is the known `WB-1` gap (see design blocker 1) — verify it degrades
   honestly (no data loss), don't advertise two-way editing until WB-1 is fixed.
5. **Relay isolation:** `docker exec mind-whiteboard-relay ls /` and confirm no
   pod data / no mounted volumes; the relay should hold only in-memory rooms.

---

## Part F — Seed the live demo personas (optional, one-time)

Whiteboard has no baked room, so seeding is only for a scripted demo (alice/bob):

```bash
cd whiteboard
cp .env.example .env.local        # set issuer = https://pods.mindpods.org/ + persona creds
npm run seed:demo                 # idempotent; provisions demo personas
```

(Provision the persona accounts on `pods.mindpods.org` first if they don't exist —
via `codespaces.mindpods.org/signup`.)

---

## Day-2

- **Update whiteboard:** push a new `v*` tag → copy the **two** new digests into
  the box's `images.env` → `./scripts/deploy.sh`. Bump both even if only one
  image changed (keep them in lockstep), or just the one that moved.
- **Fix WB-1 (fast-follow):** `restoreElements()` in `excalidraw-bridge.ts` → flips
  W3 from ⚠️ to ✅; re-run the two-tab interactive test in KNOWN-ISSUES.md.
- **Launcher cross-listing (fast-follow):** add `NEXT_PUBLIC_APP_WHITEBOARD_URL` to
  the `@mind-studio/core` catalog, bump `core`, re-release dock/drive/builder.
- **Relay hardening (fast-follow):** origin-check / rate-limit on the relay vhost.

---

## Checklist

- [ ] **Design:** confirm ship-with-WB-1-open (W3 partial) for v0.1.0
- [ ] **Design:** confirm unauthenticated relay is acceptable for public alpha
- [x] A1 `output: "standalone"`
- [x] A2 drop `NEXT_PUBLIC_OIDC_ISSUER` alias → `NEXT_PUBLIC_SOLID_ISSUER` only
- [x] A3 `@mind-studio/core` → registry `^0.1.1` (Docker-buildable), lockfile regen
- [x] A4 app `Dockerfile` + `relay/Dockerfile` + `.dockerignore`
- [x] A5 `release.yml` (two jobs: mind-whiteboard + mind-whiteboard-relay)
- [ ] A5 enable read+write Actions permissions on the repo
- [ ] A6 local build green → tag `v0.1.0` → grab BOTH digests
- [ ] B1 `MIND_DOMAIN_WHITEBOARD` + `MIND_DOMAIN_WHITEBOARD_RELAY` in `.env(.example)`
- [ ] B2 `whiteboard` + `whiteboard-relay` services + caddy `depends_on` + env passthrough
- [ ] B3 Caddy vhosts (app + relay with `flush_interval -1`)
- [ ] B4 `images.env.example` placeholders (both images)
- [ ] B5 real digests in box `images.env`
- [ ] C DNS A records for `whiteboard` and `whiteboard-relay` (propagated)
- [ ] D `deploy.sh` (force-recreate caddy)
- [ ] E verify 200 / relay `/health` / SSO / W1 / W2 / W3-partial / relay isolation
- [ ] F seed demo personas (optional)
- [ ] Fast-follow: WB-1 fix · launcher cross-listing · relay hardening
```
