/**
 * scripts/test-diff.js
 *
 * Unit test for the week-over-week diff engine.
 * Seeds two synthetic week_labels into the snapshots table using REAL
 * opportunity IDs from the live DB, then exercises all 7 change categories:
 *
 *   new       — deal present this week, absent last week
 *   dropped   — deal present last week, absent this week
 *   promoted  — stage moved forward
 *   demoted   — stage moved backward
 *   amount    — total_opportunity_amount changed ≥ $50k AND ≥ 10%
 *   slipped   — close_date pushed out ≥ 7 days
 *   pulled_in — close_date moved earlier ≥ 7 days
 *   unchanged — no tracked fields changed
 *
 * Usage:
 *   node scripts/test-diff.js
 *
 * The script ONLY writes to the snapshots table under synthetic week_labels
 * ("TEST-W01" and "TEST-W02"). It cleans up after itself.
 * It does NOT touch the real 2026-W28 snapshot or the opportunities table.
 */

'use strict';

const db             = require('../server/db');
const { computeDiff } = require('../server/diffEngine');

// ── Synthetic week labels — never clash with real ISO weeks ──────────────────
const PREV_WEEK = 'TEST-W01';
const CURR_WEEK = 'TEST-W02';
const NOW       = new Date().toISOString();

// ── Real IDs from the live DB (first 8 rows) ─────────────────────────────────
// We borrow real IDs so FK-style assumptions are never an issue.
const liveRows = db.prepare('SELECT * FROM opportunities ORDER BY rowid LIMIT 8').all();
if (liveRows.length < 8) {
  console.error('Need at least 8 opportunity rows in the DB. Run a scrape first.');
  process.exit(1);
}

const [r0, r1, r2, r3, r4, r5, r6, r7] = liveRows;

// ── Helpers ───────────────────────────────────────────────────────────────────
const insert = db.prepare(`
  INSERT OR REPLACE INTO snapshots
    (id, week_label, snapped_at,
     opportunity_name, account_name, stage, forecast_category,
     close_date, filtered_opportunity_amount, total_opportunity_amount,
     opportunity_owner, flm_judgement, next_steps)
  VALUES (?,?,?, ?,?,?,?, ?,?,?, ?,?,?)
`);

function snap(weekLabel, row) {
  insert.run(
    row.id, weekLabel, NOW,
    row.opportunity_name, row.account_name, row.stage, row.forecast_category,
    row.close_date, row.filtered_opportunity_amount, row.total_opportunity_amount,
    row.opportunity_owner, row.flm_judgement, row.next_steps
  );
}

function cleanup() {
  db.prepare("DELETE FROM snapshots WHERE week_label IN (?, ?)").run(PREV_WEEK, CURR_WEEK);
}

// ── Seed: build PREV_WEEK (baseline) ─────────────────────────────────────────
// r0 → unchanged
// r1 → will be promoted   (stage advance)
// r2 → will be demoted    (stage regression)
// r3 → will have amount change
// r4 → will be slipped    (close date pushed)
// r5 → will be pulled_in  (close date moved earlier)
// r6 → will be dropped    (present in PREV, absent in CURR)
// r7 → will be "new"      (absent in PREV, present in CURR)

db.transaction(() => {
  snap(PREV_WEEK, r0);  // unchanged

  snap(PREV_WEEK, { ...r1, stage: '2 - Qualify' });   // prev stage
  snap(PREV_WEEK, { ...r2, stage: '4 - Propose' });   // prev stage (will go back)

  snap(PREV_WEEK, { ...r3, total_opportunity_amount: 1_000_000 });  // prev amount

  snap(PREV_WEEK, { ...r4, close_date: '2026-07-01' });  // will slip
  snap(PREV_WEEK, { ...r5, close_date: '2026-09-30' });  // will pull in

  snap(PREV_WEEK, r6);  // will be dropped (not in CURR)
  // r7 NOT added to PREV — will appear as "new" in CURR
})();

// ── Seed: build CURR_WEEK (this week's state) ─────────────────────────────────
db.transaction(() => {
  snap(CURR_WEEK, r0);  // unchanged (same data)

  snap(CURR_WEEK, { ...r1, stage: '4 - Propose' });   // promoted: Qualify → Propose
  snap(CURR_WEEK, { ...r2, stage: '2 - Qualify' });   // demoted: Propose → Qualify

  snap(CURR_WEEK, { ...r3, total_opportunity_amount: 2_000_000 });  // +$1M (100% — above both thresholds)

  snap(CURR_WEEK, { ...r4, close_date: '2026-08-15' });  // slipped 45 days
  snap(CURR_WEEK, { ...r5, close_date: '2026-08-31' });  // pulled in 30 days

  // r6 NOT added to CURR — dropped
  snap(CURR_WEEK, r7);  // new — wasn't in PREV
})();

// ── Run computeDiff ───────────────────────────────────────────────────────────
const diff = computeDiff(db);

// ── Print results ─────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  DIFF ENGINE TEST RESULTS');
console.log('══════════════════════════════════════════');
console.log(`  ${diff.previousWeek} → ${diff.currentWeek}`);
console.log(`  hasData: ${diff.hasData}`);
console.log('──────────────────────────────────────────');

const categories = [
  { key: 'new',       label: 'New',          expect: 1 },
  { key: 'dropped',   label: 'Dropped',      expect: 1 },
  { key: 'promoted',  label: 'Promoted',     expect: 1 },
  { key: 'demoted',   label: 'Demoted',      expect: 1 },
  { key: 'amount',    label: 'Amt Changed',  expect: 1 },
  { key: 'slipped',   label: 'Slipped',      expect: 1 },
  { key: 'pulled_in', label: 'Pulled In',    expect: 1 },
  { key: 'unchanged', label: 'Unchanged',    expect: 1 },
];

let passed = 0;
let failed = 0;

categories.forEach(({ key, label, expect }) => {
  const actual = diff[key]?.length ?? 0;
  const ok = actual === expect;
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(14)} expected=${expect}  got=${actual}`);
  if (!ok && diff[key]?.length > 0) {
    diff[key].forEach(r => console.log(`       → ${r.opportunity_name} (${r.id})`));
  }
});

console.log('──────────────────────────────────────────');
console.log(`  Summary: ${diff.summary}`);
console.log('──────────────────────────────────────────');

// Detail for each category
if (diff.promoted.length)  console.log(`  Promoted:  ${diff.promoted[0].opportunity_name}  ${diff.promoted[0].prevStage} → ${diff.promoted[0].curStage}`);
if (diff.demoted.length)   console.log(`  Demoted:   ${diff.demoted[0].opportunity_name}  ${diff.demoted[0].prevStage} → ${diff.demoted[0].curStage}`);
if (diff.amount.length)    console.log(`  Amount:    ${diff.amount[0].opportunity_name}  $${(diff.amount[0].prevAmt/1e6).toFixed(2)}M → $${(diff.amount[0].curAmt/1e6).toFixed(2)}M`);
if (diff.slipped.length)   console.log(`  Slipped:   ${diff.slipped[0].opportunity_name}  ${diff.slipped[0].prevCloseDate} → ${diff.slipped[0].curCloseDate} (+${diff.slipped[0].daysDiff}d)`);
if (diff.pulled_in.length) console.log(`  Pulled In: ${diff.pulled_in[0].opportunity_name}  ${diff.pulled_in[0].prevCloseDate} → ${diff.pulled_in[0].curCloseDate} (${diff.pulled_in[0].daysDiff}d)`);
if (diff.new.length)       console.log(`  New:       ${diff.new[0].opportunity_name}`);
if (diff.dropped.length)   console.log(`  Dropped:   ${diff.dropped[0].opportunity_name}`);
if (diff.unchanged.length) console.log(`  Unchanged: ${diff.unchanged[0].opportunity_name}`);

console.log('──────────────────────────────────────────');
console.log(`  RESULT: ${failed === 0 ? '✅ ALL ' + passed + ' TESTS PASSED' : '❌ ' + failed + ' FAILED, ' + passed + ' passed'}`);
console.log('══════════════════════════════════════════\n');

// ── Cleanup — remove synthetic test rows ─────────────────────────────────────
cleanup();
console.log('  Synthetic test data cleaned up (TEST-W01, TEST-W02 removed).\n');
