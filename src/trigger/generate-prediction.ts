import { task, logger } from '@trigger.dev/sdk/v3';
import { initServices } from './init';
import type { PredictionType } from '../agents/agents.service';

/**
 * Generate a prediction for a single fixture using the 3-agent pipeline:
 *   1. Data Collector  — gathers structured data from DB + APIs
 *   2. Research Agent   — Perplexity Sonar web search
 *   3. Analysis Agent   — Claude reasoning + structured prediction output
 *
 * This is the core unit of work. Long-running (~30-90s per fixture due to
 * external API calls to Perplexity and Anthropic), so it benefits from
 * Trigger.dev's durable execution, retries, and visibility.
 */
export const generatePredictionTask = task({
  id: 'generate-prediction',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async (payload: {
    fixtureId: number;
    predictionType: PredictionType;
  }) => {
    const { fixtureId, predictionType } = payload;
    logger.info('Starting prediction pipeline', { fixtureId, predictionType });

    const { agentsService } = initServices();

    const result = await agentsService.generatePrediction(
      fixtureId,
      predictionType,
    );

    logger.info('Prediction pipeline complete', {
      fixtureId,
      predictionId: result.id,
      confidence: result.confidence,
      homeTeam: result.homeTeamName,
      awayTeam: result.awayTeamName,
    });

    return {
      predictionId: result.id,
      fixtureId,
      confidence: result.confidence,
      homeWinProb: result.homeWinProb,
      drawProb: result.drawProb,
      awayWinProb: result.awayWinProb,
      homeTeamName: result.homeTeamName,
      awayTeamName: result.awayTeamName,
    };
  },
});
