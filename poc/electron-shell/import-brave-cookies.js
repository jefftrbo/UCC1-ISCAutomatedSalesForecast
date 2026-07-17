/**
 * import-brave-cookies.js
 *
 * Copies Salesforce session cookies from Brave's cookie store directly into
 * the Electron PoC's persisted session partition (persist:salesforce-poc).
 *
 * Run ONCE before `npm start` to seed the session.
 * After this, `npm start` opens straight to the ISC dashboard — no login.
 *
 * Usage:
 *   node import-brave-cookies.js
 *
 * Requirements:
 *   - Brave must be CLOSED (SQLite locks the file while Brave is running)
 *   - You must be logged into Salesforce in Brave
 */

'use strict';

const { app, session } = require('electron');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

// Brave's cookie database path on macOS
const BRAVE_COOKIES_PATH = path.join(
  os.homedir(),
  'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'
);

// Salesforce domains to import
const SF_DOMAINS = [
  'salesforce.com',
  'ibmsc.lightning.force.com',
  'ibm.my.salesforce.com',
  'force.com',
];

async function importCookies() {
  if (!fs.existsSync(BRAVE_COOKIES_PATH)) {
    console.error('❌ Brave cookie file not found at:', BRAVE_COOKIES_PATH);
    console.error('   Make sure Brave is installed and you have logged into Salesforce in Brave.');
    process.exit(1);
  }

  console.log('📂 Reading Brave cookies from:', BRAVE_COOKIES_PATH);

  // Use better-sqlite3 from this PoC's own node_modules (compiled against Electron's ABI)
  const Database = require('better-sqlite3');

  let db;
  try {
    // Open read-only copy to avoid locking issues
    const tmpPath = path.join(os.tmpdir(), 'brave-cookies-tmp.db');
    fs.copyFileSync(BRAVE_COOKIES_PATH, tmpPath);
    db = new Database(tmpPath, { readonly: true });
  } catch (e) {
    console.error('❌ Could not open Brave cookie file:', e.message);
    console.error('   Make sure Brave is fully closed (Cmd+Q, not just window close).');
    process.exit(1);
  }

  // Query Salesforce cookies from Brave
  // Brave stores cookies in the standard Chromium cookies schema
  let rows;
  try {
    rows = db.prepare(`
      SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite
      FROM cookies
      WHERE (
        host_key LIKE '%salesforce.com%' OR
        host_key LIKE '%force.com%'
      )
    `).all();
  } catch (e) {
    console.error('❌ Could not query cookies:', e.message);
    process.exit(1);
  }

  db.close();
  console.log(`✅ Found ${rows.length} Salesforce cookies in Brave`);

  if (rows.length === 0) {
    console.error('❌ No Salesforce cookies found. Make sure you are logged into Salesforce in Brave.');
    process.exit(1);
  }

  // Boot Electron just enough to access the session API
  app.whenReady().then(async () => {
    const sfSession = session.fromPartition('persist:salesforce-poc');
    let imported = 0;
    let skipped  = 0;

    for (const row of rows) {
      // Chromium stores expiry as microseconds since Jan 1, 1601
      // Convert to Unix timestamp (seconds since Jan 1, 1970)
      const EPOCH_DIFF = 11644473600; // seconds between 1601 and 1970
      const expiryUnix = row.expires_utc
        ? Math.floor(row.expires_utc / 1_000_000) - EPOCH_DIFF
        : undefined;

      const cookie = {
        url: `https://${row.host_key.replace(/^\./, '')}`,
        name:     row.name,
        value:    row.value,
        domain:   row.host_key,
        path:     row.path || '/',
        secure:   !!row.is_secure,
        httpOnly: !!row.is_httponly,
        sameSite: row.samesite === 2 ? 'strict' : row.samesite === 1 ? 'lax' : 'no_restriction',
        ...(expiryUnix && expiryUnix > 0 ? { expirationDate: expiryUnix } : {}),
      };

      try {
        await sfSession.cookies.set(cookie);
        imported++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`✅ Imported ${imported} cookies into Electron session`);
    if (skipped > 0) console.log(`   (${skipped} skipped — expired or invalid)`);
    console.log('\n✅ Done. Run `npm start` — Salesforce should open directly to the dashboard.\n');

    app.quit();
  });
}

importCookies();
