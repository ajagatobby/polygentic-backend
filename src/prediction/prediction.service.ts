import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import {
  predictions,
  marketFixtureLinks,
  polymarketMarkets,
  fixtures,
  consensusOdds,
  teamForm,
  injuries,
} from '../database/schema';
import { MispricingService, MispricingResult } from './mispricing.service';
import {
  StatisticalModelService,
  StatisticalProbability,
} from './statistical-model.service';
import { ConfidenceService, ConfidenceInput } from './confidence.service';
import { PredictionQueryDto, Recommendation } from './dto/prediction-query.dto';

@Injectable()
export class PredictionService {
  private readonly logger = new Logger(PredictionService.name);

  private readonly weightMispricing: number;
  private readonly weightStatistical: number;
  private readonly weightApiFootball: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly mispricingService: MispricingService,
    private readonly statisticalModelService: StatisticalModelService,
    private readonly confidenceService: ConfidenceService,
    @Inject('DRIZZLE') private db: any,
  ) {
    this.weightMispricing = this.configService.get<number>(
      'PREDICTION_SIGNAL_WEIGHT_MISPRICING',
      0.4,
    );
    this.weightStatistical = this.configService.get<number>(
      'PREDICTION_SIGNAL_WEIGHT_STATISTICAL',
      0.35,
    );
    this.weightApiFootball = this.configService.get<number>(
      'PREDICTION_SIGNAL_WEIGHT_API_FOOTBALL',
      0.25,
    );
  }

  // ─── Public Methods ──────────────────────────────────────────────────

  /**
   * Generate predictions for all matched markets that don't have
   * a recent active prediction.
   */
  async generatePredictions(): Promise<{
    predictionsGenerated: number;
    marketsProcessed: number;
    errors: string[];
  }> {
    this.logger.log('Starting prediction generation');

    // Get all market-fixture links
    const links = await this.db
      .select()
      .from(marketFixtureLinks)
      .orderBy(desc(marketFixtureLinks.createdAt));

    let predictionsGenerated = 0;
    let marketsProcessed = 0;
    const errors: string[] = [];

    for (const link of links) {
      try {
        marketsProcessed++;
        const prediction = await this.generatePrediction(link);
        if (prediction) {
          predictionsGenerated++;
        }
      } catch (err) {
        const msg = `Failed to generate prediction for market ${link.polymarketMarketId}: ${err.message}`;
        this.logger.warn(msg);
        errors.push(msg);
      }
    }

    this.logger.log(
      `Prediction generation complete: ${predictionsGenerated} predictions from ${marketsProcessed} markets`,
    );

    return {
      predictionsGenerated,
      marketsProcessed,
      errors: errors.length > 0 ? errors : [],
    };
  }

  /**
   * Generate a prediction for a single matched market-fixture link.
   */
  async generatePrediction(link: any): Promise<any | null> {
    const marketId = link.polymarketMarketId as string;
    const fixtureId = link.fixtureId as number | null;
    const oddsEventId = link.oddsApiEventId as string | null;
    const matchType = link.matchType as string;
    const mappedOutcome = (link.mappedOutcome as string) || 'home_win';

    // Load market
    const [market] = await this.db
      .select()
      .from(polymarketMarkets)
      .where(eq(polymarketMarkets.id, marketId))
      .limit(1);

    if (!market || market.closed) {
      return null;
    }

    // Get current Polymarket price
    const polymarketPrice = this.extractPolymarketPrice(market);
    if (polymarketPrice <= 0) {
      this.logger.debug(`No valid price for market ${marketId}`);
      return null;
    }

    // ─── Signal 1: Mispricing Detection (Weight: 40%) ──────────────────
    let mispricingResult: MispricingResult | null = null;
    let consensusProb: number | null = null;
    let pinnacleProb: number | null = null;
    let numBookmakers: number | null = null;

    if (oddsEventId) {
      mispricingResult = await this.mispricingService.calculateMispricingSignal(
        marketId,
        oddsEventId,
        mappedOutcome,
      );

      if (mispricingResult) {
        consensusProb = mispricingResult.consensusProbability;
      }

      // Get Pinnacle-specific probability
      const consensusRows = await this.db
        .select()
        .from(consensusOdds)
        .where(eq(consensusOdds.oddsApiEventId, oddsEventId))
        .orderBy(desc(consensusOdds.calculatedAt))
        .limit(1);

      if (consensusRows.length > 0) {
        const c = consensusRows[0];
        numBookmakers = c.numBookmakers;

        switch (mappedOutcome) {
          case 'home_win':
            pinnacleProb = c.pinnacleHomeWin
              ? parseFloat(String(c.pinnacleHomeWin))
              : null;
            break;
          case 'draw':
            pinnacleProb = c.pinnacleDraw
              ? parseFloat(String(c.pinnacleDraw))
              : null;
            break;
          case 'away_win':
            pinnacleProb = c.pinnacleAwayWin
              ? parseFloat(String(c.pinnacleAwayWin))
              : null;
            break;
        }
      }
    }

    // ─── Signal 2: Statistical Model (Weight: 35%) ─────────────────────
    let statisticalProb: number | null = null;
    let statResult: StatisticalProbability | null = null;

    if (fixtureId && ['match_outcome', 'over_under'].includes(matchType)) {
      statResult =
        await this.statisticalModelService.calculateProbability(fixtureId);

      if (statResult) {
        switch (mappedOutcome) {
          case 'home_win':
            statisticalProb = statResult.homeWin;
            break;
          case 'away_win':
            statisticalProb = statResult.awayWin;
            break;
          case 'draw':
            statisticalProb = statResult.draw;
            break;
          default:
            statisticalProb = statResult.homeWin;
        }
      }
    }

    // ─── Signal 3: API-Football Prediction (Weight: 25%) ───────────────
    // This signal would come from stored API-Football prediction data.
    // For now, we check if the fixture has prediction data stored.
    const apiFootballProb: number | null = null;
    // API-Football predictions would be loaded from a predictions table
    // if available. This is a placeholder for future integration.

    // ─── Combine Signals ───────────────────────────────────────────────
    const predictedProbability = this.combineSignals(
      matchType,
      mispricingResult?.consensusProbability ?? null,
      statisticalProb,
      apiFootballProb,
    );

    // ─── Confidence Scoring ────────────────────────────────────────────
    let daysToEvent: number | null = null;
    let hasInjuryData = false;
    let hasFormData = false;
    let hasH2HData =
      statResult?.h2hScore !== undefined && statResult?.h2hScore !== 0.5;

    if (fixtureId) {
      const [fixture] = await this.db
        .select()
        .from(fixtures)
        .where(eq(fixtures.id, fixtureId))
        .limit(1);

      if (fixture?.date) {
        const eventDate = new Date(fixture.date);
        daysToEvent =
          (eventDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      }

      // Check for injury data
      const injuryCount = await this.db
        .select({ count: sql`count(*)` })
        .from(injuries)
        .where(eq(injuries.teamId, fixture?.homeTeamId ?? 0));
      hasInjuryData = (injuryCount[0]?.count ?? 0) > 0;

      // Check for form data
      const formCount = await this.db
        .select({ count: sql`count(*)` })
        .from(teamForm)
        .where(eq(teamForm.teamId, fixture?.homeTeamId ?? 0));
      hasFormData = (formCount[0]?.count ?? 0) > 0;
    }

    const confidenceInput: ConfidenceInput = {
      mispricingGap: mispricingResult?.gap ?? null,
      mispricingDirection: mispricingResult?.direction ?? null,
      statisticalProb,
      consensusProb,
      apiFootballProb,
      liquidity: market.liquidity ? parseFloat(String(market.liquidity)) : null,
      volume: market.volume ? parseFloat(String(market.volume)) : null,
      daysToEvent,
      numBookmakers,
      hasInjuryData,
      hasFormData,
      hasH2HData,
    };

    const confidenceResult =
      this.confidenceService.calculateConfidence(confidenceInput);

    const recommendation = this.confidenceService.getRecommendation(
      confidenceResult.score,
      mispricingResult?.gap ?? null,
    );

    // ─── Build reasoning text ──────────────────────────────────────────
    const reasoning = this.buildReasoning(
      mispricingResult,
      statisticalProb,
      apiFootballProb,
      confidenceResult,
      recommendation,
      mappedOutcome,
    );

    // ─── Store prediction ──────────────────────────────────────────────
    const predictionValues = {
      polymarketMarketId: marketId,
      fixtureId,
      polymarketPrice: polymarketPrice.toFixed(4),
      bookmakerConsensus: consensusProb?.toFixed(4) ?? null,
      pinnacleProbability: pinnacleProb?.toFixed(4) ?? null,
      statisticalModelProb: statisticalProb?.toFixed(4) ?? null,
      apiFootballPrediction: apiFootballProb?.toFixed(4) ?? null,
      predictedProbability: predictedProbability.toFixed(4),
      mispricingGap: mispricingResult?.gap?.toFixed(4) ?? null,
      mispricingPct: mispricingResult?.pct?.toFixed(4) ?? null,
      confidenceScore: confidenceResult.score,
      recommendation,
      reasoning,
      signals: {
        mispricing: mispricingResult
          ? {
              gap: mispricingResult.gap,
              pct: mispricingResult.pct,
              direction: mispricingResult.direction,
              strength: mispricingResult.signalStrength,
            }
          : null,
        statistical: statResult
          ? {
              homeWin: statResult.homeWin,
              draw: statResult.draw,
              awayWin: statResult.awayWin,
              components: {
                form: statResult.formScore,
                homeAway: statResult.homeAwayFactor,
                h2h: statResult.h2hScore,
                goals: statResult.goalModel,
                injury: statResult.injuryImpact,
                position: statResult.positionContext,
              },
            }
          : null,
        apiFootball: apiFootballProb,
        confidence: confidenceResult,
      },
      isLive: false,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const [inserted] = await this.db
      .insert(predictions)
      .values(predictionValues)
      .returning();

    this.logger.debug(
      `Prediction #${inserted.id}: ${recommendation} (confidence: ${confidenceResult.score}, gap: ${mispricingResult?.gap?.toFixed(3) ?? 'N/A'})`,
    );

    return inserted;
  }

  /**
   * Query stored predictions with optional filters.
   */
  async getPredictions(filters?: PredictionQueryDto) {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (filters?.recommendation) {
      conditions.push(eq(predictions.recommendation, filters.recommendation));
    }

    if (filters?.minConfidence != null) {
      conditions.push(gte(predictions.confidenceScore, filters.minConfidence));
    }

    if (filters?.status) {
      conditions.push(eq(predictions.status, filters.status));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const results = await this.db
      .select()
      .from(predictions)
      .where(whereClause)
      .orderBy(desc(predictions.confidenceScore))
      .limit(limit)
      .offset(offset);

    return results;
  }

  /**
   * Get predictions with significant mispricings.
   */
  async getMispricings(minGap: number = 0.05) {
    const results = await this.db
      .select()
      .from(predictions)
      .where(
        and(
          eq(predictions.status, 'active'),
          sql`ABS(CAST(${predictions.mispricingGap} AS NUMERIC)) >= ${minGap}`,
        ),
      )
      .orderBy(sql`ABS(CAST(${predictions.mispricingGap} AS NUMERIC)) DESC`);

    return results;
  }

  /**
   * Get a single prediction by ID with related market and fixture data.
   */
  async getPredictionById(id: number) {
    const [prediction] = await this.db
      .select()
      .from(predictions)
      .where(eq(predictions.id, id))
      .limit(1);

    if (!prediction) return null;

    // Load related data in parallel
    const [market, fixture, consensus] = await Promise.all([
      this.db
        .select()
        .from(polymarketMarkets)
        .where(eq(polymarketMarkets.id, prediction.polymarketMarketId))
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null),
      prediction.fixtureId
        ? this.db
            .select()
            .from(fixtures)
            .where(eq(fixtures.id, prediction.fixtureId))
            .limit(1)
            .then((rows: any[]) => rows[0] ?? null)
        : Promise.resolve(null),
      // Find linked odds event for consensus
      this.db
        .select()
        .from(marketFixtureLinks)
        .where(
          eq(
            marketFixtureLinks.polymarketMarketId,
            prediction.polymarketMarketId,
          ),
        )
        .limit(1)
        .then(async (links: any[]) => {
          if (links.length > 0 && links[0].oddsApiEventId) {
            const rows = await this.db
              .select()
              .from(consensusOdds)
              .where(eq(consensusOdds.oddsApiEventId, links[0].oddsApiEventId))
              .orderBy(desc(consensusOdds.calculatedAt))
              .limit(1);
            return rows[0] ?? null;
          }
          return null;
        }),
    ]);

    return {
      ...prediction,
      market,
      fixture,
      consensus,
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  /**
   * Combine signals according to market type weights.
   */
  private combineSignals(
    matchType: string,
    consensusProb: number | null,
    statisticalProb: number | null,
    apiFootballProb: number | null,
  ): number {
    // For match outcomes: 40% mispricing + 35% statistical + 25% API-Football
    // For league/season: 55% mispricing + 45% statistical (no API-Football)
    // For transfer/manager: consensus only

    if (['transfer', 'manager'].includes(matchType)) {
      return consensusProb ?? 0.5;
    }

    const hasConsensus = consensusProb != null && consensusProb > 0;
    const hasStat = statisticalProb != null && statisticalProb > 0;
    const hasApiFootball = apiFootballProb != null && apiFootballProb > 0;

    if (
      ['league_winner', 'top_finish', 'relegation', 'tournament'].includes(
        matchType,
      )
    ) {
      // No API-Football prediction for season markets
      if (hasConsensus && hasStat) {
        return consensusProb * 0.55 + statisticalProb * 0.45;
      }
      if (hasConsensus) return consensusProb;
      if (hasStat) return statisticalProb;
      return 0.5;
    }

    // Match outcome: standard weighting
    let totalWeight = 0;
    let weightedSum = 0;

    if (hasConsensus) {
      weightedSum += consensusProb * this.weightMispricing;
      totalWeight += this.weightMispricing;
    }
    if (hasStat) {
      weightedSum += statisticalProb * this.weightStatistical;
      totalWeight += this.weightStatistical;
    }
    if (hasApiFootball) {
      weightedSum += apiFootballProb * this.weightApiFootball;
      totalWeight += this.weightApiFootball;
    }

    if (totalWeight === 0) return 0.5;

    return weightedSum / totalWeight;
  }

  /**
   * Extract the current "Yes" price from a Polymarket market.
   */
  private extractPolymarketPrice(market: any): number {
    const prices = market.outcomePrices;

    if (Array.isArray(prices) && prices.length > 0) {
      const yesPrice = parseFloat(String(prices[0]));
      if (!isNaN(yesPrice) && yesPrice > 0) return yesPrice;
    }

    return 0;
  }

  /**
   * Build a human-readable reasoning string.
   */
  private buildReasoning(
    mispricing: MispricingResult | null,
    statisticalProb: number | null,
    apiFootballProb: number | null,
    confidence: { score: number; label: string },
    recommendation: Recommendation,
    mappedOutcome: string,
  ): string {
    const parts: string[] = [];

    parts.push(`Outcome: ${mappedOutcome.replace('_', ' ')}.`);

    if (mispricing) {
      const direction = mispricing.gap > 0 ? 'underpriced' : 'overpriced';
      parts.push(
        `Mispricing: Polymarket is ${direction} by ${(Math.abs(mispricing.gap) * 100).toFixed(1)}% ` +
          `(consensus: ${(mispricing.consensusProbability * 100).toFixed(1)}%, ` +
          `Polymarket: ${(mispricing.polymarketPrice * 100).toFixed(1)}%).`,
      );
    } else {
      parts.push('Mispricing: No bookmaker consensus available.');
    }

    if (statisticalProb != null) {
      parts.push(
        `Statistical model: ${(statisticalProb * 100).toFixed(1)}% probability.`,
      );
    }

    if (apiFootballProb != null) {
      parts.push(
        `API-Football prediction: ${(apiFootballProb * 100).toFixed(1)}%.`,
      );
    }

    parts.push(`Confidence: ${confidence.score}/100 (${confidence.label}).`);
    parts.push(`Recommendation: ${recommendation}.`);

    return parts.join(' ');
  }
}
