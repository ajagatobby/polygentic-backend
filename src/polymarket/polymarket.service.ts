import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, isNull, sql, desc, gte, asc } from 'drizzle-orm';
import * as schema from '../database/schema';
import { PolymarketGammaService } from './services/polymarket-gamma.service';
import {
  PolymarketClobService,
  MarketPricingSnapshot,
} from './services/polymarket-clob.service';
import {
  PolymarketMatcherService,
  MarketFixtureMatch,
} from './services/polymarket-matcher.service';
import {
  PolymarketTradingAgent,
  TradingCandidate,
  TradingDecision,
  BankrollContext,
} from './services/polymarket-trading.agent';

/**
 * PolymarketService — Orchestrator
 *
 * Runs the full Polymarket trading agent loop:
 * 1. Discover soccer markets on Polymarket (Gamma API)
 * 2. Match markets to internal fixtures
 * 3. Find markets with predictions that show edge
 * 4. Let the trading agent (Claude) evaluate each candidate
 * 5. Log paper trades or execute real trades
 * 6. Track bankroll and P&L
 */
@Injectable()
export class PolymarketService {
  private readonly logger = new Logger(PolymarketService.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly config: ConfigService,
    private readonly gammaService: PolymarketGammaService,
    private readonly clobService: PolymarketClobService,
    private readonly matcherService: PolymarketMatcherService,
    private readonly tradingAgent: PolymarketTradingAgent,
  ) {}

  // ─── Main agent loop ────────────────────────────────────────────────

  /**
   * Run a full scan cycle:
   * 1. Fetch Polymarket soccer markets
   * 2. Match to fixtures with predictions
   * 3. Identify value opportunities
   * 4. Run trading agent on each candidate
   * 5. Log trades
   */
  async runScanCycle(): Promise<{
    marketsFound: number;
    marketsMatched: number;
    candidatesEvaluated: number;
    tradesPlaced: number;
    tradesSkipped: number;
    errors: string[];
  }> {
    const startTime = Date.now();
    const errors: string[] = [];

    this.logger.log('Starting Polymarket scan cycle');

    // Check if trading is stopped
    const bankroll = await this.getOrCreateBankroll();
    if (bankroll.isStopped) {
      this.logger.warn(
        `Trading is STOPPED: ${bankroll.stoppedReason}. Skipping scan.`,
      );
      return {
        marketsFound: 0,
        marketsMatched: 0,
        candidatesEvaluated: 0,
        tradesPlaced: 0,
        tradesSkipped: 0,
        errors: [`Trading stopped: ${bankroll.stoppedReason}`],
      };
    }

    // Step 1: Fetch soccer markets
    let events;
    try {
      events = await this.gammaService.fetchSoccerEvents();
    } catch (error) {
      this.logger.error(`Failed to fetch Polymarket events: ${error.message}`);
      return {
        marketsFound: 0,
        marketsMatched: 0,
        candidatesEvaluated: 0,
        tradesPlaced: 0,
        tradesSkipped: 0,
        errors: [error.message],
      };
    }

    // Step 2: Match to fixtures
    const matches = await this.matcherService.matchEventsToFixtures(events);

    // Step 3: Persist markets to DB
    await this.persistMarkets(matches);

    // Step 4: Find candidates with predictions and edge
    const candidates = await this.buildTradingCandidates(matches);

    this.logger.log(
      `Scan: ${events.length} events → ${matches.length} matched → ${candidates.length} candidates with edge`,
    );

    // Step 5: Evaluate each candidate with the trading agent
    let tradesPlaced = 0;
    let tradesSkipped = 0;

    const bankrollContext = await this.buildBankrollContext();
    const openPositions = await this.getOpenPositionsSummary();

    for (const candidate of candidates) {
      try {
        const decision = await this.tradingAgent.evaluate(
          candidate,
          bankrollContext,
          openPositions,
        );

        if (decision.action === 'bet' && decision.positionSizeUsd > 0) {
          await this.executeTrade(candidate, decision, bankroll);
          tradesPlaced++;

          // Update open positions for next evaluation
          openPositions.push({
            outcomeName: decision.outcomeName,
            fixtureId: candidate.match.fixtureId,
            positionSizeUsd: decision.positionSizeUsd,
          });
        } else {
          await this.logSkippedTrade(candidate, decision);
          tradesSkipped++;
        }
      } catch (error) {
        this.logger.error(
          `Failed to evaluate candidate (fixture ${candidate.match.fixtureId}): ${error.message}`,
        );
        errors.push(error.message);
      }
    }

    // Step 6: Update bankroll snapshot
    await this.updateBankrollSnapshot();

    const duration = Date.now() - startTime;
    this.logger.log(
      `Polymarket scan complete in ${duration}ms: ` +
        `${tradesPlaced} trades placed, ${tradesSkipped} skipped, ${errors.length} errors`,
    );

    return {
      marketsFound: events.length,
      marketsMatched: matches.length,
      candidatesEvaluated: candidates.length,
      tradesPlaced,
      tradesSkipped,
      errors,
    };
  }

  // ─── Candidate building ─────────────────────────────────────────────

  /**
   * Build trading candidates by enriching matched markets with:
   * - Our prediction data
   * - CLOB pricing snapshots
   * - Edge calculations
   *
   * Filters out candidates below minimum edge/confidence/liquidity thresholds.
   */
  private async buildTradingCandidates(
    matches: MarketFixtureMatch[],
  ): Promise<TradingCandidate[]> {
    const minEdge = this.config.get<number>('POLYMARKET_MIN_EDGE') || 0.05;
    const minLiquidity =
      this.config.get<number>('POLYMARKET_MIN_LIQUIDITY') || 1000;
    const minConfidence =
      this.config.get<number>('POLYMARKET_MIN_CONFIDENCE') || 6;

    const candidates: TradingCandidate[] = [];

    for (const match of matches) {
      // Skip low-liquidity markets
      if (Number(match.event.liquidity) < minLiquidity) continue;

      // Get our prediction for this fixture
      const [prediction] = await this.db
        .select()
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, match.fixtureId),
            isNull(schema.predictions.resolvedAt),
          ),
        )
        .orderBy(desc(schema.predictions.createdAt))
        .limit(1);

      if (!prediction) continue;
      if ((prediction.confidence ?? 0) < minConfidence) continue;

      // Check if we already have an open trade for this market
      const existingTrades = await this.db
        .select({ id: schema.polymarketTrades.id })
        .from(schema.polymarketTrades)
        .innerJoin(
          schema.polymarketMarkets,
          eq(
            schema.polymarketTrades.polymarketMarketId,
            schema.polymarketMarkets.id,
          ),
        )
        .where(
          and(
            eq(schema.polymarketMarkets.marketId, match.market.marketId),
            eq(schema.polymarketTrades.status, 'open'),
          ),
        )
        .limit(1);

      if (existingTrades.length > 0) continue;

      // Get CLOB pricing for the first token (Yes/primary outcome)
      const primaryTokenId = match.market.clobTokenIds[0];
      if (!primaryTokenId) continue;

      const pricing =
        await this.clobService.getMarketPricingSnapshot(primaryTokenId);
      if (!pricing) continue;

      // Determine which probability maps to this market
      const { ensembleProb, outcomeDescription } =
        this.mapPredictionToMarketOutcome(match, prediction);

      if (ensembleProb == null) continue;

      // Calculate edge
      const polymarketProb = pricing.midpoint;
      const rawEdge = ensembleProb - polymarketProb;

      // Also check the inverse: maybe betting "No" has edge
      // (if our probability is much lower than Polymarket's)
      const inverseEdge = 1 - ensembleProb - (1 - polymarketProb);

      // We want positive edge — either on Yes (rawEdge > 0) or No (inverseEdge > 0)
      if (rawEdge < minEdge && inverseEdge < minEdge) continue;

      // Get No token pricing if betting No has more edge
      let pricingNo: MarketPricingSnapshot | undefined;
      const secondTokenId = match.market.clobTokenIds[1];
      if (inverseEdge > rawEdge && secondTokenId) {
        const noSnapshot =
          await this.clobService.getMarketPricingSnapshot(secondTokenId);
        if (noSnapshot) pricingNo = noSnapshot;
      }

      // Use whichever direction has more edge
      const bestEdge = Math.max(rawEdge, inverseEdge);
      const bestPricing =
        inverseEdge > rawEdge && pricingNo ? pricingNo : pricing;
      const bestEnsembleProb =
        inverseEdge > rawEdge ? 1 - ensembleProb : ensembleProb;
      const bestPolymarketProb =
        inverseEdge > rawEdge ? 1 - polymarketProb : polymarketProb;

      candidates.push({
        match,
        pricing: bestPricing,
        pricingNo: inverseEdge > rawEdge ? undefined : pricingNo,
        prediction: {
          id: prediction.id,
          homeWinProb: Number(prediction.homeWinProb),
          drawProb: Number(prediction.drawProb),
          awayWinProb: Number(prediction.awayWinProb),
          predictedHomeGoals: Number(prediction.predictedHomeGoals),
          predictedAwayGoals: Number(prediction.predictedAwayGoals),
          confidence: prediction.confidence ?? 5,
          keyFactors: (prediction.keyFactors as string[]) ?? [],
          riskFactors: (prediction.riskFactors as string[]) ?? [],
          valueBets: (prediction.valueBets as any[]) ?? [],
          detailedAnalysis: prediction.detailedAnalysis ?? '',
        },
        ensembleProbability: bestEnsembleProb,
        polymarketProbability: bestPolymarketProb,
        rawEdge: bestEdge,
      });
    }

    // Sort by edge descending — evaluate best opportunities first
    candidates.sort((a, b) => b.rawEdge - a.rawEdge);

    return candidates;
  }

  /**
   * Map our prediction probabilities to the market's outcome.
   *
   * Polymarket match outcome markets are typically "Will X beat Y?" (Yes/No).
   * We need to figure out which of our probabilities (homeWin, draw, awayWin)
   * corresponds to the market's "Yes" outcome.
   */
  private mapPredictionToMarketOutcome(
    match: MarketFixtureMatch,
    prediction: any,
  ): { ensembleProb: number | null; outcomeDescription: string } {
    const question = match.market.question.toLowerCase();
    const title = match.event.title.toLowerCase();
    const text = `${question} ${title}`;

    const homeTeamNorm = match.homeTeamName.toLowerCase();
    const awayTeamNorm = match.awayTeamName.toLowerCase();

    // Check if the market is about the home team winning
    if (
      text.includes(homeTeamNorm) &&
      (text.includes('beat') || text.includes('win') || text.includes('defeat'))
    ) {
      if (
        text.includes(awayTeamNorm) &&
        text.indexOf(homeTeamNorm) < text.indexOf(awayTeamNorm)
      ) {
        // "Will [Home] beat [Away]?" → Yes = Home Win
        return {
          ensembleProb: Number(prediction.homeWinProb),
          outcomeDescription: `${match.homeTeamName} Win`,
        };
      }
    }

    // Check if the market is about the away team winning
    if (
      text.includes(awayTeamNorm) &&
      (text.includes('beat') || text.includes('win') || text.includes('defeat'))
    ) {
      if (
        text.includes(homeTeamNorm) &&
        text.indexOf(awayTeamNorm) < text.indexOf(homeTeamNorm)
      ) {
        // "Will [Away] beat [Home]?" → Yes = Away Win
        return {
          ensembleProb: Number(prediction.awayWinProb),
          outcomeDescription: `${match.awayTeamName} Win`,
        };
      }
    }

    // Generic: if event title contains both team names, try to match from outcomes
    const outcomes = match.market.outcomes.map((o) => o.toLowerCase());
    if (outcomes.includes('yes') && outcomes.includes('no')) {
      // Binary market — need to figure out what "Yes" means from context
      // Check if home team is the subject
      if (text.includes(homeTeamNorm) && !text.includes(awayTeamNorm)) {
        return {
          ensembleProb: Number(prediction.homeWinProb),
          outcomeDescription: `${match.homeTeamName} Win`,
        };
      }
      if (text.includes(awayTeamNorm) && !text.includes(homeTeamNorm)) {
        return {
          ensembleProb: Number(prediction.awayWinProb),
          outcomeDescription: `${match.awayTeamName} Win`,
        };
      }
    }

    // Multi-outcome market (rare on Polymarket for soccer)
    // Try to match outcome names to teams
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i].includes(homeTeamNorm)) {
        return {
          ensembleProb: Number(prediction.homeWinProb),
          outcomeDescription: `${match.homeTeamName} Win`,
        };
      }
      if (outcomes[i].includes(awayTeamNorm)) {
        return {
          ensembleProb: Number(prediction.awayWinProb),
          outcomeDescription: `${match.awayTeamName} Win`,
        };
      }
    }

    // Couldn't determine mapping
    this.logger.warn(
      `Could not map prediction to market outcome: "${match.market.question}"`,
    );
    return { ensembleProb: null, outcomeDescription: '' };
  }

  // ─── Trade execution ────────────────────────────────────────────────

  /**
   * Execute a trade — either paper or live depending on config.
   */
  private async executeTrade(
    candidate: TradingCandidate,
    decision: TradingDecision,
    bankroll: any,
  ): Promise<void> {
    const isLive =
      this.config.get<string>('POLYMARKET_LIVE_TRADING') === 'true';
    const mode = isLive ? 'live' : 'paper';

    // Find or create the market record
    const marketRecord = await this.getOrCreateMarketRecord(candidate.match);

    let orderId: string | null = null;
    let orderStatus = 'filled'; // Paper trades are instantly "filled"

    // Place real order if live trading
    if (isLive) {
      const tokenId =
        candidate.match.market.clobTokenIds[decision.outcomeIndex];
      if (!tokenId) {
        this.logger.error(
          'No token ID for outcome index — skipping live trade',
        );
        return;
      }

      const tokensToReceive = decision.positionSizeUsd / decision.entryPrice;
      const result = await this.clobService.placeLimitOrder({
        tokenId,
        side: 'BUY',
        price: decision.entryPrice,
        size: tokensToReceive,
      });

      if (!result) {
        this.logger.error('Live order placement failed');
        return;
      }

      orderId = result.orderId;
      orderStatus = result.status;
    }

    // Record the trade
    const tokenQuantity = decision.positionSizeUsd / decision.entryPrice;

    await this.db.insert(schema.polymarketTrades).values({
      polymarketMarketId: marketRecord.id,
      predictionId: candidate.prediction.id,
      fixtureId: candidate.match.fixtureId,
      mode,
      side: 'buy',
      outcomeIndex: decision.outcomeIndex,
      outcomeName: decision.outcomeName,
      entryPrice: String(decision.entryPrice),
      midpointAtEntry: String(candidate.pricing.midpoint),
      spreadAtEntry: String(candidate.pricing.spread),
      positionSizeUsd: String(decision.positionSizeUsd),
      tokenQuantity: String(tokenQuantity),
      ensembleProbability: String(candidate.ensembleProbability),
      polymarketProbability: String(candidate.polymarketProbability),
      edgePercent: String(decision.edgePercent),
      kellyFraction: String(decision.kellyFraction),
      confidenceAtEntry: candidate.prediction.confidence,
      agentReasoning: decision.reasoning,
      riskAssessment: decision.riskAssessment,
      bankrollAtEntry: String(Number(bankroll.currentBalance)),
      openPositionsCount: bankroll.openPositionsCount,
      orderId,
      orderStatus,
      fillPrice: isLive ? null : String(decision.entryPrice),
      fillTimestamp: isLive ? null : new Date(),
      status: isLive ? 'open' : 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Update bankroll
    const newBalance =
      Number(bankroll.currentBalance) - decision.positionSizeUsd;
    await this.db
      .update(schema.polymarketBankroll)
      .set({
        currentBalance: String(newBalance),
        openPositionsCount: bankroll.openPositionsCount + 1,
        openPositionsValue: String(
          Number(bankroll.openPositionsValue) + decision.positionSizeUsd,
        ),
        updatedAt: new Date(),
      })
      .where(eq(schema.polymarketBankroll.id, bankroll.id));

    this.logger.log(
      `[${mode.toUpperCase()}] Trade placed: ${decision.outcomeName} ` +
        `$${decision.positionSizeUsd.toFixed(2)} @ ${decision.entryPrice.toFixed(3)} ` +
        `(edge: ${decision.edgePercent.toFixed(1)}%, Kelly: ${decision.kellyFraction.toFixed(3)})`,
    );
  }

  /**
   * Log a trade that was evaluated but skipped.
   * We don't persist skips to the DB — just log for observability.
   */
  private async logSkippedTrade(
    candidate: TradingCandidate,
    decision: TradingDecision,
  ): Promise<void> {
    this.logger.debug(
      `SKIP: ${candidate.match.homeTeamName} vs ${candidate.match.awayTeamName} ` +
        `(edge: ${(candidate.rawEdge * 100).toFixed(1)}%) — ${decision.reasoning.substring(0, 200)}`,
    );
  }

  // ─── Trade resolution ───────────────────────────────────────────────

  /**
   * Resolve open trades for finished matches.
   * Called after fixtures are synced and predictions resolved.
   */
  async resolveCompletedTrades(): Promise<{
    resolved: number;
    errors: string[];
  }> {
    // Find open trades where the fixture is finished
    const openTrades = await this.db
      .select({
        trade: schema.polymarketTrades,
        fixture: schema.fixtures,
        prediction: schema.predictions,
      })
      .from(schema.polymarketTrades)
      .innerJoin(
        schema.fixtures,
        eq(schema.polymarketTrades.fixtureId, schema.fixtures.id),
      )
      .leftJoin(
        schema.predictions,
        eq(schema.polymarketTrades.predictionId, schema.predictions.id),
      )
      .where(
        and(
          eq(schema.polymarketTrades.status, 'open'),
          eq(schema.fixtures.status, 'FT'),
        ),
      );

    let resolved = 0;
    const errors: string[] = [];

    for (const { trade, fixture, prediction } of openTrades) {
      try {
        // Determine actual result
        const homeGoals = fixture.goalsHome ?? 0;
        const awayGoals = fixture.goalsAway ?? 0;
        let actualResult: string;
        if (homeGoals > awayGoals) actualResult = 'home_win';
        else if (awayGoals > homeGoals) actualResult = 'away_win';
        else actualResult = 'draw';

        // Determine if the trade's outcome won
        const outcomeName = trade.outcomeName?.toLowerCase() ?? '';
        let tradeWon = false;

        if (
          outcomeName.includes('home') ||
          outcomeName.includes((fixture.homeTeamId ? 'team' : '').toLowerCase())
        ) {
          tradeWon = actualResult === 'home_win';
        } else if (
          outcomeName.includes('away') ||
          outcomeName.includes((fixture.awayTeamId ? 'team' : '').toLowerCase())
        ) {
          tradeWon = actualResult === 'away_win';
        } else if (outcomeName.includes('draw')) {
          tradeWon = actualResult === 'draw';
        } else {
          // Try to match using the prediction's actual result
          if (prediction?.actualResult) {
            // For "Yes/No" markets about a specific team winning
            // If we bet Yes on "Will X beat Y" and X won
            tradeWon = this.didTradeWin(trade, fixture, prediction);
          }
        }

        // Calculate P&L
        const exitPrice = tradeWon ? 1.0 : 0.0;
        const entryPrice = Number(trade.entryPrice);
        const positionSize = Number(trade.positionSizeUsd);
        const tokenQty =
          Number(trade.tokenQuantity) || positionSize / entryPrice;
        const pnlUsd = tradeWon
          ? tokenQty * (exitPrice - entryPrice)
          : -positionSize; // Lost the entire position
        const pnlPercent = positionSize > 0 ? pnlUsd / positionSize : 0;

        await this.db
          .update(schema.polymarketTrades)
          .set({
            exitPrice: String(exitPrice),
            pnlUsd: String(pnlUsd),
            pnlPercent: String(pnlPercent),
            resolvedAt: new Date(),
            resolutionOutcome: tradeWon ? 'win' : 'loss',
            status: 'resolved',
            updatedAt: new Date(),
          })
          .where(eq(schema.polymarketTrades.id, trade.id));

        resolved++;

        this.logger.log(
          `Trade resolved: ${trade.outcomeName} — ${tradeWon ? 'WIN' : 'LOSS'} ` +
            `P&L: $${pnlUsd.toFixed(2)} (${(pnlPercent * 100).toFixed(1)}%)`,
        );
      } catch (error) {
        errors.push(`Failed to resolve trade ${trade.id}: ${error.message}`);
      }
    }

    // Update bankroll after resolutions
    if (resolved > 0) {
      await this.updateBankrollSnapshot();
    }

    return { resolved, errors };
  }

  /**
   * Determine if a trade won based on fixture result.
   * Handles binary Yes/No markets about specific team outcomes.
   */
  private didTradeWin(trade: any, fixture: any, prediction: any): boolean {
    const actualResult = prediction.actualResult;
    const outcomeName = (trade.outcomeName ?? '').toLowerCase();
    const outcomeIndex = trade.outcomeIndex ?? 0;

    // If outcome name clearly indicates a team
    if (outcomeName.includes('yes')) {
      // "Yes" in a "Will X beat Y?" market — need to check what X is
      // Use the edge direction: if ensemble > polymarket, we bet Yes believing X wins
      const ensembleProb = Number(trade.ensembleProbability);
      const homeWinProb = Number(prediction.homeWinProb);

      // If our ensemble probability is close to homeWinProb, we were betting on home win
      if (Math.abs(ensembleProb - homeWinProb) < 0.1) {
        return actualResult === 'home_win';
      }
      const awayWinProb = Number(prediction.awayWinProb);
      if (Math.abs(ensembleProb - awayWinProb) < 0.1) {
        return actualResult === 'away_win';
      }
    }

    if (outcomeName.includes('no')) {
      // Inverse — we bet against the market's proposition
      const ensembleProb = Number(trade.ensembleProbability);
      const homeWinProb = Number(prediction.homeWinProb);
      if (Math.abs(1 - ensembleProb - homeWinProb) < 0.1) {
        return actualResult !== 'home_win';
      }
    }

    // Fallback: assume outcomeIndex 0 = Yes = the proposition holds
    return outcomeIndex === 0
      ? prediction.wasCorrect === true
      : prediction.wasCorrect === false;
  }

  // ─── Bankroll management ────────────────────────────────────────────

  /**
   * Get or create the bankroll record.
   */
  async getOrCreateBankroll(): Promise<any> {
    const isLive =
      this.config.get<string>('POLYMARKET_LIVE_TRADING') === 'true';
    const mode = isLive ? 'live' : 'paper';

    const existing = await this.db
      .select()
      .from(schema.polymarketBankroll)
      .where(eq(schema.polymarketBankroll.mode, mode))
      .orderBy(desc(schema.polymarketBankroll.updatedAt))
      .limit(1);

    if (existing.length > 0) return existing[0];

    // Create initial bankroll
    const budget = this.config.get<number>('POLYMARKET_BUDGET') || 500;

    const [created] = await this.db
      .insert(schema.polymarketBankroll)
      .values({
        mode,
        initialBudget: String(budget),
        currentBalance: String(budget),
        totalDeposited: String(budget),
        totalWithdrawn: '0',
        realizedPnl: '0',
        unrealizedPnl: '0',
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        peakBalance: String(budget),
        currentDrawdownPct: '0',
        maxDrawdownPct: '0',
        openPositionsCount: 0,
        openPositionsValue: '0',
        snapshotAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    this.logger.log(`Created ${mode} bankroll with initial budget: $${budget}`);

    return created;
  }

  /**
   * Build a BankrollContext object for the trading agent.
   */
  async buildBankrollContext(): Promise<BankrollContext> {
    const bankroll = await this.getOrCreateBankroll();
    const targetMultiplier =
      this.config.get<number>('POLYMARKET_TARGET_MULTIPLIER') || 3;

    return {
      initialBudget: Number(bankroll.initialBudget),
      currentBalance: Number(bankroll.currentBalance),
      targetMultiplier,
      realizedPnl: Number(bankroll.realizedPnl),
      openPositionsCount: bankroll.openPositionsCount ?? 0,
      openPositionsValue: Number(bankroll.openPositionsValue ?? 0),
      winRate: Number(bankroll.winRate ?? 0),
      totalTrades: bankroll.totalTrades ?? 0,
      currentDrawdownPct: Number(bankroll.currentDrawdownPct ?? 0),
      maxDrawdownPct: Number(bankroll.maxDrawdownPct ?? 0),
      peakBalance: Number(bankroll.peakBalance ?? bankroll.initialBudget),
    };
  }

  /**
   * Update the bankroll snapshot after trades are placed or resolved.
   */
  async updateBankrollSnapshot(): Promise<void> {
    const bankroll = await this.getOrCreateBankroll();
    const stopLossPct =
      this.config.get<number>('POLYMARKET_STOP_LOSS_PCT') || 0.3;

    // Recalculate from all resolved trades
    const resolvedTrades = await this.db
      .select()
      .from(schema.polymarketTrades)
      .where(
        and(
          eq(schema.polymarketTrades.mode, bankroll.mode),
          eq(schema.polymarketTrades.status, 'resolved'),
        ),
      );

    const openTrades = await this.db
      .select()
      .from(schema.polymarketTrades)
      .where(
        and(
          eq(schema.polymarketTrades.mode, bankroll.mode),
          eq(schema.polymarketTrades.status, 'open'),
        ),
      );

    const totalTrades = resolvedTrades.length;
    const winningTrades = resolvedTrades.filter(
      (t: any) => t.resolutionOutcome === 'win',
    ).length;
    const losingTrades = resolvedTrades.filter(
      (t: any) => t.resolutionOutcome === 'loss',
    ).length;
    const realizedPnl = resolvedTrades.reduce(
      (sum: number, t: any) => sum + (Number(t.pnlUsd) || 0),
      0,
    );
    const avgEdge =
      totalTrades > 0
        ? resolvedTrades.reduce(
            (sum: number, t: any) => sum + (Number(t.edgePercent) || 0),
            0,
          ) / totalTrades
        : 0;

    const openPositionsCount = openTrades.length;
    const openPositionsValue = openTrades.reduce(
      (sum: number, t: any) => sum + (Number(t.positionSizeUsd) || 0),
      0,
    );

    const initialBudget = Number(bankroll.initialBudget);
    const currentBalance = initialBudget + realizedPnl - openPositionsValue;
    const peakBalance = Math.max(
      Number(bankroll.peakBalance ?? initialBudget),
      currentBalance,
    );
    const currentDrawdownPct =
      peakBalance > 0 ? (peakBalance - currentBalance) / peakBalance : 0;
    const maxDrawdownPct = Math.max(
      Number(bankroll.maxDrawdownPct ?? 0),
      currentDrawdownPct,
    );

    // Check stop-loss
    const balanceRatio = currentBalance / initialBudget;
    const isStopped = balanceRatio < stopLossPct;
    const stoppedReason = isStopped
      ? `Bankroll dropped to ${(balanceRatio * 100).toFixed(1)}% of initial budget (stop-loss at ${(stopLossPct * 100).toFixed(0)}%)`
      : null;

    await this.db
      .update(schema.polymarketBankroll)
      .set({
        currentBalance: String(currentBalance),
        realizedPnl: String(realizedPnl),
        totalTrades,
        winningTrades,
        losingTrades,
        winRate: totalTrades > 0 ? String(winningTrades / totalTrades) : null,
        avgEdge: String(avgEdge),
        peakBalance: String(peakBalance),
        currentDrawdownPct: String(currentDrawdownPct),
        maxDrawdownPct: String(maxDrawdownPct),
        openPositionsCount,
        openPositionsValue: String(openPositionsValue),
        isStopped,
        stoppedReason,
        snapshotAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.polymarketBankroll.id, bankroll.id));

    if (isStopped) {
      this.logger.warn(`STOP-LOSS TRIGGERED: ${stoppedReason}`);
    }
  }

  // ─── Market persistence ─────────────────────────────────────────────

  private async persistMarkets(matches: MarketFixtureMatch[]): Promise<void> {
    for (const match of matches) {
      const market = match.market;

      await this.db
        .insert(schema.polymarketMarkets)
        .values({
          eventId: match.event.eventId,
          marketId: market.marketId,
          conditionId: market.conditionId,
          slug: market.slug,
          eventTitle: match.event.title,
          marketQuestion: market.question,
          outcomes: market.outcomes,
          clobTokenIds: market.clobTokenIds,
          marketType: match.marketType,
          tags: match.event.tags,
          outcomePrices: market.outcomePrices.map(String),
          liquidity: String(match.event.liquidity),
          volume: String(match.event.volume),
          volume24hr: String(match.event.volume24hr),
          active: match.event.active,
          closed: match.event.closed,
          acceptingOrders: market.acceptingOrders,
          startDate: match.event.startDate
            ? new Date(match.event.startDate)
            : null,
          endDate: match.event.endDate ? new Date(match.event.endDate) : null,
          fixtureId: match.fixtureId,
          matchScore: String(match.matchScore),
          lastSyncedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.polymarketMarkets.marketId,
          set: {
            outcomePrices: market.outcomePrices.map(String),
            liquidity: String(match.event.liquidity),
            volume: String(match.event.volume),
            volume24hr: String(match.event.volume24hr),
            active: match.event.active,
            closed: match.event.closed,
            acceptingOrders: market.acceptingOrders,
            fixtureId: match.fixtureId,
            matchScore: String(match.matchScore),
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }
  }

  private async getOrCreateMarketRecord(
    match: MarketFixtureMatch,
  ): Promise<any> {
    const existing = await this.db
      .select()
      .from(schema.polymarketMarkets)
      .where(eq(schema.polymarketMarkets.marketId, match.market.marketId))
      .limit(1);

    if (existing.length > 0) return existing[0];

    // Persist first, then return
    await this.persistMarkets([match]);
    const [created] = await this.db
      .select()
      .from(schema.polymarketMarkets)
      .where(eq(schema.polymarketMarkets.marketId, match.market.marketId))
      .limit(1);

    return created;
  }

  // ─── Query helpers ──────────────────────────────────────────────────

  async getOpenPositionsSummary(): Promise<
    Array<{ outcomeName: string; fixtureId: number; positionSizeUsd: number }>
  > {
    const isLive =
      this.config.get<string>('POLYMARKET_LIVE_TRADING') === 'true';
    const mode = isLive ? 'live' : 'paper';

    const trades = await this.db
      .select({
        outcomeName: schema.polymarketTrades.outcomeName,
        fixtureId: schema.polymarketTrades.fixtureId,
        positionSizeUsd: schema.polymarketTrades.positionSizeUsd,
      })
      .from(schema.polymarketTrades)
      .where(
        and(
          eq(schema.polymarketTrades.mode, mode),
          eq(schema.polymarketTrades.status, 'open'),
        ),
      );

    return trades.map((t: any) => ({
      outcomeName: t.outcomeName,
      fixtureId: t.fixtureId,
      positionSizeUsd: Number(t.positionSizeUsd),
    }));
  }

  /**
   * Get trading performance summary.
   */
  async getPerformanceSummary(): Promise<any> {
    const bankroll = await this.getOrCreateBankroll();

    const recentTrades = await this.db
      .select()
      .from(schema.polymarketTrades)
      .where(eq(schema.polymarketTrades.mode, bankroll.mode))
      .orderBy(desc(schema.polymarketTrades.createdAt))
      .limit(50);

    return {
      bankroll: {
        mode: bankroll.mode,
        initialBudget: Number(bankroll.initialBudget),
        currentBalance: Number(bankroll.currentBalance),
        realizedPnl: Number(bankroll.realizedPnl),
        totalTrades: bankroll.totalTrades,
        winningTrades: bankroll.winningTrades,
        losingTrades: bankroll.losingTrades,
        winRate: bankroll.winRate ? Number(bankroll.winRate) : null,
        avgEdge: bankroll.avgEdge ? Number(bankroll.avgEdge) : null,
        peakBalance: Number(bankroll.peakBalance),
        currentDrawdownPct: Number(bankroll.currentDrawdownPct),
        maxDrawdownPct: Number(bankroll.maxDrawdownPct),
        openPositionsCount: bankroll.openPositionsCount,
        openPositionsValue: Number(bankroll.openPositionsValue),
        isStopped: bankroll.isStopped,
        stoppedReason: bankroll.stoppedReason,
        returnPct:
          Number(bankroll.initialBudget) > 0
            ? (
                ((Number(bankroll.currentBalance) -
                  Number(bankroll.initialBudget)) /
                  Number(bankroll.initialBudget)) *
                100
              ).toFixed(2)
            : '0',
      },
      recentTrades: recentTrades.map((t: any) => ({
        id: t.id,
        mode: t.mode,
        outcomeName: t.outcomeName,
        side: t.side,
        entryPrice: Number(t.entryPrice),
        positionSizeUsd: Number(t.positionSizeUsd),
        edgePercent: Number(t.edgePercent),
        confidenceAtEntry: t.confidenceAtEntry,
        status: t.status,
        pnlUsd: t.pnlUsd ? Number(t.pnlUsd) : null,
        resolutionOutcome: t.resolutionOutcome,
        createdAt: t.createdAt,
        resolvedAt: t.resolvedAt,
      })),
    };
  }

  /**
   * Get all discovered Polymarket markets with fixture links.
   */
  async getMarkets(filters?: {
    active?: boolean;
    matched?: boolean;
    limit?: number;
  }): Promise<any[]> {
    const limit = filters?.limit ?? 50;
    const conditions: any[] = [];

    if (filters?.active !== undefined) {
      conditions.push(eq(schema.polymarketMarkets.active, filters.active));
    }
    if (filters?.matched === true) {
      conditions.push(sql`${schema.polymarketMarkets.fixtureId} IS NOT NULL`);
    }
    if (filters?.matched === false) {
      conditions.push(isNull(schema.polymarketMarkets.fixtureId));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(schema.polymarketMarkets)
      .where(where)
      .orderBy(desc(schema.polymarketMarkets.lastSyncedAt))
      .limit(limit);
  }
}
