// Shared by the browser (site/app.js) and the tests. Zero dependencies, uses Web Crypto
// (window.crypto.subtle in the browser, globalThis.crypto.subtle in Node 22+).
//
// A flag submission is sealed: the payload
//   {v: 2, kid, login (lowercase), mission, answer (normalized), hints, nonce (16 random bytes hex), ts (ISO)}
// is encrypted with RSA-OAEP (SHA-256) using the public key from config.json ("submitKey", written by
// scripts/gen-keys.mjs). Only the GitHub Action holds the private key (secret SUBMIT_PRIVATE_KEY), so the
// ciphertext visible in the issue reveals nothing and cannot be brute-forced offline.
// The verifier (.github/scripts/sealed.mjs) decrypts it; tests/seal.test.mjs checks both ends agree.

export const SEAL_VERSION = 2;
export const SEAL_ALG = "RSA-OAEP-256";
export const MAX_ANSWER_CHARS = 200;

/** trim -> lowercase -> strip ALL whitespace (same as academy/missions.mjs and the verifier). */
export function normalizeAnswer(raw) {
  return String(raw == null ? "" : raw).trim().toLowerCase().replace(/\s+/g, "");
}

/** GitHub logins are case-insensitive; the verifier always compares lowercase logins. */
export function normalizeLogin(raw) {
  return String(raw == null ? "" : raw).trim().replace(/^@/, "").toLowerCase();
}

/** GitHub username rules: 1-39 chars, alphanumerics and single hyphens, no leading/trailing hyphen. */
export function isValidLogin(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/^@/, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s);
}

/** Shape check of config.json "submitKey": {kid: 16 hex, alg: "RSA-OAEP-256", spki: base64 DER}. */
export function isValidSubmitKey(k) {
  return !!k && typeof k === "object" && k.alg === SEAL_ALG && typeof k.kid === "string" && /^[0-9a-f]{16}$/.test(k.kid) &&
    typeof k.spki === "string" && k.spki.length > 300 && k.spki.length < 4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(k.spki);
}

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error("This browser doesn't provide Web Crypto (HTTPS or localhost is required).");
  return s;
};
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

/** Import the public key from config.json for RSA-OAEP / SHA-256 encryption. */
export async function importSubmitKey(submitKey) {
  if (!isValidSubmitKey(submitKey)) throw new Error("No valid public key (submitKey) in config.json.");
  const key = await subtle().importKey("spki", b64ToBytes(submitKey.spki), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  if (!(key.algorithm && key.algorithm.modulusLength >= 3072)) throw new Error("The public key in config.json is too short (RSA 3072 is required).");
  return key;
}

/** The exact object that gets encrypted. */
export function buildPayload({ kid, login, missionId, answer, hints, nonce, ts }) {
  return { v: SEAL_VERSION, kid, login: normalizeLogin(login), mission: missionId, answer: normalizeAnswer(answer), hints: Number(hints), nonce, ts };
}

/**
 * Encrypt a submission. Returns base64url ciphertext (512 chars for a 3072-bit key).
 * opts.cryptoKey: a key from importSubmitKey() (cached by the page); opts.now / opts.nonce: for tests.
 */
export async function sealSubmission(submitKey, { login, missionId, answer, hints }, opts = {}) {
  const key = opts.cryptoKey || await importSubmitKey(submitKey);
  const normalized = normalizeAnswer(answer);
  if (!normalized) throw new Error("Empty answer.");
  if (normalized.length > MAX_ANSWER_CHARS) throw new Error("The answer is too long.");
  const nonce = opts.nonce || toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const ts = new Date(opts.now || Date.now()).toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify(buildPayload({ kid: submitKey.kid, login, missionId, answer, hints, nonce, ts })));
  // RSA-OAEP with SHA-256 fits at most modulusBytes - 2*32 - 2 bytes of plaintext
  if (bytes.length > key.algorithm.modulusLength / 8 - 66) throw new Error("The answer is too long to encrypt. Shorten it: only the letters and digits of the flag count.");
  const ct = await subtle().encrypt({ name: "RSA-OAEP" }, key, bytes);
  return bytesToB64url(new Uint8Array(ct));
}

/**
 * Link to the prefilled issue form (.github/ISSUE_TEMPLATE/flag.yml). Field values are passed as query
 * params named after the form fields' `id`s. The answer is only inside the encrypted `sealed` field.
 */
export function buildIssueUrl(cfg, { missionId, sealed, hints, team, login }) {
  const base = `https://github.com/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/issues/new`;
  const q = new URLSearchParams();
  q.set("template", "flag.yml");
  q.set("title", `[flag] ${missionId} · ${login}`);
  q.set("mission", missionId);
  q.set("sealed", sealed);
  q.set("hints", String(hints));
  q.set("team", team);
  q.set("login", login);
  return `${base}?${q.toString()}`;
}
