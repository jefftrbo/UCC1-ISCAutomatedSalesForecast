# ISC Automated Sales Forecast

**Automates the weekly US Public Sector IBM Sales VP → GM meeting preparation workflow.**

Replaces 60–90 minutes of manual pipeline export, scoring, narrative writing, and PowerPoint building with a single five-minute workflow powered by IBM watsonx.ai.

> Built by Jeffrey L. Trbovich with [IBM Bob](https://w3.ibm.com) · IBM watsonx Challenge 2026 · Growth Enablers Track

---

## What It Does

| Step | Manual (before) | Automated (now) |
|---|---|---|
| Export pipeline data | Open ISC, copy/paste to spreadsheet | Upload one HAR file — done in 5 seconds |
| Score every deal | Eyeball each row | watsonx.ai Granite-13b scores all 206 in ~15 sec |
| Write GM narrative | Type from memory | Llama-3-70b generates meeting-ready prose in ~10 sec |
| See what changed | Remember last week | Diff engine compares live vs. saved baseline automatically |
| Build PowerPoint | Format slides by hand | One-click PPTX with GM narrative + scored deals + What Changed slide |

**Total time: under 5 minutes, every week.**

---

## Prerequisites

- **Node.js v18 or later** — [nodejs.org](https://nodejs.org/)
- **Chrome browser** — for HAR export (Brave also works)
- **Cookie Editor browser extension** — for first-time ISC session setup (see Step 3 below)
  - Chrome: [Cookie Editor on Chrome Web Store](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
  - Brave/Edge: same extension, available in their respective stores
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

Open `.env` in any text editor:

```env
# Leave WATSONX_ENABLED=false to use rule-based scoring (no credentials needed)
# Set to true once you have watsonx.ai API key and project ID
WATSONX_ENABLED=false

# IBM watsonx.ai credentials (required only if WATSONX_ENABLED=true)
WATSONX_API_KEY=your_ibm_cloud_api_key_here
WATSONX_PROJECT_ID=your_watsonx_project_id_here
WATSONX_URL=https://us-south.ml.cloud.ibm.com
```

**To run without watsonx.ai:** leave `WATSONX_ENABLED=false`. The app uses a rule-based confidence scoring engine and placeholder narratives. Fully functional.

**To run with watsonx.ai:** set `WATSONX_ENABLED=true` and fill in your API key and project ID.

### Step 3 — Start the app

```bash
npm start
```

Open your browser to **[http://localhost:3090](http://localhost:3090)**

You should see the ISC Automated Sales Forecast dashboard with the action bar at the top. The GM Ready indicator will show **"No data loaded"** until you complete the weekly data refresh below.

---

## Weekly Data Refresh (~2 minutes)

Every week before the GM meeting, follow these steps to load fresh pipeline data.

---

### Part A — Export your ISC pipeline data as a HAR file

**Why HAR?** IBM Sales Cloud (ISC) is protected by IBM w3id SSO with passkey authentication that blocks all programmatic access. The HAR file captures the authenticated API responses directly from your browser session — no credentials stored in the app, no security risk.

#### Step A1 — Open ISC in Chrome

Navigate to:
```
https://ibmsc.lightning.force.com/lightning/page/analytics?wave__assetType=dashboard
```

Log in with your IBM w3id credentials (passkey/Touch ID if prompted).

#### Step A2 — Apply the correct pipeline filters

Once the CRM Analytics dashboard loads:

1. **Opportunity Owner:** Clear your name → select **Dushyant K Patel** (or the Sales VP whose pipeline you're preparing)
2. Click the **"Deal List by Opportunity"** tab
3. **Forecast Grouping:** Select **Call, Upside, Stretch**
4. Confirm the table shows ~200 opportunities

> **Important:** The filters must be applied before exporting the HAR file. The HAR captures the API response for whatever data is currently displayed.

#### Step A3 — Open Chrome DevTools and start recording

1. Press **Cmd+Option+I** (Mac) or **F12** (Windows) to open DevTools
2. Click the **Network** tab
3. Make sure the **red record button** (●) is active — if it's grey, click it to start recording
4. With DevTools open, **reload the page** (Cmd+R) — this ensures the deal-list API call is captured fresh

#### Step A4 — Re-apply your filters

After the page reloads, re-apply the same filters from Step A2:
1. Opportunity Owner → Dushyant K Patel
2. Deal List by Opportunity tab
3. Forecast Grouping → Call, Upside, Stretch

Watch the Network panel — you should see requests firing as the data loads.

#### Step A5 — Export the HAR file

1. In the Network panel, click the **⬇ download icon** ("Export HAR" — it looks like a downward arrow, top-right of the Network panel)
2. Save the file anywhere convenient (e.g. `~/Downloads/isc-export.har`)

> **Tip:** The HAR file will be 5–15 MB. If it's smaller than 1 MB, the deal-list data may not have loaded — re-check your filters and try again.

---

### Part B — Load the HAR file into the app

With the app running at `http://localhost:3090`:

1. Click **"Refresh Data"** in the action bar
2. In the file picker that appears, select your exported HAR file
3. The app parses the HAR, extracts all opportunities, and loads them into the database
4. The pipeline status line updates: **"206 opportunities loaded · [timestamp]"**

The GM Ready indicator updates to show the next required action.

---

### Part C — Run the GM prep workflow

Once data is loaded, the action bar guides you through each step. All steps are independently re-runnable — no sequence lock.

#### Score with watsonx
Click **"Score with watsonx"** to run AI confidence scoring on all opportunities.
- With `WATSONX_ENABLED=true`: Granite-13b scores each deal via IBM watsonx.ai REST API (~15 sec)
- With `WATSONX_ENABLED=false`: Rule-based engine scores each deal instantly
- Each deal gets a **confidence score (0–100)** and **tier (Hot / Warm / Cold)**

#### Generate Narrative
Click **"Generate Narrative"** to produce the GM meeting opening text.
- With `WATSONX_ENABLED=true`: Llama-3-70b-instruct generates a VP-ready executive narrative (~10 sec)
- The narrative is **scoped to whatever filter you have applied** — use the named view presets or custom filters before generating
- **Named view presets** (filter bar): 📊 GM Prep · ⚠ At Risk · 🗂 Full Pipeline — click any to apply instantly

#### What Changed
Click **"⇄ What Changed"** to see the week-over-week diff against your last saved baseline.
- Shows: promoted deals, demoted deals, slipped close dates, amount changes, new deals, removed deals
- Click any category tile to open a drill-down modal with affected deals, before/after confidence scores, and financials

#### Baseline & Generate GM Report
Click **"📌 Save Baseline & Generate Report"** when you're satisfied with the data.
- A confirm modal explains what will happen
- Clicking confirm: saves today's pipeline as the new baseline (timestamped), generates the GM PowerPoint, and downloads it
- **Next week's diff will compare against this exact snapshot**

---

## Using Named View Presets

The filter bar includes three one-click view presets:

| Preset | What it shows |
|---|---|
| 📊 **GM Prep** | High-confidence deals (score ≥ 70) closing within 90 days — the GM meeting's primary focus |
| ⚠ **At Risk** | Deals with low confidence (score < 40) or slipped close dates — needs VP attention |
| 🗂 **Full Pipeline** | All 206 opportunities — unfiltered |

Active preset is highlighted with a blue left border. Changing any filter manually clears the active preset.

---

## The Generated PowerPoint

The PPTX includes:
- **Cover slide** — GM narrative paragraph + key pipeline stats
- **Deal slides** — one per opportunity, sorted by confidence score, with stage, close date, amount, tier badge, and next-steps summary
- **"What Changed" slide** — week-over-week delta summary (Granite-3-8b generated)

Downloaded automatically to your browser's default download folder as `GM-Report-[date].pptx`.

---

## App Structure

```
server/
  index.js          — Express API server (port 3090); all endpoints
  db.js             — SQLite schema + migrations (opportunities + snapshots tables)
  diffEngine.js     — saveSnapshot(), computeDiff(); live-vs-baseline model
  watsonxScore.js   — scoreWithWatsonx(), generateNarrative(), generateDeltaSummary()
  scoreOpportunity.js — rule-based scoring engine (fallback)
  generatePpt.js    — PowerPoint generator (cover + data + What Changed slides)

public/
  index.html        — Full frontend; Carbon Design UI, action bar, filter bar,
                      named presets, diff panel, narrative panel, tile modals

scripts/
  test-diff.js      — Unit test: all 8 diff scenarios (snapshots 206 rows, mutates 8, restores)
  seed-changes.js   — UI end-to-end test helper (--restore, --status flags)

poc/
  electron-shell/   — Electron PoC (proof-of-concept for future zero-HAR architecture)

.env.example        — Template for WATSONX_ENABLED, WATSONX_API_KEY, WATSONX_PROJECT_ID
package.json        — npm start → node server/index.js
```

---

## Testing the Diff Engine

To verify the week-over-week diff engine works correctly without needing a real second HAR file:

```bash
# Runs all 8 diff scenarios (promotes, demotes, slips, amounts, new, removed, unchanged, stale)
# Snapshots all 206 rows as baseline, mutates 8, verifies diff output, then fully restores
node scripts/test-diff.js
```

To test the UI end-to-end with seeded changes:

```bash
# Seeds 5 visible changes into the database for UI testing
node scripts/seed-changes.js

# After testing, restore original data
node scripts/seed-changes.js --restore

# Check current seeded state
node scripts/seed-changes.js --status
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| HAR file uploads but shows 0 opportunities | Filters weren't applied before export — re-apply Opportunity Owner + Forecast Grouping filters and re-export |
| HAR file is < 1 MB | Deal-list data didn't load — reload the ISC page with DevTools open and filters applied |
| watsonx scoring fails | Check `WATSONX_ENABLED=true` and that `WATSONX_API_KEY` + `WATSONX_PROJECT_ID` are set in `.env`. App falls back to rule-based scoring automatically. |
| Port 3090 already in use | `lsof -i :3090` to find the process, then `kill [PID]` |
| "No data loaded" after uploading HAR | Check the terminal for parse errors — the HAR may not contain the CRM Analytics deal-list response. Try re-exporting with a fresh page reload inside DevTools. |
| Diff shows everything as "new" | No baseline snapshot saved yet — run the full workflow once and click "Save Baseline" at the end |

---

## Version History

| Version | What changed |
|---|---|
| v1.0.0 | HAR → SQLite → rule-based scoring → PowerPoint pipeline |
| v2.1.0-rc1 | watsonx.ai scoring + GM narrative + week-over-week diff engine |
| v2.2.0 | IBM Carbon Design System UI · Model 3 action bar · named view presets · per-tile diff modals · GM Ready indicator · timestamp snapshots · score/tier persisted to DB |

---

## IBM watsonx Challenge 2026

This app is a submission for the **IBM watsonx Challenge 2026, Growth Enablers track** (deadline July 22, 2026).

- **Business value:** 90 min → under 5 min weekly GM prep · 94% time reduction
- **watsonx.ai models:** `ibm/granite-13b-instruct-v2` (scoring) · `meta-llama/llama-3-70b-instruct` (narrative) · `ibm/granite-3-8b-instruct` (delta summary)
- **Built with:** IBM Bob (IBM's watsonx AI development assistant)
- **Deployment path:** CIO "Build with watsonx" Path to Production (ServiceNow AI System Demand in progress)

---

*UCC1 — ISC Automated Sales Forecast · US Public Sector IBM · v2.2.0*
