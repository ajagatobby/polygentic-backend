import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Supermemory from 'supermemory';

/**
 * Prediction Memory Service — powered by Supermemory.
 *
 * Gives the prediction pipeline persistent, searchable memory so that Claude
 * can learn from specific past mistakes instead of generic aggregate stats.
 *
 * Two main operations:
 * 1. **Store** — after a prediction resolves, store a structured memory of
 *    what happened, what went wrong (or right), and why.
 * 2. **Recall** — before generating a new prediction, search for relevant
 *    memories (same teams, same league, similar patterns) and inject them
 *    into Claude's prompt as specific, contextual lessons.
 *
 * Container tags:
 * - "predictions"          — all prediction memories (global)
 * - "league:{leagueId}"    — league-scoped memories
 * - "team:{teamId}"        — team-scoped memories
 */
@Injectable()
export class PredictionMemoryService {
  private readonly logger = new Logger(PredictionMemoryService.name);
  private client: Supermemory | null = null;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('SUPERMEMORY_API_KEY');
    if (apiKey) {
      this.client = new Supermemory({ apiKey });
      this.logger.log('Supermemory client initialized');
    } else {
      this.logger.warn(
        'SUPERMEMORY_API_KEY not set — prediction memory disabled',
      );
    }
  }

  /**
   * Store a memory after a prediction is resolved.
   *
   * Creates a rich, searchable memory that captures:
   * - Match context (teams, league, round, date)
   * - What was predicted vs what actually happened
   * - Whether the prediction was correct
   * - Key factors that were relevant
   * - Lessons learned (especially for wrong predictions)
   */
  async storeResolvedPrediction(params: {
    predictionId: number;
    fixtureId: number;
    homeTeamName: string;
    awayTeamName: string;
    homeTeamId: number;
    awayTeamId: number;
    leagueId: number;
    leagueName: string;
    round: string | null;
    matchDate: Date;
    predictedResult: string;
    actualResult: string;
    wasCorrect: boolean;
    homeWinProb: number;
    drawProb: number;
    awayWinProb: number;
    predictedHomeGoals: number;
    predictedAwayGoals: number;
    actualHomeGoals: number;
    actualAwayGoals: number;
    confidence: number;
    brierScore: number;
    keyFactors: any;
    riskFactors: any;
  }): Promise<void> {
    if (!this.client) return;

    try {
      const {
        homeTeamName,
        awayTeamName,
        leagueName,
        round,
        matchDate,
        predictedResult,
        actualResult,
        wasCorrect,
        homeWinProb,
        drawProb,
        awayWinProb,
        predictedHomeGoals,
        predictedAwayGoals,
        actualHomeGoals,
        actualAwayGoals,
        confidence,
        brierScore,
        keyFactors,
        riskFactors,
      } = params;

      const dateStr = matchDate.toISOString().split('T')[0];
      const correctStr = wasCorrect ? 'CORRECT' : 'WRONG';

      // Determine what type of miss it was
      let missType = '';
      if (!wasCorrect) {
        if (actualResult === 'draw' && predictedResult !== 'draw') {
          missType =
            'Missed draw — predicted a winner in what turned out to be a drawn match.';
        } else if (predictedResult === 'draw' && actualResult !== 'draw') {
          missType =
            'False draw — predicted draw but there was a clear winner.';
        } else if (
          predictedResult === 'home_win' &&
          actualResult === 'away_win'
        ) {
          missType =
            'Wrong winner — predicted home win but away team won (complete reversal).';
        } else if (
          predictedResult === 'away_win' &&
          actualResult === 'home_win'
        ) {
          missType =
            'Wrong winner — predicted away win but home team won (complete reversal).';
        }
      }

      // Build the memory content
      const keyFactorsStr = Array.isArray(keyFactors)
        ? keyFactors.map((f: string) => `  - ${f}`).join('\n')
        : '';
      const riskFactorsStr = Array.isArray(riskFactors)
        ? riskFactors.map((f: string) => `  - ${f}`).join('\n')
        : '';

      const content = [
        `Match: ${homeTeamName} vs ${awayTeamName}`,
        `League: ${leagueName}${round ? `, ${round}` : ''}, ${dateStr}`,
        ``,
        `Prediction: ${this.formatResult(predictedResult)} (H: ${(homeWinProb * 100).toFixed(1)}%, D: ${(drawProb * 100).toFixed(1)}%, A: ${(awayWinProb * 100).toFixed(1)}%)`,
        `Predicted Score: ${predictedHomeGoals.toFixed(1)} - ${predictedAwayGoals.toFixed(1)}`,
        `Confidence: ${confidence}/10`,
        ``,
        `Actual Result: ${this.formatResult(actualResult)} (${actualHomeGoals} - ${actualAwayGoals})`,
        `Outcome: ${correctStr}`,
        `Brier Score: ${brierScore.toFixed(4)}`,
        missType ? `\nMiss Type: ${missType}` : '',
        keyFactorsStr ? `\nKey Factors Used:\n${keyFactorsStr}` : '',
        riskFactorsStr ? `\nRisk Factors Identified:\n${riskFactorsStr}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      // Store in Supermemory with the league as the container tag
      // so memories are organized by league
      await this.client.add({
        content,
        containerTag: `league_${params.leagueId}`,
        customId: `prediction_${params.predictionId}`,
        metadata: {
          predictionId: params.predictionId,
          fixtureId: params.fixtureId,
          homeTeamId: params.homeTeamId,
          awayTeamId: params.awayTeamId,
          leagueId: params.leagueId,
          wasCorrect: params.wasCorrect,
          predictedResult,
          actualResult,
          confidence,
          brierScore: Number(brierScore.toFixed(4)),
          matchDate: dateStr,
        },
      });

      this.logger.debug(
        `Stored memory for prediction ${params.predictionId}: ${homeTeamName} vs ${awayTeamName} (${correctStr})`,
      );
    } catch (error) {
      // Memory storage failure should never block the resolution pipeline
      this.logger.warn(`Failed to store prediction memory: ${error.message}`);
    }
  }

  /**
   * Recall relevant memories before generating a new prediction.
   *
   * Searches for:
   * 1. Past predictions involving the same teams (in this league)
   * 2. Pattern-relevant memories (similar league, similar contexts)
   *
   * Returns formatted text ready to inject into Claude's prompt.
   */
  async recallForPrediction(params: {
    homeTeamName: string;
    awayTeamName: string;
    homeTeamId: number;
    awayTeamId: number;
    leagueId: number;
    leagueName: string;
  }): Promise<string | null> {
    if (!this.client) return null;

    try {
      const { homeTeamName, awayTeamName, leagueId, leagueName } = params;

      // Run multiple targeted searches in parallel
      const [teamMemories, leagueMemories] = await Promise.all([
        // Search 1: Memories about these specific teams in this league
        this.client.search.memories({
          q: `${homeTeamName} vs ${awayTeamName} prediction ${leagueName}`,
          containerTag: `league_${leagueId}`,
          searchMode: 'hybrid',
          limit: 5,
          threshold: 0.5,
        }),
        // Search 2: General league pattern memories (wrong predictions, draw misses)
        this.client.search.memories({
          q: `${leagueName} prediction wrong missed draw lesson`,
          containerTag: `league_${leagueId}`,
          searchMode: 'hybrid',
          limit: 5,
          threshold: 0.5,
        }),
      ]);

      // Deduplicate results by ID
      const seen = new Set<string>();
      const allResults: Array<{ text: string; similarity: number }> = [];

      for (const result of [
        ...(teamMemories?.results ?? []),
        ...(leagueMemories?.results ?? []),
      ]) {
        const id = result.id ?? (result as any).memory ?? (result as any).chunk;
        if (seen.has(id)) continue;
        seen.add(id);

        const text = (result as any).memory ?? (result as any).chunk ?? '';
        if (text) {
          allResults.push({ text, similarity: result.similarity ?? 0 });
        }
      }

      // Sort by relevance and take top 8
      allResults.sort((a, b) => b.similarity - a.similarity);
      const topResults = allResults.slice(0, 8);

      if (topResults.length === 0) {
        this.logger.debug(
          `No relevant memories found for ${homeTeamName} vs ${awayTeamName}`,
        );
        return null;
      }

      // Format for Claude's prompt
      const memoriesText = topResults
        .map((r, i) => `${i + 1}. ${r.text}`)
        .join('\n\n');

      const header = [
        `# RELEVANT PAST PREDICTIONS — LEARN FROM THESE`,
        `The following are specific past predictions for similar matches in ${leagueName}.`,
        `Pay close attention to the WRONG predictions — understand why they failed and avoid the same mistakes.`,
        `Do NOT blindly repeat past predictions — each match is different. Use these as calibration, not templates.`,
        ``,
      ].join('\n');

      this.logger.debug(
        `Recalled ${topResults.length} memories for ${homeTeamName} vs ${awayTeamName}`,
      );

      return `${header}\n${memoriesText}\n`;
    } catch (error) {
      // Memory recall failure should never block prediction generation
      this.logger.warn(
        `Failed to recall prediction memories: ${error.message}`,
      );
      return null;
    }
  }

  private formatResult(result: string): string {
    switch (result) {
      case 'home_win':
        return 'Home Win';
      case 'away_win':
        return 'Away Win';
      case 'draw':
        return 'Draw';
      default:
        return result;
    }
  }
}
