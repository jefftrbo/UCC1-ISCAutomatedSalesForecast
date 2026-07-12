/**
 * server/index.js
 *
 * Local Express API server — the backbone of the ISC Automated Sales Forecast app.
 * Listens on http://localhost:3000
 *
 * Endpoints:
 *   GET  /api/opportunities           — fetch all opportunities from SQLite
 *   POST /api/opportunities/:id/select — update selected flag for one opportunity
 *   POST /api/scrape                  — trigger the Playwright ISC scraper
 *   POST /api/generate-ppt            — generate PowerPoint from selected opportunities
 */

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const generatePpt = require('./generatePpt');
const { scoreOpportunity } = require('./scoreOpportunity');

const app = express();
const PORT = process.env.PORT || 3090;

app.use(express.json());

// Serve frontend static files from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// GET /api/opportunities
// Returns all opportunities ordered by close_date ascending.
// ---------------------------------------------------------------------------
app.get('/api/opportunities', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM opportunities ORDER BY close_date ASC, total_opportunity_amount DESC')
      .all();
    // Inject confidence score into each row before sending to frontend
    const scored = rows.map(row => {
      const { score, tier, closeQuarter, breakdown } = scoreOpportunity(row);
      return { ...row, score, tier, closeQuarter, breakdown };
    });
    res.json(scored);
  } catch (err) {
    console.error('GET /api/opportunities error:', err.message);
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
      res.write('\nScrape complete.');
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
// POST /api/generate-ppt
// Queries all selected opportunities and generates a .pptx file.
// Returns JSON with the relative file path so the frontend can download it.
// ---------------------------------------------------------------------------
app.post('/api/generate-ppt', async (req, res) => {
  try {
    const selected = db
      .prepare('SELECT * FROM opportunities WHERE selected = 1 ORDER BY close_date ASC')
      .all();

    if (selected.length === 0) {
      return res.status(400).json({ error: 'No opportunities selected. Please check at least one opportunity.' });
    }

    const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const fileName = `forecast-${dateStamp}.pptx`;
    const outputDir = path.join(__dirname, '..', 'output');
    const outputPath = path.join(outputDir, fileName);

    await generatePpt(selected, outputPath);

    // Return the download URL (served as static file)
    res.json({ file: `/output/${fileName}`, count: selected.length });
  } catch (err) {
    console.error('POST /api/generate-ppt error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve generated .pptx files from /output
app.use('/output', express.static(path.join(__dirname, '..', 'output')));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ISC Sales Forecast app running at http://localhost:${PORT}`);
  console.log(`Open in your browser: http://localhost:${PORT}`);
});
