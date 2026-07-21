/**
 * server/generatePpt.js
 *
 * Generates a clean IBM-branded executive PowerPoint from selected sales opportunities.
 * v2.0.0: accepts optional `narrative` param ({paragraph, bullets}) for the cover slide.
 *
 * Slide 1: Cover — "US Public Sector Sales Forecast" + week date + optional GM narrative
 * Slide 2+: Opportunity table (auto-paginates at ROWS_PER_SLIDE rows per slide)
 *
 * TODO: When the IBM PPT template is provided, load it here using:
 *   pres.load('path/to/ibm-template.pptx')
 *   and apply master slide / layout names from the template.
 */

const PptxGenJS = require('pptxgenjs');

const IBM_BLUE = '0043CE';   // IBM Blue 60
const IBM_DARK = '161616';   // IBM Gray 100
const IBM_GRAY = '6F6F6F';   // IBM Gray 60
const WHITE    = 'FFFFFF';

// Slide geometry (LAYOUT_WIDE = 13.33" × 7.5")
const SLIDE_H        = 7.5;
const TABLE_TOP      = 0.75;  // y where table starts (below header bar)
const BOTTOM_BAR_Y   = 6.85;  // y where bottom bar starts

// pptxgenjs ignores rowH when cell content forces the row taller.
// The only reliable way to keep rows at a fixed height is to ensure
// no cell ever wraps — so we truncate Next Steps to NEXT_STEPS_CHARS,
// which fits in one line at 8pt in a 2.1" column (empirically ~55 chars).
// We then use a conservative ROWS_PER_SLIDE derived from the actual
// usable height with an explicit safety margin baked in.
const NEXT_STEPS_CHARS = 55;   // max chars in Next Steps cell — keeps row single-line
const HEADER_ROW_H   = 0.32;   // header row height (inches)
const DATA_ROW_H     = 0.40;   // data row height with padding — must match single-line row
const ROWS_PER_SLIDE = 12;     // hard ceiling: 0.75 + 0.32 + (12×0.40) = 5.87" < 6.85"

/**
 * Format a number as USD currency string.
 * @param {number} value
 * @returns {string}
 */
function formatCurrency(value) {
  if (!value && value !== 0) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Generate the forecast PowerPoint.
 * @param {Array<Object>} opportunities  selected opportunity rows from SQLite
 * @param {string}        outputPath     absolute path where .pptx is written
 * @param {{ paragraph?: string, bullets?: string[] }} [narrative]  optional GM narrative for cover
 * @param {object} [diff]  optional week-over-week diff from diffEngine.computeDiff()
 * @param {{ paragraph?: string, bullets?: string[] }} [deltaSummary]  optional AI delta summary
 * @returns {Promise<void>}
 */
async function generatePpt(opportunities, outputPath, narrative = null, diff = null, deltaSummary = null) {
  const pres = new PptxGenJS();

  // Presentation defaults
  pres.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"
  pres.author = 'ISC Automated Sales Forecast';
  pres.subject = 'US Public Sector GM Meeting';

  // Week label for subtitle
  const now = new Date();
  const weekLabel = `Week of ${now.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })}`;

  // ---------------------------------------------------------------------------
  // Slide 1 — Cover
  // ---------------------------------------------------------------------------
  const cover = pres.addSlide();

  // Full-width IBM Blue header bar
  cover.addShape(pres.ShapeType.rect, {
    x: 0, y: 0, w: '100%', h: 1.5,
    fill: { color: IBM_BLUE },
  });

  // Title
  cover.addText('US Public Sector Sales Forecast', {
    x: 0.5, y: 0.25, w: 12, h: 1,
    fontSize: 32,
    bold: true,
    color: WHITE,
    fontFace: 'Calibri',
  });

  // Week subtitle
  cover.addText(weekLabel, {
    x: 0.5, y: 1.8, w: 12, h: 0.6,
    fontSize: 18,
    color: IBM_DARK,
    fontFace: 'Calibri',
  });

  // Summary line
  cover.addText(`${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'} selected for GM review`, {
    x: 0.5, y: 2.5, w: 12, h: 0.5,
    fontSize: 14,
    color: IBM_GRAY,
    fontFace: 'Calibri',
  });

  // GM Narrative block (optional — present when narrative was generated)
  if (narrative && narrative.paragraph) {
    const NARRATIVE_BLUE = '0F62FE';

    // Thin divider line
    cover.addShape(pres.ShapeType.line, {
      x: 0.5, y: 3.15, w: 12.33, h: 0,
      line: { color: 'e0e0e0', width: 0.5 },
    });

    // "GM BRIEFING" label
    cover.addText('GM BRIEFING', {
      x: 0.5, y: 3.25, w: 12, h: 0.25,
      fontSize: 9,
      bold: true,
      color: NARRATIVE_BLUE,
      fontFace: 'Calibri',
      charSpacing: 2,
    });

    // Paragraph text (wraps automatically)
    cover.addText(narrative.paragraph, {
      x: 0.5, y: 3.55, w: 12.33, h: 1.5,
      fontSize: 11,
      color: IBM_DARK,
      fontFace: 'Calibri',
      wrap: true,
      valign: 'top',
    });

    // Bullet points
    if (narrative.bullets && narrative.bullets.length > 0) {
      const bulletRows = narrative.bullets.map(b => ({
        text: b,
        options: { bullet: { type: 'bullet' }, fontSize: 10, color: IBM_DARK, fontFace: 'Calibri' },
      }));
      cover.addText(bulletRows, {
        x: 0.5, y: 5.1, w: 12.33, h: 1.5,
        fontFace: 'Calibri',
        wrap: true,
        valign: 'top',
      });
    }
  }

  // Bottom accent bar
  cover.addShape(pres.ShapeType.rect, {
    x: 0, y: 6.9, w: '100%', h: 0.6,
    fill: { color: IBM_BLUE },
  });

  // ---------------------------------------------------------------------------
  // Slide 2+ — Opportunity Table (paginates every ROWS_PER_SLIDE rows)
  // ---------------------------------------------------------------------------
  // Executive-appropriate columns for GM presentation.
  // Full data is available in the web app; PPT shows the decision-relevant subset.
  const HEADERS = [
    'Opportunity',
    'Account',
    'Stage',
    'Forecast',
    'Close Date',
    'IBM Tech Amt',
    'Total Amt',
    'Owner',
    'FLM Judgement',
    'Next Steps',
  ];

  // Column widths (inches) — total = 13.0 for LAYOUT_WIDE
  const COL_WIDTHS = [2.4, 1.8, 0.9, 0.9, 0.8, 0.95, 0.95, 1.3, 0.8, 2.1];

  // Split opportunities into pages
  for (let pageStart = 0; pageStart < opportunities.length; pageStart += ROWS_PER_SLIDE) {
    const pageRows = opportunities.slice(pageStart, pageStart + ROWS_PER_SLIDE);
    const pageNum = Math.floor(pageStart / ROWS_PER_SLIDE) + 1;
    const totalPages = Math.ceil(opportunities.length / ROWS_PER_SLIDE);

    const slide = pres.addSlide();

    // Slide header bar
    slide.addShape(pres.ShapeType.rect, {
      x: 0, y: 0, w: '100%', h: 0.6,
      fill: { color: IBM_BLUE },
    });

    slide.addText('US Public Sector Sales Forecast', {
      x: 0.3, y: 0.05, w: 10, h: 0.5,
      fontSize: 14,
      bold: true,
      color: WHITE,
      fontFace: 'Calibri',
    });

    // Page indicator (top right)
    if (totalPages > 1) {
      slide.addText(`Page ${pageNum} of ${totalPages}`, {
        x: 10.5, y: 0.1, w: 2.5, h: 0.4,
        fontSize: 10,
        color: WHITE,
        align: 'right',
        fontFace: 'Calibri',
      });
    }

    // Build table data: header row + opportunity rows
    const tableData = [
      // Header row — 10pt bold white on IBM Blue
      HEADERS.map((h) => ({
        text: h,
        options: {
          bold: true,
          color: WHITE,
          fill: { color: IBM_BLUE },
          align: 'left',
          fontSize: 10,
          valign: 'middle',
        },
      })),
      // Data rows — 9pt, alternating row shading
      ...pageRows.map((opp, i) => {
        const rowBg = i % 2 === 0 ? 'F4F4F4' : WHITE;
        const c = (align = 'left') => ({
          fill: { color: rowBg }, color: IBM_DARK, fontSize: 9, align, valign: 'middle',
        });
        // Truncate Next Steps to NEXT_STEPS_CHARS — keeps the cell single-line so
        // pptxgenjs honours our rowH and rows don't overflow the bottom bar
        const nextSteps = opp.next_steps
          ? opp.next_steps.slice(0, NEXT_STEPS_CHARS).trimEnd() + (opp.next_steps.length > NEXT_STEPS_CHARS ? '…' : '')
          : '—';
        return [
          { text: opp.opportunity_name || '—',                     options: c() },
          { text: opp.account_name || '—',                         options: c() },
          { text: opp.stage || '—',                                options: c() },
          { text: opp.forecast_category || '—',                    options: c() },
          { text: opp.close_date || '—',                           options: c() },
          { text: formatCurrency(opp.filtered_opportunity_amount),  options: c('right') },
          { text: formatCurrency(opp.total_opportunity_amount),     options: c('right') },
          { text: opp.opportunity_owner || '—',                    options: c() },
          { text: opp.flm_judgement || '—',                        options: c('center') },
          { text: nextSteps,                                        options: { ...c(), fontSize: 8, valign: 'top' } },
        ];
      }),
    ];

    // rowH: array — header gets its own height, data rows get DATA_ROW_H each
    const rowHeights = [HEADER_ROW_H, ...Array(pageRows.length).fill(DATA_ROW_H)];

    slide.addTable(tableData, {
      x: 0.15,
      y: TABLE_TOP,
      w: COL_WIDTHS.reduce((a, b) => a + b, 0),
      colW: COL_WIDTHS,
      rowH: rowHeights,
      border: { pt: 0.5, color: 'E0E0E0' },
      autoPage: false,   // we handle pagination manually
    });

    // Bottom bar
    slide.addShape(pres.ShapeType.rect, {
      x: 0, y: BOTTOM_BAR_Y, w: '100%', h: SLIDE_H - BOTTOM_BAR_Y,
      fill: { color: IBM_BLUE },
    });

    slide.addText(weekLabel, {
      x: 0.3, y: BOTTOM_BAR_Y + 0.05, w: 12, h: 0.4,
      fontSize: 9,
      color: WHITE,
      fontFace: 'Calibri',
    });
  }

  // ---------------------------------------------------------------------------
  // "What Changed" slide — only rendered when diff data is available
  // ---------------------------------------------------------------------------
  if (diff && diff.hasData) {
    const changeSlide = pres.addSlide();

    // Header bar
    changeSlide.addShape(pres.ShapeType.rect, {
      x: 0, y: 0, w: '100%', h: 0.6,
      fill: { color: IBM_BLUE },
    });
    changeSlide.addText('What Changed This Week', {
      x: 0.3, y: 0.05, w: 10, h: 0.5,
      fontSize: 14, bold: true, color: WHITE, fontFace: 'Calibri',
    });
    changeSlide.addText(`${diff.previousWeek} → ${diff.currentWeek}`, {
      x: 9.5, y: 0.1, w: 3.5, h: 0.4,
      fontSize: 10, color: WHITE, align: 'right', fontFace: 'Calibri',
    });

    // AI delta summary paragraph (if available)
    let contentY = 0.8;
    if (deltaSummary && deltaSummary.paragraph) {
      changeSlide.addText(deltaSummary.paragraph, {
        x: 0.3, y: contentY, w: 12.7, h: 0.8,
        fontSize: 11, color: IBM_DARK, fontFace: 'Calibri', wrap: true, valign: 'top',
      });
      contentY += 0.9;
    }

    // Change category table
    const categories = [
      { label: 'New Deals',         count: diff.new.length,       color: '198038' },
      { label: 'Dropped',           count: diff.dropped.length,   color: 'da1e28' },
      { label: 'Stage Promoted',    count: diff.promoted.length,  color: '0043ce' },
      { label: 'Stage Demoted',     count: diff.demoted.length,   color: 'f59e0b' },
      { label: 'Amount Changes',    count: diff.amount.length,    color: '525252' },
      { label: 'Close Date Slipped',count: diff.slipped.length,   color: 'da1e28' },
      { label: 'Pulled In Earlier', count: diff.pulled_in.length, color: '198038' },
    ].filter(c => c.count > 0);

    if (categories.length === 0) {
      changeSlide.addText('No significant changes detected this week.', {
        x: 0.3, y: contentY, w: 12, h: 0.5,
        fontSize: 12, color: IBM_GRAY, fontFace: 'Calibri', italic: true,
      });
    } else {
      const catTableData = [
        [
          { text: 'Category',   options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, fontSize: 10 } },
          { text: 'Count',      options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, fontSize: 10, align: 'center' } },
          { text: 'Top Examples', options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, fontSize: 10 } },
        ],
        ...categories.map((cat, i) => {
          const bg = i % 2 === 0 ? 'F4F4F4' : WHITE;
          // Pull top 3 examples for this category from diff
          let examples = [];
          if (cat.label === 'New Deals')          examples = diff.new.slice(0,3).map(r => r.opportunity_name);
          if (cat.label === 'Dropped')            examples = diff.dropped.slice(0,3).map(r => r.opportunity_name);
          if (cat.label === 'Stage Promoted')     examples = diff.promoted.slice(0,3).map(r => `${r.opportunity_name} (→${r.curStage})`);
          if (cat.label === 'Stage Demoted')      examples = diff.demoted.slice(0,3).map(r => `${r.opportunity_name} (→${r.curStage})`);
          if (cat.label === 'Amount Changes')     examples = diff.amount.slice(0,3).map(r => r.opportunity_name);
          if (cat.label === 'Close Date Slipped') examples = diff.slipped.slice(0,3).map(r => `${r.opportunity_name} (+${r.daysDiff}d)`);
          if (cat.label === 'Pulled In Earlier')  examples = diff.pulled_in.slice(0,3).map(r => `${r.opportunity_name} (${r.daysDiff}d)`);

          return [
            { text: cat.label,               options: { fill: { color: bg }, color: IBM_DARK, fontSize: 9 } },
            { text: String(cat.count),       options: { fill: { color: bg }, color: `${cat.color}`, fontSize: 11, bold: true, align: 'center' } },
            { text: examples.join('  |  ') || '—', options: { fill: { color: bg }, color: IBM_GRAY, fontSize: 8 } },
          ];
        }),
      ];

      changeSlide.addTable(catTableData, {
        x: 0.3, y: contentY, w: 12.7,
        colW: [2.2, 0.8, 9.7],
        rowH: [0.28, ...Array(categories.length).fill(0.28)],
        border: { pt: 0.5, color: 'E0E0E0' },
      });
      contentY += 0.35 * (categories.length + 1) + 0.2;
    }

    // AI delta bullets (if available)
    if (deltaSummary && deltaSummary.bullets && deltaSummary.bullets.length > 0) {
      const bulletRows = deltaSummary.bullets.map(b => ({
        text: b,
        options: { bullet: { type: 'bullet' }, fontSize: 10, color: IBM_DARK, fontFace: 'Calibri' },
      }));
      changeSlide.addText(bulletRows, {
        x: 0.3, y: Math.min(contentY, 5.8), w: 12.7, h: 1.5,
        fontFace: 'Calibri', wrap: true, valign: 'top',
      });
    }

    // Bottom bar
    changeSlide.addShape(pres.ShapeType.rect, {
      x: 0, y: BOTTOM_BAR_Y, w: '100%', h: SLIDE_H - BOTTOM_BAR_Y,
      fill: { color: IBM_BLUE },
    });
    changeSlide.addText(weekLabel, {
      x: 0.3, y: BOTTOM_BAR_Y + 0.05, w: 12, h: 0.4,
      fontSize: 9, color: WHITE, fontFace: 'Calibri',
    });
  }

  await pres.writeFile({ fileName: outputPath });
  return outputPath;
}

// ---------------------------------------------------------------------------
// generatePtmpSlide — PTMP (Plan to Make Plan) one-pager for GM review
// ---------------------------------------------------------------------------
// Produces a single slide in Frank Attaie's PTMP format:
//   Title | Summary table (Budget / Call / Gap / Upside / Stretch)
//   Left:  Deals In Call > $500K
//   Right: Deals to close Gap  +  Other Upside/Stretch > $500K
//   Bottom left: Action Plan
//
// @param {object} opts
//   ownerName   {string}  — e.g. "Dushyant K Patel"
//   teamLabel   {string}  — e.g. "HCLS 3Q26"
//   budget      {number}  — 3Q budget in dollars (user-entered)
//   callDeals   {Array}   — Best Case deals (selected by rep)
//   pipeDeals   {Array}   — Pipeline deals for gap/stretch list
//   actionPlan  {string}  — free text or watsonx bullets joined by \n
// ---------------------------------------------------------------------------
async function generatePtmpSlide(opts) {
  const {
    ownerName  = 'Patel',
    teamLabel  = '3Q26',
    budget     = 0,
    callDeals  = [],
    pipeDeals  = [],
    actionPlan = '',
    outputPath,
  } = opts;

  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE'; // 13.33" × 7.5"
  pres.author = 'ISC Automated Sales Forecast';
  pres.subject = 'PTMP — Plan to Make Plan';

  // ── Fonts — match Frank Attaie's PTMP template exactly ───────────────────
  // Title uses Aptos Display (Headings); all other text uses Aptos (Body)
  const FONT_HDG  = 'Aptos Display';  // title only
  const FONT      = 'Aptos';          // all body text

  // Row height for deal tables — sized for Aptos (Body) 16pt
  const ROW_H     = 0.32;

  // ── All positions measured from Format Shape panels in Duey's original PPT ─
  // Slide canvas: LAYOUT_WIDE = 13.33" × 7.5"
  const TITLE_X   = 0.39;  TITLE_Y  = 0.34;  // title text box
  const SUM_X     = 3.93;  SUM_Y    = 0.24;  // summary table x,y
  const SUM_W     = 7.96;                     // summary table width
  const LEFT_X    = 0.38;                     // left column x
  const CALL_Y    = 1.11;                     // "Deals In Call" header y
  const LEFT_W    = 5.25;                     // left column width
  const ACT_X     = 0.45;  ACT_Y    = 4.59;  // action plan box
  const ACT_W     = 5.99;  ACT_H    = 2.92;  // action plan dimensions
  const RIGHT_X   = 6.99;                     // right column x
  const RIGHT_W   = 5.89;                     // right column width
  const GAP_HDR_Y = 1.49;                     // "Deals to close Gap" y — FIXED
  const STR_HDR_Y = 3.84;                     // "Other Deals Upside/Stretch" y — FIXED

  // Derived financials
  const sumAmt = arr => arr.reduce((s, r) => s + (r.filtered_opportunity_amount || 0), 0);
  const callTotal = sumAmt(callDeals);
  const gap       = Math.max(0, budget - callTotal);
  const upside    = sumAmt(pipeDeals.filter(r => (r.filtered_opportunity_amount || 0) >= 500000));
  const stretch   = sumAmt(pipeDeals);

  const fmt = n => {
    if (!n && n !== 0) return '—';
    if (Math.abs(n) >= 1e6) return '$' + (Math.round(n / 1e5) / 10).toFixed(1) + 'M';
    return '$' + Math.round(n / 1e3) + 'K';
  };

  // Owner last name for slide title
  const lastName = (ownerName || '').split(' ').filter(Boolean).pop() || ownerName;

  const slide = pres.addSlide();

  // ── Title — Aptos Display 24pt Bold, left of summary table ───────────────
  // Width stops at x=3.93 (summary table left edge) minus margin = 3.44"
  slide.addText(`${lastName} ${teamLabel}\nPTMP`, {
    x: TITLE_X, y: TITLE_Y, w: 3.44, h: 0.88,
    fontSize: 24, bold: true, color: IBM_DARK, fontFace: FONT_HDG,
    wrap: true, valign: 'top',
  });

  // ── Summary table — x=3.93", y=0.24", w=7.96", Aptos 18pt ───────────────
  const HDR_BLUE = '1A4F8A';
  const colW5    = SUM_W / 5; // 1.592" each
  const summaryHeader = [
    { text: '3Q Budget', options: { bold: true, color: WHITE, fill: { color: HDR_BLUE }, align: 'center', fontSize: 18, valign: 'middle', fontFace: FONT } },
    { text: '3Q Call',   options: { bold: true, color: WHITE, fill: { color: HDR_BLUE }, align: 'center', fontSize: 18, valign: 'middle', fontFace: FONT } },
    { text: 'Gap',       options: { bold: true, color: WHITE, fill: { color: HDR_BLUE }, align: 'center', fontSize: 18, valign: 'middle', fontFace: FONT } },
    { text: 'Upside',    options: { bold: true, color: WHITE, fill: { color: HDR_BLUE }, align: 'center', fontSize: 18, valign: 'middle', fontFace: FONT } },
    { text: 'Stretch',   options: { bold: true, color: WHITE, fill: { color: HDR_BLUE }, align: 'center', fontSize: 18, valign: 'middle', fontFace: FONT } },
  ];
  const summaryData = [
    { text: fmt(budget),    options: { align: 'center', fontSize: 18, bold: false, color: IBM_DARK, fill: { color: 'E8ECF4' }, valign: 'middle', fontFace: FONT } },
    { text: fmt(callTotal), options: { align: 'center', fontSize: 18, bold: false, color: IBM_DARK, fill: { color: 'E8ECF4' }, valign: 'middle', fontFace: FONT } },
    { text: fmt(gap),       options: { align: 'center', fontSize: 18, bold: false, color: gap > 0 ? 'da1e28' : '198038', fill: { color: 'E8ECF4' }, valign: 'middle', fontFace: FONT } },
    { text: fmt(upside),    options: { align: 'center', fontSize: 18, bold: false, color: IBM_DARK, fill: { color: 'E8ECF4' }, valign: 'middle', fontFace: FONT } },
    { text: fmt(stretch),   options: { align: 'center', fontSize: 18, bold: false, color: IBM_DARK, fill: { color: 'E8ECF4' }, valign: 'middle', fontFace: FONT } },
  ];
  slide.addTable([summaryHeader, summaryData], {
    x: SUM_X, y: SUM_Y, w: SUM_W,
    colW: [colW5, colW5, colW5, colW5, colW5],
    rowH: [0.35, 0.44],
    border: { pt: 0.5, color: 'AAAAAA' },
  });

  // ── Helper: deal table — bullet | account | opportunity name | amount ─────
  // All deal text: Aptos (Body) 16pt, no alternating row shading (matches Duey's)
  function dealTable(deals, x, y, w, h, emptyMsg) {
    if (deals.length === 0) {
      slide.addText(emptyMsg, { x, y, w, h, fontSize: 16, color: IBM_GRAY, italic: true, fontFace: FONT, valign: 'top' });
      return;
    }
    const acctW = w * 0.28;
    const oppW  = w * 0.52;
    const amtW  = w * 0.20;
    const rows  = deals.map((r, i) => {
      const acct = (r.account_name || '').replace(/-US$/, '').slice(0, 20);
      const opp  = (r.opportunity_name || '').slice(0, 28);
      const amt  = fmt(r.filtered_opportunity_amount);
      const bg   = i % 2 === 0 ? WHITE : 'F7F8FA';
      const base = { fill: { color: bg }, fontSize: 16, fontFace: FONT, valign: 'middle' };
      return [
        { text: '•', options: { ...base, align: 'center', color: IBM_GRAY } },
        { text: acct, options: { ...base, align: 'left', color: IBM_DARK, bold: false } },
        { text: opp,  options: { ...base, align: 'left', color: IBM_DARK, bold: false } },
        { text: amt,  options: { ...base, align: 'right', color: IBM_DARK, bold: false } },
      ];
    });
    slide.addTable(rows, {
      x, y, w,
      colW: [0.15, acctW, oppW, amtW],
      rowH: Array(deals.length).fill(ROW_H),
      border: { pt: 0, color: 'FFFFFF' },
    });
  }

  // ── LEFT: "Deals In Call > $500K" — x=0.38", y=1.11", w=5.25" ───────────
  // Max rows = floor((ACT_Y - CALL_Y - 0.34 - 0.10) / ROW_H) = floor(2.80 / 0.32) = 8
  const MAX_CALL_ROWS = Math.floor((ACT_Y - CALL_Y - 0.34 - 0.10) / ROW_H);
  const callBig = callDeals
    .filter(r => (r.filtered_opportunity_amount || 0) >= 500000)
    .sort((a, b) => (b.filtered_opportunity_amount || 0) - (a.filtered_opportunity_amount || 0))
    .slice(0, MAX_CALL_ROWS);

  slide.addText('Deals In Call > $500K', {
    x: LEFT_X, y: CALL_Y, w: LEFT_W, h: 0.32,
    fontSize: 16, bold: true, color: IBM_DARK, fontFace: FONT,
  });
  dealTable(callBig, LEFT_X, CALL_Y + 0.34, LEFT_W, ACT_Y - CALL_Y - 0.50, 'No deals in Call > $500K');

  // ── LEFT: "Action Plan" — x=0.45", y=4.59", w=5.99", h=2.92" ────────────
  // Header: Aptos (Body) 11pt Bold. Bullets: Aptos (Body) 11pt (not bold)
  slide.addText('Action Plan', {
    x: ACT_X, y: ACT_Y, w: ACT_W, h: 0.28,
    fontSize: 11, bold: true, color: IBM_DARK, fontFace: FONT,
  });
  const planLines = (actionPlan || '').split('\n').filter(Boolean).slice(0, 8);
  const planBullets = planLines.map(line => ({
    text: line,
    options: { bullet: { type: 'bullet' }, fontSize: 11, bold: false, color: IBM_DARK, fontFace: FONT },
  }));
  if (planBullets.length === 0) {
    planBullets.push({ text: 'Action plan not provided.', options: { fontSize: 11, color: IBM_GRAY, italic: true, fontFace: FONT } });
  }
  slide.addText(planBullets, {
    x: ACT_X, y: ACT_Y + 0.30, w: ACT_W, h: ACT_H - 0.30,
    fontFace: FONT, wrap: true, valign: 'top',
  });

  // ── RIGHT: "Deals to close Gap" — x=6.99", y=1.49", w=5.89" FIXED ───────
  const gapLabel = `Deals to close Gap of ${fmt(gap)}`;
  slide.addText(gapLabel, {
    x: RIGHT_X, y: GAP_HDR_Y, w: RIGHT_W, h: 0.32,
    fontSize: 16, bold: true, color: IBM_DARK, fontFace: FONT,
  });

  // Select pipeline deals toward the gap — capped by available vertical space
  // Gap zone: y=1.83 to y=3.84 = 2.01" → max floor(1.67 / 0.32) = 5 rows
  const MAX_GAP_ROWS = Math.floor((STR_HDR_Y - GAP_HDR_Y - 0.34 - 0.10) / ROW_H);
  const gapDeals = [];
  let running = 0;
  const sortedPipe = [...pipeDeals]
    .filter(r => (r.filtered_opportunity_amount || 0) >= 200000)
    .sort((a, b) => (b.filtered_opportunity_amount || 0) - (a.filtered_opportunity_amount || 0));
  for (const r of sortedPipe) {
    if (gapDeals.length >= MAX_GAP_ROWS) break;
    gapDeals.push(r);
    running += r.filtered_opportunity_amount || 0;
    if (gap > 0 && running >= gap * 1.1) break;
  }
  dealTable(gapDeals, RIGHT_X, GAP_HDR_Y + 0.34, RIGHT_W, STR_HDR_Y - GAP_HDR_Y - 0.50,
    budget === 0 ? 'Enter budget to compute gap.' : 'No pipeline deals available.');

  // ── RIGHT: "Other Deals in Upside/Stretch" — x=6.99", y=3.84" FIXED ─────
  // Stretch zone: y=4.18 to BOTTOM_BAR_Y=6.85 = 2.67" → max floor(2.33 / 0.32) = 7 rows
  const MAX_STR_ROWS = Math.floor((BOTTOM_BAR_Y - STR_HDR_Y - 0.34 - 0.10) / ROW_H);
  const gapIds = new Set(gapDeals.map(r => r.id));
  const otherStretch = pipeDeals
    .filter(r => !gapIds.has(r.id) && (r.filtered_opportunity_amount || 0) >= 500000)
    .sort((a, b) => (b.filtered_opportunity_amount || 0) - (a.filtered_opportunity_amount || 0))
    .slice(0, MAX_STR_ROWS);

  slide.addText('Other Deals in Upside / Stretch > $500K', {
    x: RIGHT_X, y: STR_HDR_Y, w: RIGHT_W, h: 0.32,
    fontSize: 16, bold: true, color: IBM_DARK, fontFace: FONT,
  });
  dealTable(otherStretch, RIGHT_X, STR_HDR_Y + 0.34, RIGHT_W, BOTTOM_BAR_Y - STR_HDR_Y - 0.50,
    'No additional stretch deals > $500K.');

  // ── Bottom bar ────────────────────────────────────────────────────────────
  slide.addShape(pres.ShapeType.rect, {
    x: 0, y: BOTTOM_BAR_Y, w: '100%', h: SLIDE_H - BOTTOM_BAR_Y,
    fill: { color: IBM_BLUE },
  });
  const now = new Date();
  slide.addText(`ISC Automated Sales Forecast  ·  Generated ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}  ·  v2.6.2`, {
    x: 0.3, y: BOTTOM_BAR_Y + 0.05, w: 12.7, h: 0.4,
    fontSize: 9, color: WHITE, fontFace: FONT,
  });

  await pres.writeFile({ fileName: outputPath });
  return outputPath;
}

// ---------------------------------------------------------------------------
// generateCustomPpt — column-picker PowerPoint
// ---------------------------------------------------------------------------
// Produces an IBM-branded executive PPT with whatever columns the user chose
// in the Column Picker modal.  Column order and selection are caller-controlled.
//
// @param {object} opts
//   opportunities {Array}   — full opportunity rows from SQLite
//   columns       {string[]} — ordered array of COLUMN_META keys to include
//   includeNarrative    {boolean} — prepend AI GM narrative on cover slide
//   includeWhatChanged  {boolean} — append What Changed slide
//   outputPath    {string}  — absolute path where .pptx is written
//   narrative     {object}  — optional { paragraph, bullets } (pre-generated)
//   diff          {object}  — optional diff from diffEngine.computeDiff()
//   deltaSummary  {object}  — optional { paragraph, bullets }
// ---------------------------------------------------------------------------

const COLUMN_META = {
  account_name:                { label: 'Account',        type: 'text',   maxLen: 22,  defaultW: 1.8  },
  opportunity_name:            { label: 'Opportunity',    type: 'text',   maxLen: 30,  defaultW: 2.4  },
  close_date:                  { label: 'Close Date',     type: 'date',                defaultW: 0.85 },
  forecast_category:           { label: 'Forecast',       type: 'text',   maxLen: 12,  defaultW: 0.9  },
  filtered_opportunity_amount: { label: 'Filtered Amt',   type: 'amount',              defaultW: 0.95 },
  total_opportunity_amount:    { label: 'Total Amt',      type: 'amount',              defaultW: 0.95 },
  score:                       { label: 'Score',          type: 'score',               defaultW: 0.65 },
  stage:                       { label: 'Stage',          type: 'text',   maxLen: 18,  defaultW: 0.9  },
  opportunity_owner:           { label: 'Owner',          type: 'text',   maxLen: 20,  defaultW: 1.3  },
  next_steps:                  { label: 'Next Steps',     type: 'text',   maxLen: 50,  defaultW: 2.2  },
  team_notes:                  { label: 'Team Notes',     type: 'text',   maxLen: 50,  defaultW: 2.2  },
  flm_judgement:               { label: 'FLM Judgement',  type: 'text',   maxLen: 14,  defaultW: 0.9  },
};

// Default columns pre-selected in the Column Picker modal
const CUSTOM_PPT_DEFAULTS = [
  'account_name',
  'opportunity_name',
  'close_date',
  'forecast_category',
  'total_opportunity_amount',
  'score',
];

/**
 * Compute the cell value string for a given column key.
 */
function cellValue(row, key) {
  const meta = COLUMN_META[key];
  if (!meta) return '—';
  const raw = row[key];
  if (meta.type === 'amount') return formatCurrency(raw);
  if (meta.type === 'score')  return (raw !== null && raw !== undefined) ? String(Math.round(raw)) : '—';
  if (meta.type === 'date')   return raw || '—';
  // text — truncate to maxLen
  if (!raw) return '—';
  const s   = String(raw);
  const max = meta.maxLen || 60;
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

/**
 * Compute column widths (inches) so they fill the 13.0" usable slide width.
 * Uses each column's `defaultW` as a proportional weight.
 */
function computeColWidths(columns) {
  const TOTAL_W  = 13.0;
  const rawTotal = columns.reduce((s, k) => s + (COLUMN_META[k]?.defaultW || 1.0), 0);
  return columns.map(k => {
    const raw = COLUMN_META[k]?.defaultW || 1.0;
    return Math.round((raw / rawTotal) * TOTAL_W * 100) / 100;
  });
}

async function generateCustomPpt(opts) {
  const {
    opportunities   = [],
    columns         = CUSTOM_PPT_DEFAULTS,
    outputPath,
    narrative       = null,
    diff            = null,
    deltaSummary    = null,
  } = opts;

  const HEADER_ROW_H_C = 0.32;
  const DATA_ROW_H_C   = 0.40;
  // How many data rows fit between TABLE_TOP and BOTTOM_BAR_Y?
  // TABLE_TOP=0.75, BOTTOM_BAR_Y=6.85 → usable=6.10", header=0.32" → 5.78" / 0.40 = 14
  const ROWS_PER_SLIDE_C = 14;

  const pres = new PptxGenJS();
  pres.layout  = 'LAYOUT_WIDE';
  pres.author  = 'ISC Automated Sales Forecast';
  pres.subject = 'Custom Pipeline Report';

  const now = new Date();
  const weekLabel = `Week of ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  // ── Cover slide ────────────────────────────────────────────────────────────
  const cover = pres.addSlide();
  cover.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 1.5, fill: { color: IBM_BLUE } });
  cover.addText('Custom Pipeline Report', {
    x: 0.5, y: 0.25, w: 12, h: 1,
    fontSize: 32, bold: true, color: WHITE, fontFace: 'Calibri',
  });
  cover.addText(weekLabel, {
    x: 0.5, y: 1.8, w: 12, h: 0.6,
    fontSize: 18, color: IBM_DARK, fontFace: 'Calibri',
  });
  cover.addText(
    `${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'} · ${columns.length} column${columns.length === 1 ? '' : 's'}`,
    { x: 0.5, y: 2.5, w: 12, h: 0.5, fontSize: 14, color: IBM_GRAY, fontFace: 'Calibri' }
  );
  // Column list on cover
  const colLabels = columns.map(k => COLUMN_META[k]?.label || k).join('  ·  ');
  cover.addText(colLabels, {
    x: 0.5, y: 3.1, w: 12.33, h: 0.5,
    fontSize: 10, color: IBM_GRAY, fontFace: 'Calibri', italic: true,
  });

  if (narrative && narrative.paragraph) {
    const NARRATIVE_BLUE = '0F62FE';
    cover.addShape(pres.ShapeType.line, { x: 0.5, y: 3.75, w: 12.33, h: 0, line: { color: 'e0e0e0', width: 0.5 } });
    cover.addText('GM BRIEFING', {
      x: 0.5, y: 3.85, w: 12, h: 0.25,
      fontSize: 9, bold: true, color: NARRATIVE_BLUE, fontFace: 'Calibri', charSpacing: 2,
    });
    cover.addText(narrative.paragraph, {
      x: 0.5, y: 4.15, w: 12.33, h: 1.5,
      fontSize: 11, color: IBM_DARK, fontFace: 'Calibri', wrap: true, valign: 'top',
    });
    if (narrative.bullets && narrative.bullets.length > 0) {
      const bulletRows = narrative.bullets.map(b => ({
        text: b,
        options: { bullet: { type: 'bullet' }, fontSize: 10, color: IBM_DARK, fontFace: 'Calibri' },
      }));
      cover.addText(bulletRows, {
        x: 0.5, y: 5.7, w: 12.33, h: 1.0,
        fontFace: 'Calibri', wrap: true, valign: 'top',
      });
    }
  }

  cover.addShape(pres.ShapeType.rect, { x: 0, y: 6.9, w: '100%', h: 0.6, fill: { color: IBM_BLUE } });

  // ── Data slides ────────────────────────────────────────────────────────────
  const colWidths = computeColWidths(columns);
  const headers   = columns.map(k => COLUMN_META[k]?.label || k);
  const amountCols = new Set(columns.filter(k => COLUMN_META[k]?.type === 'amount'));
  const scoreCols  = new Set(columns.filter(k => COLUMN_META[k]?.type === 'score'));

  for (let pageStart = 0; pageStart < opportunities.length; pageStart += ROWS_PER_SLIDE_C) {
    const pageRows   = opportunities.slice(pageStart, pageStart + ROWS_PER_SLIDE_C);
    const pageNum    = Math.floor(pageStart / ROWS_PER_SLIDE_C) + 1;
    const totalPages = Math.ceil(opportunities.length / ROWS_PER_SLIDE_C);

    const slide = pres.addSlide();

    // Header bar
    slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.6, fill: { color: IBM_BLUE } });
    slide.addText('Custom Pipeline Report', {
      x: 0.3, y: 0.05, w: 10, h: 0.5,
      fontSize: 14, bold: true, color: WHITE, fontFace: 'Calibri',
    });
    if (totalPages > 1) {
      slide.addText(`Page ${pageNum} of ${totalPages}`, {
        x: 10.5, y: 0.1, w: 2.5, h: 0.4,
        fontSize: 10, color: WHITE, align: 'right', fontFace: 'Calibri',
      });
    }

    // Build table
    const tableData = [
      headers.map(h => ({
        text: h,
        options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, align: 'left', fontSize: 10, valign: 'middle' },
      })),
      ...pageRows.map((opp, i) => {
        const rowBg = i % 2 === 0 ? 'F4F4F4' : WHITE;
        return columns.map(key => {
          const isAmt   = COLUMN_META[key]?.type === 'amount';
          const isScore = COLUMN_META[key]?.type === 'score';
          return {
            text: cellValue(opp, key),
            options: {
              fill:   { color: rowBg },
              color:  IBM_DARK,
              fontSize: 9,
              align:  isAmt ? 'right' : isScore ? 'center' : 'left',
              valign: 'middle',
            },
          };
        });
      }),
    ];

    const rowHeights = [HEADER_ROW_H_C, ...Array(pageRows.length).fill(DATA_ROW_H_C)];
    slide.addTable(tableData, {
      x: 0.15, y: TABLE_TOP,
      w: colWidths.reduce((a, b) => a + b, 0),
      colW: colWidths,
      rowH: rowHeights,
      border: { pt: 0.5, color: 'E0E0E0' },
      autoPage: false,
    });

    // Bottom bar
    slide.addShape(pres.ShapeType.rect, { x: 0, y: BOTTOM_BAR_Y, w: '100%', h: SLIDE_H - BOTTOM_BAR_Y, fill: { color: IBM_BLUE } });
    slide.addText(weekLabel, {
      x: 0.3, y: BOTTOM_BAR_Y + 0.05, w: 12, h: 0.4,
      fontSize: 9, color: WHITE, fontFace: 'Calibri',
    });
  }

  // ── What Changed slide (optional) ─────────────────────────────────────────
  if (diff && diff.hasData) {
    const changeSlide = pres.addSlide();
    changeSlide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.6, fill: { color: IBM_BLUE } });
    changeSlide.addText('What Changed This Week', {
      x: 0.3, y: 0.05, w: 10, h: 0.5,
      fontSize: 14, bold: true, color: WHITE, fontFace: 'Calibri',
    });
    changeSlide.addText(`${diff.previousWeek} → ${diff.currentWeek}`, {
      x: 9.5, y: 0.1, w: 3.5, h: 0.4,
      fontSize: 10, color: WHITE, align: 'right', fontFace: 'Calibri',
    });

    let contentY = 0.8;
    if (deltaSummary && deltaSummary.paragraph) {
      changeSlide.addText(deltaSummary.paragraph, {
        x: 0.3, y: contentY, w: 12.7, h: 0.8,
        fontSize: 11, color: IBM_DARK, fontFace: 'Calibri', wrap: true, valign: 'top',
      });
      contentY += 0.9;
    }

    const categories = [
      { label: 'New Deals',          count: diff.new.length,       color: '198038' },
      { label: 'Dropped',            count: diff.dropped.length,   color: 'da1e28' },
      { label: 'Stage Promoted',     count: diff.promoted.length,  color: '0043ce' },
      { label: 'Stage Demoted',      count: diff.demoted.length,   color: 'f59e0b' },
      { label: 'Amount Changes',     count: diff.amount.length,    color: '525252' },
      { label: 'Close Date Slipped', count: diff.slipped.length,   color: 'da1e28' },
      { label: 'Pulled In Earlier',  count: diff.pulled_in.length, color: '198038' },
    ].filter(c => c.count > 0);

    if (categories.length === 0) {
      changeSlide.addText('No significant changes detected this week.', {
        x: 0.3, y: contentY, w: 12, h: 0.5,
        fontSize: 12, color: IBM_GRAY, fontFace: 'Calibri', italic: true,
      });
    } else {
      const catTableData = [
        [
          { text: 'Category',    options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, fontSize: 10 } },
          { text: 'Count',       options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, fontSize: 10, align: 'center' } },
          { text: 'Top Examples', options: { bold: true, color: WHITE, fill: { color: IBM_BLUE }, fontSize: 10 } },
        ],
        ...categories.map((cat, i) => {
          const bg = i % 2 === 0 ? 'F4F4F4' : WHITE;
          let examples = [];
          if (cat.label === 'New Deals')           examples = diff.new.slice(0,3).map(r => r.opportunity_name);
          if (cat.label === 'Dropped')             examples = diff.dropped.slice(0,3).map(r => r.opportunity_name);
          if (cat.label === 'Stage Promoted')      examples = diff.promoted.slice(0,3).map(r => `${r.opportunity_name} (→${r.curStage})`);
          if (cat.label === 'Stage Demoted')       examples = diff.demoted.slice(0,3).map(r => `${r.opportunity_name} (→${r.curStage})`);
          if (cat.label === 'Amount Changes')      examples = diff.amount.slice(0,3).map(r => r.opportunity_name);
          if (cat.label === 'Close Date Slipped')  examples = diff.slipped.slice(0,3).map(r => `${r.opportunity_name} (+${r.daysDiff}d)`);
          if (cat.label === 'Pulled In Earlier')   examples = diff.pulled_in.slice(0,3).map(r => `${r.opportunity_name} (${r.daysDiff}d)`);
          return [
            { text: cat.label,               options: { fill: { color: bg }, color: IBM_DARK, fontSize: 9 } },
            { text: String(cat.count),       options: { fill: { color: bg }, color: `${cat.color}`, fontSize: 11, bold: true, align: 'center' } },
            { text: examples.join('  |  ') || '—', options: { fill: { color: bg }, color: IBM_GRAY, fontSize: 8 } },
          ];
        }),
      ];
      changeSlide.addTable(catTableData, {
        x: 0.3, y: contentY, w: 12.7,
        colW: [2.2, 0.8, 9.7],
        rowH: [0.28, ...Array(categories.length).fill(0.28)],
        border: { pt: 0.5, color: 'E0E0E0' },
      });
    }

    changeSlide.addShape(pres.ShapeType.rect, { x: 0, y: BOTTOM_BAR_Y, w: '100%', h: SLIDE_H - BOTTOM_BAR_Y, fill: { color: IBM_BLUE } });
    changeSlide.addText(weekLabel, {
      x: 0.3, y: BOTTOM_BAR_Y + 0.05, w: 12, h: 0.4,
      fontSize: 9, color: WHITE, fontFace: 'Calibri',
    });
  }

  await pres.writeFile({ fileName: outputPath });
  return outputPath;
}

module.exports = { generatePpt, generatePtmpSlide, generateCustomPpt, COLUMN_META, CUSTOM_PPT_DEFAULTS };
