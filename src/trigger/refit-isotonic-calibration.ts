import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Refit the isotonic calibration mappings from the latest set of
 * resolved predictions.
 *
 * Cheap to run (one DB read + ≤ 50 small UPSERTs per scope), so the
 * weekly cadence is conservative. We could increase this later — but
 * isotonic mappings shift slowly, and refitting too often risks chasing
 * sample noise on smaller leagues.
 *
 * The fitter is a no-op when fewer than 200 resolved predictions exist
 * globally; until then this task just logs the gap.
 */
export const refitIsotonicCalibrationTask = task({
  id: 'refit-isotonic-calibration',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
  },
  run: async () => {
    const { isotonicCalibrationService } = initServices();
    const result = await isotonicCalibrationService.refit();
    logger.info('Isotonic calibration refit complete', {
      fittedAt: result.fittedAt,
      mappingsPersisted: result.summaries.length,
      scopesSkipped: result.skipped.length,
    });
    return result;
  },
});
