#!/usr/bin/env node
// Agent Academy — flag verifier run by .github/workflows/flag.yml (zero npm dependencies, Node 22+).
//
// Security model
//   * Identity = the issue AUTHOR (issue.user.login from the event / REST API), never a form field.
//   * The answer travels only inside "sealed": RSA-OAEP-3072/SHA-256 ciphertext of
//     {v, kid, login, mission, answer, hints, nonce, ts}, made in the browser with the public key from
//     site/config.json. Closed issues therefore reveal nothing that can be brute-forced offline.
//   * Only the decrypted payload is trusted for mission/answer/hints/login. The visible form fields are
//     for humans; if they disagree with the payload the submission is invalid. The payload login must be
//     the issue author (someone else's sealed blob is useless), each nonce is accepted once per login, and
//     ts must be at most 10 min in the future and at most 7 days old.
//   * Decrypted answers are masked (::add-mask::) immediately and never logged, returned or stored.
//   * Issue data reaches this script only through the event file (GITHUB_EVENT_PATH) and the REST API,
//     never through ${{ }} interpolation in the workflow.
//
// Environment
//   ANSWERS            JSON {"m1":"<answer>",...} (repository secret). Required.
//   SUBMIT_PRIVATE_KEY PEM private key (repository secret, scripts/gen-keys.mjs). Required.
//   SUBMIT_PRIVATE_KEY_OLD  previous private key during a rotation (optional).
//   GITHUB_EVENT_PATH  event payload (issues.opened or workflow_dispatch).
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL   REST API access (comments, close, lock, sweep).
//   ROOT               repository root (default: two levels above this file).
//   DRY_RUN=1          no git, no API calls: prints what would happen (used by scripts/simulate.mjs).
//   NOW                ISO timestamp override (tests / simulation).
//   SWEEP=0            do not list other open flag issues (default: sweep when the API is available).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MISSION_IDS, BADGE_NAMES, GITHUB_LOGIN_RE, createRules, normalizeAnswer, normalizeLogin, answersEqual } from "./rules.mjs";
import { openSealed, loadPrivateKeys, maskableParts, MAX_SEALED_CHARS, MAX_FUTURE_MS, MAX_AGE_MS } from "./sealed.mjs";

export { GITHUB_LOGIN_RE };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_ATTEMPTS_MS = 2 * DAY_MS;
// GitHub issue bodies are capped at 65 536 chars; anything above that is not a real issue form.
const MAX_BODY_CHARS = 65536;
// Upper bound of issues handled in one run (spam protection: 3 REST calls per issue, GITHUB_TOKEN ~1000 req/h).
const MAX_ISSUES_PER_RUN = 100;
// Authors not matching GITHUB_LOGIN_RE (rules.mjs) are ignored without touching state.
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/* ------------------------------------------------------------------ parsing */

// Issue-form headings (labels in .github/ISSUE_TEMPLATE/flag.yml) -> field ids.
export const FIELD_LABELS = {
  mission: "Mission",
  sealed: "Encrypted submission (do not edit)",
  hints: "Hints revealed",
  team: "Team",
  login: "GitHub login typed on the site"
};
const fold = s => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const LABEL_TO_FIELD = new Map(Object.entries(FIELD_LABELS).map(([id, label]) => [fold(label), id]));
// tolerate the bare field id as a heading too ("### mission")
Object.keys(FIELD_LABELS).forEach(id => LABEL_TO_FIELD.set(id, id));

/**
 * Parse an issue-form body: "### Label\n\nvalue\n\n### Label 2\n\nvalue 2".
 * Robust to CRLF, extra blank lines/spaces, "_No response_", code fences and unknown headings.
 * Returns only known fields; empty values become "".
 */
export function parseIssueBody(body) {
  const out = {};
  const text = String(body == null ? "" : body).slice(0, MAX_BODY_CHARS).replace(/\r\n?/g, "\n");
  const parts = text.split(/^[ \t]{0,3}#{3}[ \t]+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).replace(/[ \t#]+$/, "").trim();
    const field = LABEL_TO_FIELD.get(fold(heading));
    if (!field || field in out) continue;
    let value = nl === -1 ? "" : part.slice(nl + 1);
    value = value.trim().replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
    if (/^_no response_$/i.test(value)) value = "";
    // "sealed" is ~512 base64url chars; anything longer than the cap is kept just long enough to be rejected
    out[field] = value.slice(0, field === "sealed" ? MAX_SEALED_CHARS + 1 : 200);
  }
  return out;
}

export function isFlagIssue(issue) {
  if (!issue || issue.pull_request) return false;
  const labels = (issue.labels || []).map(l => (typeof l === "string" ? l : l && l.name) || "");
  return labels.includes("flag") || /^\s*\[flag\]/i.test(String(issue.title || ""));
}

/* ------------------------------------------------------------------ state */

export function emptyState() {
  return { players: { version: 1, players: {}, lastResults: {} }, attempts: { version: 2, byLogin: {}, processed: {}, nonces: {} } };
}

export function validateAnswers(raw) {
  let answers;
  try { answers = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch (e) { throw new Error("The ANSWERS secret is not valid JSON."); }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("The ANSWERS secret must be a JSON object {\"m1\": \"...\", ...}.");
  const missing = MISSION_IDS.filter(id => !normalizeAnswer(answers[id]));
  if (missing.length) throw new Error(`The ANSWERS secret has no answer for: ${missing.join(", ")}.`);
  return Object.fromEntries(MISSION_IDS.map(id => [id, normalizeAnswer(answers[id])]));
}

/* ------------------------------------------------------------------ core */

const SEALED_DETAIL = "The \"Encrypted submission\" field is empty, damaged or encrypted with an outdated key. " +
  "Reload the Agent Academy site (Cmd+Shift+R) and submit the flag again with the button.";

/**
 * Evaluate one flag issue and mutate `state`. Pure apart from `state` (and the onSecret callback,
 * called with decrypted plaintext right after decryption so the caller can mask it).
 * `keys` = loadPrivateKeys(env). Returns { status: correct|wrong|limited|invalid|ignored, ... }
 * — never the answer or the decrypted payload.
 */
export function processIssue({ issue, answers, keys, config, state, now = new Date(), onSecret = () => {} }) {
  const rules = createRules(config);
  const nowIso = new Date(now).toISOString(), nowMs = Date.parse(nowIso);
  const user = issue && issue.user;
  if (!issue || !user || !user.login) return { status: "ignored", reason: "no-author" };
  if (user.type === "Bot" || /\[bot\]$/i.test(String(user.login))) return { status: "ignored", reason: "bot" };
  if (!GITHUB_LOGIN_RE.test(String(user.login))) return { status: "ignored", reason: "bad-author" };
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) return { status: "ignored", reason: "bad-number" };
  if (!isFlagIssue(issue)) return { status: "ignored", reason: "not-flag" };
  const number = issue.number;
  if (own(state.attempts.processed, String(number))) return { status: "ignored", reason: "already-processed", issue: number, previous: state.attempts.processed[String(number)] };

  const author = String(user.login), key = normalizeLogin(author);
  const base = { issue: number, login: author };
  const log = state.attempts.byLogin[key] = (own(state.attempts.byLogin, key) && Array.isArray(state.attempts.byLogin[key]) ? state.attempts.byLogin[key] : []).filter(a => nowMs - Date.parse(a.at) < KEEP_ATTEMPTS_MS);
  const inWindow = log.filter(a => nowMs - Date.parse(a.at) < DAY_MS);

  const finish = (result, missionId) => {
    // issues over the daily cap are not added to the log: a spammer cannot grow attempts.json without bound
    if (result.reason !== "issues-per-day") log.push({ at: nowIso, mission: missionId || null, status: result.status, issue: number });
    state.attempts.processed[String(number)] = { status: result.status, at: nowIso, login: key };
    const lr = state.players.lastResults[key] = own(state.players.lastResults, key) ? state.players.lastResults[key] : {};
    lr[missionId && MISSION_IDS.includes(missionId) ? missionId : "_"] = { status: result.status, at: nowIso, issue: number };
    return Object.assign(base, { missionId: missionId || null, at: nowIso }, result);
  };

  // per-login issue limit (all flag issues, whatever their outcome)
  if (inWindow.length >= rules.limits.issuesPerDay) {
    const retryAt = new Date(Date.parse(inWindow[0].at) + DAY_MS).toISOString();
    return finish({ status: "limited", reason: "issues-per-day", retryAt, limit: rules.limits.issuesPerDay });
  }

  const f = parseIssueBody(issue.body);
  const missionId = String(f.mission || "").trim().toLowerCase().replace(/^#/, "");
  const hintsRaw = String(f.hints == null ? "" : f.hints).trim();
  const teamRaw = String(f.team || "").trim();
  const typedLogin = normalizeLogin(f.login || "");

  // visible fields (shown to humans; checked for consistency with the sealed payload below)
  if (!MISSION_IDS.includes(missionId)) return finish({ status: "invalid", reason: "mission", detail: "The \"Mission\" field must be a value from m1 to m8." });
  if (!/^\d+$/.test(hintsRaw) || Number(hintsRaw) > rules.maxHints) return finish({ status: "invalid", reason: "hints", detail: `The "Hints revealed" field must be a whole number from 0 to ${rules.maxHints}.` }, missionId);
  const team = rules.teams.find(t => t.toLowerCase() === teamRaw.toLowerCase());
  if (!team) return finish({ status: "invalid", reason: "team", detail: `Unknown team. Allowed: ${rules.teams.join(", ")}.` }, missionId);
  if (typedLogin && typedLogin !== key) return finish({ status: "invalid", reason: "login", detail: `The login typed on the site was "${typedLogin.replace(/[^a-z0-9-]/g, "")}", but the issue was opened by @${author}. Fix the login on the site (the button with your login in the header) and submit the flag again.` }, missionId);

  // sealed payload: the only source of truth for mission / answer / hints / login
  const opened = openSealed(f.sealed, keys, { maxHints: rules.maxHints, onSecret });
  if (!opened.ok) return finish({ status: "invalid", reason: opened.reason, detail: SEALED_DETAIL }, missionId);
  const sealed = opened.payload;
  if (sealed.login !== key) return finish({ status: "invalid", reason: "sealed-login", detail: `The encrypted submission was prepared for a different login than @${author}, the account that opened the issue. Enter your own GitHub login on the site and submit the flag again.` }, missionId);
  const tsMs = Date.parse(sealed.ts);
  if (tsMs > nowMs + MAX_FUTURE_MS || nowMs - tsMs > MAX_AGE_MS) return finish({ status: "invalid", reason: "sealed-ts", detail: "The submission has an invalid timestamp (in the future or older than 7 days). Check your computer's clock and submit the flag again with the button on the site." }, missionId);
  if (!state.attempts.nonces || typeof state.attempts.nonces !== "object" || Array.isArray(state.attempts.nonces)) state.attempts.nonces = {};
  const nonces = state.attempts.nonces[key] = own(state.attempts.nonces, key) && state.attempts.nonces[key] && typeof state.attempts.nonces[key] === "object" && !Array.isArray(state.attempts.nonces[key]) ? state.attempts.nonces[key] : {};
  if (own(nonces, sealed.nonce)) return finish({ status: "invalid", reason: "sealed-replay", detail: "This encrypted submission has already been used once. Submit the flag again with the button on the site." }, missionId);
  nonces[sealed.nonce] = sealed.ts;
  if (sealed.mission !== missionId || sealed.hints !== Number(hintsRaw) || (typedLogin && typedLogin !== sealed.login)) {
    return finish({ status: "invalid", reason: "mismatch", detail: "The visible fields (mission, hints or login) don't match the encrypted content. Don't change the fields by hand. Submit the flag again with the button on the site." }, missionId);
  }
  const hints = sealed.hints;

  const players = state.players.players;
  const existing = own(players, key) ? players[key] : undefined;
  // idempotent re-solve: an already solved mission never changes XP again
  if (existing && existing.solved[missionId]) {
    existing.team = team; existing.login = author;
    return finish({ status: "correct", alreadySolved: true, xpAwarded: 0, xp: existing.xp, level: rules.levelIndex(existing.xp), newBadges: [], badges: existing.badges }, missionId);
  }

  const wrongHere = inWindow.filter(a => a.mission === missionId && a.status === "wrong");
  if (wrongHere.length >= rules.limits.wrongPerMissionPerDay) {
    const retryAt = new Date(Date.parse(wrongHere[0].at) + DAY_MS).toISOString();
    return finish({ status: "limited", reason: "wrong-per-mission", retryAt, limit: rules.limits.wrongPerMissionPerDay }, missionId);
  }

  const player = existing || (players[key] = { login: author, team, xp: 0, solved: {}, badges: [], createdAt: nowIso, updatedAt: nowIso });
  player.login = author; player.team = team; player.updatedAt = nowIso;

  if (!answersEqual(sealed.answer, answers[missionId])) {
    const left = rules.limits.wrongPerMissionPerDay - wrongHere.length - 1;
    return finish({ status: "wrong", attemptsLeft: Math.max(0, left), xp: player.xp }, missionId);
  }

  const beforeLevel = rules.levelIndex(player.xp), beforeBadges = new Set(player.badges);
  const award = rules.missionAward(missionId, hints);
  player.solved[missionId] = { at: nowIso, xp: award, hints, issue: number };
  player.xp = Object.values(player.solved).reduce((s, x) => s + x.xp, 0);
  player.badges = rules.computeBadges(player);
  const level = rules.levelIndex(player.xp);
  return finish({
    status: "correct", alreadySolved: false, xpAwarded: award, hints, xp: player.xp, level,
    levelUp: level > beforeLevel, newBadges: player.badges.filter(b => !beforeBadges.has(b)), badges: player.badges
  }, missionId);
}

/**
 * Drop attempt entries older than the rate-limit window (+1 day margin) for every login, and used
 * nonces whose ts is older than MAX_AGE_MS (such a payload is rejected by the ts check anyway).
 */
export function pruneAttempts(state, now = new Date()) {
  const nowMs = new Date(now).getTime();
  for (const [login, list] of Object.entries(state.attempts.byLogin)) {
    const kept = Array.isArray(list) ? list.filter(a => a && nowMs - Date.parse(a.at) < KEEP_ATTEMPTS_MS) : [];
    if (kept.length) state.attempts.byLogin[login] = kept; else delete state.attempts.byLogin[login];
  }
  const nonces = state.attempts.nonces && typeof state.attempts.nonces === "object" ? state.attempts.nonces : (state.attempts.nonces = {});
  for (const [login, byNonce] of Object.entries(nonces)) {
    const kept = byNonce && typeof byNonce === "object" && !Array.isArray(byNonce)
      ? Object.entries(byNonce).filter(([, ts]) => nowMs - Date.parse(ts) <= MAX_AGE_MS) : [];
    if (kept.length) nonces[login] = Object.fromEntries(kept); else delete nonces[login];
  }
  return state;
}

/** Public summary published to site/data/leaderboard.json (no sealed data, no attempt logs, no nonces). */
export function buildLeaderboard(state, config, now = new Date()) {
  const rules = createRules(config);
  const lastSolve = p => Math.max(0, ...Object.values(p.solved).map(s => Date.parse(s.at)));
  const list = Object.values(state.players.players).slice().sort((a, b) =>
    b.xp - a.xp || lastSolve(a) - lastSolve(b) || a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
  const players = list.map(p => ({
    login: p.login, team: p.team || "", xp: p.xp, level: rules.levelIndex(p.xp) + 1,
    solved: Object.fromEntries(MISSION_IDS.filter(id => p.solved[id]).map(id => [id, true])),
    badges: p.badges.slice(), updatedAt: p.updatedAt
  }));
  const teamMap = new Map();
  for (const p of players) {
    if (!p.team) continue;
    const t = teamMap.get(p.team) || { team: p.team, xp: 0, players: 0, solved: 0 };
    t.xp += p.xp; t.players += 1; t.solved += Object.keys(p.solved).length;
    teamMap.set(p.team, t);
  }
  const teams = [...teamMap.values()].map(t => ({ ...t, avgXp: Math.round(t.xp / t.players) }))
    .sort((a, b) => b.xp - a.xp || b.avgXp - a.avgXp || a.team.localeCompare(b.team));
  const lastResults = {};
  for (const [login, byMission] of Object.entries(state.players.lastResults)) {
    lastResults[login] = {};
    for (const [mid, r] of Object.entries(byMission)) lastResults[login][mid] = { status: r.status, at: r.at, issue: r.issue };
  }
  return { version: 1, generatedAt: new Date(now).toISOString(), totalPlayers: players.length, maxXp: rules.maxXp, players, teams, lastResults };
}

/* ------------------------------------------------------------------ comments */

const fmtDate = iso => new Date(iso).toLocaleString("en-US", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" }) + " (Europe/Warsaw)";

export function commentFor(r, config) {
  const rules = createRules(config);
  const M = r.missionId ? r.missionId.toUpperCase() : "";
  const lv = Number.isInteger(r.level) ? rules.levels[r.level] : null;
  const foot = "\n\n<sub>Agent Academy · automatic verification. The leaderboard on the site updates in about a minute.</sub>";
  switch (r.status) {
    case "correct": {
      if (r.alreadySolved) return `✅ **You already solved ${M}.** Your XP doesn't change (you have ${r.xp} XP).${foot}`;
      const lines = [`🎉 **Nailed it! ${M} solved: +${r.xpAwarded} XP**${r.hints ? ` (hints: ${r.hints}, −${r.hints * rules.hintCost} XP)` : ""}.`, "",
        `You now have **${r.xp} XP** · level **${r.level + 1}: ${lv ? lv.name : ""}**${r.levelUp ? " · **LEVEL UP!** 🚀" : ""}.`];
      if (r.newBadges && r.newBadges.length) lines.push("", `New badges: ${r.newBadges.map(b => `🏅 **${BADGE_NAMES[b] || b}**`).join(", ")}.`);
      if (r.badges && r.badges.length) lines.push("", `All badges: ${r.badges.map(b => BADGE_NAMES[b] || b).join(", ")}.`);
      return lines.join("\n") + foot;
    }
    case "wrong":
      return `❌ **Not quite: that's not the right answer for ${M}.**\n\n` +
        `Check the spelling (case and spaces don't matter) or reveal a hint on the site.\n\n` +
        `Attempts left for ${M} in the next 24 hours: **${r.attemptsLeft}**.${foot}`;
    case "limited":
      return r.reason === "issues-per-day"
        ? `⏳ **Submission limit reached**: at most ${r.limit} flag submissions per person in 24 hours. This submission was not checked. Try again after ${fmtDate(r.retryAt)}.${foot}`
        : `⏳ **Too many wrong attempts for ${M}** (limit: ${r.limit} in 24 hours). This submission was not checked. ` +
          `You can try again after ${fmtDate(r.retryAt)}. Meanwhile, reveal a hint or ask your trainer.${foot}`;
    case "invalid":
      return `⚠️ **This submission can't be checked.** ${r.detail || ""}\n\n` +
        `Submit flags with the **Submit** button on the Agent Academy site. The site fills in the form for you. ` +
        `Don't change the fields by hand.${foot}`;
    default: return "";
  }
}

/* ------------------------------------------------------------------ I/O */

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); };

export function loadState(root) {
  const s = emptyState();
  const p = readJson(path.join(root, "state/players.json"), null);
  const a = readJson(path.join(root, "state/attempts.json"), null);
  const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  if (p && typeof p === "object") { s.players.players = obj(p.players); s.players.lastResults = obj(p.lastResults); }
  if (a && typeof a === "object") { s.attempts.byLogin = obj(a.byLogin); s.attempts.processed = obj(a.processed); s.attempts.nonces = obj(a.nonces); }
  return s;
}
export function saveState(root, state, config, now) {
  pruneAttempts(state, now);
  writeJson(path.join(root, "state/players.json"), state.players);
  writeJson(path.join(root, "state/attempts.json"), state.attempts);
  writeJson(path.join(root, "site/data/leaderboard.json"), buildLeaderboard(state, config, now));
}

function makeApi(env) {
  const base = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const repo = env.GITHUB_REPOSITORY;
  return async function api(method, p, body) {
    const res = await fetch(`${base}/repos/${repo}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agent-academy-verifier",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok && res.status !== 204) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };
}

async function listOpenFlagIssues(api) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api("GET", `/issues?state=open&sort=created&direction=asc&per_page=100&page=${page}`);
    out.push(...batch.filter(isFlagIssue));
    if (batch.length < 100) break;
  }
  return out;
}

// git (and anything it spawns: hooks, credential helpers) never sees the secrets
const SECRET_ENV = new Set(["ANSWERS", "SUBMIT_PRIVATE_KEY", "SUBMIT_PRIVATE_KEY_OLD"]);
export const gitEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.has(k)));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

let stopToken = null;
export async function main(env = process.env, log = console.log) {
  const root = path.resolve(env.ROOT || path.join(HERE, "..", ".."));
  const dry = env.DRY_RUN === "1" || env.DRY_RUN === "true";
  const inActions = env.GITHUB_ACTIONS === "true" && !dry;
  const now = () => (env.NOW ? new Date(env.NOW) : new Date());
  const config = readJson(path.join(root, "site/config.json"), null);
  if (!config) throw new Error("Missing site/config.json.");
  const answers = validateAnswers(env.ANSWERS);
  const keys = loadPrivateKeys(env);
  const commandsOn = env.GITHUB_ACTIONS === "true";
  if (commandsOn) {
    // Defence in depth: mask every individual answer (the runner masks only the whole secret string) and
    // stop workflow-command processing, so nothing printed below (issue numbers, logins, API errors) can
    // inject ::set-output/::add-mask/::error commands. GITHUB_OUTPUT is a file and is unaffected.
    let raw = {}; try { raw = JSON.parse(env.ANSWERS); } catch (e) { /* validated above */ }
    const masks = new Set([...Object.values(answers), ...Object.values(raw).map(v => String(v).trim())].filter(v => v.length >= 4 && !/[\r\n]/.test(v)));
    for (const v of masks) log(`::add-mask::${v}`);
    stopToken = crypto.randomBytes(16).toString("hex");
    log(`::stop-commands::${stopToken}`);
  }
  // Mask decrypted plaintext right after decryption. While stop-commands is active the runner would
  // ignore ::add-mask::, so: resume commands with the current token, add the masks, stop again with a
  // fresh token. All three lines are printed synchronously, nothing else can be interleaved.
  const onSecret = value => {
    if (!commandsOn) return;
    const parts = [...new Set(maskableParts(value))];
    if (!parts.length) return;
    log(`::${stopToken}::`);
    for (const v of parts) log(`::add-mask::${escapeCommandData(v)}`);
    stopToken = crypto.randomBytes(16).toString("hex");
    log(`::stop-commands::${stopToken}`);
  };
  const event = env.GITHUB_EVENT_PATH ? readJson(env.GITHUB_EVENT_PATH, {}) : {};
  const api = !dry && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY ? makeApi(env) : null;

  // 1. collect issues: the triggering one (only "opened"), plus any open flag issue left behind
  //    (GitHub keeps only one pending run per concurrency group, so a sweep makes sure none is lost).
  const issues = new Map();
  if (event.issue && (!event.action || event.action === "opened")) issues.set(event.issue.number, event.issue);
  if (api && env.SWEEP !== "0") {
    for (const i of await listOpenFlagIssues(api)) if (!issues.has(i.number)) issues.set(i.number, i);
  }
  const queue = [...issues.values()].filter(isFlagIssue).sort((a, b) => a.number - b.number).slice(0, MAX_ISSUES_PER_RUN);
  if (!queue.length) { log("No flag issues to check."); writeOutput(env, false); return { results: [], changed: false }; }

  // 2. evaluate + commit, recomputing from the latest main if the push races with another commit
  let results = [], changed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (inActions) { git(root, "fetch", "--quiet", "origin", env.BRANCH || "main"); git(root, "reset", "--quiet", "--hard", `origin/${env.BRANCH || "main"}`); }
    const state = loadState(root);
    results = queue.map(issue => {
      try { return processIssue({ issue, answers, keys, config, state, now: now(), onSecret }); }
      catch (e) { log(`#${issue.number}: error ${e.message}`); return { status: "ignored", reason: "error", issue: issue.number }; }
    });
    changed = results.some(r => r.status !== "ignored");
    if (!changed) break;
    saveState(root, state, config, now());
    if (!inActions) break;
    git(root, "add", "state/players.json", "state/attempts.json", "site/data/leaderboard.json");
    try { git(root, "diff", "--cached", "--quiet"); changed = false; break; } catch (e) { /* there are staged changes */ }
    git(root, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "--quiet", "-m", `leaderboard: ${results.filter(r => r.status !== "ignored").map(r => `#${r.issue} ${r.status}`).join(", ")}`);
    try { git(root, "push", "--quiet", "origin", `HEAD:${env.BRANCH || "main"}`); break; }
    catch (e) {
      log(`Push failed (attempt ${attempt}/5), fetching the latest state and recomputing…`);
      if (attempt === 5) throw new Error("Could not push the results after 5 attempts: " + e.message);
      await new Promise(r => setTimeout(r, 1000 * attempt + Math.floor(Math.random() * 1000)));
    }
  }

  // 3. comment, close and lock every processed issue
  for (const r of results) {
    if (r.status === "ignored") {
      log(`#${r.issue ?? "?"}: skipped (${r.reason})`);
      // processed earlier but still open (e.g. closing failed last time): just close it
      if (r.reason === "already-processed" && api) {
        try { await api("PATCH", `/issues/${r.issue}`, { state: "closed", state_reason: r.previous.status === "correct" ? "completed" : "not_planned" }); }
        catch (e) { log(`  warning: ${e.message}`); }
      }
      continue;
    }
    const body = commentFor(r, config);
    const reason = r.status === "correct" ? "completed" : "not_planned";
    log(`#${r.issue} @${r.login} ${r.missionId || "-"}: ${r.status}${r.xpAwarded ? ` +${r.xpAwarded} XP` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    if (!api) { log(`  [dry-run] comment:\n${body.split("\n").map(l => "    " + l).join("\n")}\n  [dry-run] close: ${reason}, lock: resolved`); continue; }
    try {
      await api("POST", `/issues/${r.issue}/comments`, { body });
      await api("PATCH", `/issues/${r.issue}`, { state: "closed", state_reason: reason });
      await api("PUT", `/issues/${r.issue}/lock`, { lock_reason: "resolved" });
    } catch (e) { log(`  warning: ${e.message}`); }
  }
  writeOutput(env, changed);
  return { results, changed };
}

/** Lines printed when main() fails: resume workflow commands (if stopped), then one defused ::error::. */
export function errorLines(e, token) {
  const msg = String(e && e.message).replace(/[\r\n]+/g, " ").replace(/::/g, ": :");
  return [...(token ? [`::${token}::`] : []), "::error::" + msg];
}

/** Workflow-command data escaping (same as @actions/core): %, CR, LF. */
function escapeCommandData(v) {
  return String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function writeOutput(env, changed) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `changed=${changed ? "true" : "false"}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // single-line error annotation with any "::" from the message defused (it may quote an API response)
  // Both lines go to stdout: the runner reads stdout and stderr as two pipes with no ordering between them,
  // so an ::error:: on stderr could be seen while commands are still stopped (and shown as plain text).
  main().catch(e => {
    console.log(errorLines(e, stopToken).join("\n"));
    process.exitCode = 1;
  });
}
