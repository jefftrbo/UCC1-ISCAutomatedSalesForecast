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
  // v2.2.0 — persist rules-based score + tier so snapshots capture before→after confidence
  { name: 'score',         ddl: 'ALTER TABLE opportunities ADD COLUMN score INTEGER'          },
  { name: 'tier',          ddl: 'ALTER TABLE opportunities ADD COLUMN tier TEXT'              },
];
v2Columns.forEach(({ name, ddl }) => {
  if (!existingCols.includes(name)) {
    db.exec(ddl);
    console.log(`[db] Migration: added column ${name}`);
  }
});

// ── v2.3.0 — baseline_ledger table (permanent quarterly audit trail) ──────────
//
// DESIGN CHANGE from v2.1.0/v2.2.x:
//   Old design: snapshots keyed by (id, week_label) with INSERT OR REPLACE.
//               Re-running "Baseline & GM Report" in the same week silently
//               overwrote the prior record — no history preserved.
//
//   New design: every confirmed "Final" baseline run gets a globally-unique
//               snapshot_id (UUID). Rows are NEVER overwritten. The table is an
//               append-only audit ledger. Multiple runs per week accumulate as
//               separate records — the diff engine uses MAX(confirmed_at) to
//               find the most recent PRIOR confirmed baseline.
//
// quarter_label: derived at save time from the close of business date,
//                e.g. "Q3 2026". Enables cross-quarter historical queries.
// week_seq:      week number within the quarter (1–13). Enables trend charts.
// confirmed:     0 = "Generate Only" (test run, not a final), 1 = confirmed Final.
//                Only confirmed=1 rows are used as diff baselines.
//
// The old `snapshots` table is preserved for migration safety but no longer written.
db.exec(`
  CREATE TABLE IF NOT EXISTS baseline_ledger (
    snapshot_id     TEXT NOT NULL,        -- UUID, unique per confirmed run
    week_label      TEXT NOT NULL,        -- human timestamp: "Jul 17, 2026 · 7:00 PM"
    quarter_label   TEXT NOT NULL,        -- e.g. "Q3 2026"
    week_seq        INTEGER,              -- week-within-quarter: 1, 2, … 13
    confirmed_at    TEXT NOT NULL,        -- ISO timestamp of this save
    confirmed       INTEGER NOT NULL DEFAULT 1, -- 1=Final confirmed, 0=Generate Only (test)
    id              TEXT NOT NULL,        -- Opportunity ID (matches opportunities.id)
    opportunity_name            TEXT,
    account_name                TEXT,
    stage                       TEXT,
    forecast_category           TEXT,
    close_date                  TEXT,
    filtered_opportunity_amount REAL,
    total_opportunity_amount    REAL,
    opportunity_owner           TEXT,
    flm_judgement               TEXT,
    next_steps                  TEXT,
    team_notes                  TEXT,
    score                       INTEGER,  -- rules-based confidence score at baseline time
    tier                        TEXT,     -- High / Medium / Low at baseline time
    PRIMARY KEY (snapshot_id, id)         -- append-only: snapshot_id never reused
  )
`);

// ── v2.1.0/v2.2.0 snapshots table — preserved for migration safety, no longer written ──
// New code writes only to baseline_ledger. This table stays so existing data is not lost.
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id              TEXT NOT NULL,
    week_label      TEXT NOT NULL,
    snapped_at      TEXT NOT NULL,
    opportunity_name            TEXT,
    account_name                TEXT,
    stage                       TEXT,
    forecast_category           TEXT,
    close_date                  TEXT,
    filtered_opportunity_amount REAL,
    total_opportunity_amount    REAL,
    opportunity_owner           TEXT,
    flm_judgement               TEXT,
    next_steps                  TEXT,
    score                       INTEGER,
    tier                        TEXT,
    PRIMARY KEY (id, week_label)
  )
`);

module.exports = db;
