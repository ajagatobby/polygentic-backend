import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';
import { TRACKED_BASKETBALL_LEAGUES } from '../basketball/basketball.service';

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Basketball Data Sync Tasks                                      │
 * │                                                                  │
 * │  Designed for the API-Basketball free tier (100 req/day).        │
 * │  Schedules are conservative to stay within budget:               │
 * │    - Fixtures:  every 12 hours  (~10 requests per run)           │
 * │    - Standings: once per day    (~10 requests per run)           │
 * │    - Completed: once per day    (~20 requests per run)           │
 * │  Total: ~40-50 requests/day, leaving headroom for manual calls.  │
 * │                                                                  │
 * │  To increase frequency, upgrade your API plan and set            │
 * │  API_BASKETBALL_DAILY_LIMIT in .env accordingly.                │
 * └──────────────────────────────────────────────────────────────────┘
 */

// ─── Sync Basketball Fixtures (upcoming) ────────────────────────────

export const syncBasketballFixturesTask = task({
  id: 'sync-basketball-fixtures',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { basketballService } = initServices();

    const budget = basketballService.getRemainingRequests();
    logger.info(
      `Syncing basketball fixtures (${budget.remaining}/${budget.limit} API requests remaining today)`,
    );

    if (budget.remaining < TRACKED_BASKETBALL_LEAGUES.length) {
      logger.warn(
        `Not enough API budget to sync all leagues. ` +
          `Need ~${TRACKED_BASKETBALL_LEAGUES.length}, have ${budget.remaining}. Skipping.`,
      );
      return { skipped: true, reason: 'insufficient_budget', budget };
    }

    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_BASKETBALL_LEAGUES) {
      try {
        const count = await basketballService.syncFixtures([leagueId]);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(
            `Basketball league ${leagueId}: ${count} fixtures synced`,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('daily limit exhausted')
        ) {
          logger.warn('Daily API limit reached, stopping sync early.');
          break;
        }
        failed++;
        logger.warn(
          `Basketball league ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const finalBudget = basketballService.getRemainingRequests();
    logger.info('Basketball fixtures sync complete', {
      totalProcessed,
      succeeded,
      failed,
      remainingBudget: finalBudget.remaining,
    });
    return { totalProcessed, succeeded, failed, budget: finalBudget };
  },
});

// ─── Sync Basketball Completed Fixtures (final scores) ──────────────

export const syncBasketballCompletedFixturesTask = task({
  id: 'sync-basketball-completed-fixtures',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { basketballService } = initServices();

    const budget = basketballService.getRemainingRequests();
    logger.info(
      `Syncing completed basketball fixtures (${budget.remaining}/${budget.limit} remaining)`,
    );

    if (budget.remaining < 5) {
      logger.warn('Not enough API budget for completed fixtures sync.');
      return { skipped: true, reason: 'insufficient_budget', budget };
    }

    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_BASKETBALL_LEAGUES) {
      try {
        const count = await basketballService.syncCompletedFixtures([leagueId]);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(
            `Basketball league ${leagueId}: ${count} completed fixtures synced`,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('daily limit exhausted')
        ) {
          logger.warn('Daily API limit reached, stopping sync early.');
          break;
        }
        failed++;
        logger.warn(
          `Basketball league ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const finalBudget = basketballService.getRemainingRequests();
    logger.info('Basketball completed fixtures sync done', {
      totalProcessed,
      succeeded,
      failed,
      remainingBudget: finalBudget.remaining,
    });
    return { totalProcessed, succeeded, failed, budget: finalBudget };
  },
});

// ─── Sync Basketball Standings ──────────────────────────────────────

export const syncBasketballStandingsTask = task({
  id: 'sync-basketball-standings',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { basketballService } = initServices();

    const budget = basketballService.getRemainingRequests();
    logger.info(
      `Syncing basketball standings (${budget.remaining}/${budget.limit} remaining)`,
    );

    if (budget.remaining < TRACKED_BASKETBALL_LEAGUES.length) {
      logger.warn('Not enough API budget for standings sync.');
      return { skipped: true, reason: 'insufficient_budget', budget };
    }

    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const leagueId of TRACKED_BASKETBALL_LEAGUES) {
      try {
        const count = await basketballService.syncStandings(leagueId);
        totalProcessed += count || 0;
        succeeded++;
        if (count > 0) {
          logger.info(
            `Basketball league ${leagueId}: ${count} standings synced`,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('daily limit exhausted')
        ) {
          logger.warn('Daily API limit reached, stopping sync early.');
          break;
        }
        failed++;
        logger.warn(
          `Basketball league ${leagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const finalBudget = basketballService.getRemainingRequests();
    logger.info('Basketball standings sync complete', {
      totalProcessed,
      succeeded,
      failed,
      remainingBudget: finalBudget.remaining,
    });
    return { totalProcessed, succeeded, failed, budget: finalBudget };
  },
});
