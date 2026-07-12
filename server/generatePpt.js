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
const USABLE_H       = BOTTOM_BAR_Y - TABLE_TOP; // 6.1"

const HEADER_ROW_H   = 0.30;  // header row height (inches)
const DATA_ROW_H     = 0.32;  // data row height — tight but readable at 9pt

// How many data rows fit per slide
const ROWS_PER_SLIDE = Math.floor((USABLE_H - HEADER_ROW_H) / DATA_ROW_H); // ~18

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
        // Truncate Next Steps to 120 chars for PPT — full text is in the web app
        const nextSteps = opp.next_steps
          ? opp.next_steps.slice(0, 120).trimEnd() + (opp.next_steps.length > 120 ? '…' : '')
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

module.exports = generatePpt;
