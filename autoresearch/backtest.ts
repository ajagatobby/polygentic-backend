/**
 * Autoresearch Backtester
 * =======================
 * This is the FIXED evaluation harness. DO NOT MODIFY.
 *
 * It reads resolved predictions from the database, re-applies the
 * calibration/result-logic pipeline using the current experiment-config.ts,
 * and reports metrics (Brier score, accuracy, calibration).
 *
 * The stored probabilities in the DB are the FINAL ensemble output.
 * We re-run the post-ensemble calibration (draw floors, dampening,
 * overconfidence caps) and result-prediction logic with different config
 * parameters to see if the output improves.
 *
 * Usage: npx ts-node -r tsconfig-paths/register autoresearch/backtest.ts
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { eq, and, isNotNull, desc, sql } from 'drizzle-orm';
import { EXPERIMENT_CONFIG, type ExperimentConfig } from './experiment-config';

// ─── Database Connection (matches trigger/init.ts pattern) ────────────

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const client = (postgres as any)(DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

const db = drizzle(client, { schema });

// ─── Calibration Logic (mirrors agents.service.ts) ────────────────────

function applyDrawFloor(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  config: ExperimentConfig,
): { homeWinProb: number; drawProb: number; awayWinProb: number } {
  const c = config.drawCalibration;

  const dominantProb = Math.max(homeProb, awayProb);
  let drawFloor: number;
  if (dominantProb < c.tier1Threshold) {
    drawFloor = c.tier1Floor;
  } else if (dominantProb < c.tier2Threshold) {
    drawFloor = c.tier2Floor;
  } else {
    drawFloor = c.tier3Floor;
  }

  if (drawProb < drawFloor) {
    const drawBoost = (drawFloor - drawProb) * c.gapClosureFactor;
    drawProb += drawBoost;
    const homeShare = homeProb / (homeProb + awayProb || 1);
    homeProb -= drawBoost * homeShare;
    awayProb -= drawBoost * (1 - homeShare);

    const total = homeProb + drawProb + awayProb;
    homeProb /= total;
    drawProb /= total;
    awayProb /= total;
  }

  return { homeWinProb: homeProb, drawProb, awayWinProb: awayProb };
}

function applyCompetitiveDampening(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  config: ExperimentConfig,
): { homeWinProb: number; drawProb: number; awayWinProb: number } {
  const c = config.competitiveDampening;
  const maxProb = Math.max(homeProb, drawProb, awayProb);

  if (maxProb < c.upperThreshold && maxProb > c.lowerThreshold) {
    const mean = 1 / 3;
    homeProb = homeProb * c.dampeningFactor + mean * (1 - c.dampeningFactor);
    drawProb = drawProb * c.dampeningFactor + mean * (1 - c.dampeningFactor);
    awayProb = awayProb * c.dampeningFactor + mean * (1 - c.dampeningFactor);

    const total = homeProb + drawProb + awayProb;
    homeProb /= total;
    drawProb /= total;
    awayProb /= total;
  }

  return { homeWinProb: homeProb, drawProb, awayWinProb: awayProb };
}

function applyOverconfidenceDampening(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  config: ExperimentConfig,
): { homeWinProb: number; drawProb: number; awayWinProb: number } {
  const c = config.overconfidence;
  const maxProb = Math.max(homeProb, drawProb, awayProb);

  if (maxProb > c.threshold) {
    const mean = 1 / 3;
    homeProb = homeProb * c.dampeningFactor + mean * (1 - c.dampeningFactor);
    drawProb = drawProb * c.dampeningFactor + mean * (1 - c.dampeningFactor);
    awayProb = awayProb * c.dampeningFactor + mean * (1 - c.dampeningFactor);

    const total = homeProb + drawProb + awayProb;
    homeProb /= total;
    drawProb /= total;
    awayProb /= total;
  }

  return { homeWinProb: homeProb, drawProb, awayWinProb: awayProb };
}

/**
 * Apply the full post-ensemble calibration pipeline.
 * Mirrors the exact order in agents.service.ts ensemblePredictions().
 */
function calibrateProbabilities(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  config: ExperimentConfig,
): { homeWinProb: number; drawProb: number; awayWinProb: number } {
  let result = applyDrawFloor(homeProb, drawProb, awayProb, config);
  result = applyCompetitiveDampening(
    result.homeWinProb,
    result.drawProb,
    result.awayWinProb,
    config,
  );
  result = applyOverconfidenceDampening(
    result.homeWinProb,
    result.drawProb,
    result.awayWinProb,
    config,
  );
  return result;
}

/**
 * Determine the predicted result from probabilities.
 * Mirrors getPredictedResultFromProbs() in agents.service.ts.
 */
function getPredictedResult(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  config: ExperimentConfig,
): string {
  const c = config.resultLogic;

  // 1. If draw is already the highest probability, always predict draw
  if (drawProb >= homeProb && drawProb >= awayProb) {
    return 'draw';
  }

  const maxWinProb = Math.max(homeProb, awayProb);
  const winSpread = Math.abs(homeProb - awayProb);

  // 2. Very tight match
  if (
    maxWinProb < c.veryTightThreshold &&
    drawProb >= c.veryTightDrawFloor &&
    maxWinProb - drawProb < c.veryTightLeaderGap
  ) {
    return 'draw';
  }

  // 3. Competitive match
  if (
    maxWinProb <= c.competitiveThreshold &&
    winSpread < c.competitiveSpreadMax &&
    drawProb >= c.competitiveDrawFloor
  ) {
    return 'draw';
  }

  // 4. Pick the higher of home or away
  if (homeProb >= awayProb) return 'home_win';
  return 'away_win';
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
    Math.pow(homeProb - actual.home_win, 2) +
    Math.pow(drawProb - actual.draw, 2) +
    Math.pow(awayProb - actual.away_win, 2)
  );
}

// ─── Main Backtest ────────────────────────────────────────────────────

async function runBacktest(config: ExperimentConfig) {
  // Fetch all resolved predictions
  const rows = await db
    .select({
      prediction: schema.predictions,
    })
    .from(schema.predictions)
    .where(
      and(
        isNotNull(schema.predictions.resolvedAt),
        eq(schema.predictions.predictionStatus, 'resolved'),
      ),
    )
    .orderBy(desc(schema.predictions.resolvedAt));

  if (rows.length === 0) {
    console.error('No resolved predictions found. Cannot backtest.');
    process.exit(1);
  }

  let totalBrier = 0;
  let totalStoredBrier = 0;
  let totalCorrect = 0;
  let totalConfidence = 0;
  let confidenceCount = 0;
  let validCount = 0;

  const byResult = {
    home_win: { predicted: 0, correct: 0, accuracy: 0 },
    draw: { predicted: 0, correct: 0, accuracy: 0 },
    away_win: { predicted: 0, correct: 0, accuracy: 0 },
  };

  const actualCounts = { home_win: 0, draw: 0, away_win: 0 };

  // Calibration tracking: avg prob assigned when outcome actually occurs
  let totalHomeProbWhenHome = 0;
  let countHomeActual = 0;
  let totalDrawProbWhenDraw = 0;
  let countDrawActual = 0;
  let totalAwayProbWhenAway = 0;
  let countAwayActual = 0;

  for (const { prediction } of rows) {
    const storedHomeProb = Number(prediction.homeWinProb);
    const storedDrawProb = Number(prediction.drawProb);
    const storedAwayProb = Number(prediction.awayWinProb);
    const actualResult = prediction.actualResult as string;

    if (
      !actualResult ||
      !['home_win', 'draw', 'away_win'].includes(actualResult)
    ) {
      continue;
    }

    validCount++;

    // Apply calibration pipeline with experiment config
    const calibrated = calibrateProbabilities(
      storedHomeProb,
      storedDrawProb,
      storedAwayProb,
      config,
    );

    // Determine predicted result using experiment config
    const predictedResult = getPredictedResult(
      calibrated.homeWinProb,
      calibrated.drawProb,
      calibrated.awayWinProb,
      config,
    );

    const wasCorrect = predictedResult === actualResult;
    if (wasCorrect) totalCorrect++;

    // Track by predicted result
    if (
      predictedResult === 'home_win' ||
      predictedResult === 'draw' ||
      predictedResult === 'away_win'
    ) {
      byResult[predictedResult].predicted++;
      if (wasCorrect) byResult[predictedResult].correct++;
    }

    // Track actual results
    if (
      actualResult === 'home_win' ||
      actualResult === 'draw' ||
      actualResult === 'away_win'
    ) {
      actualCounts[actualResult]++;
    }

    // Brier score with calibrated probabilities
    const brier = calculateBrierScore(
      calibrated.homeWinProb,
      calibrated.drawProb,
      calibrated.awayWinProb,
      actualResult,
    );
    totalBrier += brier;

    // Stored Brier for comparison
    const storedBrier = Number(prediction.probabilityAccuracy) || 0;
    totalStoredBrier += storedBrier;

    // Confidence tracking
    if (prediction.confidence != null) {
      totalConfidence += prediction.confidence;
      confidenceCount++;
    }

    // Calibration tracking
    if (actualResult === 'home_win') {
      totalHomeProbWhenHome += calibrated.homeWinProb;
      countHomeActual++;
    } else if (actualResult === 'draw') {
      totalDrawProbWhenDraw += calibrated.drawProb;
      countDrawActual++;
    } else if (actualResult === 'away_win') {
      totalAwayProbWhenAway += calibrated.awayWinProb;
      countAwayActual++;
    }
  }

  // Compute accuracies
  for (const key of Object.keys(byResult) as Array<keyof typeof byResult>) {
    byResult[key].accuracy =
      byResult[key].predicted > 0
        ? byResult[key].correct / byResult[key].predicted
        : 0;
  }

  return {
    totalPredictions: validCount,
    brierScore: validCount > 0 ? totalBrier / validCount : 0,
    storedBrierScore: validCount > 0 ? totalStoredBrier / validCount : 0,
    accuracy: validCount > 0 ? totalCorrect / validCount : 0,
    drawAccuracy:
      byResult.draw.predicted > 0
        ? byResult.draw.correct / byResult.draw.predicted
        : 0,
    homeWinAccuracy:
      byResult.home_win.predicted > 0
        ? byResult.home_win.correct / byResult.home_win.predicted
        : 0,
    awayWinAccuracy:
      byResult.away_win.predicted > 0
        ? byResult.away_win.correct / byResult.away_win.predicted
        : 0,
    drawPredictionRate:
      validCount > 0 ? byResult.draw.predicted / validCount : 0,
    actualDrawRate: validCount > 0 ? actualCounts.draw / validCount : 0,
    avgConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    byResult,
    calibration: {
      avgHomeProbWhenHomeWins:
        countHomeActual > 0 ? totalHomeProbWhenHome / countHomeActual : 0,
      avgDrawProbWhenDraw:
        countDrawActual > 0 ? totalDrawProbWhenDraw / countDrawActual : 0,
      avgAwayProbWhenAwayWins:
        countAwayActual > 0 ? totalAwayProbWhenAway / countAwayActual : 0,
    },
  };
}

// ─── Output (matches autoresearch format) ─────────────────────────────

async function main() {
  console.log('Autoresearch Backtester');
  console.log('======================\n');

  try {
    const result = await runBacktest(EXPERIMENT_CONFIG);

    // Key metrics block (greppable, like autoresearch's val_bpb output)
    console.log('---');
    console.log(`brier_score:       ${result.brierScore.toFixed(6)}`);
    console.log(`stored_brier:      ${result.storedBrierScore.toFixed(6)}`);
    console.log(
      `brier_delta:       ${(result.brierScore - result.storedBrierScore).toFixed(6)}`,
    );
    console.log(`accuracy:          ${(result.accuracy * 100).toFixed(2)}%`);
    console.log(
      `draw_accuracy:     ${(result.drawAccuracy * 100).toFixed(2)}%`,
    );
    console.log(
      `home_accuracy:     ${(result.homeWinAccuracy * 100).toFixed(2)}%`,
    );
    console.log(
      `away_accuracy:     ${(result.awayWinAccuracy * 100).toFixed(2)}%`,
    );
    console.log(
      `draw_pred_rate:    ${(result.drawPredictionRate * 100).toFixed(2)}%`,
    );
    console.log(
      `actual_draw_rate:  ${(result.actualDrawRate * 100).toFixed(2)}%`,
    );
    console.log(`total_predictions: ${result.totalPredictions}`);
    console.log(`avg_confidence:    ${result.avgConfidence.toFixed(1)}`);
    console.log('');
    console.log('By Result:');
    for (const [key, val] of Object.entries(result.byResult)) {
      console.log(
        `  ${key.padEnd(10)} predicted=${val.predicted} correct=${val.correct} accuracy=${(val.accuracy * 100).toFixed(1)}%`,
      );
    }
    console.log('');
    console.log(
      'Calibration (avg prob assigned when outcome actually occurs):',
    );
    console.log(
      `  home_win: ${(result.calibration.avgHomeProbWhenHomeWins * 100).toFixed(1)}%`,
    );
    console.log(
      `  draw:     ${(result.calibration.avgDrawProbWhenDraw * 100).toFixed(1)}%`,
    );
    console.log(
      `  away_win: ${(result.calibration.avgAwayProbWhenAwayWins * 100).toFixed(1)}%`,
    );
  } catch (error) {
    console.error('FAIL');
    console.error(error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
