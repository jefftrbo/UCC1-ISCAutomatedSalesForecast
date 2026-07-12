/**
 * server/diffEngine.js
 *
 * Week-over-week diff engine for the ISC Automated Sales Forecast app (v2.1.0).
 *
 * DESIGN (revised):
 *   "Previous" = the most-recent snapshot in the `snapshots` table (frozen baseline
 *                saved deliberately by the user via "📌 Save Baseline" after the GM call).
 *   "Current"  = the live `opportunities` table as it stands right now.
 *
 *   This means Dushyant can refresh the pipeline as many times as he wants during
 *   the week (high-velocity deals updating frequently) and "⇄ What Changed" always
 *   shows: "here is what is different RIGHT NOW vs. the last time we held a GM call."
 *
 *   saveSnapshot(db)
 *     Freezes the current `opportunities` table as the new baseline, tagged with
 *     the current ISO week label (e.g. "2026-W29").
 *     Uses INSERT OR REPLACE — calling it multiple times in the same week
 *     intentionally OVERWRITES the prior snapshot for that week, so the baseline
 *     always reflects the pipeline at the moment "Save Baseline" was clicked.
 *     (Typically called once after the Friday GM call.)
 *
 *   computeDiff(db)
 *     Compares the most-recent snapshot (previous/baseline) against the live
 *     `opportunities` table (current). Returns a structured diff object.
 *
 * Diff categories returned:
 *   new       — in live opportunities, not in the baseline snapshot
 *   dropped   — in the baseline snapshot, not in live opportunities
 *   promoted  — stage moved forward (e.g. Qualify → Propose)
 *   demoted   — stage moved backward (e.g. Propose → Qualify)
 *   amount    — total_opportunity_amount changed by ≥ $50k AND ≥ 10%
 *   slipped   — close_date pushed out by ≥ 7 days
 *   pulled_in — close_date moved earlier by ≥ 7 days
 *   unchanged — no tracked fields changed
 */

'use strict';

// ---------------------------------------------------------------------------
// Stage ordering — used to determine promotion vs demotion
// Higher index = further along in the sales cycle.
// ---------------------------------------------------------------------------
const STAGE_ORDER = [
  'Identify',
  'Qualify',
  'Engage',
  'Design',
  'Propose',
  'Negotiate',
  'Closing',
  'Closed Won',
  'Closed Lost',
];

function stageIndex(stage) {
  if (!stage) return -1;
  const norm = stage.trim();
  const idx = STAGE_ORDER.findIndex(s => norm.toLowerCase().includes(s.toLowerCase()));
  return idx === -1 ? 0 : idx;
}

/**
 * Returns a human-readable timestamp label, e.g. "Jul 13, 2026 · 2:34 PM".
 * Used as the snapshot label — timestamp-based so multiple saves in the same
 * week are distinct and the diff engine always uses the most-recent one.
 * @param {Date} [date]
 * @returns {string}
 */
function snapshotLabel(date = new Date()) {
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${datePart} · ${timePart}`;
}

// Keep isoWeekLabel exported for test scripts that still use it
function isoWeekLabel(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// saveSnapshot — called by Step 5 "Baseline & Generate GM Report"
// ---------------------------------------------------------------------------
/**
 * Freeze the current opportunities table as the new baseline snapshot.
 *
 * Uses a timestamp-based label (e.g. "Jul 13, 2026 · 2:34 PM") so multiple
 * saves in the same week are always distinct. The diff engine orders by
 * snapped_at DESC so the most-recent snapshot is always the baseline,
 * regardless of when during the week it was saved.
 *
 * Primary usage: automatically called when Dushyant clicks
 * "📊 Baseline & Generate GM Report" (Step 5).
 * Secondary usage: manual override via the utility "📌 Save Baseline" button.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ weekLabel: string, saved: number }}
 */
function saveSnapshot(db) {
  const weekLabel = snapshotLabel();   // timestamp label, not ISO week
  const snappedAt = new Date().toISOString();

  const rows = db.prepare('SELECT * FROM opportunities').all();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO snapshots
      (id, week_label, snapped_at,
       opportunity_name, account_name, stage, forecast_category,
       close_date, filtered_opportunity_amount, total_opportunity_amount,
       opportunity_owner, flm_judgement, next_steps,
       score, tier)
    VALUES
      (?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?)
  `);

  db.transaction(() => {
    for (const r of rows) {
      insert.run(
        r.id, weekLabel, snappedAt,
        r.opportunity_name, r.account_name, r.stage, r.forecast_category,
        r.close_date, r.filtered_opportunity_amount, r.total_opportunity_amount,
        r.opportunity_owner, r.flm_judgement, r.next_steps,
        r.score ?? null, r.tier ?? null
      );
    }
  })();

  return { weekLabel, saved: rows.length };
}

// ---------------------------------------------------------------------------
// computeDiff — live opportunities vs. most-recent snapshot
// ---------------------------------------------------------------------------
/**
 * Compare the live opportunities table (current) against the most-recent
 * snapshot (previous/baseline).
 *
 * Returns { hasData: false } when no snapshot exists yet — the UI shows
 * "Save a baseline first by clicking 📌 Save Baseline after your GM call."
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{
 *   hasData: boolean,
 *   currentWeek: string,   — always "live"
 *   previousWeek: string,  — week_label of the most-recent snapshot
 *   new: object[],
 *   dropped: object[],
 *   promoted: object[],
 *   demoted: object[],
 *   amount: object[],
 *   slipped: object[],
 *   pulled_in: object[],
 *   unchanged: object[],
 *   summary: string
 * }}
 */
function computeDiff(db) {
  // Get the most-recent snapshot by snapped_at timestamp (the baseline)
  // Ordering by snapped_at DESC ensures we always use the latest save,
  // regardless of whether multiple snapshots exist in the same calendar week.
  const baselineRow = db
    .prepare("SELECT DISTINCT week_label FROM snapshots ORDER BY snapped_at DESC LIMIT 1")
    .get();

  if (!baselineRow) {
    return { hasData: false, currentWeek: 'live', previousWeek: null };
  }

  const previousWeek = baselineRow.week_label;
  const currentWeek  = 'live';

  // Current = live opportunities table
  const currentRows  = db.prepare('SELECT * FROM opportunities').all();
  // Previous = most-recent snapshot
  const previousRows = db.prepare('SELECT * FROM snapshots WHERE week_label = ?').all(previousWeek);

  const currentMap  = new Map(currentRows.map(r => [r.id, r]));
  const previousMap = new Map(previousRows.map(r => [r.id, r]));

  const result = {
    hasData: true,
    currentWeek,
    previousWeek,
    new:       [],
    dropped:   [],
    promoted:  [],
    demoted:   [],
    amount:    [],
    slipped:   [],
    pulled_in: [],
    unchanged: [],
  };

  // New deals (in current, not in previous)
  for (const [id, cur] of currentMap) {
    if (!previousMap.has(id)) {
      result.new.push({ ...cur });
    }
  }

  // Dropped deals (in previous, not in current)
  for (const [id, prev] of previousMap) {
    if (!currentMap.has(id)) {
      result.dropped.push({ ...prev });
    }
  }

  // Changed deals (in both)
  for (const [id, cur] of currentMap) {
    const prev = previousMap.get(id);
    if (!prev) continue;

    const changes = [];

    // Baseline confidence scores (null if snapshot predates v2.2.0 migration)
    const scoreContext = {
      prevScore: prev.score  ?? null,
      prevTier:  prev.tier   ?? null,
    };

    // Stage movement
    const prevSI = stageIndex(prev.stage);
    const curSI  = stageIndex(cur.stage);
    if (prev.stage !== cur.stage && prevSI !== -1 && curSI !== -1) {
      const delta = { ...cur, ...scoreContext, prevStage: prev.stage, curStage: cur.stage };
      if (curSI > prevSI)  { result.promoted.push(delta); changes.push('stage'); }
      if (curSI < prevSI)  { result.demoted.push(delta);  changes.push('stage'); }
    }

    // Amount change ≥ $50k AND ≥ 10%
    const prevAmt = prev.total_opportunity_amount || 0;
    const curAmt  = cur.total_opportunity_amount  || 0;
    const amtDiff = curAmt - prevAmt;
    const amtPct  = prevAmt !== 0 ? Math.abs(amtDiff / prevAmt) : (curAmt !== 0 ? 1 : 0);
    if (Math.abs(amtDiff) >= 50000 && amtPct >= 0.10) {
      result.amount.push({ ...cur, ...scoreContext, prevAmt, curAmt, amtDiff });
      changes.push('amount');
    }

    // Close date slip / pull-in (≥ 7 days)
    if (prev.close_date && cur.close_date && prev.close_date !== cur.close_date) {
      const prevDate = new Date(prev.close_date);
      const curDate  = new Date(cur.close_date);
      const daysDiff = Math.round((curDate - prevDate) / 86400000);
      if (daysDiff >= 7) {
        result.slipped.push({ ...cur, ...scoreContext, prevCloseDate: prev.close_date, curCloseDate: cur.close_date, daysDiff });
        changes.push('slipped');
      } else if (daysDiff <= -7) {
        result.pulled_in.push({ ...cur, ...scoreContext, prevCloseDate: prev.close_date, curCloseDate: cur.close_date, daysDiff });
        changes.push('pulled_in');
      }
    }

    if (changes.length === 0) {
      result.unchanged.push({ ...cur });
    }
  }

  // Build a human-readable summary string (used in PPT and narrative prompt)
  const parts = [];
  if (result.new.length)       parts.push(`${result.new.length} new`);
  if (result.dropped.length)   parts.push(`${result.dropped.length} dropped`);
  if (result.promoted.length)  parts.push(`${result.promoted.length} promoted`);
  if (result.demoted.length)   parts.push(`${result.demoted.length} demoted`);
  if (result.amount.length)    parts.push(`${result.amount.length} amount changes`);
  if (result.slipped.length)   parts.push(`${result.slipped.length} slipped`);
  if (result.pulled_in.length) parts.push(`${result.pulled_in.length} pulled in`);
  result.summary = parts.length > 0
    ? `live vs ${previousWeek}: ${parts.join(', ')}`
    : `live vs ${previousWeek}: no significant changes detected`;

  return result;
}

module.exports = { saveSnapshot, computeDiff, isoWeekLabel };
