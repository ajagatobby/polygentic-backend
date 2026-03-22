import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  eq,
  and,
  gte,
  lte,
  desc,
  isNull,
  sql,
  asc,
  inArray,
} from 'drizzle-orm';
import * as schema from '../database/schema';
import { DataCollectorAgent, CollectedMatchData } from './data-collector.agent';
import { ResearchAgent, ResearchResult } from './research.agent';
import { AnalysisAgent, PredictionOutput } from './analysis.agent';
import { CriticAgent, CriticOutput } from './critic.agent';
import {
  FirstPrinciplesAgent,
  FirstPrinciplesOutput,
} from './first-principles.agent';
import { PoissonModelService } from './poisson-model.service';
import {
  PlayerImpactService,
  TeamAbsenceImpact,
} from './player-impact.service';
import { FootballService } from '../football/football.service';
import { OddsService } from '../odds/odds.service';
import { AlertsService } from '../alerts/alerts.service';
import { PredictionMemoryService } from './prediction-memory.service';
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
    private readonly criticAgent: CriticAgent,
    private readonly firstPrinciplesAgent: FirstPrinciplesAgent,
    private readonly poissonModel: PoissonModelService,
    private readonly playerImpact: PlayerImpactService,
    private readonly footballService: FootballService,
    private readonly oddsService: OddsService,
    private readonly alertsService: AlertsService,
    private readonly predictionMemory: PredictionMemoryService,
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

    // Step 1b: Compute player impact scores for injuries/absences
    let playerImpactScores: {
      home: TeamAbsenceImpact;
      away: TeamAbsenceImpact;
    } | null = null;
    try {
      playerImpactScores = await this.playerImpact.computeImpactScores(
        matchData.injuries,
        matchData.fixture.homeTeamId,
        matchData.fixture.awayTeamId,
        matchData.fixture.leagueId,
        fixtureId,
      );

      const homeAbsences = playerImpactScores.home.players.filter(
        (p) => p.impactLabel !== 'MINIMAL',
      );
      const awayAbsences = playerImpactScores.away.players.filter(
        (p) => p.impactLabel !== 'MINIMAL',
      );
      if (homeAbsences.length > 0 || awayAbsences.length > 0) {
        this.logger.log(
          `Player impact for fixture ${fixtureId}: ` +
            `Home absences=${homeAbsences.length} (xG×${playerImpactScores.home.xgMultiplier}, xGA×${playerImpactScores.home.xgaMultiplier}), ` +
            `Away absences=${awayAbsences.length} (xG×${playerImpactScores.away.xgMultiplier}, xGA×${playerImpactScores.away.xgaMultiplier})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Player impact scoring failed for fixture ${fixtureId}: ${error.message}`,
      );
    }

    // Attach player impact to matchData so downstream agents can use it
    matchData.playerImpact = playerImpactScores;

    // Step 2: Web research + performance feedback + Poisson model + memory recall (in parallel)
    let research: ResearchResult;
    let feedback: PerformanceFeedback | null = null;
    let poissonOutput: PoissonModelOutput | null = null;
    let memories: string | null = null;
    try {
      const homeName =
        matchData.homeTeam?.team?.name ??
        `Team ${matchData.fixture.homeTeamId}`;
      const awayName =
        matchData.awayTeam?.team?.name ??
        `Team ${matchData.fixture.awayTeamId}`;

      const [researchResult, feedbackResult, poissonResult, memoriesResult] =
        await Promise.allSettled([
          this.researchAgent.research(matchData),
          this.getPerformanceFeedback(),
          this.poissonModel.predict(
            matchData.fixture.homeTeamId,
            matchData.fixture.awayTeamId,
            matchData.fixture.leagueId,
            fixtureId,
            playerImpactScores ?? undefined,
          ),
          this.predictionMemory.recallForPrediction({
            homeTeamName: homeName,
            awayTeamName: awayName,
            homeTeamId: matchData.fixture.homeTeamId,
            awayTeamId: matchData.fixture.awayTeamId,
            leagueId: matchData.fixture.leagueId,
            leagueName:
              matchData.fixture.leagueName ??
              `League ${matchData.fixture.leagueId}`,
          }),
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

      memories =
        memoriesResult.status === 'fulfilled' ? memoriesResult.value : null;

      if (poissonOutput) {
        this.logger.log(
          `Poisson model for fixture ${fixtureId}: H=${(poissonOutput.homeWinProb * 100).toFixed(1)}% ` +
            `D=${(poissonOutput.drawProb * 100).toFixed(1)}% A=${(poissonOutput.awayWinProb * 100).toFixed(1)}% ` +
            `(conf=${poissonOutput.confidence}, data=${poissonOutput.dataPoints})`,
        );
      }

      if (memories) {
        this.logger.log(
          `Recalled prediction memories for fixture ${fixtureId} (${homeName} vs ${awayName})`,
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

    // Step 3: Analysis (main reasoner)
    let prediction: PredictionOutput;
    try {
      prediction = await this.analysisAgent.analyze(
        matchData,
        research,
        feedback,
        poissonOutput,
        memories,
      );
    } catch (error) {
      this.logger.error(
        `Analysis failed for fixture ${fixtureId}: ${error.message}`,
      );
      throw error;
    }

    // Step 3a: Critic + First-principles challenge pass
    let criticReview: CriticOutput | null = null;
    let firstPrinciples: FirstPrinciplesOutput | null = null;
    try {
      const [criticResult, fpResult] = await Promise.allSettled([
        this.criticAgent.review(matchData, research, prediction),
        this.firstPrinciplesAgent.rethink(matchData),
      ]);

      if (criticResult.status === 'fulfilled') {
        criticReview = criticResult.value;
      }
      if (fpResult.status === 'fulfilled') {
        firstPrinciples = fpResult.value;
      }

      prediction = this.applyChallengePass(
        prediction,
        firstPrinciples,
        criticReview,
      );
    } catch (error) {
      this.logger.warn(
        `Challenge pass failed for fixture ${fixtureId}: ${error.message}`,
      );
    }

    // Step 3b: Ensemble — blend Claude + Poisson + Bookmaker odds
    prediction = this.ensemblePredictions(prediction, poissonOutput, matchData);

    // TODO [Phase 3]: Apply isotonic regression calibration to final probabilities
    // once we have 200+ resolved predictions. Isotonic regression maps raw model
    // probabilities to empirically calibrated ones, fixing systematic miscalibration.
    // Implementation: train an isotonic regressor on (predicted_prob, actual_outcome)
    // pairs, then apply to homeWinProb/drawProb/awayWinProb before storage.

    // Step 4: Store prediction
    const modelVersion =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-opus-4-6';
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
    voided: number;
    errors: string[];
  }> {
    // Completed fixture statuses: Full Time, After Extra Time, Penalties
    const COMPLETED_STATUSES = ['FT', 'AET', 'PEN'];
    // Void fixture statuses: Postponed, Cancelled, Abandoned, Awarded, Walkover
    const VOID_STATUSES = ['PST', 'CANC', 'ABD', 'AWD', 'WO'];

    // Get unresolved predictions where the fixture is now finished or voided
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
          eq(schema.predictions.predictionStatus, 'pending'),
          inArray(schema.fixtures.status, [
            ...COMPLETED_STATUSES,
            ...VOID_STATUSES,
          ]),
        ),
      );

    let resolved = 0;
    let voided = 0;
    const errors: string[] = [];

    for (const { prediction, fixture } of unresolved) {
      try {
        // ── Handle voided fixtures (postponed/cancelled/abandoned) ──
        if (VOID_STATUSES.includes(fixture.status)) {
          await this.db
            .update(schema.predictions)
            .set({
              predictionStatus: 'void',
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.predictions.id, prediction.id));
          voided++;
          this.logger.log(
            `Voided prediction ${prediction.id} — fixture ${fixture.id} status: ${fixture.status}`,
          );
          continue;
        }

        // ── Handle completed fixtures ──
        const actualHomeGoals = fixture.goalsHome;
        const actualAwayGoals = fixture.goalsAway;

        if (actualHomeGoals == null || actualAwayGoals == null) continue;

        // Determine actual result
        let actualResult: string;
        if (actualHomeGoals > actualAwayGoals) actualResult = 'home_win';
        else if (actualHomeGoals < actualAwayGoals) actualResult = 'away_win';
        else actualResult = 'draw';

        // Use stored predictedResult (locked at prediction time).
        // Fall back to re-deriving from probs for legacy predictions without it.
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        const predictedResult =
          prediction.predictedResult ??
          this.getPredictedResultFromProbs(homeProb, drawProb, awayProb);

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
            predictedResult, // backfill for legacy rows that had null
            predictionStatus: 'resolved',
            probabilityAccuracy: String(brierScore.toFixed(6)),
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.predictions.id, prediction.id));

        // Store memory in Supermemory for future predictions (best-effort, non-blocking)
        this.storeResolutionMemory(prediction, fixture, {
          predictedResult,
          actualResult,
          wasCorrect,
          brierScore,
          homeProb,
          drawProb,
          awayProb,
        }).catch((err) =>
          this.logger.warn(`Memory storage failed: ${err.message}`),
        );

        resolved++;
      } catch (error) {
        errors.push(
          `Failed to resolve prediction ${prediction.id}: ${error.message}`,
        );
      }
    }

    if (resolved > 0 || voided > 0) {
      this.logger.log(
        `Resolved ${resolved} predictions, voided ${voided} predictions`,
      );
    }

    return { resolved, voided, errors };
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

  /**
   * Get predictions for football fixtures by match date.
   *
   * Unlike `getPredictions` (which filters on `predictions.created_at`),
   * this joins with `fixtures` and filters on the actual **match date**.
   *
   * Supports:
   *  - Single date: `date` (YYYY-MM-DD, defaults to today)
   *  - Date range:  `from` + `to` (YYYY-MM-DD)
   *  - Shorthand:   `days` (e.g. 2 = today + next 2 days)
   *
   * For each fixture, picks the "best" prediction by priority:
   * pre_match > daily > on_demand.
   */
  async getPredictionsByMatchDate(filters: {
    date?: string;
    from?: string;
    to?: string;
    days?: number;
    leagueId?: number;
    leagueName?: string;
    minConfidence?: number;
    unresolved?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
    dateRange: { from: string; to: string };
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const offset = (page - 1) * limit;

    // ── Resolve date range ──────────────────────────────────────────
    let fromDate: Date;
    let toDate: Date;

    if (filters.from && filters.to) {
      fromDate = new Date(`${filters.from}T00:00:00Z`);
      toDate = new Date(`${filters.to}T23:59:59Z`);
    } else if (filters.days != null) {
      fromDate = new Date();
      fromDate.setUTCHours(0, 0, 0, 0);
      toDate = new Date(fromDate);
      toDate.setUTCDate(toDate.getUTCDate() + filters.days);
      toDate.setUTCHours(23, 59, 59, 999);
    } else {
      const dateStr = filters.date ?? new Date().toISOString().split('T')[0];
      fromDate = new Date(`${dateStr}T00:00:00Z`);
      toDate = new Date(`${dateStr}T23:59:59Z`);
    }

    // ── Build conditions ────────────────────────────────────────────
    const conditions: any[] = [
      gte(schema.fixtures.date, fromDate),
      lte(schema.fixtures.date, toDate),
    ];

    if (filters.leagueId) {
      conditions.push(eq(schema.fixtures.leagueId, filters.leagueId));
    }

    if (filters.leagueName) {
      conditions.push(
        sql`${schema.fixtures.leagueName} ILIKE ${'%' + filters.leagueName + '%'}`,
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

    const whereClause = and(...conditions);

    // ── Query: predictions joined with fixtures and teams ───────────
    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          prediction: schema.predictions,
          fixtureId: schema.fixtures.id,
          fixtureDate: schema.fixtures.date,
          fixtureStatus: schema.fixtures.status,
          fixtureStatusLong: schema.fixtures.statusLong,
          leagueId: schema.fixtures.leagueId,
          leagueName: schema.fixtures.leagueName,
          leagueCountry: schema.fixtures.leagueCountry,
          homeTeamId: schema.fixtures.homeTeamId,
          awayTeamId: schema.fixtures.awayTeamId,
          goalsHome: schema.fixtures.goalsHome,
          goalsAway: schema.fixtures.goalsAway,
        })
        .from(schema.predictions)
        .innerJoin(
          schema.fixtures,
          eq(schema.predictions.fixtureId, schema.fixtures.id),
        )
        .where(whereClause)
        .orderBy(asc(schema.fixtures.date), desc(schema.predictions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.predictions)
        .innerJoin(
          schema.fixtures,
          eq(schema.predictions.fixtureId, schema.fixtures.id),
        )
        .where(whereClause),
    ]);

    // ── Batch-fetch team names ──────────────────────────────────────
    const teamIds = new Set<number>();
    for (const row of rows) {
      if (row.homeTeamId) teamIds.add(row.homeTeamId);
      if (row.awayTeamId) teamIds.add(row.awayTeamId);
    }

    const teamMap = new Map<number, { name: string; logo: string | null }>();
    if (teamIds.size > 0) {
      const teamRows = await this.db
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
        );

      for (const t of teamRows) {
        teamMap.set(t.id, { name: t.name, logo: t.logo });
      }
    }

    // ── Shape response: group by fixture, pick best prediction ──────
    const fixtureMap = new Map<number, any>();

    for (const row of rows) {
      const fId = row.fixtureId;

      if (!fixtureMap.has(fId)) {
        const homeTeam = teamMap.get(row.homeTeamId);
        const awayTeam = teamMap.get(row.awayTeamId);

        fixtureMap.set(fId, {
          fixtureId: fId,
          date: row.fixtureDate,
          status: row.fixtureStatus,
          statusLong: row.fixtureStatusLong,
          league: {
            id: row.leagueId,
            name: row.leagueName,
            country: row.leagueCountry,
          },
          homeTeam: homeTeam
            ? { id: row.homeTeamId, ...homeTeam }
            : { id: row.homeTeamId, name: null, logo: null },
          awayTeam: awayTeam
            ? { id: row.awayTeamId, ...awayTeam }
            : { id: row.awayTeamId, name: null, logo: null },
          goalsHome: row.goalsHome,
          goalsAway: row.goalsAway,
          prediction: null as any,
          allPredictions: [] as any[],
        });
      }

      const entry = fixtureMap.get(fId)!;
      entry.allPredictions.push(row.prediction);
    }

    // Pick best prediction per fixture (pre_match > daily > on_demand)
    const typePriority: Record<string, number> = {
      pre_match: 0,
      daily: 1,
      on_demand: 2,
    };

    for (const entry of fixtureMap.values()) {
      entry.allPredictions.sort(
        (a: any, b: any) =>
          (typePriority[a.predictionType] ?? 99) -
          (typePriority[b.predictionType] ?? 99),
      );
      entry.prediction = entry.allPredictions[0] ?? null;
    }

    const data = Array.from(fixtureMap.values());

    return {
      data,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
      dateRange: {
        from: fromDate.toISOString().split('T')[0],
        to: toDate.toISOString().split('T')[0],
      },
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
   * Get a detailed breakdown of prediction performance for a specific day.
   *
   * Returns:
   * - Summary stats: total, correct, incorrect, pending (unresolved), accuracy
   * - Each prediction with: match info, predicted vs actual result, correctness,
   *   confidence, and a link to the Polymarket game (if one exists)
   */
  async getDailyBreakdown(date?: string): Promise<{
    date: string;
    summary: {
      total: number;
      resolved: number;
      correct: number;
      incorrect: number;
      pending: number;
      accuracy: number;
      avgConfidence: number;
      avgBrierScore: number | null;
    };
    byResult: {
      home_win: { predicted: number; correct: number; accuracy: number };
      draw: { predicted: number; correct: number; accuracy: number };
      away_win: { predicted: number; correct: number; accuracy: number };
    };
    predictions: Array<{
      predictionId: number;
      fixtureId: number;
      matchDate: Date;
      matchStatus: string;
      league: { id: number; name: string | null; country: string | null };
      homeTeam: { id: number; name: string | null; logo: string | null };
      awayTeam: { id: number; name: string | null; logo: string | null };
      predicted: {
        result: string;
        homeWinProb: number;
        drawProb: number;
        awayWinProb: number;
        homeGoals: number | null;
        awayGoals: number | null;
        confidence: number | null;
      };
      actual: {
        result: string | null;
        homeGoals: number | null;
        awayGoals: number | null;
      };
      wasCorrect: boolean | null;
      brierScore: number | null;
      predictionType: string;
      polymarketLink: string | null;
      createdAt: Date;
    }>;
  }> {
    const dateStr = date ?? new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${dateStr}T00:00:00Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59Z`);

    // Get all predictions for fixtures on this date
    const rows = await this.db
      .select({
        prediction: schema.predictions,
        fixtureId: schema.fixtures.id,
        fixtureDate: schema.fixtures.date,
        fixtureStatus: schema.fixtures.status,
        leagueId: schema.fixtures.leagueId,
        leagueName: schema.fixtures.leagueName,
        leagueCountry: schema.fixtures.leagueCountry,
        homeTeamId: schema.fixtures.homeTeamId,
        awayTeamId: schema.fixtures.awayTeamId,
        goalsHome: schema.fixtures.goalsHome,
        goalsAway: schema.fixtures.goalsAway,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          gte(schema.fixtures.date, startOfDay),
          lte(schema.fixtures.date, endOfDay),
        ),
      )
      .orderBy(asc(schema.fixtures.date), desc(schema.predictions.createdAt));

    // Deduplicate: keep best prediction per fixture (pre_match > daily > on_demand)
    const typePriority: Record<string, number> = {
      pre_match: 0,
      daily: 1,
      on_demand: 2,
    };
    const fixtureMap = new Map<number, (typeof rows)[0]>();
    for (const row of rows) {
      const existing = fixtureMap.get(row.fixtureId);
      if (
        !existing ||
        (typePriority[row.prediction.predictionType] ?? 99) <
          (typePriority[existing.prediction.predictionType] ?? 99)
      ) {
        fixtureMap.set(row.fixtureId, row);
      }
    }

    const dedupedRows = Array.from(fixtureMap.values());

    // Batch-fetch team names + logos
    const teamIds = new Set<number>();
    for (const row of dedupedRows) {
      if (row.homeTeamId) teamIds.add(row.homeTeamId);
      if (row.awayTeamId) teamIds.add(row.awayTeamId);
    }

    const teamMap = new Map<number, { name: string; logo: string | null }>();
    if (teamIds.size > 0) {
      const teamRows = await this.db
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
        );
      for (const t of teamRows) {
        teamMap.set(t.id, { name: t.name, logo: t.logo });
      }
    }

    // Batch-fetch Polymarket market links for these fixtures
    const fixtureIds = dedupedRows.map((r) => r.fixtureId);
    const polymarketMap = new Map<number, string>();
    if (fixtureIds.length > 0) {
      const marketRows = await this.db
        .select({
          fixtureId: schema.polymarketMarkets.fixtureId,
          eventSlug: schema.polymarketMarkets.eventSlug,
          slug: schema.polymarketMarkets.slug,
        })
        .from(schema.polymarketMarkets)
        .where(
          and(
            sql`${schema.polymarketMarkets.fixtureId} IN (${sql.join(
              fixtureIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            eq(schema.polymarketMarkets.marketType, 'match_outcome'),
          ),
        );

      for (const m of marketRows) {
        if (m.fixtureId && (m.eventSlug || m.slug)) {
          const slug = m.eventSlug || m.slug;
          polymarketMap.set(
            m.fixtureId,
            `https://polymarket.com/event/${slug}`,
          );
        }
      }
    }

    // Build per-prediction results and compute summary
    let totalResolved = 0;
    let totalCorrect = 0;
    let totalIncorrect = 0;
    let totalPending = 0;
    let totalConfidence = 0;
    let confidenceCount = 0;
    let brierSum = 0;
    let brierCount = 0;

    const byResult = {
      home_win: { predicted: 0, correct: 0, accuracy: 0 },
      draw: { predicted: 0, correct: 0, accuracy: 0 },
      away_win: { predicted: 0, correct: 0, accuracy: 0 },
    };

    const predictionDetails = dedupedRows.map((row) => {
      const p = row.prediction;
      const homeProb = Number(p.homeWinProb);
      const drawProb = Number(p.drawProb);
      const awayProb = Number(p.awayWinProb);
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
      }

      if (p.resolvedAt) {
        totalResolved++;
        if (p.wasCorrect === true) {
          totalCorrect++;
          if (
            predictedResult === 'home_win' ||
            predictedResult === 'draw' ||
            predictedResult === 'away_win'
          ) {
            byResult[predictedResult].correct++;
          }
        } else if (p.wasCorrect === false) {
          totalIncorrect++;
        }
      } else {
        totalPending++;
      }

      if (p.confidence != null) {
        totalConfidence += p.confidence;
        confidenceCount++;
      }

      const brier = p.probabilityAccuracy
        ? Number(p.probabilityAccuracy)
        : null;
      if (brier != null) {
        brierSum += brier;
        brierCount++;
      }

      const homeTeam = teamMap.get(row.homeTeamId) ?? {
        name: null,
        logo: null,
      };
      const awayTeam = teamMap.get(row.awayTeamId) ?? {
        name: null,
        logo: null,
      };

      return {
        predictionId: p.id,
        fixtureId: row.fixtureId,
        matchDate: row.fixtureDate,
        matchStatus: row.fixtureStatus,
        league: {
          id: row.leagueId,
          name: row.leagueName,
          country: row.leagueCountry,
        },
        homeTeam: { id: row.homeTeamId, ...homeTeam },
        awayTeam: { id: row.awayTeamId, ...awayTeam },
        predicted: {
          result: predictedResult,
          homeWinProb: homeProb,
          drawProb,
          awayWinProb: awayProb,
          homeGoals: p.predictedHomeGoals ? Number(p.predictedHomeGoals) : null,
          awayGoals: p.predictedAwayGoals ? Number(p.predictedAwayGoals) : null,
          confidence: p.confidence,
        },
        actual: {
          result: p.actualResult ?? null,
          homeGoals: p.actualHomeGoals ?? null,
          awayGoals: p.actualAwayGoals ?? null,
        },
        wasCorrect: p.wasCorrect ?? null,
        brierScore: brier,
        predictionType: p.predictionType,
        polymarketLink: polymarketMap.get(row.fixtureId) ?? null,
        createdAt: p.createdAt,
      };
    });

    // Compute by-result accuracies
    for (const key of Object.keys(byResult) as Array<keyof typeof byResult>) {
      byResult[key].accuracy =
        byResult[key].predicted > 0
          ? byResult[key].correct / byResult[key].predicted
          : 0;
    }

    return {
      date: dateStr,
      summary: {
        total: dedupedRows.length,
        resolved: totalResolved,
        correct: totalCorrect,
        incorrect: totalIncorrect,
        pending: totalPending,
        accuracy: totalResolved > 0 ? totalCorrect / totalResolved : 0,
        avgConfidence:
          confidenceCount > 0
            ? Number((totalConfidence / confidenceCount).toFixed(1))
            : 0,
        avgBrierScore:
          brierCount > 0 ? Number((brierSum / brierCount).toFixed(6)) : null,
      },
      byResult,
      predictions: predictionDetails,
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
        .limit(500); // Last 500 resolved predictions for better statistical reliability

      if (resolved.length < 5) {
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
      // Use tighter thresholds (3% instead of 5%) to catch biases earlier
      if (avgDrawProb < actualDrawPct - 0.03) {
        biasInsights.push(
          `CRITICAL: You have been UNDERESTIMATING draw probability. Your average draw prob is ${(avgDrawProb * 100).toFixed(1)}% but draws actually occur ${(actualDrawPct * 100).toFixed(1)}% of the time. Increase draw probability by at least ${((actualDrawPct - avgDrawProb) * 100).toFixed(1)} percentage points.`,
        );
      }
      if (avgDrawProb > actualDrawPct + 0.03) {
        biasInsights.push(
          `You have been OVERESTIMATING draw probability. Your average is ${(avgDrawProb * 100).toFixed(1)}% but draws actually occur ${(actualDrawPct * 100).toFixed(1)}% of the time.`,
        );
      }
      if (avgHomeProb > actualHomePct + 0.03) {
        biasInsights.push(
          `CRITICAL: You have been OVERESTIMATING home win probability. Your average is ${(avgHomeProb * 100).toFixed(1)}% but home wins occur ${(actualHomePct * 100).toFixed(1)}% of the time. Reduce home win probability by at least ${((avgHomeProb - actualHomePct) * 100).toFixed(1)} percentage points.`,
        );
      }
      if (avgHomeProb < actualHomePct - 0.03) {
        biasInsights.push(
          `You have been UNDERESTIMATING home win probability. Your average is ${(avgHomeProb * 100).toFixed(1)}% but home wins occur ${(actualHomePct * 100).toFixed(1)}% of the time.`,
        );
      }
      if (avgAwayProb > actualAwayPct + 0.03) {
        biasInsights.push(
          `You have been OVERESTIMATING away win probability. Your average is ${(avgAwayProb * 100).toFixed(1)}% but away wins occur ${(actualAwayPct * 100).toFixed(1)}% of the time. Reduce away win probability by at least ${((avgAwayProb - actualAwayPct) * 100).toFixed(1)} percentage points.`,
        );
      }
      if (avgAwayProb < actualAwayPct - 0.03) {
        biasInsights.push(
          `You have been UNDERESTIMATING away win probability. Your average is ${(avgAwayProb * 100).toFixed(1)}% but away wins occur ${(actualAwayPct * 100).toFixed(1)}% of the time.`,
        );
      }

      // Check for draw prediction rate (separate from probability)
      const drawPredRate =
        byResult.draw.predicted > 0 ? byResult.draw.predicted / total : 0;
      if (drawPredRate < 0.15) {
        biasInsights.push(
          `CRITICAL: You are only predicting draws ${(drawPredRate * 100).toFixed(1)}% of the time, but draws occur ${(actualDrawPct * 100).toFixed(1)}% of the time. You are missing ~${((actualDrawPct - drawPredRate) * total).toFixed(0)} draw outcomes. Increase draw predictions significantly.`,
        );
      }

      // Check for overconfident favorite predictions
      const homeWinAcc =
        byResult.home_win.predicted > 0
          ? byResult.home_win.correct / byResult.home_win.predicted
          : 0;
      const awayWinAcc =
        byResult.away_win.predicted > 0
          ? byResult.away_win.correct / byResult.away_win.predicted
          : 0;
      if (homeWinAcc < 0.45 && byResult.home_win.predicted > 10) {
        biasInsights.push(
          `Your home win predictions are only ${(homeWinAcc * 100).toFixed(1)}% accurate. You are predicting too many home wins. Be more conservative — consider draw predictions for close matches.`,
        );
      }
      if (awayWinAcc < 0.35 && byResult.away_win.predicted > 10) {
        biasInsights.push(
          `Your away win predictions are only ${(awayWinAcc * 100).toFixed(1)}% accurate. You are predicting too many away wins. Consider draws more often.`,
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

      if (confidenceBuckets.high.total > 3 && highAcc < 0.55) {
        biasInsights.push(
          `CRITICAL: High-confidence predictions (8-10) are only ${(highAcc * 100).toFixed(1)}% accurate (${confidenceBuckets.high.correct}/${confidenceBuckets.high.total}). You are SEVERELY OVERCONFIDENT. Reserve high confidence for genuinely clear-cut matches only.`,
        );
      }
      if (confidenceBuckets.high.total > 3 && highAcc < 0.7) {
        biasInsights.push(
          `High-confidence predictions (8-10) are ${(highAcc * 100).toFixed(1)}% accurate. For confidence 8-10 to be meaningful, accuracy should be >70%. Lower your confidence scores.`,
        );
      }
      if (confidenceBuckets.low.total > 3 && lowAcc > medAcc) {
        biasInsights.push(
          `Low-confidence predictions (${(lowAcc * 100).toFixed(1)}%) are more accurate than medium-confidence ones (${(medAcc * 100).toFixed(1)}%). Your confidence scoring is inverted — recalibrate.`,
        );
      }

      // Overall accuracy warning
      const overallAcc = correct / total;
      if (overallAcc < 0.4) {
        biasInsights.push(
          `CRITICAL: Overall accuracy is only ${(overallAcc * 100).toFixed(1)}%. This is BELOW RANDOM for 3-way prediction (~33%). Your model has systematic biases. Focus on: (1) predicting more draws, (2) being less confident in favorites, (3) using base rates as anchors.`,
        );
      } else if (overallAcc < 0.5) {
        biasInsights.push(
          `Overall accuracy is ${(overallAcc * 100).toFixed(1)}%. Target is >50%. Focus on improving draw detection and reducing overconfidence in favorites.`,
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
        if (data.total >= 3 && acc < 0.35) {
          biasInsights.push(
            `POOR performance in ${name}: ${(acc * 100).toFixed(1)}% accuracy over ${data.total} predictions. This league may have different dynamics (different draw rates, home advantage, etc.). Adjust your priors.`,
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

  // ─── Supermemory helpers ─────────────────────────────────────────────

  /**
   * Store a resolved prediction as a Supermemory memory.
   * Fetches team names for readable memory content.
   */
  private async storeResolutionMemory(
    prediction: any,
    fixture: any,
    resolution: {
      predictedResult: string;
      actualResult: string;
      wasCorrect: boolean;
      brierScore: number;
      homeProb: number;
      drawProb: number;
      awayProb: number;
    },
  ): Promise<void> {
    // Fetch team names
    const teamIds = [fixture.homeTeamId, fixture.awayTeamId].filter(Boolean);
    const teamRows =
      teamIds.length > 0
        ? await this.db
            .select({ id: schema.teams.id, name: schema.teams.name })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                teamIds.map((id: number) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [];

    const teamMap = new Map<number, string>();
    for (const t of teamRows) {
      teamMap.set(t.id, t.name);
    }

    await this.predictionMemory.storeResolvedPrediction({
      predictionId: prediction.id,
      fixtureId: prediction.fixtureId,
      homeTeamName:
        teamMap.get(fixture.homeTeamId) ?? `Team ${fixture.homeTeamId}`,
      awayTeamName:
        teamMap.get(fixture.awayTeamId) ?? `Team ${fixture.awayTeamId}`,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      leagueId: fixture.leagueId,
      leagueName: fixture.leagueName ?? `League ${fixture.leagueId}`,
      round: fixture.round,
      matchDate: fixture.date,
      predictedResult: resolution.predictedResult,
      actualResult: resolution.actualResult,
      wasCorrect: resolution.wasCorrect,
      homeWinProb: resolution.homeProb,
      drawProb: resolution.drawProb,
      awayWinProb: resolution.awayProb,
      predictedHomeGoals: Number(prediction.predictedHomeGoals),
      predictedAwayGoals: Number(prediction.predictedAwayGoals),
      actualHomeGoals: fixture.goalsHome,
      actualAwayGoals: fixture.goalsAway,
      confidence: prediction.confidence ?? 5,
      brierScore: resolution.brierScore,
      keyFactors: prediction.keyFactors,
      riskFactors: prediction.riskFactors,
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Ensemble Claude's prediction with Poisson model and bookmaker consensus.
   *
   * KEY INSIGHT: While bookmaker closing odds are well-calibrated for probabilities,
   * they are NOT optimised for 1X2 prediction accuracy. Their draw probabilities
   * are often accurate but always "second place" to a win outcome — meaning a
   * pure bookmaker-weighted model structurally under-predicts draws.
   *
   * Rebalanced weights (v2 — addresses favourite bias):
   * - Bookmaker consensus: 40% — still the best-calibrated signal but reduced
   *   to prevent the system from just echoing the market favourite
   * - Poisson model: 30% — mathematical, xG-based, independent from market
   * - Claude (LLM analysis): 30% — contextual reasoning (injuries, motivation,
   *   tactical matchups, form) that bookmakers price in slowly
   *
   * Giving Claude more weight allows qualitative factors (e.g. a key goalkeeper
   * injury, dead-rubber motivation, derby intensity) to shift predictions away
   * from the bookmaker favourite when warranted.
   *
   * If any signal is unavailable, weights are redistributed proportionally.
   */
  private ensemblePredictions(
    claudePrediction: PredictionOutput,
    poissonOutput: PoissonModelOutput | null,
    matchData: CollectedMatchData,
  ): PredictionOutput {
    // Rebalanced weights v2: less bookmaker dominance, more contextual analysis
    const baseBookmakerWeight = 0.4;
    const basePoissonWeight = 0.3;
    const baseClaudeWeight = 0.3;

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
      // All three signals available — use evidence-based weights
      // Scale Poisson weight by its confidence, but use a floor so it always
      // contributes meaningfully (minimum 50% of its base weight)
      const poissonConfMultiplier = Math.max(
        0.5,
        Math.min(1.0, poissonOutput!.confidence * 1.5),
      );
      claudeWeight = baseClaudeWeight;
      poissonWeight = basePoissonWeight * poissonConfMultiplier;
      bookmakerWeight = baseBookmakerWeight;
    } else if (hasPoissonData && !hasBookmakerData) {
      // No bookmaker data — Poisson takes the lead, Claude secondary
      const poissonConfMultiplier = Math.max(
        0.5,
        Math.min(1.0, poissonOutput!.confidence * 1.5),
      );
      claudeWeight = 0.35;
      poissonWeight = 0.65 * poissonConfMultiplier;
      bookmakerWeight = 0;
    } else if (!hasPoissonData && hasBookmakerData) {
      // No Poisson data — avoid fully shadowing Claude with market priors.
      // Heavy bookmaker dominance tended to over-pick favourites and suppress draws.
      claudeWeight = 0.45;
      poissonWeight = 0;
      bookmakerWeight = 0.55;
    } else {
      // Only Claude available — worst case, use historical calibration adjustment
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
    let total = homeWinProb + drawProb + awayWinProb;
    homeWinProb /= total;
    drawProb /= total;
    awayWinProb /= total;

    // ── Post-ensemble calibration: draw floor adjustment ──────────────
    // Football draws occur ~25-28% of the time across major leagues.
    // Both LLMs and naive models systematically underestimate draw probability.
    //
    // Two-tier floor:
    // - Tier 1 (close matches, max win < 0.50): draw floor = 0.25
    //   These matches are genuinely uncertain; draws are common (~30%+)
    // - Tier 2 (moderate matches, max win < 0.60): draw floor = 0.23
    //   Slight favourite, but draw is still realistic (~25%)
    // - Tier 3 (clear favourite, max win >= 0.60): draw floor = 0.20
    //   Only extreme mismatches should have draw below this
    const dominantProb = Math.max(homeWinProb, awayWinProb);
    let drawFloor: number;
    if (dominantProb < 0.5) {
      drawFloor = 0.25; // Close match — draws very common
    } else if (dominantProb < 0.6) {
      drawFloor = 0.23; // Moderate favourite — draw still realistic
    } else {
      drawFloor = 0.2; // Clear favourite — lower draw floor
    }

    // Context-aware draw uplift for parity matches.
    // These are high-draw profiles that pure probability blending often misses.
    const homePos = Number(matchData.standings?.home?.leaguePosition ?? 0);
    const awayPos = Number(matchData.standings?.away?.leaguePosition ?? 0);
    if (homePos > 0 && awayPos > 0) {
      const posGap = Math.abs(homePos - awayPos);
      if (posGap <= 3) {
        drawFloor = Math.max(drawFloor, 0.28);
      } else if (posGap <= 5) {
        drawFloor = Math.max(drawFloor, 0.26);
      }
    }

    const homeXgDiff =
      (matchData.recentStats?.home?.averages?.xG ?? 0) -
      (matchData.recentStats?.home?.averages?.xGA ?? 0);
    const awayXgDiff =
      (matchData.recentStats?.away?.averages?.xG ?? 0) -
      (matchData.recentStats?.away?.averages?.xGA ?? 0);
    if (homeXgDiff !== 0 || awayXgDiff !== 0) {
      const xgGap = Math.abs(homeXgDiff - awayXgDiff);
      if (xgGap < 0.2) {
        drawFloor = Math.max(drawFloor, 0.27);
      } else if (xgGap < 0.35) {
        drawFloor = Math.max(drawFloor, 0.25);
      }
    }

    if (drawProb < drawFloor) {
      // Draw is underweighted — apply stronger calibration with 85% gap closure
      const drawBoost = (drawFloor - drawProb) * 0.85;
      drawProb += drawBoost;
      // Subtract proportionally from home and away
      const homeShare = homeWinProb / (homeWinProb + awayWinProb);
      homeWinProb -= drawBoost * homeShare;
      awayWinProb -= drawBoost * (1 - homeShare);

      // Re-normalize
      total = homeWinProb + drawProb + awayWinProb;
      homeWinProb /= total;
      drawProb /= total;
      awayWinProb /= total;
    }

    // ── Competitive-match dampening ───────────────────────────────────
    // When the favourite's probability is modest (< 0.50), the match is
    // genuinely uncertain. Dampen toward equal probabilities to avoid
    // false confidence in a marginal favourite.
    let maxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    if (maxProb < 0.5 && maxProb > 0.38) {
      // Tight match — pull probabilities 5% toward the mean (1/3)
      const dampeningFactor = 0.95;
      const mean = 1 / 3;
      homeWinProb =
        homeWinProb * dampeningFactor + mean * (1 - dampeningFactor);
      drawProb = drawProb * dampeningFactor + mean * (1 - dampeningFactor);
      awayWinProb =
        awayWinProb * dampeningFactor + mean * (1 - dampeningFactor);

      // Re-normalize
      total = homeWinProb + drawProb + awayWinProb;
      homeWinProb /= total;
      drawProb /= total;
      awayWinProb /= total;

      maxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    }

    // ── Overconfidence dampening ──────────────────────────────────────
    // If any single outcome probability exceeds 0.65, dampen it.
    // Even heavy favorites lose 20-25% of the time.
    if (maxProb > 0.65) {
      const dampeningFactor = 0.9; // Pull extreme probs 10% toward the mean
      const mean = 1 / 3;
      homeWinProb =
        homeWinProb * dampeningFactor + mean * (1 - dampeningFactor);
      drawProb = drawProb * dampeningFactor + mean * (1 - dampeningFactor);
      awayWinProb =
        awayWinProb * dampeningFactor + mean * (1 - dampeningFactor);

      // Re-normalize
      total = homeWinProb + drawProb + awayWinProb;
      homeWinProb /= total;
      drawProb /= total;
      awayWinProb /= total;
    }

    // Blend expected goals (Poisson model is better calibrated for goals)
    let predictedHomeGoals = claudePrediction.predictedHomeGoals;
    let predictedAwayGoals = claudePrediction.predictedAwayGoals;
    if (hasPoissonData) {
      // Poisson model should dominate goal expectations
      const poissonGoalWeight = 0.65;
      predictedHomeGoals =
        (1 - poissonGoalWeight) * claudePrediction.predictedHomeGoals +
        poissonGoalWeight * poissonOutput!.expectedHomeGoals;
      predictedAwayGoals =
        (1 - poissonGoalWeight) * claudePrediction.predictedAwayGoals +
        poissonGoalWeight * poissonOutput!.expectedAwayGoals;
    }

    // ── Confidence adjustment ─────────────────────────────────────────
    // Confidence should correlate with actual prediction difficulty, not
    // just Claude's self-assessment. We use multiple signals:
    //
    // 1. Signal agreement: do Claude, Poisson, and bookmakers agree?
    // 2. Match decisiveness: how much higher is the favourite vs alternatives?
    // 3. Probability magnitude: is any outcome clearly dominant?
    //
    // Tight matches (max prob < 0.45) should NEVER have confidence > 5
    // because the model is essentially guessing between three close outcomes.
    let adjustedConfidence = claudePrediction.confidence;

    // Decisiveness penalty: tight matches get lower confidence
    const ensembleMaxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    if (ensembleMaxProb < 0.4) {
      // Very tight match — cap confidence at 4
      adjustedConfidence = Math.min(adjustedConfidence, 4);
    } else if (ensembleMaxProb < 0.48) {
      // Competitive match — cap confidence at 5
      adjustedConfidence = Math.min(adjustedConfidence, 5);
    } else if (ensembleMaxProb < 0.55) {
      // Moderate favourite — cap confidence at 6
      adjustedConfidence = Math.min(adjustedConfidence, 6);
    }

    if (hasBookmakerData) {
      // Check if Claude and bookmakers agree on the likely outcome
      const claudePredResult = this.getArgmax(
        claudePrediction.homeWinProb,
        claudePrediction.drawProb,
        claudePrediction.awayWinProb,
      );
      const bookPredResult = this.getArgmax(
        bookmakerProbs!.home,
        bookmakerProbs!.draw,
        bookmakerProbs!.away,
      );

      if (claudePredResult !== bookPredResult) {
        // Claude and bookmakers disagree on the outcome — reduce confidence
        adjustedConfidence = Math.max(3, adjustedConfidence - 2);
      } else {
        // They agree — but check probability divergence
        const claudeMaxOutcome = Math.max(
          claudePrediction.homeWinProb,
          claudePrediction.drawProb,
          claudePrediction.awayWinProb,
        );
        const bookmakerMaxOutcome = Math.max(
          bookmakerProbs!.home,
          bookmakerProbs!.draw,
          bookmakerProbs!.away,
        );
        const probDivergence = Math.abs(claudeMaxOutcome - bookmakerMaxOutcome);
        if (probDivergence > 0.15) {
          // Large disagreement on probability magnitude
          adjustedConfidence = Math.max(4, adjustedConfidence - 1);
        }
      }

      // Poisson agreement bonus: if all three signals point the same way, +1
      if (hasPoissonData) {
        const poissonPredResult = this.getArgmax(
          poissonOutput!.homeWinProb,
          poissonOutput!.drawProb,
          poissonOutput!.awayWinProb,
        );
        if (
          claudePredResult === bookPredResult &&
          claudePredResult === poissonPredResult &&
          ensembleMaxProb >= 0.5
        ) {
          // All three signals agree AND the prediction is reasonably decisive
          adjustedConfidence = Math.min(8, adjustedConfidence + 1);
        }
      }
    }

    this.logger.log(
      `Ensemble: Bookmaker(${(bookmakerWeight * 100).toFixed(0)}%) + ` +
        `Poisson(${(poissonWeight * 100).toFixed(0)}%) + ` +
        `Claude(${(claudeWeight * 100).toFixed(0)}%) → ` +
        `H=${(homeWinProb * 100).toFixed(1)}% D=${(drawProb * 100).toFixed(1)}% A=${(awayWinProb * 100).toFixed(1)}% ` +
        `(conf: ${claudePrediction.confidence}→${adjustedConfidence})`,
    );

    return {
      ...claudePrediction,
      homeWinProb: Number(homeWinProb.toFixed(4)),
      drawProb: Number(drawProb.toFixed(4)),
      awayWinProb: Number(awayWinProb.toFixed(4)),
      predictedHomeGoals: Number(predictedHomeGoals.toFixed(1)),
      predictedAwayGoals: Number(predictedAwayGoals.toFixed(1)),
      confidence: adjustedConfidence,
    };
  }

  /**
   * Get the argmax outcome from three probabilities.
   */
  private getArgmax(
    homeProb: number,
    drawProb: number,
    awayProb: number,
  ): string {
    if (homeProb >= drawProb && homeProb >= awayProb) return 'home_win';
    if (awayProb >= homeProb && awayProb >= drawProb) return 'away_win';
    return 'draw';
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
    // Lock in the predicted result at prediction time — never re-derived later
    const predictedResult = this.getPredictedResult(prediction);

    const values = {
      fixtureId,
      homeTeamId: data.fixture.homeTeamId,
      awayTeamId: data.fixture.awayTeamId,
      homeWinProb: String(prediction.homeWinProb),
      drawProb: String(prediction.drawProb),
      awayWinProb: String(prediction.awayWinProb),
      predictedHomeGoals: String(prediction.predictedHomeGoals),
      predictedAwayGoals: String(prediction.predictedAwayGoals),
      predictedResult,
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
      predictionStatus: 'pending' as const,
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
      seasonRematch: data.seasonRematch,
      homeTeam: data.homeTeam?.team?.name ?? null,
      awayTeam: data.awayTeam?.team?.name ?? null,
      overallFormWindows: data.formWindows,
      opponentStrength: data.opponentStrength,
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

  /**
   * Determine the predicted result from probabilities.
   *
   * Uses a multi-criteria draw-aware strategy because:
   * - In football, ~25-28% of matches end in draws
   * - Draw probability rarely exceeds BOTH home and away in a 3-way split
   * - Models systematically under-predict draws, missing ~25% of correct answers
   *
   * Strategy (layered, from most to least aggressive draw prediction):
   * Match-type aware prediction logic that accounts for football's true draw rate.
   *
   * Pure argmax predicts draws <10% of the time, but draws occur ~26% in reality.
   * This is because draw probability is distributed across ALL matches but rarely
   * becomes the single highest outcome. We need match-type classification:
   *
   * TIGHT MATCH (max win prob < 0.45):
   *   → Predict draw if drawProb >= 0.26 (matches are genuinely uncertain)
   *
   * COMPETITIVE MATCH (max win prob 0.45-0.55):
   *   → Predict draw if drawProb >= 0.28 AND win spread < 0.10
   *   → The slight favourite could easily draw
   *
   * CLEAR FAVOURITE (max win prob > 0.55):
   *   → Only predict draw if drawProb is actually highest (argmax)
   *   → Strong favourites do usually win, draw is less likely
   *
   * This produces ~20-28% draw predictions, matching the true ~26% base rate.
   */
  private getPredictedResultFromProbs(
    homeProb: number,
    drawProb: number,
    awayProb: number,
  ): string {
    // 1. If draw is already the highest probability, always predict draw
    if (drawProb >= homeProb && drawProb >= awayProb) {
      return 'draw';
    }

    const maxWinProb = Math.max(homeProb, awayProb);
    const winSpread = Math.abs(homeProb - awayProb);

    // 2. VERY TIGHT MATCH: no clear favourite (max win prob < 0.43)
    //    AND draw is within 6pp of the leader AND draw is >= 0.27
    //    These are genuinely uncertain matches — all three outcomes equally viable
    if (maxWinProb < 0.43 && drawProb >= 0.27 && maxWinProb - drawProb < 0.06) {
      return 'draw';
    }

    // 3. COMPETITIVE MATCH: slight favourite (max win prob up to 0.53)
    //    Predict draw when teams are close and draw is meaningfully high.
    if (maxWinProb <= 0.53 && winSpread < 0.08 && drawProb >= 0.28) {
      return 'draw';
    }

    // 4. MODERATE FAVOURITE: still allow draw when it is very close to the leader.
    if (maxWinProb <= 0.58 && drawProb >= 0.3 && maxWinProb - drawProb < 0.03) {
      return 'draw';
    }

    // 5. Otherwise, pick the higher of home or away
    if (homeProb >= awayProb) return 'home_win';
    return 'away_win';
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

  /**
   * Blends the main prediction with first-principles re-estimate and applies
   * critic-derived confidence penalty and risk annotations.
   */
  private applyChallengePass(
    base: PredictionOutput,
    firstPrinciples: FirstPrinciplesOutput | null,
    critic: CriticOutput | null,
  ): PredictionOutput {
    let home = base.homeWinProb;
    let draw = base.drawProb;
    let away = base.awayWinProb;

    if (firstPrinciples) {
      const wBase = 0.75;
      const wFp = 0.25;
      home = home * wBase + firstPrinciples.homeWinProb * wFp;
      draw = draw * wBase + firstPrinciples.drawProb * wFp;
      away = away * wBase + firstPrinciples.awayWinProb * wFp;
    }

    const total = home + draw + away;
    if (total > 0) {
      home /= total;
      draw /= total;
      away /= total;
    }

    let confidence = base.confidence;
    if (firstPrinciples) {
      confidence =
        Math.round((confidence * 0.7 + firstPrinciples.confidence * 0.3) * 10) /
        10;
    }
    if (critic) {
      confidence = confidence - critic.confidencePenalty;
    }

    const keyFactors = [...base.keyFactors];
    const riskFactors = [...base.riskFactors];

    if (firstPrinciples?.rationale?.length) {
      for (const r of firstPrinciples.rationale.slice(0, 2)) {
        keyFactors.push(`First-principles check: ${r}`);
      }
    }

    if (critic?.concerns?.length) {
      for (const c of critic.concerns.slice(0, 3)) {
        riskFactors.push(`Critic concern: ${c}`);
      }
    }

    if (critic?.missedFactors?.length) {
      for (const m of critic.missedFactors.slice(0, 2)) {
        riskFactors.push(`Potential missed factor: ${m}`);
      }
    }

    const lines: string[] = [base.detailedAnalysis];
    if (firstPrinciples) {
      lines.push(
        `First-principles cross-check blended at 25%: H=${firstPrinciples.homeWinProb.toFixed(2)} D=${firstPrinciples.drawProb.toFixed(2)} A=${firstPrinciples.awayWinProb.toFixed(2)} (conf ${firstPrinciples.confidence}/10).`,
      );
    }
    if (critic) {
      lines.push(
        `Critic review verdict=${critic.verdict}, confidence penalty=${critic.confidencePenalty.toFixed(1)}.`,
      );
    }

    return {
      ...base,
      homeWinProb: Number(home.toFixed(4)),
      drawProb: Number(draw.toFixed(4)),
      awayWinProb: Number(away.toFixed(4)),
      confidence: Math.max(1, Math.min(10, Math.round(confidence))),
      keyFactors: keyFactors.slice(0, 8),
      riskFactors: riskFactors.slice(0, 8),
      detailedAnalysis: lines.join(' '),
    };
  }
}
