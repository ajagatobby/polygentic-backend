/**
 * Standalone script to sync all tracked league fixtures to the database.
 *
 * Bootstraps the NestJS application context (no HTTP server), runs
 * FootballService.syncFixtures() for every tracked league, and optionally
 * syncs standings + injuries in the same pass.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/sync-fixtures.ts
 *   npx ts-node -r tsconfig-paths/register scripts/sync-fixtures.ts --standings --injuries
 *   npx ts-node -r tsconfig-paths/register scripts/sync-fixtures.ts --league 39 --league 2
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  FootballService,
  TRACKED_LEAGUES,
} from '../src/football/football.service';

interface SyncOptions {
  leagueIds: number[];
  includeStandings: boolean;
  includeInjuries: boolean;
}

function parseArgs(): SyncOptions {
  const args = process.argv.slice(2);
  const leagueIds: number[] = [];
  let includeStandings = false;
  let includeInjuries = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--league':
      case '-l':
        const id = parseInt(args[++i], 10);
        if (!isNaN(id)) leagueIds.push(id);
        break;
      case '--standings':
      case '-s':
        includeStandings = true;
        break;
      case '--injuries':
      case '-i':
        includeInjuries = true;
        break;
      case '--all':
      case '-a':
        includeStandings = true;
        includeInjuries = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: npx ts-node -r tsconfig-paths/register scripts/sync-fixtures.ts [options]

Options:
  --league, -l <id>   Sync a specific league (can be repeated). Defaults to all tracked leagues.
  --standings, -s     Also sync standings/team form data.
  --injuries, -i      Also sync injury data.
  --all, -a           Sync fixtures + standings + injuries.
  --help, -h          Show this help message.

Tracked leagues: ${[...TRACKED_LEAGUES].join(', ')}
        `);
        process.exit(0);
    }
  }

  return {
    leagueIds: leagueIds.length > 0 ? leagueIds : [...TRACKED_LEAGUES],
    includeStandings,
    includeInjuries,
  };
}

async function main() {
  const options = parseArgs();

  console.log('=== Fixture Sync Script ===');
  console.log(`Leagues: ${options.leagueIds.join(', ')}`);
  console.log(`Standings: ${options.includeStandings ? 'yes' : 'no'}`);
  console.log(`Injuries:  ${options.includeInjuries ? 'yes' : 'no'}`);
  console.log('');

  // Bootstrap NestJS app context without starting the HTTP server
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const footballService = app.get(FootballService);

  const startTime = Date.now();
  let totalFixtures = 0;
  let totalStandings = 0;
  let totalInjuries = 0;
  const errors: string[] = [];

  // Determine the current season
  const now = new Date();
  const season =
    now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;

  // ── Sync fixtures ────────────────────────────────────────────────────
  console.log(
    `\n[1/3] Syncing fixtures for ${options.leagueIds.length} leagues...`,
  );

  for (const leagueId of options.leagueIds) {
    try {
      const count = await footballService.syncFixtures([leagueId]);
      totalFixtures += count;
      console.log(`  League ${leagueId}: ${count} fixtures upserted`);
    } catch (error) {
      const msg = `League ${leagueId} fixtures failed: ${error.message}`;
      console.error(`  ${msg}`);
      errors.push(msg);
    }
  }

  // ── Sync standings ───────────────────────────────────────────────────
  if (options.includeStandings) {
    console.log(`\n[2/3] Syncing standings (season ${season})...`);

    for (const leagueId of options.leagueIds) {
      try {
        const count = await footballService.syncStandings(leagueId, season);
        totalStandings += count;
        console.log(`  League ${leagueId}: ${count} team standings upserted`);
      } catch (error) {
        const msg = `League ${leagueId} standings failed: ${error.message}`;
        console.error(`  ${msg}`);
        errors.push(msg);
      }
    }
  } else {
    console.log('\n[2/3] Standings sync skipped (use --standings to include)');
  }

  // ── Sync injuries ───────────────────────────────────────────────────
  if (options.includeInjuries) {
    console.log(`\n[3/3] Syncing injuries (season ${season})...`);

    for (const leagueId of options.leagueIds) {
      try {
        const count = await footballService.syncInjuries(leagueId, season);
        totalInjuries += count;
        console.log(`  League ${leagueId}: ${count} injuries synced`);
      } catch (error) {
        const msg = `League ${leagueId} injuries failed: ${error.message}`;
        console.error(`  ${msg}`);
        errors.push(msg);
      }
    }
  } else {
    console.log('[3/3] Injuries sync skipped (use --injuries to include)');
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n=== Sync Complete ===');
  console.log(`Duration:   ${elapsed}s`);
  console.log(`Fixtures:   ${totalFixtures} upserted`);
  if (options.includeStandings) {
    console.log(`Standings:  ${totalStandings} upserted`);
  }
  if (options.includeInjuries) {
    console.log(`Injuries:   ${totalInjuries} synced`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    errors.forEach((e) => console.log(`  - ${e}`));
  }

  await app.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
