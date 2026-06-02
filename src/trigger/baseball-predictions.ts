import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Generate daily MLB run-total predictions for upcoming games (next 48h)
 * that don't yet have one.
 */
export const baseballGeneratePredictionsTask = task({
  id: 'baseball-generate-predictions',
  retry: { maxAttempts: 1 },
  run: async () => {
    const s = initServices();
    await s.baseballTeamMap.init();
    const result = await s.baseballPredictionService.generateForUpcoming(
      48,
      'daily',
    );
    logger.info('baseball-generate-predictions complete', result);
    return result;
  },
});

/**
 * Pre-game refresh (~T-90m): re-run predictions for games starting soon so
 * we capture confirmed probables / late lineup + weather news. Overwrites
 * the existing row (pre_game type).
 */
export const baseballPreGameRefreshTask = task({
  id: 'baseball-pre-game-refresh',
  retry: { maxAttempts: 1 },
  run: async () => {
    const s = initServices();
    await s.baseballTeamMap.init();
    const soon = await s.baseballService.getUpcomingGames(3);
    let refreshed = 0;
    for (const g of soon) {
      try {
        await s.baseballPredictionService.generatePrediction(g.id, 'pre_game');
        refreshed++;
      } catch (err) {
        logger.error(`pre-game refresh failed for ${g.id}`, {
          error: (err as Error).message,
        });
      }
    }
    logger.info('baseball-pre-game-refresh complete', { refreshed });
    return { refreshed };
  },
});

/** Resolve completed/void MLB predictions and score Brier. */
export const baseballResolvePredictionsTask = task({
  id: 'baseball-resolve-predictions',
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async () => {
    const s = initServices();
    await s.baseballTeamMap.init();
    await s.baseballService.syncCompletedGames();
    const result = await s.baseballPredictionService.resolvePredictions();
    logger.info('baseball-resolve-predictions complete', result);
    return result;
  },
});
