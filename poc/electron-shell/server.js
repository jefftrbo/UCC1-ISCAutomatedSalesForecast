/**
 * server.js — PoC ingest endpoint
 *
 * Receives the Salesforce CRM Analytics deal-list payload captured by
 * session.webRequest in main.js and logs it so we can confirm:
 *   1. The intercept fires
 *   2. The payload shape matches what our HAR parser expects
 *   3. A local Express endpoint can receive it cleanly
 *
 * This is the ONLY thing this file proves. No DB, no scoring, no PPT.
 */

const express = require('express');
const app     = express();

app.use(express.json({ limit: '10mb' }));

// In-memory capture state — renderer polls /api/last-capture
let lastCapture = null;

// ── Status check — renderer polls until server is up ─────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ok: true });
});

// ── Renderer polls this to learn when a capture has fired ────────────────────
app.get('/api/last-capture', (req, res) => {
  if (!lastCapture) {
    return res.json({ captured: false });
  }
  res.json({ captured: true, ...lastCapture });
});

// ── Main capture endpoint — called by main.js when webRequest fires ──────────
app.post('/api/ingest', (req, res) => {
  const body = req.body;

  // Pull record count from standard CRM Analytics response shapes
  // (same field our HAR parser uses)
  const records =
    body?.results?.[0]?.records ||
    body?.records              ||
    body?.data                 ||
    null;

  const count  = Array.isArray(records) ? records.length : '?';
  const fields = Array.isArray(records) && records.length > 0
    ? Object.keys(records[0]).join(', ')
    : Object.keys(body).join(', ');

  const ts = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });

  // Log to terminal for developer confirmation
  console.log(`\n✅ INGEST received — ${count} records · ${ts}`);
  console.log('   Top-level keys :', Object.keys(body).join(', '));
  if (Array.isArray(records) && records.length > 0) {
    console.log('   First record keys :', Object.keys(records[0]).join(', '));
    console.log('   First record sample:', JSON.stringify(records[0]).slice(0, 300));
  } else {
    console.log('   Raw payload (first 500 chars):', JSON.stringify(body).slice(0, 500));
  }

  // Store for renderer polling
  lastCapture = { count, fields, timestamp: ts };

  res.json({ ok: true, captured: count, timestamp: ts });
});

const PORT = 3091; // separate from main app (3090) so they can run side-by-side
app.listen(PORT, () => {
  console.log(`[PoC server] listening on http://localhost:${PORT}`);
});

module.exports = { app, getLastCapture: () => lastCapture };
