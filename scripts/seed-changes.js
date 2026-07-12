/**
 * scripts/seed-changes.js
 *
 * Simulates a week of real-world pipeline activity for UI end-to-end testing.
 *
 * WORKFLOW (full UI test cycle):
 *   1. Run app, click "📌 Save Baseline" — freezes current pipeline as baseline
 *   2. node scripts/seed-changes.js    — mutates live opportunities to simulate deal activity
 *   3. In browser, click "⇄ What Changed" — should show all 6 change types live
 *   4. Click "↓ Generate PPT" — should include "What Changed" slide
 *   5. node scripts/seed-changes.js --restore — restores original values
 *      OR just click "⟳ Refresh Data" and re-import the HAR to get real data back
 *
 * Changes applied:
 *   • 2 deals promoted (stage advanced)
 *   • 1 deal demoted  (stage regression — risk signal)
 *   • 2 deals with amount changes (≥$50k AND ≥10%)
 *   • 2 deals with slipped close dates (≥7 days later)
 *   • 1 deal pulled in (close date moved earlier)
 *   • All other deals: unchanged (tests that unchanged count is correct too)
 *
 * Usage:
 *   node scripts/seed-changes.js           # apply changes
 *   node scripts/seed-changes.js --restore # restore to original values
 *   node scripts/seed-changes.js --status  # show current vs. original for seeded rows
 */

'use strict';

const db = require('../server/db');

const args   = process.argv.slice(2);
const RESTORE = args.includes('--restore');
const STATUS  = args.includes('--status');

// ── Load 8 real rows ─────────────────────────────────────────────────────────
const rows = db.prepare('SELECT * FROM opportunities ORDER BY rowid LIMIT 8').all();
if (rows.length < 8) {
  console.error('Need at least 8 rows. Run a scrape first.');
  process.exit(1);
}

// Build the change manifest — defines both what to apply AND how to restore
const changes = [
  // [index, field,                    original value (from live),       seeded value]
  { idx: 1, field: 'stage',                    orig: rows[1].stage,                    val: '4 - Propose'  },  // promoted
  { idx: 2, field: 'stage',                    orig: rows[2].stage,                    val: '5 - Negotiate'},  // promoted
  { idx: 3, field: 'stage',                    orig: rows[3].stage,                    val: '2 - Qualify'  },  // demoted
  { idx: 4, field: 'total_opportunity_amount', orig: rows[4].total_opportunity_amount, val: rows[4].total_opportunity_amount * 1.5 }, // +50% amount up
  { idx: 5, field: 'total_opportunity_amount', orig: rows[5].total_opportunity_amount, val: Math.max(rows[5].total_opportunity_amount * 0.6, 100000) }, // -40% amount down
  { idx: 6, field: 'close_date',               orig: rows[6].close_date,               val: bumpDate(rows[6].close_date, +21) }, // slipped 3 weeks
  { idx: 7, field: 'close_date',               orig: rows[7].close_date,               val: bumpDate(rows[7].close_date, +14) }, // slipped 2 weeks
  { idx: 0, field: 'close_date',               orig: rows[0].close_date,               val: bumpDate(rows[0].close_date, -14) }, // pulled in 2 weeks
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function bumpDate(dateStr, days) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function applyChange(c, useOriginal) {
  const value = useOriginal ? c.orig : c.val;
  db.prepare(`UPDATE opportunities SET ${c.field} = ? WHERE id = ?`)
    .run(value, rows[c.idx].id);
}

function formatVal(field, val) {
  if (field === 'total_opportunity_amount') {
    return val != null ? `$${(val/1e6).toFixed(2)}M` : '—';
  }
  return val || '—';
}

// ── Status mode ──────────────────────────────────────────────────────────────
if (STATUS) {
  console.log('\n📊 Seed-changes status:\n');
  changes.forEach(c => {
    const live = db.prepare(`SELECT ${c.field} FROM opportunities WHERE id = ?`).get(rows[c.idx].id);
    const liveVal = live?.[c.field];
    const isSeeded = String(liveVal) === String(c.val);
    const isOrig   = String(liveVal) === String(c.orig);
    console.log(`  ${rows[c.idx].opportunity_name?.slice(0,30).padEnd(32)} [${c.field}]`);
    console.log(`    original: ${formatVal(c.field, c.orig)}`);
    console.log(`    seeded:   ${formatVal(c.field, c.val)}`);
    console.log(`    current:  ${formatVal(c.field, liveVal)}  ${isSeeded ? '← SEEDED' : isOrig ? '← ORIGINAL' : '← OTHER'}`);
    console.log('');
  });
  process.exit(0);
}

// ── Apply or restore ──────────────────────────────────────────────────────────
if (RESTORE) {
  db.transaction(() => changes.forEach(c => applyChange(c, true)))();
  console.log('\n✅ opportunities table restored to original values.\n');
  console.log('   Next: click "⟳ Refresh Data" or re-import your HAR to get live data.\n');
} else {
  db.transaction(() => changes.forEach(c => applyChange(c, false)))();
  console.log('\n✅ Deal changes seeded into opportunities table:\n');
  changes.forEach(c => {
    const label = c.field === 'stage'                    ? 'stage'
                : c.field === 'total_opportunity_amount' ? 'amount'
                : 'close date';
    const arrow = `${formatVal(c.field, c.orig)} → ${formatVal(c.field, c.val)}`;
    console.log(`  ${rows[c.idx].opportunity_name?.slice(0, 40).padEnd(42)}  ${label.padEnd(10)} ${arrow}`);
  });
  console.log('\n   Now in the browser:');
  console.log('   1. If you haven\'t yet → click "📌 Save Baseline" first');
  console.log('   2. Click "⇄ What Changed" to see the diff live');
  console.log('   3. Click "↓ Generate PPT" to see the "What Changed" slide');
  console.log('   4. When done: node scripts/seed-changes.js --restore\n');
}
