/**
 * server/auth.js  (v2.4.0)
 *
 * Simulated IBM SSO authentication layer.
 *
 * HOW IT WORKS (SIMULATE_SSO=true  — test mode):
 *   - GET  /login          → serve public/login.html
 *   - POST /auth/login     → look up ibm_id in the `users` table,
 *                            bcrypt-compare password, write session, redirect to /
 *   - GET  /auth/logout    → destroy session, redirect to /login
 *
 * HOW TO SWAP TO REAL IBM w3id (SIMULATE_SSO=false — production):
 *   Replace the POST /auth/login handler below with a Passport.js OIDC strategy
 *   pointed at process.env.OIDC_ISSUER_URL using process.env.OIDC_CLIENT_ID and
 *   process.env.OIDC_CLIENT_SECRET.  Everything else — sessions, requireAuth,
 *   all DB queries — stays IDENTICAL.  The session shape is the same either way:
 *     req.session.user = { ibm_id, display_name, role, team }
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const db       = require('./db');

const router = express.Router();

const SIMULATE_SSO = process.env.SIMULATE_SSO !== 'false'; // default true

// ---------------------------------------------------------------------------
// GET /login  — serve the login page
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  // If already logged in, bounce to app
  if (req.session && req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ---------------------------------------------------------------------------
// POST /auth/login  — validate credentials and establish session
// ---------------------------------------------------------------------------
router.post('/auth/login', (req, res) => {
  const { ibm_id, password } = req.body || {};

  if (!ibm_id || !password) {
    return res.redirect('/login?error=missing');
  }

  if (SIMULATE_SSO) {
    // ── Mock path: look up user in local SQLite users table ──────────────────
    const user = db.prepare('SELECT * FROM users WHERE ibm_id = ?').get(ibm_id.trim().toLowerCase());

    if (!user) {
      console.log(`[auth] Login failed — unknown ibm_id: ${ibm_id}`);
      return res.redirect('/login?error=invalid');
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      console.log(`[auth] Login failed — wrong password for: ${ibm_id}`);
      return res.redirect('/login?error=invalid');
    }

    req.session.user = {
      ibm_id:       user.ibm_id,
      display_name: user.display_name,
      role:         user.role  || '',
      team:         user.team  || '',
    };

    console.log(`[auth] Login OK — ${user.display_name} (${user.ibm_id})`);
    return res.redirect('/');

  } else {
    // ── Production path: redirect to IBM w3id OIDC ──────────────────────────
    // Passport.js OIDC strategy would be mounted here.
    // For now, return a clear message so the swap is obvious.
    return res.status(501).send(
      'Real IBM w3id SSO not yet configured. Set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in .env.'
    );
  }
});

// ---------------------------------------------------------------------------
// GET /auth/logout  — destroy session and redirect to login
// ---------------------------------------------------------------------------
router.get('/auth/logout', (req, res) => {
  const name = req.session?.user?.display_name || 'User';
  req.session.destroy(() => {
    console.log(`[auth] Logout — ${name}`);
    res.redirect('/login');
  });
});

// ---------------------------------------------------------------------------
// GET /api/me  — returns the current session user (used by the frontend)
// ---------------------------------------------------------------------------
router.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(req.session.user);
});

module.exports = router;
