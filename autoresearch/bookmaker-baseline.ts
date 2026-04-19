/**
 * Bookmaker-only Brier baseline.
 *
 * For every resolved prediction where consensus 1X2 odds exist for the same
 * fixture, compute the bookmaker-implied probabilities (devigged), score
 * Brier, and compare against the stored ensemble Brier.
 *
 * Answers: is the raw bookmaker consensus already better than what our
 * ensemble spits out? If yes, the ensemble is subtracting value.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { and, eq, isNotNull, desc, sql } from 'drizzle-orm';

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
 * The consensus_odds table stores values that already sum to ≈1 (probabilities,
 * not decimal odds). We just normalise in case of rounding drift.
 */
function normalise(h: number, d: number, a: number): { h: number; d: number; a: number } {
  const sum = h + d + a;
  if (!(sum > 0)) return { h: 1 / 3, d: 1 / 3, a: 1 / 3 };
  return { h: h / sum, d: d / sum, a: a / sum };
}

async function main() {
  // Join predictions with the fixture (to get oddsApiEventId) and consensus
  // odds on the H2H market. Take the most recent consensus odds row per
  // fixture (closest to closing line available).
  const rows = await db.execute(sql`
    SELECT
      p.id AS prediction_id,
      p.home_win_prob AS stored_h,
      p.draw_prob AS stored_d,
      p.away_win_prob AS stored_a,
      p.actual_result,
      p.probability_accuracy AS stored_brier,
      c.consensus_home_win,
      c.consensus_draw,
      c.consensus_away_win,
      c.pinnacle_home_win,
      c.pinnacle_draw,
      c.pinnacle_away_win,
      c.calculated_at,
      f.league_id,
      f.league_name
    FROM predictions p
    JOIN fixtures f ON p.fixture_id = f.id
    JOIN LATERAL (
      SELECT *
      FROM consensus_odds
      WHERE odds_api_event_id = f.odds_api_event_id
        AND market_key IN ('h2h', 'H2H', '1x2')
      ORDER BY calculated_at DESC
      LIMIT 1
    ) c ON true
    WHERE p.prediction_status = 'resolved'
      AND p.actual_result IS NOT NULL
      AND f.odds_api_event_id IS NOT NULL
  `);

  const items = (rows as any[]).filter((r) =>
    ['home_win', 'draw', 'away_win'].includes(r.actual_result),
  );

  console.log(`Resolved predictions with matching consensus odds: ${items.length}`);
  if (items.length === 0) {
    console.log(
      '\nNo overlap between resolved predictions and consensus_odds table.',
    );
    console.log('This means the bookmaker baseline comparison cannot run.');
    console.log(
      'Either odds were not captured for these fixtures, or the odds_api_event_id link is missing.',
    );
    await client.end();
    return;
  }

  let consensusBrier = 0;
  let pinnacleBrier = 0;
  let storedBrier = 0;
  let consensusN = 0;
  let pinnacleN = 0;
  let consensusCorrect = 0;
  let pinnacleCorrect = 0;
  let storedCorrect = 0;

  const perLeague = new Map<
    number,
    { name: string | null; n: number; consB: number; storedB: number }
  >();

  for (const r of items) {
    const storedH = Number(r.stored_h);
    const storedD = Number(r.stored_d);
    const storedA = Number(r.stored_a);
    const actual = r.actual_result as 'home_win' | 'draw' | 'away_win';

    storedBrier += brier(storedH, storedD, storedA, actual);
    const storedPred =
      storedH >= storedD && storedH >= storedA
        ? 'home_win'
        : storedA >= storedD
          ? 'away_win'
          : 'draw';
    if (storedPred === actual) storedCorrect++;

    // Consensus book — values are already probabilities summing to ≈1.
    const ch = Number(r.consensus_home_win);
    const cd = Number(r.consensus_draw);
    const ca = Number(r.consensus_away_win);
    if (
      isFinite(ch) &&
      isFinite(cd) &&
      isFinite(ca) &&
      ch > 0 &&
      cd > 0 &&
      ca > 0
    ) {
      const p = normalise(ch, cd, ca);
      consensusBrier += brier(p.h, p.d, p.a, actual);
      const pred =
        p.h >= p.d && p.h >= p.a ? 'home_win' : p.a >= p.d ? 'away_win' : 'draw';
      if (pred === actual) consensusCorrect++;
      consensusN++;

      const lid = Number(r.league_id);
      let ls = perLeague.get(lid);
      if (!ls) {
        ls = { name: r.league_name, n: 0, consB: 0, storedB: 0 };
        perLeague.set(lid, ls);
      }
      ls.n++;
      ls.consB += brier(p.h, p.d, p.a, actual);
      ls.storedB += brier(storedH, storedD, storedA, actual);
    }

    // Pinnacle (sharpest book — true gold standard when available)
    const ph = Number(r.pinnacle_home_win);
    const pd = Number(r.pinnacle_draw);
    const pa = Number(r.pinnacle_away_win);
    if (
      isFinite(ph) &&
      isFinite(pd) &&
      isFinite(pa) &&
      ph > 0 &&
      pd > 0 &&
      pa > 0
    ) {
      const pp = normalise(ph, pd, pa);
      pinnacleBrier += brier(pp.h, pp.d, pp.a, actual);
      const pred =
        pp.h >= pp.d && pp.h >= pp.a
          ? 'home_win'
          : pp.a >= pp.d
            ? 'away_win'
            : 'draw';
      if (pred === actual) pinnacleCorrect++;
      pinnacleN++;
    }
  }

  console.log('');
  console.log('=== Head-to-head on matched fixtures ===');
  console.log(`stored ensemble Brier:   ${(storedBrier / items.length).toFixed(6)}  accuracy: ${((storedCorrect / items.length) * 100).toFixed(2)}%`);
  if (consensusN > 0) {
    console.log(
      `consensus book Brier:    ${(consensusBrier / consensusN).toFixed(6)}  accuracy: ${((consensusCorrect / consensusN) * 100).toFixed(2)}%  (n=${consensusN})`,
    );
  }
  if (pinnacleN > 0) {
    console.log(
      `Pinnacle Brier:          ${(pinnacleBrier / pinnacleN).toFixed(6)}  accuracy: ${((pinnacleCorrect / pinnacleN) * 100).toFixed(2)}%  (n=${pinnacleN})`,
    );
  }

  if (consensusN > 0) {
    console.log('');
    console.log('Per-league head-to-head (consensus book vs stored ensemble):');
    console.log(
      `  ${'league'.padEnd(28)} ${'n'.padStart(4)}  ${'consensus_brier'.padStart(15)}  ${'stored_brier'.padStart(13)}  ${'Δ (neg=book wins)'.padStart(18)}`,
    );
    const sorted = Array.from(perLeague.entries()).sort(
      (a, b) => b[1].n - a[1].n,
    );
    for (const [lid, ls] of sorted) {
      if (ls.n < 5) continue;
      const name = (ls.name ?? `league-${lid}`).slice(0, 27);
      const cB = ls.consB / ls.n;
      const sB = ls.storedB / ls.n;
      console.log(
        `  ${name.padEnd(28)} ${String(ls.n).padStart(4)}  ${cB.toFixed(6).padStart(15)}  ${sB.toFixed(6).padStart(13)}  ${(cB - sB).toFixed(6).padStart(18)}  ${cB < sB ? '◀ book wins' : ''}`,
      );
    }
  }

  await client.end();
}

main();
