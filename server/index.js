/**
 * server/index.js
 *
 * Local Express API server — the backbone of the ISC Automated Sales Forecast app.
 * Listens on http://localhost:3090
 *
 * Endpoints:
 *   GET  /api/opportunities             — fetch all opportunities (rule + AI scores)
 *   POST /api/opportunities/:id/select  — update selected flag for one opportunity
 *   POST /api/scrape                    — trigger HAR/devtools/Playwright scraper
 *   POST /api/score-opportunities       — run watsonx.ai scoring on all opportunities
 *   GET  /api/watsonx-status            — returns current watsonx mode (live/mock)
 *   POST /api/generate-narrative        — generate GM meeting executive narrative (watsonx)
 *   POST /api/generate-ppt              — generate PowerPoint from selected opportunities
 *   POST /api/snapshot                  — save baseline snapshot (deliberate action, after GM call)
 *   GET  /api/diff                      — return diff: live opportunities vs. most-recent snapshot
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const generatePpt = require('./generatePpt');
const { scoreOpportunity } = require('./scoreOpportunity');
const { batchScore, isLiveMode, modelId, generateNarrative, generateDeltaSummary } = require('./watsonxScore');
const { saveSnapshot, computeDiff, getLedgerHistory } = require('./diffEngine');

const app = express();
const PORT = process.env.PORT || 3090;

app.use(express.json());

// Serve frontend static files from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// GET /api/opportunities
// Returns all opportunities with both rule-based and AI scores.
// ---------------------------------------------------------------------------
app.get('/api/opportunities', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM opportunities ORDER BY close_date ASC, total_opportunity_amount DESC')
      .all();
    const scored = rows.map(row => {
      const { score, tier, closeQuarter, breakdown } = scoreOpportunity(row);
      return {
        ...row,
        // Rule-based score (always available)
        score, tier, closeQuarter, breakdown,
        // AI score fields (null until /api/score-opportunities is called)
        ai_score:     row.ai_score     ?? null,
        ai_rationale: row.ai_rationale ?? null,
        ai_scored_at: row.ai_scored_at ?? null,
      };
    });
    res.json(scored);
  } catch (err) {
    console.error('GET /api/opportunities error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/watsonx-status
// Returns the current watsonx mode so the frontend can show the right UI.
// ---------------------------------------------------------------------------
app.get('/api/watsonx-status', (req, res) => {
  const scored = db.prepare('SELECT COUNT(*) as n FROM opportunities WHERE ai_score IS NOT NULL').get();
  res.json({
    enabled:  isLiveMode(),
    mode:     isLiveMode() ? 'live' : 'mock',
    model:    modelId,
    scored:   scored.n,
    total:    db.prepare('SELECT COUNT(*) as n FROM opportunities').get().n,
  });
});

// ---------------------------------------------------------------------------
// POST /api/score-opportunities
// Runs watsonx.ai (or mock) scoring on all opportunities in the database.
// Streams progress back as plain text so the UI can show a progress indicator.
// Re-scores all rows on every call — scores are cheap and data may have changed.
// ---------------------------------------------------------------------------
app.post('/api/score-opportunities', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const mode = isLiveMode() ? `LIVE (${modelId})` : 'MOCK';
  res.write(`Starting watsonx.ai scoring in ${mode} mode...\n`);

  try {
    const rows = db
      .prepare('SELECT * FROM opportunities ORDER BY close_date ASC')
      .all();

    res.write(`Scoring ${rows.length} opportunities...\n`);

    const updateStmt = db.prepare(
      'UPDATE opportunities SET ai_score = ?, ai_rationale = ?, ai_scored_at = ?, score = ?, tier = ? WHERE id = ?'
    );

    // Pre-compute rules scores so batchScore can use them as anchors AND we persist them
    const rulesScores = new Map(rows.map(opp => {
      const { score, tier } = scoreOpportunity(opp);
      return [opp.id, { score, tier }];
    }));

    const results = await batchScore(
      rows,
      (opp) => rulesScores.get(opp.id)?.score ?? 0,  // rule-based score as anchor
      (done, total) => {
        if (done % 10 === 0 || done === total) {
          res.write(`  Scored ${done} of ${total}...\n`);
        }
      }
    );

    // Persist AI + rules scores in a single transaction
    const now = new Date().toISOString();
    db.transaction(() => {
      results.forEach(r => {
        const rules = rulesScores.get(r.id) || { score: null, tier: null };
        updateStmt.run(r.score, r.rationale, now, rules.score, rules.tier, r.id);
      });
    })();

    const mockCount = results.filter(r => r.mock).length;
    const liveCount = results.length - mockCount;
    res.write(`\nDone. ${liveCount > 0 ? liveCount + ' live' : ''} ${mockCount > 0 ? mockCount + ' mock' : ''} scores saved.\n`);
    res.end();
  } catch (err) {
    console.error('POST /api/score-opportunities error:', err.message);
    res.write(`\nError: ${err.message}`);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate-narrative
// Body (optional): { ids: string[] }
//   ids — the ordered list of opportunity IDs currently visible in the UI
//         (filtered set). When provided, narrative reflects that exact view.
//         When omitted, falls back to all selected=1 rows (backward compat).
// Returns: { paragraph, bullets, mock, model, count }
// ---------------------------------------------------------------------------
app.post('/api/generate-narrative', async (req, res) => {
  try {
    let opps;
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;

    if (ids && ids.length > 0) {
      // Fetch only the rows the frontend is currently showing, preserving frontend order
      const placeholders = ids.map(() => '?').join(',');
      const byId = db
        .prepare(`SELECT * FROM opportunities WHERE id IN (${placeholders})`)
        .all(...ids);
      // Re-sort to match the order the frontend sent (ids are already sorted by the UI)
      const idIndex = new Map(ids.map((id, i) => [id, i]));
      opps = byId.sort((a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0));
    } else {
      // Fallback: all selected rows
      opps = db
        .prepare('SELECT * FROM opportunities WHERE selected = 1 ORDER BY total_opportunity_amount DESC')
        .all();
    }

    if (opps.length === 0) {
      return res.status(400).json({ error: 'No opportunities in the current view. Adjust your filters or select opportunities first.' });
    }

    const result = await generateNarrative(opps);
    res.json({
      paragraph: result.paragraph,
      bullets:   result.bullets,
      mock:      result.mock,
      model:     result.mock ? 'mock' : 'meta-llama/llama-3-70b-instruct',
      count:     opps.length,
    });
  } catch (err) {
    console.error('POST /api/generate-narrative error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/opportunities/:id/select
// Body: { selected: true | false }
// Toggles the GM meeting inclusion flag for a single opportunity.
// ---------------------------------------------------------------------------
app.post('/api/opportunities/:id/select', (req, res) => {
  const { id } = req.params;
  const { selected } = req.body;

  if (typeof selected !== 'boolean') {
    return res.status(400).json({ error: '"selected" must be a boolean' });
  }

  try {
    db.prepare('UPDATE opportunities SET selected = ? WHERE id = ?').run(
      selected ? 1 : 0,
      id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/opportunities/:id/select error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/save-cookies?c=<encoded-cookie-string>
// Called by the Brave bookmarklet — bookmarklet opens this URL in a new tab,
// passing document.cookie as a query param. No CORS issues since it's a
// same-origin GET from localhost.
// ---------------------------------------------------------------------------
app.get('/api/save-cookies', (req, res) => {
  const cookieString = req.query.c ? decodeURIComponent(req.query.c) : '';
  if (!cookieString) return res.status(400).send('No cookie string provided');

  const domain = 'ibmsc.lightning.force.com';
  const cookies = cookieString.split(';').map(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return null;
    return {
      name:     pair.slice(0, idx).trim(),
      value:    pair.slice(idx + 1).trim(),
      domain:   `.lightning.force.com`,
      path:     '/',
      secure:   true,
      httpOnly: false,
      sameSite: 'None',
      expires:  -1,
    };
  }).filter(Boolean);

  const cookiesPath = path.join(__dirname, '..', 'scraper', 'cookies.json');
  require('fs').writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  console.log(`[save-cookies] Saved ${cookies.length} cookies from ${domain}`);

  // Return a friendly page so the user knows it worked
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Cookies Saved</title>
    <style>body{font-family:system-ui,sans-serif;max-width:500px;margin:80px auto;text-align:center;color:#161616}
    h1{color:#198038;font-size:28px} p{color:#6f6f6f;margin:12px 0}
    code{background:#f4f4f4;padding:4px 10px;border-radius:4px;font-size:13px}
    </style></head><body>
    <h1>✅ Cookies Saved</h1>
    <p>Captured <strong>${cookies.length} cookies</strong> from ISC.</p>
    <p>Now run in your terminal:</p>
    <p><code>node scraper/fetch-from-api.js</code></p>
    <p style="margin-top:32px"><a href="http://localhost:3090">← Back to app</a></p>
    </body></html>`);
});

// ---------------------------------------------------------------------------
// POST /api/snapshot
// Manual "Save Baseline" utility — writes a confirmed=1 entry to baseline_ledger.
// For the normal weekly workflow, the snapshot is written INSIDE /api/generate-ppt
// (after the diff is computed and the PPT is generated). This endpoint exists for
// the utility "📌 Save Baseline" button (manual override, advanced action).
// Returns: { snapshotId, weekLabel, quarterLabel, weekSeq, confirmed, saved }
// ---------------------------------------------------------------------------
app.post('/api/snapshot', (req, res) => {
  try {
    const result = saveSnapshot(db, { confirmed: true });
    res.json(result);
  } catch (err) {
    console.error('POST /api/snapshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ledger-history
// Returns all confirmed baseline runs (newest first) for the UI history panel.
// ---------------------------------------------------------------------------
app.get('/api/ledger-history', (req, res) => {
  try {
    res.json(getLedgerHistory(db));
  } catch (err) {
    console.error('GET /api/ledger-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/diff
// Compares the two most-recent week_labels in the snapshots table and returns
// a structured diff object. If fewer than 2 snapshots exist, returns
// { hasData: false } so the UI can show a "Not enough history yet" message.
// Optional query param: ?summary=true — also triggers watsonx delta summary.
// Returns: diff object from diffEngine.computeDiff()
// ---------------------------------------------------------------------------
app.get('/api/diff', async (req, res) => {
  try {
    const diff = computeDiff(db);
    if (!diff.hasData) {
      return res.json(diff);
    }

    // Optionally generate a watsonx AI summary of the changes
    if (req.query.summary === 'true') {
      try {
        const aiSummary = await generateDeltaSummary(diff);
        diff.aiSummary = aiSummary;
      } catch (e) {
        console.warn('GET /api/diff: delta summary skipped —', e.message);
        diff.aiSummary = null;
      }
    }

    res.json(diff);
  } catch (err) {
    console.error('GET /api/diff error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/scrape
// Spawns the appropriate scraper as a child process.
// - If scraper/devtools-response.json exists → load-from-devtools.js (recommended)
// - Otherwise → scrape.js --headed (requires manual filter steps in Brave)
// Streams stdout/stderr back as plain text so the UI can show progress.
// ---------------------------------------------------------------------------
app.post('/api/scrape', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const fsSync     = require('fs');
  const harFile     = path.join(__dirname, '..', 'scraper', 'isc-export.har');
  const devtoolsFile = path.join(__dirname, '..', 'scraper', 'devtools-response.json');

  // Priority: HAR file → devtools JSON → headed Playwright scraper
  let scriptPath, args, statusMsg;

  if (fsSync.existsSync(harFile)) {
    scriptPath = path.join(__dirname, '..', 'scraper', 'load-from-har.js');
    args       = [scriptPath];
    statusMsg  = 'Loading data from HAR export...\n';
  } else if (fsSync.existsSync(devtoolsFile)) {
    scriptPath = path.join(__dirname, '..', 'scraper', 'load-from-devtools.js');
    args       = [scriptPath];
    statusMsg  = 'Loading data from DevTools response...\n';
  } else {
    scriptPath = path.join(__dirname, '..', 'scraper', 'scrape.js');
    args       = [scriptPath, '--headed'];
    statusMsg  = 'Launching Brave — set filters in browser then press ENTER in terminal...\n';
  }

  res.write(statusMsg);

  const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..') });

  child.stdout.on('data', (data) => {
    process.stdout.write(data);
    res.write(data.toString());
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(data);
    res.write(data.toString());
  });

  child.on('close', (code) => {
    if (code === 0) {
      res.write('\nScrape complete. Click "📌 Save Baseline" after your GM call to lock in this week for future diffs.');
    } else {
      res.write(`\nScrape exited with code ${code}.`);
    }
    res.end();
  });

  child.on('error', (err) => {
    res.write(`\nFailed to start scraper: ${err.message}`);
    res.end();
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Shared PPT generation logic — used by both endpoints below.
// confirmed = true  → "Confirm & Generate": writes immutable baseline AFTER PPT
// confirmed = false → "Generate Only":      PPT only, no baseline written
// ---------------------------------------------------------------------------
async function runGeneratePpt(res, confirmed) {
  try {
    const selected = db
      .prepare('SELECT * FROM opportunities WHERE selected = 1 ORDER BY close_date ASC')
      .all();

    if (selected.length === 0) {
      return res.status(400).json({ error: 'No opportunities selected. Please check at least one opportunity.' });
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    const fileName  = `forecast-${dateStamp}.pptx`;
    const outputDir = path.join(__dirname, '..', 'output');
    const outputPath = path.join(outputDir, fileName);

    // Step 1 — compute diff against the most-recent PRIOR confirmed baseline
    // (asOf = now, so any snapshot written during this request is excluded)
    let diff = null;
    let deltaSummary = null;
    try {
      diff = computeDiff(db);   // uses new Date() internally — always prior baseline
      if (diff.hasData) {
        deltaSummary = await generateDeltaSummary(diff);
      }
    } catch (e) {
      console.warn('generate-ppt: diff/delta skipped —', e.message);
    }

    // Step 2 — generate GM narrative for cover slide (non-blocking)
    let narrative = null;
    try {
      narrative = await generateNarrative(selected);
    } catch (e) {
      console.warn('generate-ppt: narrative generation skipped —', e.message);
    }

    // Step 3 — generate the PowerPoint
    await generatePpt(selected, outputPath, narrative, diff, deltaSummary);

    // Step 4 — write immutable baseline entry ONLY on confirmed runs
    let snapshotResult = null;
    if (confirmed) {
      snapshotResult = saveSnapshot(db, { confirmed: true });
    }

    res.json({
      file:       `/output/${fileName}`,
      count:      selected.length,
      confirmed,
      snapshot:   snapshotResult,   // null on Generate Only runs
    });
  } catch (err) {
    console.error('generate-ppt error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/generate-ppt
// "Confirm & Generate" — generates PPT using the PRIOR baseline's diff,
// then writes a new immutable confirmed baseline entry to baseline_ledger.
// This is the "Final" action — the permanent historical record for this week.
// ---------------------------------------------------------------------------
app.post('/api/generate-ppt', (req, res) => runGeneratePpt(res, true));

// POST /api/generate-ppt-only
// "Generate Only" — generates PPT using the PRIOR baseline's diff,
// does NOT write a new baseline entry. Use for test runs and iteration.
// ---------------------------------------------------------------------------
app.post('/api/generate-ppt-only', (req, res) => runGeneratePpt(res, false));

// Serve generated .pptx files from /output
app.use('/output', express.static(path.join(__dirname, '..', 'output')));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ISC Sales Forecast app running at http://localhost:${PORT}`);
  console.log(`Open in your browser: http://localhost:${PORT}`);
});
