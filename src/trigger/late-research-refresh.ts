import { task, logger } from '@trigger.dev/sdk/v3';
import { generatePredictionTask } from './generate-prediction';
import { initServices } from './init';
import { eq, and, gte, lte, asc } from 'drizzle-orm';
import * as schema from '../database/schema';

/**
 * Re-generate predictions ~T-2h before kickoff to capture late-breaking
 * team news (lineup confirmations, late injuries, weather, motivational
 * shifts).
 *
 * Why this exists:
 *   - The daily prediction is generated up to 48h early — Perplexity
 *     research at that point can be hours out of date by kickoff.
 *   - The pre_match window is T-1h, which is too late for many sportsbooks
 *     and for Polymarket markets that move on team-news leaks 2–3h out.
 *   - The lineup-prediction task only fires when an actual lineup is
 *     available, missing news that doesn't manifest as a lineup change
 *     (manager press conferences, weather shifts, transfer rumours).
 *
 * Window: fixtures starting in 105–145 minutes (~T-2h ± 20min, the granularity
 * of the 15-minute schedule). Each fixture is refreshed at most once via the
 * `matchContext.lateRefreshed` flag — we don't want to keep re-running every
 * cycle. The existing prediction pipeline upserts on (fixtureId, predictionType)
 * so the refreshed prediction overwrites the prior pre_match version.
 *
 * Scheduled: every 15 minutes (see schedules.ts).
 */
export const lateResearchRefreshTask = task({
  id: 'late-research-refresh',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { db } = initServices();

    const now = new Date();
    // 105–145 minutes from now. The window must be at least as large as
    // the schedule's interval (15 min) plus a margin so a fixture can't
    // slip through. 40-min window is comfortable.
    const windowStart = new Date(now.getTime() + 105 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 145 * 60 * 1000);

    const fixtures = await db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, windowStart),
          lte(schema.fixtures.date, windowEnd),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    if (fixtures.length === 0) {
      return { checked: 0, refreshed: 0, skipped: 0, missingPreMatch: 0 };
    }

    logger.info(
      `Late-news refresh: checking ${fixtures.length} fixtures in T-2h window`,
    );

    const fixtureIdsToRefresh: number[] = [];
    let skippedAlreadyRefreshed = 0;
    let missingPreMatch = 0;

    for (const fixture of fixtures) {
      // Find the existing pre_match prediction (the slot that gets
      // upserted by the pipeline). If none exists, the pre_match
      // schedule will pick this fixture up at T-1h — we don't need to
      // pre-empt that here.
      const existing = await db
        .select({
          id: schema.predictions.id,
          matchContext: schema.predictions.matchContext,
        })
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, fixture.id),
            eq(schema.predictions.predictionType, 'pre_match'),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        missingPreMatch++;
        continue;
      }

      const ctx = existing[0].matchContext as Record<string, any> | null;
      if (ctx?.lateRefreshed === true) {
        skippedAlreadyRefreshed++;
        continue;
      }

      fixtureIdsToRefresh.push(fixture.id);
    }

    if (fixtureIdsToRefresh.length === 0) {
      logger.info(
        `Late-news refresh: nothing to do (${skippedAlreadyRefreshed} already refreshed, ${missingPreMatch} missing pre_match)`,
      );
      return {
        checked: fixtures.length,
        refreshed: 0,
        skipped: skippedAlreadyRefreshed,
        missingPreMatch,
      };
    }

    logger.info(
      `Late-news refresh: re-running ${fixtureIdsToRefresh.length} predictions`,
    );

    // Trigger generation in batch. The pipeline upserts on
    // (fixtureId, pre_match) so the late-refreshed version overwrites
    // the prior one. Pulling fresh Perplexity research is the whole
    // point — that happens automatically inside generatePrediction.
    const batchResult = await generatePredictionTask.batchTriggerAndWait(
      fixtureIdsToRefresh.map((fixtureId) => ({
        payload: { fixtureId, predictionType: 'pre_match' as const },
      })),
    );

    let refreshed = 0;
    let failed = 0;
    for (const run of batchResult.runs) {
      if (run.ok) refreshed++;
      else failed++;
    }

    // Mark each refreshed prediction so we don't re-run on the next cycle.
    // We do this AFTER generation so a failed run is naturally retried.
    for (let i = 0; i < batchResult.runs.length; i++) {
      const run = batchResult.runs[i];
      if (!run.ok) continue;
      const fixtureId = fixtureIdsToRefresh[i];
      try {
        // Read current matchContext, merge the flag, write back. We can't
        // do this inside the prediction pipeline cleanly because the
        // pipeline doesn't know whether it was triggered by the late
        // refresh or by another path — keeping the flag write here keeps
        // responsibilities split.
        const [row] = await db
          .select({ matchContext: schema.predictions.matchContext })
          .from(schema.predictions)
          .where(
            and(
              eq(schema.predictions.fixtureId, fixtureId),
              eq(schema.predictions.predictionType, 'pre_match'),
            ),
          )
          .limit(1);
        const ctx = (row?.matchContext as Record<string, any> | null) ?? {};
        ctx.lateRefreshed = true;
        ctx.lateRefreshedAt = new Date().toISOString();
        await db
          .update(schema.predictions)
          .set({ matchContext: ctx, updatedAt: new Date() })
          .where(
            and(
              eq(schema.predictions.fixtureId, fixtureId),
              eq(schema.predictions.predictionType, 'pre_match'),
            ),
          );
      } catch (err) {
        logger.warn(
          `Late-news refresh: failed to mark fixture ${fixtureId} as refreshed`,
          { error: (err as Error).message },
        );
      }
    }

    logger.info('Late-news refresh complete', {
      checked: fixtures.length,
      refreshed,
      failed,
      skipped: skippedAlreadyRefreshed,
      missingPreMatch,
    });

    return {
      checked: fixtures.length,
      refreshed,
      failed,
      skipped: skippedAlreadyRefreshed,
      missingPreMatch,
    };
  },
});
