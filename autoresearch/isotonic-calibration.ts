/**
 * Isotonic regression calibration test.
 *
 * Splits the 850 resolved predictions walk-forward: the earlier half is the
 * CAL set (used to fit a monotone calibration map for each outcome), the
 * later half is the TEST set (used to score Brier before vs after applying
 * the calibration).
 *
 * Per-outcome isotonic regression: for each bin of predicted probability,
 * we observe an empirical realized rate. The calibration map is the
 * pool-adjacent-violators (PAV) algorithm, which produces the monotone
 * non-decreasing function that best fits the (predicted, actual) pairs in
 * a least-squares sense.
 *
 * After calibrating each outcome independently we renormalise so the three
 * probabilities sum to 1.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { and, eq, isNotNull, desc } from 'drizzle-orm';

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const client = (postgres as any)(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
});
const db = drizzle(client, { schema });

function brier(h: number, d: number, a: number, actual: string): number {
  const yh = actual === 'home_win' ? 1 : 0;
  const yd = actual === 'draw' ? 1 : 0;
  const ya = actual === 'away_win' ? 1 : 0;
  return (h - yh) ** 2 + (d - yd) ** 2 + (a - ya) ** 2;
}

/**
 * Pool-adjacent-violators algorithm for isotonic regression.
 * Input: array of (x, y, w) pairs sorted by x (ascending).
 * Output: a monotone non-decreasing fit ŷ for each x.
 */
function pav(xs: number[], ys: number[], ws: number[]): number[] {
  const n = xs.length;
  // Each "block" holds {sum_wy, sum_w, end_idx}
  const blocks: Array<{ sumWY: number; sumW: number; endIdx: number }> = [];
  for (let i = 0; i < n; i++) {
    let b = { sumWY: ys[i] * ws[i], sumW: ws[i], endIdx: i };
    // Merge while the previous block's mean > current's mean (violation).
    while (blocks.length > 0) {
      const prev = blocks[blocks.length - 1];
      const prevMean = prev.sumWY / prev.sumW;
      const curMean = b.sumWY / b.sumW;
      if (prevMean <= curMean) break;
      blocks.pop();
      b = {
        sumWY: prev.sumWY + b.sumWY,
        sumW: prev.sumW + b.sumW,
        endIdx: b.endIdx,
      };
    }
    blocks.push(b);
  }
  const out = new Array(n);
  let startIdx = 0;
  for (const b of blocks) {
    const mean = b.sumWY / b.sumW;
    for (let i = startIdx; i <= b.endIdx; i++) out[i] = mean;
    startIdx = b.endIdx + 1;
  }
  return out;
}

/**
 * Build an isotonic calibration map from calibration data, returning a
 * function that maps a raw probability → calibrated probability by
 * piecewise-linear interpolation between the knots produced by PAV.
 */
function buildCalibrator(
  predicted: number[],
  actual: number[],
): (p: number) => number {
  // Sort by predicted
  const idx = predicted.map((_, i) => i).sort((a, b) => predicted[a] - predicted[b]);
  const xs = idx.map((i) => predicted[i]);
  const ys = idx.map((i) => actual[i]);
  const ws = idx.map(() => 1);
  const fit = pav(xs, ys, ws);

  // Deduplicate consecutive identical xs (keep first occurrence's fit value).
  const knotX: number[] = [];
  const knotY: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (knotX.length === 0 || xs[i] > knotX[knotX.length - 1]) {
      knotX.push(xs[i]);
      knotY.push(fit[i]);
    } else {
      // Same x — update to latest fit (they should all equal anyway within PAV block)
      knotY[knotY.length - 1] = fit[i];
    }
  }

  return (p: number) => {
    if (knotX.length === 0) return p;
    if (p <= knotX[0]) return knotY[0];
    if (p >= knotX[knotX.length - 1]) return knotY[knotY.length - 1];
    // Binary search
    let lo = 0;
    let hi = knotX.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (knotX[mid] <= p) lo = mid;
      else hi = mid;
    }
    const t = (p - knotX[lo]) / (knotX[hi] - knotX[lo]);
    return knotY[lo] + t * (knotY[hi] - knotY[lo]);
  };
}

async function main() {
  const rows = await db
    .select({
      id: schema.predictions.id,
      homeProb: schema.predictions.homeWinProb,
      drawProb: schema.predictions.drawProb,
      awayProb: schema.predictions.awayWinProb,
      actualResult: schema.predictions.actualResult,
      resolvedAt: schema.predictions.resolvedAt,
    })
    .from(schema.predictions)
    .where(
      and(
        eq(schema.predictions.predictionStatus, 'resolved'),
        isNotNull(schema.predictions.actualResult),
        isNotNull(schema.predictions.resolvedAt),
      ),
    );

  const items = rows
    .filter((r) =>
      ['home_win', 'draw', 'away_win'].includes(r.actualResult as string),
    )
    .map((r) => ({
      id: r.id,
      h: Number(r.homeProb),
      d: Number(r.drawProb),
      a: Number(r.awayProb),
      actual: r.actualResult as 'home_win' | 'draw' | 'away_win',
      resolvedAt: new Date(r.resolvedAt as Date).getTime(),
    }))
    .filter((r) => isFinite(r.h) && isFinite(r.d) && isFinite(r.a))
    .sort((a, b) => a.resolvedAt - b.resolvedAt);

  console.log(`Loaded ${items.length} resolved predictions (chronological)`);

  // Walk-forward split: 50/50 by chronological order.
  const splitIdx = Math.floor(items.length / 2);
  const calSet = items.slice(0, splitIdx);
  const testSet = items.slice(splitIdx);
  console.log(`  CAL  set: ${calSet.length}`);
  console.log(`  TEST set: ${testSet.length}`);
  console.log('');

  // Fit per-outcome isotonic regressions on CAL set.
  const hP = calSet.map((x) => x.h);
  const hA = calSet.map((x) => (x.actual === 'home_win' ? 1 : 0));
  const dP = calSet.map((x) => x.d);
  const dA = calSet.map((x) => (x.actual === 'draw' ? 1 : 0));
  const aP = calSet.map((x) => x.a);
  const aA = calSet.map((x) => (x.actual === 'away_win' ? 1 : 0));

  const calH = buildCalibrator(hP, hA);
  const calD = buildCalibrator(dP, dA);
  const calA = buildCalibrator(aP, aA);

  // Evaluate on TEST set.
  let rawBrier = 0;
  let calBrier = 0;
  let rawCorrect = 0;
  let calCorrect = 0;

  // Also track per-bucket calibration: how wrong were raw probs vs calibrated?
  const bucketBoundaries = [
    0.0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 1.0,
  ];
  const bucketStatsRawH = bucketBoundaries.slice(1).map(() => ({ n: 0, sumPred: 0, sumActual: 0 }));
  const bucketStatsCalH = bucketBoundaries.slice(1).map(() => ({ n: 0, sumPred: 0, sumActual: 0 }));
  function bucketIdx(p: number): number {
    for (let i = 1; i < bucketBoundaries.length; i++) {
      if (p < bucketBoundaries[i]) return i - 1;
    }
    return bucketBoundaries.length - 2;
  }

  for (const r of testSet) {
    rawBrier += brier(r.h, r.d, r.a, r.actual);

    // Apply calibration + renormalise
    let ch = calH(r.h);
    let cd = calD(r.d);
    let ca = calA(r.a);
    const sum = ch + cd + ca;
    if (sum > 0) {
      ch /= sum;
      cd /= sum;
      ca /= sum;
    }
    calBrier += brier(ch, cd, ca, r.actual);

    const rawPred =
      r.h >= r.d && r.h >= r.a ? 'home_win' : r.a >= r.d ? 'away_win' : 'draw';
    const calPred =
      ch >= cd && ch >= ca ? 'home_win' : ca >= cd ? 'away_win' : 'draw';
    if (rawPred === r.actual) rawCorrect++;
    if (calPred === r.actual) calCorrect++;

    // Home-bucket tracking
    const iRaw = bucketIdx(r.h);
    bucketStatsRawH[iRaw].n++;
    bucketStatsRawH[iRaw].sumPred += r.h;
    bucketStatsRawH[iRaw].sumActual += r.actual === 'home_win' ? 1 : 0;
    const iCal = bucketIdx(ch);
    bucketStatsCalH[iCal].n++;
    bucketStatsCalH[iCal].sumPred += ch;
    bucketStatsCalH[iCal].sumActual += r.actual === 'home_win' ? 1 : 0;
  }

  console.log(`Raw (uncalibrated) Brier:        ${(rawBrier / testSet.length).toFixed(6)}`);
  console.log(
    `Isotonic-calibrated Brier:       ${(calBrier / testSet.length).toFixed(6)}`,
  );
  console.log(
    `Δ Brier:                         ${((calBrier - rawBrier) / testSet.length).toFixed(6)}  ${calBrier < rawBrier ? '(calibration helps)' : '(calibration hurts)'}`,
  );
  console.log('');
  console.log(`Raw accuracy:                    ${((rawCorrect / testSet.length) * 100).toFixed(2)}%`);
  console.log(
    `Isotonic-calibrated accuracy:    ${((calCorrect / testSet.length) * 100).toFixed(2)}%`,
  );

  console.log('');
  console.log('Home-win calibration curve (TEST set):');
  console.log(
    `  ${'bucket'.padEnd(16)} ${'n'.padStart(4)}  ${'avg_raw'.padStart(8)}  ${'actual'.padStart(7)}  ${'gap'.padStart(6)}  |  ${'avg_cal'.padStart(8)}  ${'actual'.padStart(7)}  ${'gap'.padStart(6)}`,
  );
  for (let i = 0; i < bucketStatsRawH.length; i++) {
    const r = bucketStatsRawH[i];
    const c = bucketStatsCalH[i];
    if (r.n < 3 && c.n < 3) continue;
    const label = `${(bucketBoundaries[i] * 100).toFixed(0)}–${(bucketBoundaries[i + 1] * 100).toFixed(0)}%`;
    console.log(
      `  ${label.padEnd(16)} ${String(r.n).padStart(4)}  ${(r.n > 0 ? (r.sumPred / r.n * 100).toFixed(1) : '–').padStart(7)}%  ${(r.n > 0 ? (r.sumActual / r.n * 100).toFixed(1) : '–').padStart(6)}%  ${r.n > 0 ? ((r.sumActual / r.n - r.sumPred / r.n) * 100).toFixed(1).padStart(5) + '%' : '   —'}  |  ${(c.n > 0 ? (c.sumPred / c.n * 100).toFixed(1) : '–').padStart(7)}%  ${(c.n > 0 ? (c.sumActual / c.n * 100).toFixed(1) : '–').padStart(6)}%  ${c.n > 0 ? ((c.sumActual / c.n - c.sumPred / c.n) * 100).toFixed(1).padStart(5) + '%' : '   —'}`,
    );
  }

  await client.end();
}

main();
