// Game rules for the GitHub Pages edition of Agent Academy.
// Copied from academy/missions.mjs (same XP, hint cost, levels and badge rules), with two changes:
//   * there are no answer hashes here — the expected answers come from the ANSWERS repository secret
//     and the submitted answer arrives encrypted (see sealed.mjs);
//   * XP per mission, hint cost and level thresholds are read from site/config.json, so the page
//     and the verifier always use the same tables.
import crypto from "node:crypto";

export const MISSION_IDS = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];

// Display order and names (must match BADGES in site/app.js).
export const BADGE_ORDER = ["first", "clean", "spotter", "act1", "speed", "boss", "full"];
export const BADGE_NAMES = {
  first: "First Flag", clean: "No Lifelines", spotter: "Trap Spotter", act1: "Act I Cleared",
  speed: "Quick Draw", boss: "Boss Slayer", full: "Full Clear"
};
export const SPEED_WINDOW_MS = 15 * 60 * 1000;

export function normalizeAnswer(raw) {
  return String(raw == null ? "" : raw).trim().toLowerCase().replace(/\s+/g, "");
}
export function normalizeLogin(raw) {
  return String(raw == null ? "" : raw).trim().replace(/^@/, "").toLowerCase();
}

// GitHub logins: ASCII letters/digits and single inner hyphens, 1-39 chars. Anything else (unicode
// look-alikes, "__proto__", spaces) is never a real author. Same regex as isValidLogin() in site/seal.js.
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Constant-time comparison of two answers (both normalized first). Hashing to a fixed length first
 * hides the length of the expected answer too; the hash is only a comparison helper, never published.
 */
export function answersEqual(given, expected) {
  const h = v => crypto.createHash("sha256").update(normalizeAnswer(v), "utf8").digest();
  const e = normalizeAnswer(expected);
  return e.length > 0 && crypto.timingSafeEqual(h(given), h(e));
}

/** Build the rule set from site/config.json. */
export function createRules(config) {
  const missions = MISSION_IDS.map(id => {
    const c = (config.missions || []).find(m => m.id === id) || {};
    return { id, act: c.act || 1, xp: Number.isFinite(c.xp) ? c.xp : 0 };
  });
  const byId = new Map(missions.map(m => [m.id, m]));
  const hintCost = Number.isFinite(config.hintCost) ? config.hintCost : 20;
  const maxHints = Number.isFinite(config.maxHints) ? config.maxHints : 2;
  const levels = (config.levels && config.levels.length ? config.levels : [{ at: 0, name: "Level 1" }])
    .slice().sort((a, b) => a.at - b.at);
  const limits = Object.assign({ wrongPerMissionPerDay: 5, issuesPerDay: 30 }, config.limits || {});
  const teams = Array.isArray(config.teams) ? config.teams.slice() : [];

  const missionAward = (missionId, hints) => Math.max((byId.get(missionId)?.xp || 0) - hintCost * (hints || 0), 0);
  const levelIndex = xp => { let i = 0; levels.forEach((l, k) => { if (xp >= l.at) i = k; }); return i; };

  /** Mission-derived badges from the verifier's own state only (cosmetic badges stay in the browser). */
  function computeBadges(player) {
    const solved = player.solved || {};
    const out = new Set();
    const ids = MISSION_IDS.filter(id => solved[id]);
    if (ids.length > 0) out.add("first");
    if (ids.some(id => !(solved[id].hints > 0))) out.add("clean");
    if (solved.m5) out.add("spotter");
    if (solved.m1 && solved.m2 && solved.m3) out.add("act1");
    if (solved.m8) out.add("boss");
    if (ids.length === MISSION_IDS.length) out.add("full");
    const times = ids.map(id => Date.parse(solved[id].at)).filter(Number.isFinite).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= SPEED_WINDOW_MS) { out.add("speed"); break; }
    return BADGE_ORDER.filter(id => out.has(id));
  }

  return { missions, byId, hintCost, maxHints, levels, limits, teams, missionAward, levelIndex, computeBadges,
    maxXp: missions.reduce((s, m) => s + m.xp, 0) };
}
