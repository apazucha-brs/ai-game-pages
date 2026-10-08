#!/usr/bin/env node
// Generates an RSA-OAEP 3072 (SHA-256) key pair for encrypting flag submissions.
//   * PUBLIC key  -> site/config.json, field "submitKey" {kid, alg, spki} (published on Pages),
//   * PRIVATE key -> keys.local.pem (git-ignored, mode 600) -> secret SUBMIT_PRIVATE_KEY.
//
//   node scripts/gen-keys.mjs                 new pair (or, when keys.local.pem already matches config.json,
//                                             just prints the gh command)
//   node scripts/gen-keys.mjs --apply         …and right away: gh secret set SUBMIT_PRIVATE_KEY --repo owner/repo < keys.local.pem
//   node scripts/gen-keys.mjs --rotate        rotation: keys.local.pem -> keys.old.local.pem (secret SUBMIT_PRIVATE_KEY_OLD),
//                                             new pair in keys.local.pem and config.json
//   --repo=owner/name   defaults to owner/repo from config.json
//   --config=PATH       defaults to site/config.json
//   --out=PATH          defaults to keys.local.pem (the old key during rotation: keys.old.local.pem next to it)
//   --force             overwrite a keys.local.pem that doesn't match config.json (the old key is lost)
//
// The private key goes to gh via stdin (never in process arguments) and is never printed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSubmitKeyPair, parsePrivateKey, submitKeyId, keyIdOf, SEALED_ALG } from "../.github/scripts/sealed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const configPath = path.resolve(String(args.config || path.join(ROOT, "site/config.json")));
const keyPath = path.resolve(String(args.out || path.join(ROOT, "keys.local.pem")));
// *.pem is git-ignored; any other name could end up committed
if (!/\.pem$/i.test(keyPath)) { console.error(`--out must end in .pem (*.pem files are git-ignored): ${keyPath}`); process.exit(1); }
const oldPath = path.join(path.dirname(keyPath), path.basename(keyPath).replace(/\.pem$/, "").replace(/\.local$/, "") + ".old.local.pem");
const rel = p => path.relative(process.cwd(), p) || p;
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

const configText = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(configText);
const repo = String(args.repo || `${config.owner}/${config.repo}`);
const configKid = submitKeyId(config.submitKey);
if (config.submitKey && configKid && configKid !== config.submitKey.kid) die(`config.json: submitKey.kid (${config.submitKey.kid}) doesn't match the key (${configKid}). Generate the keys again with --force.`);

const readKey = p => { try { return parsePrivateKey(fs.readFileSync(p, "utf8"), path.basename(p)); } catch (e) { die(`${rel(p)}: ${e.message}`); } };

/** Replace (or insert) the single-line "submitKey" entry, keeping the rest of config.json as written. */
function writeSubmitKey(submitKey) {
  const line = `"submitKey": ${JSON.stringify(submitKey)}`;
  let text = configText;
  const re = /^([ \t]*)"submitKey"[ \t]*:[ \t]*(?:null|\{[^\n]*\})([ \t]*,?)[ \t]*$/m;
  if (re.test(text)) text = text.replace(re, (_, indent, comma) => indent + line + comma.trim());
  else text = text.replace(/^\{\s*\n/, m => `${m}  ${line},\n`);
  const check = JSON.parse(text);
  if (JSON.stringify(check.submitKey) !== JSON.stringify(submitKey)) die("Could not update config.json (unusual format). Add submitKey by hand.");
  fs.writeFileSync(configPath, text);
}
function writePrivate(p, pem) {
  fs.writeFileSync(p, pem, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}
function generate() {
  const pair = generateSubmitKeyPair(3072);
  if (keyIdOf(pair.privateKey) !== pair.submitKey.kid) die("Internal error: the private and public key kids differ.");
  // self-test: encrypt with the public key exactly like the browser (OAEP/SHA-256) and decrypt
  const probe = crypto.randomBytes(32);
  const ct = crypto.publicEncrypt({ key: pair.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, probe);
  const pt = crypto.privateDecrypt({ key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, ct);
  if (!pt.equals(probe)) die("Internal error: the encryption self-test failed.");
  return pair;
}

const secrets = [];   // [name, file]
if (args.rotate) {
  if (!fs.existsSync(keyPath)) die(`Rotation needs the current key in ${rel(keyPath)}. Without it, generate a new one (without --rotate); submissions encrypted with the old key won't be readable.`);
  const cur = readKey(keyPath);
  if (configKid && cur.kid !== configKid) die(`${rel(keyPath)} (kid ${cur.kid}) doesn't match config.json (kid ${configKid}). Not rotating.`);
  if (fs.existsSync(oldPath) && !args.force) die(`${rel(oldPath)} already exists (previous rotation). If you no longer need it: gh secret delete SUBMIT_PRIVATE_KEY_OLD --repo ${repo} && rm ${rel(oldPath)}, or add --force.`);
  fs.renameSync(keyPath, oldPath);
  fs.chmodSync(oldPath, 0o600);
  const pair = generate();
  writePrivate(keyPath, pair.privatePem);
  writeSubmitKey(pair.submitKey);
  console.log(`Key rotation: old kid ${cur.kid} -> ${rel(oldPath)}, new kid ${pair.submitKey.kid} -> ${rel(keyPath)} and ${rel(configPath)}.`);
  secrets.push(["SUBMIT_PRIVATE_KEY_OLD", oldPath], ["SUBMIT_PRIVATE_KEY", keyPath]);
} else if (fs.existsSync(keyPath) && !args.force) {
  const cur = readKey(keyPath);
  if (cur.kid !== configKid) die(`${rel(keyPath)} (kid ${cur.kid}) doesn't match submitKey in config.json (${configKid || "none"}).\n` +
    "Use --rotate (new pair, the old key stays as SUBMIT_PRIVATE_KEY_OLD) or --force (overwrite, the old key is lost).");
  console.log(`The key already exists and matches config.json (kid ${cur.kid}): ${rel(keyPath)}. Not generating a new one.`);
  secrets.push(["SUBMIT_PRIVATE_KEY", keyPath]);
} else {
  const pair = generate();
  writePrivate(keyPath, pair.privatePem);
  writeSubmitKey(pair.submitKey);
  console.log(`New RSA-OAEP 3072 / SHA-256 key pair (${SEALED_ALG}), kid ${pair.submitKey.kid}.`);
  console.log(`  public key   -> ${rel(configPath)} (field submitKey; commit and publish it)`);
  console.log(`  private key  -> ${rel(keyPath)} (git-ignored; do NOT commit it, keep it somewhere safe)`);
  secrets.push(["SUBMIT_PRIVATE_KEY", keyPath]);
}

const placeholderRepo = /YOUR-ORG/.test(repo);
console.log("\nSet the repository secret(s):");
for (const [name, file] of secrets) console.log(`  gh secret set ${name} --repo ${repo} < ${rel(file)}`);
if (args.rotate) {
  console.log("\nRotation order: both secrets first, then commit + push config.json (the site starts encrypting with the new key).");
  console.log(`After a few days (once no open issues use the old key): gh secret delete SUBMIT_PRIVATE_KEY_OLD --repo ${repo} && rm ${rel(oldPath)}`);
} else {
  console.log("Then commit + push site/config.json (the pages.yml workflow publishes the site with the public key).");
}
if (!args.apply) { console.log("\nThat was a preview of the commands. Run with --apply to have gh set the secret(s)."); process.exit(0); }
if (placeholderRepo) die("Set owner/repo in site/config.json or pass --repo=owner/name.");

for (const [name, file] of secrets) {
  const r = spawnSync("gh", ["secret", "set", name, "--repo", repo], { input: fs.readFileSync(file), stdio: ["pipe", "inherit", "inherit"] });
  if (r.error) die("Could not run gh: " + r.error.message);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log("Done.");
