/**
 * scraper/watch-cookies.js
 *
 * Watches for a fresh Cookie-Editor export and immediately runs fetch-from-api.js.
 *
 * FASTEST WORKFLOW (15 seconds total):
 *
 * Terminal window 1 — run this script FIRST, leave it running:
 *   node scraper/watch-cookies.js
 *
 * Then in Brave (while on ISC dashboard with filters set):
 *   Click Cookie-Editor → Export → Export as JSON → Save to scraper/cookies.json
 *   (overwrite the existing file)
 *
 * The watcher detects the file change instantly and runs fetch-from-api.js
 * automatically — no need to switch back to terminal.
 *
 * Cookie-Editor export takes ~3 seconds. The sid cookie is valid for several
 * minutes after export, so there is plenty of time.
 */

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const COOKIES_FILE  = path.join(__dirname, 'cookies.json');
const FETCH_SCRIPT  = path.join(__dirname, 'fetch-from-api.js');
const PROJECT_ROOT  = path.join(__dirname, '..');

let debounce = null;
let running  = false;

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Cookie Watcher is running.');
console.log('');
console.log('  Steps:');
console.log('  1. In Brave, navigate to ISC and set your filters:');
console.log('       • Owner → Dushyant K Patel');
console.log('       • Tab  → Deal List by Opportunity');
console.log('       • Forecast → Call, Upside, Stretch');
console.log('');
console.log('  2. Click Cookie-Editor → Export → Export as JSON');
console.log('     Save/overwrite: scraper/cookies.json');
console.log('');
console.log('  Data will load automatically the moment the file is saved.');
console.log('  Press Ctrl+C to stop watching.');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('Waiting for cookies.json to be updated...');

fs.watchFile(COOKIES_FILE, { interval: 500 }, (curr, prev) => {
  // File must have been modified (mtime changed) and be non-empty
  if (curr.mtimeMs === prev.mtimeMs) return;
  if (curr.size === 0) return;
  if (running) return;

  // Debounce — file may be written in chunks
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    // Verify it has a sid cookie
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      const hasSid = cookies.some(c => c.name === 'sid');
      if (!hasSid) {
        console.log('⚠️  cookies.json updated but no "sid" cookie found.');
        console.log('   Make sure Cookie-Editor exports ALL cookies (not just non-httpOnly).');
        console.log('   Waiting for next update...\n');
        return;
      }
      console.log(`✅  cookies.json updated — ${cookies.length} cookies detected (sid present).`);
    } catch {
      console.log('⚠️  cookies.json saved but could not parse — waiting for next update...');
      return;
    }

    running = true;
    console.log('🚀  Running fetch-from-api.js...\n');

    const child = spawn(process.execPath, [FETCH_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      running = false;
      if (code === 0) {
        console.log('\n✅  Done! Open http://localhost:3090 to review and generate PPT.');
      } else {
        console.log(`\n⚠️  fetch-from-api.js exited with code ${code}.`);
      }
      console.log('\nWaiting for next cookies.json update...');
    });
  }, 800);
});
