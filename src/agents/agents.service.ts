import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, gte, lte, desc, isNull, sql, asc } from 'drizzle-orm';
import * as schema from '../database/schema';
import { DataCollectorAgent, CollectedMatchData } from './data-collector.agent';
import { ResearchAgent, ResearchResult } from './research.agent';
import { AnalysisAgent, PredictionOutput } from './analysis.agent';
import { AlertsService } from '../alerts/alerts.service';

export type PredictionType = 'daily' | 'pre_match' | 'on_demand';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly config: ConfigService,
    private readonly dataCollector: DataCollectorAgent,
    private readonly researchAgent: ResearchAgent,
    private readonly analysisAgent: AnalysisAgent,
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

    // Step 2: Web research
    let research: ResearchResult;
    try {
      research = await this.researchAgent.research(matchData);
    } catch (error) {
      this.logger.warn(
        `Research failed for fixture ${fixtureId}, proceeding with data only: ${error.message}`,
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

    // Step 3: Analysis
    let prediction: PredictionOutput;
    try {
      prediction = await this.analysisAgent.analyze(matchData, research);
    } catch (error) {
      this.logger.error(
        `Analysis failed for fixture ${fixtureId}: ${error.message}`,
      );
      throw error;
    }

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

  // ─── Private helpers ────────────────────────────────────────────────

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
