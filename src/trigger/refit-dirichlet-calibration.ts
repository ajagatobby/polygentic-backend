import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';

/**
 * Refit the Dirichlet calibration parameters from the latest set of
 * resolved predictions.
 *
 * Dirichlet calibration is the native-multiclass alternative to the
 * per-outcome isotonic mapping. See `dirichlet-calibration.service.ts`
 * for the math. The trigger mirrors the cadence of the legacy isotonic
 * refit — both can run side by side until we've confirmed Dirichlet
 * dominates, at which point the isotonic trigger can be retired.
 *
 * No-op when fewer than 200 resolved predictions exist globally.
 */
export const refitDirichletCalibrationTask = task({
  id: 'refit-dirichlet-calibration',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
  },
  run: async () => {
    const { dirichletCalibrationService } = initServices();
    const result = await dirichletCalibrationService.refit();
    logger.info('Dirichlet calibration refit complete', {
      fittedAt: result.fittedAt,
      scopesFitted: result.summaries.length,
      scopesSkipped: result.skipped.length,
      sampleSummary: result.summaries.map((s) => ({
        scope: s.scope,
        n: s.sampleSize,
        loss: Number(s.finalLoss.toFixed(4)),
        shift: s.paramShift,
      })),
    });
    return result;
  },
});
