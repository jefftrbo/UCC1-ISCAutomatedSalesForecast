#!/usr/bin/env node
/**
 * scripts/day0-reset.js
 *
 * "Day 0" reset — wipes ALL pipeline and baseline data for ALL 9 users
 * (including dkpatel@us.ibm.com) and re-seeds every user with fresh
 * synthetic data.
 *
 * ⚠  THIS DELETES DUEY'S REAL HAR DATA. To restore it, re-run the HAR
 *    importer: node scraper/load-from-har.js <path-to-har>
 *
 * Usage:
 *   node scripts/day0-reset.js            # do it
 *   node scripts/day0-reset.js --dry-run  # preview only, nothing written
 */

'use strict';

const db = require('../server/db');
const { saveSnapshot } = require('../server/diffEngine');

// ── Inline the seed data + helpers from seed-quarter.js ──────────────────────
// (We can't require seed-quarter.js because it runs side-effects at load time)

const USER_SEED_TEMPLATES = {
  'dkpatel@us.ibm.com': {
    label: 'Dushyant K Patel (HCLS VP)',
    prefix: 'DP',
    deals: [
      { n: 1, name: 'DISA watsonx AI Operations',        account: 'DISA',                     stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 4500000, ta: 5500000, flm: 'Yes', ns: 'Final contract terms agreed. Awaiting CO signature.',              score: 93, tier: 'High'   },
      { n: 2, name: 'VA Enterprise AI Platform',          account: 'Dept of Veterans Affairs',  stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 3200000, ta: 3900000, flm: 'Yes', ns: 'Proposal delivered to VHA leadership. Evaluation board meets Aug 9.', score: 85, tier: 'High'   },
      { n: 3, name: 'HHS watsonx Genomics AI',            account: 'Dept of Health & Human Svc',stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 2100000, ta: 2600000, flm: 'Yes', ns: 'Architecture review complete. SOW in final legal review.',          score: 78, tier: 'High'   },
      { n: 4, name: 'DHA Clinical Decision Support',      account: 'Defense Health Agency',     stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 1400000, ta: 1750000, flm: 'No',  ns: 'Requirements workshop scheduled Aug 5 with DHA CIO office.',        score: 61, tier: 'Medium' },
      { n: 5, name: 'CMS Modernization Phase 3',          account: 'Centers for Medicare',      stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 950000,  ta: 1190000, flm: 'No',  ns: 'Executive briefing booked for Aug 12.',                             score: 49, tier: 'Medium' },
      { n: 6, name: 'CDC Data Platform Modernize',        account: 'CDC',                       stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 600000,  ta: 750000,  flm: 'No',  ns: null,                                                                score: 37, tier: 'Low'    },
    ],
  },
  'trbovich@us.ibm.com': {
    label: 'Jeff Trbovich (UPMC)',
    prefix: 'JT',
    deals: [
      { n: 1, name: 'UPMC watsonx Clinical AI',          account: 'UPMC',                     stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 1800000, ta: 2200000, flm: 'Yes', ns: 'Contract redlines received. Legal review in progress.',            score: 86, tier: 'High'   },
      { n: 2, name: 'Highmark Health Data Platform',     account: 'Highmark Health',           stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 950000,  ta: 1150000, flm: 'Yes', ns: 'Proposal submitted July 14. Awaiting Highmark procurement review.', score: 78, tier: 'High'   },
      { n: 3, name: 'Children\'s Hospital AI Pilot',     account: 'CHOP',                      stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 620000,  ta: 780000,  flm: 'Yes', ns: 'Architecture workshop completed. SOW being drafted.',              score: 72, tier: 'High'   },
      { n: 4, name: 'Penn Medicine Hybrid Cloud',        account: 'Penn Medicine',             stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 480000,  ta: 600000,  flm: 'No',  ns: 'Discovery call done. Budget approval pending Q3 board meeting.',    score: 55, tier: 'Medium' },
      { n: 5, name: 'Jefferson Health Automation',       account: 'Jefferson Health',          stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 310000,  ta: 390000,  flm: 'No',  ns: 'Initial meeting scheduled Aug 4 with CIO office.',                 score: 44, tier: 'Medium' },
      { n: 6, name: 'Temple Health Records Modernize',   account: 'Temple Health',             stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 225000,  ta: 280000,  flm: 'No',  ns: null,                                                                score: 38, tier: 'Low'    },
    ],
  },
  'spencer.korn@ibm.com': {
    label: 'Spencer Korn',
    prefix: 'SK',
    deals: [
      { n: 1, name: 'Mayo Clinic AI Operations',        account: 'Mayo Clinic',               stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-22', fa: 2100000, ta: 2600000, flm: 'Yes', ns: 'Final T&Cs under review. Close target Sept 19.',                   score: 89, tier: 'High'   },
      { n: 2, name: 'Cleveland Clinic Cloud Migration',  account: 'Cleveland Clinic',          stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-15', fa: 1100000, ta: 1350000, flm: 'Yes', ns: 'Technical proposal delivered. Waiting for exec sponsor sign-off.',  score: 81, tier: 'High'   },
      { n: 3, name: 'Geisinger Health Analytics',       account: 'Geisinger Health',          stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 730000,  ta: 910000,  flm: 'Yes', ns: 'Use case finalized. SOW in legal review.',                         score: 74, tier: 'High'   },
      { n: 4, name: 'Vanderbilt Health Modernize',      account: 'Vanderbilt Health',         stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 445000,  ta: 560000,  flm: 'No',  ns: 'RFI response submitted. Awaiting shortlist decision.',              score: 52, tier: 'Medium' },
      { n: 5, name: 'Mass General AI Diagnostics',      account: 'Mass General Hospital',     stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 290000,  ta: 365000,  flm: 'No',  ns: 'Exec briefing booked Aug 6.',                                      score: 46, tier: 'Medium' },
      { n: 6, name: 'Brigham Womens Data Ops',          account: 'Brigham & Women\'s Hosp.',  stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 190000,  ta: 240000,  flm: 'No',  ns: null,                                                                score: 35, tier: 'Low'    },
    ],
  },
  'kim.salatino@ibm.com': {
    label: 'Kim Salatino (UPMC TSL)',
    prefix: 'KS',
    deals: [
      { n: 1, name: 'UPMC Genomics AI Platform',        account: 'UPMC Enterprises',          stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1400000, ta: 1750000, flm: 'Yes', ns: 'Proposal in final review with genomics leadership team.',          score: 83, tier: 'High'   },
      { n: 2, name: 'Allegheny Health Network Cloud',   account: 'Allegheny Health Network',  stage: 'Design',    fc: 'Best Case',  cd: '2026-09-15', fa: 860000,  ta: 1050000, flm: 'Yes', ns: 'Architecture review Aug 5 with CTO.',                              score: 76, tier: 'High'   },
      { n: 3, name: 'AHN Patient Data Integration',     account: 'AHN',                       stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-30', fa: 1950000, ta: 2350000, flm: 'Yes', ns: 'MSA being finalized. Procurement expects signature by Sept 26.',   score: 87, tier: 'High'   },
      { n: 4, name: 'UPMC Health Plan Automation',      account: 'UPMC Health Plan',          stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 520000,  ta: 650000,  flm: 'No',  ns: 'Initial scoping call complete. Needs IT director approval.',        score: 57, tier: 'Medium' },
      { n: 5, name: 'Heritage Valley Health AI',        account: 'Heritage Valley Health',    stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 275000,  ta: 345000,  flm: 'No',  ns: 'Discovery session scheduled Aug 11.',                              score: 43, tier: 'Medium' },
      { n: 6, name: 'St Clair Health Modernization',    account: 'St. Clair Health',          stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 180000,  ta: 225000,  flm: 'No',  ns: null,                                                                score: 33, tier: 'Low'    },
    ],
  },
  'junderwood@ibm.com': {
    label: 'Jeff Underwood (HCA)',
    prefix: 'JU',
    deals: [
      { n: 1, name: 'HCA watsonx Surgical AI',          account: 'HCA Healthcare',            stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 2400000, ta: 2950000, flm: 'Yes', ns: 'Final pricing negotiation underway. Close target Sept 12.',        score: 91, tier: 'High'   },
      { n: 2, name: 'HCA Cloud Infrastructure Phase 2', account: 'HCA Healthcare',            stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1650000, ta: 2000000, flm: 'Yes', ns: 'Technical SOW delivered. Business case review Aug 8.',             score: 84, tier: 'High'   },
      { n: 3, name: 'TriStar Health Analytics',         account: 'TriStar Health',            stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 780000,  ta: 980000,  flm: 'Yes', ns: 'Design sprint completed. Implementation plan in review.',          score: 75, tier: 'High'   },
      { n: 4, name: 'Sarah Cannon Research AI',         account: 'Sarah Cannon Research',     stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 560000,  ta: 700000,  flm: 'No',  ns: 'Scoping workshop July 30.',                                        score: 58, tier: 'Medium' },
      { n: 5, name: 'Medical City Dallas Modernize',    account: 'Medical City Dallas',       stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 340000,  ta: 425000,  flm: 'No',  ns: 'Exec intro meeting booked.',                                       score: 47, tier: 'Medium' },
      { n: 6, name: 'Centennial Medical Center Cloud',  account: 'Centennial Medical',        stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 210000,  ta: 265000,  flm: 'No',  ns: null,                                                                score: 36, tier: 'Low'    },
    ],
  },
  'marsal@us.ibm.com': {
    label: 'Michael Marsalis (BCBS SC)',
    prefix: 'MM',
    deals: [
      { n: 1, name: 'BCBS SC Claims AI Automation',     account: 'BlueCross BlueShield SC',   stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 1700000, ta: 2100000, flm: 'Yes', ns: 'Contract in legal. IT steering committee approved Aug 1.',         score: 88, tier: 'High'   },
      { n: 2, name: 'BCBS SC Data Lake Modernization',  account: 'BlueCross BlueShield SC',   stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1050000, ta: 1280000, flm: 'Yes', ns: 'Proposal presented to CTO July 18. Awaiting feedback.',            score: 79, tier: 'High'   },
      { n: 3, name: 'Palmetto Health Hybrid Cloud',     account: 'Palmetto Health',           stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 670000,  ta: 840000,  flm: 'Yes', ns: 'Architecture finalized. Entering procurement process.',             score: 73, tier: 'High'   },
      { n: 4, name: 'Prisma Health Analytics',          account: 'Prisma Health',             stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 430000,  ta: 540000,  flm: 'No',  ns: 'Discovery call July 28 with data science team.',                   score: 54, tier: 'Medium' },
      { n: 5, name: 'Conway Medical Center AI',         account: 'Conway Medical Center',     stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 265000,  ta: 330000,  flm: 'No',  ns: 'Introductory meeting scheduled.',                                  score: 42, tier: 'Medium' },
      { n: 6, name: 'Lexington Medical Modernize',      account: 'Lexington Medical',         stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 175000,  ta: 220000,  flm: 'No',  ns: null,                                                                score: 31, tier: 'Low'    },
    ],
  },
  'kcrum@us.ibm.com': {
    label: 'Ken Crum (ATL)',
    prefix: 'KC',
    deals: [
      { n: 1, name: 'Cigna watsonx Risk Analytics',     account: 'Cigna',                     stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1550000, ta: 1900000, flm: 'Yes', ns: 'Technical proposal delivered. Architecture review Aug 9.',         score: 82, tier: 'High'   },
      { n: 2, name: 'Aetna Cloud Transformation',       account: 'Aetna / CVS Health',        stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 1100000, ta: 1350000, flm: 'Yes', ns: 'Design phase kicked off. Weekly syncs with Aetna IT.',             score: 77, tier: 'High'   },
      { n: 3, name: 'United Health Group AI Ops',       account: 'UnitedHealth Group',        stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 2300000, ta: 2800000, flm: 'Yes', ns: 'MSA signature expected by Aug 22. Legal aligned.',                 score: 90, tier: 'High'   },
      { n: 4, name: 'Anthem Claims Automation',         account: 'Anthem / Elevance Health',  stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 610000,  ta: 760000,  flm: 'No',  ns: 'RFP response submitted. Shortlist decision Aug 15.',                score: 59, tier: 'Medium' },
      { n: 5, name: 'Humana Member Analytics',          account: 'Humana',                    stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 380000,  ta: 475000,  flm: 'No',  ns: 'Executive sponsor identified. Kickoff call pending.',              score: 48, tier: 'Medium' },
      { n: 6, name: 'Molina Healthcare Modernize',      account: 'Molina Healthcare',         stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 230000,  ta: 290000,  flm: 'No',  ns: null,                                                                score: 37, tier: 'Low'    },
    ],
  },
  'andy.quintana@ibm.com': {
    label: 'Andy Quintana (ATL Mgr)',
    prefix: 'AQ',
    deals: [
      { n: 1, name: 'Ascension Health AI Platform',     account: 'Ascension Health',          stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-22', fa: 1950000, ta: 2400000, flm: 'Yes', ns: 'Contract routing for signature. Final close Sept 18.',             score: 87, tier: 'High'   },
      { n: 2, name: 'CommonSpirit Cloud Ops',           account: 'CommonSpirit Health',       stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-15', fa: 1250000, ta: 1550000, flm: 'Yes', ns: 'Proposal under executive review. Decision expected Aug 12.',       score: 80, tier: 'High'   },
      { n: 3, name: 'SSM Health Hybrid Cloud',          account: 'SSM Health',                stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 820000,  ta: 1020000, flm: 'Yes', ns: 'Design blueprint approved. Moving to procurement stage.',          score: 74, tier: 'High'   },
      { n: 4, name: 'Bon Secours Analytics',            account: 'Bon Secours Mercy Health',  stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 490000,  ta: 615000,  flm: 'No',  ns: 'IT discovery session booked for Aug 3.',                           score: 55, tier: 'Medium' },
      { n: 5, name: 'Providence Health Data AI',        account: 'Providence Health',         stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 320000,  ta: 400000,  flm: 'No',  ns: 'Initial contact made. Follow-up call pending.',                    score: 44, tier: 'Medium' },
      { n: 6, name: 'Dignity Health Modernize',         account: 'Dignity Health',            stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 200000,  ta: 250000,  flm: 'No',  ns: null,                                                                score: 34, tier: 'Low'    },
    ],
  },
  'bcoyle@us.ibm.com': {
    label: 'Brian Coyle (Horizon BCBS NJ)',
    prefix: 'BC',
    deals: [
      { n: 1, name: 'Horizon BCBS NJ AI Claims',        account: 'Horizon Blue Cross NJ',     stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1600000, ta: 1950000, flm: 'Yes', ns: 'Final proposal delivered July 17. Exec review in progress.',       score: 84, tier: 'High'   },
      { n: 2, name: 'Horizon BCBS NJ Cloud Migration',  account: 'Horizon Blue Cross NJ',     stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 1050000, ta: 1300000, flm: 'Yes', ns: 'Architecture approved. SOW under legal review.',                   score: 76, tier: 'High'   },
      { n: 3, name: 'RWJBarnabas Health watsonx Pilot', account: 'RWJBarnabas Health',        stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 2050000, ta: 2500000, flm: 'Yes', ns: 'Negotiating final contract terms. Procurement aligned.',            score: 88, tier: 'High'   },
      { n: 4, name: 'Atlantic Health Automation',       account: 'Atlantic Health System',    stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 555000,  ta: 695000,  flm: 'No',  ns: 'Requirements workshop scheduled Aug 7.',                           score: 56, tier: 'Medium' },
      { n: 5, name: 'Hackensack Meridian Cloud',        account: 'Hackensack Meridian',       stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 350000,  ta: 440000,  flm: 'No',  ns: 'CIO intro meeting booked.',                                        score: 45, tier: 'Medium' },
      { n: 6, name: 'Virtua Health Modernize',          account: 'Virtua Health',             stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 215000,  ta: 270000,  flm: 'No',  ns: null,                                                                score: 36, tier: 'Low'    },
    ],
  },
};

const ALL_USERS = Object.keys(USER_SEED_TEMPLATES);
const isDry = process.argv.includes('--dry-run');

const STAGE_NEXT = { Identify: 'Qualify', Qualify: 'Engage', Engage: 'Design', Design: 'Propose', Propose: 'Negotiate' };
function promoteStage(s) { return STAGE_NEXT[s] || s; }
function slipDate(d, days) {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function buildRows(userId) {
  const tmpl = USER_SEED_TEMPLATES[userId];
  return tmpl.deals.map(d => ({
    id:                          `${tmpl.prefix}-${String(d.n).padStart(3, '0')}`,
    opportunity_name:            `[SEED] ${d.name}`,
    account_name:                d.account,
    stage:                       d.stage,
    forecast_category:           d.fc,
    close_date:                  d.cd,
    filtered_opportunity_amount: d.fa,
    total_opportunity_amount:    d.ta,
    opportunity_owner:           tmpl.label,
    flm_judgement:               d.flm,
    next_steps:                  d.ns ?? null,
    score:                       d.score,
    tier:                        d.tier,
    user_id:                     userId,
  }));
}

// Week-3 mutations so the diff engine has something interesting to show
function applyMutations(opps) {
  const m = opps.slice();
  // Week 2 mutations
  if (m[1]) m[1] = { ...m[1], stage: promoteStage(m[1].stage) };
  if (m[2]) m[2] = { ...m[2], total_opportunity_amount: Math.round(m[2].total_opportunity_amount * 1.20) };
  if (m[5]) m[5] = { ...m[5], close_date: slipDate(m[5].close_date, 31) };
  // Week 3 mutations
  if (m[0]) m[0] = { ...m[0], stage: promoteStage(m[0].stage) };
  if (m[3]) m[3] = { ...m[3], total_opportunity_amount: Math.round(m[3].total_opportunity_amount * 0.75) };
  if (m[4]) m[4] = { ...m[4], close_date: slipDate(m[4].close_date, -14) };
  if (m[1]) m[1] = { ...m[1], next_steps: '' };
  return m;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('  Day 0 Reset — ALL 9 users' + (isDry ? ' [DRY RUN]' : ''));
console.log(`${'─'.repeat(60)}\n`);

if (isDry) {
  console.log('Step 1: Would DELETE all rows from opportunities and baseline_ledger');
  console.log('Step 2: Would INSERT 6 seed deals per user (54 rows total)');
  console.log('Step 3: Would save Week 1 confirmed baseline per user (9 baselines)');
  console.log('Step 4: Would apply Week 3 mutations to live rows\n');
  ALL_USERS.forEach(u => console.log(`  ${u}  (${USER_SEED_TEMPLATES[u].prefix}-001 … ${USER_SEED_TEMPLATES[u].prefix}-006)`));
  console.log('\n[DRY RUN] Nothing written.\n');
  process.exit(0);
}

// Step 1 — Wipe everything
const delOpps    = db.prepare('DELETE FROM opportunities').run();
const delLedger  = db.prepare('DELETE FROM baseline_ledger').run();
console.log(`Step 1 ✅  Wiped ${delOpps.changes} opportunities, ${delLedger.changes} baseline_ledger rows\n`);

// Step 2 + 3 + 4 — Seed each user
const ins = db.prepare(`
  INSERT OR REPLACE INTO opportunities
    (id, opportunity_name, account_name, stage, forecast_category,
     close_date, filtered_opportunity_amount, total_opportunity_amount,
     opportunity_owner, flm_judgement, next_steps, team_notes, score, tier, user_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const upd = db.prepare(`UPDATE opportunities SET
  stage=?, forecast_category=?, close_date=?,
  filtered_opportunity_amount=?, total_opportunity_amount=?,
  next_steps=?, score=?, tier=? WHERE id=? AND user_id=?`);

const w1date = new Date('2026-07-11T10:00:00.000Z');

console.log('Step 2–4  Seeding users…\n');
for (const userId of ALL_USERS) {
  const rows    = buildRows(userId);
  const mutated = applyMutations(rows);

  // Insert Week 1 state
  db.transaction(() => {
    rows.forEach(r => ins.run(
      r.id, r.opportunity_name, r.account_name, r.stage, r.forecast_category,
      r.close_date, r.filtered_opportunity_amount, r.total_opportunity_amount,
      r.opportunity_owner, r.flm_judgement, r.next_steps, null, r.score, r.tier, r.user_id
    ));
  })();

  // Save Week 1 confirmed baseline
  const snap = saveSnapshot(db, { confirmed: true, now: w1date, userId });

  // Apply Week 3 live mutations
  db.transaction(() => {
    mutated.forEach(r => upd.run(
      r.stage, r.forecast_category, r.close_date,
      r.filtered_opportunity_amount, r.total_opportunity_amount,
      r.next_steps ?? null, r.score, r.tier, r.id, r.user_id
    ));
  })();

  console.log(`  ✅  ${userId.padEnd(36)} 6 deals  baseline: ${snap.weekLabel}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log('  Day 0 complete — 54 seed rows, 9 baselines written');
console.log('  Restart the server, then log in as any user.');
console.log(`  To restore Duey's real data: node scraper/load-from-har.js <har>`);
console.log(`${'─'.repeat(60)}\n`);
