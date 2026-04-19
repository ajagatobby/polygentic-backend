/**
 * Simulate the Brier impact of blending stored predictions with per-league
 * priors at various weights.
 *
 * For each resolved prediction:
 *   blended_prob = α · stored_prob + (1 − α) · league_prior
 *
 * Then measure Brier at α ∈ {1.0, 0.9, 0.8, ..., 0.0}.
 *
 * α = 1.0 → current ensemble (no blending)
 * α = 0.0 → pure league prior
 *
 * The best α tells us the optimal weight on the existing signal, and the
 * Brier at that α is a realistic approximation of what the per-league-prior
 * implementation will achieve once the LLM starts incorporating priors
 * natively (since the LLM can in principle do more nuanced blending than
 * a linear mix).
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const client = (postgres as any)(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
});
const db = drizzle(client, { schema });

function brier(
  h: number,
  d: number,
  a: number,
  actual: 'home_win' | 'draw' | 'away_win',
): number {
  const yh = actual === 'home_win' ? 1 : 0;
  const yd = actual === 'draw' ? 1 : 0;
  const ya = actual === 'away_win' ? 1 : 0;
  return (h - yh) ** 2 + (d - yd) ** 2 + (a - ya) ** 2;
}

// Shrinkage parameters must match LeaguePriorsService.
const GLOBAL = { home: 0.45, draw: 0.27, away: 0.28 };
const KAPPA = 40;

async function main() {
  // Pull per-league empirical rates from completed fixtures.
  // (Mirrors LeaguePriorsService.getLeaguePriors.)
  const leagueRows = await db.execute(sql`
    SELECT
      league_id,
      count(*)::int AS n,
      count(*) FILTER (WHERE goals_home > goals_away)::int AS h,
      count(*) FILTER (WHERE goals_home = goals_away)::int AS d,
      count(*) FILTER (WHERE goals_home < goals_away)::int AS a
    FROM fixtures
    WHERE status IN ('FT', 'AET', 'PEN')
      AND goals_home IS NOT NULL
      AND goals_away IS NOT NULL
    GROUP BY league_id
  `);

  const priors = new Map<
    number,
    {
      homeRate: number;
      drawRate: number;
      awayRate: number;
      n: number;
      isReliable: boolean;
    }
  >();
  for (const r of leagueRows as any[]) {
    const n = Number(r.n);
    const h = Number(r.h);
    const d = Number(r.d);
    const a = Number(r.a);
    const home = (h + KAPPA * GLOBAL.home) / (n + KAPPA);
    const draw = (d + KAPPA * GLOBAL.draw) / (n + KAPPA);
    const away = (a + KAPPA * GLOBAL.away) / (n + KAPPA);
    const sum = home + draw + away;
    priors.set(Number(r.league_id), {
      homeRate: home / sum,
      drawRate: draw / sum,
      awayRate: away / sum,
      n,
      isReliable: n >= 30,
    });
  }
  console.log(
    `Loaded per-league priors for ${priors.size} leagues (${
      Array.from(priors.values()).filter((p) => p.isReliable).length
    } reliable, n≥30)\n`,
  );

  // Load resolved predictions with league id
  const rows = await db
    .select({
      homeProb: schema.predictions.homeWinProb,
      drawProb: schema.predictions.drawProb,
      awayProb: schema.predictions.awayWinProb,
      actualResult: schema.predictions.actualResult,
      leagueId: schema.fixtures.leagueId,
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

  const items = rows
    .filter((r) =>
      ['home_win', 'draw', 'away_win'].includes(r.actualResult as string),
    )
    .map((r) => ({
      h: Number(r.homeProb),
      d: Number(r.drawProb),
      a: Number(r.awayProb),
      actual: r.actualResult as 'home_win' | 'draw' | 'away_win',
      leagueId: r.leagueId,
      prior: priors.get(r.leagueId),
    }));

  console.log(`Scoring ${items.length} resolved predictions at blend weights:\n`);
  console.log(
    `  ${'α'.padStart(4)}  ${'brier'.padStart(9)}  ${'accuracy'.padStart(8)}  ${'Δ_vs_α=1'.padStart(9)}  description`,
  );

  const storedOnly = items.reduce(
    (s, x) => s + brier(x.h, x.d, x.a, x.actual),
    0,
  ) / items.length;

  for (let alpha10 = 10; alpha10 >= 0; alpha10--) {
    const alpha = alpha10 / 10;
    let brierSum = 0;
    let correct = 0;
    let blended = 0;
    for (const x of items) {
      let h = x.h,
        d = x.d,
        a = x.a;
      if (x.prior && x.prior.isReliable) {
        h = alpha * x.h + (1 - alpha) * x.prior.homeRate;
        d = alpha * x.d + (1 - alpha) * x.prior.drawRate;
        a = alpha * x.a + (1 - alpha) * x.prior.awayRate;
        blended++;
      }
      brierSum += brier(h, d, a, x.actual);
      const pred = h >= d && h >= a ? 'home_win' : a >= d ? 'away_win' : 'draw';
      if (pred === x.actual) correct++;
    }
    const b = brierSum / items.length;
    const acc = (correct / items.length) * 100;
    const delta = b - storedOnly;
    const desc =
      alpha === 1
        ? `100% stored (current system)`
        : alpha === 0
          ? `100% league prior (no model — constant per league)`
          : `${(alpha * 100).toFixed(0)}% stored + ${((1 - alpha) * 100).toFixed(0)}% prior`;
    console.log(
      `  ${alpha.toFixed(1).padStart(4)}  ${b.toFixed(6).padStart(9)}  ${acc.toFixed(2).padStart(7)}%  ${delta >= 0 ? '+' : ''}${delta.toFixed(6).padStart(8)}  ${desc} [blended=${blended}/${items.length}]`,
    );
  }

  await client.end();
}

main();
