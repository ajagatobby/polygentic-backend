import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Sync recently completed fixtures then resolve predictions.
 *
 * This is a chained workflow:
 *   Step 1: Fetch fixtures from the last 2 days via API-Football
 *           (updates status to FT, populates goalsHome/goalsAway)
 *   Step 2: Resolve all unresolved predictions whose fixtures are now FT
 *           (computes actualResult, wasCorrect, Brier score, etc.)
 *
 * Each step must complete before the next starts — if the fixture sync
 * fails, we still want to attempt resolution with whatever data we have.
 *
 * Scheduled: Every hour
 */
export const syncCompletedFixturesAndResolveTask = task({
  id: 'sync-completed-fixtures-and-resolve',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { syncService, agentsService } = initServices();

    // Step 1: Sync completed fixtures
    logger.info('Step 1: Syncing completed fixtures...');
    let fixturesSynced = 0;
    try {
      await syncService.syncCompletedFixtures();
      logger.info('Completed fixtures sync finished');
    } catch (error) {
      logger.error('Completed fixtures sync failed, proceeding to resolve', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 2: Resolve predictions
    logger.info('Step 2: Resolving predictions for finished matches...');
    const resolveResult = await agentsService.resolvePredictions();

    logger.info('Sync and resolve workflow complete', {
      resolved: resolveResult.resolved,
      errors: resolveResult.errors.length,
    });

    if (resolveResult.errors.length > 0) {
      logger.warn('Resolution errors', { errors: resolveResult.errors });
    }

    return {
      fixturesSynced,
      predictionsResolved: resolveResult.resolved,
      resolveErrors: resolveResult.errors,
    };
  },
});

/**
 * Standalone task to resolve predictions only (without syncing fixtures first).
 * Useful for manual triggers when you know fixture data is already up to date.
 */
export const resolvePredictionsTask = task({
  id: 'resolve-predictions',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3_000,
    maxTimeoutInMs: 15_000,
    factor: 2,
  },
  run: async () => {
    const { agentsService } = initServices();

    logger.info('Resolving predictions...');
    const result = await agentsService.resolvePredictions();

    logger.info('Prediction resolution complete', {
      resolved: result.resolved,
      errors: result.errors.length,
    });

    return result;
  },
});
