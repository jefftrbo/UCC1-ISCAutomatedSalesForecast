# UCC1 — Deployment Options Discussion
## ISC Automated Sales Forecast — Architecture & Distribution Strategy

**Date:** July 14, 2026  
**Participants:** Dushyant (Sales VP / App Owner), Bob (AI Software Engineer / IBM watsonx)  
**Context:** Evaluating deployment strategies for the ISC Automated Sales Forecast app ahead of IBM watsonx Challenge submission (deadline July 22, 2026) and potential viral adoption within IBM Public Market.

---

## User Question (verbatim)

> *"let's keep those 3 in our back pocket for now as ISC operations will most likely execute daily updates to our source dashboard a few times this upcoming week and we can test our HAR/Refresh Data let's say before EOD Wed 7/15. I want to run some new ideas past you, and I warn you that these may be pushing the limits of what's possible considering our screen scraping/HAR architecture. Here we go... think about this... Dushyant is a Sales VP, not a web developer/architect/etc, so while this app is turning into a significant business aid in terms of time savings, and AI fueled insights that drive financial forecasting and reporting economies of scale, we have to deploy this app most likely on his machine until we can figure out where to host this within the IBM intranet if it goes viral within Public Market. This is a significant operational problem. Additionally, he has to install the Cookie Editor, find the HAR so it can be loaded into our app's db's so he can do his work. Do you see the problem that may stop him from adopting this? What are some deployment options that don't involve official hosting on the IBM intranet?"*

---

## Bob's Analysis

### The Core Adoption Problem

Dushyant currently needs to:
1. Install Node.js
2. Clone a GitHub repo
3. Install dependencies (`npm install`)
4. Configure a `.env` file with API keys
5. Install Cookie Editor browser extension
6. Navigate to Salesforce, manually export a HAR file
7. Find that HAR file on his filesystem
8. Load it into the app

**That's 8 steps before he sees a single insight.** For a Sales VP who just wants to walk into a Monday GM meeting prepared — that's a non-starter. Even *weekly* HAR exports require him to know what a HAR file is.

---

### Honest Architecture Assessment

Before suggesting solutions, here's the hard constraint: **our data ingestion is HAR-based because Salesforce/Einstein Analytics blocks every programmatic auth approach we tried (Sessions 1–3, 7 attempts).** Any deployment option has to either:
- **(A)** Keep the HAR step but make it invisible/trivial to Dushyant, or
- **(B)** Eliminate the HAR step entirely via a different data path

---

### Deployment Options (Ranked by Realism)

#### 🥇 Option 1 — Electron Desktop App (Best fit, most realistic)
**What it is:** Package the entire Node.js server + frontend into a native `.app` (macOS) or `.exe` (Windows) using Electron. One double-click. No terminal, no Node install, no clone.

**How the HAR flow works with this:** You add a native file-picker dialog — Dushyant clicks "Load This Week's Data," selects the HAR from his Downloads folder via a standard macOS open-file dialog. That's the only manual step he needs to understand.

**Effort:** Medium. Electron wraps our existing Express server almost unchanged. Main work is the file-picker UI and packaging (`electron-builder`).

**Limitation:** He still has to export the HAR manually. But a file-picker is something any executive understands — it's "Open File," not "configure a developer tool."

---

#### 🥈 Option 2 — Browser Extension (Eliminates the HAR step entirely)
**What it is:** A Chrome/Edge extension that runs alongside his normal Salesforce session, intercepts the CRM Analytics API responses in the background, and POSTs them directly to our local app — no HAR export at all.

**How it works:** Extensions have access to `chrome.webRequest` (or `chrome.declarativeNetRequest`) APIs which can capture network responses that are inaccessible to Playwright. When he opens the Salesforce dashboard tab, the extension silently captures the deal-list API response and sends it to `localhost:3090/api/ingest`.

**This is the architecturally correct solution** — it sidesteps every auth barrier we hit in Sessions 1–3 because the extension runs *inside* his authenticated browser session with full cookie access.

**Effort:** Medium-high. New codebase (manifest v3 extension), but the parsing logic is already written in our HAR loader — we'd just adapt it.

**Limitation:** Requires a one-time extension install (much easier than Cookie Editor + HAR export). Won't work on a managed IBM browser if extensions are blocked by IT policy — worth verifying.

---

#### 🥉 Option 3 — Shared Network Drive / Simple Installer Script
**What it is:** A single shell script (`install.sh` / `install.bat`) that installs Node, clones the repo, sets up the `.env`, and adds a desktop shortcut. Paired with a shared OneDrive/Box folder where Dushyant drops HAR files — the app watches that folder and auto-ingests.

**How it works:** `chokidar` (file watcher) monitors `~/Downloads` or a designated folder. When a `.har` file appears, auto-ingest fires. Dushyant never touches the terminal after day one.

**Effort:** Low-medium. Mostly scripting around existing code.

**Limitation:** Still requires HAR export knowledge. The file-watcher is a nice touch but doesn't eliminate the manual step.

---

#### Option 4 — IBM Cloud Code Engine / Container (Future path, not now)
A Docker container deployed to IBM Cloud Code Engine with watsonx credentials baked into the environment. No local install needed — browser only.

**Hard blocker right now:** The HAR dependency. A cloud-hosted app can't receive a file from Dushyant's local Salesforce session without a client-side relay. This only becomes viable if we solve the data ingestion problem first (Option 2's extension approach is the relay).

---

### Bob's Recommendation

**Short-term (this week):** Option 3 — file-watcher auto-ingest + a dead-simple `start.command` double-click launcher for macOS. Gets him running with minimal friction while we validate the HAR workflow works reliably.

**Medium-term (before challenge submission / viral spread):** Option 2 — the browser extension is the *right* architectural answer. It turns an 8-step expert workflow into a one-click invisible background process. It also makes the app dramatically more compelling as a challenge submission — "zero-friction, auto-ingesting, AI-powered GM prep tool."

---

## User Response + Hybrid Proposal (verbatim)

> *"this is great work and what I need you to do is capture word-for-word everything I asked and you responded into a separate .html or .md (as well as our TechnicalSessionLog) so that I can share this w my co-collaborators on this watsonx challenge. This is going to be a group decision and you're included too, but it will happen sometime this week for obvious reasons. I love a hybrid solution combining Option 1 and 2, where we use Electron so we can drop the app on any IBM desktop until or if we can deploy it on our intranet, AND Option 2's elimination of the HAR step entirely... thoughts?"*

---

## Bob's Response to the Hybrid Proposal

### The Hybrid: Electron Shell + Embedded Browser Extension

This is not just viable — it's the **architecturally elegant answer** that makes both problems disappear simultaneously:

| Problem | Solution Component |
|---|---|
| "Dushyant can't install Node / clone a repo" | Electron — one `.app` / `.exe`, double-click to run |
| "HAR export is an 8-step expert workflow" | Embedded extension logic — auto-capture from Salesforce tab |
| "Can't deploy to intranet yet" | Electron buys time — deployable to any IBM desktop today |
| "If it goes viral in Public Market" | Electron → Cloud migration path is clean (same server code) |

### How the Hybrid Works — Technical Architecture

```
┌─────────────────────────────────────────────────────┐
│                  ELECTRON SHELL                      │
│  ┌─────────────────┐    ┌──────────────────────────┐ │
│  │  BrowserWindow  │    │   Express Server         │ │
│  │  (app UI)       │    │   (existing Node code)   │ │
│  │  localhost:3090 │    │   server/index.js        │ │
│  └─────────────────┘    └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         ↑                          ↑
         │                          │
┌─────────────────┐      POST /api/ingest
│  SECOND         │─────────────────┘
│  BrowserWindow  │  (intercepts Salesforce
│  (Salesforce    │   CRM Analytics API calls
│   session tab)  │   via session.webRequest)
└─────────────────┘
```

**Key insight:** Electron's `session.webRequest` API is the desktop equivalent of a browser extension's `chrome.webRequest`. It can intercept all network requests from a `BrowserWindow` — including the authenticated Salesforce CRM Analytics calls — without needing a separate extension install. The Electron app *is* the extension.

### The User Flow (Dushyant's perspective)

1. Double-click **ISC Sales Forecast.app**
2. App opens — shows the familiar Carbon UI dashboard
3. Click **"Open Salesforce"** button in the action bar
4. A second window opens, already navigated to the Salesforce CRM Analytics dashboard (his normal login flow)
5. He logs in as usual — **the app silently captures the deal-list API response in the background**
6. Dashboard auto-refreshes with live data — "Data loaded: 206 deals · Jul 14, 2026 · 9:12 AM"
7. Click **Score with watsonx** → **Generate GM Report** → done

**Zero HAR files. Zero terminal. Zero configuration after day one.**

### What Changes vs. Current Architecture

| Layer | Today | With Electron Hybrid |
|---|---|---|
| App launch | `npm start` in terminal | Double-click `.app` |
| Data ingestion | Manual HAR export + file upload | Electron `session.webRequest` auto-capture |
| Salesforce login | User's own browser (separate) | Second BrowserWindow inside the app |
| Server code | Unchanged | Unchanged — Electron spawns it |
| Frontend UI | Browser tab at localhost:3090 | Electron BrowserWindow (same HTML) |
| Distribution | Git clone + npm install | Single installer package |

### Build Effort Estimate

| Task | Effort |
|---|---|
| `electron-builder` packaging + main process (`main.js`) | 1 session |
| `session.webRequest` intercept → `POST /api/ingest` relay | 1 session |
| "Open Salesforce" BrowserWindow + auto-navigate | 0.5 session |
| macOS `.app` + Windows `.exe` packaging + code signing (optional) | 0.5 session |
| **Total** | **~3 sessions** |

### Open Questions for the Group

1. **IBM IT policy:** Can Electron apps be installed on managed IBM MacBooks/PCs without IT approval? (This is the single biggest unknown — worth a quick Slack to IT before committing.)
2. **Salesforce SSO inside Electron:** IBM uses SSO for Salesforce login. Electron's BrowserWindow supports SSO redirects natively, but we should verify the w3id/IBM SSO flow works in a non-standard browser context.
3. **watsonx API keys:** Each user of the Electron app needs their own `WATSONX_API_KEY` + `WATSONX_PROJECT_ID`, or we expose a shared key (security risk). A first-run setup wizard in the Electron shell could handle this gracefully.
4. **Intranet migration path:** When the time comes, the cloud version is already built — it's just the same Express server in a container. The Electron shell becomes optional once hosting is available.

### Recommendation to the Group

**Build the Electron hybrid.** It is the right long-term architecture for this app regardless of where it ultimately lives. The Electron shell buys immediate deployability to any IBM desktop, the `session.webRequest` intercept eliminates the only friction point in the current workflow, and the migration path to cloud hosting is clean because the server layer is untouched.

This also significantly strengthens the IBM watsonx Challenge submission — judges see a complete, deployable, zero-friction AI-powered business tool, not a developer prototype.

---

## Next Steps (Pending Group Decision)

- [ ] Group alignment call (this week) — confirm Electron hybrid direction
- [ ] IT policy check — can Electron apps install on managed IBM desktops?
- [ ] Salesforce SSO validation — test w3id login flow inside Electron BrowserWindow
- [ ] HAR/Refresh Data validation — target EOD Wed 7/15 (daily ISC dashboard updates expected)
- [ ] Begin `feature/electron-shell` branch if group confirms direction

---

*Document prepared by Bob (IBM watsonx AI) · ISC Automated Sales Forecast · UCC1 watsonx Challenge submission*
