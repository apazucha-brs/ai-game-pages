#!/usr/bin/env node
// Local preview of site/ (zero dependencies): http://localhost:4100
//
//   node scripts/preview.mjs                    serve site/ as-is (data/leaderboard.json from the repo)
//   node scripts/preview.mjs --sample           serve a generated sample leaderboard instead
//   node scripts/preview.mjs --board=FILE       serve FILE as data/leaderboard.json (re-read on every request)
//   node scripts/preview.mjs --owner=org --repo=name   override owner/repo in config.json (to try "Submit flag")
//   node scripts/preview.mjs --key=FILE.pem     serve the public key of FILE.pem as submitKey (FILE is created with a
//                                               fresh 3072-bit keypair if missing) — lets you decrypt what the page seals
//   --port=4100
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { processIssue, buildLeaderboard, emptyState } from "../.github/scripts/verify-flag.mjs";
import { MISSION_IDS } from "../.github/scripts/rules.mjs";
import { generateSubmitKeyPair, parsePrivateKey, sealWithPublicKey, keyIdOf } from "../.github/scripts/sealed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const PORT = Number(args.port || process.env.PORT || 4100);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/** A plausible leaderboard built with the real verifier (fake answers, fake issues, throwaway keypair). */
export function sampleLeaderboard(config) {
  const answers = Object.fromEntries(MISSION_IDS.map(id => [id, "sample-" + id]));
  const pair = generateSubmitKeyPair(3072);
  const keys = [parsePrivateKey(pair.privatePem)];
  const state = emptyState();
  const people = [
    ["octocat", "Backend", ["m1", "m2", "m3", "m4", "m5", "m6"], 0], ["qa-kate", "QA", ["m1", "m2", "m5"], 1],
    ["devops-dan", "Platform", ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"], 0], ["frontend-olivia", "Frontend", ["m1", "m8"], 2],
    ["data-pete", "Data", ["m1"], 0], ["new-player", "Backend", [], 0]
  ];
  let n = 1, t = Date.parse("2026-10-08T08:00:00Z");
  const body = (m, sealed, hints, team, login) => `### Mission\n\n${m}\n\n### Encrypted submission (do not edit)\n\n${sealed}\n\n### Hints revealed\n\n${hints}\n\n### Team\n\n${team}\n\n### GitHub login typed on the site\n\n${login}`;
  for (const [login, team, solved, hints] of people) {
    const ms = solved.length ? solved : ["m1"];
    for (const m of ms) {
      const answer = solved.length ? answers[m] : "wrong-answer";
      const now = new Date(t += 7 * 60 * 1000);
      const sealed = sealWithPublicKey(pair.publicKey, { v: 2, kid: pair.submitKey.kid, login, mission: m, answer, hints, nonce: crypto.randomBytes(16).toString("hex"), ts: now.toISOString() });
      processIssue({ issue: { number: n++, title: `[flag] ${m}`, labels: [{ name: "flag" }], user: { login, type: "User" }, body: body(m, sealed, hints, team, login) },
        answers, keys, config, state, now });
    }
  }
  return buildLeaderboard(state, config, new Date(t));
}

/** --key=FILE.pem: public submitKey derived from that private key (generated on first use). */
function devSubmitKey(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, generateSubmitKeyPair(3072).privatePem, { mode: 0o600 });
  const { key } = parsePrivateKey(fs.readFileSync(file, "utf8"), file);
  return { kid: keyIdOf(key), alg: "RSA-OAEP-256", spki: crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") };
}
const DEV_KEY = args.key ? devSubmitKey(path.resolve(String(args.key))) : null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const send = (status, type, data) => { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(data); };
  try {
    if (rel === "/config.json" && (args.owner || args.repo || DEV_KEY)) {
      const cfg = JSON.parse(fs.readFileSync(path.join(SITE, "config.json"), "utf8"));
      if (args.owner) cfg.owner = args.owner;
      if (args.repo) cfg.repo = args.repo;
      if (DEV_KEY) cfg.submitKey = DEV_KEY;
      return send(200, TYPES[".json"], JSON.stringify(cfg));
    }
    if (rel === "/data/leaderboard.json" && args.board) {
      if (!fs.existsSync(args.board)) return send(404, "text/plain", "not found");
      return send(200, TYPES[".json"], fs.readFileSync(args.board));
    }
    if (rel === "/data/leaderboard.json" && args.sample) {
      const cfg = JSON.parse(fs.readFileSync(path.join(SITE, "config.json"), "utf8"));
      return send(200, TYPES[".json"], JSON.stringify(sampleLeaderboard(cfg), null, 2));
    }
    const file = path.normalize(path.join(SITE, rel));
    if (!file.startsWith(SITE + path.sep)) return send(403, "text/plain", "forbidden");
    if (/\.(pem|key)$/i.test(file) || /(^|[\\/])\./.test(path.relative(SITE, file))) return send(403, "text/plain", "forbidden"); // never serve keys / dotfiles
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, "text/plain", "not found");
    send(200, TYPES[path.extname(file)] || "application/octet-stream", fs.readFileSync(file));
  } catch (e) { send(500, "text/plain", String(e.message)); }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Agent Academy (preview): http://localhost:${PORT}`);
    if (args.sample) console.log("Leaderboard: sample data (--sample).");
    if (args.board) console.log(`Leaderboard: ${args.board} (re-read on every request).`);
    if (DEV_KEY) console.log(`Submission key: ${args.key} (kid ${DEV_KEY.kid}), for local testing only.`);
    console.log("Press Ctrl+C to stop.");
  });
}
