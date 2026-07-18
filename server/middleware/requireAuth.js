/**
 * server/middleware/requireAuth.js  (v2.4.0)
 *
 * Express middleware — applied to all /api/* routes and the main app page.
 * If the request has no valid session, it redirects to /login (browser
 * requests) or returns 401 JSON (API requests without Accept: text/html).
 *
 * Skipped routes (public, no auth needed):
 *   GET  /login
 *   POST /auth/login
 *   GET  /auth/logout
 *   GET  /api/me         (checked separately in auth.js)
 */

'use strict';

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();

  // API callers get JSON 401
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
  }

  // Browser requests get redirected to login
  return res.redirect('/login');
}

module.exports = requireAuth;
