const Database = require('better-sqlite3');
const path = require('path');

// DB file lives at project root
const DB_PATH = path.join(__dirname, '..', 'opportunities.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create the opportunities table if it doesn't already exist.
//
// All 20 columns confirmed from the ISC "Forecast v66.0 — Deal List by Opportunity"
// dashboard (full horizontal scroll captured). Field order matches left→right column order.
// ALL raw API fields are also stored in `raw_data` (JSON blob) so nothing is ever lost.
db.exec(`
  CREATE TABLE IF NOT EXISTS opportunities (
    -- ── Core identity ──────────────────────────────────────────────────────
    id                          TEXT PRIMARY KEY,   -- Opportunity ID (e.g. 006gR000004eqMOQAU)
    opportunity_name            TEXT,               -- Opportunity (linked name)

    -- ── Amounts ────────────────────────────────────────────────────────────
    filtered_opportunity_amount REAL,               -- Filtered Opportunity Amount ($)
    total_opportunity_amount    REAL,               -- Total Opportunity Amount ($)

    -- ── People ─────────────────────────────────────────────────────────────
    opportunity_owner           TEXT,               -- Opportunity Owner
    opportunity_owners_manager  TEXT,               -- Opportunity Owner's Manager
    opportunity_created_by      TEXT,               -- Opportunity Created By

    -- ── Dates ──────────────────────────────────────────────────────────────
    close_date                  TEXT,               -- Close Date (YYYY-MM-DD)
    create_date                 TEXT,               -- Create Date (YYYY-MM-DD)

    -- ── Stage & Forecast ───────────────────────────────────────────────────
    stage                       TEXT,               -- Stage (Negotiate/Qualify/Design/Propose/Engage)
    forecast_category           TEXT,               -- Forecast (Best Case/Pipeline/Omitted)
    flm_judgement               TEXT,               -- FLM Judgement (Yes/No)

    -- ── Account ────────────────────────────────────────────────────────────
    account_name                TEXT,               -- Account Detail (display name)
    account_company             TEXT,               -- Account (Company)
    account_db_dc               TEXT,               -- Account (DB/DC)

    -- ── Notes & Context ────────────────────────────────────────────────────
    next_steps                  TEXT,               -- Next Steps (free text)
    team_notes                  TEXT,               -- Team Notes

    -- ── Partner & Classification ───────────────────────────────────────────
    business_partner            TEXT,               -- Business Partner
    technology_client           TEXT,               -- Technology Client (Existing Continued/New)
    acquisition_pipeline        TEXT,               -- Acquisition Pipeline (IBM Pipeline)
    ibm_technology_plan         TEXT,               -- IBM Technology Plan (ibm.quip.com URL)

    -- ── Metadata ───────────────────────────────────────────────────────────
    raw_data                    TEXT,               -- Full JSON record from Salesforce API (all fields)
    scraped_at                  TEXT,               -- ISO timestamp of last scrape
    selected                    INTEGER DEFAULT 0,  -- 1 = included in GM meeting, 0 = excluded

    -- ── watsonx.ai scoring (v2.0.0) ────────────────────────────────────────
    ai_score                    INTEGER,            -- watsonx.ai confidence score 0–100
    ai_rationale                TEXT,               -- One-sentence AI rationale
    ai_scored_at                TEXT                -- ISO timestamp of last AI scoring
  )
`);

// ── v2.0.0 migration — add watsonx columns to existing databases ──────────────
// SQLite does not support ADD COLUMN IF NOT EXISTS, so we check PRAGMA table_info first.
const existingCols = db.pragma('table_info(opportunities)').map(c => c.name);
const v2Columns = [
  { name: 'ai_score',      ddl: 'ALTER TABLE opportunities ADD COLUMN ai_score INTEGER'      },
  { name: 'ai_rationale',  ddl: 'ALTER TABLE opportunities ADD COLUMN ai_rationale TEXT'     },
  { name: 'ai_scored_at',  ddl: 'ALTER TABLE opportunities ADD COLUMN ai_scored_at TEXT'     },
];
v2Columns.forEach(({ name, ddl }) => {
  if (!existingCols.includes(name)) {
    db.exec(ddl);
    console.log(`[db] Migration: added column ${name}`);
  }
});

module.exports = db;
