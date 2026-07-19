/**
 * server/hygieneScore.js  (v2.5.0)
 *
 * PIPELINE INTELLIGENCE ENGINE
 * ────────────────────────────────────────────────────────────────────────────
 * Computes per-opportunity hygiene scores and per-rep hygiene summaries from
 * existing schema columns — no new data sources required.
 *
 * Three use cases it addresses (from UCC1-TechnicalSessionLog.md §4477-4480):
 *
 *  Use Case 1 — SR/SM/C behavioral tracking:
 *    Week-over-week timeline for each deal, showing stage/close date/amount/NS
 *    progression across all saved baseline_ledger snapshots.
 *
 *  Use Case 2 — Communications hygiene as a risk predictor:
 *    Stale or absent Next Steps on a high-forecast-call deal = "liar deal" flag.
 *    FLM Judgement override vs rep forecast category = management disagreement.
 *
 *  Use Case 3 — Absence of activity as coaching/attrition signal:
 *    Per-rep summary: blank NS across all deals = disengagement indicator.
 *    Combined with stage stagnation = urgent coaching flag.
 *
 * ── Hygiene Score (0–100) ────────────────────────────────────────────────────
 *  Component                     Weight   Conditions
 *  ──────────────────────────────────────────────────────────────────────────
 *  Next Steps presence            +35      blank → 0
 *  Next Steps recency             +25      fresh (<7d) → 25, stale (7–14d) → 15,
 *                                          very stale (14–21d) → 5, >21d → 0
 *  Team Notes presence            +10      blank → 0
 *  Forecast/score alignment       +20      no mismatch → 20; moderate → 10; severe → 0
 *  FLM agreement with rep         +10      agree/blank → 10; disagree → 0
 *  ──────────────────────────────────────────────────────────────────────────
 *  Max                           100
 *
 * ── Future watsonx upgrade path (v2.6.0) ────────────────────────────────────
 *  Replace scoreNextStepsQuality() with a granite-3.3-8b API call that rates
 *  specificity, named-person presence, and ambiguous-language detection.
 *  The rest of the scoring logic is unchanged — only the quality sub-score swaps.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Forecast categories considered "committed" — VP is vouching for these. */
const HIGH_COMMIT_CATEGORIES = new Set(['Commit', 'Best Case', 'Upside']);

/** Score threshold below which a "committed" deal is a red flag. */
const LIAR_DEAL_SCORE_THRESHOLD = 50;

/**
 * FLM Judgement values that indicate the manager is pushing back on the rep's
 * forecast call (i.e. FLM is more pessimistic).
 */
const FLM_DOWNGRADE_VALUES = new Set([
  'Pipeline', 'Omitted', 'No Call', 'No Decision', 'Exclude',
]);

/**
 * "Padded close" detection — days from the quarter-end boundary.
 *
 * A close date of Sep 28–30 is the classic sign that a rep parked the deal
 * at the last safe moment before quarter-end to avoid scrutiny.
 * It doesn't mean the deal is bad — but it does mean the VP should ask.
 *
 * Thresholds:
 *   0 days  = exactly quarter-end (e.g. Sep 30, Dec 31) — highest suspicion
 *   1–2 days = penultimate days                           — high suspicion
 *   3–4 days = last week of quarter                       — watch signal
 *
 * @param {string|null} closeDateStr  YYYY-MM-DD
 * @returns {{ isPadded: boolean, daysFromEnd: number|null, quarterEnd: string|null }}
 */
function detectPaddedClose(closeDateStr) {
  if (!closeDateStr) return { isPadded: false, daysFromEnd: null, quarterEnd: null };

  const d = new Date(closeDateStr);
  if (isNaN(d.getTime())) return { isPadded: false, daysFromEnd: null, quarterEnd: null };

  const year = d.getUTCFullYear();
  // Quarter-end dates as UTC day numbers for offset-safe comparison
  // All dates are YYYY-MM-DD strings → parsed as UTC midnight → compare in UTC days.
  const quarterEnds = [
    { ms: Date.UTC(year, 2, 31), label: `Mar 31, ${year}` },   // Mar 31
    { ms: Date.UTC(year, 5, 30), label: `Jun 30, ${year}` },   // Jun 30
    { ms: Date.UTC(year, 8, 30), label: `Sep 30, ${year}` },   // Sep 30
    { ms: Date.UTC(year, 11, 31), label: `Dec 31, ${year}` },  // Dec 31
  ];

  for (const qEnd of quarterEnds) {
    const daysFromEnd = Math.round((qEnd.ms - d.getTime()) / 86400000);
    if (daysFromEnd >= 0 && daysFromEnd <= 4) {
      return {
        isPadded:    true,
        daysFromEnd,
        quarterEnd:  qEnd.label,
      };
    }
  }
  return { isPadded: false, daysFromEnd: null, quarterEnd: null };
}

// ---------------------------------------------------------------------------
// Next Steps date parsing
// ---------------------------------------------------------------------------

/**
 * Extract the most recent date mentioned at the start of a Next Steps entry.
 *
 * Sales reps commonly prefix entries with dates like:
 *   "7/9: Next steps is..."
 *   "7/13. Jean Gerald, VP..."
 *   "07/17/26 - Pricing deck delivered..."
 *   "2026-07-15 confirmed..."
 *
 * Returns a Date object, or null if no date prefix found.
 *
 * @param {string|null} text
 * @returns {Date|null}
 */
function parseNsDate(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();

  // Patterns tried in order of specificity
  const patterns = [
    // M/D/YY or M/D/YYYY  e.g. "7/9/26" "07/17/2026"
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
    // YYYY-MM-DD e.g. "2026-07-15"
    /^(\d{4})-(\d{2})-(\d{2})/,
    // M/D  e.g. "7/9:" "7/13." (no year — assume current year)
    /^(\d{1,2})\/(\d{1,2})[\s:.\-]/,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;

    let d;
    if (re.source.startsWith('^(\\d{4})')) {
      // YYYY-MM-DD
      d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    } else if (m[3] !== undefined) {
      // M/D/YY or M/D/YYYY
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
    } else {
      // M/D — use current year
      const now = new Date();
      d = new Date(now.getFullYear(), parseInt(m[1]) - 1, parseInt(m[2]));
      // If inferred date is > 14 days in the future it's probably last year
      if (d - now > 14 * 86400000) d.setFullYear(d.getFullYear() - 1);
    }

    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Days since the last Next Steps update.
 * Returns Infinity if blank / unparseable (worst-case staleness).
 *
 * @param {string|null} nextSteps
 * @param {string|null} scrapedAt   ISO timestamp from the opportunities table
 * @returns {number}
 */
function daysSinceNsUpdate(nextSteps, scrapedAt) {
  if (!nextSteps || !nextSteps.trim()) return Infinity;
  const parsed = parseNsDate(nextSteps);
  if (!parsed) return Infinity; // present but unparseable — treat as stale
  const ref = scrapedAt ? new Date(scrapedAt) : new Date();
  return Math.max(0, Math.floor((ref - parsed) / 86400000));
}

// ---------------------------------------------------------------------------
// Per-opportunity hygiene score
// ---------------------------------------------------------------------------

/**
 * Compute a 0–100 hygiene score and generate action items for one opportunity.
 *
 * @param {object} opp   Row from the opportunities table (or baseline_ledger)
 * @returns {{
 *   hygieneScore: number,
 *   hygieneGrade: 'green'|'amber'|'red',
 *   components: object,
 *   actionItems: Array<{ priority: 'P1'|'P2'|'P3', text: string, type: string }>,
 *   nsDaysSinceUpdate: number,
 *   nsDateFound: string|null,
 *   liarDeal: boolean,
 *   flmDisagreement: boolean,
 * }}
 */
function scoreHygiene(opp) {
  const actionItems = [];
  let score = 0;

  const ns         = opp.next_steps   || '';
  const tn         = opp.team_notes   || '';
  const fc         = opp.forecast_category || '';
  const flmJ       = opp.flm_judgement    || '';
  const oppScore   = opp.score ?? opp.ai_score ?? null;
  const owner      = opp.opportunity_owner || 'Unknown owner';
  const closeDateStr = opp.close_date || '';

  // ── Component 0: Padded close date (informational — no score deduction) ──────
  // Detected separately so it appears at the TOP of action items regardless
  // of other scores. A deal on Sep 30 with a great hygiene score still needs
  // this flag visible because it's a management question, not a hygiene failure.
  const paddedClose = detectPaddedClose(closeDateStr);
  if (paddedClose.isPadded) {
    const { daysFromEnd, quarterEnd } = paddedClose;
    const urgency  = daysFromEnd === 0 ? 'P1' : daysFromEnd <= 2 ? 'P2' : 'P3';
    const dayLabel = daysFromEnd === 0
      ? `exactly on quarter-end (${quarterEnd})`
      : `${daysFromEnd} day${daysFromEnd !== 1 ? 's' : ''} before quarter-end (${quarterEnd})`;
    const advice = HIGH_COMMIT_CATEGORIES.has(fc)
      ? `${owner} calls this "${fc}" with a quarter-end close date — ask: is this real or parked? Confirm customer commitment and procurement path.`
      : `Close date is ${dayLabel}. Verify this is a genuine target date and not a placeholder.`;
    actionItems.push({
      priority: urgency,
      type: 'padded-close',
      text: `Close date is ${dayLabel}. ${advice}`,
    });
  }

  // ── Component 1: Next Steps presence (+35) ────────────────────────────────
  const nsBlank = !ns.trim();
  if (!nsBlank) {
    score += 35;
  } else {
    actionItems.push({
      priority: 'P1',
      type: 'ns-blank',
      text: `No Next Steps recorded. Ask ${owner} to update before the next forecast call.`,
    });
  }

  // ── Component 2: Next Steps recency (+25) ────────────────────────────────
  const daysSince = daysSinceNsUpdate(ns, opp.scraped_at);
  const nsDateFound = nsBlank ? null : (parseNsDate(ns) ? parseNsDate(ns).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null);

  if (!nsBlank) {
    if (daysSince <= 7)       { score += 25; }
    else if (daysSince <= 14) {
      score += 15;
      actionItems.push({
        priority: 'P2',
        type: 'ns-stale',
        text: `Next Steps last updated ~${daysSince} days ago. Confirm this deal is still active — it may be stalling.`,
      });
    } else if (daysSince <= 21) {
      score += 5;
      actionItems.push({
        priority: 'P1',
        type: 'ns-stale',
        text: `Next Steps are ${daysSince} days stale. This deal has had no documented progress in over two weeks.`,
      });
    } else if (isFinite(daysSince)) {
      // > 21 days stale
      actionItems.push({
        priority: 'P1',
        type: 'ns-very-stale',
        text: `Next Steps are ${daysSince} days stale. No documented activity in over three weeks — urgent: confirm deal status with ${owner}.`,
      });
    } else {
      // Text present but date unparseable
      score += 8;
      actionItems.push({
        priority: 'P3',
        type: 'ns-no-date',
        text: `Next Steps are present but contain no date prefix. Ask ${owner} to begin entries with a date (e.g. "7/18: ...") for hygiene tracking.`,
      });
    }
  }

  // ── Component 3: Team Notes presence (+10) ───────────────────────────────
  const tnBlank = !tn.trim();
  if (!tnBlank) {
    score += 10;
  } else {
    // Only flag as action for non-trivial deals ($50K+)
    const amt = opp.total_opportunity_amount || opp.filtered_opportunity_amount || 0;
    if (amt >= 50000 || HIGH_COMMIT_CATEGORIES.has(fc)) {
      actionItems.push({
        priority: 'P3',
        type: 'tn-blank',
        text: `No close plan in Team Notes. Require ${owner} to document path-to-close for this deal.`,
      });
    }
  }

  // ── Component 4: Forecast/score alignment (+20) ──────────────────────────
  const highCommit = HIGH_COMMIT_CATEGORIES.has(fc);
  const lowScore   = oppScore !== null && oppScore < LIAR_DEAL_SCORE_THRESHOLD;
  const liarDeal   = highCommit && lowScore;

  if (!liarDeal) {
    if (oppScore === null) {
      score += 10; // unscored — partial credit
    } else {
      score += 20;
    }
  } else {
    // Moderate mismatch: Upside/Best Case + medium-low score
    const severelyLow = oppScore < 35;
    if (severelyLow) {
      score += 0;
      actionItems.push({
        priority: 'P1',
        type: 'liar-deal',
        text: `${owner} calls this "${fc}" but confidence score is ${oppScore}/100 (Low). Severe forecast-to-score mismatch — needs interrogation in forecast call.`,
      });
    } else {
      score += 10;
      actionItems.push({
        priority: 'P2',
        type: 'forecast-mismatch',
        text: `${owner} calls this "${fc}" but confidence score is ${oppScore}/100. Moderate mismatch — verify deal quality before GM call.`,
      });
    }
  }

  // ── Component 5: FLM agreement (+10) ─────────────────────────────────────
  const flmDisagreement = !!(flmJ && FLM_DOWNGRADE_VALUES.has(flmJ) && highCommit);
  if (!flmDisagreement) {
    score += 10;
  } else {
    actionItems.push({
      priority: 'P1',
      type: 'flm-override',
      text: `FLM Judgement (${flmJ}) is lower than rep's forecast call (${fc}). Manager disagrees — resolve before GM meeting.`,
    });
  }

  // ── Grade ──────────────────────────────────────────────────────────────────
  const hygieneGrade = score >= 75 ? 'green' : score >= 45 ? 'amber' : 'red';

  // If no P1/P2 issues, confirm clean
  if (actionItems.length === 0) {
    actionItems.push({
      priority: 'clean',
      type: 'clean',
      text: 'No action items. Deal hygiene is clean.',
    });
  }

  return {
    hygieneScore:      Math.round(score),
    hygieneGrade,
    components: {
      nsPresence:     nsBlank ? 0 : 35,
      nsRecency:      score - (nsBlank ? 0 : 35) - (!tnBlank ? 10 : 0) - (liarDeal ? (oppScore < 35 ? 0 : 10) : (oppScore === null ? 10 : 20)) - (flmDisagreement ? 0 : 10),
      tnPresence:     tnBlank ? 0 : 10,
      forecastAlign:  liarDeal ? (oppScore < 35 ? 0 : 10) : (oppScore === null ? 10 : 20),
      flmAgree:       flmDisagreement ? 0 : 10,
    },
    actionItems,
    nsDaysSinceUpdate: isFinite(daysSince) ? daysSince : null,
    nsDateFound,
    liarDeal,
    flmDisagreement,
    paddedClose:       paddedClose.isPadded ? paddedClose : null,
  };
}

// ---------------------------------------------------------------------------
// Per-opportunity week-over-week timeline (Use Case 1)
// ---------------------------------------------------------------------------

/**
 * Return the history of a single opportunity across all confirmed baselines
 * for this user — sorted oldest-first.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} oppId
 * @param {string} userId
 * @returns {Array<object>}
 */
function getOppTimeline(db, oppId, userId) {
  return db.prepare(`
    SELECT
      bl.snapshot_id   AS snapshotId,
      bl.week_label    AS weekLabel,
      bl.quarter_label AS quarterLabel,
      bl.week_seq      AS weekSeq,
      bl.confirmed_at  AS confirmedAt,
      bl.stage,
      bl.forecast_category AS forecastCategory,
      bl.close_date    AS closeDate,
      bl.filtered_opportunity_amount AS filteredAmt,
      bl.total_opportunity_amount    AS totalAmt,
      bl.next_steps    AS nextSteps,
      bl.team_notes    AS teamNotes,
      bl.score,
      bl.tier
    FROM   baseline_ledger bl
    WHERE  bl.id = ?
      AND  bl.user_id = ?
      AND  bl.confirmed = 1
    ORDER  BY bl.confirmed_at ASC
  `).all(oppId, userId);
}

// ---------------------------------------------------------------------------
// Per-rep hygiene summary (Use Case 3)
// ---------------------------------------------------------------------------

/**
 * Aggregate hygiene scores by opportunity_owner for the given user's pipeline.
 * Returns an array sorted by hygieneScore ASC (worst first — coaching priority).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @returns {Array<{
 *   owner: string,
 *   manager: string|null,
 *   dealCount: number,
 *   blankNs: number,
 *   staleNs: number,
 *   liarDeals: number,
 *   flmOverrides: number,
 *   avgHygieneScore: number,
 *   coachingFlag: 'urgent'|'watch'|'clean',
 * }>}
 */
function getRepHygieneSummary(db, userId) {
  const opps = db.prepare(
    'SELECT * FROM opportunities WHERE user_id = ? ORDER BY opportunity_owner ASC'
  ).all(userId);

  // Group by owner
  const ownerMap = new Map();
  for (const opp of opps) {
    const owner = opp.opportunity_owner || 'Unknown';
    if (!ownerMap.has(owner)) {
      ownerMap.set(owner, {
        owner,
        manager:    opp.opportunity_owners_manager || null,
        deals:      [],
      });
    }
    ownerMap.get(owner).deals.push(opp);
  }

  const results = [];
  for (const { owner, manager, deals } of ownerMap.values()) {
    let totalScore = 0;
    let blankNs = 0, staleNs = 0, liarDeals = 0, flmOverrides = 0;

    for (const d of deals) {
      const h = scoreHygiene(d);
      totalScore += h.hygieneScore;
      if (!d.next_steps || !d.next_steps.trim()) blankNs++;
      else if (h.nsDaysSinceUpdate !== null && h.nsDaysSinceUpdate > 14) staleNs++;
      if (h.liarDeal)        liarDeals++;
      if (h.flmDisagreement) flmOverrides++;
    }

    const avg = deals.length > 0 ? Math.round(totalScore / deals.length) : 0;
    const coachingFlag =
      blankNs === deals.length ? 'urgent' :  // ALL deals blank → disengagement signal
      avg < 40                 ? 'urgent' :
      avg < 65                 ? 'watch'  :
      'clean';

    results.push({
      owner,
      manager,
      dealCount:       deals.length,
      blankNs,
      staleNs,
      liarDeals,
      flmOverrides,
      avgHygieneScore: avg,
      coachingFlag,
    });
  }

  // Sort: urgent first, then by avgHygieneScore ASC
  results.sort((a, b) => {
    const order = { urgent: 0, watch: 1, clean: 2 };
    const od = order[a.coachingFlag] - order[b.coachingFlag];
    return od !== 0 ? od : a.avgHygieneScore - b.avgHygieneScore;
  });

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  scoreHygiene,
  getOppTimeline,
  getRepHygieneSummary,
  parseNsDate,
  daysSinceNsUpdate,
  detectPaddedClose,
};
