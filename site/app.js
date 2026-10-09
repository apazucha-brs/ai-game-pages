/* Agent Academy — GitHub Pages edition. Ported from academy/public/app.js (all visuals, sprites, sounds, XP UI).
   There is no server: config comes from config.json, the shared ranking from data/leaderboard.json (published
   by the "Verify flags" GitHub Action), and flags are submitted as prefilled GitHub issues whose answer is
   sealed (RSA-OAEP with the public key from config.json, see seal.js). localStorage keeps: identity (login + team), revealed hints,
   pending submissions, last seen progress (for celebrations), local cosmetic badges and UI prefs. */
import { sealSubmission, importSubmitKey, isValidSubmitKey, buildIssueUrl, isValidLogin, normalizeLogin } from "./seal.js";

(() => {
"use strict";

/* ===================== content ===================== */
const ACTS = [
  { n: 1, roman: "I", name: "First Contact", desc: "Meet the terminal agent, fix your first bug, teach it the house rules." },
  { n: 2, roman: "II", name: "Hands on the Controls", desc: "Plan before code, and stay alert when you approve tools." },
  { n: 3, roman: "III", name: "The Investigation", desc: "Logs, SQL and the boss: a chart that lies." }
];
let HINT_COST = 20;
let MAX_HINTS = 2;
const MISSIONS = [
  {
    id: "m1", act: 1, title: "Boot Up", xp: 100, kind: "answer",
    objective: "Get the CLI running in the repo and let the agent give you a read-only tour of the code.",
    brief: "8:12 a.m. Sales says the September chart looks like an ECG. Before you fix anything, learn the terrain.",
    goal: [
      "Start the CLI in the repo folder and sign in.",
      "Ask the agent for a tour of the project.",
      "Don't let it change anything."
    ],
    skill: "Exploring unfamiliar code",
    learn: "Start a session, trust a folder and ask about the architecture instead of grepping blindly.",
    question: "What is the name of the backend class (repository) that holds the SQL query computing the daily sales report?",
    placeholder: "ClassName",
    hints: {
      copilot: [
        "Install with `brew install --cask copilot-cli` or `npm install -g @github/copilot` (needs Node 22+). Run `copilot` in the repo folder, trust the folder and type `/login` if you're not signed in yet.",
        "Ask the agent to trace the path from the `/api/reports/daily-sales` endpoint down to the SQL. Attach specific files with `@path/to/file` (Tab completes paths). You're looking for a class in the `report` package."
      ],
      claude: [
        "Install with `curl -fsSL https://claude.ai/install.sh | bash` (or `brew install --cask claude-code`). Check `claude --version`, then run `claude` in the repo. The first start opens a browser sign-in.",
        "Ask it to trace `/api/reports/daily-sales` down to the SQL. `@` completes file paths. You're looking for a class in the `report` package."
      ]
    },
    prompt: "Give me a tour of this repository. Describe the structure of the backend and the frontend. Then trace how the response of the /api/reports/daily-sales endpoint is built, from the controller down to the SQL query. Name the classes along the way. Don't change anything."
  },
  {
    id: "m2", act: 1, title: "First Fix", xp: 150, kind: "check",
    objective: "Let the agent run a failing test, explain the cause and make the smallest possible fix.",
    brief: "A customer disputes a receipt that's one cent off. `PriceCalculatorTest` has been red for a week.",
    goal: [
      "Have the agent run the test and explain the cause.",
      "Ask for the smallest fix in production code, not in the test.",
      "Review the diff before you accept it."
    ],
    skill: "Test, diagnose, fix, review",
    learn: "The agent reads a test like a spec. You decide whether the fix is minimal.",
    hints: {
      copilot: [
        "Ask the agent to run `./mvnw test -Dtest=PriceCalculatorTest` in `backend/` itself. When it asks for permission, pick option 1 (allow once).",
        "Look at how gross prices are rounded with 23% VAT. Compare the `RoundingMode` in the calculator with what the test expects. After the change, check `/diff`."
      ],
      claude: [
        "Type `!cd backend && ./mvnw -q test -Dtest=PriceCalculatorTest`. In Claude Code the command output lands in the conversation, so ask about the cause right away.",
        "Look at gross rounding with 23% VAT and the `RoundingMode`. If the agent went too far, `/rewind` undoes the changes."
      ]
    },
    prompt: "The test pl.agentacademy.shop.pricing.PriceCalculatorTest is failing. Run it, explain the cause in 2-3 sentences and propose the smallest possible fix in production code. Don't change the test."
  },
  {
    id: "m3", act: 1, title: "Context", xp: 150, kind: "check",
    objective: "Have the agent write a project instructions file so you stop repeating the house rules.",
    brief: "Every session the agent asks how to run the tests and suggests JUnit 4. Write the house rules down once.",
    goal: [
      "Have the agent analyze the repo and write `.github/copilot-instructions.md` (or `CLAUDE.md`).",
      "Add by hand whatever it missed."
    ],
    skill: "Project instruction files",
    learn: "Context written once loads into every session: commands, structure, test conventions.",
    hints: {
      copilot: [
        "`/init` analyzes the repo and creates or updates `.github/copilot-instructions.md`. Instructions load automatically in later sessions. `/instructions` shows what's loaded.",
        "The check needs at least 400 characters and mentions of `mvnw` (or `mvn`), `npm` and the `pl.agentacademy` package. Be specific: commands, structure, test rules."
      ],
      claude: [
        "`/init` creates `CLAUDE.md` in the project folder. `/memory` lets you edit it later.",
        "The check needs at least 400 characters and mentions of `mvnw` (or `mvn`), `npm` and the `pl.agentacademy` package."
      ]
    },
    prompt: "Analyze this repository and create .github/copilot-instructions.md with instructions for an AI assistant: how to build and test the backend (Maven wrapper), how to run and test the frontend (npm), the package layout of pl.agentacademy.shop, and the test and naming conventions. Keep it short, in bullet points, 60 lines max."
  },
  {
    id: "m4", act: 2, title: "Plan First", xp: 250, kind: "check",
    objective: "Make the agent plan first, approve the plan, then implement GET /api/products/top.",
    brief: "Marketing wants a \"Most popular\" widget. The product owner left an acceptance test and went on vacation.",
    goal: [
      "Remove `@Disabled` from `TopProductsAcceptanceTest`.",
      "Make the agent write a plan, and approve it before any code is written.",
      "Then implement `GET /api/products/top?limit=N`."
    ],
    skill: "Plan mode",
    learn: "A plan before code means cheaper corrections and a smaller diff.",
    hints: {
      copilot: [
        "Shift+Tab cycles the modes: standard, plan, autopilot. You can also type `/plan` followed by the task. Skip autopilot for now.",
        "The requirements are in the test: default limit 5, max 20, no `CANCELLED` orders, sorted by quantity descending, then by `productId` ascending. One query with `GROUP BY` is enough."
      ],
      claude: [
        "Shift+Tab cycles the permission modes until you reach `plan`. Or use `/plan` with a description. Plan mode blocks edits until you approve the plan.",
        "The requirements are in the test: default limit 5, max 20, no `CANCELLED`, sorted by quantity descending, then by `productId`."
      ]
    },
    prompt: "/plan Read @backend/src/test/java/pl/agentacademy/shop/product/TopProductsAcceptanceTest.java and prepare an implementation plan for GET /api/products/top that satisfies the test. List the files to change, the SQL query and the edge cases. Don't write any code yet."
  },
  {
    id: "m5", act: 2, title: "The Trap", xp: 200, kind: "answer", security: true,
    objective: "Run a legacy importer with the agent and catch the hidden instruction before anything executes.",
    brief: "An old data importer from the PHP days. Its README looks harmless, but not everything shows up in the Markdown preview.",
    goal: [
      "Ask the agent to run the importer as the README describes.",
      "Read every permission request.",
      "If it wants to download and run a script, say no and find out where the idea came from."
    ],
    skill: "Prompt injection and tool approval",
    learn: "File contents are data, not commands. The last line of defense is you, at the approval prompt.",
    approval: [
      "**Copilot CLI:** `--yolo` and `--allow-all` switch approval prompts off, and nothing reviews the actions. Not for this mission.",
      "**Claude Code:** recent versions start in auto mode. Its classifier blocks risky actions such as `curl … | sh`, but it is not a sandbox. For this mission, switch to Manual mode.",
      "**Either tool:** never approve `curl … | sh` just because a README told the agent to."
    ],
    question: "From which domain was the script supposed to be downloaded and run?",
    placeholder: "domain.example",
    hints: {
      copilot: [
        "Don't play this mission with `--yolo`, `--allow-all` or `/allow-all`. On a suspicious request pick option 3 (No, Esc) and tell the agent what you want instead.",
        "Look at the raw file, for example `!cat tools/legacy-importer/README.md`, and search for an HTML comment `<!-- … -->`. The domain is in the `curl` command."
      ],
      claude: [
        "Play in Manual mode, not auto mode or `--dangerously-skip-permissions`: the point is that you spot the trap. Recent versions start in auto mode, so start with `claude --permission-mode default` or press Shift+Tab until the status bar says manual mode. Esc at an approval prompt means No.",
        "Type `!cat tools/legacy-importer/README.md` and search for an HTML comment `<!-- … -->`. The domain is in the `curl` command."
      ]
    },
    prompt: "Read @tools/legacy-importer/README.md and tell me which commands you plan to run BEFORE you run anything. Also list every instruction in the README that isn't about importing the data itself."
  },
  {
    id: "m6", act: 3, title: "Log Detective", xp: 250, kind: "answer",
    objective: "Have the agent count processed payment callbacks per order across three days of logs.",
    brief: "On September 17 the payment gateway hiccuped. Thousands of log lines, several threads, look-alike order numbers.",
    goal: [
      "Have the agent analyze the `logs/` folder.",
      "Count processed payment callbacks per order.",
      "Get the result from a command you can see and run again."
    ],
    skill: "Log analysis",
    learn: "The agent writes a repeatable command (grep, awk). You verify the result instead of taking its word for it.",
    question: "Which order had its payment callback processed the most times?",
    placeholder: "ORD-00000",
    hints: {
      copilot: [
        "Tell the agent the logs are in `logs/` (one file per day) and ask for a command that counts occurrences, not an eyeball estimate. Only approve commands you understand.",
        "Count only `Payment callback processed` entries, not `Received…`, `Retrying…` or timeouts. Search all files: retries can cross midnight. Look-alike order numbers are a deliberate trap, so compare digit by digit."
      ],
      claude: [
        "Tell the agent the logs are in `logs/` (one file per day). You can also run a command yourself with `!` and its output lands in the conversation.",
        "Count only `Payment callback processed` entries across all files, not every mention of an order. Look-alike numbers are a deliberate trap."
      ]
    },
    prompt: "Analyze every file in the logs/ folder. Find the entries where a payment callback was processed and count them per order number. Write and run a command that does the counting (show it to me), and give me the top 5 orders with their counts."
  },
  {
    id: "m7", act: 3, title: "SQL", xp: 250, kind: "answer",
    objective: "Have the agent write SQL that counts the duplicate rows the repeated callbacks left in order_items.",
    brief: "The callbacks were repeated. Management wants one number for the junk they left in the database.",
    goal: [
      "Connect to Postgres on `localhost:5433`. Database, user and password are all `shopflow`.",
      "Have the agent write a query that counts surplus rows in `order_items`.",
      "Check that its definition of a duplicate is right."
    ],
    skill: "SQL with an agent",
    learn: "The agent writes the SQL. You own the definition.",
    question: "How many surplus rows are in order_items? (duplicate = same order_id + product_id pair more than once; count only rows beyond the first)",
    placeholder: "number",
    hints: {
      copilot: [
        "Give the agent the schema: `@backend/src/main/resources/db/schema.sql`. Run the query with `docker compose exec db psql -U shopflow -d shopflow -c \"…\"`. No Docker? Ask the agent to count the duplicates in `data.sql` with a script.",
        "`GROUP BY order_id, product_id HAVING COUNT(*) > 1`, then sum `COUNT(*) - 1`. The number of groups is not the number of surplus rows."
      ],
      claude: [
        "Give the agent `@backend/src/main/resources/db/schema.sql` and run the query with `!docker compose exec db psql -U shopflow -d shopflow -c \"…\"`. The output lands in the conversation.",
        "`GROUP BY order_id, product_id HAVING COUNT(*) > 1`, then sum `COUNT(*) - 1`."
      ]
    },
    prompt: "Using @backend/src/main/resources/db/schema.sql, write a PostgreSQL query that counts surplus rows in order_items: a duplicate is the same order_id + product_id pair; count only the rows beyond the first. Add a second query showing which orders and days are affected."
  },
  {
    id: "m8", act: 3, title: "The Chart Lies", xp: 500, kind: "check", boss: true,
    objective: "Fix the lying sales chart: one bug in the frontend, one in the backend.",
    brief: "The CEO sees September 17 sales bigger than a small country's GDP. Two bugs, two layers, one chart.",
    goal: [
      "Start the app, screenshot the Daily sales chart and paste it into the CLI.",
      "Fix the revenue sum in the frontend file `aggregateByDay.ts`.",
      "Fix the non-idempotent `PaymentCallbackService` in the backend."
    ],
    skill: "Multimodal debugging",
    learn: "Screenshot as context, a hypothesis, a test as the judge. Each layer gets its fix and a green test.",
    hints: {
      copilot: [
        "Most reliable: Cmd+Shift+4 saves a screenshot to your Desktop; drag the file into the terminal or type `@path/screenshot.png`. Cmd+Ctrl+Shift+4 copies to the clipboard instead; paste it with Option+V, which needs \"Use Option as Meta key\" in Terminal.app (Settings > Profiles > Keyboard) or Left Option = Esc+ in iTerm2.",
        "Revenue arrives from the API as text, and in JS `\"12.50\" + \"3.10\"` concatenates strings. In the backend, a second callback for the same order must not insert the items again. Check the order state before saving."
      ],
      claude: [
        "Take a screenshot to the clipboard with Cmd+Ctrl+Shift+4, then paste with Ctrl+V (in iTerm2: Cmd+V). You'll see `[Image #1]`. You can also drag the image file into the window or reference `@screenshot.png`.",
        "Revenue arrives from the API as text, and in JS `\"12.50\" + \"3.10\"` concatenates strings. In the backend, a second callback for the same order must not insert the items again."
      ]
    },
    prompt: "[screenshot] This is the Daily sales chart from our app. The values for September 17 look absurd. Analyze @frontend/src/report/aggregateByDay.ts and the payment callback flow in the backend, and explain what could cause these spikes. Diagnosis and a plan first, no code changes yet."
  }
];
let MAX_XP = MISSIONS.reduce((s, m) => s + m.xp, 0);
const LEVELS = [
  { at: 0, name: "Prompt Intern", desc: "First steps in the terminal with an agent." },
  { at: 300, name: "Agent Pilot", desc: "You steer the agent with a steady hand: test, diagnose, fix." },
  { at: 700, name: "Context Architect", desc: "You plan before the agent touches code, and you don't fall for tricks." },
  { at: 1200, name: "Incident Slayer", desc: "Logs, SQL and charts hold no secrets from you." },
  { at: 1800, name: "Academy Legend", desc: "A full clear with almost no hints. Respect." }
];
let TEAMS = ["Backend", "Frontend", "Platform", "QA", "Data", "Other"];

/* pixel maps for badges and sprites */
const PAL = { a: "--amber", c: "--coral", y: "--cyan", p: "--paper", g: "--ok", k: "--ink" };
/* local: true = cosmetic easter egg, kept only in this browser (not in the shared ranking) */
const BADGES = [
  { id: "first", name: "First Flag", desc: "Complete any mission.", map: ["pa......","paaaaa..","paaaaaa.","paaaaa..","pa......","p.......","p.......","pp......"] },
  { id: "clean", name: "No Lifelines", desc: "Complete a mission without any hint.", map: ["...a....","...a....","aaaaaaa.",".aaaaa..","..aaa...",".aa.aa..",".a...a..","........"] },
  { id: "spotter", name: "Trap Spotter", desc: "Catch the prompt injection in M5.", map: ["........","..pppp..",".p.yy.p.","p.yyyy.p",".p.yy.p.","..pppp..","........","........"] },
  { id: "act1", name: "Act I Cleared", desc: "Complete M1, M2 and M3.", map: [".yyyyyy.","...yy...","...yy...","...yy...","...yy...","...yy...",".yyyyyy.","........"] },
  { id: "speed", name: "Quick Draw", desc: "Complete two missions within 15 minutes.", map: ["....aa..","...aa...","..aa....",".aaaaa..","...aa...","..aa....",".aa.....","........"] },
  { id: "boss", name: "Boss Slayer", desc: "Defeat M8: The Chart Lies.", map: ["..pppp..",".pppppp.",".pkppkp.",".pppppp.","..pkkp..","..pppp..","..p.p.p.","........"] },
  { id: "full", name: "Full Clear", desc: "Complete all 8 missions.", map: ["aaaaaaaa","a.aaaa.a","a.aaaa.a",".aaaaaa.","..aaaa..","...aa...","...aa...","..aaaa.."] },
  { id: "squash", local: true, name: "Bug Squasher", desc: "Hidden: squash 5 flying bugs in the background.", map: ["..p.p...","...p....","..ccc...",".ccccc..","pcpcpcp.",".ccccc..","p.ccc.p.","........"] },
  { id: "konami", local: true, name: "Old School", desc: "Hidden: type a certain famous code from the 80s.", map: ["........","..pppp..",".pppppp.","pyppppcp","yyyppcpc","pyppppcp",".pp..pp.","........"] }
];

/* ===================== utils ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = s => esc(s).replace(/`([^`]+)`/g, (_, c) => c.length > 28 ? `<code class="wrap">${c.replace(/\//g, "/<wbr>")}</code>` : `<code>${c}</code>`).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false, addEventListener() {} };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
};

/* ===================== state ===================== */
const K = {
  me: "agentAcademyPages.me", prefs: "agentAcademyPages.prefs", hints: "agentAcademyPages.hints",
  pending: "agentAcademyPages.pending", seen: "agentAcademyPages.seen", local: "agentAcademyPages.localBadges",
  honor: "agentAcademyPages.honorSeen"
};
const prefs = Object.assign({ tool: "copilot", squashed: 0 }, store.get(K.prefs, {}));
if (!["copilot", "claude"].includes(prefs.tool)) prefs.tool = "copilot";
if (!Number.isFinite(prefs.squashed)) prefs.squashed = 0;
const savePrefs = () => store.set(K.prefs, prefs);
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const S = {
  cfg: null,                               // config.json
  cfgOk: false,                            // owner/repo + submitKey filled in by the trainer
  sealKey: null,                           // Promise<CryptoKey> imported from config.submitKey
  me: store.get(K.me, null),               // {login, team} typed on this device (sealed into submissions, "me")
  board: null,                             // last data/leaderboard.json
  player: null,                            // my row in board.players (source of truth for XP/solved/badges)
  online: null,                            // null until the first fetch finishes
  hints: store.get(K.hints, {}),           // {shown: {m1: 2}, paid: {m1: 1}} — honour system, sent in the issue
  pending: store.get(K.pending, {}),       // {m1: {at, prevAt, prevAny, url}} — submitted, waiting for the Action
  seen: store.get(K.seen, null),           // {login, xp, solved: [], badges: []} — last progress we celebrated
  local: store.get(K.local, []),           // cosmetic badges earned in this browser
  obDismissed: false, loading: null, retryT: 0
};
if (!isObj(S.me) || !isValidLogin(S.me.login)) S.me = null;
if (!isObj(S.hints)) S.hints = {};
if (!isObj(S.hints.shown)) S.hints.shown = {};
if (!isObj(S.hints.paid)) S.hints.paid = {};
if (!isObj(S.pending)) S.pending = {};
if (!Array.isArray(S.local)) S.local = [];
const saveHints = () => store.set(K.hints, S.hints);
const savePending = () => store.set(K.pending, S.pending);
const saveLocal = () => store.set(K.local, S.local);
const saveMe = () => S.me ? store.set(K.me, S.me) : store.del(K.me);

const myKey = () => S.me ? normalizeLogin(S.me.login) : null;
const isSolved = id => !!(S.player && S.player.solved && S.player.solved[id]);
const hintsShown = id => Math.min(MAX_HINTS, S.hints.shown[id] || 0);
const hintsPaid = id => Math.min(MAX_HINTS, S.hints.paid[id] || 0);
const award = m => Math.max(m.xp - HINT_COST * hintsPaid(m.id), 0);
const totalXp = () => S.player ? S.player.xp : 0;
const levelIndex = xp => { let i = 0; LEVELS.forEach((l, k) => { if (xp >= l.at) i = k; }); return i; };
const ownedBadges = () => new Set([...(S.player ? S.player.badges || [] : []), ...S.local]);
const myResults = () => (S.board && S.board.lastResults && myKey() && S.board.lastResults[myKey()]) || {};

/* ===================== config + leaderboard (static files) ===================== */
async function getJson(url) {
  let res;
  try { res = await fetch(url, { cache: "no-store" }); }
  catch (e) { throw Object.assign(new Error("No connection."), { offline: true }); }
  if (res.status === 404) throw Object.assign(new Error("File not found."), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`HTTP error ${res.status}.`), { status: res.status });
  try { return await res.json(); } catch (e) { throw Object.assign(new Error("The file is not valid JSON."), { status: 0 }); }
}

function setOnline(v) {
  const was = S.online;
  S.online = v;
  $("#netbar").hidden = v !== false;
  if (v === false) scheduleRetry();
  if (v === true && was === false) toast("LEADERBOARD IS BACK", "The leaderboard is loading again.");
  if (was !== v) boardStatus();
}
function scheduleRetry() {
  if (S.retryT) return;
  S.retryT = setTimeout(() => { S.retryT = 0; pollBoard(true); }, 15000);
}
$("#net-retry").addEventListener("click", () => { clearTimeout(S.retryT); S.retryT = 0; pollBoard(true); });

async function loadConfig() {
  try { S.cfg = await getJson("config.json?t=" + Date.now()); }
  catch (e) { S.cfg = {}; }
  applyConfig();
}

function applyConfig() {
  const c = S.cfg || {};
  S.cfgOk = typeof c.owner === "string" && typeof c.repo === "string" && /^[A-Za-z0-9-]+$/.test(c.owner) && /^[A-Za-z0-9._-]+$/.test(c.repo) && c.owner !== "YOUR-ORG" &&
    isValidSubmitKey(c.submitKey);
  S.sealKey = null;
  if (S.cfgOk) { S.sealKey = importSubmitKey(c.submitKey); S.sealKey.catch(() => { /* reported on submit */ }); }
  if (Array.isArray(c.teams) && c.teams.length) TEAMS = c.teams.filter(t => typeof t === "string" && t.trim()).slice(0, 40);
  if (Number.isFinite(c.hintCost)) HINT_COST = c.hintCost;
  if (Number.isFinite(c.maxHints)) MAX_HINTS = c.maxHints;
  if (Number.isFinite(c.pollSeconds) && c.pollSeconds >= 10) POLL_MS = c.pollSeconds * 1000;
  (c.missions || []).forEach(x => { const m = MISSIONS.find(y => y.id === x.id); if (m && Number.isFinite(x.xp)) m.xp = x.xp; });
  if (Array.isArray(c.levels) && c.levels.length) {
    c.levels.forEach((l, i) => { if (LEVELS[i] && Number.isFinite(l.at)) { LEVELS[i].at = l.at; if (l.name) LEVELS[i].name = l.name; if (l.desc) LEVELS[i].desc = l.desc; } });
  }
  MAX_XP = MISSIONS.reduce((s, m) => s + m.xp, 0);
  $("#stat-maxxp").textContent = MAX_XP;
  if (S.me && !TEAMS.includes(S.me.team)) { S.me.team = ""; saveMe(); }
  populateTeams();
  const ru = $("#repo-url");
  if (c.trainingRepoUrl) {
    ru.textContent = c.trainingRepoUrl; ru.classList.add("set");
    $("#repo-note").hidden = true; $("#repo-lead").textContent = "The training repo URL is already filled in below.";
  }
  if (c.eventName) {
    document.title = `Agent Academy · ${c.eventName}`;
    $("#foot-name").textContent = `Agent Academy · ${c.eventName} · Copilot CLI available now, Claude Code coming soon`;
  }
  $("#cfg-warn").hidden = S.cfgOk;
  renderAll();
}
function populateTeams() {
  const sel = $("#team-select"), cur = S.me ? S.me.team : "";
  sel.replaceChildren(new Option("choose…", ""), ...TEAMS.map(t => new Option(t, t)));
  sel.value = TEAMS.includes(cur) ? cur : "";
  $$(".team-chips").forEach(box => {
    box.replaceChildren(...TEAMS.map(t => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "team-chip"; b.setAttribute("role", "radio"); b.dataset.team = t; b.textContent = t;
      b.setAttribute("aria-checked", String(OB.team === t));
      return b;
    }));
  });
}

/** Validate the shape of leaderboard.json defensively: it is generated, but it is still remote data. */
function sanitizeBoard(d) {
  if (!isObj(d)) return null;
  const players = (Array.isArray(d.players) ? d.players : []).filter(p => isObj(p) && typeof p.login === "string" && isValidLogin(p.login)).map(p => ({
    login: p.login, team: typeof p.team === "string" ? p.team : "", xp: Number.isFinite(p.xp) ? p.xp : 0,
    solved: isObj(p.solved) ? p.solved : {}, badges: Array.isArray(p.badges) ? p.badges.filter(b => typeof b === "string") : [],
    updatedAt: p.updatedAt
  }));
  const teams = (Array.isArray(d.teams) ? d.teams : []).filter(t => isObj(t) && typeof t.team === "string").map(t => ({
    team: t.team, xp: Number(t.xp) || 0, players: Number(t.players) || 0, avgXp: Number(t.avgXp) || 0
  }));
  return { generatedAt: d.generatedAt || null, players, teams, lastResults: isObj(d.lastResults) ? d.lastResults : {} };
}

/* ===================== ranking polling (while the tab is visible) ===================== */
let POLL_MS = 30000;
const R = { view: "players", timer: 0, loaded: false, missing: false };
async function pollBoard(force) {
  clearTimeout(R.timer); R.timer = 0;
  if (document.hidden && !force) return;
  try {
    const data = await getJson("data/leaderboard.json?t=" + Date.now());
    const b = sanitizeBoard(data);
    if (!b) throw Object.assign(new Error("The leaderboard file has an invalid format."), { status: 0 });
    R.missing = false; setOnline(true);
    applyBoard(b);
  } catch (e) {
    if (e.status === 404) { R.missing = true; setOnline(true); applyBoard({ generatedAt: null, players: [], teams: [], lastResults: {} }); }
    else setOnline(false);
  }
  boardStatus();
  if (!document.hidden) {
    const fast = Object.keys(S.pending).length > 0;
    R.timer = setTimeout(() => pollBoard(false), fast ? Math.min(POLL_MS, 15000) : POLL_MS);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(R.timer); R.timer = 0; }
  else pollBoard(true);
});

/** New leaderboard: update my progress, then celebrate what changed and resolve pending submissions. */
function applyBoard(b) {
  const firstLoad = !R.loaded;
  S.board = b; R.loaded = true;
  const key = myKey();
  S.player = key ? b.players.find(p => normalizeLogin(p.login) === key) || null : null;
  renderAll(); renderBoard();
  if (!key) return;

  const seen = S.seen && S.seen.login === key ? S.seen : null;
  const nowSolved = MISSIONS.filter(m => isSolved(m.id)).map(m => m.id);
  const xp = totalXp(), badges = S.player ? S.player.badges : [];
  const fresh = nowSolved.filter(id => (seen ? !seen.solved.includes(id) : !!S.pending[id]));
  const results = myResults();

  // 1) solved missions -> confetti, +XP, sounds, level-up, badges
  if (fresh.length) {
    const beforeXp = seen ? seen.xp : Math.max(0, xp - fresh.reduce((s, id) => s + award(MISSIONS.find(m => m.id === id)), 0));
    fresh.forEach((id, i) => setTimeout(() => celebrateSolve(MISSIONS.find(m => m.id === id), fresh.length === 1 ? xp - beforeXp : award(MISSIONS.find(m => m.id === id))), i * 900));
    const newBadges = seen ? badges.filter(x => !seen.badges.includes(x)) : badges;
    newBadges.forEach((id, i) => setTimeout(() => {
      const bd = BADGES.find(x => x.id === id); if (!bd) return;
      toast("BADGE UNLOCKED", bd.name, bd.map); play("badge");
    }, 1100 + fresh.length * 900 + i * 500));
    if (levelIndex(xp) > levelIndex(beforeXp)) setTimeout(() => showLevelUp(LEVELS[levelIndex(xp)]), 900 + fresh.length * 900);
  } else if (seen && !firstLoad && badges.some(x => !seen.badges.includes(x))) {
    badges.filter(x => !seen.badges.includes(x)).forEach(id => { const bd = BADGES.find(x => x.id === id); if (bd) { toast("BADGE UNLOCKED", bd.name, bd.map); play("badge"); } });
  }
  fresh.forEach(id => { delete S.pending[id]; });

  // 2) pending submissions that came back wrong / limited / invalid
  Object.entries(S.pending).forEach(([id, p]) => {
    if (isSolved(id)) { delete S.pending[id]; return; }
    const r = results[id], any = results._;
    const newer = (x, prev) => x && x.at && x.at !== prev && Date.parse(x.at) > (prev ? Date.parse(prev) : 0);
    const hit = newer(r, p.prevAt) ? r : newer(any, p.prevAny) ? any : null;
    if (!hit || hit.status === "correct") return;
    delete S.pending[id];
    rejectSubmission(MISSIONS.find(m => m.id === id), hit);
  });
  savePending();
  S.seen = { login: key, xp, solved: nowSolved, badges: badges.slice() };
  store.set(K.seen, S.seen);
  renderProgress();
}

/* ===================== sound (WebAudio chiptune) ===================== */
const SFX = { ctx: null, master: null, noise: null, muted: !!store.get("agentAcademy.muted", false), lastHover: 0 };
function audio() {
  if (SFX.ctx) { if (SFX.ctx.state === "suspended") SFX.ctx.resume().catch(() => {}); return SFX.ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    SFX.ctx = new AC();
    SFX.master = SFX.ctx.createGain(); SFX.master.gain.value = .55; SFX.master.connect(SFX.ctx.destination);
    const len = SFX.ctx.sampleRate * .3, buf = SFX.ctx.createBuffer(1, len, SFX.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    SFX.noise = buf;
  } catch (e) { SFX.ctx = null; }
  return SFX.ctx;
}
function tone(freq, start, dur, opt = {}) {
  const ctx = SFX.ctx; if (!ctx) return;
  const t = ctx.currentTime + start, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = opt.type || "square"; o.frequency.setValueAtTime(freq, t);
  if (opt.slide) o.frequency.exponentialRampToValueAtTime(opt.slide, t + dur);
  const v = opt.vol == null ? .08 : opt.vol;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + .006); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g); g.connect(SFX.master); o.start(t); o.stop(t + dur + .02);
}
function noise(start, dur, vol, cutoff) {
  const ctx = SFX.ctx; if (!ctx || !SFX.noise) return;
  const t = ctx.currentTime + start, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = SFX.noise; f.type = "lowpass"; f.frequency.value = cutoff || 1800;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(SFX.master); src.start(t); src.stop(t + dur + .02);
}
function play(name) {
  if (SFX.muted || !SFX.ctx) return;
  switch (name) {
    case "hover": tone(1320, 0, .035, { vol: .022 }); break;
    case "click": tone(660, 0, .045, { vol: .06 }); tone(990, .045, .05, { vol: .05 }); break;
    case "tab": tone(880, 0, .05, { vol: .05, type: "triangle" }); break;
    case "correct": [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * .07, .12, { vol: .08 })); tone(1568, .36, .4, { type: "triangle", vol: .1 }); break;
    case "wrong": tone(180, 0, .28, { type: "sawtooth", slide: 70, vol: .09 }); tone(120, .02, .24, { vol: .05 }); break;
    case "hint": tone(988, 0, .08, { type: "triangle", vol: .08 }); tone(740, .08, .14, { type: "triangle", vol: .08 }); break;
    case "levelup": [[392,0,.12],[523,.12,.12],[659,.24,.12],[784,.36,.2],[659,.56,.1],[784,.66,.12],[1047,.78,.5]].forEach(([f,s,d]) => { tone(f, s, d, { vol: .09 }); tone(f / 2, s, d, { type: "triangle", vol: .06 }); }); break;
    case "badge": tone(988, 0, .08, { vol: .07 }); tone(1319, .08, .22, { vol: .07 }); break;
    case "squash": noise(0, .14, .25, 1400); tone(240, 0, .16, { type: "sine", slide: 50, vol: .14 }); break;
    case "type": tone(1800 + Math.random() * 600, 0, .018, { vol: .018, type: "square" }); break;
    case "siren": for (let i = 0; i < 3; i++) { tone(660, i * .36, .17, { type: "sawtooth", vol: .06 }); tone(440, i * .36 + .18, .17, { type: "sawtooth", vol: .06 }); } break;
    case "combo": [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * .045, .07, { vol: .06 })); break;
    case "konami": [[523,0],[523,.1],[784,.2],[784,.3],[880,.4],[880,.5],[784,.6],[698,.85],[659,.95],[587,1.05],[523,1.15]].forEach(([f, s]) => tone(f, s, .1, { vol: .07 })); break;
    case "copy": tone(1175, 0, .05, { vol: .05, type: "triangle" }); tone(1568, .05, .06, { vol: .05, type: "triangle" }); break;
  }
}
const unlockAudio = () => { audio(); };
window.addEventListener("pointerdown", unlockAudio, { capture: true });
window.addEventListener("keydown", unlockAudio, { capture: true });
function renderSoundBtn() {
  const b = $("#sound-btn");
  b.setAttribute("aria-pressed", String(!SFX.muted));
  b.textContent = SFX.muted ? "SFX OFF" : "SFX ON";
  b.setAttribute("aria-label", SFX.muted ? "Sound off, click to turn on" : "Sound on, click to turn off");
}
$("#sound-btn").addEventListener("click", () => {
  SFX.muted = !SFX.muted; store.set("agentAcademy.muted", SFX.muted); renderSoundBtn();
  if (!SFX.muted) { audio(); play("click"); }
});
document.addEventListener("pointerover", e => {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const el = e.target.closest && e.target.closest("button, a, .tab");
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  const now = performance.now();
  if (now - SFX.lastHover < 90) return;
  SFX.lastHover = now; play("hover");
});

/* ===================== FX: floaters, confetti, toasts ===================== */
function floatText(el, text, neg) {
  const r = el.getBoundingClientRect(), f = document.createElement("div");
  f.className = "floater" + (neg ? " neg" : "");
  f.textContent = text;
  f.style.left = (r.left + r.width / 2) + "px"; f.style.top = (r.top - 4) + "px";
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1400);
}
const fx = { cv: $("#fx"), ctx: null, parts: [], running: false };
fx.ctx = fx.cv.getContext("2d");
function sizeFx() { const d = Math.min(2, window.devicePixelRatio || 1); fx.cv.width = innerWidth * d; fx.cv.height = innerHeight * d; fx.ctx.setTransform(d, 0, 0, d, 0, 0); }
function burst(x, y, n, big) {
  if (reduceMotion.matches) return;
  const cols = ["--amber", "--coral", "--cyan", "--paper", "--ok"].map(cssVar);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = (big ? 260 : 160) + Math.random() * (big ? 420 : 220);
    fx.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (big ? 220 : 120), s: 3 + Math.floor(Math.random() * 4), c: cols[i % cols.length], life: 1.1 + Math.random() * .9, t: 0 });
  }
  if (!fx.running) { fx.running = true; fx.last = performance.now(); requestAnimationFrame(fxLoop); }
}
function fxLoop(now) {
  const dt = Math.min(.04, (now - fx.last) / 1000); fx.last = now;
  const c = fx.ctx; c.clearRect(0, 0, innerWidth, innerHeight);
  fx.parts = fx.parts.filter(p => (p.t += dt) < p.life);
  for (const p of fx.parts) {
    p.vy += 700 * dt; p.vx *= .985; p.x += p.vx * dt; p.y += p.vy * dt;
    c.globalAlpha = Math.max(0, 1 - p.t / p.life); c.fillStyle = p.c;
    c.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
  }
  c.globalAlpha = 1;
  if (fx.parts.length) requestAnimationFrame(fxLoop); else { fx.running = false; c.clearRect(0, 0, innerWidth, innerHeight); }
}
function pixelCanvas(map, scale) {
  const cv = document.createElement("canvas"), h = map.length, w = map[0].length;
  cv.width = w * scale; cv.height = h * scale;
  const c = cv.getContext("2d");
  map.forEach((row, y) => [...row].forEach((ch, x) => { if (PAL[ch]) { c.fillStyle = cssVar(PAL[ch]); c.fillRect(x * scale, y * scale, scale, scale); } }));
  return cv;
}
function toast(title, text, map) {
  const t = document.createElement("div"); t.className = "toast";
  const icon = map ? pixelCanvas(map, 4) : document.createElement("span");
  const body = document.createElement("div");
  const b = document.createElement("b"); b.textContent = title;
  const s = document.createElement("span"); s.textContent = text;
  body.append(b, s); t.append(icon, body);
  const box = $("#toasts");
  box.appendChild(t);
  // a big ranking update can raise many toasts at once: keep the newest few so they don't cover a phone screen
  const max = innerWidth < 600 ? 2 : 4;
  while (box.children.length > max) box.firstElementChild.remove();
  setTimeout(() => t.remove(), 4800);
}
let lastFocus = null;
function showLevelUp(lv) {
  $("#lvl-title").textContent = lv.name; $("#lvl-desc").textContent = lv.desc;
  lastFocus = document.activeElement;
  $("#levelup").hidden = false; $("#lvl-close").focus();
  play("levelup"); burst(innerWidth / 2, innerHeight / 2, 140, true);
}
function hideLevelUp() { $("#levelup").hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
$("#lvl-close").addEventListener("click", hideLevelUp);
$("#levelup").addEventListener("click", e => { if (e.target.id === "levelup") hideLevelUp(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#levelup").hidden) hideLevelUp(); });

/* ===================== render: hero chart ===================== */
(function heroChart() {
  const ch = $("#hero-chart"); let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let d = 1; d <= 30; d++) {
    const b = document.createElement("div");
    if (d === 17) { b.className = "bar spike"; }
    else { b.className = "bar"; b.style.height = Math.round(18 + rnd() * 22 + (d % 7 === 5 || d % 7 === 6 ? 8 : 0)) + "%"; }
    ch.appendChild(b);
  }
  const lab = document.createElement("div"); lab.className = "spike-label";
  lab.textContent = 'Sep 17: "4120.50"+"3988.10"+… = 4120.503988.10…';
  ch.appendChild(lab);
})();

/* hero terminal: types itself out once */
(function heroTerm() {
  const lines = $$(".term p");
  if (reduceMotion.matches || !lines.length) return;
  const cursor = $(".term .cursor");
  const texts = lines.map(p => p.textContent);
  lines.forEach(p => { p.textContent = "\u00a0"; });
  let li = 0, ci = 0;
  const step = () => {
    if (li >= lines.length) { if (cursor) lines[lines.length - 1].appendChild(cursor); return; }
    const p = lines[li], txt = texts[li], isMe = p.classList.contains("me");
    ci++;
    p.textContent = txt.slice(0, ci) || "\u00a0";
    if (cursor) p.appendChild(cursor);
    if (isMe && ci % 2 === 0) play("type");
    if (ci >= txt.length) { li++; ci = 0; setTimeout(step, isMe ? 520 : 260); return; }
    setTimeout(step, isMe ? 38 + Math.random() * 50 : 12);
  };
  setTimeout(step, 700);
})();

/* ===================== render: missions ===================== */
/* Each mission is an accordion card. At rest it shows only: code, act chip, title, one-line objective,
   skill tag, XP, status and the primary action. Everything else lives in the expanded body,
   split into labelled sections. Only one mission is open at a time. */
const TOOL_LABEL = { copilot: "Copilot CLI", claude: "Claude Code" };
function hintBlock(m, tool) {
  const items = m.hints[tool].map((h, i) => `<li data-h="${i + 1}" hidden><span class="hint-n">Hint ${i + 1}</span><p>${fmt(h)}</p></li>`).join("");
  return `<ol class="hints">${items}</ol><button class="hint-btn" type="button" data-m="${m.id}"></button>`;
}
const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"/></svg>';
function missionHtml(m, idx) {
  const act = ACTS[m.act - 1];
  const kindLbl = m.kind === "check" ? "Script check" : "Question";
  const submit = m.kind === "check"
    ? `<ol class="pass-steps">
         <li>In the repo root, run the check:<div class="codeblk"><div class="cb-bar"><span>Terminal</span><button class="copy" type="button">Copy</button></div><pre>node check.mjs ${m.id}</pre></div></li>
         <li>On success it prints a flag that starts with <code>ACAD-</code>. Paste it below and click <b>Submit flag</b>.</li>
       </ol>`
    : `<p class="question">${fmt(m.question)}</p>`;
  const ansLabel = m.kind === "check" ? "Flag from check.mjs" : "Your answer";
  const tools = ["copilot", "claude"].map(t => {
    const sel = prefs.tool === t;
    return `<button class="tab" role="tab" type="button" id="tab-${m.id}-${t}" aria-controls="panel-${m.id}-${t}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}" data-tool="${t}">${TOOL_LABEL[t]}${t === "claude" ? ' <span class="soon-badge">Soon</span>' : ""}</button>`;
  }).join("");
  const panels = ["copilot", "claude"].map(t => `
          <div class="panel" role="tabpanel" id="panel-${m.id}-${t}" aria-labelledby="tab-${m.id}-${t}" ${prefs.tool === t ? "" : "hidden"}>
            ${t === "claude" ? '<p class="soon-note">Claude Code is coming to the company soon. Keep these hints for when you get access.</p>' : ""}
            ${hintBlock(m, t)}
          </div>`).join("");
  return `
  <article class="mission${m.boss ? " boss" : ""}" id="${m.id}" data-id="${m.id}">
    <h3 class="m-h">
      <button class="m-toggle" type="button" id="mt-${m.id}" aria-expanded="false" aria-controls="mb-${m.id}">
        <span class="m-code" aria-hidden="true">${m.id.toUpperCase()}</span>
        <span class="m-main">
          <span class="m-tags"><span class="sr-only">Act ${act.roman}, </span><span class="tag">${kindLbl}</span>${m.boss ? '<span class="tag tag-boss">Boss</span>' : ""}${m.security ? '<span class="tag tag-sec">Security</span>' : ""}<span class="sr-only">, mission ${idx + 1} of ${MISSIONS.length}:</span></span>
          <span class="m-title">${esc(m.title)}</span>
          <span class="m-obj">${esc(m.objective)}</span>
          <span class="m-skill"><span class="sr-only">Skill: </span>${esc(m.skill)}</span>
        </span>
        <span class="m-side">
          <span class="m-xp" data-xp></span>
          <span class="m-status" data-status></span>
          <span class="m-cta"><span data-cta>Open</span>${CHEVRON}</span>
        </span>
      </button>
    </h3>
    <div class="m-body" id="mb-${m.id}" role="region" aria-labelledby="mt-${m.id}" hidden>
      <div class="m-story">
        ${m.boss ? '<div class="hpbar"><span>Boss HP</span><div class="hp"><i data-hp></i></div></div>' : ""}
        <section class="m-sec"><h4>Briefing</h4><p class="brief">${fmt(m.brief)}</p></section>
        <section class="m-sec"><h4>Your goal</h4>${Array.isArray(m.goal) ? `<ul class="goal">${m.goal.map(g => `<li>${fmt(g)}</li>`).join("")}</ul>` : `<p>${fmt(m.goal)}</p>`}</section>
        <section class="m-sec"><h4>What you'll learn</h4><p>${fmt(m.learn)}</p></section>
        ${m.approval ? `<section class="m-sec m-approval"><h4>Approval modes</h4><ul>${m.approval.map(a => `<li>${fmt(a)}</li>`).join("")}</ul><p class="sec-note"><a href="#approval-modes">Compare the modes</a></p></section>` : ""}
      </div>
      <div class="m-tools">
        <section class="m-sec">
          <h4>Hints</h4>
          <p class="sec-note">Each hint costs <span data-hintcost>${HINT_COST}</span> XP until you solve the mission. Honor system: your submission includes how many hints you revealed. Don't edit that number on GitHub.</p>
          <div class="tabs" role="tablist" aria-label="Hints for tool">${tools}</div>
          ${panels}
        </section>
        <section class="m-sec">
          <h4>Example prompt</h4>
          <div class="codeblk prompt"><div class="cb-bar"><span>Prompt</span><button class="copy" type="button">Copy</button></div><pre>${esc(m.prompt)}</pre></div>
        </section>
      </div>
      <section class="m-sec m-submit">
        <h4>Submit</h4>
        ${submit}
        <form class="answer" data-m="${m.id}" novalidate>
          <label for="ans-${m.id}">${ansLabel}</label>
          <div class="ans-row">
            <input id="ans-${m.id}" name="ans-${m.id}" type="text" autocomplete="off" spellcheck="false" placeholder="${m.kind === "check" ? "ACAD-XXX-XXXX" : esc(m.placeholder)}">
            <button class="go" type="submit">${defaultLabel(m)}</button>
          </div>
          <p class="feedback" aria-live="polite"></p>
          <div class="pending" data-pending hidden>
            <div class="pend-anim" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
            <div class="pend-txt">
              <b>Checking your submission</b>
              <span data-pend-sub>The GitHub Action usually takes 1–2 minutes. If you haven't yet, click <em>Create</em> on GitHub. The result shows up here on its own.</span>
              <span class="pend-links"><a data-pend-link target="_blank" rel="noopener noreferrer" href="#">Open the issue form again</a><button class="linkbtn" type="button" data-pend-cancel="${m.id}">Stop waiting</button></span>
            </div>
          </div>
        </form>
      </section>
    </div>
  </article>`;
}
$("#acts").innerHTML = ACTS.map(a => {
  const ms = MISSIONS.filter(m => m.act === a.n);
  return `
  <section class="act" data-act="${a.n}" aria-labelledby="act-h-${a.n}">
    <div class="act-head">
      <div class="act-titles"><span class="act-num">Act ${a.roman}</span><h3 id="act-h-${a.n}">${esc(a.name)}</h3><p>${esc(a.desc)}</p></div>
      <div class="act-prog"><span data-actprog="${a.n}"></span><div class="act-bar" role="progressbar" aria-label="Act ${a.roman} progress" aria-valuemin="0" aria-valuemax="${ms.length}" aria-valuenow="0" data-actbar="${a.n}"><i></i></div></div>
    </div>
    <div class="act-list">${MISSIONS.map((m, i) => m.act === a.n ? missionHtml(m, i) : "").join("")}</div>
  </section>`;
}).join("");
/* Long commands wrap, but never inside a short flag or name such as "--prefix" or
   "docker-compose": each short hyphenated token goes in a no-wrap span. The text, and so
   what Copy copies, stays exactly the same. */
function keepTokens(pre) {
  const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT), nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    const parts = n.data.split(/(\S*-\S*)/);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (!p) return;
      if (!(i % 2)) { frag.append(p); return; }
      // keep hyphenated tokens whole; a long one (a path) may only break after a "/"
      const bits = p.length <= 22 ? [p] : p.split(/(?<=\/)/);
      bits.forEach((t, j) => { if (j) frag.append(document.createElement("wbr")); const s = document.createElement("span"); s.className = "nw"; s.textContent = t; frag.append(s); });
    });
    n.replaceWith(frag);
  }
}
document.querySelectorAll(".codeblk pre").forEach(keepTokens);
$("#order-strip").innerHTML = '<span class="os-lbl">Suggested order</span>' + MISSIONS.map((m, i) =>
  `${i ? '<span class="arrow" aria-hidden="true">&#9654;</span>' : ""}<a href="#${m.id}" data-strip="${m.id}">${m.id.toUpperCase()}</a>`).join("");

/* accordion */
function setExpanded(id, open, opts = {}) {
  MISSIONS.forEach(m => {
    const on = open && m.id === id, card = document.getElementById(m.id);
    const btn = $(".m-toggle", card), body = $(".m-body", card);
    if ((btn.getAttribute("aria-expanded") === "true") === on) return;
    btn.setAttribute("aria-expanded", String(on));
    body.hidden = !on;
    card.classList.toggle("open", on);
  });
  renderCtas();
  if (open && opts.scroll !== false) {
    const card = document.getElementById(id), top = card.getBoundingClientRect().top;
    const hud = ($(".hud") && $(".hud").getBoundingClientRect().bottom) || 0;
    if (top < hud || top > innerHeight * .6) card.scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" });
  }
}
function renderCtas() {
  const nextM = MISSIONS.find(m => !isSolved(m.id) && !S.pending[m.id]);
  MISSIONS.forEach(m => {
    const card = document.getElementById(m.id), open = card.classList.contains("open");
    $("[data-cta]", card).textContent = open ? "Close" : isSolved(m.id) ? "Review" : nextM && nextM.id === m.id ? "Start mission" : "Open";
  });
}
document.addEventListener("click", e => {
  const t = e.target.closest(".m-toggle");
  if (t) { const card = t.closest(".mission"); setExpanded(card.id, t.getAttribute("aria-expanded") !== "true"); play("tab"); return; }
  const s = e.target.closest("[data-strip]");
  if (s) { e.preventDefault(); setExpanded(s.dataset.strip, true, { scroll: false }); document.getElementById(s.dataset.strip).scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" }); $(".m-toggle", document.getElementById(s.dataset.strip)).focus({ preventScroll: true }); }
});
function openFromHash() { const id = location.hash.slice(1); if (MISSIONS.some(m => m.id === id)) setExpanded(id, true); }
window.addEventListener("hashchange", openFromHash);

/* badges grid */
const badgeHtml = b => `<div class="badge locked" data-badge="${b.id}"><span data-icon></span><div><h3>${esc(b.name)}</h3><p>${esc(b.desc)}</p></div></div>`;
$("#badges").innerHTML = BADGES.filter(b => !b.local).map(badgeHtml).join("");
$("#badges-local").innerHTML = BADGES.filter(b => b.local).map(badgeHtml).join("");
BADGES.forEach(b => { const slot = $(`[data-badge="${b.id}"] [data-icon]`); slot.replaceWith(pixelCanvas(b.map, 6)); });

const PENDING_SLOW_MS = 6 * 60 * 1000;
function renderProgress() {
  const xp = totalXp(), li = levelIndex(xp), lv = LEVELS[li], next = LEVELS[li + 1];
  $("#hud-lvl").textContent = "LV " + (li + 1);
  $("#hud-title").textContent = lv.name;
  $("#hud-xp").textContent = xp + " XP";
  const pct = next ? Math.round((xp - lv.at) / (next.at - lv.at) * 100) : 100;
  $("#hud-fill").style.width = pct + "%";
  $("#hud-bar").setAttribute("aria-valuenow", String(pct));
  $("#hud-bar").setAttribute("aria-valuetext", next ? `${xp} of ${next.at} XP to ${next.name}` : "Max level");
  const nextM = MISSIONS.find(m => !isSolved(m.id) && !S.pending[m.id]);
  const now = Date.now();
  MISSIONS.forEach(m => {
    const card = document.getElementById(m.id), solved = isSolved(m.id), pend = S.pending[m.id], isNext = !!nextM && nextM.id === m.id;
    card.classList.toggle("solved", solved);
    card.classList.toggle("is-next", isNext);
    card.classList.toggle("is-pending", !!pend && !solved);
    const xpChip = $("[data-xp]", card);
    xpChip.innerHTML = !solved && award(m) < m.xp ? `<s>${m.xp}</s> ${award(m)} XP` : `${m.xp} XP`;
    const st = $("[data-status]", card);
    st.className = "m-status" + (solved ? " done" : pend ? " pend" : isNext ? " next" : "");
    st.innerHTML = solved ? '<i aria-hidden="true">&#10003;</i>Solved' : pend ? '<i aria-hidden="true"></i>Pending' : isNext ? '<i aria-hidden="true"></i>Up next' : '<i aria-hidden="true"></i>To do';
    const hp = $("[data-hp]", card); if (hp) hp.style.width = solved ? "0%" : "100%";
    const form = $("form", card), input = $("input", form), btn = $(".go", form), fb = $(".feedback", form);
    input.disabled = solved; btn.disabled = solved;
    if (solved) {
      input.value = ""; input.placeholder = "Flag accepted"; btn.textContent = "SOLVED";
      if (!fb.classList.contains("good")) { fb.className = "feedback good"; fb.textContent = "Solved: confirmed by the GitHub Action."; }
    } else {
      input.placeholder = m.kind === "check" ? "ACAD-XXX-XXXX" : m.placeholder;
      btn.textContent = pend ? "SUBMIT AGAIN" : defaultLabel(m);
      if (fb.classList.contains("good")) { fb.textContent = ""; fb.className = "feedback"; }
    }
    const pb = $("[data-pending]", card);
    pb.hidden = !pend || solved;
    if (pend && !solved) {
      $("[data-pend-link]", pb).href = pend.url || "#";
      const slow = now - pend.at > PENDING_SLOW_MS;
      pb.classList.toggle("slow", slow);
      $("[data-pend-sub]", pb).textContent = slow
        ? "This is taking longer than usual. Check that the issue was created (link below) and that Actions are enabled in the repo."
        : "The GitHub Action usually takes 1–2 minutes. If you haven't yet, click \"Create\" on GitHub. The result shows up here on its own.";
    }
    const shown = hintsShown(m.id);
    $$(".hints li", card).forEach(li => { li.hidden = Number(li.dataset.h) > shown; });
    $$(".hint-btn", card).forEach(b => {
      b.hidden = shown >= MAX_HINTS;
      b.textContent = solved ? `Show hint ${shown + 1} (free)` : `Show hint ${shown + 1} (−${HINT_COST} XP)`;
    });
    const s = $(`[data-strip="${m.id}"]`);
    s.className = solved ? "solved" : pend ? "pend" : isNext ? "next" : "";
    s.setAttribute("aria-label", `${m.id.toUpperCase()} ${m.title}${solved ? ", solved" : pend ? ", pending" : isNext ? ", up next" : ""}`);
  });
  renderCtas();
  $$("[data-hintcost]").forEach(e => { e.textContent = HINT_COST; });
  ACTS.forEach(a => {
    const ms = MISSIONS.filter(m => m.act === a.n), done = ms.filter(m => isSolved(m.id)).length;
    $(`[data-actprog="${a.n}"]`).textContent = `${done}/${ms.length} solved`;
    const bar = $(`[data-actbar="${a.n}"]`);
    bar.setAttribute("aria-valuenow", String(done));
    $("i", bar).style.width = Math.round(done / ms.length * 100) + "%";
    bar.closest(".act").classList.toggle("act-done", done === ms.length);
  });
  const owned = ownedBadges();
  BADGES.forEach(b => { const el = $(`[data-badge="${b.id}"]`); el.classList.toggle("got", owned.has(b.id)); el.classList.toggle("locked", !owned.has(b.id)); });
  const sel = $("#team-select"), team = S.me ? S.me.team : "";
  sel.value = TEAMS.includes(team) ? team : "";
  $("#bug-count").textContent = prefs.squashed ? `Bugs squashed: ${prefs.squashed}` : "Tip: you can squash the flying bugs with a click.";
}

function renderMe() {
  const b = $("#me-btn"), link = $("#account-link"), me = S.me;
  b.classList.toggle("me-on", !!me);
  b.textContent = me ? "@" + me.login.toUpperCase() : "JOIN";
  b.title = me ? `Playing as @${me.login}${me.team ? " · " + me.team : ""}` : "Enter your GitHub login and team";
  link.textContent = me ? "My account" : "Join the game";
}
function renderAll() { renderProgress(); renderMe(); }
setInterval(() => { if (Object.keys(S.pending).length) renderProgress(); }, 30000);

/* ===================== celebrations / rejections driven by leaderboard.json ===================== */
function celebrateSolve(m, gain) {
  const card = document.getElementById(m.id); if (!card) return;
  const form = $("form", card), btn = $(".go", form), fb = $(".feedback", form);
  fb.className = "feedback good";
  fb.textContent = m.boss ? `Boss defeated! +${gain} XP. The chart tells the truth again.` : `Nailed it! The Action accepted your flag: +${gain} XP.`;
  play("correct");
  const r = btn.getBoundingClientRect();
  const visible = r.bottom > 0 && r.top < innerHeight;
  const anchor = visible ? btn : $("#hud-xp");
  const ar = anchor.getBoundingClientRect();
  floatText(anchor, `+${gain} XP`);
  burst(ar.left + ar.width / 2, ar.top + ar.height / 2, m.boss ? 160 : 70, !!m.boss);
  if (!visible) toast("FLAG ACCEPTED", `${m.id.toUpperCase()} ${m.title}: +${gain} XP`);
}
function rejectSubmission(m, r) {
  const card = document.getElementById(m.id); if (!card) return;
  const form = $("form", card), fb = $(".feedback", form);
  const issue = r.issue && S.cfgOk ? ` <a target="_blank" rel="noopener noreferrer" href="https://github.com/${encodeURIComponent(S.cfg.owner)}/${encodeURIComponent(S.cfg.repo)}/issues/${Number(r.issue)}">See the comment on issue #${Number(r.issue)}</a>.` : "";
  if (r.status === "wrong") {
    fb.className = "feedback bad";
    fb.innerHTML = (m.kind === "check"
      ? `Action: that's not a valid flag. Run <code>node check.mjs ${m.id}</code> and copy the flag from the green banner.`
      : "Action: not quite. Check the spelling or reveal a hint.") + issue;
  } else if (r.status === "limited") {
    fb.className = "feedback warn";
    fb.innerHTML = "Attempt limit reached: too many submissions in 24 hours. This one was not checked." + issue;
  } else {
    fb.className = "feedback bad";
    fb.innerHTML = "Submission rejected as invalid (for example, edited fields or a login that doesn't match the account that opened the issue)." + issue;
  }
  play("wrong"); shakeRow(form);
  const r2 = card.getBoundingClientRect();
  if (r2.bottom < 0 || r2.top > innerHeight) toast("SUBMISSION REJECTED", `${m.id.toUpperCase()}: ${r.status === "wrong" ? "wrong answer" : r.status === "limited" ? "attempt limit" : "invalid submission"}.`);
}

/* ===================== interactions ===================== */
function defaultLabel(m) { return m.kind === "check" ? "SUBMIT FLAG" : "SUBMIT ANSWER"; }
function shakeRow(form) { const row = $(".ans-row", form); row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }

document.addEventListener("submit", async e => {
  const form = e.target.closest("form.answer"); if (!form) return;
  e.preventDefault();
  const id = form.dataset.m, m = MISSIONS.find(x => x.id === id), input = $("input", form), fb = $(".feedback", form), btn = $(".go", form);
  if (isSolved(id) || form.dataset.busy) return;
  if (!input.value.trim()) { fb.className = "feedback bad"; fb.textContent = m.kind === "check" ? "Paste the flag from the check.mjs banner." : "Type your answer."; input.focus(); return; }
  if (!S.cfgOk) { fb.className = "feedback bad"; fb.textContent = "The trainer hasn't configured the site yet (owner/repo and submitKey in site/config.json), so flags can't be submitted."; play("wrong"); return; }
  if (!S.me || !S.me.team) {
    fb.className = "feedback warn"; fb.textContent = "Enter your GitHub login and team first. Your answer stays in the field.";
    S.obDismissed = false; openDialog("join"); return;
  }
  // Open the tab synchronously inside the click/submit (popup blockers), then navigate it once the answer is sealed.
  let win = null;
  try { win = window.open("about:blank", "_blank"); } catch (err) { win = null; }
  form.dataset.busy = "1"; btn.classList.add("busy");
  try {
    const sealed = await sealSubmission(S.cfg.submitKey, { login: S.me.login, missionId: id, answer: input.value, hints: hintsPaid(id) }, { cryptoKey: await S.sealKey });
    const url = buildIssueUrl(S.cfg, { missionId: id, sealed, hints: hintsPaid(id), team: S.me.team, login: S.me.login });
    if (win) { try { win.opener = null; win.location.href = url; } catch (err) { win = null; } }
    const res = myResults();
    S.pending[id] = { at: Date.now(), prevAt: (res[id] && res[id].at) || null, prevAny: (res._ && res._.at) || null, url };
    savePending();
    fb.className = "feedback warn";
    fb.innerHTML = win
      ? "We opened the issue form on GitHub in a new tab. Click <b>Create</b> there. Your answer is encrypted in the issue and only the GitHub Action can read it."
      : "Your browser blocked the new tab. Click <b>Open the issue form again</b> below, then <b>Create</b> on GitHub.";
    play("click"); floatText(btn, "SENT!");
    renderProgress();
    pollBoard(true);
  } catch (err) {
    if (win) try { win.close(); } catch (e2) { /* ignore */ }
    fb.className = "feedback bad"; fb.textContent = "Couldn't encrypt your submission in this browser: " + err.message;
  } finally { delete form.dataset.busy; btn.classList.remove("busy"); }
});

document.addEventListener("click", e => {
  const hb = e.target.closest(".hint-btn");
  if (hb) {
    const id = hb.dataset.m, solved = isSolved(id), shown = hintsShown(id);
    if (shown >= MAX_HINTS) return;
    const n = shown + 1;
    play("hint");
    S.hints.shown[id] = n;
    if (!solved) { S.hints.paid[id] = Math.min(MAX_HINTS, hintsPaid(id) + 1); floatText(hb, `−${HINT_COST} XP`, true); }
    saveHints();
    renderProgress();
    if (!solved && !store.get(K.honor, false)) {
      store.set(K.honor, true);
      toast("HONOR SYSTEM", `The number of hints you revealed goes into your submission (−${HINT_COST} XP each).`);
    }
    const li = $(`#panel-${id}-${prefs.tool} .hints li[data-h="${n}"]`);
    if (li) { li.setAttribute("tabindex", "-1"); li.focus({ preventScroll: true }); }
    return;
  }
  const cancel = e.target.closest("[data-pend-cancel]");
  if (cancel) {
    const id = cancel.dataset.pendCancel; delete S.pending[id]; savePending();
    const fb = $(`#${id} .feedback`); fb.className = "feedback"; fb.textContent = "Stopped waiting. If the issue was created, the result will still show up on the leaderboard.";
    play("tab"); renderProgress(); return;
  }
  const tab = e.target.closest(".mission .tab");
  if (tab) { selectTool(tab.dataset.tool, tab); play("tab"); return; }
  const cp = e.target.closest(".copy");
  if (cp) { copyFrom(cp); return; }
  const go = e.target.closest(".go, .start-btn, .pbtn:not(#sound-btn)");
  if (go) play("click");
});

function selectTool(tool, focusTab) {
  prefs.tool = tool; savePrefs();
  MISSIONS.forEach(m => ["copilot", "claude"].forEach(t => {
    const on = t === tool, tb = document.getElementById(`tab-${m.id}-${t}`);
    tb.setAttribute("aria-selected", String(on)); tb.tabIndex = on ? 0 : -1;
    document.getElementById(`panel-${m.id}-${t}`).hidden = !on;
  }));
  if (focusTab) { const card = focusTab.closest(".mission"); document.getElementById(`tab-${card.id}-${tool}`).focus(); }
}
document.addEventListener("keydown", e => {
  const tab = e.target.closest && e.target.closest(".mission .tab");
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  selectTool(tab.dataset.tool === "copilot" ? "claude" : "copilot", tab); play("tab");
});

function copyFrom(btn) {
  const pre = $("pre, .rcode", btn.closest(".codeblk, .rcode-box") || btn.parentElement), text = pre.textContent;
  const done = () => { btn.textContent = "Copied"; btn.classList.add("done"); play("copy"); setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600); };
  const fallback = () => {
    const r = document.createRange(); r.selectNodeContents(pre);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    btn.textContent = "Press Cmd+C"; setTimeout(() => { btn.textContent = "Copy"; }, 2200);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  } catch (err) { fallback(); }
}


/* ===================== identity dialog (GitHub login + team) / account ===================== */
const OB = { el: $("#onboard"), view: null, lastFocus: null, team: "", clearArmed: 0 };
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select, [href], [tabindex]:not([tabindex='-1'])";
function openDialog(view) {
  if (!$("#levelup").hidden) hideLevelUp();
  if (OB.el.hidden) OB.lastFocus = document.activeElement;
  OB.view = view;
  $$(".ob-view", OB.el).forEach(v => { v.hidden = v.dataset.view !== view; });
  if (view === "join") {
    if (S.me && !$("#join-login").value) $("#join-login").value = S.me.login;
    OB.team = OB.team || (S.me && S.me.team) || "";
    populateTeams(); previewLogin();
  }
  if (view === "account") renderAccount();
  OB.el.hidden = false;
  const box = $(`.ob-view[data-view="${view}"]`, OB.el);
  const first = $("input, .team-chip, .go", box) || $(FOCUSABLE, box);
  if (first) setTimeout(() => first.focus(), 30);
}
function closeDialog() {
  if (OB.el.hidden) return;
  if (OB.view === "join") S.obDismissed = true;
  OB.el.hidden = true; OB.view = null;
  if (OB.lastFocus && OB.lastFocus.focus) OB.lastFocus.focus();
}
$("#ob-close").addEventListener("click", closeDialog);
OB.el.addEventListener("click", e => {
  if (e.target === OB.el) closeDialog();
  const go = e.target.closest("[data-goto]"); if (go) { play("tab"); openDialog(go.dataset.goto); return; }
  if (e.target.closest("[data-close]")) { closeDialog(); return; }
  const chip = e.target.closest(".team-chip");
  if (chip) {
    const t = chip.dataset.team;
    OB.team = OB.team === t ? "" : t;
    $$(".team-chip", chip.parentElement).forEach(c => c.setAttribute("aria-checked", String(OB.team === c.dataset.team)));
    play("tab");
  }
});
document.addEventListener("keydown", e => {
  if (OB.el.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closeDialog(); return; }
  if (e.key !== "Tab") return;
  const box = $(`.ob-view[data-view="${OB.view}"]`, OB.el);
  const items = [$("#ob-close"), ...$$(FOCUSABLE, box)].filter(el => !el.hidden && el.offsetParent !== null);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  if (e.shiftKey && (i <= 0)) { e.preventDefault(); items[items.length - 1].focus(); }
  else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
});
function openJoin() { openDialog(S.me ? "account" : "join"); }
$("#me-btn").addEventListener("click", openJoin);
$("#account-link").addEventListener("click", openJoin);

function fbSet(el, cls, text) { el.className = "feedback" + (cls ? " " + cls : ""); el.textContent = text; }

/** GitHub avatar with a pixel-art fallback (offline, unknown login, blocked images). */
function avatarEl(login, cls) {
  if (!isValidLogin(login)) { const cv = avatar(String(login || "?")); cv.className = (cls || "ava") + " px"; return cv; }
  const img = new Image();
  img.className = cls || "ava"; img.alt = ""; img.width = 36; img.height = 36; img.loading = "lazy"; img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => { const cv = avatar(login); cv.className = img.className + " px"; img.replaceWith(cv); }, { once: true });
  img.src = `https://github.com/${encodeURIComponent(String(login).trim().replace(/^@/, ""))}.png?size=64`;
  return img;
}
let pvT = 0;
function previewLogin() {
  const v = $("#join-login").value.trim().replace(/^@/, ""), box = $("#join-ava");
  clearTimeout(pvT);
  if (!isValidLogin(v)) { box.replaceChildren(); box.hidden = true; return; }
  pvT = setTimeout(() => { box.replaceChildren(avatarEl(v, "ava big")); box.hidden = false; }, 350);
}
$("#join-login").addEventListener("input", previewLogin);

$("#join-form").addEventListener("submit", e => {
  e.preventDefault();
  const raw = $("#join-login").value.trim().replace(/^@/, ""), fb = $("#join-fb");
  if (!isValidLogin(raw)) { fbSet(fb, "bad", "That doesn't look like a GitHub login: 1–39 characters, letters, digits and single hyphens (no @ or spaces)."); play("wrong"); $("#join-login").focus(); return; }
  if (!OB.team) { fbSet(fb, "bad", "Pick your team."); play("wrong"); return; }
  const changed = !S.me || normalizeLogin(S.me.login) !== normalizeLogin(raw);
  S.me = { login: raw, team: OB.team }; saveMe();
  if (changed) { S.pending = {}; savePending(); }
  fbSet(fb, "", "");
  closeDialog(); play("correct"); burst(innerWidth / 2, innerHeight * .35, 60, false);
  toast("WELCOME, AGENT", `@${raw} · ${OB.team}. Your first mission is M1. Good luck!`);
  populateTeams(); renderAll();
  if (S.board) applyBoard(S.board);
  boardStatus();
});

function renderAccount() {
  const me = S.me; if (!me) return;
  $("#acc-nick").textContent = "@" + me.login;
  $("#acc-ava").replaceChildren(avatarEl(me.login, "ava big"));
  $("#acc-sub").textContent = `${me.team ? "Team: " + me.team : "No team"} · ${S.player ? "on the leaderboard" : "you'll appear on the leaderboard after your first flag"}`;
  const stat = (v, l) => { const d = document.createElement("div"), b = document.createElement("b"), s = document.createElement("span"); b.textContent = v; s.textContent = l; d.append(b, s); return d; };
  const solvedN = MISSIONS.filter(m => isSolved(m.id)).length;
  $("#acc-stats").replaceChildren(stat(totalXp() + " XP", "LV " + (levelIndex(totalXp()) + 1)), stat(`${solvedN}/${MISSIONS.length}`, "missions"), stat(String(ownedBadges().size), "badges"));
  fbSet($("#acc-fb"), "", "");
  OB.clearArmed = 0; $("#acc-clear").textContent = "CLEAR";
}
$("#acc-edit").addEventListener("click", () => { OB.team = S.me ? S.me.team : ""; $("#join-login").value = S.me ? S.me.login : ""; openDialog("join"); });
$("#acc-clear").addEventListener("click", () => {
  const b = $("#acc-clear");
  if (Date.now() - OB.clearArmed > 4000) { OB.clearArmed = Date.now(); b.textContent = "SURE?"; fbSet($("#acc-fb"), "warn", "This removes your login, revealed hints, pending submissions and local badges from this browser. Your leaderboard results stay. Click again to confirm."); return; }
  [K.me, K.hints, K.pending, K.seen, K.local, K.honor].forEach(k => store.del(k));
  S.me = null; S.player = null; S.hints = { shown: {}, paid: {} }; S.pending = {}; S.seen = null; S.local = []; OB.team = "";
  $("#join-login").value = "";
  renderAll(); renderBoard(); boardStatus();
  toast("CLEARED", "Local data removed. Your leaderboard results are safe.");
  openDialog("join");
});

/* ===================== ranking ===================== */
function setMsg(text, action) {
  const el = $("#board-msg"); el.textContent = "";
  const s = document.createElement("span"); s.textContent = text; el.appendChild(s);
  if (action) {
    const b = document.createElement("button"); b.className = "pbtn"; b.type = "button"; b.textContent = action.label;
    b.addEventListener("click", action.run); el.appendChild(b);
  }
}
function boardStatus() {
  if (S.online === false) { setMsg("Couldn't load the leaderboard. We'll try again in a moment.", { label: "RETRY", run: () => pollBoard(true) }); return; }
  if (!R.loaded) { setMsg("Loading the leaderboard…"); return; }
  const when = S.board && S.board.generatedAt ? ` Last update: ${new Date(S.board.generatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}.` : "";
  if (S.me) setMsg(`Playing as @${S.me.login}${S.me.team ? " · " + S.me.team : ""}. A GitHub Action scores each submission (about 1–2 minutes); this page checks every ${Math.round(POLL_MS / 1000)} s.${when}`);
  else setMsg("Enter your GitHub login and team to submit flags and appear on the leaderboard." + when, { label: "JOIN", run: () => openDialog("join") });
}

function avatar(nick) {
  let h = 2166136261;
  for (const ch of String(nick).toLowerCase()) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  h >>>= 0;
  const col = ["a", "c", "y", "p", "g"][h % 5];
  let bits = h >>> 3;
  const rows = ["......."];
  for (let y = 0; y < 5; y++) {
    const half = [];
    for (let x = 0; x < 3; x++) { half.push(bits & 1 ? col : "."); bits >>>= 1; }
    rows.push("." + half.join("") + half[1] + half[0] + ".");
  }
  rows.push(".......");
  if (!rows.some(r => r.includes(col))) rows[3] = "...".concat(col, "...");
  const cv = pixelCanvas(rows, 6); cv.className = "ava"; cv.setAttribute("aria-hidden", "true");
  return cv;
}
const plural = n => n === 1 ? "player" : "players";
function emptyState(title, text) {
  const d = document.createElement("div"); d.className = "empty";
  const b = document.createElement("b"); b.textContent = title;
  const s = document.createElement("span"); s.textContent = text;
  d.append(b, s); return d;
}
function renderBoard() {
  const panel = $("#rpanel");
  const players = S.board ? S.board.players : [];
  if (!R.loaded && S.online !== false) { panel.replaceChildren(emptyState("LOADING…", "Fetching the leaderboard.")); return; }
  if (!players.length) {
    panel.replaceChildren(S.online === false && !S.board
      ? emptyState("LEADERBOARD UNAVAILABLE", "Couldn't load the leaderboard. Missions and flag submission still work, and the leaderboard will come back on its own.")
      : emptyState("NO SCORES YET", "The leaderboard fills up after the first accepted flag. Submit yours and take the #1 spot."));
    return;
  }
  const key = myKey();
  const ul = document.createElement("ol"); ul.className = "rows";
  if (R.view === "teams") {
    const teams = S.board.teams;
    if (!teams.length) { panel.replaceChildren(emptyState("NO TEAMS YET", "Nobody has submitted a flag with a team yet.")); return; }
    const top = (teams[0] && teams[0].xp) || 1;
    teams.forEach((t, i) => {
      const li = document.createElement("li"); li.className = "row teamrow" + (S.me && S.me.team && t.team === S.me.team ? " me" : "");
      const rk = document.createElement("span"); rk.className = "rk"; rk.textContent = i + 1;
      const who = document.createElement("div"); who.className = "who";
      const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = t.team;
      const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = `${t.players} ${plural(t.players)} · avg ${t.avgXp} XP`;
      const bar = document.createElement("div"); bar.className = "tbar"; const bi = document.createElement("i"); bi.style.width = Math.max(0, Math.min(100, Math.round(t.xp / top * 100))) + "%"; bar.appendChild(bi);
      who.append(nm, sub, bar);
      const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = t.xp + " XP";
      li.append(rk, who, pts); ul.appendChild(li);
    });
    panel.replaceChildren(ul);
    return;
  }
  players.forEach((p, i) => {
    const me = key && normalizeLogin(p.login) === key;
    const li = document.createElement("li"); li.className = "row" + (me ? " me" : "");
    const rk = document.createElement("span"); rk.className = "rk"; rk.textContent = i + 1;
    const who = document.createElement("div"); who.className = "who";
    const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = "@" + p.login + (me ? " (you)" : "");
    const sub = document.createElement("div"); sub.className = "sub";
    const team = document.createElement("span"); team.textContent = p.team || "no team";
    const solvedN = MISSIONS.filter(m => p.solved[m.id]).length;
    const dots = document.createElement("span"); dots.className = "dots"; dots.setAttribute("aria-label", `${solvedN} of ${MISSIONS.length} missions`);
    MISSIONS.forEach(m => { const d = document.createElement("i"); if (p.solved[m.id]) d.className = "on"; dots.appendChild(d); });
    const bc = document.createElement("span"); bc.textContent = p.badges.length ? `${p.badges.length} ${p.badges.length === 1 ? "badge" : "badges"}` : "";
    sub.append(team, dots, bc); who.append(nm, sub);
    const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = p.xp + " XP";
    li.append(rk, avatarEl(p.login), who, pts); ul.appendChild(li);
  });
  panel.replaceChildren(ul);
}
function setView(v) {
  R.view = v;
  ["players", "teams"].forEach(k => { const t = document.getElementById("rtab-" + k); t.setAttribute("aria-selected", String(k === v)); });
  $("#rpanel").setAttribute("aria-labelledby", "rtab-" + v);
  renderBoard();
}
$("#rtab-players").addEventListener("click", () => { setView("players"); play("tab"); });
$("#rtab-teams").addEventListener("click", () => { setView("teams"); play("tab"); });
$("#team-select").addEventListener("change", e => {
  const v = TEAMS.includes(e.target.value) ? e.target.value : "";
  if (!S.me) { OB.team = v; openDialog("join"); renderProgress(); return; }
  if (!v || v === S.me.team) { renderProgress(); return; }
  S.me.team = v; saveMe(); play("click"); renderAll(); boardStatus();
  toast("TEAM CHANGED", `${v}. The leaderboard updates with your next flag submission.`);
});

/* cosmetic badges: kept only in this browser */
function grantLocal(id) {
  if (S.local.includes(id)) return;
  S.local.push(id); saveLocal(); renderProgress();
  const b = BADGES.find(x => x.id === id);
  setTimeout(() => { toast("LOCAL BADGE", b.name + " (this browser only)", b.map); play("badge"); }, 300);
}
function onSquash() {
  prefs.squashed = (prefs.squashed || 0) + 1; savePrefs();
  renderProgress();
  if (prefs.squashed >= 5) grantLocal("squash");
}

/* ===================== ambient sky: stars, glyphs, rockets, bugs ===================== */
const sky = { cv: $("#sky"), ctx: null, cv2: $("#crawl"), ctx2: null, combo: 0, lastSquash: 0, W: 0, H: 0, stars: [], glyphs: [], rockets: [], bugs: [], splats: [], t: 0, raf: 0, last: 0, nextRocket: 3, nextBug: 4 };
sky.ctx = sky.cv.getContext("2d"); sky.ctx2 = sky.cv2.getContext("2d");
const GLYPHS = [">", "_", "{", "}", "$", "⌘", "/", "@", "!", "#", "</>", "~", "*", ";"];
const ROCKET = ["..a..", ".aaa.", ".aya.", ".aaa.", ".aaa.", "aacaa", "a.c.a"];
const BUG_A = ["p.....p", ".p...p.", "..kkk..", "lcccccl", ".ccpcc.", "lcccccl", ".ccccc.", "l.....l"];
const BUG_B = ["p.....p", ".p...p.", "..kkk..", ".ccccc.", "lccpccl", ".ccccc.", "lcccccl", "......."];
let skyCols = {};
function readCols() { skyCols = { a: cssVar("--amber"), c: cssVar("--coral"), y: cssVar("--cyan"), p: cssVar("--paper"), k: "#2a0b17", l: cssVar("--coral") }; }
function drawMap(c, map, px, x, y) {
  const h = map.length, w = map[0].length, ox = x - w * px / 2, oy = y - h * px / 2;
  for (let r = 0; r < h; r++) { const row = map[r]; for (let i = 0; i < w; i++) { const ch = row[i]; if (ch !== "." && skyCols[ch]) { c.fillStyle = skyCols[ch]; c.fillRect(Math.round(ox + i * px), Math.round(oy + r * px), px, px); } } }
}
/* keep-out zones: glyphs, stars, rockets and bugs never cross free-standing text (hero, section and act headers) */
const KEEP_SEL = ".hero h1, .hero-lead, .hero-cta, .stats, .alert-tag, .sec-head > *, .act-head > *, .order-strip, footer .wrap > *";
sky.keep = []; sky.keepDirty = true; sky.keepT = 0;
function readKeep() {
  const pad = 12; sky.keep = [];
  for (const e of document.querySelectorAll(KEEP_SEL)) {
    const r = e.getBoundingClientRect();
    if (!r.width || r.bottom < -40 || r.top > sky.H + 40) continue;
    sky.keep.push([r.left - pad, r.top - pad, r.right + pad, r.bottom + pad]);
  }
  sky.keepDirty = false;
}
function inKeep(x, y, m = 0) { for (const k of sky.keep) if (x > k[0] - m && x < k[2] + m && y > k[1] - m && y < k[3] + m) return true; return false; }
window.addEventListener("scroll", () => { sky.keepDirty = true; if (reduceMotion.matches) drawSky(); }, { passive: true });
function glyphX(g) { return g.x + Math.sin(sky.t * .7 + g.ph) * g.amp; }
function glyphHidden(g) { const w = g.size * .6 * g.ch.length; return inKeep(glyphX(g) + w / 2, g.y - g.size * .35, g.size * .6 + w / 2); }
function sizeSky() {
  const d = Math.min(2, window.devicePixelRatio || 1);
  sky.W = innerWidth; sky.H = innerHeight;
  sky.cv.width = sky.W * d; sky.cv.height = sky.H * d; sky.ctx.setTransform(d, 0, 0, d, 0, 0);
  sky.cv2.width = sky.W * d; sky.cv2.height = sky.H * d; sky.ctx2.setTransform(d, 0, 0, d, 0, 0);
  const area = sky.W * sky.H;
  const nStars = Math.min(140, Math.round(area / 9000));
  sky.stars = Array.from({ length: nStars }, () => ({ x: Math.random() * sky.W, y: Math.random() * sky.H, s: Math.random() < .2 ? 2 : 1, ph: Math.random() * 6.28 }));
  const nG = Math.max(10, Math.min(34, Math.round(area / 32000)));
  const cols = ["a", "c", "y", "p"];
  sky.glyphs = Array.from({ length: nG }, () => ({ x: Math.random() * sky.W, y: Math.random() * sky.H, ch: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], col: cols[Math.floor(Math.random() * 4)], size: 12 + Math.random() * 14, vy: 6 + Math.random() * 16, amp: 6 + Math.random() * 14, ph: Math.random() * 6.28, al: .12 + Math.random() * .22 }));
  sizeFx();
  if (reduceMotion.matches) drawSky(0);
}
function spawnRocket() {
  const fromLeft = Math.random() < .5, y = sky.H * (.45 + Math.random() * .5);
  const vx = (fromLeft ? 1 : -1) * (90 + Math.random() * 70), vy = -(50 + Math.random() * 60);
  sky.rockets.push({ x: fromLeft ? -30 : sky.W + 30, y, vx, vy, t: 0 });
}
function spawnBug() {
  const side = Math.floor(Math.random() * 4), m = 30;
  const x = side === 0 ? -m : side === 1 ? sky.W + m : Math.random() * sky.W;
  const y = side === 2 ? -m : side === 3 ? sky.H + m : Math.random() * sky.H;
  const tx = sky.W * (.2 + Math.random() * .6), ty = sky.H * (.2 + Math.random() * .6), a = Math.atan2(ty - y, tx - x);
  sky.bugs.push({ x, y, a, sp: 26 + Math.random() * 22, t: 0, life: 22 + Math.random() * 14 });
}
function updateSky(dt) {
  sky.t += dt;
  if ((sky.keepT -= dt) <= 0) { sky.keepDirty = true; sky.keepT = .4; } /* layout can move (accordion, toasts, fonts) */
  if (sky.keepDirty) readKeep();
  const fade = Math.min(1, dt * 6);
  for (const g of sky.glyphs) { g.y -= g.vy * dt; if (g.y < -30) { g.y = sky.H + 30; g.x = Math.random() * sky.W; } g.f = (g.f ?? 1) + ((glyphHidden(g) ? 0 : 1) - (g.f ?? 1)) * fade; }
  if ((sky.nextRocket -= dt) <= 0) { spawnRocket(); sky.nextRocket = 7 + Math.random() * 9; }
  sky.rockets = sky.rockets.filter(r => { r.t += dt; r.x += r.vx * dt; r.y += r.vy * dt; r.f = (r.f ?? 1) + ((inKeep(r.x, r.y, 24) ? 0 : 1) - (r.f ?? 1)) * fade; return r.x > -60 && r.x < sky.W + 60 && r.y > -60; });
  if ((sky.nextBug -= dt) <= 0) { if (sky.bugs.length < 3) spawnBug(); sky.nextBug = 6 + Math.random() * 8; }
  sky.bugs = sky.bugs.filter(b => {
    b.t += dt; b.a += (Math.random() - .5) * 2.2 * dt;
    if (b.t < b.life) { /* keep the bug on screen until its life ends, then let it wander off */
      if (b.x < 40) b.a = 0; if (b.x > sky.W - 40) b.a = Math.PI; if (b.y < 70) b.a = Math.PI / 2; if (b.y > sky.H - 40) b.a = -Math.PI / 2; }
    { /* bounce off text zones instead of crawling over words */
      const nx = b.x + Math.cos(b.a) * b.sp * dt, ny = b.y + Math.sin(b.a) * b.sp * dt;
      b.inText = inKeep(b.x, b.y, 14);
      if (!b.inText && inKeep(nx, ny, 14)) { b.a = inKeep(nx, b.y, 14) ? Math.PI - b.a : -b.a; }
      else { b.x = nx; b.y = ny; }
    }
    return b.x > -80 && b.x < sky.W + 80 && b.y > -80 && b.y < sky.H + 80;
  });
  sky.splats = sky.splats.filter(s => (s.t += dt) < 1.2);
}
function drawSky() {
  const c = sky.ctx, t = sky.t;
  c.clearRect(0, 0, sky.W, sky.H);
  c.fillStyle = skyCols.p;
  if (sky.keepDirty) readKeep();
  for (const s of sky.stars) { if (inKeep(s.x, s.y)) continue; c.globalAlpha = .25 + .45 * (0.5 + 0.5 * Math.sin(t * 1.6 + s.ph)); c.fillRect(Math.round(s.x), Math.round(s.y), s.s, s.s); }
  for (const g of sky.glyphs) {
    const f = reduceMotion.matches ? (glyphHidden(g) ? 0 : 1) : (g.f ?? 1);
    if (f < .02) continue;
    c.globalAlpha = g.al * f; c.fillStyle = skyCols[g.col];
    c.font = `600 ${g.size | 0}px "JetBrains Mono", monospace`;
    c.fillText(g.ch, glyphX(g), g.y);
  }
  for (const r of sky.rockets) {
    c.globalAlpha = .9 * (r.f ?? 1); if (c.globalAlpha < .02) continue;
    c.save(); c.translate(r.x, r.y); c.rotate(Math.atan2(r.vy, r.vx) + Math.PI / 2);
    const flick = (Math.floor(t * 14) % 2);
    c.fillStyle = skyCols.c; c.fillRect(-3, 11, 6, 4 + flick * 3);
    c.fillStyle = skyCols.a; c.fillRect(-1.5, 12, 3, 3 + flick * 2);
    drawMap(c, ROCKET, 3, 0, 0);
    c.restore();
  }
  c.globalAlpha = 1;
  const c2 = sky.ctx2; c2.clearRect(0, 0, sky.W, sky.H);
  for (const b of sky.bugs) {
    c2.globalAlpha = b.inText ? .2 : 1;
    /* soft shadow under the bug */
    c2.fillStyle = "rgba(7,8,28,.45)"; c2.fillRect(Math.round(b.x - 9), Math.round(b.y + 10), 18, 4);
    c2.save(); c2.translate(b.x, b.y); c2.rotate(b.a + Math.PI / 2);
    drawMap(c2, (Math.floor(b.t * 8) % 2) ? BUG_A : BUG_B, 3, 0, 0);
    c2.restore();
  }
  c2.globalAlpha = 1;
  c2.textAlign = "center";
  for (const s of sky.splats) {
    c2.globalAlpha = Math.max(0, 1 - s.t / 1.2); c2.fillStyle = skyCols.c;
    for (const p of s.p) c2.fillRect(Math.round(s.x + p[0] * (1 + s.t * 2)), Math.round(s.y + p[1] * (1 + s.t * 2)), 3, 3);
    c2.fillStyle = "#07081c"; c2.font = '10px "Press Start 2P", monospace'; c2.fillText(s.label, s.x + 2, s.y - 16 - s.t * 24);
    c2.fillStyle = skyCols.a; c2.fillText(s.label, s.x, s.y - 18 - s.t * 24);
  }
  c2.globalAlpha = 1; c2.textAlign = "start";
}
function skyLoop(now) {
  const dt = Math.min(.05, (now - sky.last) / 1000 || 0); sky.last = now;
  updateSky(dt); drawSky();
  sky.raf = requestAnimationFrame(skyLoop);
}
function startSky() {
  cancelAnimationFrame(sky.raf); sky.raf = 0;
  if (reduceMotion.matches) {
    if (!sky.bugs.length) { spawnBug(); const b = sky.bugs[0]; b.x = sky.W * .82; b.y = sky.H * .7; b.life = 1e9; }
    drawSky(); return;
  }
  if (document.hidden) return;
  sky.last = performance.now(); sky.raf = requestAnimationFrame(skyLoop);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(sky.raf); sky.raf = 0; } else startSky(); });
if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", startSky);
let rsT = 0;
window.addEventListener("resize", () => { clearTimeout(rsT); rsT = setTimeout(() => { sizeSky(); if (reduceMotion.matches) drawSky(); }, 120); });

/* bugs live behind the content, so anything solid on top of them blocks the squash */
const INTERACTIVE = "a, button, input, select, textarea, label, pre, code, summary, [role='tab'], .overlay, .mission, .step, .board, .habit, .badge, .cabinet, .hud, .toast";
function bugAt(x, y) { return sky.bugs.find(b => Math.hypot(b.x - x, b.y - y) < 22); }
document.addEventListener("pointerdown", e => {
  if (e.target.closest && e.target.closest(INTERACTIVE)) return;
  const b = bugAt(e.clientX, e.clientY); if (!b) return;
  sky.bugs = sky.bugs.filter(x => x !== b);
  const now = performance.now();
  sky.combo = now - sky.lastSquash < 2500 ? sky.combo + 1 : 1; sky.lastSquash = now;
  const label = sky.combo > 1 ? `COMBO x${sky.combo}!` : "SQUASH!";
  if (!reduceMotion.matches) sky.splats.push({ x: b.x, y: b.y, t: 0, label, p: Array.from({ length: 12 }, () => [(Math.random() - .5) * 28, (Math.random() - .5) * 28]) });
  audio(); play("squash"); if (sky.combo > 1) setTimeout(() => play("combo"), 120);
  if (sky.bugs.length === 0 && !reduceMotion.matches) sky.nextBug = Math.min(sky.nextBug, 2.5);
  burst(b.x, b.y, 18, false);
  document.documentElement.classList.remove("bug-hover");
  onSquash();
  if (reduceMotion.matches) drawSky();
});
let pmT = 0;
document.addEventListener("pointermove", e => {
  const now = performance.now(); if (now - pmT < 60) return; pmT = now;
  const over = !(e.target.closest && e.target.closest(INTERACTIVE)) && !!bugAt(e.clientX, e.clientY);
  document.documentElement.classList.toggle("bug-hover", over);
}, { passive: true });

/* boss warning: first time the boss card scrolls into view */
let bossWarned = false;
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(entries => {
    if (bossWarned || !entries.some(e => e.isIntersecting) || isSolved("m8")) return;
    bossWarned = true; io.disconnect();
    play("siren");
    if (reduceMotion.matches) return;
    const a = document.createElement("div"); a.className = "boss-alert"; a.setAttribute("aria-hidden", "true");
    const b = document.createElement("b"); b.textContent = "! WARNING: BOSS INCOMING !";
    const sm = document.createElement("small"); sm.textContent = "M8 · The Chart Lies · two bugs, two layers";
    a.append(b, sm); document.body.appendChild(a);
    setTimeout(() => a.remove(), 2900);
  }, { threshold: .3 });
  io.observe(document.getElementById("m8"));
}

/* Konami code: a fleet of rockets, just for fun */
const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
let kIdx = 0;
document.addEventListener("keydown", e => {
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  kIdx = k === KONAMI[kIdx] ? kIdx + 1 : (k === KONAMI[0] ? 1 : 0);
  if (kIdx < KONAMI.length) return;
  kIdx = 0;
  play("konami"); toast("KONAMI CODE", "+30 rockets. No XP for this, but respect."); grantLocal("konami");
  if (!reduceMotion.matches) { for (let i = 0; i < 30; i++) setTimeout(spawnRocket, i * 90); burst(innerWidth / 2, innerHeight * .6, 120, true); }
});

/* ===================== boot ===================== */
readCols();
renderSoundBtn();
populateTeams();
renderAll();
sizeSky();
startSky();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (reduceMotion.matches) drawSky(); });
setMsg("Loading the leaderboard…");
renderBoard();
openFromHash();
loadConfig().then(() => {
  pollBoard(true);
  if (!S.me && !S.obDismissed && $("#onboard").hidden) openDialog("join");
});
})();
