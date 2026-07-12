/**
 * scraper/fetch-from-api.js
 *
 * Fetches opportunity data directly from the Salesforce CRM Analytics REST API
 * using the dataset URLs discovered from the devtools-response.json metadata
 * and your session cookies from cookies.json.
 *
 * Usage:
 *   node scraper/fetch-from-api.js
 *
 * Prerequisites:
 *   - scraper/cookies.json must exist (exported from Brave Cookie-Editor)
 *   - scraper/devtools-response.json must exist (the aura.Wave.getDatasets response)
 */

const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const db     = require('../server/db');
const config = require('../config.json');

const COOKIES_FILE  = path.join(__dirname, 'cookies.json');
const DATASETS_FILE = path.join(__dirname, 'devtools-response.json');

// Base URL from config
const BASE_URL = `https://${new URL(config.iscUrl).hostname}`;

// SAQL query — fetches all opportunity fields matching the Forecast dashboard
// filtered to Dushyant K Patel's opportunities (Call/Upside/Stretch)
const SAQL_QUERY = `
q = load "All_Opportunities";
q = filter q by 'Opportunity_Owner' == "Dushyant K Patel";
q = filter q by 'Forecast_Grouping' in ["Call", "Upside", "Stretch"];
q = foreach q generate
  'Opportunity_ID'                 as 'Opportunity_ID',
  'Opportunity'                    as 'Opportunity',
  'Account_Detail'                 as 'Account_Detail',
  'Filtered_Opportunity_Amount'    as 'Filtered_Opportunity_Amount',
  'Total_Opportunity_Amount'       as 'Total_Opportunity_Amount',
  'Opportunity_Owner'              as 'Opportunity_Owner',
  'Opportunity_Owner_s_Manager'    as 'Opportunity_Owner_s_Manager',
  'Opportunity_Created_By'         as 'Opportunity_Created_By',
  'Close_Date'                     as 'Close_Date',
  'Create_Date'                    as 'Create_Date',
  'Stage'                          as 'Stage',
  'Forecast'                       as 'Forecast',
  'FLM_Judgement'                  as 'FLM_Judgement',
  'Account'                        as 'Account',
  'Account_Company'                as 'Account_Company',
  'Account_DB_DC'                  as 'Account_DB_DC',
  'Next_Steps'                     as 'Next_Steps',
  'Team_Notes'                     as 'Team_Notes',
  'Business_Partner'               as 'Business_Partner',
  'Technology_Client'              as 'Technology_Client',
  'Acquisition_Pipeline'           as 'Acquisition_Pipeline',
  'IBM_Technology_Plan'            as 'IBM_Technology_Plan';
q = limit q 10000;
`.trim();

// ---------------------------------------------------------------------------
// HTTP helper — POST JSON to Salesforce API with session cookies
// ---------------------------------------------------------------------------
function apiRequest(urlPath, body, cookies) {
  return new Promise((resolve, reject) => {
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const bodyStr = JSON.stringify(body);

    const req = https.request(
      `${BASE_URL}${urlPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'Cookie': cookieHeader,
          'Accept': 'application/json',
          'X-Chatter-Entity-Encoding': 'false',
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { reject(new Error(`Failed to parse response (${res.statusCode}): ${data.slice(0, 300)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Parse records — same logic as scrape.js
// ---------------------------------------------------------------------------
function parseRecords(records, scraped_at) {
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
      id: pick('Opportunity_ID','OpportunityId','opportunity_id','Id','id') ?? `unknown-${Math.random().toString(36).slice(2)}`,
      opportunity_name: pick('Opportunity','Opportunity_Name','OpportunityName','Name') ?? '',
      filtered_opportunity_amount: parseAmount('Filtered_Opportunity_Amount','FilteredOpportunityAmount','filtered_opportunity_amount'),
      total_opportunity_amount: parseAmount('Total_Opportunity_Amount','TotalOpportunityAmount','total_opportunity_amount','Amount'),
      opportunity_owner: pick('Opportunity_Owner','OpportunityOwner','Owner','OwnerName') ?? '',
      opportunity_owners_manager: pick("Opportunity_Owner_s_Manager","Opportunity_Owner's_Manager",'OpportunityOwnersManager','FLM') ?? '',
      opportunity_created_by: pick('Opportunity_Created_By','OpportunityCreatedBy','CreatedBy') ?? '',
      close_date: parseDate('Close_Date','CloseDate','close_date'),
      create_date: parseDate('Create_Date','CreateDate','CreatedDate','create_date'),
      stage: pick('Stage','StageName','stage') ?? '',
      forecast_category: pick('Forecast','ForecastCategory','Forecast_Category','forecast_category','ForecastGrouping','Forecast_Grouping') ?? '',
      flm_judgement: pick('FLM_Judgement','FLMJudgement','flm_judgement') ?? '',
      account_name: pick('Account_Detail','AccountDetail','Account','AccountName','account_name') ?? '',
      account_company: pick('Account_Company','AccountCompany','account_company') ?? '',
      account_db_dc: pick('Account_DB_DC','AccountDBDC','account_db_dc') ?? '',
      next_steps: pick('Next_Steps','NextStep','next_steps') ?? '',
      team_notes: pick('Team_Notes','TeamNotes','team_notes') ?? '',
      business_partner: pick('Business_Partner','BusinessPartner','business_partner') ?? '',
      technology_client: pick('Technology_Client','TechnologyClient','technology_client') ?? '',
      acquisition_pipeline: pick('Acquisition_Pipeline','AcquisitionPipeline','acquisition_pipeline') ?? '',
      ibm_technology_plan: pick('IBM_Technology_Plan','IBMTechnologyPlan','ibm_technology_plan') ?? '',
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
    close_date, create_date, stage, forecast_category, flm_judgement,
    account_name, account_company, account_db_dc,
    next_steps, team_notes, business_partner, technology_client,
    acquisition_pipeline, ibm_technology_plan, raw_data, scraped_at
  ) VALUES (
    @id, @opportunity_name,
    @filtered_opportunity_amount, @total_opportunity_amount,
    @opportunity_owner, @opportunity_owners_manager, @opportunity_created_by,
    @close_date, @create_date, @stage, @forecast_category, @flm_judgement,
    @account_name, @account_company, @account_db_dc,
    @next_steps, @team_notes, @business_partner, @technology_client,
    @acquisition_pipeline, @ibm_technology_plan, @raw_data, @scraped_at
  )
  ON CONFLICT(id) DO UPDATE SET
    opportunity_name=excluded.opportunity_name,
    filtered_opportunity_amount=excluded.filtered_opportunity_amount,
    total_opportunity_amount=excluded.total_opportunity_amount,
    opportunity_owner=excluded.opportunity_owner,
    opportunity_owners_manager=excluded.opportunity_owners_manager,
    opportunity_created_by=excluded.opportunity_created_by,
    close_date=excluded.close_date, create_date=excluded.create_date,
    stage=excluded.stage, forecast_category=excluded.forecast_category,
    flm_judgement=excluded.flm_judgement,
    account_name=excluded.account_name, account_company=excluded.account_company,
    account_db_dc=excluded.account_db_dc,
    next_steps=excluded.next_steps, team_notes=excluded.team_notes,
    business_partner=excluded.business_partner,
    technology_client=excluded.technology_client,
    acquisition_pipeline=excluded.acquisition_pipeline,
    ibm_technology_plan=excluded.ibm_technology_plan,
    raw_data=excluded.raw_data, scraped_at=excluded.scraped_at
`);

const upsertMany = db.transaction((rows) => { for (const row of rows) upsert.run(row); });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  // Load cookies
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error('ERROR: scraper/cookies.json not found.');
    console.error('Export cookies from Brave Cookie-Editor while on the ISC page.');
    process.exit(1);
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));

  // Get dataset version URL from devtools-response.json
  let datasetVersionUrl = null;
  if (fs.existsSync(DATASETS_FILE)) {
    const meta = JSON.parse(fs.readFileSync(DATASETS_FILE, 'utf8'));
    const datasets = meta?.actions?.[0]?.returnValue?.datasets ?? [];
    // Prefer All_Opportunities, fall back to All_Opportunities_TM
    const ds = datasets.find(d => d.label === 'All_Opportunities') ||
               datasets.find(d => d.label === 'All_Opportunities_TM') ||
               datasets.find(d => d.label?.includes('Opportunit'));
    if (ds?.currentVersionUrl) {
      datasetVersionUrl = ds.currentVersionUrl;
      console.log(`Using dataset: ${ds.label}`);
      console.log(`Version URL:   ${datasetVersionUrl}`);
    }
  }

  // Build query URL
  const queryUrl = datasetVersionUrl
    ? `${datasetVersionUrl.replace('/versions/', '/query?versionId=').replace(/\/versions\/[^/]+$/, '')}/query`
    : '/services/data/v67.0/wave/query';

  console.log(`\nQuerying: ${BASE_URL}/services/data/v67.0/wave/query`);
  console.log('Fetching Dushyant K Patel\'s Call/Upside/Stretch opportunities...\n');

  let allRecords = [];
  let offset = 0;
  const pageSize = 2000;
  let page = 1;

  while (true) {
    const paginatedSaql = SAQL_QUERY + (offset > 0 ? `\nq = offset q ${offset};` : '');

    const result = await apiRequest('/services/data/v67.0/wave/query', {
      query: paginatedSaql,
      queryLanguage: 'SAQL',
    }, cookies);

    if (result.status === 401 || result.status === 403) {
      console.error(`\nERROR: Session expired or unauthorized (HTTP ${result.status}).`);
      console.error('Re-export cookies from Brave Cookie-Editor while on the ISC page');
      console.error('and save to scraper/cookies.json, then run this script again.');
      process.exit(1);
    }

    if (result.status !== 200) {
      console.error(`\nERROR: API returned HTTP ${result.status}`);
      console.error(JSON.stringify(result.body, null, 2).slice(0, 500));
      process.exit(1);
    }

    const records = result.body?.results?.records ?? result.body?.records ?? [];
    console.log(`  Page ${page}: ${records.length} records`);

    if (records.length === 0) break;

    allRecords = allRecords.concat(records);
    if (records.length < pageSize) break;

    offset += pageSize;
    page++;
  }

  if (allRecords.length === 0) {
    console.error('\nERROR: No records returned.');
    console.error('The SAQL field names may not match this dataset.');
    console.error('\nRun this to see available field names:');
    console.error('  node scraper/inspect-fields.js');
    process.exit(1);
  }

  const scraped_at = new Date().toISOString();
  const rows = parseRecords(allRecords, scraped_at);
  const valid = rows.filter(r => r.id && !r.id.startsWith('unknown-'));
  const skipped = rows.length - valid.length;

  upsertMany(valid);
  console.log(`\nSUCCESS: ${valid.length} opportunities saved to database.`);
  if (skipped > 0) console.log(`Skipped ${skipped} record(s) with no Opportunity ID.`);
  console.log('\nNext: npm start → http://localhost:3090');
})();
