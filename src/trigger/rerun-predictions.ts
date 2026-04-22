import { task, logger } from '@trigger.dev/sdk/v3';
import { generatePredictionTask } from './generate-prediction';
import { initServices } from './init';
import { eq, and, gte, lte, asc, inArray } from 'drizzle-orm';
import * as schema from '../database/schema';
import type { PredictionType } from '../agents/agents.service';

/**
 * Re-run predictions for all fixtures on a given date.
 *
 * Unlike the daily generation task, this does NOT skip fixtures that
 * already have predictions — it deliberately overwrites them via the
 * existing upsert behaviour in storePrediction().
 *
 * Before re-generating, it clears resolution data (resolvedAt, wasCorrect, etc.)
 * on any existing predictions for the targeted fixtures so the re-run
 * starts clean.
 *
 * Payload:
 *   date           — YYYY-MM-DD string (required)
 *   predictionType — which prediction slot to overwrite (default: 'daily')
 *   fixtureIds     — optional array; if provided, only re-run these fixtures
 *                    (must still fall within the given date)
 */
export const rerunPredictionsTask = task({
  id: 'rerun-predictions-for-date',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
  },
  run: async (payload: {
    date: string;
    predictionType?: PredictionType;
    fixtureIds?: number[];
  }) => {
    const { date, predictionType = 'daily', fixtureIds } = payload;
    const { db } = initServices();

    const startOfDay = new Date(`${date}T00:00:00Z`);
    const endOfDay = new Date(`${date}T23:59:59Z`);

    // 1. Find fixtures on the given date
    const conditions = [
      gte(schema.fixtures.date, startOfDay),
      lte(schema.fixtures.date, endOfDay),
    ];

    // If specific fixture IDs were provided, scope to those
    if (fixtureIds && fixtureIds.length > 0) {
      conditions.push(inArray(schema.fixtures.id, fixtureIds));
    }

    const fixtures = await db
      .select({ id: schema.fixtures.id })
      .from(schema.fixtures)
      .where(and(...conditions))
      .orderBy(asc(schema.fixtures.date));

    logger.info(`Re-run: found ${fixtures.length} fixtures on ${date}`, {
      predictionType,
      scopedFixtureIds: fixtureIds?.length ?? 'all',
    });

    if (fixtures.length === 0) {
      return { rerun: 0, failed: 0, total: 0, date };
    }

    const targetFixtureIds = fixtures.map((f) => f.id);

    // 2. Clear resolution data on existing predictions so they re-enter
    //    the unresolved state after the new prediction is upserted
    const cleared = await db
      .update(schema.predictions)
      .set({
        resolvedAt: null,
        actualHomeGoals: null,
        actualAwayGoals: null,
        actualResult: null,
        predictedResult: null,
        wasCorrect: null,
        probabilityAccuracy: null,
        predictionStatus: 'pending',
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(schema.predictions.fixtureId, targetFixtureIds),
          eq(schema.predictions.predictionType, predictionType),
        ),
      )
      .returning({ id: schema.predictions.id });

    if (cleared.length > 0) {
      logger.info(
        `Cleared resolution data on ${cleared.length} existing predictions`,
      );
    }

    // 3. Fan out individual prediction tasks (upsert will overwrite)
    const batchResult = await generatePredictionTask.batchTriggerAndWait(
      targetFixtureIds.map((fixtureId) => ({
        payload: { fixtureId, predictionType },
      })),
    );

    let rerun = 0;
    let failed = 0;

    for (const run of batchResult.runs) {
      if (run.ok) {
        rerun++;
      } else {
        failed++;
        logger.error('Re-run prediction failed', { taskRunId: run.id });
      }
    }

    logger.info('Re-run predictions complete', {
      date,
      predictionType,
      rerun,
      failed,
      total: targetFixtureIds.length,
    });

    return { rerun, failed, total: targetFixtureIds.length, date };
  },
});
