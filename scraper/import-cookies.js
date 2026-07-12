/**
 * scraper/import-cookies.js
 *
 * Imports IBM w3id / Salesforce session cookies from a JSON file exported
 * by the "Cookie-Editor" browser extension into the Playwright browser profile.
 *
 * ONE-TIME SETUP:
 *
 * Step 1 — Install "Cookie-Editor" in your Brave browser:
 *   https://cookie-editor.com  (available for Chrome/Brave)
 *
 * Step 2 — In Brave, log in to ISC normally (using your IBM passkey):
 *   https://ibmsc.lightning.force.com
 *
 * Step 3 — While on the ISC dashboard page, click the Cookie-Editor icon
 *   → click "Export" → "Export as JSON"
 *   → save the file as:  scraper/cookies.json
 *
 * Step 4 — Run this script from your terminal:
 *   node scraper/import-cookies.js
 *
 * Step 5 — Verify it worked:
 *   node scraper/scrape.js --headed
 *
 * The session will stay valid until IBM expires it (typically a few weeks).
 * When it expires, repeat Steps 2–4 — no need to re-install anything.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('../config.json');

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const profilePath  = path.resolve(__dirname, '..', config.browserProfilePath);

(async () => {
  // ── Validate input file ───────────────────────────────────────────────────
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`ERROR: cookies.json not found at: ${COOKIES_FILE}`);
    console.error('');
    console.error('Steps to create it:');
    console.error('  1. Install Cookie-Editor in Brave: https://cookie-editor.com');
    console.error('  2. Log in to ISC in Brave: https://ibmsc.lightning.force.com');
    console.error('  3. Navigate to the ISC forecast dashboard');
    console.error('  4. Click Cookie-Editor icon → Export → Export as JSON');
    console.error('  5. Save the file as: scraper/cookies.json');
    console.error('  6. Re-run: node scraper/import-cookies.js');
    process.exit(1);
  }

  // ── Load and parse cookies ────────────────────────────────────────────────
  let rawCookies;
  try {
    rawCookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Failed to parse cookies.json — ${err.message}`);
    console.error('Make sure you exported as JSON (not Netscape/header format).');
    process.exit(1);
  }

  if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
    console.error('ERROR: cookies.json is empty or not an array.');
    process.exit(1);
  }

  // ── Normalise Cookie-Editor format → Playwright format ───────────────────
  // Cookie-Editor uses the WebExtensions cookie schema which differs slightly
  // from Playwright's expected format.
  const playwrightCookies = rawCookies.map((c) => {
    const cookie = {
      name:     c.name,
      value:    c.value,
      domain:   c.domain  || '.lightning.force.com',
      path:     c.path    || '/',
      secure:   c.secure  ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: normalizeSameSite(c.sameSite),
    };

    // Playwright requires expires as a Unix timestamp (number) or -1 for session cookies
    if (c.expirationDate) {
      cookie.expires = Math.floor(c.expirationDate);
    } else if (c.expires && typeof c.expires === 'number') {
      cookie.expires = Math.floor(c.expires);
    } else {
      cookie.expires = -1; // session cookie — valid until browser closes
    }

    return cookie;
  });

  // ── Launch persistent context and inject cookies ──────────────────────────
  console.log(`Importing ${playwrightCookies.length} cookies into browser profile...`);
  console.log(`Profile path: ${profilePath}`);

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false, // visible so you can confirm the session loaded
  });

  await context.addCookies(playwrightCookies);

  // Navigate to ISC to verify the session is active
  const page = await context.newPage();
  console.log('Navigating to ISC to verify session...');
  // Einstein Analytics dashboards never reach "networkidle" — use domcontentloaded instead
  await page.goto(config.iscUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Give the dashboard an extra 8 seconds to load its widgets
  await page.waitForTimeout(8000);

  const currentUrl = page.url();
  const isLoggedIn = currentUrl.includes('force.com') &&
                     !currentUrl.includes('login') &&
                     !currentUrl.includes('password-blocked');

  if (isLoggedIn) {
    console.log('');
    console.log('SUCCESS: Session is active — ISC dashboard loaded.');
    console.log('Close this browser window when you are satisfied.');
    console.log('');
    console.log('Next steps:');
    console.log('  Start the app:  npm start');
    console.log('  Then open:      http://localhost:3000');
    console.log('  Click:          Refresh Data');
  } else {
    console.warn('');
    console.warn('WARNING: ISC did not load as expected.');
    console.warn(`Current URL: ${currentUrl}`);
    console.warn('');
    console.warn('Possible causes:');
    console.warn('  - Cookies may have expired — re-export from Brave and try again');
    console.warn('  - Make sure you were on the ISC dashboard page when you exported,');
    console.warn('    not the login page');
  }

  // Wait for user to close the browser window
  await context.waitForEvent('close').catch(() => {});
  process.exit(0);
})();

function normalizeSameSite(value) {
  if (!value) return 'None';
  const v = String(value).toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax')    return 'Lax';
  return 'None'; // Salesforce cookies are typically SameSite=None
}
