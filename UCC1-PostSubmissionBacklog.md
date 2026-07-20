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

## v2.7.1 — User-Uploaded PTMP Templates (Per-User Format Customization)

### Problem Statement

The current `generatePtmpSlide()` builds a slide from scratch using hardcoded coordinates designed for Frank Attaie's PTMP format. Every IBM VP has a different leadership upline with a different PTMP format. A TSL reporting to a VP in a different org may use a 6-column summary table, different section order, different branding — the app can't burn one hardcoded layout into the binary and serve all users.

### Two Modes

**Mode A — Build from scratch (current):** `pptxgenjs` draws the slide using our coordinate system. Works for users whose VP uses Frank Attaie's format.

**Mode B — Populate a user-supplied template (new):** User uploads their org's actual PTMP `.pptx` file. The app finds `{{token}}` placeholders the user has placed in their template and replaces them with live deal data. This is how Clari, Gong, and Salesforce CRM Analytics handle customer-supplied report formats.

### Token Convention

The user places these tokens as text in any text box or table cell in their `.pptx` template:

```
{{LAST_NAME}}           → "Patel"
{{TEAM_LABEL}}          → "3Q26"
{{BUDGET}}              → "$175.0M"
{{CALL_TOTAL}}          → "$146.7M"
{{GAP}}                 → "$28.3M"
{{UPSIDE}}              → "$495.2M"
{{STRETCH}}             → "$495.2M"
{{CALL_DEAL_1}} … {{CALL_DEAL_12}}   → "State Farm   Hybrid Cloud ELA   $12.5M"
{{GAP_DEAL_1}}  … {{GAP_DEAL_8}}    → "AT&T   watsonx.data ELA   $8.2M"
{{ACTION_1}}    … {{ACTION_8}}       → "Push Maersk renewal to commit"
{{GENERATED_DATE}}      → "Jul 19, 2026"
```

### Technical Approach

The PPTX format is a ZIP archive containing XML. After upload, the server:
1. Unzips the file in memory
2. For each slide XML (`ppt/slides/slide*.xml`), runs a regex replace on all `{{TOKEN}}` patterns
3. Re-zips the modified XML back into a new PPTX
4. Returns the populated file to the browser

No `pptxgenjs` needed for template-fill mode — pure XML string replacement. Library candidate: `pizzip` + `docxtemplater` (already used in similar PPT templating tools), or a hand-rolled `JSZip` + regex pass (fewer dependencies).

### Template Validation on Upload

After upload, the server does a dry-run scan of the XML and reports which tokens were found vs. missing:

```json
{
  "found": ["BUDGET", "CALL_TOTAL", "GAP", "CALL_DEAL_1", "ACTION_1"],
  "missing": ["UPSIDE", "STRETCH", "CALL_DEAL_2"],
  "warning": "Tokens GAP_DEAL_1…8 not found — gap deal list will not populate"
}
```

This gives the user confidence their template is wired correctly before their next GM meeting.

### New DB Table

```sql
CREATE TABLE ptmp_templates (
  id          TEXT PRIMARY KEY,       -- UUID
  user_id     TEXT NOT NULL,           -- tenant isolation
  label       TEXT NOT NULL,           -- e.g. "Frank Attaie Q3 Format"
  filename    TEXT NOT NULL,           -- original filename
  uploaded_at TEXT NOT NULL,
  is_default  INTEGER DEFAULT 1        -- 1 = active, 0 = superseded
)
```

### File Storage

`templates/{sanitized_user_id}/{uuid}.pptx` — directory is already gitignored (confirmed: `templates/` present in untracked files as of v2.6.1). Keep last 2 uploads per user; auto-retire older ones (set `is_default = 0`).

### New Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/ptmp-template/upload` | multipart, stores file + DB row, returns `{ id, label, tokensFound, tokensMissing }` |
| `GET /api/ptmp-template` | returns user's active template metadata |
| `DELETE /api/ptmp-template/:id` | removes template + file from disk |

### Modified Endpoint

`POST /api/generate-ptmp` — updated logic:
1. Check if user has an active template in `ptmp_templates`
2. If yes → template-fill mode (XML replacement)
3. If no → build-from-scratch mode (current `pptxgenjs` path)
4. If template mode fails → fall back to build-from-scratch + `warning` field in response JSON

### UX Changes in PTMP Modal

Add a "Template" section above the budget input:
- **No template uploaded:** grey dashed upload zone — "Upload your org's PTMP .pptx to use your exact format (one-time setup)"
- **Template active:** show filename + upload date + "✓ Active" badge + small "Replace" link
- Upload is a one-time setup — persists across sessions

### Constraints

1. `multer` 10MB file size cap
2. No WYSIWYG template editor (scope explosion)
3. No auto-detection of layout regions (too fragile — PPT XML structure varies per org)
4. No server-side preview/rendering (requires LibreOffice — not available here)
5. Token convention is intentional: forces user to be explicit, which makes generation reliable

### Prerequisite

Per-user HAR upload (v2.6.0 in this backlog) should land first — it establishes the `multer` multipart upload pattern and the `templates/` directory convention. PTMP template upload reuses both.

### Files That Change

| File | Change |
|---|---|
| `server/db.js` | New `ptmp_templates` table + migration |
| `server/index.js` | `POST /api/ptmp-template/upload`, `GET`, `DELETE`; modified `POST /api/generate-ptmp` with fallback logic |
| `server/generatePpt.js` | New `fillPtmpTemplate(templatePath, data)` function — JSZip + regex replacement |
| `public/index.html` | Template upload zone in PTMP modal |
| `.gitignore` | `templates/` (already present as untracked — add explicit entry) |

---

## v2.6.2 — Multi-Column Sort Modal (User-Driven Sort Stack)

**Priority: HIGH — small effort, strong demo value, buildable before 7/22 if time permits**

### Problem Statement

The pipeline table sorts by a single column at a time. The current default (Confidence score, descending) is invisible to the user — there is no label, no indicator, no way to know *why* the rows are in the order they're in without being told. More critically, a VP hunting for Best Case / Stretch candidates needs to organize data by a *deal-hunting mental model*, not by confidence score:

> "Show me all Q3 deals, grouped by account, with largest amount first."
> "Show me everything closing in September, sorted by stage so I can see what's closest to close."

Neither of these is possible today. The user can click a column header to set one sort key, but can't stack keys.

### What It Does

A **"⇅ Sort"** button in the action bar (or near the filter controls) opens a sort modal with a drag-or-ordered pick list. The user builds a sort stack from the available columns, sets direction (↑ / ↓) for each key, and clicks Apply. The table re-renders with a multi-level comparator. The active sort is shown as a readable pill row under the table header: `Sorted by: Quarter ↑ → Account ↑ → Close Date ↑`.

Example outcome (your exact use case):
```
Quarter ↑ → Account Detail ↑ → Stage ↑ → Close Date ↑ → Total Amt ↓ → Forecast ↑
```

### Technical Design

**Sort stack:** Replace the single `sortCol` / `sortDir` variables with an array:
```js
let sortStack = [{ col: 'score', dir: 'desc' }]; // default — same as today
```

**Comparator in `renderTable()`:** Walk the stack until a non-zero comparison is found:
```js
const sorted = [...filtered].sort((a, b) => {
  for (const { col, dir } of sortStack) {
    let va = a[col], vb = b[col];
    if (col === 'score' || col.includes('amount')) { va = va ?? 0; vb = vb ?? 0; }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
  }
  return 0;
});
```

**Column label map** — internal DB column name → display label (needed for the modal pick list):
```js
const COL_LABELS = {
  score:                        'Confidence Score',
  closeQuarter:                 'Quarter',
  account_name:                 'Account Detail',
  stage:                        'Stage',
  close_date:                   'Close Date',
  filtered_opportunity_amount:  'IBM Tech Amt',
  total_opportunity_amount:     'Total Amt',
  forecast_category:            'Forecast',
  opportunity_owner:            'Owner',
  opportunity_owners_manager:   "Owner's Manager",
  flm_judgement:                'FLM Judgement',
  opportunity_name:             'Opportunity',
  create_date:                  'Create Date',
};
```

**Modal structure:** A small modal (narrower than the diff modal — ~520px) with:
- A list of active sort keys (up to 6), each showing: [column dropdown] [↑/↓ toggle] [✕ remove]
- "Add level" button (disabled when 6 keys active)
- "Apply" / "Clear Sort" / "Cancel" buttons
- No drag-and-drop in Phase 1 — ordered list with Add/Remove only

**Single-click column header sort:** Still works — clicking a `th` sets `sortStack = [{ col, dir }]` (replaces the whole stack with one key). The sort pill row updates accordingly. Backward-compatible.

### Phase 2: Group-by Visual Dividers

When the first sort key is a categorical field (Quarter, Stage, Forecast, Owner), insert a `<tr class="group-header">` row between value changes. This makes the table read as a structured report:

```
── Q3 2026 ──────────────────────────────
  State Farm   Hybrid Cloud ELA   $12.5M   Best Case
  AT&T         watsonx.data ELA   $8.2M    Pipeline
── Q4 2026 ──────────────────────────────
  Ford Motor   Maximo Upgrade     $3.1M    Pipeline
```

Phase 2 is separate from Phase 1 (the sort stack). Calling it out here so it's not forgotten — the group-header `<tr>` approach is clean and requires ~20 lines.

### Effort Estimate

| Phase | Scope | Estimate |
|---|---|---|
| Phase 1: Sort stack + modal | All client-side, zero server changes | ~105 lines |
| Phase 2: Group-by divider rows | Client-side, `renderTable()` only | ~20 lines |

### Files That Change

| File | Change |
|---|---|
| `public/index.html` | Replace `sortCol`/`sortDir` with `sortStack` array; update `renderTable()` comparator; add sort modal HTML + CSS; add "⇅ Sort" button to action bar; add sort pill display row; update single-click `th` handler |

**Zero server changes. Zero DB changes. Zero new dependencies.**

### Named Preset Integration

The sort stack can be saved into the named view presets (v2.2.0 feature). "GM Prep" preset could default to `Quarter ↑ → Forecast ↑ → Total Amt ↓`. This is an optional Phase 3 enhancement, not required for Phase 1.

---

## Deferred UX Items

| Item | Description | Effort |
|---|---|---|
| Pre-compute `_hygieneGrade` on `loadOpportunities()` | Health icons are coloured on table load without requiring a click. Known v2.5.0 limitation. | Small |
| Manager column in Team Hygiene | Populate once HAR field name confirmed (see v2.6.0 open question above) | Trivial once field name known |
| Drop Manager column if always blank | If HAR never includes manager field, remove the column entirely to clean up the table | 2 lines |

---

*UCC1 — ISC Automated Sales Forecast · Post-submission backlog · Captured July 18–19, 2026*
*Built with IBM Bob · IBM watsonx Challenge 2026 · Growth Enablers Track*
