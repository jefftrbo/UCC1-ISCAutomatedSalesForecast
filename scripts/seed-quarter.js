#!/usr/bin/env node
/**
 * scripts/seed-quarter.js
 *
 * v2.3.0 UI Smoke Test Helper
 * ───────────────────────────
 * Loads 3 weeks of synthetic baseline data into the REAL opportunities.db
 * so you can verify the full UI flow: diff tiles, "What Changed" slide, PPT,
 * and the three-button confirm modal — all with realistic multi-week data.
 *
 * Usage:
 *   node scripts/seed-quarter.js            # seed week 1 baseline + week 3 live state
 *   node scripts/seed-quarter.js --week 2   # advance to week 2 live state
 *   node scripts/seed-quarter.js --status   # show current live pipeline vs. seeds
 *   node scripts/seed-quarter.js --restore  # wipe synthetic data, restore original pipeline
 *   node scripts/seed-quarter.js --dry-run  # show what would happen without writing
 *
 * What it does:
 *   1. Backs up all current rows in opportunities table
 *   2. Inserts 10 synthetic opportunities (distinct IDs: SEED-001 … SEED-010)
 *   3. Writes a confirmed baseline to baseline_ledger as "Week 1"
 *   4. Applies week-2 or week-3 mutations to the live synthetic rows
 *
 * This gives you a real diff to see when you click "⇄ What Changed" or
 * "Generate Only" / "✅ Confirm & Generate" in the UI.
 *
 * --restore removes only SEED-* rows from opportunities and any baseline_ledger
 * entries that reference them. Your real HAR-imported rows are never touched.
 */

'use strict';

const db     = require('../server/db');
const { saveSnapshot } = require('../server/diffEngine');

const args   = process.argv.slice(2);
const isDry  = args.includes('--dry-run');
const isStatus = args.includes('--status');
const isRestore = args.includes('--restore');
const weekArg = args.find(a => a.startsWith('--week'));
const targetWeek = weekArg ? parseInt(weekArg.split('=')[1] || args[args.indexOf(weekArg)+1]) : 3;

// ── Synthetic pipeline — 10 seed opportunities ───────────────────────────────
const SEED_BASE = [
  { id: 'SEED-001', opportunity_name: '[SEED] DoD Cloud Migration',     account_name: 'Dept. of Defense',       stage: 'Propose',    forecast_category: 'Best Case',  close_date: '2026-09-15', filtered_opportunity_amount: 1200000,  total_opportunity_amount: 1500000,  opportunity_owner: 'Rep Alpha', flm_judgement: 'Yes', next_steps: 'Final proposal submitted, awaiting contracting officer review.',      score: 82, tier: 'High'   },
  { id: 'SEED-002', opportunity_name: '[SEED] VA Data Analytics',        account_name: 'Veterans Affairs',       stage: 'Design',     forecast_category: 'Best Case',  close_date: '2026-09-22', filtered_opportunity_amount: 800000,   total_opportunity_amount: 950000,   opportunity_owner: 'Rep Beta',  flm_judgement: 'Yes', next_steps: 'Architecture review with CTO office on Aug 3.',                          score: 74, tier: 'High'   },
  { id: 'SEED-003', opportunity_name: '[SEED] DHS Cybersecurity SOC',    account_name: 'Dept. of Homeland Sec',  stage: 'Negotiate',  forecast_category: 'Best Case',  close_date: '2026-09-30', filtered_opportunity_amount: 2100000,  total_opportunity_amount: 2500000,  opportunity_owner: 'Rep Alpha', flm_judgement: 'Yes', next_steps: 'T&Cs review in progress. Legal on both sides engaged.',               score: 88, tier: 'High'   },
  { id: 'SEED-004', opportunity_name: '[SEED] NASA AI Platform',         account_name: 'NASA',                   stage: 'Engage',     forecast_category: 'Pipeline',   close_date: '2026-09-30', filtered_opportunity_amount: 600000,   total_opportunity_amount: 720000,   opportunity_owner: 'Rep Gamma', flm_judgement: 'No',  next_steps: 'Use case workshop scheduled for July 28.',                              score: 61, tier: 'Medium' },
  { id: 'SEED-005', opportunity_name: '[SEED] GSA Hybrid Cloud',         account_name: 'Gen Services Admin',     stage: 'Qualify',    forecast_category: 'Pipeline',   close_date: '2026-09-30', filtered_opportunity_amount: 400000,   total_opportunity_amount: 480000,   opportunity_owner: 'Rep Delta', flm_judgement: 'No',  next_steps: 'Initial briefing done. Needs budget confirmation from CIO.',            score: 48, tier: 'Medium' },
  { id: 'SEED-006', opportunity_name: '[SEED] Treasury Automation',      account_name: 'Dept. of Treasury',      stage: 'Design',     forecast_category: 'Best Case',  close_date: '2026-09-15', filtered_opportunity_amount: 950000,   total_opportunity_amount: 1100000,  opportunity_owner: 'Rep Beta',  flm_judgement: 'Yes', next_steps: 'SOW draft in review with procurement team.',                           score: 77, tier: 'High'   },
  { id: 'SEED-007', opportunity_name: '[SEED] USAF watsonx Pilot',       account_name: 'US Air Force',           stage: 'Propose',    forecast_category: 'Best Case',  close_date: '2026-09-22', filtered_opportunity_amount: 1500000,  total_opportunity_amount: 1800000,  opportunity_owner: 'Rep Alpha', flm_judgement: 'Yes', next_steps: 'Pilot proposal submitted. Decision expected by Aug 7.',               score: 80, tier: 'High'   },
  { id: 'SEED-008', opportunity_name: '[SEED] HHS Health Analytics',     account_name: 'Dept. of Health & HS',   stage: 'Engage',     forecast_category: 'Pipeline',   close_date: '2026-09-30', filtered_opportunity_amount: 350000,   total_opportunity_amount: 420000,   opportunity_owner: 'Rep Gamma', flm_judgement: 'No',  next_steps: '',                                                                       score: 52, tier: 'Medium' },
  { id: 'SEED-009', opportunity_name: '[SEED] DOE Grid Optimization',    account_name: 'Dept. of Energy',        stage: 'Qualify',    forecast_category: 'Pipeline',   close_date: '2026-09-30', filtered_opportunity_amount: 275000,   total_opportunity_amount: 330000,   opportunity_owner: 'Rep Delta', flm_judgement: 'No',  next_steps: null,                                                                     score: 42, tier: 'Low'    },
  { id: 'SEED-010', opportunity_name: '[SEED] Census Bureau Modernize',  account_name: 'Census Bureau',          stage: 'Design',     forecast_category: 'Best Case',  close_date: '2026-09-15', filtered_opportunity_amount: 700000,   total_opportunity_amount: 830000,   opportunity_owner: 'Rep Beta',  flm_judgement: 'Yes', next_steps: 'Detailed design review Aug 12 with program office.',                  score: 71, tier: 'High'   },
];

// Week 2 mutations (simulating real pipeline movement)
function applyWeek2(opps) {
  opps.find(o => o.id === 'SEED-002').stage = 'Propose';             // Design → Propose (promotion)
  opps.find(o => o.id === 'SEED-004').stage = 'Design';              // Engage → Design (promotion)
  opps.find(o => o.id === 'SEED-003').total_opportunity_amount = 3200000; // upsell +28%
  opps.find(o => o.id === 'SEED-009').close_date = '2026-10-31';     // slipped 31 days
  opps.find(o => o.id === 'SEED-008').next_steps = '';               // still blank (hygiene)
}

// Week 3 mutations (builds on week 2)
function applyWeek3(opps) {
  applyWeek2(opps);
  opps.find(o => o.id === 'SEED-005').stage = 'Qualify';             // already Qualify — no change (quiet deal)
  opps.find(o => o.id === 'SEED-007').stage = 'Negotiate';           // Propose → Negotiate (promotion)
  opps.find(o => o.id === 'SEED-006').total_opportunity_amount = 700000; // amount reduced -36%
  opps.find(o => o.id === 'SEED-001').close_date = '2026-08-30';     // pulled in (was Sep 15)
  // SEED-008 still has blank next_steps — 3rd consecutive week, hygiene flag fires
  // SEED-009 still slipped
}

function insertSeedRow(ins, row) {
  ins.run(
    row.id, row.opportunity_name, row.account_name, row.stage, row.forecast_category,
    row.close_date, row.filtered_opportunity_amount, row.total_opportunity_amount,
    row.opportunity_owner, row.flm_judgement, row.next_steps ?? null, null,
    row.score, row.tier
  );
}

// ── --status ─────────────────────────────────────────────────────────────────
if (isStatus) {
  const rows = db.prepare("SELECT id, opportunity_name, stage, close_date, next_steps FROM opportunities WHERE id LIKE 'SEED-%' ORDER BY id").all();
  if (rows.length === 0) { console.log('No SEED-* rows found in live pipeline.'); process.exit(0); }
  console.log(`\n${rows.length} seed opportunities in live pipeline:\n`);
  rows.forEach(r => {
    console.log(`  ${r.id}  ${r.stage.padEnd(12)}  ${r.close_date}  NS: ${r.next_steps ? r.next_steps.slice(0,40) : '(blank)'}`);
  });

  const ledger = db.prepare("SELECT snapshot_id, week_label, COUNT(*) AS n FROM baseline_ledger WHERE id LIKE 'SEED-%' GROUP BY snapshot_id ORDER BY confirmed_at DESC").all();
  console.log(`\nbaseline_ledger entries for SEED-* rows: ${ledger.length} snapshots`);
  ledger.forEach(l => console.log(`  ${l.snapshot_id.slice(0,8)}…  ${l.week_label}  (${l.n} rows)`));
  process.exit(0);
}

// ── --restore ─────────────────────────────────────────────────────────────────
if (isRestore) {
  if (isDry) {
    console.log('[DRY RUN] Would delete all SEED-* rows from opportunities and baseline_ledger.');
    process.exit(0);
  }
  const delOpps = db.prepare("DELETE FROM opportunities WHERE id LIKE 'SEED-%'").run();
  const delLedger = db.prepare("DELETE FROM baseline_ledger WHERE id LIKE 'SEED-%'").run();
  console.log(`✅ Restored: removed ${delOpps.changes} SEED rows from opportunities, ${delLedger.changes} from baseline_ledger.`);
  process.exit(0);
}

// ── Main: seed ────────────────────────────────────────────────────────────────
const existing = db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE id LIKE 'SEED-%'").get().n;
if (existing > 0 && !isDry) {
  console.log(`⚠  ${existing} SEED-* rows already exist. Run --restore first to reset.`);
  process.exit(1);
}

// Step 1: insert week 1 seed rows into live table
const ins = db.prepare(`
  INSERT OR IGNORE INTO opportunities
    (id, opportunity_name, account_name, stage, forecast_category,
     close_date, filtered_opportunity_amount, total_opportunity_amount,
     opportunity_owner, flm_judgement, next_steps, team_notes, score, tier)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

if (isDry) {
  console.log('[DRY RUN] Would insert 10 SEED-* rows into opportunities (Week 1 state).');
  console.log('[DRY RUN] Would call saveSnapshot(confirmed=true) → Week 1 confirmed baseline.');
  console.log(`[DRY RUN] Would apply week-${targetWeek} mutations to SEED-* rows.`);
  console.log('[DRY RUN] No data written.');
  process.exit(0);
}

db.transaction(() => { SEED_BASE.forEach(r => insertSeedRow(ins, r)); })();
console.log(`✅ Inserted 10 SEED-* opportunities (Week 1 state).`);

// Step 2: save confirmed Week 1 baseline
const w1date = new Date('2026-07-11T10:00:00.000Z'); // simulated last week
const snap = saveSnapshot(db, { confirmed: true, now: w1date });
console.log(`✅ Confirmed Week 1 baseline saved — ${snap.snapshotId.slice(0,8)}… (${snap.weekLabel}, ${snap.saved} opps)`);

// Step 3: apply mutations for target week
const liveSeed = SEED_BASE.map(o => ({ ...o }));
if (targetWeek >= 2) applyWeek2(liveSeed);
if (targetWeek >= 3) applyWeek3(liveSeed);

const upd = db.prepare(`
  UPDATE opportunities SET
    stage=?, forecast_category=?, close_date=?,
    filtered_opportunity_amount=?, total_opportunity_amount=?,
    next_steps=?, score=?, tier=?
  WHERE id=?
`);
db.transaction(() => {
  liveSeed.forEach(r => upd.run(
    r.stage, r.forecast_category, r.close_date,
    r.filtered_opportunity_amount, r.total_opportunity_amount,
    r.next_steps ?? null, r.score, r.tier, r.id
  ));
})();
console.log(`✅ Applied week-${targetWeek} mutations to live SEED-* rows.`);

console.log(`
────────────────────────────────────────────────────────
  Smoke test ready. In your browser (http://localhost:3090):

  1. Refresh the page — SEED-* opportunities appear in the table
  2. Click "⇄ What Changed" — should show promotions, amount changes,
     close date slip/pull-in vs. the Week 1 baseline
  3. Select some SEED-* rows and click "📊 Baseline & GM Report"
  4. Click "Generate Only" — PPT downloads, NO new baseline written
  5. Click "📊 Baseline & GM Report" again → "✅ Confirm & Generate"
     — PPT downloads AND Week ${targetWeek} baseline locked permanently

  When done: node scripts/seed-quarter.js --restore
────────────────────────────────────────────────────────
`);
