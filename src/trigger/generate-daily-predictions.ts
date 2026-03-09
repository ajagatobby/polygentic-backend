import { task, logger } from '@trigger.dev/sdk/v3';
import { generatePredictionTask } from './generate-prediction';
import { initServices } from './init';
import { eq, and, gte, lte, asc, sql } from 'drizzle-orm';
import * as schema from '../database/schema';

/**
 * Generate predictions for all upcoming fixtures in the next 48 hours.
 *
 * This task:
 *  1. Queries the DB for upcoming fixtures (status=NS, within 48h)
 *  2. Filters out fixtures that already have a daily prediction
 *  3. Fans out individual generatePredictionTask runs via batchTriggerAndWait
 *
 * Using batchTriggerAndWait means each fixture gets its own isolated run
 * with independent retries, and we get a summary of all results at the end.
 *
 * Scheduled: Daily at 6 AM UTC
 */
export const generateDailyPredictionsTask = task({
  id: 'generate-daily-predictions',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
  },
  run: async () => {
    const { db } = initServices();

    const now = new Date();
    const cutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    // Get upcoming fixtures
    const upcomingFixtures = await db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, now),
          lte(schema.fixtures.date, cutoff),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    logger.info(`Found ${upcomingFixtures.length} upcoming fixtures`);

    if (upcomingFixtures.length === 0) {
      return { generated: 0, skipped: 0, failed: 0 };
    }

    // Filter out fixtures that already have daily predictions
    const fixtureIdsToGenerate: number[] = [];

    for (const fixture of upcomingFixtures) {
      const existing = await db
        .select({ id: schema.predictions.id })
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, fixture.id),
            eq(schema.predictions.predictionType, 'daily'),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        fixtureIdsToGenerate.push(fixture.id);
      }
    }

    const skipped = upcomingFixtures.length - fixtureIdsToGenerate.length;
    logger.info(
      `${fixtureIdsToGenerate.length} fixtures need predictions, ${skipped} already have daily predictions`,
    );

    if (fixtureIdsToGenerate.length === 0) {
      return { generated: 0, skipped, failed: 0 };
    }

    // Fan out individual prediction tasks
    const batchResult = await generatePredictionTask.batchTriggerAndWait(
      fixtureIdsToGenerate.map((fixtureId) => ({
        payload: { fixtureId, predictionType: 'daily' as const },
      })),
    );

    let generated = 0;
    let failed = 0;

    for (const run of batchResult.runs) {
      if (run.ok) {
        generated++;
      } else {
        failed++;
        logger.error('Prediction run failed', {
          taskRunId: run.id,
        });
      }
    }

    logger.info('Daily predictions batch complete', {
      generated,
      skipped,
      failed,
    });

    return { generated, skipped, failed };
  },
});

/**
 * Generate pre-match predictions for fixtures starting within 1 hour.
 *
 * Scheduled: Every 15 minutes
 */
export const generatePreMatchPredictionsTask = task({
  id: 'generate-pre-match-predictions',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { db } = initServices();

    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    const fixtures = await db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, now),
          lte(schema.fixtures.date, oneHourFromNow),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    logger.info(`Found ${fixtures.length} fixtures within 1 hour`);

    if (fixtures.length === 0) {
      return { generated: 0, skipped: 0, failed: 0 };
    }

    // Filter out fixtures with existing pre_match predictions
    const fixtureIdsToGenerate: number[] = [];

    for (const fixture of fixtures) {
      const existing = await db
        .select({ id: schema.predictions.id })
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, fixture.id),
            eq(schema.predictions.predictionType, 'pre_match'),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        fixtureIdsToGenerate.push(fixture.id);
      }
    }

    const skipped = fixtures.length - fixtureIdsToGenerate.length;

    if (fixtureIdsToGenerate.length === 0) {
      return { generated: 0, skipped, failed: 0 };
    }

    const batchResult = await generatePredictionTask.batchTriggerAndWait(
      fixtureIdsToGenerate.map((fixtureId) => ({
        payload: { fixtureId, predictionType: 'pre_match' as const },
      })),
    );

    let generated = 0;
    let failed = 0;

    for (const run of batchResult.runs) {
      if (run.ok) {
        generated++;
      } else {
        failed++;
        logger.error('Pre-match prediction run failed', {
          taskRunId: run.id,
        });
      }
    }

    if (generated > 0) {
      logger.info('Pre-match predictions complete', {
        generated,
        skipped,
        failed,
      });
    }

    return { generated, skipped, failed };
  },
});

/**
 * Generate predictions for TODAY's fixtures only.
 *
 * This task:
 *  1. Queries the DB for fixtures scheduled today (status=NS, date between start and end of today UTC)
 *  2. Optionally skips fixtures that already have a daily prediction (controlled by `force` flag)
 *  3. Fans out individual generatePredictionTask runs via batchTriggerAndWait
 *
 * Not scheduled — triggered manually via POST /api/predictions/generate-today
 */
export const generateTodayPredictionsTask = task({
  id: 'generate-today-predictions',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
  },
  run: async (payload: { force?: boolean }) => {
    const { db } = initServices();
    const force = payload?.force ?? false;

    // Calculate today's date boundaries in UTC
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // Get all of today's fixtures (NS = Not Started)
    const todayFixtures = await db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, todayStart),
          lte(schema.fixtures.date, todayEnd),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    logger.info(
      `Found ${todayFixtures.length} fixtures scheduled for today (${todayStart.toISOString().split('T')[0]})`,
    );

    if (todayFixtures.length === 0) {
      return {
        date: todayStart.toISOString().split('T')[0],
        total: 0,
        generated: 0,
        skipped: 0,
        failed: 0,
      };
    }

    // Filter out fixtures that already have daily predictions (unless force=true)
    const fixtureIdsToGenerate: number[] = [];
    let skipped = 0;

    if (force) {
      fixtureIdsToGenerate.push(...todayFixtures.map((f) => f.id));
      logger.info(
        `Force mode: generating predictions for all ${fixtureIdsToGenerate.length} fixtures`,
      );
    } else {
      for (const fixture of todayFixtures) {
        const existing = await db
          .select({ id: schema.predictions.id })
          .from(schema.predictions)
          .where(
            and(
              eq(schema.predictions.fixtureId, fixture.id),
              eq(schema.predictions.predictionType, 'daily'),
            ),
          )
          .limit(1);

        if (existing.length === 0) {
          fixtureIdsToGenerate.push(fixture.id);
        } else {
          skipped++;
        }
      }

      logger.info(
        `${fixtureIdsToGenerate.length} fixtures need predictions, ${skipped} already have daily predictions`,
      );
    }

    if (fixtureIdsToGenerate.length === 0) {
      return {
        date: todayStart.toISOString().split('T')[0],
        total: todayFixtures.length,
        generated: 0,
        skipped,
        failed: 0,
      };
    }

    // Fan out individual prediction tasks
    const batchResult = await generatePredictionTask.batchTriggerAndWait(
      fixtureIdsToGenerate.map((fixtureId) => ({
        payload: { fixtureId, predictionType: 'daily' as const },
      })),
    );

    let generated = 0;
    let failed = 0;

    for (const run of batchResult.runs) {
      if (run.ok) {
        generated++;
      } else {
        failed++;
        logger.error('Today prediction run failed', { taskRunId: run.id });
      }
    }

    logger.info('Today predictions batch complete', {
      date: todayStart.toISOString().split('T')[0],
      total: todayFixtures.length,
      generated,
      skipped,
      failed,
    });

    return {
      date: todayStart.toISOString().split('T')[0],
      total: todayFixtures.length,
      generated,
      skipped,
      failed,
    };
  },
});
