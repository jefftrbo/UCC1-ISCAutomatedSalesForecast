# UCC1 — Technical Session Log
## ISC Salesforce Authentication & Data Extraction Attempts

> Full technical record of the 5+ hour engineering session attempting to automate
> data extraction from IBM Sales Cloud (ISC) — a Salesforce CRM Analytics (Einstein
> Analytics) instance protected by IBM w3id SSO with passkey authentication.
>
> **OUTCOME: ✅ RESOLVED** — 206 opportunities successfully loaded via HAR export.
> See "Attempt 8" at the top of this file for the winning solution.
>
> Preserved for future reference, onboarding, and architectural decision-making.

---

## Context

**Goal:** Automatically extract sales opportunity data from the ISC "Forecast v66.0"
dashboard (Deal List by Opportunity tab) filtered to VP Dushyant K Patel's
Call/Upside/Stretch opportunities, store in SQLite, and surface in a local web app
for GM meeting prep.

**ISC URL:**
```
https://ibmsc.lightning.force.com/lightning/page/analytics?wave__assetType=dashboard
&wave__assetId=0FK3h000000IogaGAC&wave__pageId=bb9b2264-d05a-4a57-881b-100ae3f79e15
&wave__savedViewId=8wkKa000000p5UcIAI
```

**Platform:** Salesforce Lightning + CRM Analytics (Einstein Analytics) dashboard  
**Auth:** IBM w3id SSO with **passkey** (biometric/device-bound, macOS Secure Enclave)  
**Dataset:** `All_Opportunities` (`0FbKa000000oMGfKAM`)

---

## Attempt 1 — Playwright with Default Chromium (login.js)

**Approach:** Use Playwright's `launchPersistentContext` with headless Chromium. Open
a visible browser window so the user can log in with IBM w3id SSO credentials once,
save the session to a `browser-profile/` directory, then run headlessly on future scrapes.

**What happened:**
- Playwright launched Chromium successfully
- IBM w3id login page loaded
- **Passkey option not available** — IBM had disabled password-based login and required
  a passkey. Chromium doesn't have the user's passkey registered (passkeys are
  device-bound to the OS Secure Enclave via the registered browser).

**Root cause:** IBM w3id passkeys are registered per browser. The user's passkey is
registered in Brave, not in a fresh Chromium instance.

**Status:** ❌ Failed — passkey not available in Playwright's Chromium

---

## Attempt 2 — Cookie Import (import-cookies.js)

**Approach:** User exports session cookies from Brave (where they're already logged in)
using the Cookie-Editor browser extension, saves as `scraper/cookies.json`. A script
imports those cookies into the Playwright persistent browser profile, allowing Playwright
to reuse the existing Brave session.

**What happened:**
- Cookie-Editor installed and used to export cookies from the ISC dashboard page
- Initially exported only 8 cookies — `sid` was present
- `import-cookies.js` ran, Playwright launched, attempted to navigate to ISC
- **Timeout error:** `page.goto` with `waitUntil: 'networkidle'` — ISC's Einstein
  Analytics dashboard continuously makes background API calls and never reaches
  network idle state

**Fix applied:** Changed `waitUntil` from `'networkidle'` to `'domcontentloaded'`
with an 8-second additional wait.

**Second attempt:**
- Browser opened but **ISC showed IBM login page** — cookies had been invalidated
- User had logged out of ISC earlier (to invalidate the previously exposed `sid` token
  that was accidentally shared in chat), which expired the session

**Key learning:** Salesforce `sid` tokens are short-lived and invalidated on logout.
Cookie export timing is critical.

**Status:** ❌ Failed — session invalidation and timing issues

---

## Attempt 3 — Playwright with Brave Executable (login.js rewrite)

**Approach:** Instead of using Playwright's bundled Chromium, launch the user's actual
**Brave browser** binary (`/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`)
with a Playwright-managed persistent context pointing to a fresh profile directory.
Since Brave's engine is used, the passkey registered in Brave should be accessible.

**What happened:**
- Brave launched via Playwright, navigated to ISC
- **IBM passkey worked** — Touch ID authenticated successfully
- ISC dashboard loaded in the background
- macOS security popup appeared ("IBM Bob.app wants to make changes")
- User force-quit Brave due to inability to close normally (Cmd+Q unresponsive)
- Subsequent attempts failed because:
  - Force quit left browser profile lock files (`SingletonLock`, `SingletonCookie`)
  - Playwright could not attach to the profile
  - When lock files were cleared and scraper ran, Brave crashed when user tried
    to interact with dashboard filters

**Root cause of Brave crashes:** Playwright's `launchPersistentContext` conflicts with
Brave's internal process management, extension handling, and passkey subsystem when
the user attempts to interact with page elements. Brave is not designed to be
controlled by an external automation framework.

**Status:** ❌ Failed — Brave crashes on filter interaction under Playwright control

---

## Attempt 4 — Network Interception via Playwright Route

**Approach:** Before navigating, register Playwright route interceptors for:
- `**/wave/query**`
- `**/wave/datasets/**`
- `**/wave/dashboards/**`
- `**/services/data/**/wave/**`

When the dashboard loads, Salesforce CRM Analytics makes internal `/wave/query` API
calls to fetch the opportunity records. Playwright intercepts these responses, extracts
the JSON payload, and saves the records to SQLite without any DOM parsing.

**What happened:**
- Session issue prevented dashboard from loading in first attempts
- When browser did load: **no `/wave/` API responses were intercepted**
- Diagnosis: Einstein Analytics uses a **Service Worker** that caches responses.
  On subsequent loads, data is served from the SW cache, bypassing the network layer
  entirely — Playwright's route interceptors never fire

**Fix attempted:** Added `page.reload()` after initial navigation to force fresh API calls.

**Result:** Reload triggered, but data still not intercepted because:
- The manual filter steps (change owner, select forecast groupings) hadn't been applied
  yet at reload time
- Without the correct filters, the wrong dataset would be captured anyway

**Additional complexity discovered:** The user must manually set 4 filter steps before
the correct data appears:
1. Opportunity Owner: clear "Jeffrey L Trbovich" → select "Dushyant K Patel"
2. Click "Deal List by Opportunity" tab
3. Forecast Grouping: select Call, Upside, Stretch
4. Confirm table shows VP's data

**Status:** ❌ Failed — service worker cache and manual filter dependency

---

## Attempt 5 — Manual Filter + Enter to Capture (scrape.js --headed)

**Approach:** Rewrite the scraper to pause execution after the browser opens, print
a step-by-step filter checklist in the terminal, and wait for the user to press Enter
after completing the filters. On Enter, clear captured payloads, reload the page,
and capture the fresh `/wave/` API responses.

**What happened:**
- Script launched correctly with `--headed` flag
- Checklist printed in terminal
- Brave opened and navigated to ISC
- User attempted to set filters in the Brave window
- **Brave crashed** every time the user interacted with the dashboard filters
- Root cause: same Playwright/Brave conflict as Attempt 3

**Status:** ❌ Failed — Brave crashes on interaction under Playwright control

---

## Attempt 6 — DevTools Network Tab Manual Capture (load-from-devtools.js)

**Approach:** Abandon Playwright for data capture entirely. User opens ISC in their
**regular Brave browser** (not Playwright-controlled), sets filters manually, then
uses **Brave DevTools → Network tab** to find the `/wave/query` XHR response and
copy the JSON. Save as `scraper/devtools-response.json`. A script parses and loads it.

**What happened:**
- User set filters successfully in regular Brave — data visible ($122.1M, 206 opps)
- Opened DevTools → Network → filtered on `wave` → filtered on Fetch/XHR
- **Could not find the right request:**
  - Cmd+F searched within response bodies (not request names) — confusion
  - Many requests visible but the largest opportunity data payload not easily identifiable
  - The most prominent request was `aura?r=5&aura.Wave.getDatasets=1` (4.1 kB)
  - User saved that response to `devtools-response.json`

**Result of parsing that file:**
- JSON structure was `{ actions: [{ returnValue: { datasets: [...] } }] }`
- This was **dataset metadata** (23 datasets with IDs and version URLs), not opportunity records
- `load-from-devtools.js` correctly reported "No records found"

**Silver lining:** The metadata file contained the `All_Opportunities` dataset version URL:
```
/services/data/v67.0/wave/datasets/0FbKa000000oMGfKAM/versions/0FcgR000004Pp6hSAC
```
This became the foundation for Attempt 7.

**Status:** ❌ Failed (wrong response captured) — but yielded critical dataset metadata

---

## Attempt 7 — Direct Salesforce CRM Analytics REST API (fetch-from-api.js)

**Approach:** Use the dataset version URL from Attempt 6's metadata to directly query
the Salesforce CRM Analytics REST API via Node.js HTTPS requests, authenticated with
cookies from `cookies.json`. Build a SAQL query to filter to Dushyant K Patel's
Call/Upside/Stretch opportunities:

```saql
q = load "All_Opportunities";
q = filter q by 'Opportunity_Owner' == "Dushyant K Patel";
q = filter q by 'Forecast_Grouping' in ["Call", "Upside", "Stretch"];
```

**What happened — Round 1:** HTTP 401 — session expired (cookies.json was stale)

**Root cause of stale cookies:** User had previously logged out to invalidate an
accidentally-shared `sid` token.

**What happened — Round 2 (bookmarklet approach):**
To avoid the manual Cookie-Editor export race condition, built a Brave bookmarklet:
```javascript
window.open('http://localhost:3090/api/save-cookies?c='+encodeURIComponent(document.cookie),'_blank')
```
This opened a localhost tab passing `document.cookie` as a URL parameter.

**Critical discovery:** `document.cookie` in JavaScript **cannot read `httpOnly` cookies**.
The Salesforce `sid` session token is set with `httpOnly: true` specifically to prevent
JavaScript from reading it. The bookmarklet captured 9 cookies but **not `sid`**.

**What happened — Round 3 (watch-cookies.js + Cookie-Editor export):**
Built a file watcher (`watch-cookies.js`) that monitors `cookies.json` for changes.
User exports via Cookie-Editor (which has browser extension privileges and CAN read
httpOnly cookies), watcher detects the change, immediately runs `fetch-from-api.js`.

Cookie-Editor export **did include `sid`** (confirmed: 8 cookies, sid present).

**Result:** Still HTTP 401.

**Root cause (final diagnosis):** Salesforce validates sessions not just by cookie value
but also by **browser fingerprint** — User-Agent, TLS fingerprint, IP binding, and
potentially other header characteristics. A raw Node.js `https.request` does not match
Brave's fingerprint. Salesforce's security model explicitly rejects API calls that
don't originate from the same browser session context that created the `sid`.

**Status:** ❌ Failed — Salesforce browser fingerprint validation rejects raw Node.js HTTP

---

## What We Built (Despite Auth Challenges)

Despite the authentication wall, the full application infrastructure is complete and working:

### Files Created

| File | Purpose | Status |
|---|---|---|
| `server/db.js` | SQLite schema — 24 columns matching all 20 ISC dashboard columns + raw_data + metadata | ✅ Working |
| `server/index.js` | Express API — 4 endpoints (opportunities, select, scrape, generate-ppt) | ✅ Working |
| `server/generatePpt.js` | pptxgenjs PowerPoint generator — cover slide + exec table | ✅ Working |
| `public/index.html` | VP selection UI — sortable table, 22 columns, sticky header/checkbox, all badges | ✅ Working |
| `scraper/scrape.js` | Playwright scraper with network interception + manual filter pause | ⚠️ Auth blocked |
| `scraper/login.js` | Brave browser session launcher | ⚠️ Brave crashes under Playwright |
| `scraper/import-cookies.js` | Cookie import from Cookie-Editor JSON export | ⚠️ sid timing issues |
| `scraper/fetch-from-api.js` | Direct Salesforce CRM Analytics REST API with SAQL | ⚠️ 401 fingerprint block |
| `scraper/load-from-devtools.js` | Load from manually-captured DevTools response | ⚠️ Correct response not yet captured |
| `scraper/watch-cookies.js` | File watcher — auto-runs fetch on cookie save | ⚠️ Depends on fetch-from-api |

### Database Schema (confirmed working)
```sql
id, opportunity_name,
filtered_opportunity_amount, total_opportunity_amount,
opportunity_owner, opportunity_owners_manager, opportunity_created_by,
close_date, create_date,
stage, forecast_category, flm_judgement,
account_name, account_company, account_db_dc,
next_steps, team_notes,
business_partner, technology_client, acquisition_pipeline, ibm_technology_plan,
raw_data, scraped_at, selected
```

---

## Key Technical Learnings

### 1. Einstein Analytics Never Reaches `networkidle`
The dashboard continuously polls background APIs. Always use `waitUntil: 'domcontentloaded'`
with an explicit `waitForTimeout()`.

### 2. Service Workers Cache `/wave/` Responses
Einstein Analytics registers a service worker that caches API responses. On subsequent
page loads, data comes from the SW cache — not the network — so Playwright route
interceptors don't fire. A full page reload forces fresh API calls.

### 3. Playwright Cannot Safely Control Brave
`launchPersistentContext` with Brave's binary works for navigation, but Brave crashes
when Playwright attempts to interact with page elements. Brave is not designed to run
under external automation frameworks. Use Chromium for automation, Brave for the human session.

### 4. `document.cookie` Cannot Read `httpOnly` Cookies
The Salesforce `sid` session token is `httpOnly: true`. JavaScript bookmarklets,
console scripts, and any browser-side JS cannot read it. Only browser extension APIs
(like Cookie-Editor) have the necessary privileges.

### 5. Salesforce Validates Sessions by Browser Fingerprint
Even with a valid `sid` cookie, direct Node.js HTTPS requests are rejected with HTTP 401/302.
Salesforce binds sessions to the browser's User-Agent, TLS fingerprint, and potentially IP.
The only reliable way to make Salesforce API calls from Node.js is via OAuth 2.0 with
a Connected App — not cookie-based authentication.

### 6. CRM Analytics SAQL API is the Right Target
Once proper OAuth credentials are available, the Salesforce CRM Analytics REST API
at `/services/data/v67.0/wave/query` with SAQL queries is the correct, reliable,
and officially supported approach. The dataset ID (`0FbKa000000oMGfKAM`) and SAQL
filter structure are already built and ready.

### 7. HAR Export is a Viable Alternative
Brave DevTools → Network → Export HAR captures all network responses including the
full `/wave/query` JSON response body. This could be a workable weekly manual step
if parsed correctly.

---

## Paths Forward (Options)

### Option A — Salesforce Connected App OAuth (Permanent Fix)
**Ask IBM Salesforce admin for a Connected App with OAuth 2.0 credentials.**
- One-time admin request
- Gives proper `access_token` via Username-Password or JWT flow
- `fetch-from-api.js` already has the SAQL query built — just swap cookie auth for Bearer token
- Fully automated, no browser interaction required
- **Recommended long-term solution**

### Option B — HAR File Export (Weekly Manual Step, 2 minutes)
With filters set and data visible in Brave:
1. DevTools → Network → ⬇ Export HAR (download icon at top of Network tab)
2. Save as `scraper/har-export.har`
3. Write a script to extract the largest `/wave/query` response from the HAR JSON
4. Run `node scraper/load-from-har.js`

### Option C — Correct DevTools Response Capture (load-from-devtools.js)
The `load-from-devtools.js` script is built and working — it just needs the right JSON.
With filters set, in the Network tab filtered to Fetch/XHR:
- Look for a request with `query` in the URL path (not `getDatasets`)
- The response Preview tab should show `{ "results": { "records": [...] } }`
- That's the one to copy

### Option D — Selenium with Chrome DevTools Protocol (CDP)
Use Selenium with Chrome's DevTools Protocol instead of Playwright. CDP gives lower-level
access to the browser session and may be able to proxy requests through the browser's
existing authenticated session rather than making independent Node.js HTTP calls.

---

## Session Metadata

- **Date:** July 2025
- **Duration:** 4+ hours
- **Project:** UCC1-ISCAutomatedSalesForecast
- **Stack:** Node.js 24, Playwright, Express, SQLite (better-sqlite3 v11), pptxgenjs
- **Port:** 3090 (3000 reserved for another app)
- **App URL:** http://localhost:3090
## ✅ RESOLVED — Attempt 8: HAR Export with Deal List Tab Trigger

**Script:** `scraper/load-from-har.js`

---

### What a HAR File Is
A HAR (HTTP Archive) is a JSON snapshot of every network request and response
captured by the browser's DevTools Network tab. Unlike cookie-based approaches,
it bypasses all authentication — the data is already in the file, decoded and readable.
Brave exports HAR files natively from DevTools with full response bodies included.

---

### Why Earlier Approaches Failed (and HAR Succeeds)

| Approach | Why it failed |
|---|---|
| Playwright + Chromium | Passkey not registered in Chromium |
| Cookie import | `sid` token is `httpOnly` — JS can't read it |
| Raw Node.js HTTPS + cookies | Salesforce validates browser fingerprint — rejects non-browser requests |
| Playwright + Brave | Brave crashes under Playwright control on filter interaction |
| Network interception | Service worker caches `/wave/` responses — interceptors never fire |
| DevTools response copy | Copied wrong entry (dataset metadata, not opportunity records) |
| HAR (first attempt) | Network tab opened after page load — deal list already cached, not in HAR |

**HAR works because:** The browser does all the authentication and data fetching.
We just snapshot what it received. No session tokens, no fingerprinting, no automation conflict.

---

### Critical Discovery: Deal List Uses Lazy Loading

The "Deal List by Opportunity" table does **NOT** load its data on initial dashboard load.
It only fires its `/analytics/wave/ui` API call when the user **clicks the tab**.
This is why:
- The first HAR export (6 MB, full page load) had NO deal list data
- The second HAR export (0.9 MB, after clicking the tab) had all 206 rows

**The Network tab must be open and recording at the moment you click the Deal List tab.**

---

### HAR Structure — What's Inside

The winning HAR contained 20 `/wave/` entries across two API calls:

| Entry | Records | Content |
|---|---|---|
| Entries 1–4, 9–13... | 8–40 | Chart/widget aggregate data (by product, stage, forecast) |
| Entry 14 | 206 | `{ OpportunityId, count: 1 }` — just IDs, no field data |
| Entry 15 | 193 | Seller name counts |
| **Entry 20** | **206** | **Full opportunity records — all 20 columns** ✅ |

**Entry 14 was a trap** — it has 206 records and an `OpportunityId` field, but each
record is just `{ OpportunityId: "...", count: 1 }`. The parser initially selected this
entry because it scored highest. The fix: detect full records by presence of `Opp.Name`
or `Opp.Stage` (unique to the deal list), not just `OpportunityId`.

---

### Confirmed Field Names (Entry 20, 206-record deal list)

These are the exact Salesforce API field names returned in the HAR — not guesses:

| HAR field name | DB column |
|---|---|
| `Opp.Id` | `id` |
| `Opp.Name` | `opportunity_name` |
| `Filtered Opportunity Amount` | `filtered_opportunity_amount` |
| `Total Opportunity Amount` | `total_opportunity_amount` |
| `Opp.User.User_Name_mk__c` | `opportunity_owner` |
| `Opp.FLM.User_Name_mk__c` | `opportunity_owners_manager` |
| `Opp.CreatedBy.User_Name_mk__c` | `opportunity_created_by` |
| `Opp.CloseDate` | `close_date` |
| `CreateDate` | `create_date` |
| `Opp.Stage` | `stage` |
| `Opp.ForecastCategoryName` | `forecast_category` |
| `FLMJudgement` | `flm_judgement` |
| `Opp.Acc.Name` | `account_name` |
| `Opp.Acc.Company__c` | `account_company` |
| `Opp.Acc.DB_DC__c` | `account_db_dc` |
| `Opp.NextStep` | `next_steps` |
| `Opp.Team_Notes__c` | `team_notes` |
| `Opp.BP.Name` | `business_partner` |
| `Opp.Acc.Technology_Client__c` | `technology_client` |
| `AcquisitionPipeline2` | `acquisition_pipeline` |
| `Opp.AccountPlanQuipDocURL` | `ibm_technology_plan` |

---

### Exact Winning Sequence

```
1. Open ISC in Brave (regular browser — passkey works normally)
2. Set filters:
     • Opportunity Owner → clear your name → select "Dushyant K Patel"
     • Forecast Grouping → Call, Upside, Stretch
3. Press Cmd+Option+I → Network tab → click 🚫 (clear existing entries)
4. Click "Deal List by Opportunity" tab in the ISC dashboard
     → Watch new entries appear in the Network tab
5. Wait for all 206 rows to load in the table
6. Click ⬇ export icon → "Save all as HAR with content"
     → Save as: scraper/isc-export.har  (~0.9 MB)
7. In terminal:
     node scraper/load-from-har.js
     → SUCCESS: 206 opportunities loaded into database.
8. Open http://localhost:3090 → full table with real data ✅
```

---

### Result

```
SUCCESS: 206 opportunities loaded into database.

Sample records confirmed:
  - "2026_Labcorp_sRenewal" | LABORATORY CORP OF AMERICA HOLDINGS-US | $13.5M | 2026-09-25
  - "Corporate ELA Software Amendment" | BLUE CROSS & BLUE SHIELD OF SOUTH CAROLINA-US | $8.7M
  - "Data Withheld" | PPSS DR | $14.7M | 1 - Engage | Omitted
```

**Status:** ✅ WORKING — 206 opportunities in SQLite, all 20 columns populated

---

### Weekly Workflow (≈ 2 minutes)

```
1. ISC in Brave → Owner: Dushyant K Patel → Call/Upside/Stretch
2. DevTools → Network → 🚫 clear → click Deal List tab → wait for load
3. ⬇ Export HAR → save as scraper/isc-export.har
4. node scraper/load-from-har.js
   (or click Refresh Data in the web app at http://localhost:3090)
```

---

## Session 2 — UI Polish & v1.0.0 Release (July 11, 2026)

**Duration:** ~8 hours  
**Outcome:** Full UI/UX polish pass, confidence scoring engine, v1.0.0 committed to GitHub

---

### Features Built

#### Confidence Scoring Engine (`server/scoreOpportunity.js`)
Rule-based 0–100 score computed server-side on every API response. Six signals:

| Signal | Weight | Logic |
|---|---|---|
| Stage | 30 pts | 5-Negotiate → 1-Engage |
| Forecast | 25 pts | Call/Commit → Best Case → Pipeline → Omit |
| Close Date | 20 pts | CQ position with last-2-week sandbagging discount |
| FLM Judgement | 10 pts | Yes = 10 |
| Next Steps | 10 pts | Strong commit language → active → stale/TBD |
| Team Notes | 5 pts | Date-stamped + length heuristic |

Tiers: 🟢 High (70–100) · 🟡 Medium (40–69) · 🔴 Low (0–39)

---

#### UI Upgrades (`public/index.html`)

**Filters — multi-select dropdowns (Quarter / Stage / Forecast / Confidence)**
- Custom checkbox-in-dropdown — stays open until user clicks outside
- "All" master checkbox syncs child options
- Trigger shows selection count badge when filtered
- Smart defaults on every load: Q3 2026 · Best Case · 🟢 High + 🟡 Medium
- "Clear filters" resets to same smart defaults (not "All")
- Quarter dropdown hardcoded with Q1–Q4 current + next year, merged with data

**Live totals bar**
- Sticky bar between filter bar and table
- Shows IBM Tech Amt + Total Amt sums for the current filtered view
- Updates instantly on every filter change

**3-column freeze pane (Excel-style)**
- Checkbox · Confidence · Opportunity columns sticky-left
- Opportunity column left offset recalculated from Confidence column width

**Column resize handles**
- Drag any column header edge to resize
- Uses `table-layout: fixed` after snapshotting rendered widths via `getBoundingClientRect()`
- Visual blue indicator on hover/drag

**Column order (logical left-to-right)**
Checkbox · Confidence · Opportunity · Account Detail · IBM Tech Amt · Total Amt · Next Steps · Close Date · Quarter · Create Date · Stage · Forecast · Owner · Owner's Manager · Created By · FLM Judgement · Account (Company) · Account (DB/DC) · Team Notes · Business Partner · Technology Client · Acquisition Pipeline · IBM Technology Plan · Opportunity ID

**Truncated text with more/less toggle**
- Opportunity: 40 chars, word boundary
- Account Detail: 40 chars, word boundary
- Next Steps: 250 chars, word boundary
- Team Notes: 250 chars, word boundary
- `truncCell(val, limit)` — single function, configurable limit

**Selection summary context-aware**
- No filters: `7 of 206 selected`
- Filters active hiding some selections: `7 selected total (0 in view)`

**Other polish**
- Confidence column: removed progress bar, locked to 72px — pill badge only
- Filtered Amt renamed to IBM Tech Amt throughout (web app + PPT)
- Owner / Owner's Manager / Created By moved after Forecast
- Version displayed in header (`Week of … · v1.0.0`) and footer
- Min Amount filter: formatted text input with live comma insertion

---

#### PowerPoint Generator (`server/generatePpt.js`)

- Header row reduced from 11pt → 10pt
- Geometry constants extracted: `TABLE_TOP`, `BOTTOM_BAR_Y`, `USABLE_H`
- Rows per slide computed dynamically: `Math.floor((USABLE_H - HEADER_ROW_H) / DATA_ROW_H)` = **18 rows**
- Per-row height array: header gets 0.30", data rows 0.32" each
- Next Steps truncated to 120 chars in PPT (full text stays in web app)
- Bottom bar y-position driven by constant — nothing bleeds off slide

---

### v1.0.0 Release
- `package.json` version confirmed at `1.0.0`
- `.gitignore` created — excludes `node_modules/`, `*.db`, `*.pptx`, `cookies.json`, `isc-export.har`, `browser-profile/`
- Git repo initialized, initial commit: 25 files, 6,142 insertions
- Pushed to `https://github.com/jefftrbo/UCC1-ISCAutomatedSalesForecast`

---

