// Sealed submissions: the browser encrypts {v, kid, login, mission, answer, hints, nonce, ts} with the
// public key from site/config.json (RSA-OAEP 3072, SHA-256, WebCrypto — see site/seal.js); only the
// verifier, holding the private key from the SUBMIT_PRIVATE_KEY secret, can read it.
//
// Nothing here ever returns, throws or logs plaintext: every failure is a fixed reason code.
// Call sites get the plaintext only through the validated payload, and the onSecret callback is invoked
// right after decryption so main() can mask it (::add-mask::) before anything else happens.
import crypto from "node:crypto";
import { MISSION_IDS, GITHUB_LOGIN_RE } from "./rules.mjs";

export const SEALED_VERSION = 2;
export const SEALED_ALG = "RSA-OAEP-256";
export const MIN_MODULUS_BITS = 3072;
// 3072-bit ciphertext = 384 bytes = 512 base64url chars; leave room for a 4096-bit key.
export const MAX_SEALED_CHARS = 1024;
export const MAX_FUTURE_MS = 10 * 60 * 1000;          // ts more than 10 min in the future -> invalid
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;    // ts older than 7 days -> invalid (and nonces pruned)
export const MAX_ANSWER_CHARS = 200;
const PAYLOAD_KEYS = ["answer", "hints", "kid", "login", "mission", "nonce", "ts", "v"];
const KID_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Key id = first 16 hex chars of sha256(SPKI DER). Same value gen-keys.mjs writes to config.json. */
export function keyIdFromSpki(spkiDer) {
  return crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}
export function keyIdOf(key) {
  const pub = key.type === "private" ? crypto.createPublicKey(key) : key;
  return keyIdFromSpki(pub.export({ type: "spki", format: "der" }));
}

/** Parse one private key (PEM). Errors never contain the secret. */
export function parsePrivateKey(pem, name = "SUBMIT_PRIVATE_KEY") {
  let key;
  try { key = crypto.createPrivateKey({ key: String(pem), format: "pem" }); }
  catch (e) { throw new Error(`Secret ${name} is not a valid PEM private key (generate it with: node scripts/gen-keys.mjs).`); }
  const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
  if (key.asymmetricKeyType !== "rsa" || !(bits >= MIN_MODULUS_BITS)) throw new Error(`Secret ${name} must be an RSA key of at least ${MIN_MODULUS_BITS} bits.`);
  return { kid: keyIdOf(key), key, bytes: bits / 8, name };
}

/**
 * Keys from the environment: SUBMIT_PRIVATE_KEY (required) and SUBMIT_PRIVATE_KEY_OLD (optional, kept
 * during a key rotation so submissions sealed with the previous public key still open).
 */
export function loadPrivateKeys(env) {
  const out = [];
  if (!env.SUBMIT_PRIVATE_KEY || !String(env.SUBMIT_PRIVATE_KEY).trim()) {
    throw new Error("Missing secret SUBMIT_PRIVATE_KEY (the private key that decrypts submissions). Set it with: node scripts/gen-keys.mjs --apply.");
  }
  out.push(parsePrivateKey(env.SUBMIT_PRIVATE_KEY, "SUBMIT_PRIVATE_KEY"));
  if (env.SUBMIT_PRIVATE_KEY_OLD && String(env.SUBMIT_PRIVATE_KEY_OLD).trim()) {
    const old = parsePrivateKey(env.SUBMIT_PRIVATE_KEY_OLD, "SUBMIT_PRIVATE_KEY_OLD");
    if (old.kid !== out[0].kid) out.push(old);
  }
  return out;
}

/** Split a value into lines worth masking (the runner masks line by line). */
export function maskableParts(value) {
  return String(value == null ? "" : value).split(/\r\n|\r|\n/).map(v => v.trim()).filter(Boolean);
}

/**
 * Decrypt and validate a sealed submission.
 * Returns { ok: true, payload, kid } or { ok: false, reason } with reason one of
 * sealed-missing | sealed-format | sealed-decrypt | sealed-garbled | sealed-schema | sealed-kid.
 * `onSecret(string)` is called synchronously right after decryption with the plaintext and the answer.
 */
export function openSealed(sealed, keys, { maxHints = 2, onSecret = () => {} } = {}) {
  const s = String(sealed == null ? "" : sealed).trim();
  if (!s) return { ok: false, reason: "sealed-missing" };
  if (s.length > MAX_SEALED_CHARS || !/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false, reason: "sealed-format" };
  const buf = Buffer.from(s, "base64url");
  // canonical encoding only: Node silently drops trailing junk bits/chars ("<blob>A" would decode to the
  // same ciphertext), so one ciphertext must have exactly one accepted spelling
  if (buf.toString("base64url") !== s) return { ok: false, reason: "sealed-format" };
  let plain = null, used = null;
  for (const k of keys || []) {
    if (buf.length !== k.bytes) continue;       // wrong size for this key: not even an attempt
    try {
      plain = crypto.privateDecrypt({ key: k.key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, buf);
      used = k; break;
    } catch (e) { plain = null; /* message intentionally dropped */ }
  }
  if (!plain) return { ok: false, reason: (keys || []).some(k => k.bytes === buf.length) ? "sealed-decrypt" : "sealed-format" };
  let text = null;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(plain); } catch (e) { text = null; }
  if (text !== null) onSecret(text);
  if (text === null || text.length > 1024) return { ok: false, reason: "sealed-garbled" };
  let p;
  try { p = JSON.parse(text); } catch (e) { return { ok: false, reason: "sealed-garbled" }; } // JSON errors quote the input
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, reason: "sealed-garbled" };
  if (typeof p.answer === "string") onSecret(p.answer);
  const keysOk = Object.keys(p).sort().join(",") === PAYLOAD_KEYS.join(",");
  const valid = keysOk && p.v === SEALED_VERSION &&
    typeof p.kid === "string" && KID_RE.test(p.kid) &&
    typeof p.login === "string" && GITHUB_LOGIN_RE.test(p.login) && p.login === p.login.toLowerCase() &&
    typeof p.mission === "string" && MISSION_IDS.includes(p.mission) &&
    typeof p.answer === "string" && p.answer.length >= 1 && p.answer.length <= MAX_ANSWER_CHARS &&
    Number.isInteger(p.hints) && p.hints >= 0 && p.hints <= maxHints &&
    typeof p.nonce === "string" && NONCE_RE.test(p.nonce) &&
    typeof p.ts === "string" && ISO_RE.test(p.ts) && Number.isFinite(Date.parse(p.ts)) &&
    new Date(Date.parse(p.ts)).toISOString().slice(0, 19) === p.ts.slice(0, 19); // real calendar date (no Feb 30)
  if (!valid) return { ok: false, reason: "sealed-schema" };
  if (p.kid !== used.kid) return { ok: false, reason: "sealed-kid" };
  return { ok: true, kid: used.kid, payload: { login: p.login, mission: p.mission, answer: p.answer, hints: p.hints, nonce: p.nonce, ts: new Date(Date.parse(p.ts)).toISOString() } };
}

/** Node-side sealing (tests, simulate.mjs, preview --sample). The browser uses site/seal.js (WebCrypto). */
export function sealWithPublicKey(publicKey, payload) {
  const key = typeof publicKey === "string" ? crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }) : publicKey;
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(JSON.stringify(payload), "utf8")).toString("base64url");
}

/** Generate a keypair and the public `submitKey` object for site/config.json. */
export function generateSubmitKeyPair(bits = MIN_MODULUS_BITS) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 0x10001 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey, publicKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    submitKey: { kid: keyIdFromSpki(spki), alg: SEALED_ALG, spki: spki.toString("base64") }
  };
}

/** Public key object (from config.json) -> its kid, or null when malformed / not RSA >= 3072. */
export function submitKeyId(submitKey) {
  try {
    if (!submitKey || submitKey.alg !== SEALED_ALG || typeof submitKey.spki !== "string") return null;
    const key = crypto.createPublicKey({ key: Buffer.from(submitKey.spki, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa" || !(key.asymmetricKeyDetails.modulusLength >= MIN_MODULUS_BITS)) return null;
    return keyIdOf(key);
  } catch (e) { return null; }
}
