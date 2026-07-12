/**
 * server/watsonxScore.js
 *
 * IBM watsonx.ai confidence scoring engine for ISC sales opportunities.
 * v2.0.0 — replaces keyword-based heuristics with Granite foundation model inference.
 *
 * Modes:
 *   LIVE   — WATSONX_ENABLED=true  + valid API key + project ID in .env
 *   MOCK   — WATSONX_ENABLED=false (default) — returns deterministic mock scores
 *            so the full UI can be tested without credentials.
 *
 * watsonx.ai API:
 *   POST {WATSONX_URL}/ml/v1/text/generation?version=2023-05-29
 *   Authorization: Bearer {iam_token}
 *   Body: { model_id, input, parameters, project_id }
 *
 * Model: ibm/granite-13b-instruct-v2
 *   IBM-native, instruction-tuned, strong JSON output, free on IBM Cloud Lite.
 *   Fallback: ibm/granite-3-8b-instruct (faster, cheaper for simpler tasks)
 */

'use strict';
require('dotenv').config();
const https = require('https');

// ── Configuration ──────────────────────────────────────────────────────────────
const WATSONX_ENABLED  = process.env.WATSONX_ENABLED === 'true';
const WATSONX_URL      = (process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com').replace(/\/$/, '');
const WATSONX_API_KEY  = process.env.WATSONX_API_KEY  || '';
const WATSONX_PROJECT  = process.env.WATSONX_PROJECT_ID || '';
const IAM_TOKEN_URL    = 'https://iam.cloud.ibm.com/identity/token';
const MODEL_ID         = 'ibm/granite-13b-instruct-v2';
const API_VERSION      = '2023-05-29';

// ── IAM token cache — reuse token until 5 min before expiry ───────────────────
let _iamToken     = null;
let _iamExpiresAt = 0;

/**
 * Obtain a fresh IBM Cloud IAM Bearer token using the API key.
 * Tokens are cached and reused for their lifetime minus a 5-minute buffer.
 * @returns {Promise<string>} Bearer token
 */
async function getIamToken() {
  const now = Date.now();
  if (_iamToken && now < _iamExpiresAt) return _iamToken;

  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=${encodeURIComponent(WATSONX_API_KEY)}`;
    const options = {
      hostname: 'iam.cloud.ibm.com',
      path:     '/identity/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.access_token) {
            return reject(new Error(`IAM token error: ${JSON.stringify(json)}`));
          }
          _iamToken     = json.access_token;
          // expires_in is in seconds; buffer 5 minutes
          _iamExpiresAt = now + ((json.expires_in - 300) * 1000);
          resolve(_iamToken);
        } catch (e) {
          reject(new Error(`IAM token parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Call the watsonx.ai text generation endpoint.
 * @param {string} prompt
 * @returns {Promise<string>} Raw generated text
 */
async function callWatsonx(prompt) {
  const token = await getIamToken();
  const url   = new URL(`${WATSONX_URL}/ml/v1/text/generation?version=${API_VERSION}`);

  const payload = JSON.stringify({
    model_id:   MODEL_ID,
    project_id: WATSONX_PROJECT,
    input:      prompt,
    parameters: {
      decoding_method: 'greedy',
      max_new_tokens:  200,
      min_new_tokens:  20,
      stop_sequences:  ['}\n', '}\r\n'],
      repetition_penalty: 1.1,
    },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${token}`,
        'Accept':         'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            return reject(new Error(`watsonx.ai HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
          }
          const text = json?.results?.[0]?.generated_text || '';
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`watsonx.ai parse error: ${e.message} — raw: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Build the Granite prompt for a single opportunity.
 * Structured so the model returns a JSON object with score and rationale.
 * @param {Object} opp  opportunity row from SQLite
 * @returns {string}
 */
function buildPrompt(opp) {
  const nextSteps  = (opp.next_steps  || '').slice(0, 400).trim() || 'Not provided';
  const teamNotes  = (opp.team_notes  || '').slice(0, 200).trim() || 'Not provided';
  const closeDate  = opp.close_date   || 'Unknown';
  const stage      = opp.stage        || 'Unknown';
  const forecast   = opp.forecast_category || 'Unknown';
  const flm        = opp.flm_judgement || 'No';
  const amount     = opp.total_opportunity_amount
    ? `$${Math.round(opp.total_opportunity_amount / 1000)}K`
    : 'Unknown';

  return `<|system|>
You are an expert IBM B2B sales coach analyzing US Public Sector sales opportunities.
Score the likelihood this deal closes within the current calendar quarter (Q3 2026, ending September 30).
Respond ONLY with a valid JSON object. No explanation outside the JSON.
<|user|>
Opportunity data:
- Stage: ${stage}
- Forecast Category: ${flm === 'Yes' ? forecast + ' (FLM confirmed)' : forecast}
- Close Date: ${closeDate}
- Amount: ${amount}
- Next Steps: ${nextSteps}
- Team Notes: ${teamNotes}

Respond with JSON:
{"score": <integer 0-100>, "rationale": "<one sentence, max 20 words, plain English, no jargon>"}
<|assistant|>
{`;
}

/**
 * Parse the raw model output into { score, rationale }.
 * Handles minor JSON formatting variations from the model.
 * @param {string} raw  raw text returned by watsonx.ai (without leading "{")
 * @returns {{ score: number, rationale: string }}
 */
function parseModelOutput(raw) {
  try {
    // Model was prompted to start with "{" — prepend it back
    const json = JSON.parse('{' + raw);
    const score = Math.min(100, Math.max(0, Math.round(Number(json.score) || 0)));
    const rationale = (json.rationale || '').slice(0, 200).trim();
    if (score === 0 && !rationale) throw new Error('empty');
    return { score, rationale };
  } catch {
    // Fallback: extract score and rationale with regex if JSON is malformed
    const scoreMatch    = raw.match(/"score"\s*:\s*(\d+)/);
    const rationaleMatch = raw.match(/"rationale"\s*:\s*"([^"]+)"/);
    return {
      score:     scoreMatch    ? Math.min(100, parseInt(scoreMatch[1], 10))    : 50,
      rationale: rationaleMatch ? rationaleMatch[1].slice(0, 200)              : 'Unable to parse model response.',
    };
  }
}

// ── Mock scoring — deterministic, based on rule signals ───────────────────────
// Used when WATSONX_ENABLED=false. Produces realistic-looking output so the
// full UI can be tested without credentials.

const MOCK_RATIONALES = {
  High:   [
    'Strong commit signals with recent executive access and FLM confirmation.',
    'Active negotiation with clear next steps and close date this quarter.',
    'Pricing presented and FLM confirmed — high probability of Q3 close.',
    'Stage 5 with signed paperwork in progress — imminent close.',
  ],
  Medium: [
    'Stage 4 but access is below executive level — needs escalation before close.',
    'Best Case forecast with active next steps but no commitment language yet.',
    'Deal progressing but close date at quarter-end raises sandbagging risk.',
    'FLM not confirmed and next steps are vague — monitor closely.',
  ],
  Low: [
    'Early stage with no next steps recorded — unlikely to close this quarter.',
    'Omitted from forecast with no recent activity — deal appears stalled.',
    'Pipeline category with 2-Qualify stage — insufficient progress for Q3 close.',
    'No next steps or team notes — deal requires immediate seller attention.',
  ],
};

/**
 * Generate a deterministic mock score for an opportunity.
 * Uses the existing rule-based score as the anchor, adds ±8 variance,
 * and picks a realistic rationale from the appropriate tier.
 * @param {Object} opp  opportunity row from SQLite (with rule-based score injected by caller)
 * @returns {{ score: number, rationale: string, mock: true }}
 */
function mockScore(opp) {
  // Use the rule-based score as the base if available, otherwise derive from fields
  const base = typeof opp._ruleScore === 'number' ? opp._ruleScore : 50;

  // Deterministic variance: hash the opportunity ID to get a consistent ±8 offset
  let hash = 0;
  for (const ch of (opp.id || '')) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  const variance = (Math.abs(hash) % 17) - 8; // -8 to +8
  const score = Math.min(100, Math.max(0, base + variance));

  const tier = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
  const pool = MOCK_RATIONALES[tier];
  const rationale = pool[Math.abs(hash) % pool.length];

  return { score, rationale, mock: true };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score a single opportunity using watsonx.ai (live) or mock mode.
 *
 * @param {Object} opp        opportunity row from SQLite
 * @param {number} ruleScore  the existing rule-based score (0–100) — used as mock anchor
 * @returns {Promise<{ score: number, rationale: string, mock: boolean }>}
 */
async function scoreWithWatsonx(opp, ruleScore = 50) {
  if (!WATSONX_ENABLED) {
    return mockScore({ ...opp, _ruleScore: ruleScore });
  }

  try {
    const prompt = buildPrompt(opp);
    const raw    = await callWatsonx(prompt);
    const result = parseModelOutput(raw);
    return { ...result, mock: false };
  } catch (err) {
    console.error(`[watsonx] Scoring failed for ${opp.id}: ${err.message}`);
    // Graceful degradation — fall back to mock on any API error
    return { ...mockScore({ ...opp, _ruleScore: ruleScore }), mock: true, error: err.message };
  }
}

/**
 * Batch score all opportunities that haven't been AI-scored yet (or need refresh).
 * Processes sequentially to avoid rate-limit issues on IBM Cloud Lite tier.
 *
 * @param {Array<Object>} opportunities  array of opportunity rows from SQLite
 * @param {Function} getRuleScore        fn(opp) → number, returns rule-based score
 * @param {Function} onProgress          fn(done, total) — called after each scored opp
 * @returns {Promise<Array<{ id, score, rationale, mock }>>}
 */
async function batchScore(opportunities, getRuleScore, onProgress = () => {}) {
  const results = [];
  for (let i = 0; i < opportunities.length; i++) {
    const opp       = opportunities[i];
    const ruleScore = getRuleScore(opp);
    const result    = await scoreWithWatsonx(opp, ruleScore);
    results.push({ id: opp.id, ...result });
    onProgress(i + 1, opportunities.length);
    // Small delay between calls when live — respect IBM Cloud Lite rate limits
    if (WATSONX_ENABLED && i < opportunities.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
}

// ── GM Narrative generation ───────────────────────────────────────────────────

const NARRATIVE_MODEL_ID = 'meta-llama/llama-3-70b-instruct';

// STALE_DAYS: next steps with a date older than this are considered stale
const STALE_DAYS = 14;

/**
 * Classify the next_steps field of a single opportunity into one of four buckets:
 *   'fresh'  — has a date within STALE_DAYS of today
 *   'stale'  — has a date but it's older than STALE_DAYS
 *   'weak'   — has text but no recognisable date (no activity timestamp)
 *   'blank'  — null, empty, or whitespace only
 *
 * Date patterns recognised: M/D, M/D/YY, M/D/YYYY
 * Uses the most recent date found in the text.
 *
 * @param {string|null} ns   next_steps field value
 * @param {Date}        [now] reference date (defaults to today; injectable for tests)
 * @returns {'fresh'|'stale'|'weak'|'blank'}
 */
function classifyNextSteps(ns, now = new Date()) {
  if (!ns || !ns.trim()) return 'blank';
  const dates = [...ns.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)];
  if (dates.length === 0) return 'weak';
  // Use the last date mentioned (sellers typically prepend newest entry)
  const last = dates[dates.length - 1];
  const mon  = parseInt(last[1], 10);
  const day  = parseInt(last[2], 10);
  const yr   = last[3]
    ? (last[3].length === 2 ? 2000 + parseInt(last[3], 10) : parseInt(last[3], 10))
    : now.getFullYear();
  const d = new Date(yr, mon - 1, day);
  const ageDays = (now - d) / 86400000;
  return ageDays <= STALE_DAYS ? 'fresh' : 'stale';
}

/**
 * Compute next-steps health stats for a set of opportunities.
 * Returns counts for each bucket plus a breakdown of low-confidence opps.
 *
 * @param {Array<Object>} opps
 * @returns {{ fresh, stale, weak, blank, lowBlank, lowStale, lowWeak, lowTotal }}
 */
function nextStepsStats(opps) {
  let fresh = 0, stale = 0, weak = 0, blank = 0;
  let lowBlank = 0, lowStale = 0, lowWeak = 0;
  const now = new Date();

  for (const o of opps) {
    const bucket  = classifyNextSteps(o.next_steps, now);
    const isLow   = (o.ai_score ?? o.score ?? 0) < 40;
    if (bucket === 'fresh') fresh++;
    else if (bucket === 'stale') { stale++; if (isLow) lowStale++; }
    else if (bucket === 'weak')  { weak++;  if (isLow) lowWeak++;  }
    else                         { blank++; if (isLow) lowBlank++; }
  }

  const lowTotal = opps.filter(o => (o.ai_score ?? o.score ?? 0) < 40).length;
  return { fresh, stale, weak, blank, lowBlank, lowStale, lowWeak, lowTotal };
}

function buildNarrativePrompt(opps) {
  const fmt$ = (v) => v ? '$' + (v / 1e6).toFixed(1) + 'M' : '—';
  const ibmTotal = opps.reduce((s, o) => s + (o.filtered_opportunity_amount || 0), 0);
  const totalAmt = opps.reduce((s, o) => s + (o.total_opportunity_amount    || 0), 0);
  const highConf = opps.filter(o => (o.ai_score ?? o.score ?? 0) >= 70);
  const midConf  = opps.filter(o => { const s = o.ai_score ?? o.score ?? 0; return s >= 40 && s < 70; });
  const lowConf  = opps.filter(o => (o.ai_score ?? o.score ?? 0) < 40);
  const flmYes   = opps.filter(o => (o.flm_judgement || '').toLowerCase() === 'yes');
  const ns       = nextStepsStats(opps);

  const topDeals = [...opps]
    .sort((a, b) => (b.total_opportunity_amount || 0) - (a.total_opportunity_amount || 0))
    .slice(0, 8)
    .map(o => {
      const score     = o.ai_score ?? o.score ?? '—';
      const rationale = o.ai_rationale ? ` — "${o.ai_rationale.slice(0, 80)}"` : '';
      return `  • ${o.opportunity_name || 'Unnamed'} | ${o.account_name || '—'} | ${fmt$(o.total_opportunity_amount)} | ${o.stage || '—'} | Score: ${score}/100${rationale}`;
    }).join('\n');

  return `<|system|>
You are an executive communications specialist for IBM US Public Sector sales leadership.
Write a concise, professional GM meeting briefing based on the forecast data below.
Tone: confident, executive, data-driven. No fluff. Reference specific numbers.
Respond ONLY with valid JSON — no text outside the JSON object.
<|user|>
Weekly forecast — VP Dushyant K Patel — Q3 2026 GM Meeting:

Selected opportunities: ${opps.length}
IBM Technology Amount: ${fmt$(ibmTotal)}
Total Contract Amount: ${fmt$(totalAmt)}
High confidence (≥70): ${highConf.length} deals
Medium confidence (40–69): ${midConf.length} deals
Low confidence (<40): ${lowConf.length} deals
FLM confirmed: ${flmYes.length} deals

Next Steps health across all selected opportunities:
  Fresh (updated ≤${STALE_DAYS} days): ${ns.fresh}
  Stale (last update >${STALE_DAYS} days ago): ${ns.stale}
  Weak (no date recorded): ${ns.weak}
  Blank (no next steps at all): ${ns.blank}

Low-confidence deals next-steps breakdown (${ns.lowTotal} deals <40 score):
  No next steps at all: ${ns.lowBlank}
  Stale next steps: ${ns.lowStale}
  Weak/undated next steps: ${ns.lowWeak}

Top deals by amount:
${topDeals}

Respond with JSON:
{"paragraph": "<3-5 sentence executive summary with specific amounts, counts, and next-steps health>", "bullets": ["<talking point 1>", "<talking point 2>", "<talking point 3>", "<talking point 4 — specific low-confidence next-steps action>"]}
<|assistant|>
{`;
}

function parseNarrativeOutput(raw) {
  try {
    const json = JSON.parse('{' + raw);
    return {
      paragraph: (json.paragraph || '').trim(),
      bullets:   Array.isArray(json.bullets) ? json.bullets.slice(0, 5) : [],
    };
  } catch {
    const paraMatch    = raw.match(/"paragraph"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    const bulletsMatch = [...raw.matchAll(/"([^"]{10,})"/g)].slice(1).map(m => m[1]);
    return {
      paragraph: paraMatch ? paraMatch[1].replace(/\\n/g, ' ').trim() : 'Unable to generate narrative.',
      bullets:   bulletsMatch.slice(0, 3),
    };
  }
}

function mockNarrative(opps) {
  const fmt$ = (v) => v ? '$' + (v / 1e6).toFixed(1) + 'M' : '—';
  const ibmTotal  = opps.reduce((s, o) => s + (o.filtered_opportunity_amount || 0), 0);
  const totalAmt  = opps.reduce((s, o) => s + (o.total_opportunity_amount    || 0), 0);
  const highConf  = opps.filter(o => (o.ai_score ?? o.score ?? 0) >= 70);
  const flmYes    = opps.filter(o => (o.flm_judgement || '').toLowerCase() === 'yes');
  const topDeal   = [...opps].sort((a, b) => (b.total_opportunity_amount || 0) - (a.total_opportunity_amount || 0))[0];
  const ns        = nextStepsStats(opps);
  const atRisk    = ns.lowBlank + ns.lowStale + ns.lowWeak;  // low-conf opps needing attention

  // Build a specific action sentence based on what the data actually shows
  let actionDetail = '';
  const parts = [];
  if (ns.lowBlank  > 0) parts.push(`${ns.lowBlank} with no Next Steps`);
  if (ns.lowStale  > 0) parts.push(`${ns.lowStale} with stale updates`);
  if (ns.lowWeak   > 0) parts.push(`${ns.lowWeak} with undated notes`);
  if (parts.length > 0) {
    actionDetail = ` Of the ${ns.lowTotal} low-confidence deals, ${parts.join(', ')} require immediate seller attention.`;
  }

  const paragraph =
    `This week's US Public Sector IBM Technology forecast stands at ${fmt$(ibmTotal)} IBM Tech across ${opps.length} selected opportunities closing in Q3 2026, with a total contract value of ${fmt$(totalAmt)}. ` +
    `${highConf.length} deal${highConf.length !== 1 ? 's are' : ' is'} rated High confidence and ${flmYes.length} have first-line manager confirmation. ` +
    (topDeal ? `The largest opportunity is ${topDeal.opportunity_name} at ${fmt$(topDeal.total_opportunity_amount)}, currently in ${topDeal.stage}. ` : '') +
    `Next Steps health: ${ns.fresh} fresh, ${ns.stale} stale, ${ns.weak} undated, ${ns.blank} blank across all selected opportunities.${actionDetail}`;

  const bullets = [
    `IBM Tech forecast: ${fmt$(ibmTotal)} across ${opps.length} opportunities — ${highConf.length} High confidence, ${flmYes.length} FLM confirmed`,
    topDeal
      ? `Top deal: ${topDeal.opportunity_name} (${topDeal.account_name}) — ${fmt$(topDeal.total_opportunity_amount)} | ${topDeal.stage}`
      : `${opps.length} opportunities selected for GM review`,
    `Next Steps health: ${ns.fresh} fresh · ${ns.stale} stale · ${ns.weak} undated · ${ns.blank} blank`,
    atRisk > 0
      ? `⚠ ${atRisk} low-confidence deal${atRisk !== 1 ? 's' : ''} need attention: ${parts.join(', ')}`
      : `All low-confidence deals have current Next Steps — no immediate action required`,
  ];

  return { paragraph, bullets, mock: true };
}

/**
 * Generate the GM executive narrative from selected opportunities.
 * @param {Array<Object>} opps  selected opportunity rows (with scores populated)
 * @returns {Promise<{ paragraph: string, bullets: string[], mock: boolean }>}
 */
async function generateNarrative(opps) {
  if (opps.length === 0) {
    return { paragraph: 'No opportunities selected. Please select opportunities before generating a narrative.', bullets: [], mock: true };
  }

  if (!WATSONX_ENABLED) return mockNarrative(opps);

  try {
    const token   = await getIamToken();
    const url     = new URL(`${WATSONX_URL}/ml/v1/text/generation?version=${API_VERSION}`);
    const payload = JSON.stringify({
      model_id:   NARRATIVE_MODEL_ID,
      project_id: WATSONX_PROJECT,
      input:      buildNarrativePrompt(opps),
      parameters: { decoding_method: 'greedy', max_new_tokens: 600, min_new_tokens: 80, stop_sequences: ['}\n'], repetition_penalty: 1.05 },
    });

    const raw = await new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            resolve((json?.results?.[0]?.generated_text || '').trim());
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    return { ...parseNarrativeOutput(raw), mock: false };
  } catch (err) {
    console.error('[watsonx] Narrative failed:', err.message);
    return { ...mockNarrative(opps), mock: true, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// generateDeltaSummary — week-over-week change summary (v2.1.0)
// ---------------------------------------------------------------------------
const DELTA_MODEL_ID = 'ibm/granite-3-8b-instruct';

/**
 * Build a prompt for the delta summary — concise, structured.
 * Uses Granite 3-8b (fast, efficient — appropriate for structured change summary).
 * @param {object} diff — result from diffEngine.computeDiff()
 * @returns {string}
 */
function buildDeltaPrompt(diff) {
  const fmt$ = v => v != null ? `$${(v/1e6).toFixed(1)}M` : '—';

  const newList = diff.new.slice(0,5).map(r =>
    `  - ${r.opportunity_name} (${r.account_name}) — ${fmt$(r.total_opportunity_amount)} · ${r.stage}`
  ).join('\n');

  const droppedList = diff.dropped.slice(0,5).map(r =>
    `  - ${r.opportunity_name} (${r.account_name}) — ${fmt$(r.total_opportunity_amount)}`
  ).join('\n');

  const promotedList = diff.promoted.slice(0,5).map(r =>
    `  - ${r.opportunity_name}: ${r.prevStage} → ${r.curStage}`
  ).join('\n');

  const demotedList = diff.demoted.slice(0,5).map(r =>
    `  - ${r.opportunity_name}: ${r.prevStage} → ${r.curStage}`
  ).join('\n');

  const slippedList = diff.slipped.slice(0,5).map(r =>
    `  - ${r.opportunity_name}: close date slipped ${r.daysDiff} days (${r.prevCloseDate} → ${r.curCloseDate})`
  ).join('\n');

  return `You are a sales operations analyst preparing a week-over-week change briefing for a General Manager.
Compare ${diff.previousWeek} to ${diff.currentWeek} and write a concise executive summary.
Respond ONLY with a JSON object in this exact format:
{"paragraph":"<2-3 sentence summary>","bullets":["<bullet 1>","<bullet 2>","<bullet 3>"]}

CHANGE DATA:
New deals this week (${diff.new.length} total):
${newList || '  (none)'}
Dropped deals (${diff.dropped.length} total):
${droppedList || '  (none)'}
Stage promotions (${diff.promoted.length}):
${promotedList || '  (none)'}
Stage demotions (${diff.demoted.length}):
${demotedList || '  (none)'}
Slipped close dates (${diff.slipped.length}):
${slippedList || '  (none)'}
Amount changes: ${diff.amount.length}
Overall: ${diff.summary}

Respond with only the JSON object.`;
}

/**
 * Generate a mock delta summary when watsonx is not enabled.
 * @param {object} diff
 * @returns {{ paragraph: string, bullets: string[], mock: true }}
 */
function mockDeltaSummary(diff) {
  const total = diff.new.length + diff.dropped.length + diff.promoted.length +
                diff.demoted.length + diff.amount.length + diff.slipped.length;

  const paragraph = total === 0
    ? `Pipeline was stable this week (${diff.currentWeek} vs ${diff.previousWeek}). No significant changes detected across stage, amount, or close dates.`
    : `This week's pipeline review (${diff.currentWeek} vs ${diff.previousWeek}) shows ${diff.summary.split(': ')[1]}. ` +
      (diff.new.length    ? `${diff.new.length} new deal${diff.new.length>1?'s':''} entered the pipeline. ` : '') +
      (diff.dropped.length ? `${diff.dropped.length} deal${diff.dropped.length>1?'s':''} dropped out. ` : '') +
      (diff.demoted.length ? `${diff.demoted.length} stage regression${diff.demoted.length>1?'s':''} require attention.` : '');

  const bullets = [];
  if (diff.new.length)       bullets.push(`${diff.new.length} new deal${diff.new.length>1?'s':''} added to pipeline`);
  if (diff.dropped.length)   bullets.push(`${diff.dropped.length} deal${diff.dropped.length>1?'s':''} removed from pipeline`);
  if (diff.promoted.length)  bullets.push(`${diff.promoted.length} deal${diff.promoted.length>1?'s':''} advanced in stage`);
  if (diff.demoted.length)   bullets.push(`⚠ ${diff.demoted.length} deal${diff.demoted.length>1?'s':''} regressed in stage — review needed`);
  if (diff.slipped.length)   bullets.push(`⚠ ${diff.slipped.length} deal${diff.slipped.length>1?'s':''} with slipped close dates`);
  if (diff.amount.length)    bullets.push(`${diff.amount.length} deal${diff.amount.length>1?'s':''} with significant amount changes`);
  if (bullets.length === 0)  bullets.push('No significant changes detected this week');

  return { paragraph, bullets, mock: true };
}

/**
 * Generate a watsonx AI delta summary of week-over-week pipeline changes.
 * Uses ibm/granite-3-8b-instruct (fast) with graceful fallback to mock.
 * @param {object} diff — result from diffEngine.computeDiff()
 * @returns {Promise<{ paragraph: string, bullets: string[], mock: boolean }>}
 */
async function generateDeltaSummary(diff) {
  if (!diff.hasData) {
    return { paragraph: 'Not enough history to generate a delta summary yet. Run a second scrape next week.', bullets: [], mock: true };
  }

  if (!WATSONX_ENABLED) return mockDeltaSummary(diff);

  try {
    const token   = await getIamToken();
    const url     = new URL(`${WATSONX_URL}/ml/v1/text/generation?version=${API_VERSION}`);
    const payload = JSON.stringify({
      model_id:   DELTA_MODEL_ID,
      project_id: WATSONX_PROJECT,
      input:      buildDeltaPrompt(diff),
      parameters: { decoding_method: 'greedy', max_new_tokens: 400, min_new_tokens: 40, stop_sequences: ['}\n'], repetition_penalty: 1.05 },
    });

    const raw = await new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            resolve((json?.results?.[0]?.generated_text || '').trim());
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    return { ...parseNarrativeOutput(raw), mock: false };
  } catch (err) {
    console.error('[watsonx] Delta summary failed:', err.message);
    return { ...mockDeltaSummary(diff), mock: true, error: err.message };
  }
}

module.exports = {
  scoreWithWatsonx,
  batchScore,
  generateNarrative,
  generateDeltaSummary,
  isLiveMode:        () => WATSONX_ENABLED,
  modelId:           MODEL_ID,
  narrativeModelId:  NARRATIVE_MODEL_ID,
  deltaModelId:      DELTA_MODEL_ID,
};
