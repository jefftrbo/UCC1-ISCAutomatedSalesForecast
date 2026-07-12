# UCC1 — Planning Session Log

> Full transcript of the initial planning session between the Sales VP and Bob (AI Technical Lead) for the ISC Automated Sales Forecast project.

---

## Requirements (UCC1-Requirements.md)

> *As originally written, with user answers inline:*

1. We need the ability to extract current sales forecast data from ISC in preparation for our Sales VP's weekly meeting w US Public Sector General Manager (GM)
2. In a perfect scenario, I'd like to provide you w a URL to the ISC web page that would act as a source of that data, providing you w the fields that I need extracted to be stored an appropriate datastore of your choice
3. Once the data is stored, I need you to create a simple web page that would give our Sales VP to choose which sales opportunities to include in this week's GM meeting
4. Create an executive business appropriate powerpoint containing that information

---

## Bob's Initial Feasibility Assessment

### What's Being Asked — Analysis

The requirements describe a **4-stage automated pipeline**:

**ISC Web Page URL → Extract → Datastore → Selection UI (Sales VP Web App) → Generate → Executive PowerPoint**

#### Req 1 — Extract sales forecast data from ISC
**Feasibility: Conditionally possible**

ISC (IBM Sales Cloud) is IBM's internal CRM. Data extraction depends on how the data is accessed:
- If ISC exposes a URL-accessible page (req 2) — web scraping is possible but fragile; ISC likely requires authenticated sessions (IBM w3id SSO)
- If ISC has an API (many CRM platforms do) — that is far more reliable and maintainable
- The main **blocker**: authentication. IBM w3id login is SAML/SSO-based, which makes headless scraping significantly more complex

#### Req 2 — Provide a URL as the data source
**Feasibility: The hardest part**

This is the critical dependency. A few questions determine what's actually buildable:
- Is the ISC page publicly accessible, or does it require IBM VPN + w3id login?
- Is there an ISC API or export (CSV/Excel) that can serve as the data source instead?
- What specific fields need to be extracted? (Opportunity name, stage, close date, revenue, account, etc.)

Without API access or a clean export mechanism, scraping an authenticated enterprise CRM is technically difficult and fragile.

#### Req 3 — Simple web page for opportunity selection
**Feasibility: Fully buildable**

A straightforward React or plain HTML/JS web app that:
- Reads from the chosen datastore
- Displays a filterable/selectable table of opportunities
- Lets the VP check which ones to include in the GM meeting

#### Req 4 — Generate an executive PowerPoint
**Feasibility: Fully buildable**

Using libraries like `pptxgenjs` (Node.js), a polished, executive-appropriate `.pptx` can be generated automatically from the selected opportunities.

---

## Q&A — Data Source

**Bob:** How is the ISC sales forecast data actually accessible? This determines everything about the data extraction approach.

**Options presented:**
- ISC has a web page I can give you a URL to — I expect you to scrape or parse it (we can handle the IBM w3id SSO login separately)
- ISC supports data export (CSV or Excel download) — I can provide a sample export file as the input source
- ISC has a REST API or Salesforce-based API that we can call with credentials
- I'm not sure yet — let's design the system so the data source can be swapped in later, and start with a mock/sample dataset

**User answers (from UCC1-Requirements.md):**

> **On the web page / URL option:**
> I don't have access to any ISC APIs, so if I were to login w my IBM SSO credentials then give you that URL, would you be able to access it? If "no", can I invoke the code you may write directly from another URL to kick off your scrape process?

> **On the CSV/Excel export option:**
> ISC does not support data export because IBM's senior execs want to eliminate xls based reporting and conduct such reporting "off of the ISC glass"

> **On the REST API option:**
> No

---

## Q&A — Scraper Architecture

**Bob:** Here's my understanding of the data extraction approach. Does this match your mental model?

> The app would include a "Refresh Data" button on the web page. When clicked, it launches a headless browser (running on your machine or a local server) that opens ISC in a real browser session using your IBM SSO cookie/session, navigates to the URL you provide, scrapes the forecast fields, and saves them to a local datastore. You never need to give me direct access to ISC — the scraper runs locally under your session.

**User:** Yes — that's exactly what I need. The scraper runs locally, I trigger it from the web app, and it pulls data under my authenticated session.

---

## Q&A — Data Fields

**Bob:** What fields do you need extracted from the ISC forecast page?

**User:** For right now, let's focus on the standard opportunity fields and expect me to ask for additional fields later.

*Standard fields agreed: Opportunity Name, Account Name, Stage, Close Date, Expected Revenue, Seller Name*

---

## Q&A — PowerPoint Format

**Bob:** For the executive PowerPoint, what format/style do you need?

**User:** Clean minimal format for now, and I'll provide you w a PPT template for submission to our GM.

---

## Final Architecture Agreed Upon

**Full stack — runs entirely on user's local machine:**

```
[ISC Web Page — user's SSO session]
        ↓  Playwright headless scraper
[SQLite DB — opportunities.db]
        ↓
[Express API — localhost:3000]
        ↓
[Web App UI — Opportunity Selector]
        ↓
[pptxgenjs — forecast-DATE.pptx]
```

**Tech stack:**
- Runtime: Node.js
- Scraper: Playwright (persistent browser profile preserves IBM SSO session)
- Backend: Express.js
- Database: SQLite via `better-sqlite3`
- Frontend: Plain HTML/CSS/JS
- PowerPoint: `pptxgenjs`

**Key design decisions:**
- No cloud infrastructure, no credentials stored anywhere
- User logs in to ISC once via a visible browser; all subsequent scrapes are headless/automatic
- ISC URL stored in `config.json` — DOM selectors tunable without code changes
- IBM PPT template placeholder hook built in from the start
- Schema designed to accommodate additional fields on request

---

## Plan Output

Plan written to: `UCC1-plan.md`

### Sub-Tasks Summary

| # | Sub-Task | Status |
|---|---|---|
| 1 | Project Scaffold — folder structure, `package.json`, README | `[ ] pending` |
| 2 | SQLite Schema — opportunities table with standard fields + `selected` flag | `[ ] pending` |
| 3 | ISC Scraper — Playwright with persistent SSO profile, config-driven URL | `[ ] pending` |
| 4 | Express Backend — API endpoints for opportunities, scrape trigger, PPT generation | `[ ] pending` |
| 5 | PowerPoint Generator — cover slide + opportunity table, IBM template hook | `[ ] pending` |
| 6 | Frontend Web App — table, checkboxes, Refresh Data button, Generate PPT button | `[ ] pending` |

### Open Items / Still Needed

1. **Real ISC forecast page URL** — required to tune Playwright DOM selectors
2. **IBM PPT template file** — for GM-submission formatting (placeholder hook is ready)
3. **Additional fields** — user may request extra ISC fields beyond the standard set

---

*Session date: 2025 | Project: UCC1-ISCAutomatedSalesForecast*
