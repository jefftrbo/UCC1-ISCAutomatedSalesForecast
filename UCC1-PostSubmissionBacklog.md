# UCC1 — Post-Submission Backlog
## ISC Automated Sales Forecast — Items deferred past July 22, 2026 challenge deadline

> Captured during Session 29 (July 18, 2026). These items were discussed in full
> but deliberately deferred to avoid scope creep before submission. Every item
> here is design-complete — the architecture, rationale, and implementation plan
> were fully worked through in conversation.
>
> **Resume instruction:** Tell Bob "Read UCC1-TechnicalSessionLog.md and pick up
> where we left off" then reference this file for the deferred backlog.

---

## v2.6.0 — Per-User HAR Upload (Multi-User Server Deployment)

### Problem Statement

The current HAR ingestion design uses a single hardcoded file path:

```js
const HAR_FILE = path.join(__dirname, 'isc-export.har');
```

This is a **single shared file**. In a multi-user server deployment (1–100 Public
Market users), User A uploads their HAR, User B uploads theirs 30 seconds later —
User B's file silently overwrites User A's before User A's import finishes. This is
a race condition that corrupts data without any error message.

### Why This Matters

The current design only works safely on a single developer's local machine. As soon
as the app is deployed to a real datacenter/cloud server:

- Multiple users are logged in concurrently at various times throughout the week
- Each user has their own ISC view with their own pipeline data
- The HAR export workflow (Cmd+Opt+I → Network → Export HAR) produces a file on
  the user's local machine that must somehow reach the server
- There is no safe mechanism to store a shared `isc-export.har` on the server — it
  would be immediately overwritten by the next user's upload

### Designed Solution

**HAR files are named per-user and stored per-user on the server.**

Naming convention: sanitize the userId (IBM email) by replacing `@` and `.` with
underscores:

```
scraper/har/dkpatel_us.ibm.com.har
scraper/har/spencer.korn_ibm.com.har
scraper/har/kim.salatino_ibm.com.har
```

**New endpoint:** `POST /api/upload-har`
- Accepts `multipart/form-data` with the HAR file
- Authenticated via `requireAuth` — userId comes from `req.session.user.id`
- Saves to `scraper/har/{sanitized-userId}.har`
- Immediately triggers the import pipeline (same logic as current `/api/scrape`)
- Streams import progress back to browser (same SSE pattern as current Refresh Data)

**Modified scrape flow in `server/index.js`:**
- Priority 1: `scraper/har/{sanitized-userId}.har` (uploaded by this user)
- Priority 2: `scraper/isc-export.har` (legacy local dev fallback — MBP only)
- Priority 3: devtools JSON / Playwright (existing fallback chain)
- If none found: return clear error — "No HAR file found. Use the file picker."

**UI change in `public/index.html`:**
- Add `<input type="file" accept=".har">` file picker above the Refresh Data button
- On file select → POST to `/api/upload-har` → on success → trigger scrape stream
- Local dev note (shown only when `DEV_MODE=true` env var): "Local dev: file picker
  optional — place HAR at `scraper/isc-export.har` as fallback"
- In production: file picker is the only path (no fallback)

**`.gitignore` update:**
- Replace `scraper/isc-export.har` with `scraper/har/` (entire directory gitignored)

### Local Dev Backward Compatibility

The fallback chain ensures zero workflow disruption for local development:

| Scenario | Experience |
|---|---|
| Local dev, your MBP | Drop `isc-export.har` in `scraper/` as always — zero change |
| Local dev, co-developer with test-users.csv | Same fallback OR use file picker |
| Server deployment, any user | File picker is the only path |
| Server deployment, admin re-import | Per-user HAR already on `scraper/har/{userId}.har` — admin re-triggers via API |

### Additional Benefits (Not In Current Design)

1. **Re-import without re-scraping:** Per-user HAR persists on the server — admin
   can re-run any user's import without requiring them to re-export from ISC
2. **Audit trail:** Server can record `har_uploaded_at` timestamp per user — VP can
   see how fresh each user's data is without asking them
3. **Parallel imports:** No race condition — each user's import reads its own file,
   writes to its own `user_id`-namespaced DB rows

### Files That Change

| File | Change |
|---|---|
| `server/index.js` | New `POST /api/upload-har` endpoint; scrape reads userId-namespaced path with fallback |
| `scraper/load-from-har.js` | Accept file path as CLI argument instead of hardcoded constant |
| `public/index.html` | File picker `<input>` above Refresh Data; upload → scrape flow |
| `.gitignore` | `scraper/isc-export.har` → `scraper/har/` |
| `server/index.js` | `multer` or manual `busboy` for multipart — evaluate adding dependency |

### Open Question Before Build

The `Opp.FLM.User_Name_mk__c` field (manager name) is in the `pick()` candidate
list in `scraper/load-from-har.js` but has never populated in any HAR import run
to date. The HAR on disk as of July 18, 2026 only has 8 records and does not
contain this field. A fresh full-pipeline HAR from Duey's view is needed to
confirm the exact field name the ISC `/wave/query` response uses for manager names.
Once confirmed, add to `pick()` list if not already present.

**Partner seller note (confirmed July 18, 2026):** Reps like Jeanene Cassels
(Mainline, a partner seller) correctly show `—` for manager in ISC because they are
not in IBM LDAP. They have ISC access to enter deals but no IBM user hierarchy.
The `—` in Team Hygiene for these reps is correct and expected — do NOT treat it
as a data quality problem.

---

## v2.6.1 — watsonx.ai Granite Upgrade for Next Steps Quality Scoring

### Summary

Replace the `scoreNextStepsQuality()` placeholder in `server/hygieneScore.js` with
a real `granite-3.3-8b` API call that rates Next Steps text for:
- Specificity (named person, named action, named date)
- Ambiguous language detection ("will follow up", "pending", "TBD")
- Deal momentum signal (forward motion vs. holding pattern language)

### What Does NOT Change

The upgrade path is documented in `server/hygieneScore.js` header. Only the NS
quality sub-score function is swapped — all other scoring logic, action item
generation, UI, and endpoints are unchanged. This is a one-function replacement,
not an architecture change.

### Prerequisite

Live `WATSONX_ENABLED=true` credential test must pass first. See human-action
blockers table in `UCC1-TechnicalSessionLog.md`.

---

## v2.6.2 — Per-Rep Coaching Narrative via watsonx.ai llama-3-70b

### Summary

Add a "Generate Coaching Brief" button to the Team Hygiene tab that sends the
selected rep's hygiene data to `llama-3-70b-instruct` and returns a paragraph-form
coaching brief the VP can share with the rep's first-line manager. Input: owner,
dealCount, blankNs, staleNs, liarDeals, flmOverrides, avgHygieneScore,
coachingFlag, sample deal names. Output: 2–3 sentence professional coaching note.

---

## v2.7.0 — Cloud Deployment (CIO "Build with watsonx" Path to Production)

### Summary

Deploy the app to IBM Cloud (Code Engine or Kubernetes) with:
- Real IBM w3id OIDC (swap 1 code block + 2 env vars — already architected)
- PostgreSQL replacing SQLite (schema is portable — no ORM lock-in)
- Per-user HAR upload (v2.6.0 prerequisite)
- ServiceNow AI System Demand submitted and approved
- IBM Cloud Object Storage for HAR file persistence (replaces local `scraper/har/`)

### Prerequisite Human Actions

| Action | Owner |
|---|---|
| Complete PLAN-3067F00C01E4 on Your Learning | Trbovich |
| Register at w3.ibm.com/w3publisher/challenge | Trbovich |
| Identify Risk & Compliance Lead for ServiceNow | Trbovich |
| Submit ServiceNow AI System Demand | Trbovich + R&C Lead |
| IBM app registration for real w3id OIDC | IBM IT / app registration team |

---

## Deferred UX Items

| Item | Description | Effort |
|---|---|---|
| Pre-compute `_hygieneGrade` on `loadOpportunities()` | Health icons are coloured on table load without requiring a click. Known v2.5.0 limitation. | Small |
| Manager column in Team Hygiene | Populate once HAR field name confirmed (see v2.6.0 open question above) | Trivial once field name known |
| Drop Manager column if always blank | If HAR never includes manager field, remove the column entirely to clean up the table | 2 lines |

---

*UCC1 — ISC Automated Sales Forecast · Post-submission backlog · Captured July 18, 2026*
*Built with IBM Bob · IBM watsonx Challenge 2026 · Growth Enablers Track*
