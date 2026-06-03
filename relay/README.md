# mind-whiteboard relay

Ephemeral [y-websocket](https://github.com/yjs/y-websocket) room broker. One in-memory `Y.Doc` + awareness per board id; **no persistence, no pod credentials, no decryption** — kill it and the pod copy is untouched. Run from the app root with `npm run relay` (boots `tsx relay/server.ts` on `ws://localhost:3112`; override with `RELAY_PORT`/`RELAY_HOST`). Health check: `GET /health`.
