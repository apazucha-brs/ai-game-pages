import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateSubmitKeyPair, parsePrivateKey, sealWithPublicKey } from "../.github/scripts/sealed.mjs";
import { normalizeAnswer } from "../.github/scripts/rules.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "site/config.json"), "utf8"));

// Test answers shaped like the real ones. The real answers are NEVER stored in this repository
// (participants can read it). tests/seal.test.mjs additionally uses answers.local.json if present.
export const ANSWERS = {
  m1: "SampleReportRepository", m2: "ACAD-TST-1A2B", m3: "ACAD-TST-3C4D", m4: "ACAD-TST-5E6F",
  m5: "evil-example.invalid", m6: "ORD-12345", m7: "42", m8: "ACAD-BOSS-7G8H"
};
export const NORMALIZED = Object.fromEntries(Object.entries(ANSWERS).map(([k, v]) => [k, v.trim().toLowerCase().replace(/\s+/g, "")]));

// One throwaway keypair per test process (3072-bit generation takes ~0.1-1 s).
export const PAIR = generateSubmitKeyPair(3072);
export const PRIVATE_PEM = PAIR.privatePem;
export const KEYS = [parsePrivateKey(PRIVATE_PEM)];
export const SUBMIT_KEY = PAIR.submitKey;
export const TEST_CONFIG = { ...CONFIG, owner: "acme", repo: "agent-academy", submitKey: SUBMIT_KEY };
export const DEFAULT_TS = "2026-10-08T08:59:00.000Z";

export const nonce = () => crypto.randomBytes(16).toString("hex");

/** Payload exactly as site/seal.js builds it (overridable for attacks). */
export function payload({ login = "alice", mission = "m1", answer, hints = 0, ts = DEFAULT_TS, nonce: n, kid = SUBMIT_KEY.kid, v = 2 } = {}) {
  return { v, kid, login: String(login).toLowerCase().replace(/^@/, ""), mission, answer: normalizeAnswer(answer ?? ANSWERS[mission] ?? "x"), hints, nonce: n || nonce(), ts };
}
export const seal = (p, publicKey = PAIR.publicKey) => sealWithPublicKey(publicKey, p);

let seq = 100;
export function body({ mission = "m1", sealed = "", hints = "0", team = "QA", login = "" } = {}, { crlf = false } = {}) {
  const b = `### Mission\n\n${mission}\n\n### Encrypted submission (do not edit)\n\n${sealed}\n\n### Hints revealed\n\n${hints}\n\n### Team\n\n${team}\n\n### GitHub login typed on the site\n\n${login || "_No response_"}\n`;
  return crlf ? b.replace(/\n/g, "\r\n") : b;
}

/**
 * A flag issue as GitHub would deliver it. By default the sealed payload matches the visible fields
 * and is sealed for `login || author`. Override `sealed` (raw string) or `sealedPayload` (object) to attack.
 */
export function issue({ author = "alice", mission = "m1", answer, sealed, sealedPayload, hints = 0, team = "QA", login, ts, type = "User", labels = [{ name: "flag" }], title, number, rawBody } = {}) {
  const s = sealed ?? seal(sealedPayload ?? payload({ login: login || author, mission, answer, hints: Number(hints) || 0, ts }));
  return {
    number: number ?? ++seq, title: title ?? `[flag] ${mission} · ${author}`, labels,
    user: { login: author, type },
    body: rawBody ?? body({ mission, sealed: s, hints: String(hints), team, login: login ?? author })
  };
}
export const at = (iso, plusMin = 0) => new Date(Date.parse(iso) + plusMin * 60000);
