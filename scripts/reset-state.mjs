#!/usr/bin/env node
// Clears the results before a new group: state/players.json, state/attempts.json and site/data/leaderboard.json.
// Makes a copy in archive/<date>/ first (local; decide yourself whether to commit it).
//   node scripts/reset-state.mjs            preview
//   node scripts/reset-state.mjs --apply    do it
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyState, buildLeaderboard } from "../.github/scripts/verify-flag.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const files = ["state/players.json", "state/attempts.json", "site/data/leaderboard.json"];
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const archive = path.join(ROOT, "archive", stamp);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "site/config.json"), "utf8"));

console.log(`${apply ? "Reset" : "Reset preview"}: ${files.join(", ")}`);
console.log(`Backup: ${path.relative(ROOT, archive)}/`);
if (!apply) { console.log("Run with --apply to do it."); process.exit(0); }

fs.mkdirSync(archive, { recursive: true });
for (const f of files) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(archive, path.basename(f)));
const s = emptyState();
fs.writeFileSync(path.join(ROOT, "state/players.json"), JSON.stringify(s.players, null, 2) + "\n");
fs.writeFileSync(path.join(ROOT, "state/attempts.json"), JSON.stringify(s.attempts, null, 2) + "\n");
const lb = buildLeaderboard(s, config); lb.generatedAt = null;
fs.writeFileSync(path.join(ROOT, "site/data/leaderboard.json"), JSON.stringify(lb, null, 2) + "\n");
console.log("Done. Now: git add state site/data && git commit -m \"Reset leaderboard\" && git push");
