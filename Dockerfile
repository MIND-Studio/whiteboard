# syntax=docker/dockerfile:1.7
#
# Production image for the mind-whiteboard Next.js app. Two stages:
#   builder — installs deps and runs `next build` to emit .next/standalone.
#   runtime — minimal Debian-slim running the standalone server as non-root.
#
# This image is ONLY the web app. The collaboration relay is a separate,
# credential-free image (see relay/Dockerfile) so the privacy boundary holds:
# the relay never shares a process or a filesystem with anything that touches
# pod credentials. See docs/DEPLOYMENT.md.

# --- Stage 1: build --------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# `.npmrc` points the @mind-studio scope at GitHub Packages and reads the auth
# token from $NODE_AUTH_TOKEN, passed as a BuildKit secret (never layer-baked).
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" \
    npm ci --no-audit --no-fund

COPY . .
RUN mkdir -p public

# NEXT_PUBLIC_* are inlined at build time (passed as build-args by the workflow).
# These are the ONLY three the app reads (src/lib/config.ts). The whiteboard
# does not render the shared app-launcher, so it bakes NO NEXT_PUBLIC_APP_*_URL.
ARG NEXT_PUBLIC_SOLID_ISSUER
ARG NEXT_PUBLIC_RELAY_URL
ARG NEXT_PUBLIC_WHITEBOARD_NAMESPACE
ENV NEXT_PUBLIC_SOLID_ISSUER=$NEXT_PUBLIC_SOLID_ISSUER \
    NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL \
    NEXT_PUBLIC_WHITEBOARD_NAMESPACE=$NEXT_PUBLIC_WHITEBOARD_NAMESPACE

# App-owned feedback inbox (public-append container). Inlined at build time.
ARG NEXT_PUBLIC_FEEDBACK_INBOX
ENV NEXT_PUBLIC_FEEDBACK_INBOX=$NEXT_PUBLIC_FEEDBACK_INBOX

RUN npm run build

# --- Stage 2: runtime ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

USER node

COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
