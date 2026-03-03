/**
 * Historical data backfill script.
 *
 * Fetches 6 months (or custom range) of completed fixtures for all tracked
 * leagues, plus match statistics and events for each fixture. This gives
 * the AI prediction pipeline richer context and enables frontend graph data.
 *
 * The script works in 3 phases:
 *   1. Fetch fixtures for each league in 2-week chunks (avoids pagination)
 *   2. Fetch match statistics for each completed fixture
 *   3. Fetch match events (goals, cards, subs) for each completed fixture
 *
 * Includes:
 *   - Throttling (configurable req/min) to stay within API rate limits
 *   - Resume capability: skips fixtures already in DB (upsert is idempotent)
 *   - Progress tracking with ETA
 *   - Dry-run mode to estimate API call count
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --months 3
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --from 2025-09-01 --to 2026-03-01
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --league 39 --league 140 --stats --events
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --dry-run
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  FootballService,
  TRACKED_LEAGUES,
} from '../src/football/football.service';
import { eq, and, inArray } from 'drizzle-orm';
import * as schema from '../src/database/schema';

interface BackfillOptions {
  leagueIds: number[];
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  includeStats: boolean;
  includeEvents: boolean;
  includeLineups: boolean;
  dryRun: boolean;
  throttleMs: number; // milliseconds between API calls
  chunkDays: number; // days per date-range chunk
}

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  const leagueIds: number[] = [];
  let from = '';
  let to = '';
  let months = 6;
  let includeStats = false;
  let includeEvents = false;
  let includeLineups = false;
  let dryRun = false;
  let throttleMs = 450; // ~130 req/min (safe under 300 req/min limit)
  let chunkDays = 14;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--league':
      case '-l': {
        const id = parseInt(args[++i], 10);
        if (!isNaN(id)) leagueIds.push(id);
        break;
      }
      case '--from':
        from = args[++i];
        break;
      case '--to':
        to = args[++i];
        break;
      case '--months':
      case '-m':
        months = parseInt(args[++i], 10) || 6;
        break;
      case '--stats':
      case '-s':
        includeStats = true;
        break;
      case '--events':
      case '-e':
        includeEvents = true;
        break;
      case '--lineups':
        includeLineups = true;
        break;
      case '--all':
      case '-a':
        includeStats = true;
        includeEvents = true;
        includeLineups = true;
        break;
      case '--dry-run':
      case '-d':
        dryRun = true;
        break;
      case '--throttle':
        throttleMs = parseInt(args[++i], 10) || 450;
        break;
      case '--chunk-days':
        chunkDays = parseInt(args[++i], 10) || 14;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts [options]

Options:
  --from <YYYY-MM-DD>     Start date (default: 6 months ago)
  --to <YYYY-MM-DD>       End date (default: today)
  --months, -m <N>        Months to look back (default: 6, ignored if --from is set)
  --league, -l <id>       Specific league(s) to backfill (repeatable). Defaults to all tracked.
  --stats, -s             Also fetch match statistics (xG, shots, possession, etc.)
  --events, -e            Also fetch match events (goals, cards, substitutions)
  --lineups               Also fetch lineups for completed matches
  --all, -a               Fetch stats + events + lineups (equivalent to -s -e --lineups)
  --dry-run, -d           Estimate API calls without making any requests
  --throttle <ms>         Milliseconds between API calls (default: 450 ≈ 130 req/min)
  --chunk-days <N>        Days per date-range chunk (default: 14)
  --help, -h              Show this help

Tracked leagues: ${[...TRACKED_LEAGUES].join(', ')}

Examples:
  # Full 6-month backfill with stats and events:
  npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --all

  # Quick 3-month backfill for Premier League only:
  npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts -l 39 -m 3 --all

  # Dry run to check API call estimate:
  npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --all --dry-run
        `);
        process.exit(0);
    }
  }

  // Compute date range
  if (!to) {
    to = new Date().toISOString().split('T')[0];
  }
  if (!from) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    from = d.toISOString().split('T')[0];
  }

  return {
    leagueIds: leagueIds.length > 0 ? leagueIds : [...TRACKED_LEAGUES],
    from,
    to,
    includeStats,
    includeEvents,
    includeLineups,
    dryRun,
    throttleMs,
    chunkDays,
  };
}

/**
 * Split a date range into chunks of N days.
 * Returns array of [from, to] string pairs (YYYY-MM-DD).
 */
function chunkDateRange(
  from: string,
  to: string,
  chunkDays: number,
): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  const msPerDay = 24 * 60 * 60 * 1000;
  let current = new Date(from);
  const end = new Date(to);

  while (current < end) {
    const chunkEnd = new Date(
      Math.min(current.getTime() + chunkDays * msPerDay, end.getTime()),
    );
    chunks.push([
      current.toISOString().split('T')[0],
      chunkEnd.toISOString().split('T')[0],
    ]);
    current = new Date(chunkEnd.getTime() + msPerDay); // next day
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// Completed match statuses
const COMPLETED_STATUSES = new Set(['FT', 'AET', 'PEN']);

async function main() {
  const options = parseArgs();

  console.log('=== Historical Data Backfill ===');
  console.log(`Date range: ${options.from} to ${options.to}`);
  console.log(`Leagues:    ${options.leagueIds.length}`);
  console.log(`Stats:      ${options.includeStats ? 'yes' : 'no'}`);
  console.log(`Events:     ${options.includeEvents ? 'yes' : 'no'}`);
  console.log(`Lineups:    ${options.includeLineups ? 'yes' : 'no'}`);
  console.log(
    `Throttle:   ${options.throttleMs}ms (~${Math.round(60000 / options.throttleMs)} req/min)`,
  );
  console.log(`Chunk size: ${options.chunkDays} days`);
  console.log(`Dry run:    ${options.dryRun ? 'YES' : 'no'}`);
  console.log('');

  // Compute chunks
  const chunks = chunkDateRange(options.from, options.to, options.chunkDays);
  console.log(`Date range split into ${chunks.length} chunk(s)`);

  // Estimate API calls for dry run
  // Each league gets 1 call per chunk per season (calendar-year leagues get 2 seasons)
  const calendarYearLeagues = new Set([253, 262, 71, 128]);
  let estimatedFixtureCalls = 0;
  for (const leagueId of options.leagueIds) {
    const seasonsPerLeague = calendarYearLeagues.has(leagueId) ? 2 : 1;
    estimatedFixtureCalls += chunks.length * seasonsPerLeague;
  }

  // Rough estimate: ~15 fixtures per league per 6 months
  const estimatedFixtures = options.leagueIds.length * 15;
  const estimatedDetailCalls =
    estimatedFixtures *
    ((options.includeStats ? 1 : 0) +
      (options.includeEvents ? 1 : 0) +
      (options.includeLineups ? 1 : 0));

  const totalEstimatedCalls = estimatedFixtureCalls + estimatedDetailCalls;
  const estimatedTimeMs = totalEstimatedCalls * options.throttleMs;

  console.log(`\nEstimated API calls:`);
  console.log(`  Fixture fetches:  ~${estimatedFixtureCalls}`);
  console.log(
    `  Detail fetches:   ~${estimatedDetailCalls} (stats/events/lineups)`,
  );
  console.log(`  Total:            ~${totalEstimatedCalls}`);
  console.log(`  Estimated time:   ~${formatDuration(estimatedTimeMs)}`);

  if (options.dryRun) {
    console.log('\n[DRY RUN] No API calls made. Exiting.');
    process.exit(0);
  }

  console.log('\nStarting backfill...\n');

  // Bootstrap NestJS app context
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const footballService = app.get(FootballService);
  const db = app.get('DRIZZLE') as any;

  const startTime = Date.now();
  let totalFixtures = 0;
  let totalStats = 0;
  let totalEvents = 0;
  let totalLineups = 0;
  let apiCalls = 0;
  const errors: string[] = [];
  const completedFixtureIds: number[] = [];

  // ── Phase 1: Fetch fixtures by date range ──────────────────────────
  console.log('[Phase 1/3] Fetching historical fixtures...');

  for (const leagueId of options.leagueIds) {
    let leagueTotal = 0;

    for (const [chunkFrom, chunkTo] of chunks) {
      try {
        await sleep(options.throttleMs);
        apiCalls++;

        const count = await footballService.syncFixturesByDateRange(
          leagueId,
          chunkFrom,
          chunkTo,
        );
        leagueTotal += count;
        totalFixtures += count;
      } catch (error: any) {
        const msg = `League ${leagueId} fixtures (${chunkFrom}–${chunkTo}): ${error.message}`;
        errors.push(msg);
      }
    }

    if (leagueTotal > 0) {
      console.log(`  League ${leagueId}: ${leagueTotal} fixtures upserted`);
    }
  }

  console.log(
    `  Total: ${totalFixtures} fixtures upserted (${apiCalls} API calls)\n`,
  );

  // ── Collect completed fixture IDs for detail fetching ──────────────
  if (options.includeStats || options.includeEvents || options.includeLineups) {
    console.log('[Phase 1.5] Finding completed fixtures for detail fetch...');

    const fromDate = new Date(options.from);
    const toDate = new Date(options.to + 'T23:59:59Z');

    const completedFixtures = await db
      .select({ id: schema.fixtures.id })
      .from(schema.fixtures)
      .where(
        and(
          inArray(schema.fixtures.status, [...COMPLETED_STATUSES]),
          inArray(schema.fixtures.leagueId, options.leagueIds),
        ),
      );

    for (const f of completedFixtures) {
      completedFixtureIds.push(f.id);
    }

    console.log(`  Found ${completedFixtureIds.length} completed fixtures\n`);
  }

  // ── Phase 2: Fetch match statistics ────────────────────────────────
  if (options.includeStats && completedFixtureIds.length > 0) {
    console.log(
      `[Phase 2/3] Fetching match statistics for ${completedFixtureIds.length} fixtures...`,
    );

    let processed = 0;
    let skipped = 0;
    const phaseStart = Date.now();

    for (const fixtureId of completedFixtureIds) {
      processed++;

      // Check if stats already exist (skip to save API calls)
      const existing = await db
        .select({ id: schema.fixtureStatistics.id })
        .from(schema.fixtureStatistics)
        .where(eq(schema.fixtureStatistics.fixtureId, fixtureId))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        await sleep(options.throttleMs);
        apiCalls++;

        const stats = await footballService.fetchFixtureStatistics(fixtureId);
        if (stats.length > 0) totalStats++;
      } catch (error: any) {
        errors.push(`Stats fixture ${fixtureId}: ${error.message}`);
      }

      // Progress update every 50 fixtures
      if (processed % 50 === 0) {
        const elapsed = Date.now() - phaseStart;
        const rate = processed / (elapsed / 1000);
        const remaining = completedFixtureIds.length - processed;
        const eta = remaining / rate;
        console.log(
          `  Progress: ${processed}/${completedFixtureIds.length} (${skipped} skipped, ${totalStats} fetched, ETA: ${formatDuration(eta * 1000)})`,
        );
      }
    }

    console.log(
      `  Done: ${totalStats} stats fetched, ${skipped} skipped (already in DB)\n`,
    );
  } else if (options.includeStats) {
    console.log('[Phase 2/3] No completed fixtures to fetch stats for\n');
  } else {
    console.log('[Phase 2/3] Stats fetch skipped (use --stats to include)\n');
  }

  // ── Phase 3: Fetch match events ────────────────────────────────────
  if (options.includeEvents && completedFixtureIds.length > 0) {
    console.log(
      `[Phase 3/3] Fetching match events for ${completedFixtureIds.length} fixtures...`,
    );

    let processed = 0;
    let skipped = 0;
    const phaseStart = Date.now();

    for (const fixtureId of completedFixtureIds) {
      processed++;

      // Check if events already exist
      const existing = await db
        .select({ id: schema.fixtureEvents.id })
        .from(schema.fixtureEvents)
        .where(eq(schema.fixtureEvents.fixtureId, fixtureId))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        await sleep(options.throttleMs);
        apiCalls++;

        const events = await footballService.fetchFixtureEvents(fixtureId);
        if (events.length > 0) totalEvents++;
      } catch (error: any) {
        errors.push(`Events fixture ${fixtureId}: ${error.message}`);
      }

      if (processed % 50 === 0) {
        const elapsed = Date.now() - phaseStart;
        const rate = processed / (elapsed / 1000);
        const remaining = completedFixtureIds.length - processed;
        const eta = remaining / rate;
        console.log(
          `  Progress: ${processed}/${completedFixtureIds.length} (${skipped} skipped, ${totalEvents} fetched, ETA: ${formatDuration(eta * 1000)})`,
        );
      }
    }

    console.log(
      `  Done: ${totalEvents} events fetched, ${skipped} skipped (already in DB)\n`,
    );
  } else if (options.includeEvents) {
    console.log('[Phase 3/3] No completed fixtures to fetch events for\n');
  } else {
    console.log('[Phase 3/3] Events fetch skipped (use --events to include)\n');
  }

  // ── Optional: Fetch lineups for completed fixtures ─────────────────
  if (options.includeLineups && completedFixtureIds.length > 0) {
    console.log(
      `[Bonus] Fetching lineups for ${completedFixtureIds.length} completed fixtures...`,
    );

    let processed = 0;
    let skipped = 0;

    for (const fixtureId of completedFixtureIds) {
      processed++;

      // Check if lineups already exist
      const existing = await db
        .select({ id: schema.fixtureLineups.id })
        .from(schema.fixtureLineups)
        .where(eq(schema.fixtureLineups.fixtureId, fixtureId))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        await sleep(options.throttleMs);
        apiCalls++;

        const count = await footballService.fetchAndPersistLineups(fixtureId);
        if (count > 0) totalLineups++;
      } catch (error: any) {
        // Lineups may not be available for older fixtures — not an error
      }

      if (processed % 50 === 0) {
        console.log(
          `  Progress: ${processed}/${completedFixtureIds.length} (${skipped} skipped, ${totalLineups} fetched)`,
        );
      }
    }

    console.log(
      `  Done: ${totalLineups} lineups fetched, ${skipped} skipped\n`,
    );
  }

  // ── Summary ────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;

  console.log('=== Backfill Complete ===');
  console.log(`Duration:    ${formatDuration(elapsed)}`);
  console.log(`API calls:   ${apiCalls}`);
  console.log(`Fixtures:    ${totalFixtures} upserted`);
  if (options.includeStats) {
    console.log(`Statistics:  ${totalStats} fetched`);
  }
  if (options.includeEvents) {
    console.log(`Events:      ${totalEvents} fetched`);
  }
  if (options.includeLineups) {
    console.log(`Lineups:     ${totalLineups} fetched`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) {
      console.log(`  - ${e}`);
    }
    if (errors.length > 20) {
      console.log(`  ... and ${errors.length - 20} more`);
    }
  }

  await app.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
