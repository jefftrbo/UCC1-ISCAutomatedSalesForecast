/**
 * server/diffEngine.js  (v2.3.0)
 *
 * DESIGN — Permanent Quarterly Audit Ledger
 * ─────────────────────────────────────────
 * Every confirmed "Final" baseline run is written to `baseline_ledger` with a
 * globally-unique snapshot_id (UUID). Rows are NEVER overwritten or deleted.
 * The table is an append-only audit trail for the entire quarterly sales cycle.
 *
 * TWO save modes (controlled by caller):
 *   confirmed = true  → "Confirm & Generate" — permanent historical record
 *   confirmed = false → "Generate Only"      — test run, not used as diff baseline
 *
 * computeDiff(db, [asOf])
 *   Compares the live opportunities table against the most-recent CONFIRMED
 *   baseline with confirmed_at < asOf (defaults to now). This ensures:
 *   1. "today vs today" bug is impossible — the snapshot written THIS run has
 *      confirmed_at = now, so it is never selected as the prior baseline.
 *   2. Multiple test runs ("Generate Only") never pollute the diff baseline.
 *
 * Historical queries enabled by this schema:
 *   - SR/SM stage trajectory across all weeks of a quarter
 *   - Next Steps hygiene gaps (N consecutive weeks of blank next_steps)
 *   - Close date drift over time per opportunity
 *   - Quarter-over-quarter pipeline health comparison
 */

'use strict';

const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Stage ordering — used to determine promotion vs. demotion
// ---------------------------------------------------------------------------
const STAGE_ORDER = [
  'Identify', 'Qualify', 'Engage', 'Design',
  'Propose', 'Negotiate', 'Closing', 'Closed Won', 'Closed Lost',
];

function stageIndex(stage) {
  if (!stage) return -1;
  const norm = stage.trim();
  const idx = STAGE_ORDER.findIndex(s => norm.toLowerCase().includes(s.toLowerCase()));
  return idx === -1 ? 0 : idx;
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable timestamp label — "Jul 17, 2026 · 7:00 PM"
 * Used as week_label in the ledger.
 */
function snapshotLabel(date = new Date()) {
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${datePart} · ${timePart}`;
}

/**
 * Quarter label — "Q3 2026" — derived from a calendar date.
 * Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.
 * Uses UTC month to avoid local-timezone date boundary issues.
 */
function quarterLabel(date = new Date()) {
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${q} ${date.getUTCFullYear()}`;
}

/**
 * Week sequence within the quarter (1-based).
 * Week 1 = the week containing the first day of the quarter.
 * Uses UTC dates to avoid local-timezone boundary issues.
 */
function weekSeqInQuarter(date = new Date()) {
  const q      = Math.floor(date.getUTCMonth() / 3);
  const qStart = Date.UTC(date.getUTCFullYear(), q * 3, 1);
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.floor((date.getTime() - qStart) / msPerWeek) + 1;
}

// Keep isoWeekLabel exported — test scripts may still use it
function isoWeekLabel(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// saveSnapshot — writes one entry to baseline_ledger
// ---------------------------------------------------------------------------
/**
 * Freeze the current opportunities table as a new ledger entry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ confirmed?: boolean, now?: Date }} [opts]
 *   confirmed  true  = "Confirm & Generate" — permanent historical record (default)
 *              false = "Generate Only"      — test run, excluded from diff baselines
 *   now        override the current timestamp (used by test harness to simulate weeks)
 *
 * @returns {{ snapshotId: string, weekLabel: string, quarterLabel: string,
 *             weekSeq: number, confirmed: boolean, saved: number }}
 */
function saveSnapshot(db, { confirmed = true, now = new Date(), userId = null } = {}) {
  const snapshotId   = randomUUID();
  const wLabel       = snapshotLabel(now);
  const qLabel       = quarterLabel(now);
  const wSeq         = weekSeqInQuarter(now);
  const confirmedAt  = now.toISOString();
  const confirmedInt = confirmed ? 1 : 0;

  const rows = userId
    ? db.prepare('SELECT * FROM opportunities WHERE user_id = ?').all(userId)
    : db.prepare('SELECT * FROM opportunities').all();

  const insert = db.prepare(`
    INSERT INTO baseline_ledger
      (snapshot_id, week_label, quarter_label, week_seq, confirmed_at, confirmed,
       id, opportunity_name, account_name, stage, forecast_category,
       close_date, filtered_opportunity_amount, total_opportunity_amount,
       opportunity_owner, flm_judgement, next_steps, team_notes, score, tier, user_id)
    VALUES
      (?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const r of rows) {
      insert.run(
        snapshotId, wLabel, qLabel, wSeq, confirmedAt, confirmedInt,
        r.id, r.opportunity_name, r.account_name, r.stage, r.forecast_category,
        r.close_date, r.filtered_opportunity_amount, r.total_opportunity_amount,
        r.opportunity_owner, r.flm_judgement, r.next_steps, r.team_notes ?? null,
        r.score ?? null, r.tier ?? null,
        userId ?? r.user_id ?? null
      );
    }
  })();

  return {
    snapshotId,
    weekLabel:     wLabel,
    quarterLabel:  qLabel,
    weekSeq:       wSeq,
    confirmed,
    saved:         rows.length,
  };
}

// ---------------------------------------------------------------------------
// getPreviousBaseline — internal helper
// ---------------------------------------------------------------------------
/**
 * Returns the most-recent confirmed baseline whose confirmed_at is strictly
 * before `asOf`. This is what computeDiff compares the live table against.
 *
 * Returns null if no qualifying baseline exists yet.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} asOf  ISO timestamp — only baselines BEFORE this are considered
 * @returns {{ snapshotId: string, weekLabel: string } | null}
 */
function getPreviousBaseline(db, asOf, userId = null) {
  const row = userId
    ? db.prepare(`
        SELECT DISTINCT snapshot_id AS snapshotId, week_label AS weekLabel
        FROM   baseline_ledger
        WHERE  confirmed = 1 AND user_id = ?
          AND  confirmed_at < ?
        ORDER  BY confirmed_at DESC
        LIMIT  1
      `).get(userId, asOf)
    : db.prepare(`
        SELECT DISTINCT snapshot_id AS snapshotId, week_label AS weekLabel
        FROM   baseline_ledger
        WHERE  confirmed = 1
          AND  confirmed_at < ?
        ORDER  BY confirmed_at DESC
        LIMIT  1
      `).get(asOf);
  return row || null;
}

// ---------------------------------------------------------------------------
// computeDiff — live opportunities vs. most-recent prior confirmed baseline
// ---------------------------------------------------------------------------
/**
 * Compare the live opportunities table against the most-recent confirmed
 * baseline that was saved BEFORE `asOf` (defaults to now).
 *
 * The `asOf < confirmed_at` guard makes "today vs today" structurally
 * impossible — a snapshot saved during this run has confirmed_at = now,
 * which is never < now.
 *
 * Returns { hasData: false } when no qualifying baseline exists.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Date} [asOf]  defaults to new Date()
 * @returns {object}  structured diff result
 */
function computeDiff(db, asOf = new Date(), userId = null) {
  const asOfIso = asOf.toISOString();
  const baseline = getPreviousBaseline(db, asOfIso, userId);

  if (!baseline) {
    return { hasData: false, currentWeek: 'live', previousWeek: null };
  }

  const { snapshotId, weekLabel: previousWeek } = baseline;
  const currentWeek = 'live';

  const currentRows  = userId
    ? db.prepare('SELECT * FROM opportunities WHERE user_id = ?').all(userId)
    : db.prepare('SELECT * FROM opportunities').all();
  const previousRows = db.prepare(
    'SELECT * FROM baseline_ledger WHERE snapshot_id = ?'
  ).all(snapshotId);

  const currentMap  = new Map(currentRows.map(r => [r.id, r]));
  const previousMap = new Map(previousRows.map(r => [r.id, r]));

  const result = {
    hasData: true,
    currentWeek,
    previousWeek,
    snapshotId,
    new:       [],
    dropped:   [],
    promoted:  [],
    demoted:   [],
    amount:    [],
    slipped:   [],
    pulled_in: [],
    unchanged: [],
  };

  // New deals (in live, not in baseline)
  for (const [id, cur] of currentMap) {
    if (!previousMap.has(id)) result.new.push({ ...cur });
  }

  // Dropped deals (in baseline, not in live)
  for (const [id, prev] of previousMap) {
    if (!currentMap.has(id)) result.dropped.push({ ...prev });
  }

  // Changed deals (in both)
  for (const [id, cur] of currentMap) {
    const prev = previousMap.get(id);
    if (!prev) continue;

    const changes = [];
    const scoreContext = { prevScore: prev.score ?? null, prevTier: prev.tier ?? null };

    // Stage movement
    const prevSI = stageIndex(prev.stage);
    const curSI  = stageIndex(cur.stage);
    if (prev.stage !== cur.stage && prevSI !== -1 && curSI !== -1) {
      const delta = { ...cur, ...scoreContext, prevStage: prev.stage, curStage: cur.stage };
      if (curSI > prevSI) { result.promoted.push(delta); changes.push('stage'); }
      if (curSI < prevSI) { result.demoted.push(delta);  changes.push('stage'); }
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
        result.slipped.push({ ...cur, ...scoreContext,
          prevCloseDate: prev.close_date, curCloseDate: cur.close_date, daysDiff });
        changes.push('slipped');
      } else if (daysDiff <= -7) {
        result.pulled_in.push({ ...cur, ...scoreContext,
          prevCloseDate: prev.close_date, curCloseDate: cur.close_date, daysDiff });
        changes.push('pulled_in');
      }
    }

    if (changes.length === 0) result.unchanged.push({ ...cur });
  }

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

// ---------------------------------------------------------------------------
// getLedgerHistory — returns all confirmed baselines for the UI/analytics
// ---------------------------------------------------------------------------
/**
 * Returns a summary of all confirmed baseline runs, newest first.
 * Used by the UI to display the baseline history panel.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ snapshotId, weekLabel, quarterLabel, weekSeq, confirmedAt, oppCount }>}
 */
function getLedgerHistory(db, userId = null) {
  const sql = userId
    ? `SELECT snapshot_id  AS snapshotId,
              week_label   AS weekLabel,
              quarter_label AS quarterLabel,
              week_seq     AS weekSeq,
              confirmed_at AS confirmedAt,
              COUNT(*)     AS oppCount
       FROM   baseline_ledger
       WHERE  confirmed = 1 AND user_id = ?
       GROUP  BY snapshot_id
       ORDER  BY confirmed_at DESC`
    : `SELECT snapshot_id  AS snapshotId,
              week_label   AS weekLabel,
              quarter_label AS quarterLabel,
              week_seq     AS weekSeq,
              confirmed_at AS confirmedAt,
              COUNT(*)     AS oppCount
       FROM   baseline_ledger
       WHERE  confirmed = 1
       GROUP  BY snapshot_id
       ORDER  BY confirmed_at DESC`;
  return userId ? db.prepare(sql).all(userId) : db.prepare(sql).all();
}

module.exports = {
  saveSnapshot,
  computeDiff,
  getPreviousBaseline,
  getLedgerHistory,
  isoWeekLabel,
  snapshotLabel,
  quarterLabel,
  weekSeqInQuarter,
};
