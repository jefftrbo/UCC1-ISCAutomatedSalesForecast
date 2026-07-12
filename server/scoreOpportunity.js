/**
 * server/scoreOpportunity.js
 *
 * Rule-based confidence scoring engine for ISC sales opportunities.
 * Returns a score 0–100 and a tier (High / Medium / Low) for each opportunity.
 *
 * Scoring weights (total = 100 points):
 *   Stage          30 pts  — sales cycle position
 *   Forecast       25 pts  — rep/manager committed forecast category
 *   Close Date     20 pts  — proximity to end of current calendar quarter
 *   FLM Judgement  10 pts  — first-line manager override signal
 *   Next Steps     10 pts  — action-oriented language quality
 *   Team Notes      5 pts  — activity signal presence
 *
 * Tiers:
 *   🟢 High    70–100
 *   🟡 Medium  40–69
 *   🔴 Low      0–39
 */

// ---------------------------------------------------------------------------
// Calendar quarter helpers
// ---------------------------------------------------------------------------

/**
 * Returns the start and end date of the current calendar quarter.
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date, label: string }}
 */
function currentQuarter(now = new Date()) {
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3); // 0=Q1, 1=Q2, 2=Q3, 3=Q4
  const starts = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct
  const start = new Date(y, starts[q], 1);
  const end   = new Date(y, starts[q] + 3, 0); // last day of quarter
  return { start, end, label: `Q${q + 1} ${y}` };
}

/**
 * Returns the start and end date of the next calendar quarter.
 * @param {Date} [now]
 */
function nextQuarter(now = new Date()) {
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3);
  const nextQ = (q + 1) % 4;
  const nextY = nextQ === 0 ? y + 1 : y;
  const starts = [0, 3, 6, 9];
  const start = new Date(nextY, starts[nextQ], 1);
  const end   = new Date(nextY, starts[nextQ] + 3, 0);
  return { start, end, label: `Q${nextQ + 1} ${nextY}` };
}

// ---------------------------------------------------------------------------
// Individual signal scorers
// ---------------------------------------------------------------------------

/** Stage score — 30 points max */
function scoreStage(stage) {
  if (!stage) return 0;
  const s = stage.toLowerCase();
  if (s.includes('5') || s.includes('negotiat')) return 30;
  if (s.includes('4') || s.includes('propos'))   return 24;
  if (s.includes('3') || s.includes('design'))   return 18;
  if (s.includes('2') || s.includes('qualify'))  return 10;
  if (s.includes('1') || s.includes('engage'))   return 4;
  return 0;
}

/** Forecast category score — 25 points max */
function scoreForecast(forecast) {
  if (!forecast) return 0;
  const f = forecast.toLowerCase();
  if (f.includes('commit') || f === 'call')       return 25;
  if (f.includes('best'))                          return 18;
  if (f.includes('pipeline'))                      return 10;
  if (f.includes('omit'))                          return 0;
  return 5; // unknown category gets minimal credit
}

/** Close date score — 20 points max (calendar quarters).
 *
 * Within the current quarter, earlier close dates score higher —
 * a deal closing in the first half of the quarter is more credible
 * than one parked at the quarter-end (a common CRM sandbagging pattern).
 *
 * Scoring within this quarter (20 pts max):
 *   First third of quarter  → 20 pts  (e.g. July 1–31 in Q3)
 *   Second third            → 16 pts  (e.g. Aug 1–31 in Q3)
 *   Final third             → 11 pts  (e.g. Sep 1–30 in Q3)
 *   Last 2 weeks of quarter →  8 pts  (classic end-of-quarter push — discounted)
 *
 * Next quarter             → 8 pts
 * Beyond next quarter      → 3 pts
 * Past due                 → 0 pts
 */
function scoreCloseDate(closeDateStr, now = new Date()) {
  if (!closeDateStr) return 0;

  const closeDate = new Date(closeDateStr + 'T00:00:00'); // avoid timezone shift
  if (isNaN(closeDate.getTime())) return 0;

  // Past close date — missed or not yet updated, penalise
  if (closeDate < now) return 0;

  const cq = currentQuarter(now);
  const nq = nextQuarter(now);

  if (closeDate >= cq.start && closeDate <= cq.end) {
    // Within current quarter — score by position within the quarter
    const quarterMs   = cq.end.getTime() - cq.start.getTime();
    const elapsed     = closeDate.getTime() - cq.start.getTime();
    const position    = elapsed / quarterMs; // 0.0 (start) → 1.0 (end)

    // Last 2 weeks of quarter — sandbagging discount
    const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
    if (cq.end.getTime() - closeDate.getTime() <= twoWeeksMs) return 8;

    if (position < 0.333) return 20; // first third  — most credible
    if (position < 0.667) return 16; // second third — credible
    return 11;                        // final third  — some pressure needed
  }

  if (closeDate >= nq.start && closeDate <= nq.end) return 8;  // next quarter
  return 3; // beyond next quarter
}

/** FLM Judgement score — 10 points max */
function scoreFLM(flm) {
  if (!flm) return 0;
  return flm.toLowerCase() === 'yes' ? 10 : 0;
}

/**
 * Next Steps quality score — 10 points max.
 * Looks for action-oriented language that signals active progression.
 */
function scoreNextSteps(nextSteps) {
  if (!nextSteps || nextSteps.trim().length === 0) return 0;

  const text = nextSteps.toLowerCase();

  // Strong commit/close signals
  const strongSignals = [
    'po ', 'purchase order', 'signed', 'approved', 'verbal commit',
    'legal review', 'contract', 'order', 'ink', 'closed', 'commit',
    'final approval', 'executive sign', 'awaiting signature',
  ];

  // Active progression signals
  const activeSignals = [
    'meeting', 'call scheduled', 'demo', 'proposal', 'follow up',
    'follow-up', 'next step', 'action', 'deliver', 'present',
    'review', 'workshop', 'poc', 'proof of concept', 'pilot',
    'negotiate', 'finalize', 'schedule', 'confirm',
  ];

  // Weak/stale signals
  const weakSignals = [
    'tbd', 'to be determined', 'waiting', 'pending', 'no update',
    'unknown', 'exploring', 'evaluating', 'considering',
  ];

  if (strongSignals.some(s => text.includes(s))) return 10;
  if (weakSignals.some(s => text.includes(s)))   return 2;
  if (activeSignals.some(s => text.includes(s))) return 7;
  if (text.length > 20)                          return 5; // has content, no keyword match
  return 3; // very short text
}

/**
 * Team Notes activity score — 5 points max.
 * Presence of notes with a date or substantive content signals active deal.
 */
function scoreTeamNotes(teamNotes) {
  if (!teamNotes || teamNotes.trim().length === 0) return 0;

  const text = teamNotes.toLowerCase();

  // Date pattern suggests recent update (e.g. "6/29", "7/11", "2026-07")
  const hasDate = /\d{1,2}\/\d{1,2}|\d{4}-\d{2}/.test(text);
  if (hasDate && text.length > 15) return 5;
  if (text.length > 30) return 3;
  return 1;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Score a single opportunity row.
 * @param {Object} opp - opportunity row from SQLite
 * @param {Date} [now] - reference date (defaults to today)
 * @returns {{
 *   score: number,          // 0–100
 *   tier: 'High'|'Medium'|'Low',
 *   breakdown: Object,      // per-signal scores for tooltip
 *   closeQuarter: string    // e.g. "Q3 2026"
 * }}
 */
function scoreOpportunity(opp, now = new Date()) {
  const stage     = scoreStage(opp.stage);
  const forecast  = scoreForecast(opp.forecast_category);
  const closeDate = scoreCloseDate(opp.close_date, now);
  const flm       = scoreFLM(opp.flm_judgement);
  const nextSteps = scoreNextSteps(opp.next_steps);
  const teamNotes = scoreTeamNotes(opp.team_notes);

  const score = stage + forecast + closeDate + flm + nextSteps + teamNotes;

  const tier = score >= 70 ? 'High'
             : score >= 40 ? 'Medium'
             :               'Low';

  // Determine which calendar quarter the close date falls in
  let closeQuarter = '—';
  if (opp.close_date) {
    const d = new Date(opp.close_date + 'T00:00:00');
    if (!isNaN(d.getTime())) {
      const q = Math.floor(d.getMonth() / 3) + 1;
      closeQuarter = `Q${q} ${d.getFullYear()}`;
    }
  }

  return {
    score,
    tier,
    closeQuarter,
    breakdown: {
      stage:     { points: stage,     max: 30, label: opp.stage || '—' },
      forecast:  { points: forecast,  max: 25, label: opp.forecast_category || '—' },
      closeDate: { points: closeDate, max: 20, label: opp.close_date || '—' },
      flm:       { points: flm,       max: 10, label: opp.flm_judgement || '—' },
      nextSteps: { points: nextSteps, max: 10, label: opp.next_steps ? opp.next_steps.slice(0, 60) + '…' : '—' },
      teamNotes: { points: teamNotes, max: 5,  label: opp.team_notes ? opp.team_notes.slice(0, 60) + '…' : '—' },
    },
  };
}

module.exports = { scoreOpportunity, currentQuarter, nextQuarter };
