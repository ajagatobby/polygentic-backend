import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Copy-Trader Sync — poll every active followed Polymarket wallet,
 * diff against our stored position snapshot, and (if copy_enabled)
 * auto-place matching CLOB orders.
 *
 * Runs every ~5-10 minutes via the scheduler. Idempotent: running
 * twice without new trades is a no-op except for last_seen_at bumps.
 */
export const copyTraderSyncTask = task({
  id: 'copy-trader-sync',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    logger.info('Starting copy-trader sync');

    const { copyTraderService } = initServices();

    const result = await copyTraderService.sync();

    logger.info('Copy-trader sync complete', {
      scanned: result.scanned,
      newTradesDetected: result.newTradesDetected,
      executed: result.executed,
      paper: result.paper,
      skipped: result.skipped,
      failed: result.failed,
      durationMs: result.durationMs,
    });

    return result;
  },
});
