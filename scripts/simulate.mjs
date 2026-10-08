#!/usr/bin/env node
// Run the real verifier (.github/scripts/verify-flag.mjs) locally against a fake "issues.opened" event,
// with a temporary copy of state/ and NO git / GitHub API calls (DRY_RUN=1). For trainers, no GitHub needed.
// The answer is sealed with the real browser code (site/seal.js, WebCrypto) and opened by the verifier.
//
//   node scripts/simulate.mjs --login=octocat --mission=m7 --answer=123 [--hints=0] [--team=QA]
//        [--author=octocat]       issue author (default: --login). A different value = someone else's blob replayed.
//        [--sealed=<base64url>]   send this sealed value instead of sealing --answer (e.g. a blob from another run)
//        [--form-login=X]         visible "login" field (default: --login; "" = empty), to test tampered forms
//        [--state=DIR]            keep state in DIR between runs (default: fresh temp dir)
//        [--answers=FILE]         expected answers (default: answers.local.json, else answers.example.json)
//        [--key=PEM]              private key (default: keys.local.pem if it matches config.json, else a temp keypair)
//        [--bot]                  pretend the author is a bot
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../.github/scripts/verify-flag.mjs";
import { generateSubmitKeyPair, parsePrivateKey, submitKeyId, keyIdOf } from "../.github/scripts/sealed.mjs";
import { sealSubmission } from "../site/seal.js";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const usage = () => { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, a) => a.slice(0, i + 1).every(x => x.startsWith("//"))).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); };
if (args.help || !args.login || !args.mission || (args.answer === undefined && !args.sealed)) { usage(); process.exit(args.help ? 0 : 2); }

const answersFile = args.answers || (fs.existsSync(path.join(ROOT, "answers.local.json")) ? path.join(ROOT, "answers.local.json") : path.join(ROOT, "answers.example.json"));
if (answersFile.endsWith("answers.example.json")) console.log("Note: using answers.example.json (placeholders). Put the real answers in answers.local.json.\n");
const answers = fs.readFileSync(answersFile, "utf8");

const work = args.state ? path.resolve(String(args.state)) : fs.mkdtempSync(path.join(os.tmpdir(), "academy-sim-"));
fs.mkdirSync(path.join(work, "site/data"), { recursive: true });
fs.mkdirSync(path.join(work, "state"), { recursive: true });
for (const f of ["state/players.json", "state/attempts.json"]) if (!fs.existsSync(path.join(work, f))) fs.copyFileSync(path.join(ROOT, f), path.join(work, f));

// Keys: explicit --key, else keys.local.pem when it matches config.json, else a keypair kept in the state dir
// (so blobs from earlier runs with the same --state still open).
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "site/config.json"), "utf8"));
const localPem = path.join(ROOT, "keys.local.pem"), simPem = path.join(work, "sim-key.pem");
let pem, keySource;
if (args.key) { pem = fs.readFileSync(path.resolve(String(args.key)), "utf8"); keySource = String(args.key); }
else if (fs.existsSync(localPem) && submitKeyId(config.submitKey) && parsePrivateKey(fs.readFileSync(localPem, "utf8")).kid === config.submitKey.kid) { pem = fs.readFileSync(localPem, "utf8"); keySource = "keys.local.pem"; }
else if (fs.existsSync(simPem)) { pem = fs.readFileSync(simPem, "utf8"); keySource = "temporary key from the state dir"; }
else { pem = generateSubmitKeyPair(3072).privatePem; fs.writeFileSync(simPem, pem, { mode: 0o600 }); keySource = "new temporary key (no keys.local.pem matching config.json)"; }
const priv = parsePrivateKey(pem, "--key");
const spki = crypto.createPublicKey(priv.key).export({ type: "spki", format: "der" });
config.submitKey = { kid: keyIdOf(priv.key), alg: "RSA-OAEP-256", spki: spki.toString("base64") };
fs.writeFileSync(path.join(work, "site/config.json"), JSON.stringify(config, null, 2) + "\n");

const login = String(args.login), author = String(args.author || login), mission = String(args.mission);
const team = String(args.team || config.teams[0]), hints = String(args.hints ?? 0);
const formLogin = args["form-login"] === undefined ? login : (args["form-login"] === true ? "" : String(args["form-login"]));
const now = args.now ? new Date(String(args.now)) : new Date();
const sealed = args.sealed ? String(args.sealed)
  : await sealSubmission(config.submitKey, { login, missionId: mission, answer: String(args.answer), hints: Number(hints) }, { now });
const seqFile = path.join(work, ".issue-seq");
const number = (fs.existsSync(seqFile) ? Number(fs.readFileSync(seqFile, "utf8")) : 0) + 1;
fs.writeFileSync(seqFile, String(number));
fs.writeFileSync(path.join(work, `sealed-${number}.txt`), sealed + "\n");

const event = {
  action: "opened",
  issue: {
    number, title: `[flag] ${mission} · ${login}`, labels: [{ name: "flag" }],
    user: { login: author, type: args.bot ? "Bot" : "User" },
    body: `### Mission\n\n${mission}\n\n### Encrypted submission (do not edit)\n\n${sealed}\n\n### Hints revealed\n\n${hints}\n\n### Team\n\n${team}\n\n### GitHub login typed on the site\n\n${formLogin || "_No response_"}\n`
  }
};
const eventPath = path.join(work, "event.json");
fs.writeFileSync(eventPath, JSON.stringify(event, null, 2));

console.log(`Simulating issue #${number}: author @${author}, login in the submission ${login}, ${mission}, hints ${hints}, team ${team}`);
console.log(`Key: ${keySource} (kid ${config.submitKey.kid}); encrypted submission: ${sealed.length} chars -> ${path.join(work, `sealed-${number}.txt`)}`);
console.log(`State: ${work}\n`);
const { results } = await main({ ...process.env, DRY_RUN: "1", ROOT: work, GITHUB_EVENT_PATH: eventPath, ANSWERS: answers, SUBMIT_PRIVATE_KEY: pem, SUBMIT_PRIVATE_KEY_OLD: "", NOW: args.now || "" });
const board = JSON.parse(fs.readFileSync(path.join(work, "site/data/leaderboard.json"), "utf8"));
const me = board.players.find(p => p.login.toLowerCase() === author.toLowerCase());
console.log(`\nResult: ${results.map(r => r.status + (r.reason ? ` (${r.reason})` : "")).join(", ") || "none"}`);
if (me) console.log(`Leaderboard: @${me.login} ${me.xp} XP, missions: ${Object.keys(me.solved).join(", ") || "-"}, badges: ${me.badges.join(", ") || "-"}`);
console.log(`Published file: ${path.join(work, "site/data/leaderboard.json")}`);
