/**
 * scraper/load-from-devtools.js
 *
 * Alternative to Playwright scraping — reads a /wave/query API response
 * that you manually captured from Brave's DevTools Network tab and saved
 * as scraper/devtools-response.json
 *
 * This approach is used when Playwright cannot control the browser due to
 * passkey / SSO authentication requirements.
 *
 * HOW TO CAPTURE THE DATA (one-time per weekly refresh):
 *
 * Step 1 — Open ISC in your regular Brave browser (not Playwright)
 *   Navigate to: https://ibmsc.lightning.force.com
 *
 * Step 2 — Set your filters:
 *   • Opportunity Owner → clear your name → select "Dushyant K Patel"
 *   • Scroll down → click "Deal List by Opportunity" tab
 *   • Forecast Grouping → select Call, Upside, Stretch
 *   • Confirm the opportunity table shows the VP's data
 *
 * Step 3 — Open DevTools while on the filtered dashboard:
 *   • Press Cmd+Option+I  (or right-click → Inspect)
 *   • Click the "Network" tab
 *   • In the filter box, type:  wave
 *   • Reload the page with the filters still applied (Cmd+R)
 *   • Wait for the table to load
 *
 * Step 4 — Find the largest /wave/query response:
 *   • Look for a request with "wave" in the name that has the most data
 *   • Click on it
 *   • Click the "Response" tab (or "Preview")
 *   • Right-click anywhere in the response body → "Copy response"
 *     (or click the copy icon if available)
 *
 * Step 5 — Save the copied JSON:
 *   • Open a text editor
 *   • Paste and save as:  scraper/devtools-response.json
 *
 * Step 6 — Run this script:
 *   node scraper/load-from-devtools.js
 *
 * The opportunities will be saved to the database and available in the web app.
 */

const path = require('path');
const fs   = require('fs');
const db   = require('../server/db');

const INPUT_FILE = path.join(__dirname, 'devtools-response.json');

// ---------------------------------------------------------------------------
// Same field parsing logic as scrape.js
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
      id: pick('Opportunity_ID','OpportunityId','opportunity_id','Id','id','Opportunity.Id','opp_id')
          ?? `unknown-${Math.random().toString(36).slice(2)}`,
      opportunity_name: pick('Opportunity','Opportunity_Name','OpportunityName','Name','opportunity_name','Opportunity.Name','OppName') ?? '',
      filtered_opportunity_amount: parseAmount('Filtered_Opportunity_Amount','FilteredOpportunityAmount','filtered_opportunity_amount','Filtered_Amount','FilteredAmount'),
      total_opportunity_amount: parseAmount('Total_Opportunity_Amount','TotalOpportunityAmount','total_opportunity_amount','Amount','TotalAmount','OppAmount'),
      opportunity_owner: pick('Opportunity_Owner','OpportunityOwner','opportunity_owner','Owner','OwnerName','Owner.Name','OppOwner') ?? '',
      opportunity_owners_manager: pick("Opportunity_Owner_s_Manager","Opportunity_Owner's_Manager",'OpportunityOwnersManager','OwnersManager','ManagerName','Owner_Manager','opportunity_owners_manager','FLM','FLMName','Manager.Name','DirectManager') ?? '',
      opportunity_created_by: pick('Opportunity_Created_By','OpportunityCreatedBy','CreatedBy','CreatedByName','Created_By','opportunity_created_by','CreatedBy.Name','Creator') ?? '',
      close_date: parseDate('Close_Date','CloseDate','close_date','Closedate'),
      create_date: parseDate('Create_Date','CreateDate','CreatedDate','create_date','Opportunity_Create_Date','OpportunityCreateDate'),
      stage: pick('Stage','StageName','Stage_Name','stage','stage_name','Opportunity_Stage','OppStage') ?? '',
      forecast_category: pick('Forecast','ForecastCategory','Forecast_Category','forecast_category','ForecastCategoryName','Forecast_Category_Name','ForecastGroup','Forecast_Grouping','ForecastGrouping') ?? '',
      flm_judgement: pick('FLM_Judgement','FLMJudgement','flm_judgement','FLM_Judgment','FLMJudgment','FLM_Override','FLMOverride','ManagerJudgement') ?? '',
      account_name: pick('Account_Detail','AccountDetail','account_name','Account','AccountName','Account_Name','Account.Name') ?? '',
      account_company: pick('Account_Company','AccountCompany','account_company','Account__Company','ParentAccount','Account_Parent','UltimateParent','Ultimate_Parent') ?? '',
      account_db_dc: pick('Account_DB_DC','AccountDBDC','account_db_dc','Account__DB_DC','DBDC','DB_DC','Account_DBDC','DBDCName') ?? '',
      next_steps: pick('Next_Steps','NextStep','next_steps','NextSteps','Description') ?? '',
      team_notes: pick('Team_Notes','TeamNotes','team_notes','TeamNote','InternalNotes','Internal_Notes','Notes') ?? '',
      business_partner: pick('Business_Partner','BusinessPartner','business_partner','Partner','PartnerName','BP','BPName') ?? '',
      technology_client: pick('Technology_Client','TechnologyClient','technology_client','ClientType','Client_Type','TechClient','ClientCategory') ?? '',
      acquisition_pipeline: pick('Acquisition_Pipeline','AcquisitionPipeline','acquisition_pipeline','Pipeline','PipelineType','AcqPipeline') ?? '',
      ibm_technology_plan: pick('IBM_Technology_Plan','IBMTechnologyPlan','ibm_technology_plan','TechPlan','Technology_Plan','IBMTechPlan','QuipLink','Quip_Link') ?? '',
      raw_data: JSON.stringify(r),
      scraped_at,
    };
  });
}

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

const upsertMany = db.transaction((rows) => { for (const row of rows) upsert.run(row); });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (!fs.existsSync(INPUT_FILE)) {
  console.error(`ERROR: Input file not found: ${INPUT_FILE}`);
  console.error('');
  console.error('Follow the instructions at the top of this file to capture');
  console.error('the /wave/query response from Brave DevTools and save it as:');
  console.error(`  ${INPUT_FILE}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
} catch (err) {
  console.error(`ERROR: Failed to parse ${INPUT_FILE} — ${err.message}`);
  process.exit(1);
}

const scraped_at = new Date().toISOString();
const rows = parseRecords(payload, scraped_at);

if (rows.length === 0) {
  console.error('ERROR: No records found in the response file.');
  console.error('Make sure you copied the response body of the correct /wave/query request.');
  console.error('');
  console.error('TIP: The correct request is the one with the most data —');
  console.error('     look for "records" array with 100+ entries in the Preview tab.');
  process.exit(1);
}

const valid = rows.filter(r => r.id && !r.id.startsWith('unknown-'));
const skipped = rows.length - valid.length;

upsertMany(valid);

console.log(`SUCCESS: ${valid.length} opportunities loaded into database.`);
if (skipped > 0) console.log(`Skipped ${skipped} record(s) with no Opportunity ID.`);
console.log('');
console.log('Next steps:');
console.log('  npm start  →  open http://localhost:3090');
