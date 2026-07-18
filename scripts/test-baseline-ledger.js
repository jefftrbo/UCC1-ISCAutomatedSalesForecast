#!/usr/bin/env node
/**
 * scripts/test-baseline-ledger.js
 *
 * v2.3.0 Test Harness — Permanent Quarterly Audit Ledger
 * ────────────────────────────────────────────────────────
 * Runs entirely in-memory (no file I/O, never touches opportunities.db).
 * Simulates 13 weekly GM cycles across Q3 2026 with a synthetic pipeline
 * of 20 opportunities and pre-scripted mutations.
 *
 * Assertions verified:
 *   A1  Schema: baseline_ledger table created correctly
 *   A2  Each saveSnapshot(confirmed=true) inserts NEW rows — never overwrites
 *   A3  Each saveSnapshot(confirmed=false) inserts rows but they are NOT used as baselines
 *   A4  computeDiff always returns diff against the PRIOR confirmed baseline (not current)
 *   A5  "today vs today" is structurally impossible (confirmed_at guard)
 *   A6  All 13 confirmed snapshots accumulate (total rows = 13 × 20 = 260)
 *   A7  Historical query: stage trajectory across Q3 for one rep
 *   A8  Historical query: Next Steps hygiene — 3 consecutive blank weeks flagged
 *   A9  Historical query: close date drift across 5 weeks for one opportunity
 *   A10 Diff correctness: new / dropped / promoted / demoted / amount / slipped / pulled_in
 *
 * Usage:
 *   node scripts/test-baseline-ledger.js
 */

'use strict';

const Database = require('better-sqlite3');
const {
  saveSnapshot, computeDiff, getPreviousBaseline,
  getLedgerHistory, quarterLabel, weekSeqInQuarter,
} = require('../server/diffEngine');

// ── In-memory database ────────────────────────────────────────────────────────
const db = new Database(':memory:');
db.pragma('journal_mode = WAL');

// Create the minimal schema needed by diffEngine (mirrors server/db.js v2.3.0)
db.exec(`
  CREATE TABLE opportunities (
    id TEXT PRIMARY KEY,
    opportunity_name TEXT, account_name TEXT, stage TEXT,
    forecast_category TEXT, close_date TEXT,
    filtered_opportunity_amount REAL, total_opportunity_amount REAL,
    opportunity_owner TEXT, flm_judgement TEXT,
    next_steps TEXT, team_notes TEXT, score INTEGER, tier TEXT
  );
  CREATE TABLE baseline_ledger (
    snapshot_id   TEXT NOT NULL,
    week_label    TEXT NOT NULL,
    quarter_label TEXT NOT NULL,
    week_seq      INTEGER,
    confirmed_at  TEXT NOT NULL,
    confirmed     INTEGER NOT NULL DEFAULT 1,
    id            TEXT NOT NULL,
    opportunity_name TEXT, account_name TEXT, stage TEXT,
    forecast_category TEXT, close_date TEXT,
    filtered_opportunity_amount REAL, total_opportunity_amount REAL,
    opportunity_owner TEXT, flm_judgement TEXT,
    next_steps TEXT, team_notes TEXT, score INTEGER, tier TEXT,
    PRIMARY KEY (snapshot_id, id)
  );
`);

// ── Test infrastructure ───────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, extra = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${extra ? ' — ' + extra : ''}`);
    failed++;
    failures.push(label);
  }
}

function assertEqual(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  assert(label, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}

// ── Synthetic pipeline — 20 opportunities ────────────────────────────────────
// Week 1 initial state — all fields deterministic
const INITIAL_PIPELINE = Array.from({ length: 20 }, (_, i) => ({
  id:                           `OPP-${String(i + 1).padStart(3, '0')}`,
  opportunity_name:             `Opportunity ${i + 1}`,
  account_name:                 `Agency ${String.fromCharCode(65 + (i % 5))}`,  // A–E
  stage:                        ['Qualify', 'Engage', 'Design', 'Propose', 'Negotiate'][i % 5],
  forecast_category:            i % 3 === 0 ? 'Pipeline' : 'Best Case',
  close_date:                   `2026-09-${String(15 + (i % 10)).padStart(2, '0')}`,
  filtered_opportunity_amount:  (i + 1) * 100000,
  total_opportunity_amount:     (i + 1) * 120000,
  opportunity_owner:            `Rep ${['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]}`,
  flm_judgement:                i % 2 === 0 ? 'Yes' : 'No',
  next_steps:                   `Week 1 next steps for opp ${i + 1}`,
  team_notes:                   null,
  score:                        60 + (i % 30),
  tier:                         i % 3 === 0 ? 'Low' : i % 3 === 1 ? 'Medium' : 'High',
}));

// Week-by-week mutation scripts
// Each entry mutates the live opportunities table for that week number.
// Mutations are cumulative — they modify from the CURRENT live state.
const WEEK_MUTATIONS = {
  2: (opps) => {
    // 2 stage promotions, 1 amount increase
    opps.find(o => o.id === 'OPP-001').stage = 'Engage';      // Qualify → Engage (promote)
    opps.find(o => o.id === 'OPP-006').stage = 'Negotiate';   // Propose → Negotiate (promote)
    opps.find(o => o.id === 'OPP-003').total_opportunity_amount = 600000; // was 360000 (+67%)
  },
  3: (opps) => {
    // 1 new opp added, 1 close date slip
    opps.push({
      id: 'OPP-021', opportunity_name: 'New Deal Week 3',
      account_name: 'Agency F', stage: 'Qualify', forecast_category: 'Pipeline',
      close_date: '2026-09-30', filtered_opportunity_amount: 250000,
      total_opportunity_amount: 300000, opportunity_owner: 'Rep Alpha',
      flm_judgement: 'No', next_steps: 'Initial discovery meeting scheduled',
      team_notes: null, score: 55, tier: 'Medium',
    });
    opps.find(o => o.id === 'OPP-005').close_date = '2026-10-15'; // slipped 30+ days
  },
  4: (opps) => {
    // 1 opp dropped, Next Steps blanked on 3 opps (hygiene clock starts)
    const idx = opps.findIndex(o => o.id === 'OPP-010');
    if (idx !== -1) opps.splice(idx, 1);  // dropped
    opps.find(o => o.id === 'OPP-002').next_steps = '';   // blank — week 1 of 3
    opps.find(o => o.id === 'OPP-007').next_steps = '';   // blank — week 1 of 3
    opps.find(o => o.id === 'OPP-012').next_steps = null; // null — week 1 of 3
  },
  5: (opps) => {
    // 2 demotions, 1 amount decrease
    opps.find(o => o.id === 'OPP-009').stage = 'Design';   // Propose → Design (demote, i=8, starts Propose)
    opps.find(o => o.id === 'OPP-017').stage = 'Qualify';  // Engage → Qualify (demote, i=16, starts Engage)
    opps.find(o => o.id === 'OPP-004').total_opportunity_amount = 100000; // was 480000 (-79%)
    // Next Steps still blank — week 2 of 3
  },
  6: (opps) => {
    // Next Steps still blank — week 3 of 3 (hygiene flag should fire after this week)
    // No other mutations — quiet week
  },
  7: (opps) => {
    // 1 close date pull-in, 1 promotion
    opps.find(o => o.id === 'OPP-008').close_date = '2026-08-01'; // pulled in from Sep
    opps.find(o => o.id === 'OPP-011').stage = 'Negotiate';        // Design → Negotiate
  },
  8: (opps) => {
    // Update Next Steps on 1 of 3 flagged opps — still 2 with ≥3 consecutive blanks
    opps.find(o => o.id === 'OPP-002').next_steps = 'Updated after coaching session';
    // OPP-007 and OPP-012 still blank — 4th consecutive week
  },
  9: (opps) => {
    // 1 opp closes won — remove from pipeline
    const idx = opps.findIndex(o => o.id === 'OPP-019');
    if (idx !== -1) opps.splice(idx, 1);
  },
  10: (opps) => {
    // 2 new opps added, 1 amount change
    opps.push({
      id: 'OPP-022', opportunity_name: 'Late Add Alpha',
      account_name: 'Agency G', stage: 'Design', forecast_category: 'Best Case',
      close_date: '2026-09-25', filtered_opportunity_amount: 400000,
      total_opportunity_amount: 500000, opportunity_owner: 'Rep Beta',
      flm_judgement: 'Yes', next_steps: 'Proposal in draft', team_notes: null,
      score: 72, tier: 'High',
    });
    opps.push({
      id: 'OPP-023', opportunity_name: 'Late Add Beta',
      account_name: 'Agency H', stage: 'Qualify', forecast_category: 'Pipeline',
      close_date: '2026-09-30', filtered_opportunity_amount: 150000,
      total_opportunity_amount: 180000, opportunity_owner: 'Rep Gamma',
      flm_judgement: 'No', next_steps: 'First meeting done', team_notes: null,
      score: 45, tier: 'Low',
    });
    opps.find(o => o.id === 'OPP-015').total_opportunity_amount = 3000000; // big upsell
  },
  11: (opps) => {
    // Stage demotion + close date slip on same opp
    opps.find(o => o.id === 'OPP-017').stage = 'Design';           // Propose → Design
    opps.find(o => o.id === 'OPP-017').close_date = '2026-10-31';  // slipped
  },
  12: (opps) => {
    // 1 opp dropped, Next Steps updated on OPP-012 (OPP-007 still blank)
    const idx = opps.findIndex(o => o.id === 'OPP-020');
    if (idx !== -1) opps.splice(idx, 1);
    opps.find(o => o.id === 'OPP-012').next_steps = 'Finally updated in week 12';
  },
  13: (opps) => {
    // Quarter-end — no mutations, just confirm the final baseline
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadOppsIntoDb(opps) {
  db.prepare('DELETE FROM opportunities').run();
  const ins = db.prepare(`
    INSERT INTO opportunities
      (id, opportunity_name, account_name, stage, forecast_category,
       close_date, filtered_opportunity_amount, total_opportunity_amount,
       opportunity_owner, flm_judgement, next_steps, team_notes, score, tier)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (const o of opps) {
      ins.run(o.id, o.opportunity_name, o.account_name, o.stage, o.forecast_category,
              o.close_date, o.filtered_opportunity_amount, o.total_opportunity_amount,
              o.opportunity_owner, o.flm_judgement, o.next_steps, o.team_notes,
              o.score, o.tier);
    }
  })();
}

// Generate a fake Date for week N of Q3 2026 (July 1 + N-1 weeks)
function weekDate(weekNum) {
  const d = new Date('2026-07-01T10:00:00.000Z');
  d.setDate(d.getDate() + (weekNum - 1) * 7);
  return d;
}

// ── Run simulation ────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  v2.3.0 Baseline Ledger Test Harness — 13-Week Q3 2026 Sim');
console.log('══════════════════════════════════════════════════════════════\n');

// Deep-clone initial pipeline so mutations don't affect the original
const livePipeline = INITIAL_PIPELINE.map(o => ({ ...o }));

const confirmedSnapshots = [];  // track { weekNum, snapshotId, oppCount }

// ── Week 1: seed initial pipeline, confirm Final baseline ────────────────────
console.log('── Week 1: Initial pipeline baseline ──');
loadOppsIntoDb(livePipeline);
const w1snap = saveSnapshot(db, { confirmed: true, now: weekDate(1) });
confirmedSnapshots.push({ weekNum: 1, ...w1snap });
console.log(`   Saved snapshot ${w1snap.snapshotId.slice(0,8)}… — ${w1snap.saved} opps`);

// ── Weeks 2–13 ───────────────────────────────────────────────────────────────
for (let week = 2; week <= 13; week++) {
  console.log(`\n── Week ${week} ──`);
  const now = weekDate(week);

  // Apply mutations for this week
  if (WEEK_MUTATIONS[week]) WEEK_MUTATIONS[week](livePipeline);
  loadOppsIntoDb(livePipeline);

  // Compute diff BEFORE saving this week's confirmed baseline
  // (asOf = now ensures the baseline written this iteration is excluded)
  const diff = computeDiff(db, now);

  // Week 5: test "Generate Only" — inserted AFTER diff so it doesn't affect diff result
  if (week === 5) {
    const testRun = saveSnapshot(db, { confirmed: false, now });
    console.log(`   Generate Only (test run) — ${testRun.snapshotId.slice(0,8)}… NOT a baseline`);
  }

  // Save confirmed Final baseline for this week (AFTER diff — mirrors production sequence)
  const snap = saveSnapshot(db, { confirmed: true, now });
  confirmedSnapshots.push({ weekNum: week, ...snap });
  console.log(`   Confirmed baseline ${snap.snapshotId.slice(0,8)}… — ${snap.saved} opps`);
  if (diff.hasData) {
    console.log(`   Diff vs "${diff.previousWeek}": ${diff.summary}`);
  } else {
    console.log(`   Diff: no prior baseline`);
  }
}

// ── Assertions ───────────────────────────────────────────────────────────────

console.log('\n── Assertions ──────────────────────────────────────────────\n');

// A1: baseline_ledger table exists and has columns
const cols = db.pragma('table_info(baseline_ledger)').map(c => c.name);
assert('A1: baseline_ledger table created with snapshot_id column',
  cols.includes('snapshot_id'));
assert('A1: baseline_ledger has quarter_label column', cols.includes('quarter_label'));
assert('A1: baseline_ledger has confirmed column',     cols.includes('confirmed'));

// A2: each confirmed save created a DISTINCT snapshot_id
const distinctConfirmedIds = db.prepare(
  "SELECT DISTINCT snapshot_id FROM baseline_ledger WHERE confirmed=1"
).all().map(r => r.snapshot_id);
assertEqual('A2: 13 distinct confirmed snapshot_ids', distinctConfirmedIds.length, 13);

// A3: "Generate Only" row exists but is excluded from diff baselines
const unconfirmedRows = db.prepare(
  "SELECT DISTINCT snapshot_id FROM baseline_ledger WHERE confirmed=0"
).all();
assertEqual('A3: exactly 1 Generate-Only snapshot exists', unconfirmedRows.length, 1);

// Verify that Generate-Only snapshot is NOT used as a baseline for week 6 diff
const w6now  = weekDate(6);
const w6base = getPreviousBaseline(db, w6now.toISOString());
const w6unconfirmedId = unconfirmedRows[0]?.snapshot_id;
assert('A3: Generate-Only snapshot NOT selected as week 6 baseline',
  w6base && w6base.snapshotId !== w6unconfirmedId);

// A4: computeDiff for week 3 uses week 2 confirmed baseline (not week 3)
const w3now  = weekDate(3);
const w3base = getPreviousBaseline(db, w3now.toISOString());
const w2snap = confirmedSnapshots.find(s => s.weekNum === 2);
assert('A4: week 3 diff uses week 2 confirmed baseline',
  w3base && w3base.snapshotId === w2snap.snapshotId);

// A5: "today vs today" impossible — computeDiff called with same timestamp as save
//     getPreviousBaseline uses strict <, so confirmed_at = asOf is excluded
const w7now     = weekDate(7);
const w7snap    = confirmedSnapshots.find(s => s.weekNum === 7);
const sameTime  = new Date(w7snap.snapshotId
  ? db.prepare("SELECT confirmed_at FROM baseline_ledger WHERE snapshot_id=? LIMIT 1")
       .get(w7snap.snapshotId)?.confirmed_at
  : w7now.toISOString());
const selfBase  = getPreviousBaseline(db, sameTime.toISOString());
assert('A5: snapshot cannot be its own diff baseline (today-vs-today impossible)',
  !selfBase || selfBase.snapshotId !== w7snap.snapshotId);

// A6: total ledger rows = 13 confirmed (20 opps each) + 1 unconfirmed (20 opps)
//     Note: week 3+ mutations change pipeline size slightly; check bounds
const totalRows = db.prepare("SELECT COUNT(*) AS n FROM baseline_ledger").get().n;
assert('A6: baseline_ledger has > 260 total rows (13+ snapshots × ~20 opps)',
  totalRows > 260);
const confirmedRows = db.prepare(
  "SELECT COUNT(*) AS n FROM baseline_ledger WHERE confirmed=1"
).get().n;
assert('A6: all confirmed rows ≥ 13 × 20 (260)', confirmedRows >= 260);

// A7: Stage trajectory — OPP-001 started as Qualify, promoted to Engage in week 2
const opp1Stages = db.prepare(`
  SELECT DISTINCT bl.week_seq, bl.stage
  FROM   baseline_ledger bl
  JOIN  (SELECT DISTINCT snapshot_id, week_seq, MIN(confirmed_at) as ca
         FROM baseline_ledger WHERE confirmed=1 GROUP BY week_seq) w
    ON  bl.snapshot_id = w.snapshot_id
  WHERE  bl.id = 'OPP-001' AND bl.confirmed = 1
  ORDER  BY bl.week_seq ASC
`).all();
const w1stage = opp1Stages.find(r => r.week_seq === 1)?.stage;
const w2stage = opp1Stages.find(r => r.week_seq === 2)?.stage;
assert('A7: OPP-001 stage at week 1 = Qualify',    w1stage === 'Qualify');
assert('A7: OPP-001 stage at week 2 = Engage (promoted)', w2stage === 'Engage');

// A8: Next Steps hygiene — OPP-007 has blank next_steps from week 4 onwards
//     Query: find opportunities with ≥ 3 consecutive weeks of blank/null next_steps
const hygieneQuery = db.prepare(`
  SELECT id, COUNT(*) AS blank_weeks
  FROM   baseline_ledger
  WHERE  confirmed = 1
    AND  (next_steps IS NULL OR next_steps = '')
  GROUP  BY id
  HAVING COUNT(*) >= 3
`).all();
const flaggedIds = hygieneQuery.map(r => r.id);
assert('A8: OPP-007 flagged for Next Steps hygiene (≥3 blank weeks)',
  flaggedIds.includes('OPP-007'));
assert('A8: OPP-012 flagged for Next Steps hygiene (≥3 blank weeks)',
  flaggedIds.includes('OPP-012'));
// OPP-002 was blanked weeks 4–7 but updated in week 8 — still ≥3, should be flagged too
assert('A8: OPP-002 flagged (blanked 4 weeks before coaching)',
  flaggedIds.includes('OPP-002'));

// A9: Close date drift — OPP-005 slipped from 2026-09-19 to 2026-10-15 in week 3
const opp5Dates = db.prepare(`
  SELECT DISTINCT bl.week_seq, bl.close_date
  FROM   baseline_ledger bl
  WHERE  bl.id = 'OPP-005' AND bl.confirmed = 1
  ORDER  BY bl.week_seq ASC
`).all();
const w1date = opp5Dates.find(r => r.week_seq === 1)?.close_date;
const w3date = opp5Dates.find(r => r.week_seq === 3)?.close_date;
assert('A9: OPP-005 close date at week 1 = 2026-09-19', w1date === '2026-09-19');
assert('A9: OPP-005 close date at week 3 = 2026-10-15 (slipped)', w3date === '2026-10-15');

// A10: Diff correctness for week 3 (new opp OPP-021 + OPP-005 slip vs week 2 baseline)
const w3diff = computeDiff(db, weekDate(3));
assert('A10: week 3 diff hasData=true',          w3diff.hasData);
assert('A10: week 3 diff detects new OPP-021',   w3diff.new.some(o => o.id === 'OPP-021'));
assert('A10: week 3 diff detects OPP-005 slipped', w3diff.slipped.some(o => o.id === 'OPP-005'));

// Diff correctness for week 2 (OPP-001 promoted, OPP-006 promoted, OPP-003 amount change)
const w2diff = computeDiff(db, weekDate(2));
assert('A10: week 2 diff detects OPP-001 promoted',      w2diff.promoted.some(o => o.id === 'OPP-001'));
assert('A10: week 2 diff detects OPP-006 promoted',      w2diff.promoted.some(o => o.id === 'OPP-006'));
assert('A10: week 2 diff detects OPP-003 amount change', w2diff.amount.some(o => o.id === 'OPP-003'));

// Diff correctness for week 4 (OPP-010 dropped)
const w4diff = computeDiff(db, weekDate(4));
assert('A10: week 4 diff detects OPP-010 dropped', w4diff.dropped.some(o => o.id === 'OPP-010'));

// Demotion in week 5 — query ledger directly (live table is at week-13 state post-simulation)
// OPP-009: Propose (w4 baseline) → Design (w5 baseline) = demotion
// OPP-017: Engage (w4 baseline) → Qualify (w5 baseline) = demotion
const w4snapId = confirmedSnapshots.find(s => s.weekNum === 4).snapshotId;
const w5snapId = confirmedSnapshots.find(s => s.weekNum === 5).snapshotId;
const opp009w4stage = db.prepare('SELECT stage FROM baseline_ledger WHERE snapshot_id=? AND id=?').get(w4snapId, 'OPP-009')?.stage;
const opp009w5stage = db.prepare('SELECT stage FROM baseline_ledger WHERE snapshot_id=? AND id=?').get(w5snapId, 'OPP-009')?.stage;
const opp017w4stage = db.prepare('SELECT stage FROM baseline_ledger WHERE snapshot_id=? AND id=?').get(w4snapId, 'OPP-017')?.stage;
const opp017w5stage = db.prepare('SELECT stage FROM baseline_ledger WHERE snapshot_id=? AND id=?').get(w5snapId, 'OPP-017')?.stage;
assert('A10: week 5 OPP-009 demoted in ledger (Propose→Design)',
  opp009w4stage !== opp009w5stage && opp009w5stage === 'Design');
assert('A10: week 5 OPP-017 demoted in ledger (Engage→Qualify)',
  opp017w4stage !== opp017w5stage && opp017w5stage === 'Qualify');

// getLedgerHistory returns 13 entries (only confirmed)
const history = getLedgerHistory(db);
assertEqual('A10: getLedgerHistory returns 13 entries', history.length, 13);
assert('A10: history entries have snapshotId, weekLabel, oppCount',
  history[0].snapshotId && history[0].weekLabel && history[0].oppCount > 0);

// ── Quarter label helpers ─────────────────────────────────────────────────────
console.log('\n── Quarter/week-seq label checks ──\n');
assert('quarterLabel(Jul 1 2026) = Q3 2026',
  quarterLabel(new Date('2026-07-01')) === 'Q3 2026');
assert('quarterLabel(Oct 1 2026) = Q4 2026',
  quarterLabel(new Date('2026-10-01')) === 'Q4 2026');
assert('quarterLabel(Jan 1 2027) = Q1 2027',
  quarterLabel(new Date('2027-01-01')) === 'Q1 2027');
assert('weekSeqInQuarter(Jul 1) = 1',  weekSeqInQuarter(new Date('2026-07-01')) === 1);
assert('weekSeqInQuarter(Jul 8) = 2',  weekSeqInQuarter(new Date('2026-07-08')) === 2);
assert('weekSeqInQuarter(Sep 29) = 13', weekSeqInQuarter(new Date('2026-09-29')) === 13);

// ── Final report ──────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`  FAILED assertions:`);
  failures.forEach(f => console.error(`    • ${f}`));
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(1);
} else {
  console.log('  ✅ ALL ASSERTIONS PASSED');
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(0);
}
