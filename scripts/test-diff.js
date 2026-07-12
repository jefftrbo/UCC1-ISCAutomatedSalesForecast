/**
 * scripts/test-diff.js
 *
 * Unit test for the week-over-week diff engine (revised design).
 *
 * DESIGN UNDER TEST:
 *   "Previous" = a snapshot saved to the `snapshots` table (the frozen baseline).
 *   "Current"  = the live `opportunities` table as it stands right now.
 *
 * TEST APPROACH:
 *   1. Save the current state of 8 real opportunities to a test snapshot
 *      (week_label = "TEST-W01").
 *   2. Mutate those 8 rows directly in the `opportunities` table to simulate
 *      a week of deal activity (stage changes, amount changes, date slips, etc.).
 *   3. Run computeDiff() — it reads live `opportunities` vs. the TEST-W01 snapshot.
 *   4. Assert all 8 change categories are detected correctly.
 *   5. RESTORE the original values to the `opportunities` table so nothing is
 *      permanently changed.
 *   6. DELETE the TEST-W01 snapshot rows.
 *
 * The real 2026-W28 (or any prior real) snapshot is NOT touched.
 * The opportunities table is left exactly as it was before the test ran.
 *
 * Usage:
 *   node scripts/test-diff.js
 */

'use strict';

const db              = require('../server/db');
const { saveSnapshot, computeDiff } = require('../server/diffEngine');

// ── Grab 8 real rows to work with ────────────────────────────────────────────
const liveRows = db.prepare('SELECT * FROM opportunities ORDER BY rowid LIMIT 8').all();
if (liveRows.length < 8) {
  console.error('Need at least 8 opportunity rows in DB. Run a scrape first.');
  process.exit(1);
}

const [r0, r1, r2, r3, r4, r5, r6, r7] = liveRows;

// ── Step 1: Save a synthetic baseline snapshot (TEST-W01) ─────────────────────
// We insert only the 8 test rows directly into snapshots using the test label,
// rather than calling saveSnapshot() which would snapshot ALL 206 rows and
// overwrite the real 2026-W28 snapshot.
const TEST_WEEK = 'TEST-W01';
const NOW       = new Date().toISOString();

const insertSnap = db.prepare(`
  INSERT OR REPLACE INTO snapshots
    (id, week_label, snapped_at,
     opportunity_name, account_name, stage, forecast_category,
     close_date, filtered_opportunity_amount, total_opportunity_amount,
     opportunity_owner, flm_judgement, next_steps)
  VALUES (?,?,?, ?,?,?,?, ?,?,?, ?,?,?)
`);

// ── Snapshot ALL 206 rows at their current live values ───────────────────────
// This is the baseline: "what the pipeline looked like at the GM call."
// We then mutate 8 specific rows in the live table to simulate the week's changes.
// The diff engine will compare live (mutated) vs TEST-W01 (frozen baseline).
const allRows = db.prepare('SELECT * FROM opportunities').all();
db.transaction(() => {
  for (const r of allRows) {
    insertSnap.run(r.id, TEST_WEEK, NOW,
      r.opportunity_name, r.account_name, r.stage, r.forecast_category,
      r.close_date, r.filtered_opportunity_amount, r.total_opportunity_amount,
      r.opportunity_owner, r.flm_judgement, r.next_steps);
  }
})();

// ── Then patch the baseline for our 8 test rows to set up the expected diffs ──
// r0: baseline = live (no change → unchanged)
// r1: baseline stage = Qualify  (live will be promoted to Propose)
// r2: baseline stage = Propose  (live will be demoted to Qualify)
// r3: baseline amount = $1M     (live will be $2M → amount change)
// r4: baseline close = 2026-07-01 (live will be 2026-08-15 → slipped)
// r5: baseline close = 2026-09-30 (live will be 2026-08-31 → pulled in)
// r6: baseline = live            (live will be deleted → dropped)
// r7: delete from baseline       (still in live → new)
db.transaction(() => {
  insertSnap.run(r1.id, TEST_WEEK, NOW, r1.opportunity_name, r1.account_name, '2 - Qualify',  r1.forecast_category, r1.close_date, r1.filtered_opportunity_amount, r1.total_opportunity_amount, r1.opportunity_owner, r1.flm_judgement, r1.next_steps);
  insertSnap.run(r2.id, TEST_WEEK, NOW, r2.opportunity_name, r2.account_name, '4 - Propose',  r2.forecast_category, r2.close_date, r2.filtered_opportunity_amount, r2.total_opportunity_amount, r2.opportunity_owner, r2.flm_judgement, r2.next_steps);
  insertSnap.run(r3.id, TEST_WEEK, NOW, r3.opportunity_name, r3.account_name, r3.stage, r3.forecast_category, r3.close_date, r3.filtered_opportunity_amount, 1_000_000, r3.opportunity_owner, r3.flm_judgement, r3.next_steps);
  insertSnap.run(r4.id, TEST_WEEK, NOW, r4.opportunity_name, r4.account_name, r4.stage, r4.forecast_category, '2026-07-01', r4.filtered_opportunity_amount, r4.total_opportunity_amount, r4.opportunity_owner, r4.flm_judgement, r4.next_steps);
  insertSnap.run(r5.id, TEST_WEEK, NOW, r5.opportunity_name, r5.account_name, r5.stage, r5.forecast_category, '2026-09-30', r5.filtered_opportunity_amount, r5.total_opportunity_amount, r5.opportunity_owner, r5.flm_judgement, r5.next_steps);
  // r7: remove from baseline so it looks "new" in live
  db.prepare('DELETE FROM snapshots WHERE id = ? AND week_label = ?').run(r7.id, TEST_WEEK);
})();

// ── Step 2: Mutate live opportunities to simulate "this week's changes" ───────
const updateOpp = db.prepare(
  'UPDATE opportunities SET stage=?, total_opportunity_amount=?, close_date=? WHERE id=?'
);

// Save originals so we can restore them later
const originals = liveRows.map(r => ({
  id:                       r.id,
  stage:                    r.stage,
  total_opportunity_amount: r.total_opportunity_amount,
  close_date:               r.close_date,
}));

db.transaction(() => {
  // r1 promoted: stage → Propose
  updateOpp.run('4 - Propose', r1.total_opportunity_amount, r1.close_date, r1.id);
  // r2 demoted: stage → Qualify
  updateOpp.run('2 - Qualify', r2.total_opportunity_amount, r2.close_date, r2.id);
  // r3 amount up: $1M → $2M
  updateOpp.run(r3.stage, 2_000_000, r3.close_date, r3.id);
  // r4 slipped: close date pushed out 45 days
  updateOpp.run(r4.stage, r4.total_opportunity_amount, '2026-08-15', r4.id);
  // r5 pulled in: close date moved earlier 30 days
  updateOpp.run(r5.stage, r5.total_opportunity_amount, '2026-08-31', r5.id);
  // r6 "dropped": delete from live opportunities
  db.prepare('DELETE FROM opportunities WHERE id = ?').run(r6.id);
  // r7 is already in live (was in DB, just not in snapshot) → "new"
  // r0 unchanged — no mutation needed
})();

// ── Step 3: Run computeDiff() — the baseline is TEST-W01, current is live ─────
// We need to temporarily ensure computeDiff picks up TEST-W01, not 2026-W28.
// Since computeDiff picks the MOST RECENT snapshot label alphabetically,
// TEST-W01 sorts AFTER 2026-W28 alphabetically (T > 2), so it will be chosen
// correctly as the baseline.
const diff = computeDiff(db);

// ── Step 4: Assert results ────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  DIFF ENGINE TEST RESULTS (revised design)');
console.log('══════════════════════════════════════════');
console.log(`  Current: ${diff.currentWeek}  |  Baseline: ${diff.previousWeek}`);
console.log(`  hasData: ${diff.hasData}`);
console.log('──────────────────────────────────────────');

// unchanged = all rows in both baseline and live that weren't mutated.
// That's: total live rows - 1 deleted (dropped) - mutated ones that changed category
// = allRows.length - 1 (r6 deleted) - 6 (r1,r2,r3,r4,r5 changed + r7 "new" but r7 is in live not baseline so not in unchanged)
// Simpler: allRows.length - 7 (r1 promoted, r2 demoted, r3 amount, r4 slipped, r5 pulled_in, r6 dropped, r7 new)
const expectedUnchanged = allRows.length - 7;

const assertions = [
  { key: 'new',       label: 'New',         expect: 1                },
  { key: 'dropped',   label: 'Dropped',     expect: 1                },
  { key: 'promoted',  label: 'Promoted',    expect: 1                },
  { key: 'demoted',   label: 'Demoted',     expect: 1                },
  { key: 'amount',    label: 'Amt Changed', expect: 1                },
  { key: 'slipped',   label: 'Slipped',     expect: 1                },
  { key: 'pulled_in', label: 'Pulled In',   expect: 1                },
  { key: 'unchanged', label: 'Unchanged',   expect: expectedUnchanged },
];

let passed = 0, failed = 0;
assertions.forEach(({ key, label, expect }) => {
  const actual = diff[key]?.length ?? 0;
  const ok = actual === expect;
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(14)} expected=${expect}  got=${actual}`);
  if (!ok) {
    console.log(`       Keys in diff.${key}:`, JSON.stringify(diff[key]?.map(r => r.opportunity_name || r.id)));
  }
});

console.log('──────────────────────────────────────────');
console.log(`  Summary: ${diff.summary}`);
console.log('──────────────────────────────────────────');
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

// ── Step 5: Restore opportunities table ──────────────────────────────────────
const restore = db.prepare(
  'UPDATE opportunities SET stage=?, total_opportunity_amount=?, close_date=? WHERE id=?'
);
db.transaction(() => {
  originals.forEach(o => restore.run(o.stage, o.total_opportunity_amount, o.close_date, o.id));
  // Re-insert r6 which was deleted
  const cols = Object.keys(r6).filter(k => k !== 'rowid');
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT OR REPLACE INTO opportunities (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map(k => r6[k]));
})();

// ── Step 6: Clean up test snapshot ───────────────────────────────────────────
db.prepare('DELETE FROM snapshots WHERE week_label = ?').run(TEST_WEEK);
console.log('  opportunities table restored to original state.');
console.log('  TEST-W01 snapshot cleaned up.\n');
