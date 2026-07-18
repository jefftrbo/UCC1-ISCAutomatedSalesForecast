#!/usr/bin/env node
/**
 * scripts/init-users.js  (v2.4.0)
 *
 * Reads scripts/test-users.csv and populates the `users` table in the DB.
 * Also assigns the existing 211 real pipeline rows (and any baseline_ledger
 * rows) to Dushyant Patel (the first user in the CSV — dkpatel@us.ibm.com).
 *
 * Run once after cloning / upgrading:
 *   node scripts/init-users.js
 *
 * Safe to re-run — uses INSERT OR REPLACE, so passwords update if CSV changes.
 * Does NOT wipe existing user data.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const db     = require('../server/db');

const CSV_PATH = path.join(__dirname, 'test-users.csv');

if (!fs.existsSync(CSV_PATH)) {
  console.error(`ERROR: ${CSV_PATH} not found.`);
  console.error('Create scripts/test-users.csv with columns: ibm_id,display_name,password,role,team');
  process.exit(1);
}

// ── Parse CSV (simple — no external deps needed) ──────────────────────────────
const lines = fs.readFileSync(CSV_PATH, 'utf8')
  .replace(/^\uFEFF/, '')          // strip BOM if present
  .split('\n')
  .map(l => l.trim())
  .filter(Boolean);

const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
const colIdx  = h => headers.indexOf(h);

const users = lines.slice(1).map(line => {
  // Handle quoted fields (fields may contain commas inside quotes)
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur.trim());

  return {
    ibm_id:       (fields[colIdx('ibm_id')]       || '').toLowerCase().trim(),
    display_name: (fields[colIdx('display_name')] || '').trim(),
    password:     (fields[colIdx('password')]     || '').trim(),
    role:         (fields[colIdx('role')]         || '').trim(),
    team:         (fields[colIdx('team')]         || '').trim(),
  };
}).filter(u => u.ibm_id && u.password);

if (users.length === 0) {
  console.error('ERROR: No valid users found in CSV. Check column names and data.');
  process.exit(1);
}

// ── Insert / update users ─────────────────────────────────────────────────────
const upsertUser = db.prepare(`
  INSERT INTO users (ibm_id, display_name, password_hash, role, team)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(ibm_id) DO UPDATE SET
    display_name  = excluded.display_name,
    password_hash = excluded.password_hash,
    role          = excluded.role,
    team          = excluded.team
`);

const SALT_ROUNDS = 10;
let inserted = 0;

db.transaction(() => {
  for (const u of users) {
    const hash = bcrypt.hashSync(u.password, SALT_ROUNDS);
    upsertUser.run(u.ibm_id, u.display_name, hash, u.role, u.team);
    console.log(`  ✓ ${u.display_name.padEnd(24)} ${u.ibm_id.padEnd(34)} role: ${u.role}`);
    inserted++;
  }
})();

console.log(`\n✅ ${inserted} users loaded into the users table.\n`);

// ── Assign existing untagged rows to the first user (Dushyant) ───────────────
const primaryUser = users[0];
console.log(`Assigning untagged rows to primary user: ${primaryUser.display_name} (${primaryUser.ibm_id})`);

const oppResult = db.prepare(
  `UPDATE opportunities SET user_id = ? WHERE user_id IS NULL`
).run(primaryUser.ibm_id);

const ledgerResult = db.prepare(
  `UPDATE baseline_ledger SET user_id = ? WHERE user_id IS NULL`
).run(primaryUser.ibm_id);

console.log(`  opportunities   → ${oppResult.changes} rows tagged as ${primaryUser.ibm_id}`);
console.log(`  baseline_ledger → ${ledgerResult.changes} rows tagged as ${primaryUser.ibm_id}`);
console.log(`\n✅ Database ready for multi-tenant use.`);
console.log(`\nNext: node server/index.js  →  open http://localhost:3090/login`);
