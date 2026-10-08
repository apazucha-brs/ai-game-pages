// The browser seals with WebCrypto (site/seal.js, globalThis.crypto.subtle); the verifier opens with node:crypto
// (.github/scripts/sealed.mjs). Both ends must agree byte for byte on the payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  sealSubmission, importSubmitKey, isValidSubmitKey, normalizeAnswer, buildIssueUrl, isValidLogin, SEAL_VERSION
} from "../site/seal.js";
import { normalizeAnswer as serverNormalize } from "../.github/scripts/rules.mjs";
import { openSealed, submitKeyId } from "../.github/scripts/sealed.mjs";
import { parseIssueBody, processIssue, emptyState, FIELD_LABELS } from "../.github/scripts/verify-flag.mjs";
import { ANSWERS, NORMALIZED, ROOT, CONFIG, KEYS, PAIR, SUBMIT_KEY, TEST_CONFIG } from "./helpers.mjs";

const T0 = "2026-10-08T09:00:00.000Z";
const messy = a => [a, a.toLowerCase(), a.toUpperCase(), `  ${a}  `, `\t${a}\n`, a.split("").join(" "), ` ${a.slice(0, 2)}  ${a.slice(2)}\r\n`];
const sets = [["sample", ANSWERS]];
const local = process.env.ANSWERS_FILE || path.join(ROOT, "answers.local.json");
if (fs.existsSync(local)) sets.push(["answers.local.json", JSON.parse(fs.readFileSync(local, "utf8"))]);
const decryptRaw = b64u => JSON.parse(crypto.privateDecrypt({ key: PAIR.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(b64u, "base64url")).toString("utf8"));

test("WebCrypto is the one from Node (same API as the browser)", () => {
  assert.equal(typeof globalThis.crypto.subtle.encrypt, "function");
});

for (const [name, answers] of sets) {
  test(`browser-sealed answers open in the verifier and match, messy input (${name})`, async () => {
    const key = await importSubmitKey(SUBMIT_KEY);
    for (const [id, a] of Object.entries(answers)) {
      for (const variant of messy(a)) {
        assert.equal(normalizeAnswer(variant), serverNormalize(a), `${id}: normalization of ${JSON.stringify(variant)}`);
        const sealed = await sealSubmission(SUBMIT_KEY, { login: "  @ALICE ", missionId: id, answer: variant, hints: 1 }, { cryptoKey: key, now: T0 });
        const r = openSealed(sealed, KEYS);
        assert.equal(r.ok, true, `${id}: ${r.reason}`);
        assert.equal(r.payload.answer, serverNormalize(a));
        assert.equal(r.payload.login, "alice", "login is trimmed, @-stripped and lowercased");
        assert.equal(r.payload.mission, id); assert.equal(r.payload.hints, 1);
      }
    }
  });
}

test("payload format: exactly {v, kid, login, mission, answer, hints, nonce, ts}; fresh nonce + ciphertext each time", async () => {
  const a = await sealSubmission(SUBMIT_KEY, { login: "Alice", missionId: "m6", answer: " ord-12345 ", hints: 2 }, { now: T0 });
  const b = await sealSubmission(SUBMIT_KEY, { login: "Alice", missionId: "m6", answer: " ord-12345 ", hints: 2 }, { now: T0 });
  assert.match(a, /^[A-Za-z0-9_-]{512}$/, "3072-bit RSA -> 384 bytes -> 512 base64url chars");
  assert.notEqual(a, b, "OAEP is randomized");
  const pa = decryptRaw(a), pb = decryptRaw(b);
  assert.deepEqual(Object.keys(pa), ["v", "kid", "login", "mission", "answer", "hints", "nonce", "ts"]);
  assert.deepEqual({ ...pa, nonce: "-" }, { v: SEAL_VERSION, kid: SUBMIT_KEY.kid, login: "alice", mission: "m6", answer: "ord-12345", hints: 2, nonce: "-", ts: T0 });
  assert.match(pa.nonce, /^[0-9a-f]{32}$/); assert.notEqual(pa.nonce, pb.nonce);
});

test("too long answers are refused in the browser instead of producing an unreadable blob", async () => {
  await assert.rejects(sealSubmission(SUBMIT_KEY, { login: "alice", missionId: "m1", answer: "x".repeat(180), hints: 0 }), /too long/);
  await assert.rejects(sealSubmission(SUBMIT_KEY, { login: "alice", missionId: "m1", answer: "x".repeat(300), hints: 0 }), /too long/);
  await assert.rejects(sealSubmission(SUBMIT_KEY, { login: "alice", missionId: "m1", answer: "   ", hints: 0 }), /Empty answer/);
  // a long-but-fitting flag still works with the longest possible login
  const ok = await sealSubmission(SUBMIT_KEY, { login: "a".repeat(39), missionId: "m8", answer: "ACAD-" + "X".repeat(80), hints: 2 });
  assert.equal(openSealed(ok, KEYS).ok, true);
});

test("submit key validation: wrong alg / short key / garbage are refused by the page", async () => {
  assert.equal(isValidSubmitKey(SUBMIT_KEY), true);
  for (const bad of [null, {}, { ...SUBMIT_KEY, alg: "RSA-OAEP" }, { ...SUBMIT_KEY, kid: "x" }, { ...SUBMIT_KEY, spki: "%%%" }]) assert.equal(isValidSubmitKey(bad), false);
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const weak = { kid: "0".repeat(16), alg: "RSA-OAEP-256", spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  await assert.rejects(importSubmitKey(weak), /3072/);
});

test("issue URL prefills the form by field id, stays far below URL limits and never contains the answer", async () => {
  const sealed = await sealSubmission(SUBMIT_KEY, { login: "Alice", missionId: "m6", answer: ANSWERS.m6, hints: 1 }, { now: T0 });
  const href = buildIssueUrl(TEST_CONFIG, { missionId: "m6", sealed, hints: 1, team: "QA", login: "Alice" });
  const url = new URL(href);
  assert.ok(href.length < 2000, `URL is ${href.length} chars (GitHub/browsers start failing around 8 KB)`);
  assert.equal(url.origin + url.pathname, "https://github.com/acme/agent-academy/issues/new");
  assert.equal(url.searchParams.get("template"), "flag.yml");
  assert.equal(url.searchParams.get("title"), "[flag] m6 · Alice");
  assert.equal(url.searchParams.get("mission"), "m6");
  assert.equal(url.searchParams.get("sealed"), sealed);
  assert.equal(url.searchParams.get("hints"), "1");
  assert.equal(url.searchParams.get("team"), "QA");
  assert.equal(url.searchParams.get("login"), "Alice");
  assert.equal(url.searchParams.get("proof"), null);
  for (const a of Object.values(NORMALIZED)) if (a.length > 3) assert.ok(!href.toLowerCase().includes(a), "answer in URL");
  // every prefilled param is a field id in the template, with the label the parser expects
  const yml = fs.readFileSync(path.join(ROOT, ".github/ISSUE_TEMPLATE/flag.yml"), "utf8");
  for (const k of ["mission", "sealed", "hints", "team", "login"]) assert.match(yml, new RegExp(`id: ${k}\\n`));
  assert.ok(!/id: proof/.test(yml));
  assert.equal(FIELD_LABELS.sealed, "Encrypted submission (do not edit)");
  // what GitHub renders from those fields parses back and is accepted end to end
  const rendered = `### Mission\n\n${url.searchParams.get("mission")}\n\n### ${FIELD_LABELS.sealed}\n\n${url.searchParams.get("sealed")}\n\n### Hints revealed\n\n1\n\n### Team\n\nQA\n\n### GitHub login typed on the site\n\nAlice`;
  assert.deepEqual(parseIssueBody(rendered), { mission: "m6", sealed, hints: "1", team: "QA", login: "Alice" });
  const r = processIssue({ issue: { number: 7, title: url.searchParams.get("title"), labels: [{ name: "flag" }], user: { login: "Alice", type: "User" }, body: rendered },
    answers: NORMALIZED, keys: KEYS, config: CONFIG, state: emptyState(), now: new Date(T0) });
  assert.equal(r.status, "correct"); assert.equal(r.xpAwarded, 230);
});

test("GitHub login validation", () => {
  for (const ok of ["a", "octocat", "Octo-Cat", "a1-b2-c3", "@octocat", "x".repeat(39)]) assert.ok(isValidLogin(ok), ok);
  for (const bad of ["", "-a", "a-", "a--b", "a b", "a_b", "é", "x".repeat(40), "<script>"]) assert.ok(!isValidLogin(bad), bad);
});

test("site/config.json is consistent with the academy XP table; submitKey is unset or a valid RSA-3072 key with the right kid", () => {
  assert.deepEqual(CONFIG.missions.map(m => m.xp), [100, 150, 150, 250, 200, 250, 250, 500]);
  assert.deepEqual(CONFIG.levels.map(l => l.at), [0, 300, 700, 1200, 1800]);
  assert.equal(CONFIG.hintCost, 20); assert.equal(CONFIG.maxHints, 2);
  assert.ok("submitKey" in CONFIG, "config.json must have a submitKey entry (null until scripts/gen-keys.mjs runs)");
  if (CONFIG.submitKey !== null) {
    assert.ok(isValidSubmitKey(CONFIG.submitKey));
    assert.equal(submitKeyId(CONFIG.submitKey), CONFIG.submitKey.kid, "kid = sha256(spki)[0:16]");
  }
});

test("no proof/sha256-of-answer code path is left", () => {
  const files = ["site/seal.js", "site/app.js", ".github/scripts/verify-flag.mjs", ".github/scripts/rules.mjs", ".github/scripts/sealed.mjs", "scripts/simulate.mjs", "scripts/preview.mjs"];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/computeProof|proofFor|proofsEqual|\bproof\b/.test(t), `${f} still mentions proof`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "site/proof.js")));
  assert.ok(!/digest\(/.test(fs.readFileSync(path.join(ROOT, "site/seal.js"), "utf8")), "the page must not hash answers");
});

test("private keys are git-ignored and never in tracked-looking files", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^keys\.local\.pem$/m); assert.match(gi, /^\*\.pem$/m);
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if ([".git", "node_modules", "archive"].includes(e.name) || e.name.endsWith(".pem")) continue;
    const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p);
  } return out; };
  for (const f of walk(ROOT)) assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fs.readFileSync(f, "utf8")), `${path.relative(ROOT, f)} contains a private key`);
});

test("no real answers anywhere in the published site or repo files", () => {
  // With answers.local.json (or ANSWERS_FILE) present, make sure none of the real answers leaked into tracked files.
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(e.name) || e.name === "answers.local.json" || e.name.endsWith(".pem")) continue;
    const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p);
  } };
  walk(ROOT);
  const all = fs.existsSync(local) ? Object.values(JSON.parse(fs.readFileSync(local, "utf8"))).map(serverNormalize) : [];
  const forbidden = all.filter(a => a.length > 4);
  // short answers (e.g. a number) only in answer-like positions: --answer=X, "X", 'X'
  const shortRes = all.filter(a => a.length <= 4).map(a => new RegExp(`(answer[=:]\\s*|["'\`])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["'\`\\s]|$)`, "i"));
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8").toLowerCase();
    for (const a of forbidden) assert.ok(!t.replace(/\s+/g, "").includes(a), `${path.relative(ROOT, f)} contains a real answer`);
    for (const re of shortRes) assert.ok(!re.test(t), `${path.relative(ROOT, f)} contains a short real answer (${re})`);
  }
});
