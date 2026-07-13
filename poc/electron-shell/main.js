/**
 * main.js — Electron PoC main process
 *
 * Proves three things:
 *   1. Express server starts inside an Electron process
 *   2. IBM w3id SSO login completes inside a BrowserWindow
 *   3. CDP intercepts the Salesforce CRM Analytics deal-list response
 *      and POSTs it to our local server
 *
 * ── PASSKEY / AUTH STRATEGY ──────────────────────────────────────────────────
 * IBM w3id passkeys are device-bound to the macOS Secure Enclave and registered
 * per-browser. Electron's bundled Chromium does NOT have the passkey registered,
 * so the w3id chooser appears instead of going straight to Touch ID.
 *
 * Solution: persist the Salesforce session in a named userData folder
 * (~/.ucc1-electron-poc/sf-session). On FIRST RUN, use "w3id Password" or
 * "IBM Verify" from the chooser — one time only. On all subsequent runs,
 * Electron reuses the persisted session cookies and skips login entirely.
 *
 * FIRST RUN INSTRUCTIONS:
 *   1. The Salesforce window opens showing "Sign in with w3id"
 *   2. Click "w3id Password" and sign in with your IBM intranet password
 *      (or use IBM Verify if configured)
 *   3. Once the ISC dashboard loads, the session is saved automatically
 *   4. Every run after this opens straight to the dashboard — no login
 *
 * Port: 3091 (separate from main app on 3090)
 */

'use strict';

const { app, BrowserWindow, session } = require('electron');
const path   = require('path');
const http   = require('http');
const os     = require('os');

// ── Target URL patterns for Salesforce CRM Analytics deal-list API ───────────
// These are the same endpoints our HAR parser found in Session 1 / Attempt 8
const SF_INTERCEPT_PATTERNS = [
  '*://*/wave/wave/query*',
  '*://*/wave/wave/datasets*',
  '*://*/liveagent/wave*',
  '*://*/*/wave/query*',
  '*://*/services/data/*/wave/query*',
];

// Salesforce login entry point — w3id SSO will redirect from here
const SF_LOGIN_URL = 'https://ibmsc.lightning.force.com/lightning/page/analytics?wave__assetType=dashboard';

let appWindow = null;
let sfWindow  = null;

// ── Start Express server ──────────────────────────────────────────────────────
// Require after app is ready so there's no timing issue
function startServer() {
  require('./server.js');
  console.log('[main] Express server started on port 3091');
}

// ── Create the status dashboard window ───────────────────────────────────────
function createAppWindow() {
  appWindow = new BrowserWindow({
    width: 640,
    height: 680,
    title: 'ISC Sales Forecast — Electron PoC',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  appWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  appWindow.on('closed', () => { appWindow = null; });
}

// ── Create the Salesforce window with webRequest intercept ───────────────────
function createSalesforceWindow() {
  // Persist the Salesforce session to disk so login survives restarts.
  // On first run: user logs in once via w3id Password / IBM Verify.
  // On subsequent runs: session cookies are reused — no login prompt.
  const sfSession = session.fromPartition('persist:salesforce-poc');

  sfWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Salesforce — Log in to capture deal data',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: sfSession,
    },
  });

  sfWindow.loadURL(SF_LOGIN_URL);
  sfWindow.on('closed', () => { sfWindow = null; });

  // ── session.webRequest intercept ─────────────────────────────────────────
  // onCompleted fires AFTER the response is received — we get the full
  // response body via a CDP workaround below.
  //
  // IMPORTANT: webRequest gives us request metadata but NOT the response body
  // directly. To get the body we use the Debugger (CDP) protocol on the window.
  // This is the standard pattern for Electron response-body capture.

  const debugger_ = sfWindow.webContents.debugger;

  try {
    debugger_.attach('1.3');
    console.log('[main] CDP debugger attached to Salesforce window');
  } catch (e) {
    console.error('[main] CDP attach failed:', e.message);
  }

  debugger_.on('detach', (event, reason) => {
    console.log('[main] CDP debugger detached:', reason);
  });

  // Track requestIds that match our target patterns
  const pendingRequests = new Map();

  debugger_.on('message', async (event, method, params) => {
    // ── Step 1: Identify matching requests ─────────────────────────────────
    if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url || '';
      const isSaql =
        url.includes('/wave/query') ||
        url.includes('/wave/datasets') ||
        url.includes('wave/execute') ||
        url.includes('/query?') ||
        (url.includes('wave') && url.includes('query'));

      if (isSaql) {
        console.log(`[main] Intercepted Salesforce request: ${url.slice(0, 120)}`);
        pendingRequests.set(params.requestId, url);
      }
    }

    // ── Step 2: When a matching response loads, get the body ───────────────
    if (method === 'Network.loadingFinished') {
      if (!pendingRequests.has(params.requestId)) return;

      const url = pendingRequests.get(params.requestId);
      pendingRequests.delete(params.requestId);

      try {
        const result = await debugger_.sendCommand(
          'Network.getResponseBody',
          { requestId: params.requestId }
        );

        const rawBody = result.base64Encoded
          ? Buffer.from(result.body, 'base64').toString('utf-8')
          : result.body;

        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          console.log('[main] Response body is not JSON — skipping');
          return;
        }

        // Quick size check — the real deal-list response is large;
        // skip tiny responses (auth tokens, pings, etc.)
        const recordCount =
          parsed?.results?.[0]?.records?.length ||
          parsed?.records?.length               ||
          parsed?.data?.length                  ||
          0;

        if (recordCount < 10) {
          console.log(`[main] Skipping small response (${recordCount} records) from ${url.slice(0, 80)}`);
          return;
        }

        console.log(`\n[main] 🎯 Deal-list response captured — ${recordCount} records from:\n   ${url.slice(0, 120)}`);

        // ── Step 3: POST to local Express endpoint ────────────────────────
        postToIngest(parsed);

      } catch (e) {
        // getResponseBody can fail if the request was cancelled or the
        // debugger detached — not a fatal error
        console.log(`[main] Could not get response body for ${url.slice(0, 80)}: ${e.message}`);
      }
    }
  });

  // Enable Network domain so CDP events fire
  debugger_.sendCommand('Network.enable').catch(e => {
    console.error('[main] Network.enable failed:', e.message);
  });
}

// ── POST captured payload to local Express server ────────────────────────────
function postToIngest(payload) {
  const body = JSON.stringify(payload);
  const opts = {
    hostname: 'localhost',
    port: 3091,
    path: '/api/ingest',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = http.request(opts, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      console.log('[main] /api/ingest response:', data);
    });
  });

  req.on('error', (e) => {
    console.error('[main] POST to /api/ingest failed:', e.message);
  });

  req.write(body);
  req.end();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startServer();
  createAppWindow();

  // Small delay so the app window is visible before Salesforce window opens
  setTimeout(createSalesforceWindow, 1200);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
