#!/usr/bin/env node
// Stores the answers as the ANSWERS repository secret (JSON {"m1":"...", ...}, already normalized).
//
//   node scripts/set-answers.mjs                 reads answers.local.json (or asks in the terminal), shows the command
//   node scripts/set-answers.mjs --apply         …and actually runs: gh secret set ANSWERS --repo owner/repo
//   --repo=owner/name   defaults to owner/repo from site/config.json
//   --file=PATH         a different answers file
//
// The secret value goes to gh via stdin (it never appears in process arguments or shell history).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MISSION_IDS, normalizeAnswer } from "../.github/scripts/rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "site/config.json"), "utf8"));
const repo = String(args.repo || `${config.owner}/${config.repo}`);
const file = path.resolve(String(args.file || path.join(ROOT, "answers.local.json")));

let raw = {};
if (fs.existsSync(file)) {
  raw = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Answers from: ${path.relative(process.cwd(), file) || file}`);
} else if (process.stdin.isTTY) {
  console.log(`No ${path.basename(file)}. Type the answers (they won't be saved to disk):`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (const id of MISSION_IDS) raw[id] = await rl.question(`  ${id}: `);
  rl.close();
} else {
  console.error(`File ${file} not found. Copy answers.example.json to answers.local.json and fill in the real answers.`);
  process.exit(2);
}

const example = JSON.parse(fs.readFileSync(path.join(ROOT, "answers.example.json"), "utf8"));
const answers = {};
const problems = [];
for (const id of MISSION_IDS) {
  const v = normalizeAnswer(raw[id]);
  if (!v) problems.push(`${id}: no answer`);
  else if (v === normalizeAnswer(example[id])) problems.push(`${id}: looks like the placeholder from answers.example.json ("${v}")`);
  answers[id] = v;
}
if (problems.length) { console.error("Fix the answers:\n  " + problems.join("\n  ")); process.exit(1); }
if (/YOUR-ORG/.test(repo)) { console.error("Set owner/repo in site/config.json or pass --repo=owner/name."); process.exit(1); }

const json = JSON.stringify(answers);
console.log(`\nANSWERS secret: ${MISSION_IDS.length} answers, normalized (trimmed, lowercase, no spaces).`);
console.log(`Command:\n  gh secret set ANSWERS --repo ${repo}   (value via stdin)\n`);
if (!args.apply) { console.log("That was a preview. Run with --apply to save the secret."); process.exit(0); }

const r = spawnSync("gh", ["secret", "set", "ANSWERS", "--repo", repo], { input: json, stdio: ["pipe", "inherit", "inherit"] });
if (r.error) { console.error("Could not run gh: " + r.error.message); process.exit(1); }
process.exit(r.status ?? 1);
