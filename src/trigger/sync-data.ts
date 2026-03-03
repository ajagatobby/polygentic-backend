import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';
import { TRACKED_LEAGUES } from '../football/football.service';

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Data Sync Tasks                                                 │
 * │                                                                  │
 * │  Each task syncs data for ALL tracked leagues. Data is saved to  │
 * │  the database incrementally as each league completes — there is  │
 * │  no batching or waiting for all leagues to finish.               │
 * │                                                                  │
 * │  Trigger.dev provides: durable execution, automatic retries,     │
 * │  real-time dashboard, run history, and cancellation.             │
 * └──────────────────────────────────────────────────────────────────┘
 */

// ─── Sync Fixtures (upcoming) ───────────────────────────────────────

export const syncFixturesTask = task({
  id: 'sync-fixtures',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { footballService } = initServices();

    logger.info(
      `Syncing upcoming fixtures for ${TRACKED_LEAGUES.length} leagues`,
    );
    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_LEAGUES) {
      try {
        const count = await footballService.syncFixtures([leagueId]);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(`League ${leagueId}: ${count} fixtures synced`);
        }
      } catch (error) {
        failed++;
        logger.warn(
          `League ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    logger.info('Fixtures sync complete', {
      totalProcessed,
      succeeded,
      failed,
    });
    return { totalProcessed, succeeded, failed };
  },
});

// ─── Sync Completed Fixtures (final scores) ─────────────────────────

export const syncCompletedFixturesTask = task({
  id: 'sync-completed-fixtures',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { footballService } = initServices();

    logger.info(
      `Syncing completed fixtures for ${TRACKED_LEAGUES.length} leagues`,
    );
    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_LEAGUES) {
      try {
        const count = await footballService.syncCompletedFixtures([leagueId]);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(`League ${leagueId}: ${count} completed fixtures synced`);
        }
      } catch (error) {
        failed++;
        logger.warn(
          `League ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    logger.info('Completed fixtures sync done', {
      totalProcessed,
      succeeded,
      failed,
    });
    return { totalProcessed, succeeded, failed };
  },
});

// ─── Sync Injuries ──────────────────────────────────────────────────

export const syncInjuriesTask = task({
  id: 'sync-injuries',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { footballService } = initServices();

    logger.info(`Syncing injuries for ${TRACKED_LEAGUES.length} leagues`);
    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_LEAGUES) {
      try {
        const count = await footballService.syncInjuries(leagueId);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(`League ${leagueId}: ${count} injuries synced`);
        }
      } catch (error) {
        failed++;
        logger.warn(
          `League ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    logger.info('Injuries sync complete', {
      totalProcessed,
      succeeded,
      failed,
    });
    return { totalProcessed, succeeded, failed };
  },
});

// ─── Sync Standings ─────────────────────────────────────────────────

export const syncStandingsTask = task({
  id: 'sync-standings',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { footballService } = initServices();

    logger.info(`Syncing standings for ${TRACKED_LEAGUES.length} leagues`);
    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_LEAGUES) {
      try {
        const count = await footballService.syncStandings(leagueId);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(`League ${leagueId}: ${count} standings synced`);
        }
      } catch (error) {
        failed++;
        logger.warn(
          `League ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    logger.info('Standings sync complete', {
      totalProcessed,
      succeeded,
      failed,
    });
    return { totalProcessed, succeeded, failed };
  },
});

// ─── Sync Odds ──────────────────────────────────────────────────────

export const syncOddsTask = task({
  id: 'sync-odds',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { oddsService } = initServices();

    logger.info('Syncing odds for all soccer events');
    const result = await oddsService.syncAllSoccerOdds();

    logger.info('Odds sync complete', result);
    return result;
  },
});

// ─── Full Sync (all data types sequentially) ────────────────────────

export const fullSyncTask = task({
  id: 'full-sync',
  // Longer timeout — this runs all sync types sequentially
  maxDuration: 7200,
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
  },
  run: async () => {
    logger.info('=== Starting full data sync ===');

    const results: Record<string, any> = {};

    // Step 1: Fixtures
    logger.info('Step 1/5: Syncing fixtures...');
    try {
      const handle = await syncFixturesTask.triggerAndWait(undefined as void);
      results.fixtures = handle.ok ? handle.output : { error: 'failed' };
    } catch (error) {
      results.fixtures = {
        error: error instanceof Error ? error.message : String(error),
      };
      logger.error('Fixtures sync failed, continuing...', {
        error: results.fixtures.error,
      });
    }

    // Step 2: Completed fixtures
    logger.info('Step 2/5: Syncing completed fixtures...');
    try {
      const handle = await syncCompletedFixturesTask.triggerAndWait(
        undefined as void,
      );
      results.completed_fixtures = handle.ok
        ? handle.output
        : { error: 'failed' };
    } catch (error) {
      results.completed_fixtures = {
        error: error instanceof Error ? error.message : String(error),
      };
      logger.error('Completed fixtures sync failed, continuing...', {
        error: results.completed_fixtures.error,
      });
    }

    // Step 3: Standings
    logger.info('Step 3/5: Syncing standings...');
    try {
      const handle = await syncStandingsTask.triggerAndWait(undefined as void);
      results.standings = handle.ok ? handle.output : { error: 'failed' };
    } catch (error) {
      results.standings = {
        error: error instanceof Error ? error.message : String(error),
      };
      logger.error('Standings sync failed, continuing...', {
        error: results.standings.error,
      });
    }

    // Step 4: Injuries
    logger.info('Step 4/5: Syncing injuries...');
    try {
      const handle = await syncInjuriesTask.triggerAndWait(undefined as void);
      results.injuries = handle.ok ? handle.output : { error: 'failed' };
    } catch (error) {
      results.injuries = {
        error: error instanceof Error ? error.message : String(error),
      };
      logger.error('Injuries sync failed, continuing...', {
        error: results.injuries.error,
      });
    }

    // Step 5: Odds
    logger.info('Step 5/5: Syncing odds...');
    try {
      const handle = await syncOddsTask.triggerAndWait(undefined as void);
      results.odds = handle.ok ? handle.output : { error: 'failed' };
    } catch (error) {
      results.odds = {
        error: error instanceof Error ? error.message : String(error),
      };
      logger.error('Odds sync failed', { error: results.odds.error });
    }

    logger.info('=== Full data sync complete ===', results);
    return results;
  },
});
