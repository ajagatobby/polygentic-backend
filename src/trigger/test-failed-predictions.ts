import { task, logger } from '@trigger.dev/sdk/v3';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '../database/schema';
import { initServices } from './init';
import type { PredictionType } from '../agents/agents.service';

function getPredictedResultFromProbs(
  homeProb: number,
  drawProb: number,
  awayProb: number,
): 'home_win' | 'draw' | 'away_win' {
  const maxWinProb = Math.max(homeProb, awayProb);
  const teamsClose = Math.abs(homeProb - awayProb) < 0.1;

  if (drawProb >= homeProb && drawProb >= awayProb) return 'draw';

  if (maxWinProb < 0.45 && drawProb >= 0.26) return 'draw';
  if (
    maxWinProb >= 0.45 &&
    maxWinProb <= 0.55 &&
    drawProb >= 0.28 &&
    teamsClose
  ) {
    return 'draw';
  }

  return homeProb >= awayProb ? 'home_win' : 'away_win';
}

function calculateBrierScore(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  actualResult: string,
): number {
  const actual = {
    home_win: actualResult === 'home_win' ? 1 : 0,
    draw: actualResult === 'draw' ? 1 : 0,
    away_win: actualResult === 'away_win' ? 1 : 0,
  };

  return (
    ((homeProb - actual.home_win) ** 2 +
      (drawProb - actual.draw) ** 2 +
      (awayProb - actual.away_win) ** 2) /
    3
  );
}

/**
 * Re-runs currently failed resolved predictions and stores backtest outcomes
 * in prediction_tests for evaluation.
 */
export const testFailedPredictionsTask = task({
  id: 'test-failed-predictions',
  retry: {
    maxAttempts: 1,
  },
  run: async (payload?: {
    predictionType?: PredictionType;
    limit?: number;
    fixtureIds?: number[];
  }) => {
    const predictionType = payload?.predictionType ?? 'daily';
    const limit = Math.min(Math.max(payload?.limit ?? 20, 1), 200);
    const fixtureIds = payload?.fixtureIds ?? [];

    const { db, agentsService } = initServices();

    const whereConditions: any[] = [
      eq(schema.predictions.predictionStatus, 'resolved'),
      eq(schema.predictions.predictionType, predictionType),
      eq(schema.predictions.wasCorrect, false),
      isNotNull(schema.predictions.actualResult),
    ];

    if (fixtureIds.length > 0) {
      whereConditions.push(inArray(schema.predictions.fixtureId, fixtureIds));
    }

    const failedPredictions = await db
      .select()
      .from(schema.predictions)
      .where(and(...whereConditions))
      .orderBy(desc(schema.predictions.resolvedAt), asc(schema.predictions.id))
      .limit(limit);

    logger.info('Loaded failed predictions for testing', {
      predictionType,
      count: failedPredictions.length,
      limit,
    });

    let tested = 0;
    let improved = 0;
    let stillWrong = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const baseline of failedPredictions) {
      try {
        const fixtureId = baseline.fixtureId;
        const actualResult = baseline.actualResult;
        if (!actualResult) {
          failed++;
          errors.push(`Prediction ${baseline.id} has null actualResult`);
          continue;
        }

        // Re-run prediction for the same fixture and slot (upsert updates row)
        await agentsService.generatePrediction(fixtureId, predictionType);

        const updatedRows = await db
          .select()
          .from(schema.predictions)
          .where(
            and(
              eq(schema.predictions.fixtureId, fixtureId),
              eq(schema.predictions.predictionType, predictionType),
            ),
          )
          .limit(1);

        const retest = updatedRows[0];
        if (!retest) {
          failed++;
          errors.push(`No retest prediction found for fixture ${fixtureId}`);
          continue;
        }

        const retestHome = Number(retest.homeWinProb);
        const retestDraw = Number(retest.drawProb);
        const retestAway = Number(retest.awayWinProb);

        const retestPredictedResult =
          (retest.predictedResult as 'home_win' | 'draw' | 'away_win' | null) ??
          getPredictedResultFromProbs(retestHome, retestDraw, retestAway);

        const retestWasCorrect = retestPredictedResult === actualResult;
        const retestBrier = calculateBrierScore(
          retestHome,
          retestDraw,
          retestAway,
          actualResult,
        );

        const baselineBrier =
          baseline.probabilityAccuracy != null
            ? Number(baseline.probabilityAccuracy)
            : calculateBrierScore(
                Number(baseline.homeWinProb),
                Number(baseline.drawProb),
                Number(baseline.awayWinProb),
                actualResult,
              );

        const isImproved =
          retestWasCorrect ||
          (!retestWasCorrect && Number(retestBrier.toFixed(6)) < baselineBrier);

        await db.insert(schema.predictionTests).values({
          fixtureId,
          predictionType,
          baselinePredictionId: baseline.id,
          retestPredictionId: retest.id,
          actualResult,

          baselinePredictedResult: baseline.predictedResult,
          baselineWasCorrect: baseline.wasCorrect,
          baselineHomeWinProb: baseline.homeWinProb,
          baselineDrawProb: baseline.drawProb,
          baselineAwayWinProb: baseline.awayWinProb,
          baselineBrier: String(Number(baselineBrier.toFixed(6))),

          retestPredictedResult,
          retestWasCorrect,
          retestHomeWinProb: retest.homeWinProb,
          retestDrawProb: retest.drawProb,
          retestAwayWinProb: retest.awayWinProb,
          retestBrier: String(Number(retestBrier.toFixed(6))),

          improved: isImproved,
          runStatus: 'completed',
          createdAt: new Date(),
        });

        tested++;
        if (isImproved) improved++;
        if (!retestWasCorrect) stillWrong++;
      } catch (error) {
        failed++;
        const message = `Fixture ${baseline.fixtureId} failed: ${error.message}`;
        errors.push(message);

        await db.insert(schema.predictionTests).values({
          fixtureId: baseline.fixtureId,
          predictionType,
          baselinePredictionId: baseline.id,
          retestPredictionId: null,
          actualResult: baseline.actualResult ?? 'draw',
          baselinePredictedResult: baseline.predictedResult,
          baselineWasCorrect: baseline.wasCorrect,
          baselineHomeWinProb: baseline.homeWinProb,
          baselineDrawProb: baseline.drawProb,
          baselineAwayWinProb: baseline.awayWinProb,
          baselineBrier: baseline.probabilityAccuracy,
          runStatus: 'failed',
          errorMessage: message,
          createdAt: new Date(),
        });
      }
    }

    logger.info('Failed prediction testing complete', {
      predictionType,
      tested,
      improved,
      stillWrong,
      failed,
      total: failedPredictions.length,
    });

    return {
      predictionType,
      total: failedPredictions.length,
      tested,
      improved,
      stillWrong,
      failed,
      errors,
    };
  },
});
