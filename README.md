# Agent Academy: GitHub Pages edition (no server)

The same training site as `academy/` (missions, XP, levels, badges, sounds, flying bugs, the boss),
but **without any server**:

- the site is a set of static files in `site/`, published on **GitHub Pages**,
- players submit a flag as an **issue** (the site fills in the form for them),
- a **GitHub Action** checks the submission, updates the leaderboard (`site/data/leaderboard.json`),
  comments, closes and locks the issue, then republishes the site.

No npm dependencies. For local work you only need Node 22+. All instructions below are for **macOS**
(Apple silicon or Intel) with [Homebrew](https://brew.sh); run the commands in Terminal.app or iTerm2.

```
.github/ISSUE_TEMPLATE/flag.yml   flag submission form (fields: mission, sealed, hints, team, login)
.github/workflows/flag.yml        flag verification + Pages publishing
.github/workflows/pages.yml       Pages publishing after a push to main / on demand
.github/scripts/verify-flag.mjs   verifier (parsing, limits, XP, badges, leaderboard, comments)
.github/scripts/rules.mjs         game rules copied from academy/missions.mjs (no answer hashes)
.github/scripts/sealed.mjs        decryption and validation of submissions (RSA-OAEP), keys and rotation
site/                             the site (index.html, app.js, app.css, seal.js, config.json, data/)
state/                            game state: players.json, attempts.json (outside site/, not published on Pages)
scripts/                          gen-keys, set-answers, preview, simulate, reset-state
tests/                            node:test
```

---

## Trainer prerequisites (macOS)

```bash
brew install git node gh      # Node 22+ and the GitHub CLI
gh auth login                 # sign in to github.com (HTTPS, browser login is fine)
node -v && gh --version
```

`gh` is used to create the label, set the repository secrets and manage issues. Everything else runs with plain Node.

---

## How a flag submission works

1. On the first visit the player enters their **GitHub login** and **team** (stored in `localStorage`).
2. They type the answer/flag and click **Submit flag** (or **Submit answer**). The browser (Web Crypto) encrypts
   `{v: 2, kid, login (lowercase), mission, answer (normalized: trim → lowercase → no whitespace), hints, nonce (16 random bytes, hex), ts (ISO)}`
   with **RSA-OAEP (3072 bit, SHA-256)** using the public key from `config.json` (`submitKey`) and opens
   `https://github.com/<owner>/<repo>/issues/new?template=flag.yml&title=…&mission=…&sealed=…&hints=…&team=…&login=…`
   (the `sealed` field is 512 base64url characters, the whole link about 0.7 KB). **The answer is only in the issue in encrypted form.**
   Only the Action can read it, because it holds the private key in the `SUBMIT_PRIVATE_KEY` secret.
3. The player clicks **Create** on GitHub. The mission card shows a "Checking your submission" state.
4. The `flag.yml` workflow (`issues: opened` event) runs `verify-flag.mjs`, which:
   - takes identity **only from the issue author** (`issue.user.login`), never from the form,
   - decrypts the `sealed` field and trusts **only** the decrypted content (mission, answer, hints, login);
     the login inside must be the issue author (someone else's encrypted blob is useless), each `nonce` works once,
     and `ts` can't be more than 10 minutes in the future or older than 7 days,
   - compares the answer with the `ANSWERS` secret in constant time,
   - validates the visible fields (mission m1–m8, hints 0–2, a team from `config.json`, login matching the author) and
     rejects the submission (`invalid`) when they don't match the encrypted content,
   - enforces limits (5 wrong attempts per mission per person in 24 hours, 30 submissions per person in 24 hours),
   - computes XP (`mission xp − 20 × hints`, minimum 0), levels and badges (same rules as `academy/`),
   - writes `state/*.json` and `site/data/leaderboard.json` and commits as `github-actions[bot]` (with retries),
   - comments in English, closes the issue (`completed` / `not_planned`) and locks it,
   - the `deploy` job publishes `site/` to Pages (a push made with `GITHUB_TOKEN` doesn't trigger other workflows).
5. Every 30 seconds (every 15 seconds while a result is pending) the site fetches `data/leaderboard.json`. When the
   mission is solved: confetti, "+XP", sounds, level up, badges. For `wrong` / `limited` / `invalid`: a shake, a sound and
   a message linking to the comment on the issue.

From clicking **Create** to the result on the site usually takes **1–2 minutes** (runner start + commit + Pages deploy + cache).

> Why does the script also check other open issues? In a `concurrency` group GitHub keeps only **one** pending run
> in the queue and cancels the rest. So every run goes through all open flag issues and checks them one by one.
> Nothing gets lost, even when 20 people submit a flag in the same minute.

---

## Setup, step by step

### 1. Repository

Create a repo in your company organization, preferably **private** or **internal**, e.g. `agent-academy`.

```bash
cd academy-pages
git init -b main            # if there's no .git yet
git add .
git commit -m "Agent Academy (GitHub Pages)"
git remote add origin git@github.com:<ORG>/agent-academy.git
git push -u origin main
```

Make sure `answers.local.json` is **not** in the commit (`git status`; it's in `.gitignore`).

It's easiest to fill in `site/config.json` (step 2) before the first push. The first push runs `pages.yml`, which
**fails** until Pages is enabled (step 3). That's expected: after step 3, run it by hand.

### 2. Site configuration: `site/config.json`

| Field | Meaning |
|-------|---------|
| `owner`, `repo` | organization and repo name from step 1 (the site builds the issue form link from them; `YOUR-ORG` is the placeholder) |
| `trainingRepoUrl` | URL of the ShopFlow training repo, shown in the "Start" section |
| `eventName` | optional suffix for the title, e.g. "Group 3 · October" |
| `teams` | list of teams (join dialog + validation in the Action) |
| `missions[].xp`, `hintCost`, `maxHints`, `levels` | XP and level tables, shared by the site and the verifier |
| `limits` | `wrongPerMissionPerDay` (5), `issuesPerDay` (30) |
| `pollSeconds` | how often the site fetches the leaderboard, in seconds (30) |

Change → commit → push (the `pages.yml` workflow publishes the site by itself).

### 3. GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**
Then **Actions → Publish site → Run workflow** (first publish, if you pushed earlier).

> ⚠️ **Site visibility.** Private Pages (only people with access to the repo can open the site) are available **only on GitHub
> Enterprise Cloud**. In that case set **Settings → Pages → Visibility: Private**.
> On the **Free / Team** plans a Pages site is **PUBLIC on the internet, even from a private repo** (and on the Free plan
> an organization can't publish Pages from a private repo at all). The leaderboard shows **players' GitHub logins and teams**.
> If that can't be public, use Enterprise Cloud with private Pages, or the self-hosted `academy/` version.

### 4. Actions permissions

The workflows declare minimal permissions themselves (`contents: write`, `issues: write`, `pages: write`, `id-token: write`).
If your organization enforces read-only: **Settings → Actions → General → Workflow permissions → Read and write permissions**.

- The `main` branch must not require a PR for `github-actions[bot]` (the leaderboard is committed directly).
  If you have a branch protection rule, add an exception for GitHub Actions or don't create one.
- The `github-pages` environment (created automatically) must allow deploys from `main` (the default).

### 5. The `flag` label

The form only adds the label if it exists:

```bash
gh label create flag --repo <ORG>/agent-academy --color FFB547 --description "Agent Academy flag submission"
```

(It works without the label too, since the workflow also recognizes the `[flag] …` title, but the label makes filtering easier.)

### 6. Encryption keys: `SUBMIT_PRIVATE_KEY`

```bash
node scripts/gen-keys.mjs            # new RSA-OAEP 3072 pair: public -> site/config.json (submitKey), private -> keys.local.pem
node scripts/gen-keys.mjs --apply    # …and right away: gh secret set SUBMIT_PRIVATE_KEY --repo <owner>/<repo> < keys.local.pem
git add site/config.json && git commit -m "Submission key" && git push
```

- `keys.local.pem` is git-ignored (mode 600). **Don't commit it**; treat it like a password (e.g. store it in your
  password manager or the macOS Keychain as a secure note), because without it you can't read submissions encrypted with this key.
- Running the script again with a matching key generates nothing: it only prints (with `--apply`: runs) the `gh` command.
- `kid` is the first 16 hex characters of `sha256(SPKI)`. The verifier computes it from the private key, nothing to set by hand.
- Without `submitKey` in `config.json` the site shows "This site isn't configured yet"; without the secret the workflow fails
  **before** it touches any submission (after fixing it: **Run workflow**).

**Key rotation** (e.g. if `keys.local.pem` may have leaked, or between training editions):

```bash
node scripts/gen-keys.mjs --rotate --apply   # keys.local.pem -> keys.old.local.pem (SUBMIT_PRIVATE_KEY_OLD), new pair -> SUBMIT_PRIVATE_KEY
git add site/config.json && git commit -m "Rotate submission key" && git push
# a few days later, once no open issues use the old key:
gh secret delete SUBMIT_PRIVATE_KEY_OLD --repo <owner>/<repo> && rm keys.old.local.pem
```

Secrets first, then push `config.json`: submissions encrypted with the old key (open tabs, the queue) still decrypt
thanks to `SUBMIT_PRIVATE_KEY_OLD`. After a key leak, delete `SUBMIT_PRIVATE_KEY_OLD` right away.

### 7. The answers secret: `ANSWERS`

```bash
cp answers.example.json answers.local.json     # fill in the real answers (trainer/README.md, mission table)
node scripts/set-answers.mjs                   # preview: checks the 8 answers, prints the command
node scripts/set-answers.mjs --apply           # gh secret set ANSWERS --repo <owner>/<repo> (value via stdin)
```

Without the file the script asks for the answers in the terminal. The secret is a JSON `{"m1":"…", …, "m8":"…"}` (normalized).
A missing secret or a missing answer makes the workflow fail **before** it touches any submission;
after fixing it, run **Actions → Verify flags → Run workflow**, which checks all open submissions.

### 8. Player access

Players need the **Read** role on the repo (enough to open issues) and a GitHub account in the organization.
An `internal` repo on Enterprise gives every company member Read automatically.
Share the Pages link with them (Settings → Pages shows the URL).

### 9. Test before the training

Open the site, enter your login, submit M1 with a wrong answer and then with the right one. Watch **Actions**,
the comments on the issues and the leaderboard.

---

## Local work (no GitHub)

```bash
npm test                                         # tests (node:test, zero dependencies)
node scripts/preview.mjs                         # http://localhost:4100, the site from site/
node scripts/preview.mjs --sample                # …with a sample leaderboard
node scripts/preview.mjs --owner=acme --repo=x   # …with owner/repo overridden (so you can click "Submit flag")
node scripts/preview.mjs --board=/tmp/lb.json    # …with your own leaderboard file (re-read on every request)
node scripts/preview.mjs --owner=acme --repo=x --key=/tmp/dev.pem   # …with a test key (created if missing),
                                                 #    so you can decrypt locally what the site encrypts

# simulate a submission: the real verifier, temporary state, no git and no API calls (DRY_RUN=1)
node scripts/simulate.mjs --login=octocat --mission=m7 --answer=123 --hints=1 --team=QA
node scripts/simulate.mjs --login=octocat --mission=m6 --answer=ORD-00000 --state=/tmp/sim   # more runs in the same state
node scripts/simulate.mjs --login=octocat --author=mallory --form-login=mallory --mission=m7 \
  --sealed=$(cat /tmp/sim/sealed-1.txt) --state=/tmp/sim                                   # someone else's blob → invalid
```

Open the preview in Safari or Chrome; press Ctrl+C in the terminal to stop the server.

`simulate.mjs` encrypts the answer with the site's real code (`site/seal.js`) and decrypts it with the verifier. Key:
`--key=PEM`, otherwise `keys.local.pem` (if it matches `config.json`), otherwise a temporary pair saved in the state folder.
It reads the answers from `answers.local.json` (or `--answers=FILE`), and without them from the `answers.example.json` placeholders.
It prints the comment the player would get, the encrypted submission (`sealed-N.txt`) and the path to `leaderboard.json`.

---

## Cost (Actions minutes)

One submission = a `verify` run (~15–30 s) + `deploy` (~30–60 s). GitHub rounds each job up to a full
minute, so count **~2 minutes per submission** (Linux runner, 1× multiplier).

Example: 30 people × 8 missions × ~1.5 submissions ≈ 360 submissions ≈ **720 minutes** per group.
Monthly limits for private repos: Free 2,000, Team 3,000, Enterprise Cloud 50,000 minutes. Public repos are free.
When someone sends many flags in a short time, pending runs merge (one run checks several submissions), so
in practice it comes out lower.

## Reset between groups

1. Close any open flag issues from the previous group
   (`gh issue list --repo <ORG>/agent-academy --label flag --state open`) so they don't count for the new group.
2. `node scripts/reset-state.mjs --apply` clears `state/players.json`, `state/attempts.json` and
   `site/data/leaderboard.json` (a copy goes to `archive/<date>/`, which git ignores; git history keeps it anyway).
3. Optionally change `eventName` in `site/config.json`.
4. `git add state site && git commit -m "Reset leaderboard" && git push`. `pages.yml` publishes the empty leaderboard.

Players who played in the previous group on the same computer: **My account → Clear** (revealed hints
and local badges live in the browser).

## Anti-cheating: what's covered and what isn't

- **Identity** = the issue author. The login typed on the site goes into the encrypted content and must match the author
  (otherwise `invalid`, without using up attempts). It also highlights "(you)" on the leaderboard.
- **The answer is encrypted with a public key** (RSA-OAEP 3072, SHA-256). The private key exists only in the
  `SUBMIT_PRIVATE_KEY` secret (and locally with the trainer in `keys.local.pem`). Why not a hash? A hash of the correct answer
  visible in a closed issue could be checked **offline** against candidates (M7 is a number, M6 is `ORD-#####`)
  in seconds. RSA-OAEP ciphertext is randomized (the same text gives a different result every time), and without the
  private key you can't tell whether a candidate matches, so **an offline attack is no longer possible**.
- **Someone else's submission is useless**: the login in the encrypted content must be the issue author; your own submission
  used a second time is rejected (the `nonce` is remembered per login for 7 days, as long as `ts` stays valid).
- **The visible fields are for humans only**: mission/hints/login that don't match the encrypted content → `invalid`.
- **The answers aren't in the repo or on the site**, only in the `ANSWERS` secret (and with the trainer in `trainer/README.md`).
  The verifier never prints decrypted content; right after decryption it masks it in the logs (`::add-mask::`).

**What remains (known limitations):**

- **Online guessing** through repeated submissions: the limit is **5 wrong attempts per mission per person per 24 hours** (a submission
  over the limit isn't checked at all) and 30 submissions per person per day. For M7 in a range of, say, 0–999 that's ~500 attempts on average,
  i.e. **~100 days** for one account (or 100 accounts for one day). Not worth it in practice.
- **Hints are on the honor system.** The site fills in (and encrypts) the number of revealed hints, but a player
  could encrypt a different number (the public key is public) or reveal hints in another browser.
  If it matters, review submissions with `0`.
- **Pages are public on Free/Team plans** (private Pages only on Enterprise Cloud): the leaderboard shows logins and teams.
- `state/attempts.json` (logins, times, attempt results and used `nonce`s, no answers) is in the repo and visible to anyone
  with Read access. It doesn't go to Pages: only `site/` is published.
- Encryption protects the answer from other players, not from people with access to the repo secrets (admins).

## Workflow security (for the trainer)

- **No script injection:** no issue data is interpolated with `${{ }}` into `run:`. The script reads the event
  from the `GITHUB_EVENT_PATH` file. `tests/security.test.mjs` enforces this, including multi-line `run:` blocks.
- **Workflow commands:** before printing anything, the script masks every answer (`::add-mask::`; the runner itself only masks
  the whole secret) and stops command processing (`::stop-commands::<random token>`), so nothing in the logs
  (logins, API errors) can set `::set-output`/`::add-mask`/`::error`. The `changed` output goes through the `GITHUB_OUTPUT` file.
  Decrypted content is masked **right after decryption**: with commands stopped the runner would ignore
  `::add-mask::`, so the script resumes commands with the current token, adds the masks and immediately stops them again with a new token
  (three lines printed synchronously). Invalid JSON in `ANSWERS` or a bad PEM key produce a message without the secret's content.
- **Encryption:** RSA-OAEP with SHA-256 (`crypto.privateDecrypt`, `RSA_PKCS1_OAEP_PADDING`, `oaepHash: "sha256"`), keys of
  at least 3072 bits. Rejected: wrong field format/size (> 1024 characters, not base64url, length ≠ key size),
  undecryptable, non-UTF-8 or non-JSON content, extra/missing fields, a `kid` that doesn't match the key. Private keys
  reach the script only through `env` (secrets `SUBMIT_PRIVATE_KEY`, optionally `SUBMIT_PRIVATE_KEY_OLD`).
- **Permissions:** `permissions: {}` by default; `verify` has only `contents: write` + `issues: write`, `deploy` only
  `pages: write` + `id-token: write`. The publishing jobs check out with `persist-credentials: false`.
- **Actions** are only official `actions/*`, pinned to full SHAs with a version comment (checked with
  `git ls-remote` on 2026-10-08: checkout v7.0.1, setup-node v7.1.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1).
  Update them deliberately (e.g. Dependabot for `github-actions`).
- **Triggers:** only `issues: [opened]` and manual `workflow_dispatch` (people with Write only). No
  `pull_request_target`/`issue_comment`, so bot comments trigger nothing (and a push with `GITHUB_TOKEN` doesn't
  trigger workflows anyway). Editing or reopening an issue doesn't trigger verification; an issue that was already checked is never
  counted twice (`state/attempts.json → processed`). The author can still edit their issue before the Action
  checks it, which gives them nothing beyond what they could have typed in the first place (hints are on the honor system anyway).
- **Queue:** the `leaderboard` group is set on the `verify` job, so a run for a regular issue (job skipped)
  doesn't cancel a pending flag verification. Every run sweeps all open flag issues anyway
  (up to 100 per run). A race on `git push` → fetch the latest `main` and recompute (up to 5 attempts).
- **Identity:** only the issue author counts. The author's login must follow GitHub's rules (ASCII, 1–39 characters),
  otherwise the submission is ignored, which rules out `__proto__` and Unicode look-alike characters. Bot accounts
  (`type: Bot` or `…[bot]`) are skipped. The team must be one of `teams` in `site/config.json`, hints must be an ASCII
  whole number 0–2, the issue body is cut to 64 KB and each field to 200 characters.
- **State size:** attempt entries older than 48 hours are removed on every write, and submissions over the daily limit
  don't go into the attempt log. `processed` grows by ~70 B per submission (cleared by `reset-state.mjs`).
- **Site:** logins and teams from `leaderboard.json` reach the DOM only through `textContent`; entries with a login
  that breaks GitHub's rules are dropped, and the avatar URL is built only from a valid login (`encodeURIComponent`).

### Spam and Actions minutes

Every new issue creates a workflow run, but for issues without `[flag]`/the label the job is skipped (0 minutes).
During a flood of flag submissions GitHub keeps only **one** pending `verify` job in the queue; the others are cancelled
before they start (0 minutes), and the one that runs checks all open submissions at once. So the cost grows
with how long the spam lasts, not with the number of issues (roughly ~2 minutes for every ~1 minute of spam). Submissions over the 30/day limit
get a short comment and are closed without being checked. If someone spams on purpose:
`gh workflow disable "Verify flags" --repo <ORG>/agent-academy`, block the account in the organization or remove their
access, close their issues (`gh issue list --author <login> --state open`), then `gh workflow enable` and **Run workflow**.
Interaction limits (Settings → Moderation) only work in public repos.

## Troubleshooting

| Symptom | Cause / what to do |
|---------|--------------------|
| Site: "This site isn't configured yet" | `owner`/`repo` in `site/config.json` still have the default values, or `submitKey` is missing. |
| The link opens a 404 on GitHub | The player has no Read access to the repo or isn't signed in to GitHub. |
| The form opens empty | `.github/ISSUE_TEMPLATE/flag.yml` is missing on `main`, or the field `id`s were changed. |
| The issue doesn't get the `flag` label | The label doesn't exist: `gh label create flag …` (the workflow still works through the `[flag]` title). |
| The workflow doesn't start | Actions are disabled in the repo/organization; the workflow reacts only to opening an issue, not to edits. |
| Error "The ANSWERS secret…" | Set the secret (`scripts/set-answers.mjs --apply`), then **Run workflow** on "Verify flags". |
| Error "Missing secret SUBMIT_PRIVATE_KEY…" | `node scripts/gen-keys.mjs --apply`, push `config.json`, then **Run workflow**. |
| Every submission is `invalid` with "outdated key" | `config.json` on Pages has a different key than the secret. Check the `kid` (gen-keys without `--apply` shows whether `keys.local.pem` matches); after a rotation set `SUBMIT_PRIVATE_KEY_OLD`. |
| "Couldn't encrypt your submission" on the site | The site was opened over `http://` from a host other than localhost (Web Crypto needs HTTPS) or in a very old browser. |
| Error on `git push` / 403 | Workflow permissions are read-only, or branch protection on `main` blocks the bot. |
| `deploy` fails: "Pages not enabled" / 404 | Settings → Pages → Source: GitHub Actions. |
| `deploy` fails on the environment | The `github-pages` environment has a branch rule that doesn't include `main`. |
| The result doesn't show up on the site | Wait 1–2 minutes (Pages cache); check the comment on the issue and the Actions tab. "Stop waiting" removes the pending state. |
| A player gets "invalid" (different login) | The login typed on the site differs from the account that opened the issue. The comment explains it. |
| A player hit the limit because of a typo | Edit `state/attempts.json` (remove their `wrong` entries for that mission), commit, push. |
| A result needs a manual fix | Fix the player in `state/players.json` (`solved`, `xp`, `badges`). It's the source of truth, and the leaderboard is rebuilt from it on the next submission. To make the change visible right away, also fix `site/data/leaderboard.json`; the push triggers publishing. |

## Possible extensions

- A scheduled run (`schedule`) as a safety net in case a run fails. It costs minutes, so it's off by default
  (a manual **Run workflow** is enough).
