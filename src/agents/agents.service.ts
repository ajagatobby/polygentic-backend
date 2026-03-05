import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, gte, lte, desc, isNull, sql, asc } from 'drizzle-orm';
import * as schema from '../database/schema';
import { DataCollectorAgent, CollectedMatchData } from './data-collector.agent';
import { ResearchAgent, ResearchResult } from './research.agent';
import { AnalysisAgent, PredictionOutput } from './analysis.agent';
import { PoissonModelService } from './poisson-model.service';
import { FootballService } from '../football/football.service';
import { OddsService } from '../odds/odds.service';
import { AlertsService } from '../alerts/alerts.service';
import {
  PredictionType,
  PerformanceFeedback,
  PoissonModelOutput,
} from './types';

// Re-export so existing importers don't break
export { PredictionType, PerformanceFeedback } from './types';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly config: ConfigService,
    private readonly dataCollector: DataCollectorAgent,
    private readonly researchAgent: ResearchAgent,
    private readonly analysisAgent: AnalysisAgent,
    private readonly poissonModel: PoissonModelService,
    private readonly footballService: FootballService,
    private readonly oddsService: OddsService,
    private readonly alertsService: AlertsService,
  ) {}

  // ─── Core prediction pipeline ───────────────────────────────────────

  /**
   * Run the full 3-agent prediction pipeline for a single fixture.
   * 1. Data Collector  — gathers structured data from DB + APIs
   * 2. Research Agent   — Perplexity Sonar web search
   * 3. Analysis Agent   — Claude reasoning + structured prediction output
   */
  async generatePrediction(
    fixtureId: number,
    predictionType: PredictionType,
  ): Promise<any> {
    this.logger.log(
      `Starting prediction pipeline for fixture ${fixtureId} (type: ${predictionType})`,
    );

    const startTime = Date.now();

    // Step 0: Freshen all data sources before prediction
    await this.freshenDataForFixture(fixtureId);

    // Step 1: Collect data
    let matchData: CollectedMatchData;
    try {
      matchData = await this.dataCollector.collect(fixtureId);
    } catch (error) {
      this.logger.error(
        `Data collection failed for fixture ${fixtureId}: ${error.message}`,
      );
      throw error;
    }

    // Step 2: Web research + performance feedback + Poisson model (in parallel)
    let research: ResearchResult;
    let feedback: PerformanceFeedback | null = null;
    let poissonOutput: PoissonModelOutput | null = null;
    try {
      const [researchResult, feedbackResult, poissonResult] =
        await Promise.allSettled([
          this.researchAgent.research(matchData),
          this.getPerformanceFeedback(),
          this.poissonModel.predict(
            matchData.fixture.homeTeamId,
            matchData.fixture.awayTeamId,
            matchData.fixture.leagueId,
            fixtureId,
          ),
        ]);

      research =
        researchResult.status === 'fulfilled'
          ? researchResult.value
          : {
              matchPreview: null,
              teamNews: null,
              tacticalAnalysis: null,
              combinedResearch:
                'Research unavailable — proceeding with structured data only.',
              citations: [],
            };

      if (researchResult.status === 'rejected') {
        this.logger.warn(
          `Research failed for fixture ${fixtureId}, proceeding with data only: ${researchResult.reason?.message}`,
        );
      }

      feedback =
        feedbackResult.status === 'fulfilled' ? feedbackResult.value : null;

      poissonOutput =
        poissonResult.status === 'fulfilled' ? poissonResult.value : null;

      if (poissonOutput) {
        this.logger.log(
          `Poisson model for fixture ${fixtureId}: H=${(poissonOutput.homeWinProb * 100).toFixed(1)}% ` +
            `D=${(poissonOutput.drawProb * 100).toFixed(1)}% A=${(poissonOutput.awayWinProb * 100).toFixed(1)}% ` +
            `(conf=${poissonOutput.confidence}, data=${poissonOutput.dataPoints})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Research/feedback/model failed for fixture ${fixtureId}: ${error.message}`,
      );
      research = {
        matchPreview: null,
        teamNews: null,
        tacticalAnalysis: null,
        combinedResearch:
          'Research unavailable — proceeding with structured data only.',
        citations: [],
      };
    }

    // Step 3: Analysis (Claude gets Poisson output as input for reasoning)
    let prediction: PredictionOutput;
    try {
      prediction = await this.analysisAgent.analyze(
        matchData,
        research,
        feedback,
        poissonOutput,
      );
    } catch (error) {
      this.logger.error(
        `Analysis failed for fixture ${fixtureId}: ${error.message}`,
      );
      throw error;
    }

    // Step 3b: Ensemble — blend Claude + Poisson + Bookmaker odds
    prediction = this.ensemblePredictions(prediction, poissonOutput, matchData);

    // Step 4: Store prediction
    const modelVersion =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-sonnet-4-20250514';
    const stored = await this.storePrediction(
      fixtureId,
      matchData,
      research,
      prediction,
      predictionType,
      modelVersion,
    );

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Prediction pipeline complete for fixture ${fixtureId} in ${durationMs}ms — ` +
        `confidence: ${prediction.confidence}/10, result: ${this.getPredictedResult(prediction)}`,
    );

    // Step 5: Create alert if high confidence
    const threshold =
      this.config.get<number>('PREDICTION_HIGH_CONFIDENCE_THRESHOLD') || 7;
    if (prediction.confidence >= threshold) {
      const homeName =
        matchData.homeTeam?.team?.name ??
        `Team ${matchData.fixture.homeTeamId}`;
      const awayName =
        matchData.awayTeam?.team?.name ??
        `Team ${matchData.fixture.awayTeamId}`;

      try {
        await this.alertsService.createHighConfidenceAlert(
          stored.id,
          fixtureId,
          `${homeName} vs ${awayName}`,
          prediction.confidence,
          this.getPredictedResult(prediction),
        );
      } catch (error) {
        this.logger.warn(`Failed to create alert: ${error.message}`);
      }
    }

    return {
      ...stored,
      homeTeamName: matchData.homeTeam?.team?.name ?? null,
      awayTeamName: matchData.awayTeam?.team?.name ?? null,
    };
  }

  // ─── Batch generation ───────────────────────────────────────────────

  /**
   * Generate daily predictions for all upcoming fixtures within the next 48 hours.
   */
  async generateDailyPredictions(): Promise<{
    generated: number;
    skipped: number;
    failed: number;
    errors: string[];
  }> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    // Get upcoming fixtures that don't have a daily prediction yet
    const upcomingFixtures = await this.db
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

    this.logger.log(
      `Daily predictions: found ${upcomingFixtures.length} upcoming fixtures`,
    );

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    const maxConcurrent =
      this.config.get<number>('PREDICTION_MAX_CONCURRENT') || 5;

    // Process in batches
    for (let i = 0; i < upcomingFixtures.length; i += maxConcurrent) {
      const batch = upcomingFixtures.slice(i, i + maxConcurrent);

      const results = await Promise.allSettled(
        batch.map(async (fixture: any) => {
          // Check if prediction already exists
          const existing = await this.db
            .select()
            .from(schema.predictions)
            .where(
              and(
                eq(schema.predictions.fixtureId, fixture.id),
                eq(schema.predictions.predictionType, 'daily'),
              ),
            )
            .limit(1);

          if (existing.length > 0) {
            return { status: 'skipped', fixtureId: fixture.id };
          }

          await this.generatePrediction(fixture.id, 'daily');
          return { status: 'generated', fixtureId: fixture.id };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.status === 'generated') generated++;
          else skipped++;
        } else {
          failed++;
          errors.push(result.reason?.message ?? 'Unknown error');
        }
      }
    }

    this.logger.log(
      `Daily predictions complete: ${generated} generated, ${skipped} skipped, ${failed} failed`,
    );

    return { generated, skipped, failed, errors };
  }

  /**
   * Generate pre-match predictions for fixtures starting within 1 hour
   * that don't already have a pre_match prediction.
   */
  async generatePreMatchPredictions(): Promise<{
    generated: number;
    skipped: number;
    failed: number;
  }> {
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    const fixtures = await this.db
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

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (const fixture of fixtures) {
      // Check if pre_match prediction already exists
      const existing = await this.db
        .select()
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, fixture.id),
            eq(schema.predictions.predictionType, 'pre_match'),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        await this.generatePrediction(fixture.id, 'pre_match');
        generated++;
      } catch (error) {
        this.logger.warn(
          `Pre-match prediction failed for fixture ${fixture.id}: ${error.message}`,
        );
        failed++;
      }
    }

    if (generated > 0) {
      this.logger.log(
        `Pre-match predictions: ${generated} generated, ${skipped} skipped, ${failed} failed`,
      );
    }

    return { generated, skipped, failed };
  }

  // ─── Resolution ─────────────────────────────────────────────────────

  /**
   * Resolve predictions for finished matches — compute accuracy metrics.
   */
  async resolvePredictions(): Promise<{
    resolved: number;
    errors: string[];
  }> {
    // Get unresolved predictions where the fixture is now finished (FT)
    const unresolved = await this.db
      .select({
        prediction: schema.predictions,
        fixture: schema.fixtures,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          isNull(schema.predictions.resolvedAt),
          eq(schema.fixtures.status, 'FT'),
        ),
      );

    let resolved = 0;
    const errors: string[] = [];

    for (const { prediction, fixture } of unresolved) {
      try {
        const actualHomeGoals = fixture.goalsHome;
        const actualAwayGoals = fixture.goalsAway;

        if (actualHomeGoals == null || actualAwayGoals == null) continue;

        // Determine actual result
        let actualResult: string;
        if (actualHomeGoals > actualAwayGoals) actualResult = 'home_win';
        else if (actualHomeGoals < actualAwayGoals) actualResult = 'away_win';
        else actualResult = 'draw';

        // Determine predicted result
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        const predictedResult = this.getPredictedResultFromProbs(
          homeProb,
          drawProb,
          awayProb,
        );
        const wasCorrect = predictedResult === actualResult;

        // Calculate Brier score (lower is better, 0 = perfect)
        const brierScore = this.calculateBrierScore(
          homeProb,
          drawProb,
          awayProb,
          actualResult,
        );

        await this.db
          .update(schema.predictions)
          .set({
            actualHomeGoals,
            actualAwayGoals,
            actualResult,
            wasCorrect,
            probabilityAccuracy: String(brierScore.toFixed(6)),
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.predictions.id, prediction.id));

        resolved++;
      } catch (error) {
        errors.push(
          `Failed to resolve prediction ${prediction.id}: ${error.message}`,
        );
      }
    }

    if (resolved > 0) {
      this.logger.log(`Resolved ${resolved} predictions`);
    }

    return { resolved, errors };
  }

  // ─── Query methods ──────────────────────────────────────────────────

  async getPredictions(filters: {
    predictionType?: string;
    leagueId?: number;
    minConfidence?: number;
    date?: string;
    unresolved?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (filters.predictionType) {
      conditions.push(
        eq(schema.predictions.predictionType, filters.predictionType),
      );
    }

    if (filters.minConfidence) {
      conditions.push(
        sql`${schema.predictions.confidence} >= ${filters.minConfidence}`,
      );
    }

    if (filters.unresolved) {
      conditions.push(isNull(schema.predictions.resolvedAt));
    }

    if (filters.date) {
      const startOfDay = new Date(`${filters.date}T00:00:00Z`);
      const endOfDay = new Date(`${filters.date}T23:59:59Z`);
      conditions.push(gte(schema.predictions.createdAt, startOfDay));
      conditions.push(lte(schema.predictions.createdAt, endOfDay));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // If filtering by leagueId, join with fixtures + teams
    if (filters.leagueId) {
      const [data, countResult] = await Promise.all([
        this.db
          .select({
            prediction: schema.predictions,
            fixture: schema.fixtures,
            homeTeam: schema.teams,
          })
          .from(schema.predictions)
          .innerJoin(
            schema.fixtures,
            eq(schema.predictions.fixtureId, schema.fixtures.id),
          )
          .leftJoin(
            schema.teams,
            eq(schema.predictions.homeTeamId, schema.teams.id),
          )
          .where(and(where, eq(schema.fixtures.leagueId, filters.leagueId)))
          .orderBy(desc(schema.predictions.createdAt))
          .limit(limit)
          .offset(offset),
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.predictions)
          .innerJoin(
            schema.fixtures,
            eq(schema.predictions.fixtureId, schema.fixtures.id),
          )
          .where(and(where, eq(schema.fixtures.leagueId, filters.leagueId))),
      ]);

      return {
        data: await this.enrichPredictionsWithTeamNames(
          data.map((r: any) => ({ ...r.prediction, fixture: r.fixture })),
        ),
        total: Number(countResult[0]?.count ?? 0),
        page,
        limit,
      };
    }

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(schema.predictions)
        .where(where)
        .orderBy(desc(schema.predictions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.predictions)
        .where(where),
    ]);

    return {
      data: await this.enrichPredictionsWithTeamNames(data),
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  async getPredictionByFixtureId(fixtureId: number): Promise<any[]> {
    const rows = await this.db
      .select()
      .from(schema.predictions)
      .where(eq(schema.predictions.fixtureId, fixtureId))
      .orderBy(desc(schema.predictions.createdAt));

    return this.enrichPredictionsWithTeamNames(rows);
  }

  /**
   * Get accuracy stats for resolved predictions.
   */
  async getAccuracyStats(): Promise<{
    totalResolved: number;
    correct: number;
    accuracy: number;
    avgBrierScore: number;
    byType: Record<
      string,
      { total: number; correct: number; accuracy: number }
    >;
  }> {
    const resolved = await this.db
      .select()
      .from(schema.predictions)
      .where(sql`${schema.predictions.resolvedAt} IS NOT NULL`);

    const total = resolved.length;
    const correct = resolved.filter((p: any) => p.wasCorrect === true).length;
    const avgBrier =
      total > 0
        ? resolved.reduce(
            (sum: number, p: any) => sum + (Number(p.probabilityAccuracy) || 0),
            0,
          ) / total
        : 0;

    // Group by type
    const byType: Record<
      string,
      { total: number; correct: number; accuracy: number }
    > = {};
    for (const p of resolved) {
      const type = p.predictionType as string;
      if (!byType[type]) byType[type] = { total: 0, correct: 0, accuracy: 0 };
      byType[type].total++;
      if (p.wasCorrect) byType[type].correct++;
    }
    for (const type of Object.keys(byType)) {
      byType[type].accuracy =
        byType[type].total > 0 ? byType[type].correct / byType[type].total : 0;
    }

    return {
      totalResolved: total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      avgBrierScore: Number(avgBrier.toFixed(6)),
      byType,
    };
  }

  /**
   * Generate performance feedback from historical predictions to inform future predictions.
   * This creates a self-improving feedback loop by identifying systematic biases.
   */
  async getPerformanceFeedback(): Promise<PerformanceFeedback | null> {
    try {
      const resolved = await this.db
        .select({
          prediction: schema.predictions,
          fixture: schema.fixtures,
        })
        .from(schema.predictions)
        .innerJoin(
          schema.fixtures,
          eq(schema.predictions.fixtureId, schema.fixtures.id),
        )
        .where(sql`${schema.predictions.resolvedAt} IS NOT NULL`)
        .orderBy(desc(schema.predictions.resolvedAt))
        .limit(200); // Last 200 resolved predictions

      if (resolved.length < 10) {
        // Not enough data for meaningful feedback
        return null;
      }

      const total = resolved.length;
      const correct = resolved.filter(
        (r: any) => r.prediction.wasCorrect === true,
      ).length;
      const avgBrier =
        resolved.reduce(
          (sum: number, r: any) =>
            sum + (Number(r.prediction.probabilityAccuracy) || 0),
          0,
        ) / total;

      // Track what we predicted vs what actually happened
      const byResult = {
        home_win: { predicted: 0, correct: 0, accuracy: 0 },
        draw: { predicted: 0, correct: 0, accuracy: 0 },
        away_win: { predicted: 0, correct: 0, accuracy: 0 },
      };

      const actualCounts = { home_win: 0, draw: 0, away_win: 0 };
      let totalHomeProb = 0;
      let totalDrawProb = 0;
      let totalAwayProb = 0;

      // Confidence calibration buckets
      const confidenceBuckets = {
        high: { total: 0, correct: 0 }, // confidence 8-10
        med: { total: 0, correct: 0 }, // confidence 5-7
        low: { total: 0, correct: 0 }, // confidence 1-4
      };

      // League breakdown
      const leagueMap: Record<string, { total: number; correct: number }> = {};

      for (const { prediction, fixture } of resolved) {
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        totalHomeProb += homeProb;
        totalDrawProb += drawProb;
        totalAwayProb += awayProb;

        // Determine predicted result
        const predictedResult = this.getPredictedResultFromProbs(
          homeProb,
          drawProb,
          awayProb,
        );

        // Track predicted outcomes
        if (
          predictedResult === 'home_win' ||
          predictedResult === 'draw' ||
          predictedResult === 'away_win'
        ) {
          byResult[predictedResult].predicted++;
          if (prediction.wasCorrect) byResult[predictedResult].correct++;
        }

        // Track actual outcomes
        const actual = prediction.actualResult as string;
        if (
          actual === 'home_win' ||
          actual === 'draw' ||
          actual === 'away_win'
        ) {
          actualCounts[actual]++;
        }

        // Confidence calibration
        const conf = prediction.confidence ?? 5;
        if (conf >= 8) {
          confidenceBuckets.high.total++;
          if (prediction.wasCorrect) confidenceBuckets.high.correct++;
        } else if (conf >= 5) {
          confidenceBuckets.med.total++;
          if (prediction.wasCorrect) confidenceBuckets.med.correct++;
        } else {
          confidenceBuckets.low.total++;
          if (prediction.wasCorrect) confidenceBuckets.low.correct++;
        }

        // League breakdown
        const leagueName = fixture.leagueName ?? `League ${fixture.leagueId}`;
        if (!leagueMap[leagueName]) {
          leagueMap[leagueName] = { total: 0, correct: 0 };
        }
        leagueMap[leagueName].total++;
        if (prediction.wasCorrect) leagueMap[leagueName].correct++;
      }

      // Compute accuracies
      for (const key of Object.keys(byResult) as Array<keyof typeof byResult>) {
        byResult[key].accuracy =
          byResult[key].predicted > 0
            ? byResult[key].correct / byResult[key].predicted
            : 0;
      }

      // Generate bias insights
      const biasInsights: string[] = [];
      const avgHomeProb = totalHomeProb / total;
      const avgDrawProb = totalDrawProb / total;
      const avgAwayProb = totalAwayProb / total;
      const actualHomePct = actualCounts.home_win / total;
      const actualDrawPct = actualCounts.draw / total;
      const actualAwayPct = actualCounts.away_win / total;

      // Check for systematic probability miscalibration
      if (avgDrawProb < actualDrawPct - 0.05) {
        biasInsights.push(
          `You have been UNDERESTIMATING draw probability. Your average draw prob is ${(avgDrawProb * 100).toFixed(1)}% but draws actually occur ${(actualDrawPct * 100).toFixed(1)}% of the time. Increase draw probability.`,
        );
      }
      if (avgHomeProb > actualHomePct + 0.05) {
        biasInsights.push(
          `You have been OVERESTIMATING home win probability. Your average is ${(avgHomeProb * 100).toFixed(1)}% but home wins occur ${(actualHomePct * 100).toFixed(1)}% of the time.`,
        );
      }
      if (avgAwayProb > actualAwayPct + 0.05) {
        biasInsights.push(
          `You have been OVERESTIMATING away win probability. Your average is ${(avgAwayProb * 100).toFixed(1)}% but away wins occur ${(actualAwayPct * 100).toFixed(1)}% of the time.`,
        );
      }

      // Check confidence calibration
      const highAcc =
        confidenceBuckets.high.total > 0
          ? confidenceBuckets.high.correct / confidenceBuckets.high.total
          : 0;
      const medAcc =
        confidenceBuckets.med.total > 0
          ? confidenceBuckets.med.correct / confidenceBuckets.med.total
          : 0;
      const lowAcc =
        confidenceBuckets.low.total > 0
          ? confidenceBuckets.low.correct / confidenceBuckets.low.total
          : 0;

      if (confidenceBuckets.high.total > 5 && highAcc < 0.6) {
        biasInsights.push(
          `High-confidence predictions (8-10) are only ${(highAcc * 100).toFixed(1)}% accurate. You are OVERCONFIDENT. Reserve high confidence for genuinely clear-cut matches.`,
        );
      }
      if (confidenceBuckets.low.total > 5 && lowAcc > medAcc) {
        biasInsights.push(
          `Low-confidence predictions are more accurate than medium-confidence ones. Your confidence scoring is not well calibrated.`,
        );
      }

      // Find worst-performing leagues
      const leagueBreakdown: Record<
        string,
        { total: number; correct: number; accuracy: number }
      > = {};
      for (const [name, data] of Object.entries(leagueMap)) {
        const acc = data.total > 0 ? data.correct / data.total : 0;
        leagueBreakdown[name] = { ...data, accuracy: acc };
        if (data.total >= 5 && acc < 0.4) {
          biasInsights.push(
            `Poor performance in ${name}: ${(acc * 100).toFixed(1)}% accuracy over ${data.total} predictions. Consider that this league may have different dynamics.`,
          );
        }
      }

      return {
        totalResolved: total,
        overallAccuracy: correct / total,
        avgBrierScore: Number(avgBrier.toFixed(6)),
        byResult,
        avgProbabilities: {
          homeWinProb: Number(avgHomeProb.toFixed(4)),
          drawProb: Number(avgDrawProb.toFixed(4)),
          awayWinProb: Number(avgAwayProb.toFixed(4)),
        },
        actualDistribution: {
          homeWinPct: Number(actualHomePct.toFixed(4)),
          drawPct: Number(actualDrawPct.toFixed(4)),
          awayWinPct: Number(actualAwayPct.toFixed(4)),
        },
        biasInsights,
        confidenceCalibration: {
          highConfidence: {
            total: confidenceBuckets.high.total,
            correct: confidenceBuckets.high.correct,
            accuracy: highAcc,
          },
          medConfidence: {
            total: confidenceBuckets.med.total,
            correct: confidenceBuckets.med.correct,
            accuracy: medAcc,
          },
          lowConfidence: {
            total: confidenceBuckets.low.total,
            correct: confidenceBuckets.low.correct,
            accuracy: lowAcc,
          },
        },
        leagueBreakdown,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to compute performance feedback: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get the predictions the model is most bullish on.
   *
   * "Bullish" = high confidence + a strongly dominant outcome probability.
   * Sorted by a composite bullish score that combines:
   *   - Confidence (1-10 scale)
   *   - Dominant probability (how lopsided the prediction is)
   *   - Value edge vs bookmaker odds (if available)
   *
   * Only returns unresolved predictions for upcoming matches.
   */
  async getBullishPredictions(options?: {
    limit?: number;
    minConfidence?: number;
    minDominantProb?: number;
  }): Promise<any[]> {
    const limit = options?.limit ?? 10;
    const minConfidence = options?.minConfidence ?? 6;
    const minDominantProb = options?.minDominantProb ?? 0.45;

    // Get unresolved predictions for upcoming fixtures with high confidence
    const rows = await this.db
      .select({
        prediction: schema.predictions,
        fixture: schema.fixtures,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          isNull(schema.predictions.resolvedAt),
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, new Date()),
          gte(schema.predictions.confidence, minConfidence),
        ),
      )
      .orderBy(desc(schema.predictions.confidence), asc(schema.fixtures.date));

    if (rows.length === 0) return [];

    // Score and rank each prediction by "bullishness"
    const scored = rows
      .map(({ prediction, fixture }: any) => {
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        const confidence = prediction.confidence ?? 5;

        // Dominant probability — the highest of the three outcomes
        const dominantProb = Math.max(homeProb, drawProb, awayProb);

        // Skip if dominant probability is too low (close match)
        if (dominantProb < minDominantProb) return null;

        // Determine the predicted outcome
        let predictedOutcome: string;
        if (homeProb >= drawProb && homeProb >= awayProb)
          predictedOutcome = 'Home Win';
        else if (awayProb >= homeProb && awayProb >= drawProb)
          predictedOutcome = 'Away Win';
        else predictedOutcome = 'Draw';

        // Value edge from value bets (if available)
        const valueBets = (prediction.valueBets as any[]) ?? [];
        const maxEdge =
          valueBets.length > 0
            ? Math.max(
                ...valueBets.map((vb: any) => Number(vb.edgePercent) || 0),
              )
            : 0;

        // Composite bullish score (0-100):
        // - Confidence contributes 40% (scaled from 1-10 to 0-40)
        // - Dominant probability contributes 40% (scaled from 0.33-1.0 to 0-40)
        // - Value edge contributes 20% (capped at 20% edge = 20 points)
        const confidenceScore = (confidence / 10) * 40;
        const probScore = ((dominantProb - 0.33) / 0.67) * 40;
        const edgeScore = Math.min(20, maxEdge);
        const bullishScore = Number(
          (confidenceScore + probScore + edgeScore).toFixed(1),
        );

        return {
          predictionId: prediction.id,
          fixtureId: prediction.fixtureId,
          homeTeamId: prediction.homeTeamId,
          awayTeamId: prediction.awayTeamId,
          predictedOutcome,
          dominantProb: Number(dominantProb.toFixed(4)),
          homeWinProb: homeProb,
          drawProb,
          awayWinProb: awayProb,
          predictedHomeGoals: prediction.predictedHomeGoals,
          predictedAwayGoals: prediction.predictedAwayGoals,
          confidence,
          bullishScore,
          keyFactors: prediction.keyFactors,
          riskFactors: prediction.riskFactors,
          valueBets: prediction.valueBets,
          detailedAnalysis: prediction.detailedAnalysis,
          predictionType: prediction.predictionType,
          fixture: {
            id: fixture.id,
            date: fixture.date,
            status: fixture.status,
            round: fixture.round,
            leagueId: fixture.leagueId,
            leagueName: fixture.leagueName,
            leagueCountry: fixture.leagueCountry,
            venueName: fixture.venueName,
          },
          createdAt: prediction.createdAt,
        };
      })
      .filter(Boolean);

    // Sort by bullish score descending
    scored.sort((a: any, b: any) => b.bullishScore - a.bullishScore);

    // Take top N
    const topPicks = scored.slice(0, limit);

    // Enrich with team names, lineups, and injuries
    const teamIds = new Set<number>();
    const fixtureIds: number[] = [];
    for (const p of topPicks) {
      if (p.homeTeamId) teamIds.add(p.homeTeamId);
      if (p.awayTeamId) teamIds.add(p.awayTeamId);
      fixtureIds.push(p.fixtureId);
    }

    const [teamRows, lineupsAndInjuries] = await Promise.all([
      teamIds.size > 0
        ? this.db
            .select({
              id: schema.teams.id,
              name: schema.teams.name,
              logo: schema.teams.logo,
            })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [],
      this.footballService.getLineupsAndInjuriesForFixtures(fixtureIds),
    ]);

    const teamMap = new Map<number, { name: string; logo: string | null }>();
    for (const t of teamRows) {
      teamMap.set(t.id, { name: t.name, logo: t.logo });
    }

    return topPicks.map((p: any) => {
      const homeTeam = teamMap.get(p.homeTeamId);
      const awayTeam = teamMap.get(p.awayTeamId);
      const fixtureLineups =
        lineupsAndInjuries.lineupsByFixture.get(p.fixtureId) ?? null;
      const homeInjuries =
        lineupsAndInjuries.injuriesByTeam.get(p.homeTeamId) ?? [];
      const awayInjuries =
        lineupsAndInjuries.injuriesByTeam.get(p.awayTeamId) ?? [];

      return {
        ...p,
        homeTeam: {
          id: p.homeTeamId,
          name: homeTeam?.name ?? null,
          logo: homeTeam?.logo ?? null,
          injuries: homeInjuries,
        },
        awayTeam: {
          id: p.awayTeamId,
          name: awayTeam?.name ?? null,
          logo: awayTeam?.logo ?? null,
          injuries: awayInjuries,
        },
        lineups: fixtureLineups,
      };
    });
  }

  // ─── Pre-prediction data freshening ──────────────────────────────────

  /**
   * Ensure all data sources are fresh before generating a prediction.
   * Fetches injuries, lineups, standings, and odds from external APIs
   * and persists them to the database so the DataCollector reads fresh data.
   *
   * Each fetch is best-effort — failures are logged but don't block the prediction.
   */
  /**
   * Track when each league was last freshened to avoid redundant API calls.
   * Key = leagueId, Value = timestamp of last sync.
   */
  private lastFreshened = new Map<number, number>();
  private static readonly FRESHEN_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  private async freshenDataForFixture(fixtureId: number): Promise<void> {
    // Get the fixture to know the league
    const fixtureRows = await this.db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, fixtureId))
      .limit(1);

    const fixture = fixtureRows?.[0];
    if (!fixture) {
      this.logger.warn(
        `Fixture ${fixtureId} not found, skipping data freshening`,
      );
      return;
    }

    const leagueId = fixture.leagueId;
    const now = Date.now();

    // Skip heavy syncs (injuries, standings) if this league was freshened recently
    const lastTime = this.lastFreshened.get(leagueId) ?? 0;
    const needsLeagueSync = now - lastTime > AgentsService.FRESHEN_COOLDOWN_MS;

    const freshenStart = now;
    const tasks: Promise<{ type: string; count: number }>[] = [];

    // Always fetch lineups — lightweight, fixture-specific, and critical
    tasks.push(
      this.footballService
        .fetchAndPersistLineups(fixtureId)
        .then((count) => ({ type: 'lineups', count }))
        .catch(() => ({ type: 'lineups', count: 0 })),
    );

    // Only sync injuries and standings if not recently done for this league
    if (needsLeagueSync) {
      this.logger.log(
        `Freshening injuries + standings for league ${leagueId} (fixture ${fixtureId})`,
      );
      tasks.push(
        this.footballService
          .syncInjuries(leagueId)
          .then((count) => ({ type: 'injuries', count }))
          .catch(() => ({ type: 'injuries', count: 0 })),
      );
      tasks.push(
        this.footballService
          .syncStandings(leagueId)
          .then((count) => ({ type: 'standings', count }))
          .catch(() => ({ type: 'standings', count: 0 })),
      );
    }

    // Odds sync is too heavy to run per-prediction — handled by the 6-hourly cron.
    // No odds sync here.

    const results = await Promise.all(tasks);

    if (needsLeagueSync) {
      this.lastFreshened.set(leagueId, Date.now());
    }

    const duration = Date.now() - freshenStart;
    const summary = results
      .filter((r) => r.count > 0)
      .map((r) => `${r.type}=${r.count}`)
      .join(', ');

    this.logger.log(
      `Data freshened for fixture ${fixtureId} in ${duration}ms` +
        (summary ? `: ${summary}` : ' (all cached)'),
    );
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Ensemble Claude's prediction with Poisson model and bookmaker consensus.
   *
   * Weights (configurable via env):
   * - Claude (LLM analysis): 40% — contextual reasoning, qualitative factors
   * - Poisson model: 25% — mathematical, xG-based, well-calibrated
   * - Bookmaker consensus: 35% — market-efficient, incorporates all information
   *
   * If Poisson or bookmaker data is unavailable, weights are redistributed.
   */
  private ensemblePredictions(
    claudePrediction: PredictionOutput,
    poissonOutput: PoissonModelOutput | null,
    matchData: CollectedMatchData,
  ): PredictionOutput {
    // Get weights from config (or defaults)
    const baseClaudeWeight = 0.4;
    const basePoissonWeight = 0.25;
    const baseBookmakerWeight = 0.35;

    // Extract bookmaker consensus probabilities
    let bookmakerProbs: {
      home: number;
      draw: number;
      away: number;
    } | null = null;

    const h2hConsensus = matchData.odds?.consensus?.find(
      (c: any) => c.marketKey === 'h2h',
    );
    if (h2hConsensus) {
      const bHome = Number(h2hConsensus.consensusHomeWin) || 0;
      const bDraw = Number(h2hConsensus.consensusDraw) || 0;
      const bAway = Number(h2hConsensus.consensusAwayWin) || 0;
      const bTotal = bHome + bDraw + bAway;
      if (bTotal > 0.9 && bTotal < 1.1) {
        // Looks like valid probabilities (close to 1.0)
        bookmakerProbs = {
          home: bHome / bTotal,
          draw: bDraw / bTotal,
          away: bAway / bTotal,
        };
      }
    }

    // Determine available signals and redistribute weights
    const hasPoissonData =
      poissonOutput != null &&
      poissonOutput.dataPoints >= 6 &&
      poissonOutput.confidence > 0;
    const hasBookmakerData = bookmakerProbs != null;

    let claudeWeight: number;
    let poissonWeight: number;
    let bookmakerWeight: number;

    if (hasPoissonData && hasBookmakerData) {
      // All three signals available
      // Scale Poisson weight by its confidence
      claudeWeight = baseClaudeWeight;
      poissonWeight = basePoissonWeight * poissonOutput!.confidence;
      bookmakerWeight = baseBookmakerWeight;
    } else if (hasPoissonData && !hasBookmakerData) {
      // No bookmaker data — split between Claude and Poisson
      claudeWeight = 0.6;
      poissonWeight = 0.4 * poissonOutput!.confidence;
      bookmakerWeight = 0;
    } else if (!hasPoissonData && hasBookmakerData) {
      // No Poisson data — split between Claude and bookmaker
      claudeWeight = 0.5;
      poissonWeight = 0;
      bookmakerWeight = 0.5;
    } else {
      // Only Claude available
      claudeWeight = 1.0;
      poissonWeight = 0;
      bookmakerWeight = 0;
    }

    // Normalize weights to sum to 1.0
    const totalWeight = claudeWeight + poissonWeight + bookmakerWeight;
    claudeWeight /= totalWeight;
    poissonWeight /= totalWeight;
    bookmakerWeight /= totalWeight;

    // Blend probabilities
    let homeWinProb =
      claudeWeight * claudePrediction.homeWinProb +
      (hasPoissonData ? poissonWeight * poissonOutput!.homeWinProb : 0) +
      (hasBookmakerData ? bookmakerWeight * bookmakerProbs!.home : 0);

    let drawProb =
      claudeWeight * claudePrediction.drawProb +
      (hasPoissonData ? poissonWeight * poissonOutput!.drawProb : 0) +
      (hasBookmakerData ? bookmakerWeight * bookmakerProbs!.draw : 0);

    let awayWinProb =
      claudeWeight * claudePrediction.awayWinProb +
      (hasPoissonData ? poissonWeight * poissonOutput!.awayWinProb : 0) +
      (hasBookmakerData ? bookmakerWeight * bookmakerProbs!.away : 0);

    // Normalize
    const total = homeWinProb + drawProb + awayWinProb;
    homeWinProb /= total;
    drawProb /= total;
    awayWinProb /= total;

    // Blend expected goals
    let predictedHomeGoals = claudePrediction.predictedHomeGoals;
    let predictedAwayGoals = claudePrediction.predictedAwayGoals;
    if (hasPoissonData) {
      predictedHomeGoals =
        claudeWeight * claudePrediction.predictedHomeGoals +
        (1 - claudeWeight) * poissonOutput!.expectedHomeGoals;
      predictedAwayGoals =
        claudeWeight * claudePrediction.predictedAwayGoals +
        (1 - claudeWeight) * poissonOutput!.expectedAwayGoals;
    }

    this.logger.log(
      `Ensemble: Claude(${(claudeWeight * 100).toFixed(0)}%) + ` +
        `Poisson(${(poissonWeight * 100).toFixed(0)}%) + ` +
        `Bookmaker(${(bookmakerWeight * 100).toFixed(0)}%) → ` +
        `H=${(homeWinProb * 100).toFixed(1)}% D=${(drawProb * 100).toFixed(1)}% A=${(awayWinProb * 100).toFixed(1)}%`,
    );

    return {
      ...claudePrediction,
      homeWinProb: Number(homeWinProb.toFixed(4)),
      drawProb: Number(drawProb.toFixed(4)),
      awayWinProb: Number(awayWinProb.toFixed(4)),
      predictedHomeGoals: Number(predictedHomeGoals.toFixed(1)),
      predictedAwayGoals: Number(predictedAwayGoals.toFixed(1)),
    };
  }

  /**
   * Enrich prediction rows with homeTeamName / awayTeamName by looking up the teams table.
   * Batches team ID lookups to avoid N+1 queries.
   */
  private async enrichPredictionsWithTeamNames(
    predictions: any[],
  ): Promise<any[]> {
    if (predictions.length === 0) return predictions;

    // Collect unique team IDs
    const teamIds = new Set<number>();
    for (const p of predictions) {
      if (p.homeTeamId) teamIds.add(p.homeTeamId);
      if (p.awayTeamId) teamIds.add(p.awayTeamId);
    }

    if (teamIds.size === 0) return predictions;

    // Batch lookup
    const teamRows = await this.db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(
        sql`${schema.teams.id} IN (${sql.join(
          [...teamIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const teamMap = new Map<number, string>();
    for (const t of teamRows) {
      teamMap.set(t.id, t.name);
    }

    return predictions.map((p: any) => ({
      ...p,
      homeTeamName: teamMap.get(p.homeTeamId) ?? null,
      awayTeamName: teamMap.get(p.awayTeamId) ?? null,
    }));
  }

  private async storePrediction(
    fixtureId: number,
    data: CollectedMatchData,
    research: ResearchResult,
    prediction: PredictionOutput,
    predictionType: PredictionType,
    modelVersion: string,
  ): Promise<any> {
    const values = {
      fixtureId,
      homeTeamId: data.fixture.homeTeamId,
      awayTeamId: data.fixture.awayTeamId,
      homeWinProb: String(prediction.homeWinProb),
      drawProb: String(prediction.drawProb),
      awayWinProb: String(prediction.awayWinProb),
      predictedHomeGoals: String(prediction.predictedHomeGoals),
      predictedAwayGoals: String(prediction.predictedAwayGoals),
      confidence: prediction.confidence,
      predictionType,
      keyFactors: prediction.keyFactors,
      riskFactors: prediction.riskFactors,
      valueBets: prediction.valueBets,
      matchContext: this.buildMatchContext(data),
      researchContext: {
        combinedResearch: research.combinedResearch,
        citations: research.citations,
      },
      detailedAnalysis: prediction.detailedAnalysis,
      modelVersion,
      updatedAt: new Date(),
    };

    const [stored] = await this.db
      .insert(schema.predictions)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.predictions.fixtureId,
          schema.predictions.predictionType,
        ],
        set: {
          ...values,
          updatedAt: new Date(),
        },
      })
      .returning();

    return stored;
  }

  private buildMatchContext(data: CollectedMatchData): Record<string, any> {
    return {
      fixture: {
        id: data.fixture.id,
        date: data.fixture.date,
        league: data.fixture.leagueName,
        round: data.fixture.round,
        venue: data.fixture.venueName,
      },
      homeTeam: data.homeTeam?.team?.name ?? null,
      awayTeam: data.awayTeam?.team?.name ?? null,
      h2hCount: data.h2h.length,
      injuriesCount: data.injuries.length,
      lineupsAvailable: data.lineups.length > 0,
      oddsAvailable: data.odds.consensus.length > 0,
      apiPredictionAvailable: data.apiPrediction != null,
    };
  }

  private getPredictedResult(prediction: PredictionOutput): string {
    return this.getPredictedResultFromProbs(
      prediction.homeWinProb,
      prediction.drawProb,
      prediction.awayWinProb,
    );
  }

  private getPredictedResultFromProbs(
    homeProb: number,
    drawProb: number,
    awayProb: number,
  ): string {
    if (homeProb >= drawProb && homeProb >= awayProb) return 'home_win';
    if (awayProb >= homeProb && awayProb >= drawProb) return 'away_win';
    return 'draw';
  }

  /**
   * Calculate Brier score for a 3-outcome prediction.
   * Lower is better (0 = perfect, 2 = worst possible).
   */
  private calculateBrierScore(
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
}
