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

function buildNarrativePrompt(opps) {
  const fmt$ = (v) => v ? '$' + (v / 1e6).toFixed(1) + 'M' : '—';
  const ibmTotal = opps.reduce((s, o) => s + (o.filtered_opportunity_amount || 0), 0);
  const totalAmt = opps.reduce((s, o) => s + (o.total_opportunity_amount    || 0), 0);
  const highConf = opps.filter(o => (o.ai_score ?? o.score ?? 0) >= 70);
  const midConf  = opps.filter(o => { const s = o.ai_score ?? o.score ?? 0; return s >= 40 && s < 70; });
  const lowConf  = opps.filter(o => (o.ai_score ?? o.score ?? 0) < 40);
  const flmYes   = opps.filter(o => (o.flm_judgement || '').toLowerCase() === 'yes');

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

Top deals by amount:
${topDeals}

Respond with JSON:
{"paragraph": "<3-5 sentence executive summary with specific amounts and counts>", "bullets": ["<talking point 1>", "<talking point 2>", "<talking point 3>"]}
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
  const ibmTotal = opps.reduce((s, o) => s + (o.filtered_opportunity_amount || 0), 0);
  const totalAmt = opps.reduce((s, o) => s + (o.total_opportunity_amount    || 0), 0);
  const highConf = opps.filter(o => (o.ai_score ?? o.score ?? 0) >= 70);
  const flmYes   = opps.filter(o => (o.flm_judgement || '').toLowerCase() === 'yes');
  const topDeal  = [...opps].sort((a, b) => (b.total_opportunity_amount || 0) - (a.total_opportunity_amount || 0))[0];

  const paragraph =
    `This week's US Public Sector IBM Technology forecast stands at ${fmt$(ibmTotal)} IBM Tech across ${opps.length} selected opportunities closing in Q3 2026, with a total contract value of ${fmt$(totalAmt)}. ` +
    `${highConf.length} deal${highConf.length !== 1 ? 's are' : ' is'} rated High confidence and ${flmYes.length} have first-line manager confirmation. ` +
    (topDeal ? `The largest opportunity is ${topDeal.opportunity_name} at ${fmt$(topDeal.total_opportunity_amount)}, currently in ${topDeal.stage}. ` : '') +
    `Recommend VP review of any Best Case deals with stale Next Steps before the GM call.`;

  const bullets = [
    `IBM Tech forecast: ${fmt$(ibmTotal)} across ${opps.length} opportunities — ${highConf.length} High confidence, ${flmYes.length} FLM confirmed`,
    topDeal ? `Top deal: ${topDeal.opportunity_name} (${topDeal.account_name}) — ${fmt$(topDeal.total_opportunity_amount)} | ${topDeal.stage}` : `${opps.length} opportunities selected for GM review`,
    `Action: review low-confidence deals and confirm Next Steps are current before quarter close`,
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

module.exports = {
  scoreWithWatsonx,
  batchScore,
  generateNarrative,
  isLiveMode:        () => WATSONX_ENABLED,
  modelId:           MODEL_ID,
  narrativeModelId:  NARRATIVE_MODEL_ID,
};
