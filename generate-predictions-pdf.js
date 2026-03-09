#!/usr/bin/env node
/**
 * Polygentic Predictions PDF Generator
 *
 * Usage:
 *   node generate-predictions-pdf.js                  # today
 *   node generate-predictions-pdf.js 2026-03-09       # specific date
 *   node generate-predictions-pdf.js 2026-03-09 2026-03-11  # date range
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// ─── Config ───
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';

// ─── Parse CLI args ───
const args = process.argv.slice(2);
let dateParam, fromParam, toParam;

if (args.length === 0) {
  dateParam = new Date().toISOString().split('T')[0];
} else if (args.length === 1) {
  dateParam = args[0];
} else if (args.length === 2) {
  fromParam = args[0];
  toParam = args[1];
}

// ─── Fetch predictions from API ───
async function fetchPredictions() {
  let url;
  if (fromParam && toParam) {
    url = `${API_BASE}/api/predictions/upcoming?from=${fromParam}&to=${toParam}&limit=100`;
  } else {
    url = `${API_BASE}/api/predictions/upcoming?date=${dateParam}&limit=100`;
  }

  console.log(`Fetching predictions from: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ─── Transform API data to match objects ───
function transformData(apiData) {
  return apiData.data
    .filter((f) => f.prediction)
    .map((f) => {
      const p = f.prediction;
      const homeProb = parseFloat(p.homeWinProb);
      const drawProb = parseFloat(p.drawProb);
      const awayProb = parseFloat(p.awayWinProb);

      let predictedOutcome, predictedWinner;
      if (drawProb >= homeProb && drawProb >= awayProb) {
        predictedOutcome = 'Draw';
        predictedWinner = 'Draw';
      } else if (homeProb >= awayProb) {
        predictedOutcome = 'Home Win';
        predictedWinner = sanitize(f.homeTeam.name);
      } else {
        predictedOutcome = 'Away Win';
        predictedWinner = sanitize(f.awayTeam.name);
      }

      // Pick the first key factor as summary (strip internal data)
      const keyFactors = (p.keyFactors || []).filter(
        (k) =>
          !k.toLowerCase().includes('base rate') &&
          !k.toLowerCase().includes('model'),
      );
      const keyFactor = sanitize(keyFactors[0] || '');

      const matchDate = new Date(f.date);
      const timeStr =
        matchDate.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC',
        }) + ' UTC';

      // Build result info if match is resolved
      let result = null;
      if (f.goalsHome !== null && f.goalsAway !== null) {
        result = `${f.goalsHome} - ${f.goalsAway}`;
      }

      return {
        fixtureId: f.fixtureId,
        time: timeStr,
        date: matchDate,
        league: sanitize(`${f.league.name} (${f.league.country})`),
        round: sanitize(p.matchContext?.fixture?.round || ''),
        venue: sanitize(p.matchContext?.fixture?.venue || ''),
        home: sanitize(f.homeTeam.name),
        away: sanitize(f.awayTeam.name),
        homeProb,
        drawProb,
        awayProb,
        homeGoals: parseFloat(p.predictedHomeGoals),
        awayGoals: parseFloat(p.predictedAwayGoals),
        confidence: p.confidence,
        predictedOutcome,
        predictedWinner,
        keyFactor,
        result,
        wasCorrect: p.wasCorrect,
        status: f.status,
      };
    })
    .sort((a, b) => a.date - b.date);
}

// ─── Sanitize text for PDF (pdfkit's built-in fonts don't support extended Unicode) ───
function sanitize(str) {
  if (!str) return '';
  // Map common extended Latin characters to ASCII equivalents
  const map = {
    ü: 'u',
    Ü: 'U',
    ö: 'o',
    Ö: 'O',
    ä: 'a',
    Ä: 'A',
    ğ: 'g',
    Ğ: 'G',
    ş: 's',
    Ş: 'S',
    ı: 'i',
    İ: 'I',
    ç: 'c',
    Ç: 'C',
    ñ: 'n',
    Ñ: 'N',
    á: 'a',
    Á: 'A',
    é: 'e',
    É: 'E',
    í: 'i',
    Í: 'I',
    ó: 'o',
    Ó: 'O',
    ú: 'u',
    Ú: 'U',
    à: 'a',
    À: 'A',
    è: 'e',
    È: 'E',
    ì: 'i',
    Ì: 'I',
    ò: 'o',
    Ò: 'O',
    ù: 'u',
    Ù: 'U',
    â: 'a',
    Â: 'A',
    ê: 'e',
    Ê: 'E',
    î: 'i',
    Î: 'I',
    ô: 'o',
    Ô: 'O',
    û: 'u',
    Û: 'U',
    ë: 'e',
    Ë: 'E',
    ï: 'i',
    Ï: 'I',
    ã: 'a',
    Ã: 'A',
    õ: 'o',
    Õ: 'O',
    ý: 'y',
    Ý: 'Y',
    ž: 'z',
    Ž: 'Z',
    č: 'c',
    Č: 'C',
    ř: 'r',
    Ř: 'R',
    ť: 't',
    Ť: 'T',
    ď: 'd',
    Ď: 'D',
    ň: 'n',
    Ň: 'N',
    ů: 'u',
    Ů: 'U',
    ě: 'e',
    Ě: 'E',
    ś: 's',
    Ś: 'S',
    ź: 'z',
    Ź: 'Z',
    ć: 'c',
    Ć: 'C',
    ł: 'l',
    Ł: 'L',
    ą: 'a',
    Ą: 'A',
    ę: 'e',
    Ę: 'E',
    ő: 'o',
    Ő: 'O',
    ű: 'u',
    Ű: 'U',
    ā: 'a',
    ē: 'e',
    ī: 'i',
    ō: 'o',
    ū: 'u',
    ș: 's',
    Ș: 'S',
    ț: 't',
    Ț: 'T',
    '\u2014': '-',
    '\u2013': '-',
    '\u2018': "'",
    '\u2019': "'",
    '\u201C': '"',
    '\u201D': '"',
  };
  return str.replace(/[^\x00-\x7F]/g, (ch) => map[ch] || '');
}

// ─── Colors ───
const C = {
  darkBg: '#0F1923',
  cardBg: '#1A2736',
  cardBgAlt: '#1E3040',
  headerBg: '#0D47A1',
  accent: '#2196F3',
  accentLight: '#64B5F6',
  gold: '#FFD700',
  green: '#4CAF50',
  greenLight: '#81C784',
  red: '#F44336',
  orange: '#FF9800',
  white: '#FFFFFF',
  lightGray: '#B0BEC5',
  midGray: '#78909C',
  divider: '#37474F',
  homeWin: '#4CAF50',
  draw: '#FF9800',
  awayWin: '#2196F3',
};

function outcomeColor(o) {
  if (o === 'Home Win') return C.homeWin;
  if (o === 'Draw') return C.orange;
  return C.awayWin;
}

function confLabel(c) {
  if (c <= 3) return 'Low';
  if (c <= 5) return 'Medium';
  if (c <= 7) return 'High';
  return 'Very High';
}

function confColor(c) {
  if (c <= 3) return C.red;
  if (c <= 5) return C.orange;
  if (c <= 7) return C.green;
  return C.gold;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ─── PDF Drawing Helpers ───
function drawConfDots(doc, x, y, conf) {
  for (let i = 0; i < 10; i++) {
    const cx = x + i * 8 + 2.5;
    const cy = y + 2.5;
    doc.circle(cx, cy, 2.5).fill(i < conf ? confColor(conf) : C.divider);
  }
}

function drawProbBar(doc, x, y, w, h, hp, dp, ap) {
  const hw = w * hp;
  const dw = w * dp;
  const aw = w * ap;
  const r = 4;

  // Draw with rounded ends
  doc.save();
  doc.roundedRect(x, y, w, h, r).clip();
  doc.rect(x, y, hw, h).fill(C.homeWin);
  doc.rect(x + hw, y, dw, h).fill(C.orange);
  doc.rect(x + hw + dw, y, aw, h).fill(C.awayWin);
  doc.restore();

  // Labels
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.white);
  if (hw > 35)
    doc.text(`${Math.round(hp * 100)}%`, x, y + 3, {
      width: hw,
      align: 'center',
    });
  if (dw > 30)
    doc.text(`${Math.round(dp * 100)}%`, x + hw, y + 3, {
      width: dw,
      align: 'center',
    });
  if (aw > 35)
    doc.text(`${Math.round(ap * 100)}%`, x + hw + dw, y + 3, {
      width: aw,
      align: 'center',
    });
}

// ─── Build PDF ───
function generatePDF(matches, targetDate, dateRange) {
  const displayDate = dateRange
    ? `${formatDate(dateRange.from)} — ${formatDate(dateRange.to)}`
    : formatDate(targetDate);
  const shortDate = dateRange
    ? `${dateRange.from}_to_${dateRange.to}`
    : targetDate;

  const outputDir = path.join(__dirname, 'predictions');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `predictions-${shortDate}.pdf`);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    autoFirstPage: false,
  });
  let pageNum = 0;
  const totalPages = 1 + matches.length; // summary + detail pages

  function addNewPage() {
    doc.addPage({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    pageNum++;
    doc.rect(0, 0, 595.28, 841.89).fill(C.darkBg);
    // Footer
    doc.font('Helvetica').fontSize(6.5).fillColor(C.midGray);
    doc.text(
      `Polygentic Predictions  |  ${shortDate}  |  Page ${pageNum} of ${totalPages}`,
      ML,
      841.89 - 28,
      { width: 515.28, align: 'center', lineBreak: false },
    );
    // Reset cursor to top to prevent auto-pagination
    doc.y = 40;
    doc.x = ML;
  }
  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  const PW = 595.28; // A4 width
  const PH = 841.89; // A4 height
  const ML = 40;
  const MR = 40;
  const CW = PW - ML - MR; // ~515

  // Count unique leagues
  const leagues = new Set(matches.map((m) => m.league));
  const homeWins = matches.filter(
    (m) => m.predictedOutcome === 'Home Win',
  ).length;
  const draws = matches.filter((m) => m.predictedOutcome === 'Draw').length;
  const awayWins = matches.filter(
    (m) => m.predictedOutcome === 'Away Win',
  ).length;

  // ═══════════════════════════════════════════
  // PAGE 1 — HEADER + SUMMARY TABLE
  // ═══════════════════════════════════════════
  addNewPage();

  // Top banner
  doc.rect(0, 0, PW, 100).fill(C.headerBg);
  doc.font('Helvetica-Bold').fontSize(26).fillColor(C.white);
  doc.text('POLYGENTIC', 0, 25, { width: PW, align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor(C.accentLight);
  doc.text('AI-POWERED MATCH PREDICTIONS', 0, 55, {
    width: PW,
    align: 'center',
  });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(C.gold);
  doc.text(displayDate, 0, 74, { width: PW, align: 'center' });

  // Summary strip
  let y = 115;
  doc.roundedRect(ML, y, CW, 45, 6).fill(C.cardBg);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.white);
  doc.text('OVERVIEW', ML + 15, y + 8);

  doc.font('Helvetica').fontSize(8.5).fillColor(C.lightGray);
  const summaryText = `${matches.length} Matches   |   ${leagues.size} Leagues   |   ${homeWins} Home Win${homeWins !== 1 ? 's' : ''}   |   ${draws} Draw${draws !== 1 ? 's' : ''}   |   ${awayWins} Away Win${awayWins !== 1 ? 's' : ''}`;
  doc.text(summaryText, ML + 15, y + 26, { width: CW - 30 });

  // ─── Table ───
  y = 178;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(C.gold);
  doc.text('PREDICTED WINNERS', ML, y);
  y += 22;

  // Column positions
  const col = {
    time: { x: ML + 8, w: 52 },
    match: { x: ML + 62, w: 195 },
    league: { x: ML + 260, w: 115 },
    pred: { x: ML + 378, w: 130 },
  };

  // Table header row
  doc.roundedRect(ML, y, CW, 20, 4).fill(C.headerBg);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.white);
  doc.text('TIME', col.time.x, y + 6, { width: col.time.w });
  doc.text('MATCH', col.match.x, y + 6, { width: col.match.w });
  doc.text('LEAGUE', col.league.x, y + 6, { width: col.league.w });
  doc.text('PREDICTION', col.pred.x, y + 6, { width: col.pred.w });
  y += 22;

  matches.forEach((m, i) => {
    const ROW_H = 26;

    // Check if we need a new page
    if (y + ROW_H > PH - 50) {
      // Adjust totalPages since we have an extra table page
      addNewPage();
      y = 40;
      // Re-draw header
      doc.roundedRect(ML, y, CW, 20, 4).fill(C.headerBg);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.white);
      doc.text('TIME', col.time.x, y + 6, { width: col.time.w });
      doc.text('MATCH', col.match.x, y + 6, { width: col.match.w });
      doc.text('LEAGUE', col.league.x, y + 6, { width: col.league.w });
      doc.text('PREDICTION', col.pred.x, y + 6, { width: col.pred.w });
      y += 22;
    }

    const bg = i % 2 === 0 ? C.cardBg : C.cardBgAlt;
    doc.rect(ML, y, CW, ROW_H).fill(bg);

    // Time
    doc.font('Helvetica').fontSize(7.5).fillColor(C.midGray);
    doc.text(m.time, col.time.x, y + 8, { width: col.time.w });

    // Match
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.white);
    doc.text(`${m.home} vs ${m.away}`, col.match.x, y + 8, {
      width: col.match.w,
    });

    // League
    doc.font('Helvetica').fontSize(6.5).fillColor(C.lightGray);
    doc.text(m.league, col.league.x, y + 8, { width: col.league.w });

    // Prediction badge
    const oc = outcomeColor(m.predictedOutcome);
    const badgeLabel =
      m.predictedOutcome === 'Draw' ? 'DRAW' : m.predictedWinner.toUpperCase();
    doc.font('Helvetica-Bold').fontSize(6.5);
    const badgeTextW = doc.widthOfString(badgeLabel) + 14;
    const badgeW = Math.max(Math.min(badgeTextW, col.pred.w - 5), 40);
    const badgeX = col.pred.x;
    const badgeY = y + 5;
    doc.roundedRect(badgeX, badgeY, badgeW, 15, 3).fill(oc);
    doc
      .fillColor(C.white)
      .text(badgeLabel, badgeX + 7, badgeY + 3.5, { width: badgeW - 14 });

    y += ROW_H;
  });

  // ═══════════════════════════════════════════
  // DETAIL PAGES — one per match
  // ═══════════════════════════════════════════
  matches.forEach((m, idx) => {
    addNewPage();

    let cy = 35;

    // Top bar: match number + league + time
    doc.roundedRect(ML, cy, CW, 22, 4).fill(C.headerBg);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.white);
    doc.text(`MATCH ${idx + 1} / ${matches.length}`, ML + 10, cy + 6);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.accentLight);
    doc.text(m.league.toUpperCase(), ML + 100, cy + 6, { width: 200 });
    doc.fillColor(C.white);
    doc.text(`${m.round}  |  ${m.time}`, ML + 300, cy + 6, {
      width: CW - 310,
      align: 'right',
    });
    cy += 32;

    // ─── Teams card ───
    doc.roundedRect(ML, cy, CW, 90, 8).fill(C.cardBg);

    const halfW = (CW - 60) / 2;
    const leftX = ML + 20;
    const rightX = ML + CW - 20 - halfW;
    const vsX = ML + CW / 2;

    // Home team
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.white);
    doc.text(m.home, leftX, cy + 20, { width: halfW });

    // VS
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.midGray);
    doc.text('VS', vsX - 12, cy + 22, { width: 24, align: 'center' });

    // Away team
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.white);
    doc.text(m.away, rightX, cy + 20, { width: halfW, align: 'right' });

    // Venue
    if (m.venue) {
      doc.font('Helvetica').fontSize(7).fillColor(C.midGray);
      doc.text(m.venue, leftX, cy + 55, { width: CW - 40 });
    }

    // Predicted score
    doc.font('Helvetica').fontSize(8).fillColor(C.lightGray);
    doc.text('Expected Goals:', leftX, cy + 70);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.gold);
    doc.text(`${m.homeGoals}  -  ${m.awayGoals}`, leftX + 90, cy + 67);

    cy += 100;

    // ─── PREDICTION BANNER ───
    const oc = outcomeColor(m.predictedOutcome);
    doc.roundedRect(ML, cy, CW, 50, 6).fill(oc);

    const winLabel =
      m.predictedOutcome === 'Draw' ? 'DRAW' : m.predictedWinner.toUpperCase();

    doc.font('Helvetica').fontSize(9).fillColor(C.white);
    doc.text('PREDICTED WINNER', ML + 15, cy + 8);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(C.white);
    doc.text(winLabel, ML + 15, cy + 24);

    // Confidence on right side
    doc.font('Helvetica').fontSize(8).fillColor(C.white);
    doc.text(`Confidence: ${m.confidence}/10`, ML + CW - 140, cy + 8, {
      width: 125,
      align: 'right',
    });
    drawConfDots(doc, ML + CW - 85, cy + 26, m.confidence);
    doc.font('Helvetica').fontSize(7).fillColor(C.white);
    doc.text(confLabel(m.confidence), ML + CW - 140, cy + 37, {
      width: 125,
      align: 'right',
    });

    cy += 60;

    // ─── PROBABILITY BAR ───
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white);
    doc.text('WIN PROBABILITY', ML, cy);
    cy += 16;

    // Legend
    doc.font('Helvetica').fontSize(7);
    doc
      .fillColor(C.homeWin)
      .text(`Home ${Math.round(m.homeProb * 100)}%`, ML, cy);
    doc
      .fillColor(C.orange)
      .text(`Draw ${Math.round(m.drawProb * 100)}%`, ML + 130, cy);
    doc
      .fillColor(C.awayWin)
      .text(`Away ${Math.round(m.awayProb * 100)}%`, ML + 260, cy);
    cy += 14;

    drawProbBar(doc, ML, cy, CW, 16, m.homeProb, m.drawProb, m.awayProb);
    cy += 30;

    // ─── KEY INSIGHT ───
    if (m.keyFactor) {
      doc.roundedRect(ML, cy, CW, 55, 6).fill(C.cardBg);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.gold);
      doc.text('KEY INSIGHT', ML + 15, cy + 10);
      doc.font('Helvetica').fontSize(8).fillColor(C.lightGray);
      doc.text(m.keyFactor, ML + 15, cy + 26, { width: CW - 30, lineGap: 2 });
      cy += 63;
    }

    // ─── RESULT (if resolved) ───
    if (m.result) {
      const resBg =
        m.wasCorrect === true
          ? '#1B3A2A'
          : m.wasCorrect === false
            ? '#3A1B1B'
            : C.cardBg;
      const resColor =
        m.wasCorrect === true
          ? C.greenLight
          : m.wasCorrect === false
            ? C.red
            : C.lightGray;
      const resLabel =
        m.wasCorrect === true
          ? 'CORRECT'
          : m.wasCorrect === false
            ? 'INCORRECT'
            : 'PENDING';

      doc.roundedRect(ML, cy, CW, 40, 6).fill(resBg);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(resColor);
      doc.text(`RESULT: ${m.result}   —   ${resLabel}`, ML + 15, cy + 14, {
        width: CW - 30,
      });
      cy += 48;
    }
  });

  return new Promise((resolve, reject) => {
    writeStream.on('finish', () => resolve(outputPath));
    writeStream.on('error', reject);
    doc.end();
  });
}

// ─── Main ───
async function main() {
  const target = dateParam || fromParam;
  console.log(`\nPolygentic Predictions PDF Generator`);
  console.log(`${'─'.repeat(40)}`);

  if (fromParam && toParam) {
    console.log(`Date range: ${fromParam} to ${toParam}`);
  } else {
    console.log(`Date: ${dateParam}`);
  }

  try {
    const apiData = await fetchPredictions();
    const matches = transformData(apiData);

    if (matches.length === 0) {
      console.log(
        '\nNo predictions found for this date. Make sure predictions have been generated.',
      );
      process.exit(1);
    }

    console.log(`Found ${matches.length} matches with predictions.`);

    const dateRange =
      fromParam && toParam ? { from: fromParam, to: toParam } : null;
    const outPath = await generatePDF(matches, dateParam, dateRange);

    console.log(`\nPDF saved to: ${outPath}`);
    console.log('Done.\n');

    // Try to open on macOS
    try {
      require('child_process').execSync(`open "${outPath}"`);
    } catch (_) {}
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (
      err.message.includes('fetch failed') ||
      err.message.includes('ECONNREFUSED')
    ) {
      console.error('Make sure the API server is running (pnpm start:dev).');
    }
    process.exit(1);
  }
}

main();
