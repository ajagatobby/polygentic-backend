import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Sync MLB games (schedule + scores) and snapshot sharp market totals.
 * Runs a few times a day to catch schedule shifts and late scratches.
 */
export const baseballSyncGamesTask = task({
  id: 'baseball-sync-games',
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async () => {
    const s = initServices();
    await s.baseballTeamMap.init();
    const games = await s.baseballService.syncGames();
    const market = await s.baseballMarketService.syncMarketTotals();
    logger.info('baseball-sync-games complete', { games, market });
    return { games, market };
  },
});

/** Sweep completed games (last 2 days) to capture final scores. */
export const baseballSyncResultsTask = task({
  id: 'baseball-sync-results',
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async () => {
    const s = initServices();
    await s.baseballTeamMap.init();
    const upserted = await s.baseballService.syncCompletedGames();
    logger.info('baseball-sync-results complete', { upserted });
    return { upserted };
  },
});

/** Refresh Statcast pitcher + team-batting caches (daily). */
export const baseballRefreshStatcastTask = task({
  id: 'baseball-refresh-statcast',
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000, factor: 2 },
  run: async () => {
    const s = initServices();
    await s.baseballTeamMap.init();
    const pitchers = await s.statcastService.refreshPitcherExpectedStats();
    const teams = await s.statcastService.refreshTeamBatting();
    logger.info('baseball-refresh-statcast complete', { pitchers, teams });
    return { pitchers, teams };
  },
});
