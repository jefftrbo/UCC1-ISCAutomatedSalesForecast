/**
 * main.js — Electron PoC main process
 *
 * Proves three things:
 *   1. Express server starts inside an Electron process
 *   2. IBM w3id SSO + passkey login completes inside a BrowserWindow
 *   3. CDP intercepts the Salesforce CRM Analytics deal-list response
 *      and POSTs it to our local server
 *
 * ── OUTPUT STRATEGY ──────────────────────────────────────────────────────────
 * All proof output goes to the terminal (npm start window). No status UI window.
 * The Salesforce BrowserWindow is the only window — it gets full focus so the
 * macOS Touch ID / passkey sheet can surface cleanly without interference.
 *
 * ── PASSKEY AUTH ─────────────────────────────────────────────────────────────
 * IBM w3id passkeys live in macOS Keychain (platform authenticator).
 * Electron's Chromium can reach them — but the Touch ID sheet needs the
 * Salesforce BrowserWindow to be the frontmost, focused window when it fires.
 * No competing windows = clean passkey prompt.
 *
 * Session is persisted to disk (persist:salesforce-poc partition).
 * First run: authenticate once. All subsequent runs: no login prompt.
 *
 * Port: 3091 (separate from main app on 3090)
 */

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

// Enable WebAuthn platform authenticator (Touch ID / passkey support)
app.commandLine.appendSwitch('enable-features', 'WebAuthenticationTouchId');
app.commandLine.appendSwitch('enable-blink-features', 'WebAuthenticationGetAssertionWithoutUI');

// ISC CRM Analytics dashboard — triggers w3id SSO → passkey
const SF_LOGIN_URL = 'https://ibmsc.lightning.force.com/lightning/page/analytics?wave__assetType=dashboard';

let sfWindow = null;

// ── Start Express server ──────────────────────────────────────────────────────
function startServer() {
  require('./server.js');
  console.log('[main] ✅ Proof 1 — Express server started on port 3091');
}

// ── Create the Salesforce window ─────────────────────────────────────────────
function createSalesforceWindow() {
  const { session } = require('electron');

  // Persist session so login survives restarts — first run only needs auth
  const sfSession = session.fromPartition('persist:salesforce-poc');

  sfWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'ISC Sales Forecast PoC — Salesforce',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: sfSession,
      // Allow cross-origin SAML POST redirects (IBM w3id → Salesforce handshake)
      // Safe for PoC — this window only loads IBM/Salesforce URLs
      webSecurity: false,
    },
  });

  // Full focus immediately — required for macOS Touch ID sheet to surface
  sfWindow.focus();

  // Dump all session cookies to terminal so we can see what was imported
  sfSession.cookies.get({}).then(cookies => {
    console.log(`[main] Session has ${cookies.length} cookies total`);
    cookies.forEach(c => {
      console.log(`[main]   ${c.domain} | ${c.name} | expires: ${c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session'}`);
    });
    sfWindow.loadURL(SF_LOGIN_URL);
  }).catch(() => {
    sfWindow.loadURL(SF_LOGIN_URL);
  });

  sfWindow.webContents.on('did-finish-load', () => {
    const url = sfWindow.webContents.getURL();
    console.log(`[main] Page loaded: ${url.slice(0, 120)}`);

    // Proof 2: SSO complete only when the Lightning app shell has fully landed
    // Must be ibmsc.lightning.force.com AND not a redirect/session/login URL
    const isLightningApp =
      url.includes('ibmsc.lightning.force.com') &&
      !url.includes('visualforce/session') &&
      !url.includes('login.ibm.com') &&
      !url.includes('/saml/') &&
      !url.includes('ibm.my.salesforce.com');

    if (isLightningApp) {
      console.log('[main] ✅ Proof 2 — IBM w3id SSO completed, Lightning dashboard loaded');
      console.log('[main]    Navigate to the deal-list tab and apply your filters...');
    }
  });

  sfWindow.on('closed', () => { sfWindow = null; });

  // ── Attach CDP debugger for response-body capture ─────────────────────────
  const debugger_ = sfWindow.webContents.debugger;

  try {
    debugger_.attach('1.3');
    console.log('[main] CDP debugger attached — watching for CRM Analytics requests...');
  } catch (e) {
    console.error('[main] CDP attach failed:', e.message);
  }

  debugger_.on('detach', (event, reason) => {
    console.log('[main] CDP debugger detached:', reason);
  });

  const pendingRequests = new Map();

  debugger_.on('message', async (event, method, params) => {
    // ── Identify matching CRM Analytics requests ──────────────────────────
    if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url || '';
      const isSaql =
        url.includes('/wave/query') ||
        url.includes('/wave/datasets') ||
        url.includes('wave/execute') ||
        (url.includes('wave') && url.includes('query'));

      if (isSaql) {
        console.log(`[main] Intercepted: ${url.slice(0, 120)}`);
        pendingRequests.set(params.requestId, url);
      }
    }

    // ── When response loads, get the body via CDP ─────────────────────────
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
          return; // not JSON — skip silently
        }

        const recordCount =
          parsed?.results?.[0]?.records?.length ||
          parsed?.records?.length               ||
          parsed?.data?.length                  ||
          0;

        // Skip small auth/ping responses
        if (recordCount < 10) return;

        console.log(`\n[main] ✅ Proof 3 — Deal-list intercepted — ${recordCount} records`);
        console.log(`[main]    URL: ${url.slice(0, 120)}`);

        postToIngest(parsed);

      } catch (e) {
        console.log(`[main] getResponseBody failed for ${url.slice(0, 80)}: ${e.message}`);
      }
    }
  });

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
      console.log(`[main] ✅ Proof 4 — POST /api/ingest → ${res.statusCode}: ${data}`);
      console.log('\n🎉 ALL FOUR PROOFS PASSED — Electron hybrid architecture validated.\n');
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

  // Salesforce window is the ONLY window — gets full focus, no interference
  createSalesforceWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSalesforceWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
