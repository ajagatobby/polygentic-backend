/**
 * Execute the historical-fixtures backfill.
 *
 * For each league the system has resolved predictions in, pulls the previous
 * two seasons of fixtures from API-Football and upserts them into the DB.
 * Uses FootballService.syncFixtures (production path). No new code — same
 * behaviour the production sync cron uses, just for a broader date range.
 *
 * After fixtures land, runs the odds sync (now covering 35 sport keys with
 * inline link-backfill) so downstream analyses can actually see the whole
 * picture.
 *
 * Safe to re-run: syncFixtures upserts on fixture ID, so repeated runs for
 * the same (league, season) are idempotent.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { ConfigService } from '@nestjs/config';
import { FootballService } from '../src/football/football.service';
import { OddsService } from '../src/odds/odds.service';
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

// Prior seasons to pull. API-Football season numbers are usually the start
// year of a European-format season (2023 = "2023-24"), and the full calendar
// year for Americas. syncFixturesBySeason handles the mapping correctly.
const BACKFILL_SEASONS = [2023, 2024];

async function main() {
  const config = new ConfigService(process.env);
  const footballService = new FootballService(config, db as any);
  const oddsService = new OddsService(config, db as any);

  // ── Discover which leagues to backfill ──
  const leagueRows = await db.execute(sql`
    SELECT DISTINCT f.league_id, f.league_name
    FROM predictions p
    JOIN fixtures f ON p.fixture_id = f.id
    WHERE p.prediction_status = 'resolved'
    ORDER BY f.league_id
  `);
  const leagues = (leagueRows as any[]).map((r) => ({
    id: Number(r.league_id),
    name: r.league_name as string,
  }));

  console.log(
    `Backfilling ${leagues.length} leagues × ${BACKFILL_SEASONS.length} seasons = ${leagues.length * BACKFILL_SEASONS.length} API calls\n`,
  );

  const startFixtureCount = await countFixtures(db);
  console.log(`Starting fixture count: ${startFixtureCount}\n`);

  let totalCalls = 0;
  let totalUpserted = 0;
  const errors: Array<{ league: string; range: string; error: string }> = [];

  const t0 = Date.now();

  for (const league of leagues) {
    for (const season of BACKFILL_SEASONS) {
      totalCalls++;
      const label = `[${totalCalls}/${leagues.length * BACKFILL_SEASONS.length}] ${league.name ?? `league-${league.id}`} season=${season}`;
      try {
        const n = await footballService.syncFixturesBySeason(
          league.id,
          season,
        );
        totalUpserted += n;
        console.log(`${label}: +${n} fixtures`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`${label}: FAIL — ${msg}`);
        errors.push({
          league: league.name ?? `league-${league.id}`,
          range: String(season),
          error: msg,
        });
      }
    }
  }

  const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
  const endFixtureCount = await countFixtures(db);

  console.log('');
  console.log('═══ Fixture backfill complete ═══');
  console.log(`API calls:             ${totalCalls}`);
  console.log(`Fixtures upserted:     ${totalUpserted}`);
  console.log(`Errors:                ${errors.length}`);
  console.log(`Elapsed:               ${elapsedMin} min`);
  console.log(`Fixtures before → after: ${startFixtureCount} → ${endFixtureCount} (+${endFixtureCount - startFixtureCount})`);
  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) {
      console.log(`  ${e.league} ${e.range}: ${e.error}`);
    }
  }

  // ── Odds sync + inline link backfill (only if requested) ──
  if (process.env.RUN_ODDS_SYNC === 'true') {
    console.log('\n═══ Running odds sync (35 sport keys) ═══');
    try {
      const result = await oddsService.syncAllSoccerOdds();
      console.log('Odds sync result:', result);

      const backfill = await oddsService.backfillUnlinkedFixtures({
        since: new Date('2023-01-01'),
        until: new Date('2026-12-31'),
        limit: 20_000,
      });
      console.log('Link backfill result:', backfill);
    } catch (err) {
      console.log(
        'Odds sync failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    console.log(
      '\n(Skipping odds sync — set RUN_ODDS_SYNC=true to include.)',
    );
  }

  // ── Final state check ──
  console.log('\n═══ Final data state ═══');
  const finalCounts = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM fixtures) AS fixtures,
      (SELECT count(*) FROM fixtures WHERE status IN ('FT','AET','PEN') AND goals_home IS NOT NULL) AS ft_fixtures,
      (SELECT count(*) FROM fixtures WHERE odds_api_event_id IS NOT NULL) AS linked_fixtures,
      (SELECT count(*) FROM bookmaker_odds) AS bookmaker_odds,
      (SELECT count(DISTINCT odds_api_event_id) FROM bookmaker_odds) AS unique_events,
      (SELECT count(*) FROM consensus_odds WHERE market_key='h2h' AND consensus_home_win IS NOT NULL) AS h2h_consensus_rows
  `);
  console.log(finalCounts[0]);

  await client.end();
}

async function countFixtures(db: any): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM fixtures`);
  return Number((r as any)[0].n);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
