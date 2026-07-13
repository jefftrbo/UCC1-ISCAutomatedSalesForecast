# UCC1 — Electron PoC

**Purpose:** Prove the three technical unknowns in the Electron hybrid architecture before any production code is written.

---

## What This Proves

| # | Claim | How it's proved |
|---|---|---|
| 1 | Express server starts inside an Electron process | Status page loads at `localhost:3091` |
| 2 | IBM w3id SSO login completes inside a BrowserWindow | Salesforce dashboard loads after login |
| 3 | `session.webRequest` (via CDP) intercepts the CRM Analytics deal-list response | Status page flips to "✅ Captured N records" |

**This PoC contains zero production code.** No SQLite, no scoring, no PPT, no Carbon UI. Pure signal.

---

## Prerequisites

- Node.js ≥ 18
- Access to IBM Salesforce (w3id SSO credentials)
- macOS (tested) or Windows

---

## Run It

```bash
cd poc/electron-shell
npm install
npm start
```

**What happens:**
1. A small status dashboard opens (this is the "app window")
2. A Salesforce window opens automatically (navigate to the CRM Analytics deal-list dashboard)
3. Log in with your IBM w3id credentials as normal
4. Navigate to the pipeline/deal-list dashboard
5. Watch the status panel — it updates automatically when deal data is captured

---

## Interpreting Results

### ✅ All four proof items check green
The Electron hybrid architecture is validated. Proceed to `feature/electron-shell` in the main repo.

### ⚠️ SSO completes but intercept never fires
The deal-list response is likely served from a **Service Worker cache** — the same issue found in Session 1 of this project. The CDP `Network.enable` call in `main.js` should bypass this (SW-cached responses still fire `Network.loadingFinished` when CDP is active), but if it doesn't:
- Open DevTools on the Salesforce window: `sfWindow.webContents.openDevTools()`
- Check the Network tab for the actual request URL
- Update `SF_INTERCEPT_PATTERNS` in `main.js` to match

### ❌ Server fails to start
Check port 3091 is not in use: `lsof -i :3091`

---

## Architecture (for reference)

```
┌─────────────────────────────────────────────────────┐
│                  ELECTRON PROCESS                    │
│                                                      │
│  appWindow (renderer/index.html)                     │
│  └── polls localhost:3091/api/last-capture           │
│                                                      │
│  sfWindow (ibm.my.salesforce.com)                    │
│  └── CDP debugger attached                           │
│      └── Network.loadingFinished → getResponseBody   │
│          └── POST localhost:3091/api/ingest          │
│                                                      │
│  Express server (server.js : 3091)                   │
│  ├── GET  /api/status        ← renderer startup poll │
│  ├── GET  /api/last-capture  ← renderer data poll    │
│  └── POST /api/ingest        ← receives CDP payload  │
└─────────────────────────────────────────────────────┘
```

---

## Files

```
main.js              — Electron main process; CDP intercept; two BrowserWindows
server.js            — 76-line Express; /api/status, /api/last-capture, /api/ingest
renderer/index.html  — Status dashboard; polls server; shows proof checklist
package.json         — electron + express only
```

---

*UCC1 — ISC Automated Sales Forecast · watsonx Challenge 2026 · PoC v0.1.0*
