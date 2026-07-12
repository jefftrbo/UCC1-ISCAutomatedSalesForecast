# UCC1 — ISC Automated Sales Forecast

Automates the weekly Sales VP → US Public Sector GM meeting preparation workflow.

**What it does:**
1. Scrapes current sales opportunity data from an ISC web page under your IBM SSO session
2. Stores it in a local SQLite database
3. Lets you select which opportunities to include in the GM meeting via a simple web app
4. Generates a clean executive PowerPoint from your selection

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [npm](https://www.npmjs.com/) (comes with Node.js)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install the Playwright Chromium browser

```bash
npx playwright install chromium
```

### 3. Configure your ISC URL

Edit `config.json` and replace the placeholder with your real ISC forecast page URL:

```json
{
  "iscUrl": "https://your-isc-forecast-page-url-here",
  "browserProfilePath": "./browser-profile"
}
```

### 4. Log in to ISC (one-time setup)

Run this command to open a **visible** browser window where you can log in with your IBM SSO credentials. Your session will be saved to the `browser-profile/` folder so future scrapes run headlessly without re-authentication.

```bash
node scraper/login.js
```

Log in fully, wait for the ISC forecast page to load, then close the browser window. You only need to do this once (or again if your session expires).

---

## Running the App

### Start the local server

```bash
npm start
```

Then open your browser to: **[http://localhost:3090](http://localhost:3090)**

---

## Weekly Data Refresh (≈ 2 minutes)

Each week before the GM meeting, follow these steps to load fresh ISC data:

**Step 1 — Open ISC in Brave and set filters:**
- Opportunity Owner → clear your name → select **Dushyant K Patel**
- Click **Deal List by Opportunity** tab
- Forecast Grouping → select **Call, Upside, Stretch**
- Confirm the table shows the VP's data (~200 opportunities)

**Step 2 — Export HAR file from DevTools:**
- Press **Cmd+Option+I** → click **Network** tab
- Click the **⬇ export icon** (top of Network panel) → "Save all as HAR with content"
- Save as: `scraper/isc-export.har`

**Step 3 — Load data (two options):**

Option A — Terminal:
```bash
node scraper/load-from-har.js
```

Option B — Web app (if `npm start` is running):
- Click **Refresh Data** — it auto-detects the HAR file

---

## Using the Web App

| Button | What it does |
|---|---|
| **Refresh Data** | Loads data from `scraper/isc-export.har` (or other sources) |
| Checkboxes | Select which opportunities to include in the GM meeting |
| **Generate PPT** | Creates a PowerPoint of your selected opportunities and downloads it |

Generated PowerPoint files are saved to the `output/` folder as `forecast-YYYY-MM-DD.pptx`.

---

## Project Structure

```
├── config.json              # ISC URL and browser profile path
├── package.json
├── scraper/
│   ├── scrape.js            # Playwright-based ISC scraper
│   └── login.js             # One-time SSO login helper
├── server/
│   ├── index.js             # Express API server
│   ├── db.js                # SQLite database module
│   └── generatePpt.js       # PowerPoint generator
├── public/
│   └── index.html           # Frontend web app
└── output/                  # Generated .pptx files
```

---

## .gitignore (create this file manually)

Add a `.gitignore` with the following content to avoid committing sensitive or generated files:

```
node_modules/
*.db
output/*.pptx
browser-profile/
scraper/cookies.json
scraper/api-dump.json
scraper/isc-export.har
scraper/devtools-response.json
.env
```

---

## Future Enhancements

- [ ] Swap in IBM PPT template for GM-submission formatting (hook is ready in `generatePpt.js`)
- [ ] Add additional ISC fields as needed (DB schema and scraper are designed to accommodate)
- [ ] Tune Playwright DOM selectors once real ISC URL is configured

---

*Project: UCC1-ISCAutomatedSalesForecast | US Public Sector Sales*
