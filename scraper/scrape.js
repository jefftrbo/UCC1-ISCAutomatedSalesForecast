/**
 * scraper/scrape.js
 *
 * Salesforce CRM Analytics (Einstein Analytics) dashboard scraper.
 *
 * Strategy: Playwright intercepts the internal Salesforce /wave/ Analytics API
 * network responses as the dashboard loads. The API returns the full dataset —
 * all rows, not just what's visible on screen — so no DOM scrolling is needed.
 * Pagination is followed automatically if the dataset exceeds one API page.
 *
 * All 20 columns from the ISC "Forecast v66.0 — Deal List by Opportunity"
 * dashboard are captured (confirmed via full horizontal scroll screenshots).
 * The complete raw JSON record is also stored so no field is ever lost.
 *
 * Usage:
 *   node scraper/scrape.js           (headless — requires prior login.js run)
 *   node scraper/scrape.js --headed  (visible browser — for debugging)
 *   node scraper/scrape.js --dump    (saves raw API JSON to scraper/api-dump.json for inspection)
 *
 * Called automatically by the Express backend via POST /api/scrape.
 */

const { chromium } = require('playwright');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const config = require('../config.json');
const db = require('../server/db');

const profilePath = path.resolve(__dirname, '..', config.browserProfilePath);
const headed = process.argv.includes('--headed');
const dump   = process.argv.includes('--dump');

// Use Brave if available — passkey session was established there via login.js
const BRAVE_EXEC = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const executablePath = fs.existsSync(BRAVE_EXEC) ? BRAVE_EXEC : undefined;

// Pauses execution until the user presses Enter in the terminal
function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Upsert — preserves the user's `selected` flag on re-scrape
// ---------------------------------------------------------------------------
const upsert = db.prepare(`
  INSERT INTO opportunities (
    id, opportunity_name,
    filtered_opportunity_amount, total_opportunity_amount,
    opportunity_owner, opportunity_owners_manager, opportunity_created_by,
    close_date, create_date,
    stage, forecast_category, flm_judgement,
    account_name, account_company, account_db_dc,
    next_steps, team_notes,
    business_partner, technology_client, acquisition_pipeline, ibm_technology_plan,
    raw_data, scraped_at
  ) VALUES (
    @id, @opportunity_name,
    @filtered_opportunity_amount, @total_opportunity_amount,
    @opportunity_owner, @opportunity_owners_manager, @opportunity_created_by,
    @close_date, @create_date,
    @stage, @forecast_category, @flm_judgement,
    @account_name, @account_company, @account_db_dc,
    @next_steps, @team_notes,
    @business_partner, @technology_client, @acquisition_pipeline, @ibm_technology_plan,
    @raw_data, @scraped_at
  )
  ON CONFLICT(id) DO UPDATE SET
    opportunity_name            = excluded.opportunity_name,
    filtered_opportunity_amount = excluded.filtered_opportunity_amount,
    total_opportunity_amount    = excluded.total_opportunity_amount,
    opportunity_owner           = excluded.opportunity_owner,
    opportunity_owners_manager  = excluded.opportunity_owners_manager,
    opportunity_created_by      = excluded.opportunity_created_by,
    close_date                  = excluded.close_date,
    create_date                 = excluded.create_date,
    stage                       = excluded.stage,
    forecast_category           = excluded.forecast_category,
    flm_judgement               = excluded.flm_judgement,
    account_name                = excluded.account_name,
    account_company             = excluded.account_company,
    account_db_dc               = excluded.account_db_dc,
    next_steps                  = excluded.next_steps,
    team_notes                  = excluded.team_notes,
    business_partner            = excluded.business_partner,
    technology_client           = excluded.technology_client,
    acquisition_pipeline        = excluded.acquisition_pipeline,
    ibm_technology_plan         = excluded.ibm_technology_plan,
    raw_data                    = excluded.raw_data,
    scraped_at                  = excluded.scraped_at
`);

const upsertMany = db.transaction((rows) => {
  for (const row of rows) upsert.run(row);
});

// ---------------------------------------------------------------------------
// parseRecords()
//
// Maps a raw Salesforce CRM Analytics API payload to our DB schema.
// Each field tries multiple known aliases in priority order — the API uses
// different naming conventions depending on dataset version and org config.
// Falls back gracefully to null / 0 for any missing field.
//
// The complete raw record is stored in `raw_data` so we can always inspect
// and promote new fields without re-scraping.
// ---------------------------------------------------------------------------
function parseRecords(payload, scraped_at) {
  const records = payload?.results?.records ?? payload?.records ?? [];
  if (!Array.isArray(records) || records.length === 0) return [];

  return records.map((r) => {
    // Pick first non-null, non-empty value from candidate field name list
    const pick = (...keys) => {
      for (const k of keys) {
        const v = r[k];
        if (v !== undefined && v !== null && v !== '' && v !== '-') return v;
      }
      return null;
    };

    const parseAmount = (...keys) => {
      const raw = pick(...keys);
      if (raw === null) return 0;
      if (typeof raw === 'number') return raw;
      return parseFloat(String(raw).replace(/[^0-9.-]/g, '')) || 0;
    };

    const parseDate = (...keys) => {
      const raw = pick(...keys);
      if (!raw) return null;
      if (typeof raw === 'number') return new Date(raw).toISOString().slice(0, 10);
      return String(raw).slice(0, 10); // handles YYYY-MM-DD and YYYY-MM-DDThh:mm:ssZ
    };

    return {
      // ── Core identity ────────────────────────────────────────────────────
      id: pick(
        'Opportunity_ID', 'OpportunityId', 'opportunity_id', 'Id', 'id',
        'Opportunity.Id', 'opp_id', 'OppId'
      ) ?? `unknown-${Math.random().toString(36).slice(2)}`,

      opportunity_name: pick(
        'Opportunity', 'Opportunity_Name', 'OpportunityName', 'Name',
        'opportunity_name', 'Opportunity.Name', 'OppName'
      ) ?? '',

      // ── Amounts ──────────────────────────────────────────────────────────
      filtered_opportunity_amount: parseAmount(
        'Filtered_Opportunity_Amount', 'FilteredOpportunityAmount',
        'filtered_opportunity_amount', 'Filtered_Amount', 'FilteredAmount'
      ),

      total_opportunity_amount: parseAmount(
        'Total_Opportunity_Amount', 'TotalOpportunityAmount',
        'total_opportunity_amount', 'Amount', 'TotalAmount', 'OppAmount'
      ),

      // ── People ───────────────────────────────────────────────────────────
      opportunity_owner: pick(
        'Opportunity_Owner', 'OpportunityOwner', 'opportunity_owner',
        'Owner', 'OwnerName', 'Owner.Name', 'OppOwner'
      ) ?? '',

      opportunity_owners_manager: pick(
        "Opportunity_Owner_s_Manager", "Opportunity_Owner's_Manager",
        'OpportunityOwnersManager', 'OwnersManager', 'ManagerName',
        'Owner_Manager', 'opportunity_owners_manager', 'FLM', 'FLMName',
        'Manager.Name', 'DirectManager'
      ) ?? '',

      opportunity_created_by: pick(
        'Opportunity_Created_By', 'OpportunityCreatedBy', 'CreatedBy',
        'CreatedByName', 'Created_By', 'opportunity_created_by',
        'CreatedBy.Name', 'Creator'
      ) ?? '',

      // ── Dates ────────────────────────────────────────────────────────────
      close_date: parseDate(
        'Close_Date', 'CloseDate', 'close_date', 'Closedate'
      ),

      create_date: parseDate(
        'Create_Date', 'CreateDate', 'CreatedDate', 'create_date',
        'Opportunity_Create_Date', 'OpportunityCreateDate'
      ),

      // ── Stage & Forecast ─────────────────────────────────────────────────
      stage: pick(
        'Stage', 'StageName', 'Stage_Name', 'stage', 'stage_name',
        'Opportunity_Stage', 'OppStage'
      ) ?? '',

      forecast_category: pick(
        'Forecast', 'ForecastCategory', 'Forecast_Category', 'forecast_category',
        'ForecastCategoryName', 'Forecast_Category_Name', 'ForecastGroup',
        'Forecast_Grouping', 'ForecastGrouping'
      ) ?? '',

      flm_judgement: pick(
        'FLM_Judgement', 'FLMJudgement', 'flm_judgement', 'FLM_Judgment',
        'FLMJudgment', 'FLM_Override', 'FLMOverride', 'ManagerJudgement'
      ) ?? '',

      // ── Account ──────────────────────────────────────────────────────────
      account_name: pick(
        'Account_Detail', 'AccountDetail', 'account_name', 'Account',
        'AccountName', 'Account_Name', 'Account.Name'
      ) ?? '',

      account_company: pick(
        'Account_Company', 'AccountCompany', 'account_company',
        'Account__Company', 'ParentAccount', 'Account_Parent',
        'UltimateParent', 'Ultimate_Parent'
      ) ?? '',

      account_db_dc: pick(
        'Account_DB_DC', 'AccountDBDC', 'account_db_dc', 'Account__DB_DC',
        'DBDC', 'DB_DC', 'Account_DBDC', 'DBDCName'
      ) ?? '',

      // ── Notes & Context ──────────────────────────────────────────────────
      next_steps: pick(
        'Next_Steps', 'NextStep', 'next_steps', 'NextSteps', 'Description'
      ) ?? '',

      team_notes: pick(
        'Team_Notes', 'TeamNotes', 'team_notes', 'TeamNote',
        'InternalNotes', 'Internal_Notes', 'Notes'
      ) ?? '',

      // ── Partner & Classification ─────────────────────────────────────────
      business_partner: pick(
        'Business_Partner', 'BusinessPartner', 'business_partner',
        'Partner', 'PartnerName', 'BP', 'BPName'
      ) ?? '',

      technology_client: pick(
        'Technology_Client', 'TechnologyClient', 'technology_client',
        'ClientType', 'Client_Type', 'TechClient', 'ClientCategory'
      ) ?? '',

      acquisition_pipeline: pick(
        'Acquisition_Pipeline', 'AcquisitionPipeline', 'acquisition_pipeline',
        'Pipeline', 'PipelineType', 'AcqPipeline'
      ) ?? '',

      ibm_technology_plan: pick(
        'IBM_Technology_Plan', 'IBMTechnologyPlan', 'ibm_technology_plan',
        'TechPlan', 'Technology_Plan', 'IBMTechPlan', 'QuipLink', 'Quip_Link'
      ) ?? '',

      // ── Metadata ─────────────────────────────────────────────────────────
      raw_data: JSON.stringify(r),
      scraped_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Fetch additional API pages using session cookies from the Playwright context
// ---------------------------------------------------------------------------
async function fetchPageWithCookies(url, cookies) {
  return new Promise((resolve, reject) => {
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const lib = url.startsWith('https') ? https : http;

    const req = lib.get(
      url,
      {
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json',
          'X-Chatter-Entity-Encoding': 'false',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Failed to parse page response: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  if (!config.iscUrl || config.iscUrl === 'REPLACE_WITH_ISC_FORECAST_PAGE_URL') {
    console.error('ERROR: No ISC URL configured. Edit config.json and set "iscUrl".');
    process.exit(1);
  }

  console.log(`Launching browser (headless: ${!headed})...`);

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: !headed,
    executablePath,
  });

  const page = await context.newPage();

  // Intercept all Salesforce /wave/ Analytics API responses before navigating
  const capturedPayloads = [];

  const captureRoute = async (route) => {
    const response = await route.fetch();
    try {
      const json = await response.json();
      const count = json?.results?.records?.length ?? json?.records?.length ?? 0;
      if (count > 0) {
        capturedPayloads.push(json);
        console.log(`  [API] Captured response — ${count} records`);
      }
    } catch { /* non-JSON or empty — ignore */ }
    await route.fulfill({ response });
  };

  await page.route('**/wave/query**',       captureRoute);
  await page.route('**/wave/datasets/**',   captureRoute);
  await page.route('**/wave/dashboards/**', captureRoute);

  // Also intercept the broader /services/data/ endpoint used by some Salesforce orgs
  await page.route('**/services/data/**/wave/**', captureRoute);
  await page.route('**/webruntime/**',             captureRoute);

  try {
    console.log('Navigating to ISC dashboard...');
    // Einstein Analytics never reaches "networkidle" — use domcontentloaded
    await page.goto(config.iscUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (headed) {
      // ── Manual filter mode ───────────────────────────────────────────────
      // The dashboard requires manual filter changes before the correct data
      // is visible. Wait for the user to set filters, then press Enter.
      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('  MANUAL STEPS REQUIRED — set filters in the Brave window:');
      console.log('');
      console.log('  STEP 1 — Opportunity Owner filter (top row):');
      console.log('    • Click "Opportunity Owner" dropdown');
      console.log('    • Clear your name (Jeffrey L Trbovich)');
      console.log('    • Search for and select "Dushyant K Patel"');
      console.log('');
      console.log('  STEP 2 — Scroll down to the Deal List by Opportunity tab');
      console.log('    • Click "Deal List by Opportunity" tab');
      console.log('');
      console.log('  STEP 3 — Forecast Grouping (multi-select):');
      console.log('    • Select: Call, Upside, Stretch');
      console.log('');
      console.log('  STEP 4 — Confirm the opportunity table shows VP\'s data');
      console.log('');
      console.log('  When the table looks correct, come back here and');
      console.log('  press ENTER to capture the data.');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');

      await waitForEnter();

      // Clear any previously captured payloads from the initial page load
      capturedPayloads.length = 0;

      // Reload the page — this forces fresh /wave/ API calls with the
      // current filter state baked into the dashboard URL/state
      console.log('Capturing data — please wait...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(12000);

    } else {
      // ── Headless / automated mode ────────────────────────────────────────
      // Assumes saved view in config.iscUrl already has the correct filters.
      // Force a reload to bypass service worker cache.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(12000);
    }

    const scraped_at = new Date().toISOString();

    if (capturedPayloads.length === 0) {
      console.warn(
        '\nWARNING: No /wave/ API responses were intercepted.\n' +
        '  Possible causes:\n' +
        '  1. Session expired       → run: node scraper/login.js\n' +
        '  2. Dashboard served from cache → run with --headed and manually refresh the page\n' +
        '  3. API URL pattern changed → check DevTools Network tab for /wave/ requests\n'
      );
      process.exitCode = 1;
      return;
    }

    // Optionally dump raw API response for field name inspection
    if (dump) {
      const dumpPath = path.join(__dirname, 'api-dump.json');
      fs.writeFileSync(dumpPath, JSON.stringify(capturedPayloads, null, 2));
      console.log(`\n[--dump] Raw API responses saved to: ${dumpPath}`);
      console.log('  Inspect this file to find exact Salesforce field names.\n');
    }

    console.log(`\nProcessing ${capturedPayloads.length} captured API response(s)...`);

    // Use the payload with the most records as the main deal list
    const mainPayload = capturedPayloads.reduce((best, p) => {
      const count = p?.results?.records?.length ?? p?.records?.length ?? 0;
      const bestCount = best?.results?.records?.length ?? best?.records?.length ?? 0;
      return count > bestCount ? p : best;
    }, capturedPayloads[0]);

    let allOpportunities = parseRecords(mainPayload, scraped_at);
    console.log(`  → ${allOpportunities.length} records from main payload`);

    // Follow pagination (Salesforce CRM Analytics pages at ~10,000 rows)
    const cookies = await context.cookies();
    let nextPageUrl = mainPayload?.results?.nextPageUrl ?? mainPayload?.nextPageUrl ?? null;
    let pageNum = 2;

    while (nextPageUrl) {
      console.log(`  → Fetching page ${pageNum}...`);
      const baseUrl = new URL(config.iscUrl);
      const fullUrl = nextPageUrl.startsWith('http')
        ? nextPageUrl
        : `${baseUrl.protocol}//${baseUrl.host}${nextPageUrl}`;

      try {
        const pagePayload = await fetchPageWithCookies(fullUrl, cookies);
        const pageRecords = parseRecords(pagePayload, scraped_at);
        console.log(`    → Page ${pageNum}: ${pageRecords.length} additional records`);
        allOpportunities = allOpportunities.concat(pageRecords);
        nextPageUrl = pagePayload?.results?.nextPageUrl ?? pagePayload?.nextPageUrl ?? null;
        pageNum++;
      } catch (err) {
        console.error(`  ERROR fetching page ${pageNum}: ${err.message}`);
        break;
      }
    }

    // Drop rows with no real Opportunity ID
    const valid = allOpportunities.filter(o => o.id && !o.id.startsWith('unknown-'));
    const skipped = allOpportunities.length - valid.length;
    if (skipped > 0) console.log(`  → Skipped ${skipped} record(s) with no Opportunity ID`);

    upsertMany(valid);
    console.log(`\nSUCCESS: ${valid.length} opportunities saved to database.`);

  } catch (err) {
    console.error('SCRAPE ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
