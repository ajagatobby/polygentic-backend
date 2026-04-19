/**
 * Per-league base-rate and calibration analysis.
 *
 * For each league that has resolved predictions, computes:
 *   - empirical home/draw/away rate  (what actually happens)
 *   - mean predicted home/draw/away prob (what the ensemble said on average)
 *   - Brier score on that league's predictions
 *   - accuracy
 *
 * Flags leagues where the ensemble's mean prediction is >5pp off the
 * empirical rate on any outcome — those are the leagues paying the most
 * for hardcoded global 44/27/29 priors.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { and, eq, isNotNull } from 'drizzle-orm';

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

interface LeagueStats {
  leagueId: number;
  leagueName: string | null;
  n: number;
  actualH: number;
  actualD: number;
  actualA: number;
  predMeanH: number;
  predMeanD: number;
  predMeanA: number;
  brierSum: number;
  correct: number;
  baselineBrierSum: number; // always global 44/27/29
  perLeagueBrierSum: number; // always that league's own empirical rates
}

async function main() {
  const rows = await db
    .select({
      homeProb: schema.predictions.homeWinProb,
      drawProb: schema.predictions.drawProb,
      awayProb: schema.predictions.awayWinProb,
      actualResult: schema.predictions.actualResult,
      probAccuracy: schema.predictions.probabilityAccuracy,
      leagueId: schema.fixtures.leagueId,
      leagueName: schema.fixtures.leagueName,
    })
    .from(schema.predictions)
    .innerJoin(
      schema.fixtures,
      eq(schema.predictions.fixtureId, schema.fixtures.id),
    )
    .where(
      and(
        eq(schema.predictions.predictionStatus, 'resolved'),
        isNotNull(schema.predictions.actualResult),
      ),
    );

  const byLeague = new Map<number, LeagueStats>();
  let globalH = 0,
    globalD = 0,
    globalA = 0,
    globalN = 0;

  for (const r of rows) {
    const h = Number(r.homeProb);
    const d = Number(r.drawProb);
    const a = Number(r.awayProb);
    if (!r.actualResult) continue;
    if (!['home_win', 'draw', 'away_win'].includes(r.actualResult)) continue;
    globalN++;
    if (r.actualResult === 'home_win') globalH++;
    else if (r.actualResult === 'draw') globalD++;
    else globalA++;

    let ls = byLeague.get(r.leagueId);
    if (!ls) {
      ls = {
        leagueId: r.leagueId,
        leagueName: r.leagueName,
        n: 0,
        actualH: 0,
        actualD: 0,
        actualA: 0,
        predMeanH: 0,
        predMeanD: 0,
        predMeanA: 0,
        brierSum: 0,
        correct: 0,
        baselineBrierSum: 0,
        perLeagueBrierSum: 0,
      };
      byLeague.set(r.leagueId, ls);
    }
    ls.n++;
    if (r.actualResult === 'home_win') ls.actualH++;
    else if (r.actualResult === 'draw') ls.actualD++;
    else ls.actualA++;
    ls.predMeanH += h;
    ls.predMeanD += d;
    ls.predMeanA += a;
    ls.brierSum += brier(h, d, a, r.actualResult);
    ls.baselineBrierSum += brier(0.45, 0.26, 0.29, r.actualResult);
    const predicted =
      h >= d && h >= a ? 'home_win' : a >= d ? 'away_win' : 'draw';
    if (predicted === r.actualResult) ls.correct++;
  }

  // Second pass: compute per-league-prior Brier (using the league's own empirical
  // rates as the "prediction"). This is the theoretical lower bound of a
  // constant-per-league model.
  for (const ls of byLeague.values()) {
    const ph = ls.actualH / ls.n;
    const pd = ls.actualD / ls.n;
    const pa = ls.actualA / ls.n;
    // Re-scan rows for this league
    // (small n, just recompute)
    // Faster: ∑ brier with constant probs = n * ph*(1-ph)*... formula
    // Brier(constant p, actuals) = ∑_match (p_h - y_h)^2 + (p_d - y_d)^2 + (p_a - y_a)^2
    // = n*p_h^2 - 2 p_h H + H + n*p_d^2 - 2 p_d D + D + n*p_a^2 - 2 p_a A + A
    //   where H,D,A are actual counts
    // With p = empirical: n*p_h^2 - 2 p_h (n p_h) + n p_h + ...
    // = -n p_h^2 + n p_h + ... = n (p_h (1 - p_h) + p_d (1 - p_d) + p_a (1 - p_a))
    ls.perLeagueBrierSum =
      ls.n * (ph * (1 - ph) + pd * (1 - pd) + pa * (1 - pa));
  }

  // Print
  const sorted = Array.from(byLeague.values()).sort((a, b) => b.n - a.n);
  console.log(`Global: n=${globalN}  actual H/D/A = ${(globalH / globalN * 100).toFixed(1)}% / ${(globalD / globalN * 100).toFixed(1)}% / ${(globalA / globalN * 100).toFixed(1)}%`);
  console.log('');
  console.log('Per-league (n ≥ 10):');
  console.log('');
  console.log(
    `  ${'league'.padEnd(28)} ${'n'.padStart(4)}  ${'actualH'.padStart(7)} ${'actualD'.padStart(7)} ${'actualA'.padStart(7)}   ${'predH'.padStart(6)} ${'predD'.padStart(6)} ${'predA'.padStart(6)}    ${'pred_brier'.padStart(10)}  ${'baseline'.padStart(8)}  ${'league_prior'.padStart(12)}`,
  );
  for (const ls of sorted) {
    if (ls.n < 10) continue;
    const name = (ls.leagueName ?? `league-${ls.leagueId}`).slice(0, 27);
    const pH = ls.actualH / ls.n;
    const pD = ls.actualD / ls.n;
    const pA = ls.actualA / ls.n;
    const mH = ls.predMeanH / ls.n;
    const mD = ls.predMeanD / ls.n;
    const mA = ls.predMeanA / ls.n;
    const b = ls.brierSum / ls.n;
    const bB = ls.baselineBrierSum / ls.n;
    const bL = ls.perLeagueBrierSum / ls.n;
    const flag =
      Math.abs(mH - pH) > 0.05 ||
      Math.abs(mD - pD) > 0.05 ||
      Math.abs(mA - pA) > 0.05;
    console.log(
      `  ${name.padEnd(28)} ${String(ls.n).padStart(4)}  ${(pH * 100).toFixed(1).padStart(6)}% ${(pD * 100).toFixed(1).padStart(6)}% ${(pA * 100).toFixed(1).padStart(6)}%   ${(mH * 100).toFixed(1).padStart(5)}% ${(mD * 100).toFixed(1).padStart(5)}% ${(mA * 100).toFixed(1).padStart(5)}%   ${b.toFixed(4).padStart(10)}  ${bB.toFixed(4).padStart(8)}  ${bL.toFixed(4).padStart(12)}${flag ? '  ◀ miscalibrated' : ''}`,
    );
  }

  // Aggregates
  let totalN = 0;
  let totalB = 0;
  let totalBaseB = 0;
  let totalLeagueB = 0;
  for (const ls of byLeague.values()) {
    totalN += ls.n;
    totalB += ls.brierSum;
    totalBaseB += ls.baselineBrierSum;
    totalLeagueB += ls.perLeagueBrierSum;
  }
  console.log('');
  console.log('Aggregate Brier:');
  console.log(`  ensemble stored:     ${(totalB / totalN).toFixed(6)}  (our current system)`);
  console.log(`  global baseline:     ${(totalBaseB / totalN).toFixed(6)}  (always 45/26/29)`);
  console.log(
    `  per-league prior:    ${(totalLeagueB / totalN).toFixed(6)}  (always each league's own empirical rates — constant model)`,
  );
  console.log('');
  console.log(
    'The per-league-prior Brier is the absolute floor for any "constant per league" model.',
  );
  console.log(
    'If ensemble stored ≥ per-league prior, the ensemble is adding no information beyond league identity.',
  );

  await client.end();
}

main();
