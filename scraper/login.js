/**
 * scraper/login.js
 *
 * ONE-TIME SETUP — launches your actual Brave browser (with your IBM passkey
 * already registered) pointed at the ISC dashboard. Once you confirm it loads,
 * close the window. The persistent Playwright profile will be seeded from your
 * Brave session via cookie copy.
 *
 * Usage:
 *   node scraper/login.js
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const config = require('../config.json');

const profilePath = path.resolve(__dirname, '..', config.browserProfilePath);

// Path to your Brave browser executable on macOS
const BRAVE_EXEC = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

(async () => {
  console.log('Launching Brave browser with your existing profile...');
  console.log('Your IBM passkey is registered here — use it to log in normally.');
  console.log('');

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    executablePath: fs.existsSync(BRAVE_EXEC) ? BRAVE_EXEC : undefined,
    args: ['--start-maximized'],
  });

  const page = await context.newPage();

  if (config.iscUrl && config.iscUrl !== 'REPLACE_WITH_ISC_FORECAST_PAGE_URL') {
    await page.goto(config.iscUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  console.log('Browser is open. Log in with your IBM passkey if prompted.');
  console.log('Once the ISC dashboard loads, close this browser window.');
  console.log('');

  await context.waitForEvent('close').catch(() => {});
  console.log('Session saved. You can now run: node scraper/scrape.js');
  process.exit(0);
})();
