# ISC Automated Sales Forecast

**Automates the weekly US Public Sector IBM Sales VP → GM meeting preparation workflow.**

Replaces 60–90 minutes of manual pipeline export, scoring, narrative writing, and PowerPoint building with a single five-minute workflow powered by IBM watsonx.ai. Multi-user, IBM-SSO-authenticated, with full per-user data isolation.

> Built by Jeffrey L. Trbovich with [IBM Bob](https://w3.ibm.com) · IBM watsonx Challenge 2026 · Growth Enablers Track

---

## What It Does

| Step | Manual (before) | Automated (now) |
|---|---|---|
| Sign in | N/A | IBM w3id SSO login (simulated for demo; real OIDC-ready) |
| Export pipeline data | Open ISC, copy/paste to spreadsheet | Upload one HAR file — done in 5 seconds |
| Score every deal | Eyeball each row | watsonx.ai scores all deals in ~15 sec |
| Write GM narrative | Type from memory | Llama-3-70b generates meeting-ready prose in ~10 sec |
| See what changed | Remember last week | Diff engine compares live vs. saved baseline automatically |
| Build PowerPoint | Format slides by hand | One-click PPTX with GM narrative + scored deals + What Changed slide |

**Total time: under 5 minutes, every week.**

---

## Prerequisites

- **Node.js v18 or later** — [nodejs.org](https://nodejs.org/)
- **Chrome browser** — for HAR export (Brave also works)
- **IBM watsonx.ai credentials** *(optional — app runs without them using rule-based scoring)*
  - `WATSONX_API_KEY` — your IBM Cloud API key
  - `WATSONX_PROJECT_ID` — your watsonx.ai project ID

---

## First-Time Setup

### Step 1 — Clone the repo and install dependencies

```bash
git clone https://github.com/jefftrbo/UCC1-ISCAutomatedSalesForecast.git
cd UCC1-ISCAutomatedSalesForecast
npm install
```

### Step 2 — Configure environment variables

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Open `.env` in any text editor. The minimum required settings for local/test use:

```env
# Simulated IBM SSO — uses scripts/test-users.csv for login (default: true)
SIMULATE_SSO=true

# Session secret — change to any long random string
SESSION_SECRET=change-me-to-a-long-random-string

# Leave WATSONX_ENABLED=false to use rule-based scoring (no credentials needed)
WATSONX_ENABLED=false

# IBM watsonx.ai credentials (required only if WATSONX_ENABLED=true)
WATSONX_API_KEY=your_ibm_cloud_api_key_here
WATSONX_PROJECT_ID=your_watsonx_project_id_here
WATSONX_URL=https://us-south.ml.cloud.ibm.com
```

### Step 3 — Load test users into the database

This reads `scripts/test-users.csv`, hashes passwords, and creates the user registry. It also assigns all existing pipeline rows to the primary user (Duey Patel).

```bash
node scripts/init-users.js
```

You should see all 9 test users confirmed and existing pipeline rows tagged.

### Step 4 — Seed demo data for the other 8 users *(optional but recommended)*

Each non-primary user gets 6 realistic deals from real health system accounts, with a Week 1 baseline and Week 3 live mutations pre-loaded so the diff engine shows changes on first login.

```bash
node scripts/seed-quarter.js --all
```

### Step 5 — Start the app

```bash
npm start
```

Open your browser to **[http://localhost:3090/login](http://localhost:3090/login)**

You will see the IBM-styled simulated SSO login page. Sign in with any user from the test list below.

---

## Test Users (Simulated SSO)

| Display Name | IBM ID | Password | Pipeline |
|---|---|---|---|
| Duey Patel (GM/VP) | `dkpatel@us.ibm.com` | `dk` | 221 real deals from ISC |
| Jeff Trbovich | `trbovich@us.ibm.com` | `jt` | 6 UPMC/Philadelphia deals |
| Spencer Korn | `spencer.korn@ibm.com` | `sk` | 6 Mayo/Cleveland Clinic deals |
| Kim Salatino | `kim.salatino@ibm.com` | `ks` | 6 UPMC/AHN deals |
| Jeff Underwood | `junderwood@ibm.com` | `ju` | 6 HCA Healthcare deals |
| Michael Marsalis | `marsal@us.ibm.com` | `mm` | 6 BCBS SC/Palmetto deals |
| Ken Crum | `kcrum@us.ibm.com` | `kc` | 6 Cigna/Aetna/UHG deals |
| Andy Quintana | `andy.quintana@ibm.com` | `aq` | 6 Ascension/CommonSpirit deals |
| Brian Coyle | `bcoyle@us.ibm.com` | `bc` | 6 Horizon BCBS NJ deals |

Each user's data is **completely isolated** — no user can see another's pipeline. Log out and log back in as a different user to prove it.

---

## Weekly Data Refresh (~2 minutes)

Every week before the GM meeting, follow these steps to load fresh pipeline data.

### Part A — Export your ISC pipeline data as a HAR file

**Why HAR?** IBM Sales Cloud (ISC) is protected by IBM w3id SSO with passkey authentication that blocks all programmatic access. The HAR file captures the authenticated API responses directly from your browser session — no credentials stored in the app, no security risk.

#### Step A1 — Open ISC in Chrome

Navigate to:
```
https://ibmsc.lightning.force.com/lightning/page/analytics?wave__assetType=dashboard
```

Log in with your IBM w3id credentials (passkey/Touch ID if prompted).

#### Step A2 — Apply your pipeline filters

Once the CRM Analytics dashboard loads:

1. **Accounts Assigned To:** Your name defaults — change to the Sales VP whose pipeline you're preparing (e.g. "Dushyant K Patel")
2. Click the **"Deal List by Opportunity"** tab
3. **Forecast Grouping:** Select **Call, Upside, Stretch**
4. **Opportunity Status Grouping:** Leave as **Open only** (do not select Won/Lost/"-")
5. Confirm the table shows the expected opportunities (~200 for a VP)

> **Note:** ISC defaults the `Accounts Assigned To` filter to **your own name**. Every user must clear their name and select the VP (or their own account set) before exporting. This is the same filter shown in the ISC screenshots — only `View_As_Territory` changes per user.

> **Why the record count in the app is lower than ISC's total:** ISC's summary row (e.g. "1,087 Opps") counts **all** opportunity statuses — Open, Won, Lost, and "-". The app only imports **Open** pipeline opportunities (active stages 1–5: Engage → Negotiate) because Won and Lost deals are not relevant to forecast prep. A difference of 10–20% between ISC's total and the app's loaded count is **normal and expected**.

#### Step A3 — Open Chrome DevTools and start recording

1. Press **Cmd+Option+I** (Mac) or **F12** (Windows) to open DevTools
2. Click the **Network** tab
3. Make sure the **red record button** (●) is active — if grey, click it to start recording
4. With DevTools open, **reload the page** (Cmd+R)

#### Step A4 — Re-apply your filters

After the page reloads, re-apply the same filters from Step A2.

#### Step A5 — Export the HAR file

1. In the Network panel, click the **⬇ download icon** ("Export HAR")
2. Save the file as `scraper/isc-export.har` in the project directory

> **Tip:** The HAR file will be 5–15 MB. If it's smaller than 1 MB, re-check filters and try again.

### Part B — Load the HAR file into the app

With the app running and logged in:

1. Click **"Refresh Data"** in the action bar
2. The app detects `scraper/isc-export.har` automatically and parses it
3. Pipeline rows are tagged with **your** IBM ID — no other user sees them
4. The pipeline status line updates with the record count and timestamp

### Part C — Run the GM prep workflow

Once data is loaded, the action bar guides you through each step. All steps are independently re-runnable — no sequence lock.

#### Score with watsonx
Click **"⬡ Score"** to run AI confidence scoring on all your opportunities.

#### Generate Narrative
Click **"✍ Narrative"** to produce the GM meeting opening text, scoped to your current filter.

#### What Changed
Click **"⇄ What Changed"** to see week-over-week diff against your last saved baseline.

#### Baseline & Generate GM Report
Click **"📊 Baseline & GM Report"** → confirm → PowerPoint generated and downloaded.

---

## App Header — What You'll See After Login

The header displays:
- **Initials avatar** (first + last name initial, circular)
- **Display name** and abbreviated **role** (e.g. "Duey Patel · Vice President")
- **Sign out** button — ends your session and returns to `/login`

A yellow **🔬 Simulated SSO — Test Mode** banner appears below the header showing your active IBM ID and a **Switch User** link. This banner is present in simulated SSO mode; it is hidden when wired to real IBM w3id.

---

## Using Named View Presets

The filter bar includes three one-click view presets:

| Preset | What it shows |
|---|---|
| 📊 **GM Prep** | Current quarter · Best Case forecast · High & Medium confidence |
| ⚠ **At Risk** | Low confidence only · deals most likely to slip |
| 🗂 **Full Pipeline** | All opportunities — unfiltered |

---

## The Generated PowerPoint

The PPTX includes:
- **Cover slide** — GM narrative paragraph + key pipeline stats
- **Deal slides** — one per opportunity, sorted by confidence score
- **"What Changed" slide** — week-over-week delta summary

Downloaded automatically as `forecast-[date].pptx` in your user-namespaced output directory.

---

## App Structure

```
server/
  index.js              — Express API server (port 3090); session + auth + all endpoints
  auth.js               — Simulated IBM SSO: POST /auth/login, GET /auth/logout, GET /api/me
  middleware/
    requireAuth.js      — Auth guard: redirects unauthenticated requests to /login
  db.js                 — SQLite schema + migrations (users + opportunities + baseline_ledger)
  diffEngine.js         — saveSnapshot(), computeDiff(); per-user live-vs-baseline model
  watsonxScore.js       — scoreWithWatsonx(), generateNarrative(), generateDeltaSummary()
  scoreOpportunity.js   — Rule-based scoring engine (fallback when watsonx unavailable)
  generatePpt.js        — PowerPoint generator (cover + data + What Changed slides)

public/
  login.html            — IBM-styled simulated SSO login page
  index.html            — Full frontend: Carbon Design UI, action bar, filter bar,
                          user chip, TEST MODE banner, named presets, diff panel,
                          narrative panel, per-tile diff modals

scripts/
  init-users.js         — Loads test-users.csv → users table; tags existing rows to primary user
  seed-quarter.js       — Multi-user seed helper: --user / --all / --restore / --status flags
  test-baseline-ledger.js — Unit test: 34/34 assertions, 13-week Q3 2026 in-memory simulation

scraper/
  load-from-har.js      — Parses HAR; tags rows with USER_ID env var (set by server on scrape)
  fetch-from-api.js     — SAQL direct API scraper (alternative path)

poc/
  electron-shell/       — Electron PoC (future zero-HAR architecture proof-of-concept)

.env.example            — Template: SIMULATE_SSO, SESSION_SECRET, WATSONX_*, OIDC_*
scripts/test-users.csv  — Test user registry (gitignored — contains real IBM IDs)
```

---

## Running Tests

```bash
# Unit test: 34/34 assertions, 13-week Q3 2026 simulation, under 5 seconds
node scripts/test-baseline-ledger.js

# Seed demo data for a specific user
node scripts/seed-quarter.js --user trbovich@us.ibm.com

# Seed all non-primary users at once
node scripts/seed-quarter.js --all

# Check seeded state
node scripts/seed-quarter.js --status

# Restore (remove all seeded rows)
node scripts/seed-quarter.js --restore --all
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Can't reach `localhost:3090` — redirected to `/login` | Expected — sign in first with any user from the test list |
| Login fails with "IBM ID or password incorrect" | Run `node scripts/init-users.js` to ensure the users table is populated |
| **App shows fewer records than ISC's total count** | Expected — ISC counts Open + Won + Lost + "-". The app imports Open-only (stages 1–5). A 10–20% difference is normal. |
| HAR file parses but shows 0 opportunities | Filters weren't applied before export — re-apply Owner + Forecast Grouping and re-export |
| Opportunities visible to wrong user | Run `node scripts/init-users.js` again — it tags unowned rows to the primary user |
| watsonx scoring fails | Check `WATSONX_ENABLED=true` and that API key + project ID are in `.env` |
| Port 3090 already in use | `lsof -i :3090` to find the process, then `kill [PID]` |
| Diff shows everything as "new" | No baseline saved yet — click "✅ Confirm & Generate" to write the first baseline |

---

## Transitioning to Real IBM w3id SSO

When an IBM app registration is approved (Client ID + Client Secret from IBM's w3id identity team), replace one block in `server/auth.js`:

```js
// Current (SIMULATE_SSO=true): bcrypt check against users table
// Production (SIMULATE_SSO=false): Passport.js OIDC strategy
passport.use(new OIDCStrategy({
  issuer:      process.env.OIDC_ISSUER_URL,
  clientID:    process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  callbackURL: 'https://yourapp.w3.ibm.com/auth/callback',
}, (issuer, profile, done) => done(null, {
  ibm_id: profile.emails[0].value,
  display_name: profile.displayName,
})));
```

Set `SIMULATE_SSO=false` in `.env`. Session shape, all DB queries, and the frontend are unchanged.

---

## Version History

| Version | What changed |
|---|---|
| v1.0.0 | HAR → SQLite → rule-based scoring → PowerPoint pipeline |
| v2.2.0 | IBM Carbon Design System · Model 3 action bar · named view presets · per-tile diff modals · GM Ready indicator · timestamp snapshots |
| v2.3.0 | Permanent quarterly audit ledger · UUID-keyed immutable baselines · 34/34 test harness · three-button confirm modal |
| v2.4.0 | Simulated IBM SSO · multi-tenant per-user data isolation · login page · header user chip · 9 test users · per-user seed data |
| v2.5.0 | Pipeline Intelligence Engine · Deal Health Card modal · hygiene scoring · liar-deal detection · rep coaching tab · week-over-week timeline |
| v2.5.1 | HAR user-tagging guard in TEST MODE · health icon pre-compute |
| v2.5.2 | Narrative scoped to checked rows in filtered view |
| v2.5.3 | Live narrative refresh on checkbox selection change (300ms debounce) |
| v2.5.4 | Narrative refresh on filter/search change |
| v2.5.5 | PPT uses filtered+checked IDs from frontend (fixes 906-vs-172 bug) |
| v2.5.6 | Padded-close detection signal · P1/P2/P3 QE-close flag · UTC timezone fix |
| v2.5.7 | Team Hygiene sticky header · QE Close column per rep · amber highlight |
| v2.5.8 | Manager name field fix — `Opp.MGR.Mgr.User_Name_mk__c` resolves 870/949 reps · ISC count mismatch documented across all user docs |
| v2.5.9 | Column width tuning — explicit widths on all 25 columns · truncation on Owner/Manager/Created By/Company/Partner/Technology/Pipeline · sticky col offsets corrected |

---

## IBM watsonx Challenge 2026

This app is a submission for the **IBM watsonx Challenge 2026, Growth Enablers track** (deadline July 22, 2026).

- **Business value:** 90 min → under 5 min weekly GM prep · 94% time reduction
- **Multi-user:** 9 IBM TSLs/ATLs/GMs with full data isolation, IBM SSO architecture
- **watsonx.ai models:** `ibm/granite-13b-instruct-v2` (scoring) · `meta-llama/llama-3-70b-instruct` (narrative) · `ibm/granite-3-8b-instruct` (delta summary)
- **Built with:** IBM Bob (IBM's watsonx AI development assistant) · 30 sessions
- **Deployment path:** CIO "Build with watsonx" Path to Production

---

*UCC1 — ISC Automated Sales Forecast · US Public Sector IBM · v2.5.9*
