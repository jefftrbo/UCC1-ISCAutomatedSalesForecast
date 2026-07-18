#!/usr/bin/env node
/**
 * scripts/seed-quarter.js  (v2.4.0)
 *
 * Multi-tenant UI Smoke Test Helper
 * ──────────────────────────────────
 * Seeds synthetic pipeline data per user so every IBM test user has a
 * realistic, distinct pipeline to demonstrate the full UI/UX flow.
 *
 * Usage:
 *   node scripts/seed-quarter.js --user trbovich@us.ibm.com
 *       # seed 6 deals for Jeff + Week 1 baseline + Week 3 live mutations
 *   node scripts/seed-quarter.js --all
 *       # seed ALL non-primary users at once (8 users from the users table,
 *         skipping dkpatel@us.ibm.com who already has real data)
 *   node scripts/seed-quarter.js --status [--user ...]
 *       # show SEED rows in the pipeline (all users, or scoped to --user)
 *   node scripts/seed-quarter.js --restore [--user ...]
 *       # remove SEED rows (all users, or scoped to --user)
 *   node scripts/seed-quarter.js --dry-run --user ...
 *       # show what would happen without writing
 *
 *   Legacy (no --user):
 *   node scripts/seed-quarter.js
 *       # seeds for the primary user (dkpatel@us.ibm.com) — backward compat
 */

'use strict';

const db     = require('../server/db');
const { saveSnapshot } = require('../server/diffEngine');

const args      = process.argv.slice(2);
const isDry     = args.includes('--dry-run');
const isStatus  = args.includes('--status');
const isRestore = args.includes('--restore');
const isAll     = args.includes('--all');
const weekIdx   = args.findIndex(a => a === '--week');
const targetWeek = weekIdx >= 0 ? parseInt(args[weekIdx + 1]) || 3 : 3;

// --user <ibm_id>
const userIdx = args.findIndex(a => a === '--user');
const userArg = userIdx >= 0 ? args[userIdx + 1] : null;

// Primary user — owns the real HAR data, never seeded synthetically
const PRIMARY_USER = 'dkpatel@us.ibm.com';

// ── Resolve which users to operate on ────────────────────────────────────────
function resolveUsers() {
  if (userArg) return [userArg.toLowerCase().trim()];
  if (isAll) {
    const all = db.prepare('SELECT ibm_id FROM users WHERE ibm_id != ?').all(PRIMARY_USER);
    return all.map(u => u.ibm_id);
  }
  // Legacy: no flag = primary user
  return [PRIMARY_USER];
}

// ── Per-user seed data: distinct accounts/deals per person ───────────────────
// Each user gets 6 deals spread across stages so the diff engine has something
// interesting to show (promotions, amount changes, slippage) after mutations.
// IDs are namespaced by user initials to ensure global uniqueness.
const USER_SEED_TEMPLATES = {
  'trbovich@us.ibm.com': {
    label: 'Jeff Trbovich (UPMC)',
    prefix: 'JT',
    deals: [
      { n: 1, name: 'UPMC watsonx Clinical AI',         account: 'UPMC',                    stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 1800000, ta: 2200000, flm: 'Yes', ns: 'Contract redlines received. Legal review in progress.',           score: 86, tier: 'High'   },
      { n: 2, name: 'Highmark Health Data Platform',     account: 'Highmark Health',          stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 950000,  ta: 1150000, flm: 'Yes', ns: 'Proposal submitted July 14. Awaiting Highmark procurement review.', score: 78, tier: 'High'   },
      { n: 3, name: 'Children\'s Hospital AI Pilot',     account: 'CHOP',                     stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 620000,  ta: 780000,  flm: 'Yes', ns: 'Architecture workshop completed. SOW being drafted.',             score: 72, tier: 'High'   },
      { n: 4, name: 'Penn Medicine Hybrid Cloud',        account: 'Penn Medicine',            stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 480000,  ta: 600000,  flm: 'No',  ns: 'Discovery call done. Budget approval pending Q3 board meeting.',   score: 55, tier: 'Medium' },
      { n: 5, name: 'Jefferson Health Automation',       account: 'Jefferson Health',         stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 310000,  ta: 390000,  flm: 'No',  ns: 'Initial meeting scheduled Aug 4 with CIO office.',                score: 44, tier: 'Medium' },
      { n: 6, name: 'Temple Health Records Modernize',   account: 'Temple Health',            stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 225000,  ta: 280000,  flm: 'No',  ns: null,                                                              score: 38, tier: 'Low'    },
    ],
  },
  'spencer.korn@ibm.com': {
    label: 'Spencer Korn',
    prefix: 'SK',
    deals: [
      { n: 1, name: 'Mayo Clinic AI Operations',        account: 'Mayo Clinic',              stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-22', fa: 2100000, ta: 2600000, flm: 'Yes', ns: 'Final T&Cs under review. Close target Sept 19.',                  score: 89, tier: 'High'   },
      { n: 2, name: 'Cleveland Clinic Cloud Migration',  account: 'Cleveland Clinic',         stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-15', fa: 1100000, ta: 1350000, flm: 'Yes', ns: 'Technical proposal delivered. Waiting for exec sponsor sign-off.',score: 81, tier: 'High'   },
      { n: 3, name: 'Geisinger Health Analytics',       account: 'Geisinger Health',         stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 730000,  ta: 910000,  flm: 'Yes', ns: 'Use case finalized. SOW in legal review.',                        score: 74, tier: 'High'   },
      { n: 4, name: 'Vanderbilt Health Modernize',      account: 'Vanderbilt Health',        stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 445000,  ta: 560000,  flm: 'No',  ns: 'RFI response submitted. Awaiting shortlist decision.',             score: 52, tier: 'Medium' },
      { n: 5, name: 'Mass General AI Diagnostics',      account: 'Mass General Hospital',    stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 290000,  ta: 365000,  flm: 'No',  ns: 'Exec briefing booked Aug 6.',                                     score: 46, tier: 'Medium' },
      { n: 6, name: 'Brigham Womens Data Ops',          account: 'Brigham & Women\'s Hosp.', stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 190000,  ta: 240000,  flm: 'No',  ns: null,                                                              score: 35, tier: 'Low'    },
    ],
  },
  'kim.salatino@ibm.com': {
    label: 'Kim Salatino (UPMC TSL)',
    prefix: 'KS',
    deals: [
      { n: 1, name: 'UPMC Genomics AI Platform',        account: 'UPMC Enterprises',         stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1400000, ta: 1750000, flm: 'Yes', ns: 'Proposal in final review with genomics leadership team.',         score: 83, tier: 'High'   },
      { n: 2, name: 'Allegheny Health Network Cloud',   account: 'Allegheny Health Network', stage: 'Design',    fc: 'Best Case',  cd: '2026-09-15', fa: 860000,  ta: 1050000, flm: 'Yes', ns: 'Architecture review Aug 5 with CTO.',                             score: 76, tier: 'High'   },
      { n: 3, name: 'AHN Patient Data Integration',     account: 'AHN',                      stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-30', fa: 1950000, ta: 2350000, flm: 'Yes', ns: 'MSA being finalized. Procurement expects signature by Sept 26.',  score: 87, tier: 'High'   },
      { n: 4, name: 'UPMC Health Plan Automation',      account: 'UPMC Health Plan',         stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 520000,  ta: 650000,  flm: 'No',  ns: 'Initial scoping call complete. Needs IT director approval.',       score: 57, tier: 'Medium' },
      { n: 5, name: 'Heritage Valley Health AI',        account: 'Heritage Valley Health',   stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 275000,  ta: 345000,  flm: 'No',  ns: 'Discovery session scheduled Aug 11.',                             score: 43, tier: 'Medium' },
      { n: 6, name: 'St Clair Health Modernization',    account: 'St. Clair Health',         stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 180000,  ta: 225000,  flm: 'No',  ns: null,                                                              score: 33, tier: 'Low'    },
    ],
  },
  'junderwood@ibm.com': {
    label: 'Jeff Underwood (HCA)',
    prefix: 'JU',
    deals: [
      { n: 1, name: 'HCA watsonx Surgical AI',          account: 'HCA Healthcare',           stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 2400000, ta: 2950000, flm: 'Yes', ns: 'Final pricing negotiation underway. Close target Sept 12.',       score: 91, tier: 'High'   },
      { n: 2, name: 'HCA Cloud Infrastructure Phase 2', account: 'HCA Healthcare',           stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1650000, ta: 2000000, flm: 'Yes', ns: 'Technical SOW delivered. Business case review Aug 8.',            score: 84, tier: 'High'   },
      { n: 3, name: 'TriStar Health Analytics',         account: 'TriStar Health',           stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 780000,  ta: 980000,  flm: 'Yes', ns: 'Design sprint completed. Implementation plan in review.',         score: 75, tier: 'High'   },
      { n: 4, name: 'Sarah Cannon Research AI',         account: 'Sarah Cannon Research',    stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 560000,  ta: 700000,  flm: 'No',  ns: 'Scoping workshop July 30.',                                       score: 58, tier: 'Medium' },
      { n: 5, name: 'Medical City Dallas Modernize',    account: 'Medical City Dallas',      stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 340000,  ta: 425000,  flm: 'No',  ns: 'Exec intro meeting booked.',                                      score: 47, tier: 'Medium' },
      { n: 6, name: 'Centennial Medical Center Cloud',  account: 'Centennial Medical',       stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 210000,  ta: 265000,  flm: 'No',  ns: null,                                                              score: 36, tier: 'Low'    },
    ],
  },
  'marsal@us.ibm.com': {
    label: 'Michael Marsalis (BCBS SC)',
    prefix: 'MM',
    deals: [
      { n: 1, name: 'BCBS SC Claims AI Automation',     account: 'BlueCross BlueShield SC',  stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 1700000, ta: 2100000, flm: 'Yes', ns: 'Contract in legal. IT steering committee approved Aug 1.',        score: 88, tier: 'High'   },
      { n: 2, name: 'BCBS SC Data Lake Modernization',  account: 'BlueCross BlueShield SC',  stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1050000, ta: 1280000, flm: 'Yes', ns: 'Proposal presented to CTO July 18. Awaiting feedback.',           score: 79, tier: 'High'   },
      { n: 3, name: 'Palmetto Health Hybrid Cloud',     account: 'Palmetto Health',          stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 670000,  ta: 840000,  flm: 'Yes', ns: 'Architecture finalized. Entering procurement process.',            score: 73, tier: 'High'   },
      { n: 4, name: 'Prisma Health Analytics',          account: 'Prisma Health',            stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 430000,  ta: 540000,  flm: 'No',  ns: 'Discovery call July 28 with data science team.',                  score: 54, tier: 'Medium' },
      { n: 5, name: 'Conway Medical Center AI',         account: 'Conway Medical Center',    stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 265000,  ta: 330000,  flm: 'No',  ns: 'Introductory meeting scheduled.',                                 score: 42, tier: 'Medium' },
      { n: 6, name: 'Lexington Medical Modernize',      account: 'Lexington Medical',        stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 175000,  ta: 220000,  flm: 'No',  ns: null,                                                              score: 31, tier: 'Low'    },
    ],
  },
  'kcrum@us.ibm.com': {
    label: 'Ken Crum (ATL)',
    prefix: 'KC',
    deals: [
      { n: 1, name: 'Cigna watsonx Risk Analytics',     account: 'Cigna',                    stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1550000, ta: 1900000, flm: 'Yes', ns: 'Technical proposal delivered. Architecture review Aug 9.',        score: 82, tier: 'High'   },
      { n: 2, name: 'Aetna Cloud Transformation',       account: 'Aetna / CVS Health',       stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 1100000, ta: 1350000, flm: 'Yes', ns: 'Design phase kicked off. Weekly syncs with Aetna IT.',            score: 77, tier: 'High'   },
      { n: 3, name: 'United Health Group AI Ops',       account: 'UnitedHealth Group',       stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 2300000, ta: 2800000, flm: 'Yes', ns: 'MSA signature expected by Aug 22. Legal aligned.',                score: 90, tier: 'High'   },
      { n: 4, name: 'Anthem Claims Automation',         account: 'Anthem / Elevance Health', stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 610000,  ta: 760000,  flm: 'No',  ns: 'RFP response submitted. Shortlist decision Aug 15.',               score: 59, tier: 'Medium' },
      { n: 5, name: 'Humana Member Analytics',          account: 'Humana',                   stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 380000,  ta: 475000,  flm: 'No',  ns: 'Executive sponsor identified. Kickoff call pending.',             score: 48, tier: 'Medium' },
      { n: 6, name: 'Molina Healthcare Modernize',      account: 'Molina Healthcare',        stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 230000,  ta: 290000,  flm: 'No',  ns: null,                                                              score: 37, tier: 'Low'    },
    ],
  },
  'andy.quintana@ibm.com': {
    label: 'Andy Quintana (ATL Mgr)',
    prefix: 'AQ',
    deals: [
      { n: 1, name: 'Ascension Health AI Platform',     account: 'Ascension Health',         stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-22', fa: 1950000, ta: 2400000, flm: 'Yes', ns: 'Contract routing for signature. Final close Sept 18.',            score: 87, tier: 'High'   },
      { n: 2, name: 'CommonSpirit Cloud Ops',           account: 'CommonSpirit Health',      stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-15', fa: 1250000, ta: 1550000, flm: 'Yes', ns: 'Proposal under executive review. Decision expected Aug 12.',      score: 80, tier: 'High'   },
      { n: 3, name: 'SSM Health Hybrid Cloud',          account: 'SSM Health',               stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 820000,  ta: 1020000, flm: 'Yes', ns: 'Design blueprint approved. Moving to procurement stage.',         score: 74, tier: 'High'   },
      { n: 4, name: 'Bon Secours Analytics',            account: 'Bon Secours Mercy Health', stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 490000,  ta: 615000,  flm: 'No',  ns: 'IT discovery session booked for Aug 3.',                          score: 55, tier: 'Medium' },
      { n: 5, name: 'Providence Health Data AI',        account: 'Providence Health',        stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 320000,  ta: 400000,  flm: 'No',  ns: 'Initial contact made. Follow-up call pending.',                   score: 44, tier: 'Medium' },
      { n: 6, name: 'Dignity Health Modernize',         account: 'Dignity Health',           stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 200000,  ta: 250000,  flm: 'No',  ns: null,                                                              score: 34, tier: 'Low'    },
    ],
  },
  'bcoyle@us.ibm.com': {
    label: 'Brian Coyle (Horizon BCBS NJ)',
    prefix: 'BC',
    deals: [
      { n: 1, name: 'Horizon BCBS NJ AI Claims',        account: 'Horizon Blue Cross NJ',    stage: 'Propose',   fc: 'Best Case',  cd: '2026-09-22', fa: 1600000, ta: 1950000, flm: 'Yes', ns: 'Final proposal delivered July 17. Exec review in progress.',      score: 84, tier: 'High'   },
      { n: 2, name: 'Horizon BCBS NJ Cloud Migration',  account: 'Horizon Blue Cross NJ',    stage: 'Design',    fc: 'Best Case',  cd: '2026-09-30', fa: 1050000, ta: 1300000, flm: 'Yes', ns: 'Architecture approved. SOW under legal review.',                  score: 76, tier: 'High'   },
      { n: 3, name: 'RWJBarnabas Health watsonx Pilot', account: 'RWJBarnabas Health',       stage: 'Negotiate', fc: 'Best Case',  cd: '2026-09-15', fa: 2050000, ta: 2500000, flm: 'Yes', ns: 'Negotiating final contract terms. Procurement aligned.',           score: 88, tier: 'High'   },
      { n: 4, name: 'Atlantic Health Automation',       account: 'Atlantic Health System',   stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-09-30', fa: 555000,  ta: 695000,  flm: 'No',  ns: 'Requirements workshop scheduled Aug 7.',                          score: 56, tier: 'Medium' },
      { n: 5, name: 'Hackensack Meridian Cloud',        account: 'Hackensack Meridian',      stage: 'Engage',    fc: 'Pipeline',   cd: '2026-09-30', fa: 350000,  ta: 440000,  flm: 'No',  ns: 'CIO intro meeting booked.',                                       score: 45, tier: 'Medium' },
      { n: 6, name: 'Virtua Health Modernize',          account: 'Virtua Health',            stage: 'Qualify',   fc: 'Pipeline',   cd: '2026-10-31', fa: 215000,  ta: 270000,  flm: 'No',  ns: null,                                                              score: 36, tier: 'Low'    },
    ],
  },
};

// ── Build SEED rows for a given user ─────────────────────────────────────────
function buildSeedRows(userId) {
  const tmpl = USER_SEED_TEMPLATES[userId];
  if (!tmpl) {
    // Fallback for any user not in the template map — generate generic rows
    const shortId = userId.split('@')[0].replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase();
    return Array.from({ length: 6 }, (_, i) => ({
      id:                          `${shortId}-${String(i + 1).padStart(3, '0')}`,
      opportunity_name:            `[SEED] Generic Deal ${i + 1} for ${userId}`,
      account_name:                `Test Account ${i + 1}`,
      stage:                       ['Qualify', 'Engage', 'Design', 'Propose', 'Negotiate', 'Qualify'][i],
      forecast_category:           i < 3 ? 'Best Case' : 'Pipeline',
      close_date:                  i < 4 ? '2026-09-30' : '2026-10-31',
      filtered_opportunity_amount: (i + 1) * 200000,
      total_opportunity_amount:    (i + 1) * 250000,
      opportunity_owner:           userId,
      flm_judgement:               i < 3 ? 'Yes' : 'No',
      next_steps:                  i < 4 ? `Next step for deal ${i + 1}.` : null,
      score:                       85 - i * 12,
      tier:                        i < 2 ? 'High' : i < 4 ? 'Medium' : 'Low',
      user_id:                     userId,
    }));
  }
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

// ── Week mutations — applied per-user after seed insert ───────────────────────
function applyMutations(opps, week) {
  const m = opps.slice(); // shallow copy
  if (week >= 2) {
    // Deal 2: promote one stage
    if (m[1]) m[1] = { ...m[1], stage: promoteStage(m[1].stage) };
    // Deal 3: upsell +20%
    if (m[2]) m[2] = { ...m[2], total_opportunity_amount: Math.round(m[2].total_opportunity_amount * 1.20) };
    // Deal 6: slip close date by 31 days
    if (m[5]) m[5] = { ...m[5], close_date: slipDate(m[5].close_date, 31) };
  }
  if (week >= 3) {
    // Deal 1: promote one stage
    if (m[0]) m[0] = { ...m[0], stage: promoteStage(m[0].stage) };
    // Deal 4: amount reduced -25%
    if (m[3]) m[3] = { ...m[3], total_opportunity_amount: Math.round(m[3].total_opportunity_amount * 0.75) };
    // Deal 5: close date pulled in 14 days
    if (m[4]) m[4] = { ...m[4], close_date: slipDate(m[4].close_date, -14) };
    // Deal 2: blank next_steps (hygiene flag)
    if (m[1]) m[1] = { ...m[1], next_steps: '' };
  }
  return m;
}

const STAGE_NEXT = { Identify: 'Qualify', Qualify: 'Engage', Engage: 'Design', Design: 'Propose', Propose: 'Negotiate' };
function promoteStage(s) { return STAGE_NEXT[s] || s; }
function slipDate(d, days) {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ── Seed one user ─────────────────────────────────────────────────────────────
function seedUser(userId) {
  const seedPrefix = userId.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  const pattern    = `${seedPrefix}-%`;

  const existing = db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE id LIKE ? AND user_id = ?").get(pattern, userId).n;
  if (existing > 0 && !isDry) {
    console.log(`⚠  ${existing} SEED rows already exist for ${userId}. Run --restore --user ${userId} first.`);
    return false;
  }

  const seedRows   = buildSeedRows(userId);
  const w1date     = new Date('2026-07-11T10:00:00.000Z');
  const liveMutated = applyMutations(seedRows, targetWeek);

  if (isDry) {
    console.log(`[DRY RUN] Would insert ${seedRows.length} SEED rows for ${userId} and save Week 1 baseline.`);
    console.log(`[DRY RUN] Would apply week-${targetWeek} mutations.`);
    return true;
  }

  const ins = db.prepare(`
    INSERT OR IGNORE INTO opportunities
      (id, opportunity_name, account_name, stage, forecast_category,
       close_date, filtered_opportunity_amount, total_opportunity_amount,
       opportunity_owner, flm_judgement, next_steps, team_notes, score, tier, user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Insert Week 1 baseline state (unmutated)
  db.transaction(() => { seedRows.forEach(r => ins.run(
    r.id, r.opportunity_name, r.account_name, r.stage, r.forecast_category,
    r.close_date, r.filtered_opportunity_amount, r.total_opportunity_amount,
    r.opportunity_owner, r.flm_judgement, r.next_steps, null, r.score, r.tier, r.user_id
  )); })();

  // Save Week 1 confirmed baseline for this user
  const snap = saveSnapshot(db, { confirmed: true, now: w1date, userId });
  console.log(`  ✓ Week 1 baseline saved — ${snap.snapshotId.slice(0, 8)}… (${snap.weekLabel})`);

  // Apply live mutations (Week 2 or 3)
  const upd = db.prepare(`UPDATE opportunities SET
    stage=?, forecast_category=?, close_date=?,
    filtered_opportunity_amount=?, total_opportunity_amount=?,
    next_steps=?, score=?, tier=? WHERE id=? AND user_id=?`);
  db.transaction(() => { liveMutated.forEach(r => upd.run(
    r.stage, r.forecast_category, r.close_date,
    r.filtered_opportunity_amount, r.total_opportunity_amount,
    r.next_steps ?? null, r.score, r.tier, r.id, r.user_id
  )); })();

  const tmpl = USER_SEED_TEMPLATES[userId];
  console.log(`✅ ${userId.padEnd(36)} ${seedRows.length} deals seeded  (${tmpl ? tmpl.label : 'generic'})`);
  return true;
}

// ── --status ──────────────────────────────────────────────────────────────────
if (isStatus) {
  const users = resolveUsers();
  for (const uid of users) {
    const rows = db.prepare("SELECT id, stage, close_date, next_steps FROM opportunities WHERE user_id = ? AND (id GLOB '*-0*') ORDER BY id").all(uid);
    console.log(`\n${uid}: ${rows.length} SEED rows`);
    rows.forEach(r => console.log(`  ${r.id}  ${(r.stage || '').padEnd(12)}  ${r.close_date}  NS: ${r.next_steps?.slice(0, 40) || '(blank)'}`));
  }
  process.exit(0);
}

// ── --restore ─────────────────────────────────────────────────────────────────
if (isRestore) {
  const users = resolveUsers();
  let totalOpps = 0, totalLedger = 0;
  for (const uid of users) {
    if (isDry) { console.log(`[DRY RUN] Would remove all SEED rows for ${uid}.`); continue; }
    const seedRows = buildSeedRows(uid);
    const ids = seedRows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const d1 = db.prepare(`DELETE FROM opportunities WHERE id IN (${placeholders}) AND user_id = ?`).run(...ids, uid);
    const d2 = db.prepare(`DELETE FROM baseline_ledger WHERE user_id = ? AND id IN (${placeholders})`).run(uid, ...ids);
    console.log(`  ${uid}: removed ${d1.changes} opps, ${d2.changes} ledger rows`);
    totalOpps += d1.changes; totalLedger += d2.changes;
  }
  if (!isDry) console.log(`\n✅ Restore complete: ${totalOpps} opportunities, ${totalLedger} baseline_ledger rows removed.`);
  process.exit(0);
}

// ── Main: seed ────────────────────────────────────────────────────────────────
const usersToSeed = resolveUsers();
console.log(`\nSeeding ${usersToSeed.length} user(s) — Week ${targetWeek} live state...\n`);
for (const uid of usersToSeed) {
  seedUser(uid);
}
if (!isDry) {
  console.log(`\n────────────────────────────────────────────────────────
  Done. In your browser (http://localhost:3090):

  1. Log out and log back in as any seeded user
  2. Each user sees their own distinct pipeline
  3. "⇄ What Changed" shows promotions, amount changes, slippage
     vs. the simulated Week 1 baseline
  4. "✅ Confirm & Generate" locks a new baseline for that user only

  To reset: node scripts/seed-quarter.js --restore --all
────────────────────────────────────────────────────────`);
}
