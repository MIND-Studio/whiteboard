"use client";

/**
 * End-to-end encryption for board snapshots (PRD §3.4, §4).
 *
 * Unlike mind-drive-v0's crypto.ts (passphrase + PBKDF2 + per-file wrapped key),
 * the whiteboard's *key is the capability*: it travels in the share-link URL
 * fragment (`#k=`). Browsers never send the fragment to a server, so the relay
 * and the pod only ever see ciphertext — possession of the full link is what
 * grants the ability to decrypt. There is therefore no passphrase and no KDF:
 * we generate a raw AES-GCM key, base64url-encode it for the fragment, and that
 * single key both encrypts and decrypts the snapshot bytes.
 *
 * Format on the pod (one resource, no sidecar):
 *   /<ns>/boards/<id>.bin  —  [ 12-byte IV ][ AES-GCM ciphertext+tag ]
 *
 * The IV is prepended to the ciphertext (not stored separately) so the `.bin`
 * is fully self-describing given the fragment key. A fresh random IV is drawn
 * on every snapshot — never reuse an IV under the same key.
 *
 * Key rotation / revocation is explicitly out of scope for v1 (PRD §6): the
 * link possession IS the capability, so "revoke" means stop sharing the link.
 */

const KEY_LEN = 256; // AES-256-GCM
const IV_LEN = 12; // 96-bit nonce, the GCM standard

/** Opaque to callers; `Uint8Array` is just the plaintext/ciphertext payload. */
export type SnapshotKey = CryptoKey;

// --- base64url helpers (URL-fragment safe: no +/= padding) -----------------

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- key lifecycle ----------------------------------------------------------

/** Generate a fresh exportable AES-GCM key for a brand-new board. */
export async function generateKey(): Promise<SnapshotKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: KEY_LEN },
    true, // extractable — we must export it into the share-link fragment
    ["encrypt", "decrypt"],
  );
}

/** Export a key to the base64url string that goes after `#k=` in the link. */
export async function exportKey(key: SnapshotKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return bytesToB64url(raw);
}

/** Import a key from a share-link `#k=` fragment value. */
export async function importKey(b64url: string): Promise<SnapshotKey> {
  const raw = b64urlToBytes(b64url);
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: KEY_LEN },
    true,
    ["encrypt", "decrypt"],
  );
}

// --- encrypt / decrypt the snapshot bytes ----------------------------------

/**
 * Encrypt snapshot bytes (a `Y.encodeStateAsUpdate` result). Returns
 * `IV || ciphertext` as a single Uint8Array, ready to `overwriteFile` as the
 * `.bin` resource.
 */
export async function encryptBytes(
  key: SnapshotKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/**
 * Decrypt an `IV || ciphertext` blob produced by `encryptBytes`. Throws if the
 * key is wrong or the bytes were tampered with (GCM auth tag fails).
 */
export async function decryptBytes(
  key: SnapshotKey,
  ivAndCiphertext: Uint8Array,
): Promise<Uint8Array> {
  if (ivAndCiphertext.length <= IV_LEN) {
    throw new Error("Ciphertext too short — not a valid encrypted snapshot.");
  }
  const iv = ivAndCiphertext.subarray(0, IV_LEN);
  const ciphertext = ivAndCiphertext.subarray(IV_LEN);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("Wrong key, or the snapshot has been tampered with.");
  }
}
