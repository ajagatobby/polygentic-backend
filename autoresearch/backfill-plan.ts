/**
 * Historical-fixture backfill planner (DRY RUN).
 *
 * Does NOT call the API or write to the DB. Produces a plan:
 *   - Which leagues need more data (have resolved predictions but <200 FT fixtures)
 *   - What seasons to pull for each
 *   - Estimated API call count and resulting fixture count
 *
 * Review the output, then a separate execution script can be written that
 * calls FootballService.syncFixtures for each (league, season) pair.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { sql } from 'drizzle-orm';

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const client = (postgres as any)(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
});
const db = drizzle(client, { schema });

async function main() {
  // Leagues that currently have resolved predictions.
  const leagueUsage = await db.execute(sql`
    SELECT
      f.league_id,
      f.league_name,
      count(DISTINCT p.id) AS predictions_count,
      count(DISTINCT CASE WHEN f.status IN ('FT','AET','PEN') AND f.goals_home IS NOT NULL THEN f.id END) AS ft_fixture_count,
      min(f.date)::date AS earliest_fixture,
      max(f.date)::date AS latest_fixture
    FROM predictions p
    JOIN fixtures f ON p.fixture_id = f.id
    WHERE p.prediction_status = 'resolved'
    GROUP BY f.league_id, f.league_name
    ORDER BY predictions_count DESC
  `);

  console.log('Leagues with resolved predictions (planning target):\n');
  console.log(
    `  ${'league'.padEnd(32)} ${'preds'.padStart(6)}  ${'FT fixtures'.padStart(12)}  ${'earliest'.padStart(10)}  ${'latest'.padStart(10)}  target`,
  );

  const backfillPlan: Array<{
    leagueId: number;
    leagueName: string;
    seasons: number[];
  }> = [];

  for (const r of leagueUsage as any[]) {
    const lid = r.league_id;
    const name = (r.league_name ?? `league-${lid}`).slice(0, 31);
    const preds = Number(r.predictions_count);
    const ftCount = Number(r.ft_fixture_count);
    const earliest = r.earliest_fixture?.toString?.().slice(0, 10) ?? '—';
    const latest = r.latest_fixture?.toString?.().slice(0, 10) ?? '—';

    // Target: ≥300 FT fixtures per league for a competent DC fit.
    // If we have <100, pull 2 prior seasons; <200 pull 1 prior; ≥300 skip.
    let targetSeasons: number[] = [];
    const currentYear = new Date().getUTCFullYear();
    if (ftCount < 100) {
      targetSeasons = [currentYear - 1, currentYear - 2];
    } else if (ftCount < 200) {
      targetSeasons = [currentYear - 1];
    }

    const action = targetSeasons.length
      ? `pull seasons ${targetSeasons.join(', ')}`
      : '(sufficient)';

    console.log(
      `  ${name.padEnd(32)} ${String(preds).padStart(6)}  ${String(ftCount).padStart(12)}  ${earliest.padStart(10)}  ${latest.padStart(10)}  ${action}`,
    );

    if (targetSeasons.length > 0) {
      backfillPlan.push({
        leagueId: lid,
        leagueName: name,
        seasons: targetSeasons,
      });
    }
  }

  console.log('');
  console.log('═══ Backfill plan summary ═══');
  const totalCalls = backfillPlan.reduce((s, p) => s + p.seasons.length, 0);
  console.log(`Leagues to backfill: ${backfillPlan.length}`);
  console.log(`Total (league, season) combinations: ${totalCalls}`);
  console.log(
    `API-Football calls required: ${totalCalls} (one /fixtures call per (league, season))`,
  );
  console.log(
    `Expected new fixtures: ~${totalCalls * 380} (assuming ~380 matches per season per league)`,
  );
  console.log('');
  console.log('To execute:');
  console.log('  1. Review plan above for correctness.');
  console.log(
    '  2. Write an execution script that calls FootballService.syncFixtures(leagueId, \'YYYY-01-01\', \'YYYY-12-31\') for each row.',
  );
  console.log(
    '  3. Run with rate limiting — API-Football free tier allows 100 calls/min; paid tiers more.',
  );
  console.log(
    '  4. After backfill completes, re-run autoresearch/dixon-coles-backtest.ts.',
  );

  // Dump plan as JSON for the execution script to consume
  console.log('\n═══ Plan as JSON (for exec script) ═══');
  console.log(JSON.stringify(backfillPlan, null, 2));

  await client.end();
}

main();
