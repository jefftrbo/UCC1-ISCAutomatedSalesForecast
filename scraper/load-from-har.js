/**
 * scraper/load-from-har.js
 *
 * Loads ISC opportunity data from a Brave DevTools HAR (HTTP Archive) export.
 *
 * The HAR file captures ALL network responses made during your browser session,
 * including the Salesforce CRM Analytics /wave/query API response that contains
 * the full opportunity dataset. This script finds that response automatically —
 * no manual hunting for the right request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WEEKLY WORKFLOW (≈ 2 minutes)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Step 1 — Open ISC in Brave and set your filters:
 *   a. Opportunity Owner  → clear your name → select "Dushyant K Patel"
 *   b. Click "Deal List by Opportunity" tab
 *   c. Forecast Grouping  → select Call, Upside, Stretch
 *   d. Confirm the table shows the VP's data (~200 opportunities)
 *
 * Step 2 — Open DevTools while the filtered table is visible:
 *   Press Cmd+Option+I → click the "Network" tab
 *
 * Step 3 — Export the HAR file:
 *   Click the ⬇ (download/export) icon at the top of the Network panel
 *   (tooltip says "Export HAR..." or "Save all as HAR with content")
 *   Save the file as:  scraper/isc-export.har
 *
 * Step 4 — Run this script:
 *   node scraper/load-from-har.js
 *
 *   Or just click "Refresh Data" in the web app — it auto-detects the HAR file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTES
 * ─────────────────────────────────────────────────────────────────────────────
 * - You do NOT need to reload the page before exporting — the /wave/query
 *   responses are already in the Network tab from when the table loaded.
 * - The HAR file can be large (5–20 MB) — that's normal and expected.
 * - The script automatically finds the /wave/query entry with the most records.
 * - Previous selections in the web app are preserved on re-import.
 * - The HAR file is gitignored (contains session data).
 */

const path = require('path');
const fs   = require('fs');
const db   = require('../server/db');

const HAR_FILE = path.join(__dirname, 'isc-export.har');

// ---------------------------------------------------------------------------
// Find the best /wave/query entry in a HAR file.
// Returns the parsed JSON response body, or null if not found.
// ---------------------------------------------------------------------------
function findWaveQueryResponse(har) {
  const entries = har?.log?.entries ?? [];
  if (entries.length === 0) return null;

  // Filter to entries that look like Salesforce /wave/ API calls
  const waveEntries = entries.filter(e => {
    const url = e?.request?.url ?? '';
    return url.includes('/wave/') && e?.response?.content?.text;
  });

  if (waveEntries.length === 0) return null;

  console.log(`  Found ${waveEntries.length} /wave/ entries in HAR.`);

  // Try to parse each entry's response body and find the one with the most records
  let bestPayload = null;
  let bestCount   = 0;

  for (const entry of waveEntries) {
    const url      = entry.request.url;
    const mimeType = entry.response.content.mimeType ?? '';
    const text     = entry.response.content.text ?? '';

    if (!mimeType.includes('json') && !text.trim().startsWith('{')) continue;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // Some HAR entries store base64-encoded content
      try {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        payload = JSON.parse(decoded);
      } catch {
        continue;
      }
    }

    const count = payload?.results?.records?.length ?? payload?.records?.length ?? 0;
    // Prefer payloads that have Opp.Name or Opp.Id — those are the full deal list rows
    // (Entry 14 has OpportunityId+count only; Entry 20 has Opp.Name + all fields)
    const records = payload?.results?.records ?? payload?.records ?? [];
    const hasFullRecord = records.length > 0 && records[0] && (
      'Opp.Name' in records[0] || 'Opp.Id' in records[0] || 'Opp.Stage' in records[0]
    );
    // Weight full-record payloads heavily so they win over count aggregates
    const score = hasFullRecord ? count * 1000 : count;
    if (score > bestCount) {
      bestCount   = score;
      bestPayload = payload;
      console.log(`  ✓ ${url.split('?')[0].split('/').slice(-3).join('/')} — ${count} records${hasFullRecord ? ' [deal list]' : ''}`);
    }
  }

  return bestPayload;
}

// ---------------------------------------------------------------------------
// Parse records — same field mapping logic as scrape.js / fetch-from-api.js
// ---------------------------------------------------------------------------
function parseRecords(payload, scraped_at) {
  const records = payload?.results?.records ?? payload?.records ?? [];
  if (!Array.isArray(records) || records.length === 0) return [];

  return records.map((r) => {
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
      return String(raw).slice(0, 10);
    };

    return {
      // Field names confirmed from HAR Entry 20 (206-record deal list)
      id: pick(
        'Opp.Id','OpportunityId','Opportunity_ID','Id','id','opportunity_id'
      ) ?? `unknown-${Math.random().toString(36).slice(2)}`,

      opportunity_name: pick(
        'Opp.Name','Opportunity','Opportunity_Name','OpportunityName','Name','opportunity_name'
      ) ?? '',

      filtered_opportunity_amount: parseAmount(
        'Filtered Opportunity Amount','Filtered_Opportunity_Amount','FilteredOpportunityAmount','filtered_opportunity_amount','Filtered_Amount'
      ),

      total_opportunity_amount: parseAmount(
        'Total Opportunity Amount','Total_Opportunity_Amount','TotalOpportunityAmount','total_opportunity_amount','Amount','TotalAmount'
      ),

      opportunity_owner: pick(
        'Opp.User.User_Name_mk__c','Opportunity_Owner','OpportunityOwner','opportunity_owner','Owner','OwnerName','Owner.Name'
      ) ?? '',

      opportunity_owners_manager: pick(
        'Opp.FLM.User_Name_mk__c','Opp.Manager.User_Name_mk__c',
        "Opportunity_Owner_s_Manager","Opportunity_Owner's_Manager",
        'OpportunityOwnersManager','OwnersManager','FLM','FLMName','Manager.Name'
      ) ?? '',

      opportunity_created_by: pick(
        'Opp.CreatedBy.User_Name_mk__c','Opportunity_Created_By','OpportunityCreatedBy','CreatedBy','CreatedByName','Created_By'
      ) ?? '',

      close_date: parseDate(
        'Opp.CloseDate','Close_Date','CloseDate','close_date','Closedate'
      ),

      create_date: parseDate(
        'CreateDate','Create_Date','CreatedDate','create_date','Opportunity_Create_Date'
      ),

      stage: pick(
        'Opp.Stage','Stage','StageName','Stage_Name','stage','stage_name','Opportunity_Stage'
      ) ?? '',

      forecast_category: pick(
        'Opp.ForecastCategoryName','Forecast','ForecastCategory','Forecast_Category',
        'forecast_category','ForecastCategoryName','Forecast_Grouping','ForecastGrouping','RoadmapStatus'
      ) ?? '',

      flm_judgement: pick(
        'FLMJudgement','FLM_Judgement','flm_judgement','FLM_Judgment','FLMJudgment','ManagerJudgement'
      ) ?? '',

      account_name: pick(
        'Opp.Acc.Name','Opp.Account.Name','Account_Detail','AccountDetail','account_name',
        'Account','AccountName','Account_Name','Account.Name'
      ) ?? '',

      account_company: pick(
        'Opp.Acc.Company__c','Opp.Acc.Ultimate_Parent_Account__c',
        'Account_Company','AccountCompany','account_company','Account__Company','ParentAccount','UltimateParent'
      ) ?? '',

      account_db_dc: pick(
        'Opp.Acc.DB_DC__c','Account_DB_DC','AccountDBDC','account_db_dc','DBDC','DB_DC'
      ) ?? '',

      next_steps: pick(
        'Opp.NextStep','Next_Steps','NextStep','next_steps','NextSteps','Description'
      ) ?? '',

      team_notes: pick(
        'Opp.Team_Notes__c','Team_Notes','TeamNotes','team_notes','TeamNote','InternalNotes','Notes'
      ) ?? '',

      business_partner: pick(
        'Opp.BP.Name','Business_Partner','BusinessPartner','business_partner','Partner','PartnerName'
      ) ?? '',

      technology_client: pick(
        'Opp.Acc.Technology_Client__c','Technology_Client','TechnologyClient','technology_client','ClientType','Client_Type'
      ) ?? '',

      acquisition_pipeline: pick(
        'AcquisitionPipeline2','Acquisition_Pipeline','AcquisitionPipeline','acquisition_pipeline','Pipeline','PipelineType'
      ) ?? '',

      ibm_technology_plan: pick(
        'Opp.AccountPlanQuipDocURL','IBM_Technology_Plan','IBMTechnologyPlan','ibm_technology_plan','TechPlan','Technology_Plan','QuipLink'
      ) ?? '',

      raw_data:   JSON.stringify(r),
      scraped_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Upsert — preserves user's `selected` flag on re-import; tags rows with user_id
// ---------------------------------------------------------------------------
// USER_ID is injected by server/index.js when spawning this script as a child process.
// When running the script directly from the CLI (dev mode), it falls back to null,
// which means the row will NOT be assigned to a user — run init-users.js afterwards
// or set USER_ID=yourname@ibm.com manually.
const USER_ID = process.env.USER_ID || null;
if (USER_ID) {
  console.log(`[har] Tagging rows as user: ${USER_ID}`);
} else {
  console.warn('[har] WARNING: USER_ID not set — rows will have user_id = NULL.');
  console.warn('[har] Run: USER_ID=yourname@ibm.com node scraper/load-from-har.js');
}

const upsert = db.prepare(`
  INSERT INTO opportunities (
    id, opportunity_name,
    filtered_opportunity_amount, total_opportunity_amount,
    opportunity_owner, opportunity_owners_manager, opportunity_created_by,
    close_date, create_date, stage, forecast_category, flm_judgement,
    account_name, account_company, account_db_dc,
    next_steps, team_notes, business_partner, technology_client,
    acquisition_pipeline, ibm_technology_plan, raw_data, scraped_at, user_id
  ) VALUES (
    @id, @opportunity_name,
    @filtered_opportunity_amount, @total_opportunity_amount,
    @opportunity_owner, @opportunity_owners_manager, @opportunity_created_by,
    @close_date, @create_date, @stage, @forecast_category, @flm_judgement,
    @account_name, @account_company, @account_db_dc,
    @next_steps, @team_notes, @business_partner, @technology_client,
    @acquisition_pipeline, @ibm_technology_plan, @raw_data, @scraped_at, @user_id
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
    scraped_at                  = excluded.scraped_at,
    user_id                     = COALESCE(excluded.user_id, opportunities.user_id)
`);

const upsertMany = db.transaction((rows) => {
  for (const row of rows) upsert.run({ ...row, user_id: USER_ID });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (!fs.existsSync(HAR_FILE)) {
  console.error(`ERROR: HAR file not found at: ${HAR_FILE}`);
  console.error('');
  console.error('To export a HAR file from Brave:');
  console.error('  1. Open ISC in Brave and set your filters:');
  console.error('       Owner → Dushyant K Patel');
  console.error('       Tab   → Deal List by Opportunity');
  console.error('       Forecast → Call, Upside, Stretch');
  console.error('  2. Press Cmd+Option+I → Network tab');
  console.error('  3. Click the ⬇ export icon → "Save all as HAR with content"');
  console.error(`  4. Save as: ${HAR_FILE}`);
  console.error('  5. Re-run: node scraper/load-from-har.js');
  process.exit(1);
}

console.log(`Loading HAR file: ${HAR_FILE}`);
const stat = fs.statSync(HAR_FILE);
console.log(`  File size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

let har;
try {
  har = JSON.parse(fs.readFileSync(HAR_FILE, 'utf8'));
} catch (err) {
  console.error(`ERROR: Failed to parse HAR file — ${err.message}`);
  console.error('Make sure you saved the complete HAR file (not truncated).');
  process.exit(1);
}

// --inspect: dump all /wave/ entries and their field names before any validation
if (process.argv.includes('--inspect')) {
  const allEntries = har?.log?.entries ?? [];
  const waveEntries = allEntries.filter(e =>
    (e?.request?.url ?? '').includes('/wave/') && e?.response?.content?.text
  );
  console.log(`\n[--inspect] ${waveEntries.length} /wave/ entries found:\n`);
  let num = 0;
  for (const entry of waveEntries) {
    const text = entry.response.content.text ?? '';
    let p;
    try { p = JSON.parse(text); } catch {
      try { p = JSON.parse(Buffer.from(text, 'base64').toString('utf8')); } catch { continue; }
    }
    const records = p?.results?.records ?? p?.records ?? [];
    if (records.length === 0) continue;
    num++;
    const url = entry.request.url.split('?')[0].split('/').slice(-3).join('/');
    console.log(`── Entry ${num}: ${url} (${records.length} records) ──`);
    Object.keys(records[0]).forEach(k => {
      console.log(`  ${k}: ${String(records[0][k] ?? '').slice(0, 80)}`);
    });
    console.log('');
  }
  process.exit(0);
}

console.log('\nSearching for /wave/query responses...');
const payload = findWaveQueryResponse(har);

if (!payload) {
  console.error('\nERROR: No /wave/query response with opportunity records found in the HAR.');
  console.error('');
  console.error('Make sure:');
  console.error('  - You set the filters BEFORE exporting the HAR');
  console.error('  - The opportunity table was fully loaded when you exported');
  console.error('  - You used "Save all as HAR with content" (not just "Save as HAR")');
  process.exit(1);
}

const scraped_at = new Date().toISOString();
const rows  = parseRecords(payload, scraped_at);
const valid = rows.filter(r => r.id && !r.id.startsWith('unknown-'));
const skipped = rows.length - valid.length;

if (valid.length === 0) {
  console.error('\nERROR: Records found in HAR but no valid Opportunity IDs detected.');
  console.error('The field names in the response may differ from expected aliases.');
  console.error('\nRun with --inspect to see raw field names:');
  console.error('  node scraper/load-from-har.js --inspect');
  process.exit(1);
}

upsertMany(valid);

console.log(`\nSUCCESS: ${valid.length} opportunities loaded into database.`);
if (skipped > 0) console.log(`Skipped: ${skipped} record(s) with no Opportunity ID.`);
console.log('');
console.log('Next steps:');
console.log('  • Web app already running?  → Refresh the page at http://localhost:3090');
console.log('  • Not running yet?          → npm start  then open http://localhost:3090');
