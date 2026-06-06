/**
 * Seed the demo personas for whiteboard.
 *
 * For each persona (alice, bob) this mints client credentials against the local
 * CSS, ensures the `mind-whiteboard/boards/` container exists, and writes a demo
 * board's metadata sidecar (`<id>.meta.ttl`) so the "My boards" list is not
 * empty on first sign-in. It then grants bob read on alice's demo board (the
 * WebID-grant share tier) so the two-persona live-collab walkthrough has
 * something to open.
 *
 * What it does NOT seed: the encrypted `<id>.bin` snapshot. That is an
 * AES-encrypted Yjs document whose key only ever lives in the share link's `#k=`
 * fragment (PRD §3.4/§4) — it's produced by the owner's BROWSER on first draw,
 * never server-side. So the demo board starts blank; draw on it live. The
 * metadata + container + ACL are everything the seed can honestly provide.
 *
 * Usage:
 *   docker compose up -d            # CSS on :3111
 *   npm run seed:demo
 *
 * Idempotent — re-running overwrites the same metadata + re-asserts the grant.
 */
import { Session } from "@inrupt/solid-client-authn-node";

const POD_BASE = process.env.POD_BASE_URL ?? "http://localhost:3111/";
const PASSWORD = process.env.SEED_PASSWORD ?? "dev-only-do-not-use-in-prod";
const NAMESPACE = process.env.NEXT_PUBLIC_WHITEBOARD_NAMESPACE ?? "mind-whiteboard";

/** Stable id so re-seeding is idempotent (no orphaned demo boards pile up). */
const DEMO_BOARD_ID = "demo-welcome";

type Persona = {
  name: string;
  email: string;
  podName: string;
};

const ALICE: Persona = {
  name: "alice",
  email: process.env.SEED_EMAIL ?? "alice@mind-whiteboard.local",
  podName: "alice",
};
const BOB: Persona = {
  name: "bob",
  email: "bob@mind-whiteboard.local",
  podName: "bob",
};

function podRoot(p: Persona): string {
  return `${POD_BASE}${p.podName}/`;
}
function webId(p: Persona): string {
  return `${podRoot(p)}profile/card#me`;
}
function boardsRoot(p: Persona): string {
  return `${podRoot(p)}${NAMESPACE}/boards/`;
}

async function mintCredentials(
  email: string,
  webIdUrl: string
): Promise<{ id: string; secret: string }> {
  const indexRes = await fetch(`${POD_BASE}.account/`);
  if (!indexRes.ok) {
    throw new Error(`CSS account index ${indexRes.status} — is CSS running?`);
  }
  const { controls } = (await indexRes.json()) as {
    controls: { password: { login: string } };
  };

  const loginRes = await fetch(controls.password.login, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { authorization } = (await loginRes.json()) as { authorization: string };

  const accountRes = await fetch(`${POD_BASE}.account/`, {
    headers: { Authorization: `CSS-Account-Token ${authorization}` },
  });
  const account = (await accountRes.json()) as {
    controls: { account: { clientCredentials: string } };
  };

  const credRes = await fetch(account.controls.account.clientCredentials, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `CSS-Account-Token ${authorization}`,
    },
    body: JSON.stringify({ name: "mind-whiteboard-seed", webId: webIdUrl }),
  });
  if (!credRes.ok) {
    throw new Error(
      `Credentials creation failed: ${credRes.status} ${await credRes.text()}`
    );
  }
  return (await credRes.json()) as { id: string; secret: string };
}

async function loginAs(p: Persona): Promise<Session> {
  const { id, secret } = await mintCredentials(p.email, webId(p));
  const session = new Session();
  await session.login({ clientId: id, clientSecret: secret, oidcIssuer: POD_BASE });
  if (!session.info.isLoggedIn) throw new Error(`login did not stick for ${p.name}`);
  return session;
}

async function ensureContainer(session: Session, url: string) {
  const res = await session.fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "text/turtle",
      Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      "If-None-Match": "*",
    },
  });
  // 412 = already exists, 409/205 = ok-ish; anything else is real.
  if (!res.ok && ![205, 409, 412].includes(res.status)) {
    throw new Error(`Container PUT ${url} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · ensured ${url}\n`);
}

async function put(
  session: Session,
  url: string,
  body: string,
  contentType: string
) {
  const res = await session.fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!res.ok && res.status !== 205) {
    throw new Error(`PUT ${url} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · wrote ${url}\n`);
}

/** Minimal board metadata sidecar — title, creator, timestamps, AS2.0 type. */
function metaTtl(opts: {
  title: string;
  creatorWebId: string;
  createdIso: string;
  modifiedIso: string;
}): string {
  return `@prefix dcterms: <http://purl.org/dc/terms/>.
@prefix as: <https://www.w3.org/ns/activitystreams#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<>
  a as:Document;
  dcterms:title "${opts.title}";
  dcterms:creator <${opts.creatorWebId}>;
  dcterms:created "${opts.createdIso}"^^xsd:dateTime;
  dcterms:modified "${opts.modifiedIso}"^^xsd:dateTime.
`;
}

/** Grant a WebID read on a single resource via WAC (.acl PUT, owner+agent). */
async function grantAgentRead(
  session: Session,
  resourceUrl: string,
  ownerWebId: string,
  agentWebId: string,
  isContainer: boolean
) {
  const aclUrl = `${resourceUrl}.acl`;
  const childDefault = isContainer ? "\n  acl:default <./>;" : "";
  const accessTo = isContainer ? "<./>" : `<${resourceUrl.split("/").pop()}>`;
  const ttl = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.

<#owner>
  a acl:Authorization;
  acl:agent <${ownerWebId}>;
  acl:accessTo ${accessTo};${childDefault}
  acl:mode acl:Read, acl:Write, acl:Control.

<#agent>
  a acl:Authorization;
  acl:agent <${agentWebId}>;
  acl:accessTo ${accessTo};${childDefault}
  acl:mode acl:Read.
`;
  const res = await session.fetch(aclUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/turtle" },
    body: ttl,
  });
  if (!res.ok && res.status !== 205) {
    throw new Error(`ACL PUT ${aclUrl} → ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`  · granted ${agentWebId} read on ${resourceUrl}\n`);
}

async function seedPersona(p: Persona): Promise<Session> {
  console.log(`\n[seed] ${p.name}: minting credentials at ${POD_BASE}`);
  const session = await loginAs(p);
  console.log(`[seed] ${p.name}: webId = ${session.info.webId}`);

  await ensureContainer(session, `${podRoot(p)}${NAMESPACE}/`);
  await ensureContainer(session, boardsRoot(p));
  return session;
}

async function main() {
  // Alice owns the demo board; bob is the invited collaborator.
  const aliceSession = await seedPersona(ALICE);
  const bobSession = await seedPersona(BOB);

  const now = new Date().toISOString();
  const metaUrl = `${boardsRoot(ALICE)}${DEMO_BOARD_ID}.meta.ttl`;
  console.log(`\n[seed] writing demo board metadata for alice`);
  await put(
    aliceSession,
    metaUrl,
    metaTtl({
      title: "Welcome board",
      creatorWebId: webId(ALICE),
      createdIso: now,
      modifiedIso: now,
    }),
    "text/turtle"
  );

  console.log(`[seed] granting bob read on alice's demo board (WebID-grant tier)`);
  await grantAgentRead(aliceSession, boardsRoot(ALICE), webId(ALICE), webId(BOB), true);
  await grantAgentRead(aliceSession, metaUrl, webId(ALICE), webId(BOB), false);

  console.log(`\n[seed] done.`);
  console.log(`[seed] open http://localhost:3110/`);
  console.log(`[seed] OIDC issuer = ${POD_BASE}`);
  console.log(`[seed] alice's boards = ${boardsRoot(ALICE)}`);
  console.log(
    `[seed] the demo board's .bin is created live when alice first draws ` +
      `(it's E2E-encrypted with the link key, so it can't be seeded here).`
  );

  await aliceSession.logout();
  await bobSession.logout();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
