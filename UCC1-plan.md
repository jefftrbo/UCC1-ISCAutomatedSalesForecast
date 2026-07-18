# UCC1 — ISC Automated Sales Forecast Plan

## Top-Level Overview

Build a locally-hosted web application that automates the weekly Sales VP → GM meeting preparation workflow. The system has four concerns:

1. **Scrape** — A Playwright-based headless browser scraper runs locally under the user's authenticated IBM SSO session, navigates to a user-supplied ISC URL, and extracts standard sales opportunity fields.
2. **Store** — Extracted data is persisted to a local SQLite database (zero infrastructure, file-based, easy to inspect).
3. **Select** — A simple local web app lets the Sales VP review all scraped opportunities and check which ones to include in the GM meeting.
4. **Generate** — A clean, minimal PowerPoint (`.pptx`) is generated from the selected opportunities, ready for the GM meeting. A custom IBM template can be swapped in later.

The entire stack runs on the user's local machine. No cloud infrastructure, no API keys, no ISC credentials stored anywhere.

---

## Architecture

```
[ISC Web Page]
     ↓  (Playwright scraper, runs under user's browser session)
[SQLite DB — opportunities.db]
     ↓
[Local Node/Express backend]
     ↓
[Web App UI — opportunity selector]
     ↓
[pptxgenjs — .pptx export]
```

**Tech stack:**
- Runtime: Node.js
- Scraper: Playwright (headless Chromium, preserves SSO session via persistent browser profile)
- Backend: Express.js (local API server)
- Database: SQLite via `better-sqlite3`
- Frontend: Plain HTML/CSS/JS (no framework — keeps it simple and portable)
- PowerPoint: `pptxgenjs`

---

## Sub-Tasks

---

### Sub-Task 1 — Project Scaffold

**Intent:** Set up the project structure, `package.json`, and dependencies so all subsequent sub-tasks have a consistent foundation to build on.

**Expected Outcomes:**
- `package.json` with all required dependencies listed
- Folder structure created (`/scraper`, `/server`, `/public`, `/output`)
- A `README.md` with instructions to install and run

**Todo List:**
1. Create `package.json` with dependencies: `playwright`, `better-sqlite3`, `express`, `pptxgenjs`
2. Create folder structure: `/scraper`, `/server`, `/public`, `/output`
3. Add `.gitignore` excluding `node_modules`, `*.db`, `/output/*.pptx`, and the Playwright browser profile directory
4. Write `README.md` with setup steps (`npm install`, `npx playwright install chromium`)

**Relevant Context:**
- Root of workspace: `/Users/trbo/Desktop/2026wxChallenge/UCC1-ISCAutomatedSalesForecast`
- No existing code — greenfield project

**Status:** `[x] done`

---

### Sub-Task 2 — SQLite Database Schema

**Intent:** Define and initialize the database schema for storing scraped opportunities, so the scraper and backend have a stable contract to work against.

**Expected Outcomes:**
- `server/db.js` module that initializes the SQLite DB and creates the `opportunities` table if it doesn't exist
- Schema supports standard opportunity fields with a `scraped_at` timestamp and a `selected` boolean for GM meeting inclusion
- DB file is created at `opportunities.db` in the project root

**Todo List:**
1. Create `server/db.js` that opens/creates `opportunities.db`
2. Define `opportunities` table with columns:
   - `id` (TEXT, primary key — from ISC)
   - `opportunity_name` (TEXT)
   - `account_name` (TEXT)
   - `stage` (TEXT)
   - `close_date` (TEXT)
   - `expected_revenue` (REAL)
   - `seller_name` (TEXT)
   - `scraped_at` (TEXT — ISO timestamp)
   - `selected` (INTEGER default 0 — boolean flag)
3. Use `CREATE TABLE IF NOT EXISTS` so re-runs are safe
4. Export the `db` instance for use by scraper and server

**Relevant Context:**
- Used by Sub-Task 3 (scraper) and Sub-Task 4 (backend API)
- Fields are the standard set — additional fields will be added in a future request

**Status:** `[x] done`

---

### Sub-Task 3 — ISC Scraper

**Intent:** Build the Playwright-based scraper that opens ISC in a persistent browser profile (preserving IBM SSO login), navigates to the configured URL, extracts opportunity rows, and upserts them into SQLite.

**Expected Outcomes:**
- `scraper/scrape.js` script that can be run standalone (`node scraper/scrape.js`)
- Uses a persistent Playwright browser profile so the user only needs to log in once manually
- ISC URL is read from a `config.json` file (so it can be changed without touching code)
- Scraped rows are upserted into the `opportunities` table (no duplicates on re-run)
- Logs how many records were found and saved

**Todo List:**
1. Create `config.json` with a placeholder `iscUrl` field and `browserProfilePath` field
2. Create `scraper/scrape.js` using `playwright` with `launchPersistentContext` pointing to the profile path
3. Navigate to `config.iscUrl`, wait for the opportunity table/list to load
4. Extract the standard fields from each row using DOM selectors (selectors will need tuning once the real URL is provided — add a `TODO` comment flagging this)
5. Upsert each record into SQLite via `server/db.js`
6. Log results to console and exit

**Relevant Context:**
- `launchPersistentContext` in Playwright preserves cookies/session across runs — user logs in once via a visible browser, then subsequent runs are headless
- The ISC URL and exact DOM selectors are TBD until the real URL is shared — the scraper should be written with clearly marked placeholder selectors
- Used by Sub-Task 4 (backend triggers this script via an API endpoint)

**Status:** `[x] done`

---

### Sub-Task 4 — Express Backend API

**Intent:** Build a lightweight local Express server that exposes endpoints the frontend uses to fetch opportunities, update selection state, trigger the scraper, and generate the PowerPoint.

**Expected Outcomes:**
- `server/index.js` Express app listening on `localhost:3000`
- Endpoints:
  - `GET /api/opportunities` — returns all opportunities from SQLite
  - `POST /api/opportunities/:id/select` — toggles `selected` flag for an opportunity
  - `POST /api/scrape` — triggers `scraper/scrape.js` as a child process
  - `POST /api/generate-ppt` — generates a `.pptx` from all `selected=1` opportunities
- Static files served from `/public`

**Todo List:**
1. Create `server/index.js` with Express setup
2. Implement `GET /api/opportunities` — query all rows from `opportunities` table, return as JSON
3. Implement `POST /api/opportunities/:id/select` — accept `{ selected: true/false }` body, update DB
4. Implement `POST /api/scrape` — spawn `scraper/scrape.js` as a child process, stream stdout to response
5. Implement `POST /api/generate-ppt` — query selected opportunities, call the PPT generator (Sub-Task 5), return the file path
6. Add `npm start` script to `package.json`

**Relevant Context:**
- Child process for scraper: use `child_process.spawn` so output streams back in real time
- PPT generator module created in Sub-Task 5

**Status:** `[x] done`

---

### Sub-Task 5 — PowerPoint Generator

**Intent:** Build the module that takes an array of selected opportunities and produces a clean, minimal `.pptx` file using `pptxgenjs`. A title/summary slide plus one row-per-opportunity table slide.

**Expected Outcomes:**
- `server/generatePpt.js` module that accepts an array of opportunity objects and writes a `.pptx` to `/output/`
- Slide 1: Cover slide — "US Public Sector Sales Forecast" + week date
- Slide 2+: Clean table of selected opportunities (Opportunity Name, Account, Stage, Close Date, Expected Revenue, Seller)
- File saved as `output/forecast-YYYY-MM-DD.pptx`
- Design is clean and minimal — IBM template can be applied later

**Todo List:**
1. Create `server/generatePpt.js` accepting `(opportunities, outputPath)`
2. Use `pptxgenjs` to create a new presentation
3. Add cover slide with title, subtitle (week of date), and IBM blue accent color
4. Add opportunity table slide(s) — auto-paginate if row count exceeds one slide
5. Save to `outputPath` and return the path
6. Note in code where the IBM template will slot in (placeholder comment)

**Relevant Context:**
- Called by `POST /api/generate-ppt` in Sub-Task 4
- IBM PPT template will be provided by user in a future request — leave a clear hook

**Status:** `[x] done`

---

### Sub-Task 6 — Frontend Web App

**Intent:** Build the simple HTML/CSS/JS single-page app that the Sales VP uses to review scraped opportunities, select which ones go in the GM meeting, trigger a data refresh, and download the generated PowerPoint.

**Expected Outcomes:**
- `public/index.html` — single HTML file with embedded or linked CSS/JS
- Displays all opportunities in a clean, sortable table
- Checkbox per row to mark for GM meeting inclusion
- "Refresh Data" button → calls `POST /api/scrape` and shows progress
- "Generate PPT" button → calls `POST /api/generate-ppt` and triggers file download
- No framework dependencies — plain HTML/CSS/JS

**Todo List:**
1. Create `public/index.html` with a clean, minimal layout
2. On page load, fetch `GET /api/opportunities` and render the table
3. Render columns: checkbox, Opportunity Name, Account, Stage, Close Date, Expected Revenue, Seller
4. On checkbox change, call `POST /api/opportunities/:id/select`
5. "Refresh Data" button — POST to `/api/scrape`, show a loading state, reload table on completion
6. "Generate PPT" button — POST to `/api/generate-ppt`, then trigger browser download of the returned file
7. Add minimal CSS for readability (no external CSS framework needed)

**Relevant Context:**
- All API calls go to `localhost:3000`
- Designed for single-user local use — no auth, no sessions needed

**Status:** `[x] done`

---

## Open Items / Future Requests

- **ISC URL** — user will provide the real ISC forecast page URL; DOM selectors in the scraper will need tuning at that point
- **IBM PPT Template** — user will provide a `.pptx` template file for GM submissions; `generatePpt.js` has a placeholder hook for this
- **Additional fields** — user may request extra ISC fields beyond the standard set; DB schema and scraper are designed to accommodate new columns

---

### Sub-Task 7 — IBM watsonx.ai Integration (v2.0.0–v2.2.0)

**Status:** `[x] done`

- `server/watsonxScore.js` — `batchScore()`, `generateNarrative()`, `generateDeltaSummary()`; live IBM watsonx.ai REST API + graceful mock fallback
- `server/scoreOpportunity.js` — rule-based confidence scoring engine (stage, close date, next steps, financials)
- `server/generatePpt.js` — full PowerPoint generator: cover slide (narrative), scored deal slides, "What Changed" slide
- UI: Carbon Design System overhaul, Model 3 action bar, named view presets (GM Prep / At Risk / Full Pipeline), per-tile diff modals, tri-state checkbox, GM Ready indicator, `public/login.html`

---

### Sub-Task 8 — Permanent Quarterly Audit Ledger (v2.3.0)

**Status:** `[x] done`

- `server/diffEngine.js` redesigned: `saveSnapshot()` with UUID per run, `computeDiff()` with `confirmed_at < asOf` guard (structural "today vs today" prevention), `getLedgerHistory()`
- `server/db.js` — `baseline_ledger` table: append-only, UUID-keyed, quarter-tagged, week-sequenced
- Three-button confirm modal: Cancel / Generate Only / ✅ Confirm & Generate
- `scripts/test-baseline-ledger.js` — 34/34 assertions, 13-week Q3 2026 in-memory simulation, deterministic, runs in under 5 seconds
- `scripts/seed-quarter.js` (v1) — smoke test helper for UI validation

---

### Sub-Task 9 — Simulated IBM SSO + Multi-Tenant Data Isolation (v2.4.0)

**Status:** `[x] done`

**Problem:** App was single-user with no authentication. Dushyant wants all TSLs and ATLs reporting to him to use the same app independently, with their data isolated from each other.

**Solution:** Full multi-tenant architecture with simulated IBM w3id OIDC SSO (structurally identical to real production SSO; one-file swap when IBM app registration credentials arrive).

**New files:**
- `server/auth.js` — `POST /auth/login` (bcrypt check → session), `GET /auth/logout`, `GET /api/me`
- `server/middleware/requireAuth.js` — 30-line auth guard; redirects browsers to `/login`, returns 401 JSON to API callers
- `public/login.html` — IBM-styled mock SSO login page (IBM black top bar, w3id-lookalike form, TEST MODE notice, error banner)
- `scripts/init-users.js` — reads `scripts/test-users.csv`, bcrypt-hashes passwords, upserts users table, assigns untagged rows to primary user

**Modified files:**
- `server/db.js` — `users` table; `user_id TEXT` migration on `opportunities` + `baseline_ledger`; indexes
- `server/index.js` — `express-session` + `better-sqlite3-session-store`; auth routes; `requireAuth` on `/` and `/api/*`; `userId` threaded through all 10 query endpoints; PPT output namespaced to `/output/{safeId}/`
- `server/diffEngine.js` — `userId` param on `saveSnapshot`, `computeDiff`, `getPreviousBaseline`, `getLedgerHistory`
- `scraper/load-from-har.js` — `USER_ID` env var tags every upserted row
- `public/index.html` — header user chip (avatar, display name, role, Sign Out); yellow TEST MODE banner; v2.4.0
- `scripts/seed-quarter.js` — full rewrite: `--user`, `--all`, `--restore`, `--status` flags; 8 per-user seed templates with real health system accounts

**Test results (9/9 passed):**
- `GET /login` → 200 ✅
- `GET /` (unauthed) → 302 `/login` ✅
- `POST /auth/login` bad creds → 302 `/login?error=invalid` ✅
- `POST /auth/login` Duey → 302 `/` ✅
- `GET /api/me` Duey session → correct JSON ✅
- `GET /api/opportunities` Duey → 221 rows ✅
- `GET /api/opportunities` Jeff (no data) → 0 rows (isolation proven) ✅
- `GET /auth/logout` → 302 `/login` ✅
- `GET /api/me` after logout → 401 ✅

**npm dependencies added:** `express-session`, `bcryptjs`, `better-sqlite3-session-store`
