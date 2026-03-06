import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Polymarket Scan — Full trading agent cycle:
 *   1. Discover soccer markets on Polymarket (Gamma API)
 *   2. Match markets to internal fixtures with predictions
 *   3. Fetch CLOB pricing for matched markets
 *   4. Identify value opportunities (edge > threshold)
 *   5. Run Claude trading agent on each candidate
 *   6. Place paper trades (or live trades if enabled)
 *   7. Update bankroll state
 *
 * Typically runs every 30 minutes via scheduler.
 */
export const polymarketScanTask = task({
  id: 'polymarket-scan',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    logger.info('Starting Polymarket scan cycle');

    const { polymarketService } = initServices();

    const result = await polymarketService.runScanCycle();

    logger.info('Polymarket scan cycle complete', {
      marketsFound: result.marketsFound,
      marketsMatched: result.marketsMatched,
      candidatesEvaluated: result.candidatesEvaluated,
      tradesPlaced: result.tradesPlaced,
      tradesSkipped: result.tradesSkipped,
      errors: result.errors.length,
    });

    return result;
  },
});

/**
 * Resolve completed Polymarket trades after fixtures finish.
 * Called as part of the sync-and-resolve flow.
 */
export const polymarketResolveTask = task({
  id: 'polymarket-resolve-trades',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3_000,
    maxTimeoutInMs: 15_000,
    factor: 2,
  },
  run: async () => {
    logger.info('Resolving completed Polymarket trades');

    const { polymarketService } = initServices();

    const result = await polymarketService.resolveCompletedTrades();

    logger.info('Polymarket trade resolution complete', {
      resolved: result.resolved,
      errors: result.errors.length,
    });

    return result;
  },
});
