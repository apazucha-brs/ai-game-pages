import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseIssueBody, processIssue, buildLeaderboard, emptyState, commentFor, validateAnswers, isFlagIssue, main, FIELD_LABELS
} from "../.github/scripts/verify-flag.mjs";
import { createRules } from "../.github/scripts/rules.mjs";
import { CONFIG, ANSWERS, NORMALIZED, ROOT, KEYS, PRIVATE_PEM, issue, body, at, payload, seal } from "./helpers.mjs";

const T0 = "2026-10-08T09:00:00.000Z";
const run = (state, i, now = T0) => processIssue({ issue: i, answers: NORMALIZED, keys: KEYS, config: CONFIG, state, now: new Date(now) });

describe("parseIssueBody", () => {
  test("parses a standard issue-form body", () => {
    const sealed = "Ab-_".repeat(128);
    const f = parseIssueBody(body({ mission: "m3", sealed, hints: "1", team: "Data", login: "alice" }));
    assert.deepEqual(f, { mission: "m3", sealed, hints: "1", team: "Data", login: "alice" });
  });
  test("CRLF, extra whitespace, _No response_, unknown headings, code fences", () => {
    const raw = "\r\n###   Mission  \r\n\r\n\r\n   M2   \r\n\r\n### Something else\r\n\r\nxx\r\n\r\n### Encrypted submission (do not edit)\r\n\r\n```\r\n" + "CD".repeat(300) +
      "\r\n```\r\n\r\n### Hints revealed\r\n\r\n 2 \r\n\r\n### Team\r\n\r\n  QA  \r\n\r\n### GitHub login typed on the site\r\n\r\n_No response_\r\n";
    const f = parseIssueBody(raw);
    assert.equal(f.mission, "M2");
    assert.equal(f.sealed, "CD".repeat(300), "sealed is not cut at 200 chars like the other fields");
    assert.equal(f.hints, "2");
    assert.equal(f.team, "QA");
    assert.equal(f.login, "");
  });
  test("heading matching ignores diacritics/case; first occurrence wins; empty body is safe", () => {
    const f = parseIssueBody("### missíon\n\nm1\n\n### ENCRYPTED SUBMISSION (DO NOT EDIT)\n\nabc\n\n### Mission\n\nm8");
    assert.equal(f.mission, "m1"); assert.equal(f.sealed, "abc");
    assert.deepEqual(parseIssueBody(""), {}); assert.deepEqual(parseIssueBody(null), {});
  });
  test("labels in the issue template match the parser", () => {
    const yml = fs.readFileSync(path.join(ROOT, ".github/ISSUE_TEMPLATE/flag.yml"), "utf8");
    for (const [id, label] of Object.entries(FIELD_LABELS)) {
      const re = new RegExp(`id: ${id}\\s*\\n\\s*attributes:\\s*\\n\\s*label: "${label.replace(/[()]/g, "\\$&")}"`);
      assert.match(yml, re, `field ${id} must have label "${label}"`);
    }
    assert.match(yml, /labels: \["flag"\]/);
    assert.match(yml, /title: "\[flag\] "/);
  });
});

describe("processIssue", () => {
  test("correct answer: XP, level, badges, lastResults", () => {
    const s = emptyState();
    const r = run(s, issue({ author: "Alice", mission: "m1" }));
    assert.equal(r.status, "correct"); assert.equal(r.xpAwarded, 100); assert.equal(r.xp, 100);
    assert.deepEqual(r.newBadges, ["first", "clean"]);
    assert.equal(s.players.players.alice.login, "Alice");
    assert.equal(s.players.lastResults.alice.m1.status, "correct");
  });
  test("wrong answer is recorded, no XP", () => {
    const s = emptyState();
    const r = run(s, issue({ mission: "m6", answer: "ORD-12354" }));
    assert.equal(r.status, "wrong"); assert.equal(r.attemptsLeft, 4);
    assert.equal(s.players.players.alice.xp, 0);
    assert.equal(s.players.lastResults.alice.m6.status, "wrong");
  });
  test("answer normalization: messy casing/whitespace is still correct", () => {
    const s = emptyState();
    assert.equal(run(s, issue({ mission: "m2", answer: "  acad - tst - 1a2b \n" })).status, "correct");
  });
  test("sealed blob copied from another login is rejected (replay by another user)", () => {
    const s = emptyState();
    const aliceSealed = seal(payload({ login: "alice", mission: "m8" }));
    // Bob copies Alice's sealed field but keeps his own login in the form -> invalid (sealed for alice)
    const r1 = run(s, issue({ author: "bob", mission: "m8", sealed: aliceSealed, login: "bob" }));
    assert.equal(r1.status, "invalid"); assert.equal(r1.reason, "sealed-login");
    // Bob copies Alice's whole issue (login field "alice") -> invalid, typed login does not match the author
    const r = run(s, issue({ author: "bob", mission: "m8", sealed: aliceSealed, login: "alice" }));
    assert.equal(r.status, "invalid"); assert.equal(r.reason, "login");
    // Bob with the login field emptied -> still invalid
    const r3 = run(s, issue({ author: "bob", mission: "m8", rawBody: body({ mission: "m8", sealed: aliceSealed, team: "QA" }) }));
    assert.equal(r3.status, "invalid"); assert.equal(r3.reason, "sealed-login");
    assert.equal(s.players.players.bob, undefined);
    // ...and Alice can still use her own blob afterwards (Bob's attempts did not burn her nonce)
    assert.equal(run(s, issue({ author: "alice", mission: "m8", sealed: aliceSealed })).status, "correct");
  });
  test("same author replaying their own blob: second use rejected as replay, XP unchanged", () => {
    const s = emptyState();
    const blob = seal(payload({ login: "alice", mission: "m2" }));
    assert.equal(run(s, issue({ mission: "m2", sealed: blob })).xpAwarded, 150);
    const again = run(s, issue({ mission: "m2", sealed: blob }), at(T0, 1));
    assert.equal(again.status, "invalid"); assert.equal(again.reason, "sealed-replay");
    assert.equal(s.players.players.alice.xp, 150);
    // a replayed WRONG answer cannot be used to burn attempts twice either
    const wrong = seal(payload({ login: "alice", mission: "m3", answer: "nope" }));
    assert.equal(run(s, issue({ mission: "m3", sealed: wrong }), at(T0, 2)).status, "wrong");
    assert.equal(run(s, issue({ mission: "m3", sealed: wrong }), at(T0, 3)).reason, "sealed-replay");
  });
  test("visible fields must agree with the decrypted payload", () => {
    const s = emptyState();
    const cases = [
      [{ mission: "m1", sealedPayload: payload({ mission: "m8" }) }, "mismatch"],                 // claims m1, sealed m8
      [{ mission: "m8", hints: 0, sealedPayload: payload({ mission: "m8", hints: 2 }) }, "mismatch"],
      [{ mission: "m8", hints: 2, sealedPayload: payload({ mission: "m8", hints: 0 }) }, "mismatch"], // fewer hints sealed
      [{ mission: "m1", login: "alice", sealedPayload: payload({ login: "bob" }) }, "sealed-login"]
    ];
    for (const [opts, reason] of cases) {
      const r = run(s, issue(opts));
      assert.equal(r.status, "invalid", JSON.stringify(opts)); assert.equal(r.reason, reason);
    }
    assert.equal(s.players.players.alice, undefined);
  });
  test("ts sanity: max 10 min in the future, max 7 days old", () => {
    const s = emptyState();
    const ok = (ts, now) => run(s, issue({ mission: "m1", ts }), now);
    assert.equal(ok(at(T0, 11).toISOString(), T0).reason, "sealed-ts", "11 min in the future");
    assert.equal(ok(at(T0, -(7 * 24 * 60 + 1)).toISOString(), T0).reason, "sealed-ts", "older than 7 days");
    assert.equal(ok(at(T0, 9).toISOString(), T0).status, "correct", "9 min clock skew is fine");
    assert.equal(run(s, issue({ mission: "m2", ts: at(T0, -(6 * 24 * 60)).toISOString() }), T0).status, "correct", "6 days old is fine");
  });
  test("login typed with different case/@ is accepted", () => {
    const s = emptyState();
    assert.equal(run(s, issue({ author: "Alice", mission: "m1", login: "@ALICE" })).status, "correct");
  });
  test("idempotent: re-solving does not change XP; the same issue is never processed twice", () => {
    const s = emptyState();
    const i1 = issue({ mission: "m4" });
    assert.equal(run(s, i1).xpAwarded, 250);
    const again = run(s, issue({ mission: "m4" }), at(T0, 1));
    assert.equal(again.status, "correct"); assert.equal(again.alreadySolved, true); assert.equal(again.xpAwarded, 0);
    assert.equal(s.players.players.alice.xp, 250);
    const dup = run(s, i1, at(T0, 2));
    assert.equal(dup.status, "ignored"); assert.equal(dup.reason, "already-processed");
    // wrong answer after a solve keeps it solved (still reported as already solved)
    assert.equal(run(s, issue({ mission: "m4", answer: "nope" }), at(T0, 3)).alreadySolved, true);
    assert.equal(s.players.players.alice.xp, 250);
  });
  test("hints reduce XP by 20 each; XP never below 0", () => {
    const s = emptyState();
    assert.equal(run(s, issue({ mission: "m1", hints: 2 })).xpAwarded, 60);
    assert.equal(run(s, issue({ mission: "m2", hints: 1 })).xpAwarded, 130);
    const cfg = { ...CONFIG, missions: CONFIG.missions.map(m => m.id === "m3" ? { ...m, xp: 30 } : m) };
    const r = processIssue({ issue: issue({ mission: "m3", hints: 2 }), answers: NORMALIZED, keys: KEYS, config: cfg, state: s, now: new Date(T0) });
    assert.equal(r.xpAwarded, 0);
    assert.equal(s.players.players.alice.xp, 190);
    assert.ok(!s.players.players.alice.badges.includes("clean"), "no clean badge when every solve used hints (m3 used 2)");
  });
  test("invalid: mission, sealed, hints, team", () => {
    const s = emptyState();
    const p = seal(payload({ login: "alice", mission: "m1" }));
    const flip = p.slice(0, 100) + (p[100] === "A" ? "B" : "A") + p.slice(101);
    const cases = [
      [{ rawBody: body({ mission: "m9", sealed: p }) }, "mission"],
      [{ rawBody: body({ mission: "", sealed: p }) }, "mission"],
      [{ rawBody: body({ mission: "m1", sealed: "" }) }, "sealed-missing"],
      [{ rawBody: body({ mission: "m1", sealed: p.slice(4) }) }, "sealed-format"],      // wrong length
      [{ rawBody: body({ mission: "m1", sealed: p + "AAAA" }) }, "sealed-format"],
      [{ rawBody: body({ mission: "m1", sealed: p.replace(/^./, "+") }) }, "sealed-format"], // not base64url
      [{ rawBody: body({ mission: "m1", sealed: "A".repeat(2000) }) }, "sealed-format"],  // oversized
      [{ rawBody: body({ mission: "m1", sealed: flip }) }, "sealed-decrypt"],           // garbled ciphertext
      [{ rawBody: body({ mission: "m1", sealed: p, hints: "3" }) }, "hints"],
      [{ rawBody: body({ mission: "m1", sealed: p, hints: "-1" }) }, "hints"],
      [{ rawBody: body({ mission: "m1", sealed: p, hints: "1.5" }) }, "hints"],
      [{ rawBody: body({ mission: "m1", sealed: p, hints: "_No response_" }) }, "hints"],
      [{ rawBody: body({ mission: "m1", sealed: p, team: "Marketing" }) }, "team"],
      [{ rawBody: "plain text without a form" }, "mission"]
    ];
    for (const [opts, reason] of cases) {
      const r = run(s, issue(opts));
      assert.equal(r.status, "invalid", JSON.stringify(opts)); assert.equal(r.reason, reason);
    }
    assert.equal(s.players.players.alice, undefined, "invalid submissions do not create a player");
    assert.equal(s.players.lastResults.alice._.status, "invalid");
    assert.equal(s.players.lastResults.alice.m1.status, "invalid");
  });
  test("team is case-insensitive and normalized to the configured name; latest team wins", () => {
    const s = emptyState();
    run(s, issue({ mission: "m1", team: "backend" }));
    assert.equal(s.players.players.alice.team, "Backend");
    run(s, issue({ mission: "m2", team: "Data" }));
    assert.equal(s.players.players.alice.team, "Data");
  });
  test("rate limit: 5 wrong per mission per rolling 24h", () => {
    const s = emptyState();
    for (let k = 0; k < 5; k++) assert.equal(run(s, issue({ mission: "m7", answer: String(k) }), at(T0, k)).status, "wrong");
    const lim = run(s, issue({ mission: "m7" }), at(T0, 10));   // even the correct answer is not checked
    assert.equal(lim.status, "limited"); assert.equal(lim.reason, "wrong-per-mission");
    assert.equal(lim.retryAt, at(T0, 24 * 60).toISOString());
    assert.equal(run(s, issue({ mission: "m6" }), at(T0, 11)).status, "correct", "other missions are not blocked");
    assert.equal(run(s, issue({ mission: "m7" }), at(T0, 24 * 60 + 1)).status, "correct", "window rolls after 24h");
  });
  test("rate limit: 30 issues per login per 24h (any outcome)", () => {
    const s = emptyState();
    for (let k = 0; k < 30; k++) run(s, issue({ rawBody: "spam" }), at(T0, k));
    const r = run(s, issue({ mission: "m1" }), at(T0, 31));
    assert.equal(r.status, "limited"); assert.equal(r.reason, "issues-per-day");
    assert.equal(run(s, issue({ author: "carol", mission: "m1" }), at(T0, 32)).status, "correct", "other people unaffected");
    assert.equal(run(s, issue({ mission: "m1" }), at(T0, 24 * 60 + 5)).status, "correct");
  });
  test("bots, non-flag issues and pull requests are ignored without touching state", () => {
    const s = emptyState();
    assert.equal(run(s, issue({ type: "Bot", author: "dependabot[bot]" })).reason, "bot");
    assert.equal(run(s, issue({ labels: [], title: "Pytanie o M3" })).reason, "not-flag");
    assert.equal(isFlagIssue({ title: "[flag] m1", pull_request: {} }), false);
    assert.equal(isFlagIssue({ title: "[FLAG] m1", labels: [] }), true);
    assert.equal(isFlagIssue({ title: "x", labels: ["flag"] }), true);
    assert.deepEqual(s, emptyState());
  });
  test("badges and levels (speed, act1, spotter, boss, full, level thresholds)", () => {
    const s = emptyState();
    let r;
    const order = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
    const levels = [];
    order.forEach((m, k) => { r = run(s, issue({ mission: m }), at(T0, k * 60)); levels.push(r.level); });
    assert.deepEqual(levels, [0, 0, 1, 1, 2, 2, 3, 4]); // 100,250,400,650,850,1100,1350,1850 XP
    assert.equal(r.xp, 1850); assert.equal(r.levelUp, true);
    assert.deepEqual(r.badges, ["first", "clean", "spotter", "act1", "boss", "full"], "no speed: solves 60 min apart");
    const s2 = emptyState();
    run(s2, issue({ author: "dave", mission: "m1", hints: 1 }), T0);
    const r2 = run(s2, issue({ author: "dave", mission: "m2", hints: 1 }), at(T0, 15));
    assert.deepEqual(r2.badges, ["first", "speed"]);
    const rules = createRules(CONFIG);
    assert.equal(rules.levelIndex(299), 0); assert.equal(rules.levelIndex(300), 1); assert.equal(rules.levelIndex(1800), 4);
  });
  test("ANSWERS secret validation", () => {
    assert.throws(() => validateAnswers("not json"), /JSON/);
    assert.throws(() => validateAnswers(JSON.stringify({ ...ANSWERS, m3: "   " })), /m3/);
    assert.throws(() => validateAnswers(JSON.stringify({ m1: "x" })), /m2/);
    assert.deepEqual(validateAnswers(JSON.stringify(ANSWERS)), NORMALIZED);
  });
});

describe("buildLeaderboard", () => {
  test("public summary only: no sealed data, no attempt logs, sorted, team aggregates", () => {
    const s = emptyState();
    run(s, issue({ author: "alice", mission: "m1", team: "QA" }), T0);
    run(s, issue({ author: "alice", mission: "m8", team: "QA" }), at(T0, 1));
    run(s, issue({ author: "bob", mission: "m1", team: "QA" }), at(T0, 2));
    run(s, issue({ author: "carol", mission: "m1", team: "Data" }), at(T0, 3));
    run(s, issue({ author: "dan", mission: "m1", answer: "zle", team: "Data" }), at(T0, 4));
    run(s, issue({ author: "eve", rawBody: "spam" }), at(T0, 5));
    const lb = buildLeaderboard(s, CONFIG, at(T0, 6));
    assert.deepEqual(lb.players.map(p => p.login), ["alice", "bob", "carol", "dan"], "xp desc, then who got there first");
    assert.deepEqual(lb.players[0].solved, { m1: true, m8: true });
    assert.deepEqual(Object.keys(lb.players[0]).sort(), ["badges", "level", "login", "solved", "team", "updatedAt", "xp"]);
    assert.deepEqual(lb.teams, [
      { team: "QA", xp: 700, players: 2, solved: 3, avgXp: 350 },
      { team: "Data", xp: 100, players: 2, solved: 1, avgXp: 50 }
    ]);
    assert.equal(lb.lastResults.dan.m1.status, "wrong");
    assert.equal(lb.lastResults.eve._.status, "invalid");
    assert.deepEqual(Object.keys(lb.lastResults.alice.m8).sort(), ["at", "issue", "status"]);
    const text = JSON.stringify(lb);
    for (const id of Object.keys(ANSWERS)) {
      if (NORMALIZED[id].length > 3) assert.ok(!text.toLowerCase().includes(NORMALIZED[id]), "no answers in leaderboard");
    }
    assert.ok(!/attempt|sealed|nonce|hints/i.test(text), "no attempt details, sealed data, nonces or hints");
  });
});

describe("comments", () => {
  test("English comments for every status", () => {
    const s = emptyState();
    const ok = run(s, issue({ mission: "m1", hints: 1 }));
    assert.match(commentFor(ok, CONFIG), /\+80 XP/); assert.match(commentFor(ok, CONFIG), /level/); assert.match(commentFor(ok, CONFIG), /First Flag/);
    assert.match(commentFor(run(s, issue({ mission: "m2", answer: "x" })), CONFIG), /Not quite/);
    assert.match(commentFor(run(s, issue({ rawBody: "x" })), CONFIG), /can't be checked/);
    for (let k = 0; k < 5; k++) run(s, issue({ mission: "m3", answer: "x" + k }));
    assert.match(commentFor(run(s, issue({ mission: "m3" })), CONFIG), /Too many wrong attempts/);
    assert.match(commentFor(run(s, issue({ mission: "m1" })), CONFIG), /already solved/);
  });
});

describe("main (DRY_RUN, as used by scripts/simulate.mjs)", () => {
  test("processes the event, writes state + leaderboard, makes no API calls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "academy-test-"));
    fs.mkdirSync(path.join(dir, "site"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "site/config.json"), path.join(dir, "site/config.json"));
    const ev = path.join(dir, "event.json");
    fs.writeFileSync(ev, JSON.stringify({ action: "opened", issue: issue({ author: "zoe", mission: "m5" }) }));
    const logs = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("network must not be used in DRY_RUN"); };
    try {
      const { results, changed } = await main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: JSON.stringify(ANSWERS), SUBMIT_PRIVATE_KEY: PRIVATE_PEM, GITHUB_TOKEN: "x", GITHUB_REPOSITORY: "o/r", NOW: T0 }, l => logs.push(l));
      assert.equal(changed, true); assert.equal(results[0].status, "correct");
    } finally { globalThis.fetch = realFetch; }
    const lb = JSON.parse(fs.readFileSync(path.join(dir, "site/data/leaderboard.json"), "utf8"));
    assert.equal(lb.players[0].login, "zoe"); assert.equal(lb.players[0].xp, 200);
    assert.ok(fs.existsSync(path.join(dir, "state/players.json")) && fs.existsSync(path.join(dir, "state/attempts.json")));
    assert.ok(logs.some(l => /dry-run/.test(l)));
    // edited issues are ignored
    fs.writeFileSync(ev, JSON.stringify({ action: "edited", issue: issue({ author: "zoe", mission: "m6" }) }));
    const r2 = await main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: JSON.stringify(ANSWERS), SUBMIT_PRIVATE_KEY: PRIVATE_PEM }, () => {});
    assert.equal(r2.changed, false);
    // missing secrets fail loudly before touching anything
    await assert.rejects(main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: "", SUBMIT_PRIVATE_KEY: PRIVATE_PEM }, () => {}), /ANSWERS/);
    await assert.rejects(main({ DRY_RUN: "1", ROOT: dir, GITHUB_EVENT_PATH: ev, ANSWERS: JSON.stringify(ANSWERS) }, () => {}), /SUBMIT_PRIVATE_KEY/);
  });
});

describe("workflow hygiene", () => {
  test("no ${{ github.event.* }} interpolation inside run: scripts; secrets only as env", () => {
    for (const f of ["flag.yml", "pages.yml"]) {
      const y = fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
      const runBlocks = y.split("\n").filter(l => /^\s*run:/.test(l));
      for (const l of runBlocks) assert.ok(!/\$\{\{/.test(l), `${f}: expression inside run: ${l}`);
      assert.ok(!/\|\s*\n[^\n]*\$\{\{\s*github\.event/.test(y), `${f}: multi-line run with event data`);
    }
    const flag = fs.readFileSync(path.join(ROOT, ".github/workflows/flag.yml"), "utf8");
    assert.match(flag, /types: \[opened\]/);
    assert.match(flag, /group: leaderboard\s*\n\s*cancel-in-progress: false/);
    assert.match(flag, /ANSWERS: \$\{\{ secrets\.ANSWERS \}\}/);
    assert.match(flag, /SUBMIT_PRIVATE_KEY: \$\{\{ secrets\.SUBMIT_PRIVATE_KEY \}\}/);
    assert.match(flag, /SUBMIT_PRIVATE_KEY_OLD: \$\{\{ secrets\.SUBMIT_PRIVATE_KEY_OLD \}\}/);
  });
});
