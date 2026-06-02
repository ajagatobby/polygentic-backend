import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Combined refit job for the pi-rating ratings + mapping AND the
 * meta-blender weights. They're co-scheduled because the meta-blender's
 * `pi_rating` slot uses the freshly-fitted ordered-logit mapping, so
 * running them out of order would feed the meta-blender stale pi-rating
 * probabilities.
 *
 * Order: pi-ratings refit (replays all FT fixtures) → meta-blender refit.
 * Cheap to run; weekly cadence matches the isotonic refit.
 */
export const refitPiRatingsMetaBlenderTask = task({
  id: 'refit-pi-ratings-meta-blender',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 180_000,
    factor: 2,
  },
  run: async () => {
    const { piRatingService, metaBlenderService } = initServices();

    logger.info('Pi-rating refit starting…');
    const pi = await piRatingService.refit();
    logger.info('Pi-rating refit complete', {
      ratingsUpdated: pi.ratingsUpdated,
      fixturesReplayed: pi.totalMatchesProcessed,
      mappingsFitted: pi.mappingsFitted,
      globalSampleSize: pi.globalMappingSampleSize,
    });

    logger.info('Meta-blender refit starting…');
    const mb = await metaBlenderService.refit();
    logger.info('Meta-blender refit complete', {
      fittedAt: mb.fittedAt,
      scopesFitted: mb.summaries.length,
      scopesSkipped: mb.skipped.length,
      globalSummary: mb.summaries.find((s) => s.scope === 'global') ?? null,
    });

    return { piRatings: pi, metaBlender: mb };
  },
});
