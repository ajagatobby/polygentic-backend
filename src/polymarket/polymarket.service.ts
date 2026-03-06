import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  eq,
  and,
  isNull,
  sql,
  desc,
  asc,
  gte,
  lte,
  inArray,
} from 'drizzle-orm';
import * as schema from '../database/schema';
import { PolymarketGammaService } from './services/polymarket-gamma.service';
import {
  PolymarketClobService,
  MarketPricingSnapshot,
} from './services/polymarket-clob.service';
import {
  PolymarketMatcherService,
  MarketMatch,
  OutrightMarketMatch,
  FixtureMarketMatch,
} from './services/polymarket-matcher.service';
import {
  PolymarketTradingAgent,
  TradingCandidate,
  OutrightTradingCandidate,
  FixtureTradingCandidate,
  TradingDecision,
  BankrollContext,
  TeamStandingsContext,
} from './services/polymarket-trading.agent';

/**
 * PolymarketService — Orchestrator
 *
 * Runs the full Polymarket trading agent loop:
 * 1. Discover soccer markets on Polymarket (Gamma API, client-side filter)
 * 2. Match markets to internal leagues/teams (outrights) or fixtures
 * 3. Enrich with standings data and price snapshots
 * 4. Estimate probabilities and identify edge
 * 5. Let the trading agent (Claude) evaluate each candidate
 * 6. Log paper trades or execute real trades
 * 7. Track bankroll and P&L
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
   * Run a full scan cycle.
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
    let bankroll = await this.getOrCreateBankroll();
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

    // Step 1: Fetch soccer markets (client-side filtered)
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

    const totalMarkets = events.reduce((sum, e) => sum + e.markets.length, 0);

    // Step 2: Match to internal data (leagues/teams for outrights, fixtures for match outcomes)
    const matches = await this.matcherService.matchEvents(events);

    // Step 3: Persist markets to DB
    await this.persistMarkets(matches);

    // Step 4: Build trading candidates with pricing + edge
    const candidates = await this.buildTradingCandidates(matches);

    this.logger.log(
      `Scan: ${events.length} events (${totalMarkets} markets) → ` +
        `${matches.length} matched → ${candidates.length} candidates with edge`,
    );

    // Step 5: Evaluate each candidate with the trading agent
    let tradesPlaced = 0;
    let tradesSkipped = 0;

    let bankrollContext = await this.buildBankrollContext();
    const openPositions = await this.getOpenPositionsSummary();

    for (const candidate of candidates) {
      try {
        // Re-fetch bankroll for accurate balance after each trade
        bankroll = await this.getOrCreateBankroll();
        bankrollContext = await this.buildBankrollContext();

        // Stop placing trades if budget is exhausted
        if (Number(bankroll.currentBalance) <= 0) {
          this.logger.warn('Budget exhausted — stopping scan cycle');
          break;
        }

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
            fixtureId:
              candidate.type === 'fixture'
                ? candidate.match.fixtureId
                : undefined,
            leagueId:
              candidate.type === 'outright'
                ? candidate.match.leagueId
                : undefined,
            positionSizeUsd: decision.positionSizeUsd,
          });
        } else {
          await this.logSkippedTrade(candidate, decision);
          tradesSkipped++;
        }
      } catch (error) {
        const label =
          candidate.type === 'outright'
            ? `${candidate.match.teamName} in ${candidate.match.leagueName}`
            : `fixture ${(candidate.match as FixtureMarketMatch).fixtureId}`;
        this.logger.error(
          `Failed to evaluate candidate (${label}): ${error.message}`,
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
      marketsFound: totalMarkets,
      marketsMatched: matches.length,
      candidatesEvaluated: candidates.length,
      tradesPlaced,
      tradesSkipped,
      errors,
    };
  }

  // ─── Candidate building ─────────────────────────────────────────────

  /**
   * Build trading candidates from matched markets.
   * Handles both outright and fixture market types.
   */
  private async buildTradingCandidates(
    matches: MarketMatch[],
  ): Promise<TradingCandidate[]> {
    const minEdge = this.config.get<number>('POLYMARKET_MIN_EDGE') || 0.05;
    const minLiquidity =
      this.config.get<number>('POLYMARKET_MIN_LIQUIDITY') || 1000;

    const candidates: TradingCandidate[] = [];

    for (const match of matches) {
      // Skip low-liquidity markets
      if (Number(match.event.liquidity) < minLiquidity) continue;

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

      if (match.marketType === 'match_outcome') {
        const candidate = await this.buildFixtureCandidate(
          match as FixtureMarketMatch,
          minEdge,
        );
        if (candidate) candidates.push(candidate);
      } else {
        const candidate = await this.buildOutrightCandidate(
          match as OutrightMarketMatch,
          minEdge,
        );
        if (candidate) candidates.push(candidate);
      }
    }

    // Sort by edge descending
    candidates.sort((a, b) => b.rawEdge - a.rawEdge);

    return candidates;
  }

  // ─── Outright candidate building ────────────────────────────────────

  /**
   * Build an outright trading candidate with standings data and probability estimate.
   */
  private async buildOutrightCandidate(
    match: OutrightMarketMatch,
    minEdge: number,
  ): Promise<OutrightTradingCandidate | null> {
    // Get primary token pricing
    const primaryTokenId = match.market.clobTokenIds[0];
    if (!primaryTokenId) return null;

    const pricing =
      await this.clobService.getMarketPricingSnapshot(primaryTokenId);
    if (!pricing) return null;

    const polymarketProb = pricing.midpoint;

    // We need the team in our DB to get standings
    if (!match.teamId) {
      this.logger.debug(
        `No teamId for outright: "${match.market.question}" — skipping`,
      );
      return null;
    }

    // Fetch standings for this team
    const teamStandings = await this.getTeamStandings(
      match.teamId,
      match.leagueId,
      match.season,
    );

    if (!teamStandings) {
      this.logger.debug(
        `No standings data for ${match.teamName} in league ${match.leagueId} — skipping`,
      );
      return null;
    }

    // Fetch top competitors for context
    const topCompetitors = await this.getTopCompetitors(
      match.leagueId,
      match.season,
      match.teamId,
    );

    // Estimate probability from standings
    const estimatedProb = this.estimateOutrightProbability(
      match,
      teamStandings,
      topCompetitors,
    );

    // Calculate edge
    const rawEdge = estimatedProb - polymarketProb;

    // Also check inverse (bet No / against this team)
    const inverseEdge = 1 - estimatedProb - (1 - polymarketProb);

    if (rawEdge < minEdge && inverseEdge < minEdge) return null;

    // Use whichever direction has more edge
    const bestEdge = Math.max(rawEdge, inverseEdge);
    const bestProb = inverseEdge > rawEdge ? 1 - estimatedProb : estimatedProb;
    const bestPolymarketProb =
      inverseEdge > rawEdge ? 1 - polymarketProb : polymarketProb;

    // If betting No, get No token pricing
    let finalPricing = pricing;
    if (inverseEdge > rawEdge) {
      const noTokenId = match.market.clobTokenIds[1];
      if (noTokenId) {
        const noPricing =
          await this.clobService.getMarketPricingSnapshot(noTokenId);
        if (noPricing) finalPricing = noPricing;
      }
    }

    return {
      type: 'outright',
      match,
      pricing: finalPricing,
      estimatedProbability: bestProb,
      polymarketProbability: bestPolymarketProb,
      rawEdge: bestEdge,
      teamStandings,
      topCompetitors,
    };
  }

  /**
   * Get team standings from team_form table.
   */
  private async getTeamStandings(
    teamId: number,
    leagueId: number,
    season: number,
  ): Promise<TeamStandingsContext | null> {
    const [form] = await this.db
      .select()
      .from(schema.teamForm)
      .where(
        and(
          eq(schema.teamForm.teamId, teamId),
          eq(schema.teamForm.leagueId, leagueId),
          eq(schema.teamForm.season, season),
        ),
      )
      .limit(1);

    if (!form) return null;

    // Calculate games played
    const homeGames =
      (form.homeWins ?? 0) + (form.homeDraws ?? 0) + (form.homeLosses ?? 0);
    const awayGames =
      (form.awayWins ?? 0) + (form.awayDraws ?? 0) + (form.awayLosses ?? 0);
    const gamesPlayed = homeGames + awayGames;

    // Get the leader's points
    const [leader] = await this.db
      .select({ points: schema.teamForm.points })
      .from(schema.teamForm)
      .where(
        and(
          eq(schema.teamForm.leagueId, leagueId),
          eq(schema.teamForm.season, season),
        ),
      )
      .orderBy(desc(schema.teamForm.points))
      .limit(1);

    const leaderPoints = leader?.points ?? form.points ?? 0;

    // Count total teams in the league
    const teamsInLeague = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.teamForm)
      .where(
        and(
          eq(schema.teamForm.leagueId, leagueId),
          eq(schema.teamForm.season, season),
        ),
      );
    const totalTeams = Number(teamsInLeague[0]?.count ?? 20);

    // Estimate total games in the season (each team plays others twice in most leagues)
    const totalGamesEstimate = (totalTeams - 1) * 2;
    const gamesRemaining = Math.max(0, totalGamesEstimate - gamesPlayed);

    return {
      leaguePosition: form.leaguePosition ?? 99,
      totalTeams,
      points: form.points ?? 0,
      pointsFromTop: Math.max(0, leaderPoints - (form.points ?? 0)),
      formString: form.formString ?? '',
      last5: {
        wins: form.last5Wins ?? 0,
        draws: form.last5Draws ?? 0,
        losses: form.last5Losses ?? 0,
        goalsFor: form.last5GoalsFor ?? 0,
        goalsAgainst: form.last5GoalsAgainst ?? 0,
      },
      home: {
        wins: form.homeWins ?? 0,
        draws: form.homeDraws ?? 0,
        losses: form.homeLosses ?? 0,
      },
      away: {
        wins: form.awayWins ?? 0,
        draws: form.awayDraws ?? 0,
        losses: form.awayLosses ?? 0,
      },
      goalsForAvg: Number(form.goalsForAvg ?? 0),
      goalsAgainstAvg: Number(form.goalsAgainstAvg ?? 0),
      attackRating: Number(form.attackRating ?? 50),
      defenseRating: Number(form.defenseRating ?? 50),
      gamesPlayed,
      gamesRemaining,
    };
  }

  /**
   * Get top competitors' standings for a league (excluding the target team).
   */
  private async getTopCompetitors(
    leagueId: number,
    season: number,
    excludeTeamId: number,
  ): Promise<
    Array<{
      teamName: string;
      position: number;
      points: number;
      formString: string;
    }>
  > {
    const rows = await this.db
      .select({
        teamId: schema.teamForm.teamId,
        position: schema.teamForm.leaguePosition,
        points: schema.teamForm.points,
        formString: schema.teamForm.formString,
      })
      .from(schema.teamForm)
      .where(
        and(
          eq(schema.teamForm.leagueId, leagueId),
          eq(schema.teamForm.season, season),
        ),
      )
      .orderBy(desc(schema.teamForm.points))
      .limit(10);

    // Fetch team names
    const teamIds = rows
      .filter((r: any) => r.teamId !== excludeTeamId)
      .map((r: any) => r.teamId);

    if (teamIds.length === 0) return [];

    const teamRows = await this.db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(
        sql`${schema.teams.id} IN (${sql.join(
          teamIds.map((id: number) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const teamNameMap = new Map<number, string>();
    for (const t of teamRows) {
      teamNameMap.set(t.id, t.name);
    }

    return rows
      .filter((r: any) => r.teamId !== excludeTeamId)
      .map((r: any) => ({
        teamName: teamNameMap.get(r.teamId) ?? `Team ${r.teamId}`,
        position: r.position ?? 99,
        points: r.points ?? 0,
        formString: r.formString ?? '',
      }))
      .slice(0, 5);
  }

  /**
   * Estimate the probability of an outright outcome from standings data.
   *
   * This is a heuristic model — not a sophisticated one. It provides a
   * reasonable starting point that Claude will refine during evaluation.
   *
   * The model considers:
   * - Current league position and points
   * - Points gap to leader / to competitors
   * - Season stage (games remaining)
   * - Form quality
   */
  private estimateOutrightProbability(
    match: OutrightMarketMatch,
    standings: TeamStandingsContext,
    competitors: Array<{
      teamName: string;
      position: number;
      points: number;
      formString: string;
    }>,
  ): number {
    const { marketType } = match;

    if (marketType === 'league_winner' || marketType === 'tournament_winner') {
      return this.estimateWinnerProbability(standings, competitors);
    }

    if (marketType === 'qualification') {
      return this.estimateQualificationProbability(standings);
    }

    if (marketType === 'top_4') {
      return this.estimateTop4Probability(standings);
    }

    return 0.1; // Default low probability for unknown types
  }

  /**
   * Estimate probability of winning the league/tournament.
   */
  private estimateWinnerProbability(
    standings: TeamStandingsContext,
    competitors: Array<{
      teamName: string;
      position: number;
      points: number;
      formString: string;
    }>,
  ): number {
    const {
      leaguePosition,
      totalTeams,
      pointsFromTop,
      gamesPlayed,
      gamesRemaining,
    } = standings;

    // Base rate: 1/N where N = total teams
    let prob = 1 / totalTeams;

    // Early season (< 25% of games played) — revert more to base rate
    const seasonProgress = gamesPlayed / (gamesPlayed + gamesRemaining);

    if (seasonProgress < 0.1) {
      // Very early — almost pure base rate with slight position adjustment
      prob =
        (1 / totalTeams) * (1 + (totalTeams - leaguePosition) / totalTeams);
      return Math.max(0.01, Math.min(0.5, prob));
    }

    // Points per game for the team
    const ppg = gamesPlayed > 0 ? standings.points / gamesPlayed : 0;

    // Max possible points
    const maxPossiblePoints = standings.points + gamesRemaining * 3;

    // Leader's projected points (simple projection)
    const leaderPoints = standings.points + pointsFromTop;
    const leaderPpg = gamesPlayed > 0 ? leaderPoints / gamesPlayed : 0;
    const leaderProjected = leaderPoints + gamesRemaining * leaderPpg;

    if (leaguePosition === 1) {
      // Currently leading
      if (gamesRemaining === 0) return 1.0; // Season over, they won
      if (seasonProgress > 0.75) {
        // Late season leader — strong probability
        // Points gap matters more
        const gapPerGame =
          pointsFromTop === 0 && competitors.length > 0
            ? (standings.points - competitors[0].points) / gamesRemaining
            : 0;

        if (standings.points > (competitors[0]?.points ?? 0)) {
          const gap = standings.points - (competitors[0]?.points ?? 0);
          // If gap > remaining games * 3, it's mathematically certain
          if (gap > gamesRemaining * 3) return 0.99;
          // Rough heuristic: probability increases with gap relative to remaining points
          prob = 0.5 + (gap / (gamesRemaining * 3)) * 0.45;
        } else {
          prob = 0.4; // Leading on GD or tiebreaker
        }
      } else if (seasonProgress > 0.5) {
        // Midseason leader — historically ~60-75% chance
        prob = 0.55 + (seasonProgress - 0.5) * 0.4;
      } else {
        // Early-ish leader
        prob = 0.3 + seasonProgress * 0.3;
      }
    } else {
      // Not leading
      if (maxPossiblePoints < leaderProjected * 0.9) {
        // Mathematically very difficult
        prob = Math.max(0.01, 0.05 * (1 - seasonProgress));
      } else {
        // Still in contention
        const positionFactor = Math.max(0, 1 - (leaguePosition - 1) / 5);
        const gapFactor = Math.max(
          0,
          1 - pointsFromTop / (gamesRemaining * 3 + 1),
        );
        const formFactor = this.formQuality(standings.formString);

        prob = positionFactor * 0.3 + gapFactor * 0.4 + formFactor * 0.3;
        prob *= 1 - seasonProgress * 0.3; // Discount more as season progresses (harder to catch up)

        // Cap at reasonable levels
        prob = Math.max(0.01, Math.min(0.4, prob));
      }
    }

    return Math.max(0.01, Math.min(0.99, prob));
  }

  /**
   * Estimate probability of qualifying (e.g., for World Cup).
   */
  private estimateQualificationProbability(
    standings: TeamStandingsContext,
  ): number {
    // Qualification typically means finishing in top N positions
    // For European WC qualifiers: top 2 in group + some 3rd-place playoff
    const qualifyingPositions = Math.ceil(standings.totalTeams * 0.4); // ~40% qualify

    if (standings.leaguePosition <= qualifyingPositions) {
      // Currently in a qualifying position
      const buffer = qualifyingPositions - standings.leaguePosition;
      return Math.min(0.95, 0.6 + buffer * 0.1);
    } else {
      // Outside qualifying positions
      const deficit = standings.leaguePosition - qualifyingPositions;
      return Math.max(0.05, 0.4 - deficit * 0.1);
    }
  }

  /**
   * Estimate probability of finishing in top 4.
   */
  private estimateTop4Probability(standings: TeamStandingsContext): number {
    if (standings.leaguePosition <= 4) {
      const buffer = 4 - standings.leaguePosition;
      return Math.min(0.95, 0.55 + buffer * 0.1);
    } else {
      const deficit = standings.leaguePosition - 4;
      return Math.max(0.05, 0.4 - deficit * 0.08);
    }
  }

  /**
   * Calculate form quality from a form string like "WWDLW".
   * Returns 0-1 where 1 = all wins.
   */
  private formQuality(formString: string): number {
    if (!formString) return 0.5;
    let score = 0;
    let count = 0;
    for (const ch of formString.toUpperCase()) {
      if (ch === 'W') {
        score += 1;
        count++;
      } else if (ch === 'D') {
        score += 0.33;
        count++;
      } else if (ch === 'L') {
        count++;
      }
    }
    return count > 0 ? score / count : 0.5;
  }

  // ─── Fixture candidate building (kept for match_outcome markets) ────

  private async buildFixtureCandidate(
    match: FixtureMarketMatch,
    minEdge: number,
  ): Promise<FixtureTradingCandidate | null> {
    const minConfidence =
      this.config.get<number>('POLYMARKET_MIN_CONFIDENCE') || 6;

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

    if (!prediction) return null;
    if ((prediction.confidence ?? 0) < minConfidence) return null;

    const primaryTokenId = match.market.clobTokenIds[0];
    if (!primaryTokenId) return null;

    const pricing =
      await this.clobService.getMarketPricingSnapshot(primaryTokenId);
    if (!pricing) return null;

    // Map prediction to market outcome
    const { ensembleProb, outcomeDescription } =
      this.mapFixturePredictionToOutcome(match, prediction);

    if (ensembleProb == null) return null;

    const polymarketProb = pricing.midpoint;
    const rawEdge = ensembleProb - polymarketProb;
    const inverseEdge = 1 - ensembleProb - (1 - polymarketProb);

    if (rawEdge < minEdge && inverseEdge < minEdge) return null;

    let pricingNo: MarketPricingSnapshot | undefined;
    const secondTokenId = match.market.clobTokenIds[1];
    if (inverseEdge > rawEdge && secondTokenId) {
      const noSnapshot =
        await this.clobService.getMarketPricingSnapshot(secondTokenId);
      if (noSnapshot) pricingNo = noSnapshot;
    }

    const bestEdge = Math.max(rawEdge, inverseEdge);
    const bestPricing =
      inverseEdge > rawEdge && pricingNo ? pricingNo : pricing;
    const bestEnsembleProb =
      inverseEdge > rawEdge ? 1 - ensembleProb : ensembleProb;
    const bestPolymarketProb =
      inverseEdge > rawEdge ? 1 - polymarketProb : polymarketProb;

    return {
      type: 'fixture',
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
    };
  }

  /**
   * Map fixture prediction probabilities to the market's outcome.
   * (Same logic as before — for "Will X beat Y?" markets)
   */
  private mapFixturePredictionToOutcome(
    match: FixtureMarketMatch,
    prediction: any,
  ): { ensembleProb: number | null; outcomeDescription: string } {
    const question = match.market.question.toLowerCase();
    const title = match.event.title.toLowerCase();
    const text = `${question} ${title}`;

    const homeTeamNorm = match.homeTeamName.toLowerCase();
    const awayTeamNorm = match.awayTeamName.toLowerCase();

    if (
      text.includes(homeTeamNorm) &&
      (text.includes('beat') || text.includes('win') || text.includes('defeat'))
    ) {
      if (
        text.includes(awayTeamNorm) &&
        text.indexOf(homeTeamNorm) < text.indexOf(awayTeamNorm)
      ) {
        return {
          ensembleProb: Number(prediction.homeWinProb),
          outcomeDescription: `${match.homeTeamName} Win`,
        };
      }
    }

    if (
      text.includes(awayTeamNorm) &&
      (text.includes('beat') || text.includes('win') || text.includes('defeat'))
    ) {
      if (
        text.includes(homeTeamNorm) &&
        text.indexOf(awayTeamNorm) < text.indexOf(homeTeamNorm)
      ) {
        return {
          ensembleProb: Number(prediction.awayWinProb),
          outcomeDescription: `${match.awayTeamName} Win`,
        };
      }
    }

    const outcomes = match.market.outcomes.map((o) => o.toLowerCase());
    if (outcomes.includes('yes') && outcomes.includes('no')) {
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

    this.logger.warn(
      `Could not map prediction to market outcome: "${match.market.question}"`,
    );
    return { ensembleProb: null, outcomeDescription: '' };
  }

  // ─── Trade execution ────────────────────────────────────────────────

  /**
   * Execute a trade — either paper or live.
   */
  private async executeTrade(
    candidate: TradingCandidate,
    decision: TradingDecision,
    bankroll: any,
  ): Promise<void> {
    const isLive =
      this.config.get<string>('POLYMARKET_LIVE_TRADING') === 'true';
    const mode = isLive ? 'live' : 'paper';

    // ── Budget guard: never exceed initial budget ─────────────────────
    const currentBalance = Number(bankroll.currentBalance);
    const maxPositionPct =
      this.config.get<number>('POLYMARKET_MAX_POSITION_PCT') || 0.1;
    const maxPositionSize = currentBalance * maxPositionPct;
    const minTradeSize = 1; // $1 minimum to be worth placing

    if (currentBalance <= 0) {
      this.logger.warn(
        `Budget exhausted ($${currentBalance.toFixed(2)} remaining) — skipping trade`,
      );
      return;
    }

    // Cap position size to: min(agent suggestion, max position %, remaining balance)
    let positionSizeUsd = Math.min(
      decision.positionSizeUsd,
      maxPositionSize,
      currentBalance,
    );

    if (positionSizeUsd < minTradeSize) {
      this.logger.warn(
        `Position size $${positionSizeUsd.toFixed(2)} below minimum $${minTradeSize} — skipping trade`,
      );
      return;
    }

    if (positionSizeUsd < decision.positionSizeUsd) {
      this.logger.log(
        `Budget guard: capped position from $${decision.positionSizeUsd.toFixed(2)} → $${positionSizeUsd.toFixed(2)} ` +
          `(balance: $${currentBalance.toFixed(2)}, max position: $${maxPositionSize.toFixed(2)})`,
      );
    }

    // Use the capped size from here on
    decision = { ...decision, positionSizeUsd };

    const marketRecord = await this.getOrCreateMarketRecord(candidate.match);

    let orderId: string | null = null;
    let orderStatus = 'filled';

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

    const tokenQuantity = decision.positionSizeUsd / decision.entryPrice;

    // Determine ensemble probability based on candidate type
    const ensembleProbability =
      candidate.type === 'outright'
        ? candidate.estimatedProbability
        : candidate.ensembleProbability;
    const polymarketProbability = candidate.polymarketProbability;

    // Build trade record values
    const tradeValues: any = {
      polymarketMarketId: marketRecord.id,
      fixtureId:
        candidate.type === 'fixture' ? candidate.match.fixtureId : null,
      leagueId: candidate.type === 'outright' ? candidate.match.leagueId : null,
      teamId: candidate.type === 'outright' ? candidate.match.teamId : null,
      mode,
      side: 'buy',
      outcomeIndex: decision.outcomeIndex,
      outcomeName: decision.outcomeName,
      entryPrice: String(decision.entryPrice),
      midpointAtEntry: String(candidate.pricing.midpoint),
      spreadAtEntry: String(candidate.pricing.spread),
      positionSizeUsd: String(decision.positionSizeUsd),
      tokenQuantity: String(tokenQuantity),
      ensembleProbability: String(ensembleProbability),
      polymarketProbability: String(polymarketProbability),
      edgePercent: String(decision.edgePercent),
      kellyFraction: String(decision.kellyFraction),
      confidenceAtEntry:
        candidate.type === 'fixture'
          ? candidate.prediction.confidence
          : decision.confidenceInEdge,
      agentReasoning: decision.reasoning,
      riskAssessment: decision.riskAssessment,
      bankrollAtEntry: String(Number(bankroll.currentBalance)),
      openPositionsCount: bankroll.openPositionsCount,
      orderId,
      orderStatus,
      fillPrice: isLive ? null : String(decision.entryPrice),
      fillTimestamp: isLive ? null : new Date(),
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add predictionId only for fixture trades
    if (candidate.type === 'fixture') {
      tradeValues.predictionId = candidate.prediction.id;
    }

    await this.db.insert(schema.polymarketTrades).values(tradeValues);

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

    const label =
      candidate.type === 'outright'
        ? `${candidate.match.teamName} to win ${candidate.match.leagueName}`
        : `${decision.outcomeName}`;

    this.logger.log(
      `[${mode.toUpperCase()}] Trade placed: ${label} ` +
        `$${decision.positionSizeUsd.toFixed(2)} @ ${decision.entryPrice.toFixed(3)} ` +
        `(edge: ${decision.edgePercent.toFixed(1)}%, Kelly: ${decision.kellyFraction.toFixed(3)})`,
    );
  }

  private async logSkippedTrade(
    candidate: TradingCandidate,
    decision: TradingDecision,
  ): Promise<void> {
    const label =
      candidate.type === 'outright'
        ? `${candidate.match.teamName} in ${candidate.match.leagueName}`
        : `${(candidate.match as FixtureMarketMatch).homeTeamName} vs ${(candidate.match as FixtureMarketMatch).awayTeamName}`;

    this.logger.debug(
      `SKIP: ${label} (edge: ${(candidate.rawEdge * 100).toFixed(1)}%) — ${decision.reasoning.substring(0, 200)}`,
    );
  }

  // ─── Trade resolution ───────────────────────────────────────────────

  /**
   * Resolve open trades.
   * - Fixture trades: Resolved when the match finishes
   * - Outright trades: Resolved when the market closes on Polymarket
   *   (we check the Gamma API for closed markets)
   */
  async resolveCompletedTrades(): Promise<{
    resolved: number;
    errors: string[];
  }> {
    let resolved = 0;
    const errors: string[] = [];

    // Resolve fixture-based trades (match finished)
    const fixtureResult = await this.resolveFixtureTrades();
    resolved += fixtureResult.resolved;
    errors.push(...fixtureResult.errors);

    // Resolve outright trades (market closed on Polymarket)
    const outrightResult = await this.resolveOutrightTrades();
    resolved += outrightResult.resolved;
    errors.push(...outrightResult.errors);

    if (resolved > 0) {
      await this.updateBankrollSnapshot();
    }

    return { resolved, errors };
  }

  /**
   * Resolve fixture-based trades where the match has finished.
   */
  private async resolveFixtureTrades(): Promise<{
    resolved: number;
    errors: string[];
  }> {
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
          sql`${schema.polymarketTrades.fixtureId} IS NOT NULL`,
        ),
      );

    let resolved = 0;
    const errors: string[] = [];

    for (const { trade, fixture, prediction } of openTrades) {
      try {
        const homeGoals = fixture.goalsHome ?? 0;
        const awayGoals = fixture.goalsAway ?? 0;
        let actualResult: string;
        if (homeGoals > awayGoals) actualResult = 'home_win';
        else if (awayGoals > homeGoals) actualResult = 'away_win';
        else actualResult = 'draw';

        const tradeWon = this.didFixtureTradeWin(
          trade,
          fixture,
          prediction,
          actualResult,
        );

        const exitPrice = tradeWon ? 1.0 : 0.0;
        const entryPrice = Number(trade.entryPrice);
        const positionSize = Number(trade.positionSizeUsd);
        const tokenQty =
          Number(trade.tokenQuantity) || positionSize / entryPrice;
        const pnlUsd = tradeWon
          ? tokenQty * (exitPrice - entryPrice)
          : -positionSize;
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
          `Fixture trade resolved: ${trade.outcomeName} — ${tradeWon ? 'WIN' : 'LOSS'} P&L: $${pnlUsd.toFixed(2)}`,
        );
      } catch (error) {
        errors.push(`Failed to resolve trade ${trade.id}: ${error.message}`);
      }
    }

    return { resolved, errors };
  }

  /**
   * Resolve outright trades by checking if the Polymarket market has closed.
   *
   * Uses fetchMarketForResolution() which returns raw market data INCLUDING
   * closed markets — unlike fetchEventById which filters them out.
   * When a market resolves, outcome prices go to $1 (winner) / $0 (loser).
   */
  private async resolveOutrightTrades(): Promise<{
    resolved: number;
    errors: string[];
  }> {
    // Find open outright trades
    const openTrades = await this.db
      .select({
        trade: schema.polymarketTrades,
        market: schema.polymarketMarkets,
      })
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
          eq(schema.polymarketTrades.status, 'open'),
          sql`${schema.polymarketTrades.fixtureId} IS NULL`, // Outright trades have no fixture
          sql`${schema.polymarketTrades.leagueId} IS NOT NULL`, // But they have a league
        ),
      );

    let resolved = 0;
    const errors: string[] = [];

    for (const { trade, market } of openTrades) {
      try {
        // Fetch the market directly — this returns data even for closed markets
        const freshMarket = await this.gammaService.fetchMarketForResolution(
          market.marketId,
        );

        if (!freshMarket) continue;

        // Only resolve if the market is actually closed
        if (!freshMarket.closed) continue;

        // Check outcome prices — resolved markets have one outcome at ~$1
        const prices = freshMarket.outcomePrices;
        let resolvedOutcome: number | null = null;

        for (let i = 0; i < prices.length; i++) {
          if (prices[i] >= 0.99) resolvedOutcome = i;
        }

        if (resolvedOutcome === null) {
          // Market is closed but no clear winner — might be cancelled/voided
          this.logger.warn(
            `Outright market ${market.marketId} is closed but no outcome >= 0.99. ` +
              `Prices: ${prices.join(', ')}. Skipping resolution.`,
          );
          continue;
        }

        const tradeWon = trade.outcomeIndex === resolvedOutcome;
        const exitPrice = tradeWon ? 1.0 : 0.0;
        const entryPrice = Number(trade.entryPrice);
        const positionSize = Number(trade.positionSizeUsd);
        const tokenQty =
          Number(trade.tokenQuantity) || positionSize / entryPrice;
        const pnlUsd = tradeWon
          ? tokenQty * (exitPrice - entryPrice)
          : -positionSize;
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
          `Outright trade resolved: ${trade.outcomeName} — ` +
            `${tradeWon ? 'WIN' : 'LOSS'} P&L: $${pnlUsd.toFixed(2)} ` +
            `(entry: ${entryPrice.toFixed(3)}, exit: ${exitPrice.toFixed(1)})`,
        );
      } catch (error) {
        errors.push(
          `Failed to resolve outright trade ${trade.id}: ${error.message}`,
        );
      }
    }

    return { resolved, errors };
  }

  private didFixtureTradeWin(
    trade: any,
    fixture: any,
    prediction: any,
    actualResult: string,
  ): boolean {
    const outcomeName = trade.outcomeName?.toLowerCase() ?? '';
    const outcomeIndex = trade.outcomeIndex ?? 0;

    if (outcomeName.includes('home')) return actualResult === 'home_win';
    if (outcomeName.includes('away')) return actualResult === 'away_win';
    if (outcomeName.includes('draw')) return actualResult === 'draw';

    if (outcomeName.includes('yes')) {
      const ensembleProb = Number(trade.ensembleProbability);
      const homeWinProb = Number(prediction?.homeWinProb ?? 0);
      if (Math.abs(ensembleProb - homeWinProb) < 0.1)
        return actualResult === 'home_win';
      const awayWinProb = Number(prediction?.awayWinProb ?? 0);
      if (Math.abs(ensembleProb - awayWinProb) < 0.1)
        return actualResult === 'away_win';
    }

    if (outcomeName.includes('no')) {
      const ensembleProb = Number(trade.ensembleProbability);
      const homeWinProb = Number(prediction?.homeWinProb ?? 0);
      if (Math.abs(1 - ensembleProb - homeWinProb) < 0.1)
        return actualResult !== 'home_win';
    }

    return outcomeIndex === 0
      ? prediction?.wasCorrect === true
      : prediction?.wasCorrect === false;
  }

  // ─── Bankroll management ────────────────────────────────────────────

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

  async updateBankrollSnapshot(): Promise<void> {
    const bankroll = await this.getOrCreateBankroll();
    const stopLossPct =
      this.config.get<number>('POLYMARKET_STOP_LOSS_PCT') || 0.3;

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

  private async persistMarkets(matches: MarketMatch[]): Promise<void> {
    for (const match of matches) {
      const market = match.market;

      const values: any = {
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
        matchScore: String(match.matchScore),
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Set linking fields based on market type
      if (match.marketType === 'match_outcome') {
        const fixtureMatch = match as FixtureMarketMatch;
        values.fixtureId = fixtureMatch.fixtureId;
      } else {
        const outrightMatch = match as OutrightMarketMatch;
        values.leagueId = outrightMatch.leagueId;
        values.leagueName = outrightMatch.leagueName;
        values.teamId = outrightMatch.teamId;
        values.teamName = outrightMatch.teamName;
        values.season = outrightMatch.season;
      }

      await this.db
        .insert(schema.polymarketMarkets)
        .values(values)
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
            matchScore: String(match.matchScore),
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
            // Update linking fields too
            ...(match.marketType === 'match_outcome'
              ? { fixtureId: (match as FixtureMarketMatch).fixtureId }
              : {
                  leagueId: (match as OutrightMarketMatch).leagueId,
                  leagueName: (match as OutrightMarketMatch).leagueName,
                  teamId: (match as OutrightMarketMatch).teamId,
                  teamName: (match as OutrightMarketMatch).teamName,
                  season: (match as OutrightMarketMatch).season,
                }),
          },
        });
    }
  }

  private async getOrCreateMarketRecord(match: MarketMatch): Promise<any> {
    const existing = await this.db
      .select()
      .from(schema.polymarketMarkets)
      .where(eq(schema.polymarketMarkets.marketId, match.market.marketId))
      .limit(1);

    if (existing.length > 0) return existing[0];

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
    Array<{
      outcomeName: string;
      fixtureId?: number;
      leagueId?: number;
      positionSizeUsd: number;
    }>
  > {
    const isLive =
      this.config.get<string>('POLYMARKET_LIVE_TRADING') === 'true';
    const mode = isLive ? 'live' : 'paper';

    const trades = await this.db
      .select({
        outcomeName: schema.polymarketTrades.outcomeName,
        fixtureId: schema.polymarketTrades.fixtureId,
        leagueId: schema.polymarketTrades.leagueId,
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
      fixtureId: t.fixtureId ?? undefined,
      leagueId: t.leagueId ?? undefined,
      positionSizeUsd: Number(t.positionSizeUsd),
    }));
  }

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
      conditions.push(
        sql`(${schema.polymarketMarkets.fixtureId} IS NOT NULL OR ${schema.polymarketMarkets.teamId} IS NOT NULL)`,
      );
    }
    if (filters?.matched === false) {
      conditions.push(isNull(schema.polymarketMarkets.fixtureId));
      conditions.push(isNull(schema.polymarketMarkets.teamId));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(schema.polymarketMarkets)
      .where(where)
      .orderBy(desc(schema.polymarketMarkets.lastSyncedAt))
      .limit(limit);
  }

  // ─── Trades by month ────────────────────────────────────────────────

  /**
   * Get trades filtered by month and year, joined with market details.
   */
  async getTradesByMonth(month: number, year: number): Promise<any[]> {
    // Build date range for the given month (1-indexed)
    const startDate = new Date(year, month - 1, 1); // First day of month
    const endDate = new Date(year, month, 1); // First day of next month

    const rows = await this.db
      .select({
        trade: schema.polymarketTrades,
        market: schema.polymarketMarkets,
      })
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
          gte(schema.polymarketTrades.createdAt, startDate),
          lte(schema.polymarketTrades.createdAt, endDate),
        ),
      )
      .orderBy(desc(schema.polymarketTrades.createdAt));

    return rows.map(({ trade, market }: any) => ({
      id: trade.id,
      mode: trade.mode,
      side: trade.side,
      outcomeIndex: trade.outcomeIndex,
      outcomeName: trade.outcomeName,
      entryPrice: Number(trade.entryPrice),
      fillPrice: trade.fillPrice ? Number(trade.fillPrice) : null,
      positionSizeUsd: Number(trade.positionSizeUsd),
      tokenQuantity: trade.tokenQuantity ? Number(trade.tokenQuantity) : null,
      ensembleProbability: Number(trade.ensembleProbability),
      polymarketProbability: Number(trade.polymarketProbability),
      edgePercent: Number(trade.edgePercent),
      kellyFraction: trade.kellyFraction ? Number(trade.kellyFraction) : null,
      confidenceAtEntry: trade.confidenceAtEntry,
      agentReasoning: trade.agentReasoning,
      riskAssessment: trade.riskAssessment,
      bankrollAtEntry: trade.bankrollAtEntry
        ? Number(trade.bankrollAtEntry)
        : null,
      orderId: trade.orderId,
      orderStatus: trade.orderStatus,
      status: trade.status,
      pnlUsd: trade.pnlUsd ? Number(trade.pnlUsd) : null,
      pnlPercent: trade.pnlPercent ? Number(trade.pnlPercent) : null,
      resolutionOutcome: trade.resolutionOutcome,
      createdAt: trade.createdAt,
      resolvedAt: trade.resolvedAt,
      // Market details
      market: {
        eventTitle: market.eventTitle,
        marketQuestion: market.marketQuestion,
        marketType: market.marketType,
        outcomes: market.outcomes,
        startDate: market.startDate,
        endDate: market.endDate,
        leagueName: market.leagueName,
        teamName: market.teamName,
        season: market.season,
        liquidity: market.liquidity ? Number(market.liquidity) : null,
        volume: market.volume ? Number(market.volume) : null,
        active: market.active,
        closed: market.closed,
      },
    }));
  }

  // ─── Upcoming trades ─────────────────────────────────────────────────

  /**
   * Get upcoming open trades — sorted by market end date (soonest resolution first).
   *
   * Filters:
   * - limit: max trades to return (default 5)
   * - month + year: only trades created in that month
   * - mode: 'paper' | 'live' | undefined (all)
   */
  async getUpcomingTrades(filters?: {
    limit?: number;
    month?: number;
    year?: number;
    mode?: string;
  }): Promise<any[]> {
    const limit = filters?.limit ?? 5;
    const conditions: any[] = [eq(schema.polymarketTrades.status, 'open')];

    if (filters?.month && filters?.year) {
      const startDate = new Date(filters.year, filters.month - 1, 1);
      const endDate = new Date(filters.year, filters.month, 1);
      conditions.push(gte(schema.polymarketTrades.createdAt, startDate));
      conditions.push(lte(schema.polymarketTrades.createdAt, endDate));
    }

    if (filters?.mode) {
      conditions.push(eq(schema.polymarketTrades.mode, filters.mode));
    }

    const rows = await this.db
      .select({
        trade: schema.polymarketTrades,
        market: schema.polymarketMarkets,
      })
      .from(schema.polymarketTrades)
      .innerJoin(
        schema.polymarketMarkets,
        eq(
          schema.polymarketTrades.polymarketMarketId,
          schema.polymarketMarkets.id,
        ),
      )
      .where(and(...conditions))
      .orderBy(
        asc(schema.polymarketMarkets.endDate), // Soonest resolution first
        desc(schema.polymarketTrades.createdAt),
      )
      .limit(limit);

    return rows.map(({ trade, market }: any) => {
      const entryPrice = Number(trade.entryPrice);
      const positionSizeUsd = Number(trade.positionSizeUsd);
      const tokenQuantity =
        Number(trade.tokenQuantity) || positionSizeUsd / entryPrice;
      const ensembleProb = Number(trade.ensembleProbability);

      const payoutIfWin = tokenQuantity * 1.0;
      const profitIfWin = payoutIfWin - positionSizeUsd;
      const roiIfWin =
        positionSizeUsd > 0 ? (profitIfWin / positionSizeUsd) * 100 : 0;
      const lossIfLoss = -positionSizeUsd;
      const expectedValue =
        ensembleProb * profitIfWin + (1 - ensembleProb) * lossIfLoss;

      return {
        id: trade.id,
        mode: trade.mode,
        side: trade.side,
        outcomeIndex: trade.outcomeIndex,
        outcomeName: trade.outcomeName,
        entryPrice,
        positionSizeUsd,
        tokenQuantity: Number(tokenQuantity.toFixed(4)),
        ensembleProbability: ensembleProb,
        polymarketProbability: Number(trade.polymarketProbability),
        edgePercent: Number(trade.edgePercent),
        confidenceAtEntry: trade.confidenceAtEntry,
        agentReasoning: trade.agentReasoning,
        status: trade.status,
        createdAt: trade.createdAt,
        // Projections
        payoutIfWin: Number(payoutIfWin.toFixed(2)),
        profitIfWin: Number(profitIfWin.toFixed(2)),
        roiIfWin: Number(roiIfWin.toFixed(2)),
        lossIfLoss: Number(lossIfLoss.toFixed(2)),
        expectedValue: Number(expectedValue.toFixed(2)),
        // Market details
        market: {
          eventTitle: market.eventTitle,
          marketQuestion: market.marketQuestion,
          marketType: market.marketType,
          outcomes: market.outcomes,
          startDate: market.startDate,
          endDate: market.endDate,
          leagueName: market.leagueName,
          teamName: market.teamName,
          season: market.season,
          liquidity: market.liquidity ? Number(market.liquidity) : null,
          active: market.active,
          closed: market.closed,
        },
      };
    });
  }

  // ─── Potential profit projection ─────────────────────────────────────

  /**
   * Calculate potential profit for open trades if outcomes are predicted correctly.
   *
   * Binary outcome tokens pay $1 on a win. So:
   *   tokenQuantity = positionSizeUsd / entryPrice
   *   payout = tokenQuantity * $1
   *   profit = payout - positionSizeUsd
   *   ROI = profit / positionSizeUsd
   *
   * Groups trades by market type and league for aggregated projections.
   */
  async getPotentialProfit(filters?: {
    month?: number;
    year?: number;
    status?: string;
  }): Promise<any> {
    const conditions: any[] = [];

    if (filters?.month && filters?.year) {
      const startDate = new Date(filters.year, filters.month - 1, 1);
      const endDate = new Date(filters.year, filters.month, 1);
      conditions.push(gte(schema.polymarketTrades.createdAt, startDate));
      conditions.push(lte(schema.polymarketTrades.createdAt, endDate));
    }

    if (filters?.status) {
      conditions.push(eq(schema.polymarketTrades.status, filters.status));
    } else {
      // Default to open trades
      conditions.push(eq(schema.polymarketTrades.status, 'open'));
    }

    const rows = await this.db
      .select({
        trade: schema.polymarketTrades,
        market: schema.polymarketMarkets,
      })
      .from(schema.polymarketTrades)
      .innerJoin(
        schema.polymarketMarkets,
        eq(
          schema.polymarketTrades.polymarketMarketId,
          schema.polymarketMarkets.id,
        ),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.polymarketTrades.createdAt));

    // Per-trade projections
    const trades = rows.map(({ trade, market }: any) => {
      const entryPrice = Number(trade.entryPrice);
      const positionSizeUsd = Number(trade.positionSizeUsd);
      const tokenQuantity =
        Number(trade.tokenQuantity) || positionSizeUsd / entryPrice;

      // If win: each token pays $1
      const payoutIfWin = tokenQuantity * 1.0;
      const profitIfWin = payoutIfWin - positionSizeUsd;
      const roiIfWin = positionSizeUsd > 0 ? profitIfWin / positionSizeUsd : 0;

      // If loss: tokens worth $0
      const lossIfLoss = -positionSizeUsd;

      // Expected value based on our ensemble probability
      const ensembleProb = Number(trade.ensembleProbability);
      const expectedValue =
        ensembleProb * profitIfWin + (1 - ensembleProb) * lossIfLoss;

      return {
        id: trade.id,
        mode: trade.mode,
        outcomeName: trade.outcomeName,
        status: trade.status,
        entryPrice,
        positionSizeUsd,
        tokenQuantity: Number(tokenQuantity.toFixed(4)),
        ensembleProbability: ensembleProb,
        polymarketProbability: Number(trade.polymarketProbability),
        edgePercent: Number(trade.edgePercent),
        // Projections
        payoutIfWin: Number(payoutIfWin.toFixed(2)),
        profitIfWin: Number(profitIfWin.toFixed(2)),
        roiIfWin: Number((roiIfWin * 100).toFixed(2)), // as percentage
        lossIfLoss: Number(lossIfLoss.toFixed(2)),
        expectedValue: Number(expectedValue.toFixed(2)),
        createdAt: trade.createdAt,
        // Market context
        market: {
          eventTitle: market.eventTitle,
          marketQuestion: market.marketQuestion,
          marketType: market.marketType,
          leagueName: market.leagueName,
          teamName: market.teamName,
          endDate: market.endDate,
        },
      };
    });

    // Aggregates
    const totalCost = trades.reduce((s, t) => s + t.positionSizeUsd, 0);
    const totalPayoutIfAllWin = trades.reduce((s, t) => s + t.payoutIfWin, 0);
    const totalProfitIfAllWin = trades.reduce((s, t) => s + t.profitIfWin, 0);
    const totalExpectedValue = trades.reduce((s, t) => s + t.expectedValue, 0);

    // Group by market type
    const byMarketType: Record<
      string,
      {
        count: number;
        totalCost: number;
        profitIfAllWin: number;
        expectedValue: number;
      }
    > = {};
    for (const t of trades) {
      const type = t.market.marketType;
      if (!byMarketType[type]) {
        byMarketType[type] = {
          count: 0,
          totalCost: 0,
          profitIfAllWin: 0,
          expectedValue: 0,
        };
      }
      byMarketType[type].count++;
      byMarketType[type].totalCost += t.positionSizeUsd;
      byMarketType[type].profitIfAllWin += t.profitIfWin;
      byMarketType[type].expectedValue += t.expectedValue;
    }

    // Group by league
    const byLeague: Record<
      string,
      {
        count: number;
        totalCost: number;
        profitIfAllWin: number;
        expectedValue: number;
      }
    > = {};
    for (const t of trades) {
      const league = t.market.leagueName || 'Unknown';
      if (!byLeague[league]) {
        byLeague[league] = {
          count: 0,
          totalCost: 0,
          profitIfAllWin: 0,
          expectedValue: 0,
        };
      }
      byLeague[league].count++;
      byLeague[league].totalCost += t.positionSizeUsd;
      byLeague[league].profitIfAllWin += t.profitIfWin;
      byLeague[league].expectedValue += t.expectedValue;
    }

    // Round group values
    for (const g of [
      ...Object.values(byMarketType),
      ...Object.values(byLeague),
    ]) {
      g.totalCost = Number(g.totalCost.toFixed(2));
      g.profitIfAllWin = Number(g.profitIfAllWin.toFixed(2));
      g.expectedValue = Number(g.expectedValue.toFixed(2));
    }

    // Bankroll context
    const bankroll = await this.getOrCreateBankroll();
    const initialBudget = Number(bankroll.initialBudget);
    const currentBalance = Number(bankroll.currentBalance);
    const realizedPnl = Number(bankroll.realizedPnl);

    return {
      budget: {
        mode: bankroll.mode,
        initialBudget,
        currentBalance,
        realizedPnl,
        openPositionsCount: bankroll.openPositionsCount,
        openPositionsValue: Number(bankroll.openPositionsValue),
        availableBalance: currentBalance,
        balanceIfAllWin: Number(
          (currentBalance + totalProfitIfAllWin).toFixed(2),
        ),
        returnOnBudgetIfAllWin:
          initialBudget > 0
            ? Number(
                (
                  ((currentBalance + totalProfitIfAllWin - initialBudget) /
                    initialBudget) *
                  100
                ).toFixed(2),
              )
            : 0,
        multiplierIfAllWin:
          initialBudget > 0
            ? Number(
                (
                  (currentBalance + totalProfitIfAllWin) /
                  initialBudget
                ).toFixed(2),
              )
            : 0,
      },
      trades,
      count: trades.length,
      summary: {
        totalCost: Number(totalCost.toFixed(2)),
        totalPayoutIfAllWin: Number(totalPayoutIfAllWin.toFixed(2)),
        totalProfitIfAllWin: Number(totalProfitIfAllWin.toFixed(2)),
        totalRoiIfAllWin:
          totalCost > 0
            ? Number(((totalProfitIfAllWin / totalCost) * 100).toFixed(2))
            : 0,
        totalExpectedValue: Number(totalExpectedValue.toFixed(2)),
      },
      byMarketType,
      byLeague,
    };
  }

  // ─── Adjust trade budgets ────────────────────────────────────────────

  /**
   * Adjust the position size of open trades — scale up or down.
   *
   * Sizing modes:
   * - `amount`: Total budget to distribute across all targeted trades
   *   proportionally (weighted by current position size).
   *   e.g. { all: true, amount: 200 } — redistribute $200 across all open
   *   trades, each getting a share proportional to its current weight.
   * - `multiplier`: Scale each trade's position by a factor.
   *   e.g. { multiplier: 2 } — double, { multiplier: 0.5 } — halve
   *
   * When scaling UP, the total increase is capped by available bankroll balance.
   * When scaling DOWN, freed funds are returned to the bankroll.
   */
  async adjustTradeBudgets(params: {
    tradeIds?: number[];
    month?: number;
    year?: number;
    all?: boolean;
    amount?: number; // Total budget to distribute across targeted trades
    multiplier?: number; // Relative scale factor (e.g. 2 = double, 0.5 = halve)
  }): Promise<{
    adjusted: number;
    skipped: number;
    totalDelta: number;
    results: Array<{
      tradeId: number;
      outcomeName: string;
      status: 'adjusted' | 'skipped';
      oldSize: number;
      newSize: number;
      delta: number;
      entryPrice: number;
      tokenQuantity: number;
      payoutIfWin: number;
      profitIfWin: number;
      roiIfWin: number;
      lossIfLoss: number;
      ensembleProbability: number;
      expectedValue: number;
      reason?: string;
      market?: {
        eventTitle: string;
        marketQuestion: string;
        marketType: string;
        leagueName: string | null;
        teamName: string | null;
      };
    }>;
    projection: {
      totalCost: number;
      totalPayoutIfAllWin: number;
      totalProfitIfAllWin: number;
      totalRoiIfAllWin: number;
      totalExpectedValue: number;
    };
    budget: {
      mode: string;
      initialBudget: number;
      currentBalance: number;
      balanceIfAllWin: number;
      multiplierIfAllWin: number;
    };
  }> {
    if (params.amount === undefined && params.multiplier === undefined) {
      throw new Error('Must provide either amount or multiplier.');
    }
    if (params.amount !== undefined && params.multiplier !== undefined) {
      throw new Error('Provide either amount or multiplier, not both.');
    }
    if (params.amount !== undefined && params.amount < 0) {
      throw new Error('Amount must be >= 0.');
    }
    if (params.multiplier !== undefined && params.multiplier < 0) {
      throw new Error('Multiplier must be >= 0.');
    }

    // Build conditions to find target trades
    const conditions: any[] = [eq(schema.polymarketTrades.status, 'open')];

    if (params.tradeIds && params.tradeIds.length > 0) {
      conditions.push(inArray(schema.polymarketTrades.id, params.tradeIds));
    } else if (params.month && params.year) {
      const startDate = new Date(params.year, params.month - 1, 1);
      const endDate = new Date(params.year, params.month, 1);
      conditions.push(gte(schema.polymarketTrades.createdAt, startDate));
      conditions.push(lte(schema.polymarketTrades.createdAt, endDate));
    } else if (!params.all) {
      throw new Error(
        'Must provide tradeIds, month+year, or all=true to specify which trades to adjust.',
      );
    }

    const tradeRows = await this.db
      .select({
        trade: schema.polymarketTrades,
        market: schema.polymarketMarkets,
      })
      .from(schema.polymarketTrades)
      .innerJoin(
        schema.polymarketMarkets,
        eq(
          schema.polymarketTrades.polymarketMarketId,
          schema.polymarketMarkets.id,
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.polymarketTrades.createdAt));

    if (tradeRows.length === 0) {
      return {
        adjusted: 0,
        skipped: 0,
        totalDelta: 0,
        results: [],
        projection: {
          totalCost: 0,
          totalPayoutIfAllWin: 0,
          totalProfitIfAllWin: 0,
          totalRoiIfAllWin: 0,
          totalExpectedValue: 0,
        },
        budget: {
          mode: 'paper',
          initialBudget: 0,
          currentBalance: 0,
          balanceIfAllWin: 0,
          multiplierIfAllWin: 0,
        },
      };
    }

    // Get bankroll for the mode of the first trade (paper or live)
    const mode = tradeRows[0].trade.mode;
    const bankroll = await this.db
      .select()
      .from(schema.polymarketBankroll)
      .where(eq(schema.polymarketBankroll.mode, mode))
      .orderBy(desc(schema.polymarketBankroll.updatedAt))
      .limit(1);

    if (bankroll.length === 0) {
      throw new Error(`No bankroll found for mode: ${mode}`);
    }

    let availableBalance = Number(bankroll[0].currentBalance);

    // ── Compute new sizes for all trades up front ─────────────────────
    // For `amount`: distribute the total budget proportionally by current weight
    // For `multiplier`: scale each trade individually

    const currentTotalSize = tradeRows.reduce(
      (sum: number, row: any) => sum + Number(row.trade.positionSizeUsd),
      0,
    );

    // If using amount, figure out the effective budget we can actually deploy
    let targetBudget = params.amount;
    if (targetBudget !== undefined) {
      // The net change needed = targetBudget - currentTotalSize
      // If scaling up, cap by available balance
      const netChange = targetBudget - currentTotalSize;
      if (netChange > 0 && netChange > availableBalance) {
        // Cap to what we can afford
        targetBudget = currentTotalSize + availableBalance;
        this.logger.log(
          `Budget guard: capped target from $${params.amount!.toFixed(2)} → $${targetBudget.toFixed(2)} ` +
            `(only $${availableBalance.toFixed(2)} available to add)`,
        );
      }
    }

    let adjusted = 0;
    let skipped = 0;
    let totalDelta = 0;
    const results: Array<any> = [];

    // Helper to compute projection for a trade
    const computeProjection = (
      size: number,
      entry: number,
      ensembleProb: number,
    ) => {
      const tokenQty = entry > 0 ? size / entry : 0;
      const payoutIfWin = tokenQty * 1.0;
      const profitIfWin = payoutIfWin - size;
      const roiIfWin = size > 0 ? (profitIfWin / size) * 100 : 0;
      const lossIfLoss = -size;
      const expectedValue =
        ensembleProb * profitIfWin + (1 - ensembleProb) * lossIfLoss;
      return {
        tokenQuantity: Number(tokenQty.toFixed(4)),
        payoutIfWin: Number(payoutIfWin.toFixed(2)),
        profitIfWin: Number(profitIfWin.toFixed(2)),
        roiIfWin: Number(roiIfWin.toFixed(2)),
        lossIfLoss: Number(lossIfLoss.toFixed(2)),
        expectedValue: Number(expectedValue.toFixed(2)),
      };
    };

    for (const { trade, market } of tradeRows) {
      const oldSize = Number(trade.positionSizeUsd);
      const entryPrice = Number(trade.entryPrice);
      const ensembleProb = Number(trade.ensembleProbability);
      let newSize: number;

      if (targetBudget !== undefined) {
        // Distribute proportionally by current weight
        const weight =
          currentTotalSize > 0
            ? oldSize / currentTotalSize
            : 1 / tradeRows.length;
        newSize = targetBudget * weight;
      } else {
        newSize = oldSize * params.multiplier!;
      }

      // Round to 2 decimal places
      newSize = Number(newSize.toFixed(2));

      const delta = newSize - oldSize;

      const marketInfo = {
        eventTitle: market.eventTitle,
        marketQuestion: market.marketQuestion,
        marketType: market.marketType,
        leagueName: market.leagueName,
        teamName: market.teamName,
      };

      // Skip if no meaningful change
      if (Math.abs(delta) < 0.01) {
        const proj = computeProjection(oldSize, entryPrice, ensembleProb);
        skipped++;
        results.push({
          tradeId: trade.id,
          outcomeName: trade.outcomeName,
          status: 'skipped',
          oldSize,
          newSize: oldSize,
          delta: 0,
          entryPrice,
          ensembleProbability: ensembleProb,
          ...proj,
          reason: 'No change needed',
          market: marketInfo,
        });
        continue;
      }

      // For multiplier mode: if scaling up, check available balance per trade
      if (targetBudget === undefined && delta > 0) {
        if (delta > availableBalance) {
          const cappedNew = oldSize + availableBalance;
          if (cappedNew - oldSize < 0.01) {
            const proj = computeProjection(oldSize, entryPrice, ensembleProb);
            skipped++;
            results.push({
              tradeId: trade.id,
              outcomeName: trade.outcomeName,
              status: 'skipped',
              oldSize,
              newSize: oldSize,
              delta: 0,
              entryPrice,
              ensembleProbability: ensembleProb,
              ...proj,
              reason: `Insufficient balance: $${availableBalance.toFixed(2)} available, $${delta.toFixed(2)} needed`,
              market: marketInfo,
            });
            continue;
          }
          newSize = Number(cappedNew.toFixed(2));
        }
      }

      const actualDelta = newSize - oldSize;
      const newTokenQuantity = entryPrice > 0 ? newSize / entryPrice : 0;

      // Update the trade
      await this.db
        .update(schema.polymarketTrades)
        .set({
          positionSizeUsd: String(newSize),
          tokenQuantity: String(newTokenQuantity),
          updatedAt: new Date(),
        })
        .where(eq(schema.polymarketTrades.id, trade.id));

      // Update available balance (increase uses balance, decrease frees it)
      availableBalance -= actualDelta;
      totalDelta += actualDelta;
      adjusted++;

      const proj = computeProjection(newSize, entryPrice, ensembleProb);
      results.push({
        tradeId: trade.id,
        outcomeName: trade.outcomeName,
        status: 'adjusted',
        oldSize,
        newSize,
        delta: Number(actualDelta.toFixed(2)),
        entryPrice,
        ensembleProbability: ensembleProb,
        ...proj,
        market: marketInfo,
      });

      this.logger.log(
        `Adjusted trade #${trade.id} (${trade.outcomeName}): $${oldSize.toFixed(2)} → $${newSize.toFixed(2)} (${actualDelta >= 0 ? '+' : ''}$${actualDelta.toFixed(2)})`,
      );
    }

    // Update bankroll with net change
    if (Math.abs(totalDelta) >= 0.01) {
      const newBalance = Number(bankroll[0].currentBalance) - totalDelta;
      const currentOpenValue =
        Number(bankroll[0].openPositionsValue) + totalDelta;

      await this.db
        .update(schema.polymarketBankroll)
        .set({
          currentBalance: String(Number(newBalance.toFixed(2))),
          openPositionsValue: String(
            Number(Math.max(0, currentOpenValue).toFixed(2)),
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.polymarketBankroll.id, bankroll[0].id));
    }

    // Compute projection totals
    const totalCost = results.reduce(
      (s: number, r: any) =>
        s + (r.status === 'adjusted' ? r.newSize : r.oldSize),
      0,
    );
    const totalPayoutIfAllWin = results.reduce(
      (s: number, r: any) => s + r.payoutIfWin,
      0,
    );
    const totalProfitIfAllWin = results.reduce(
      (s: number, r: any) => s + r.profitIfWin,
      0,
    );
    const totalExpectedValue = results.reduce(
      (s: number, r: any) => s + r.expectedValue,
      0,
    );

    // Budget context (re-fetch after updates)
    const updatedBankroll = await this.getOrCreateBankroll();
    const initialBudget = Number(updatedBankroll.initialBudget);
    const currentBalance = Number(updatedBankroll.currentBalance);

    this.logger.log(
      `Budget adjustment complete: ${adjusted} adjusted, ${skipped} skipped, net delta: ${totalDelta >= 0 ? '+' : ''}$${totalDelta.toFixed(2)}`,
    );

    return {
      adjusted,
      skipped,
      totalDelta: Number(totalDelta.toFixed(2)),
      results,
      projection: {
        totalCost: Number(totalCost.toFixed(2)),
        totalPayoutIfAllWin: Number(totalPayoutIfAllWin.toFixed(2)),
        totalProfitIfAllWin: Number(totalProfitIfAllWin.toFixed(2)),
        totalRoiIfAllWin:
          totalCost > 0
            ? Number(((totalProfitIfAllWin / totalCost) * 100).toFixed(2))
            : 0,
        totalExpectedValue: Number(totalExpectedValue.toFixed(2)),
      },
      budget: {
        mode: updatedBankroll.mode,
        initialBudget,
        currentBalance,
        balanceIfAllWin: Number(
          (currentBalance + totalProfitIfAllWin).toFixed(2),
        ),
        multiplierIfAllWin:
          initialBudget > 0
            ? Number(
                (
                  (currentBalance + totalProfitIfAllWin) /
                  initialBudget
                ).toFixed(2),
              )
            : 0,
      },
    };
  }

  // ─── Go-live: convert paper trades to live trades ───────────────────

  /**
   * Convert paper trades to live by placing real orders on the Polymarket CLOB.
   *
   * Modes:
   * - { tradeIds: [1, 2, 3] } — convert specific trades
   * - { month: 5, year: 2026 } — convert all open paper trades from that month
   * - { all: true } — convert all open paper trades
   */
  async goLiveTrades(params: {
    tradeIds?: number[];
    month?: number;
    year?: number;
    all?: boolean;
  }): Promise<{
    converted: number;
    failed: number;
    skipped: number;
    results: Array<{
      tradeId: number;
      status: 'converted' | 'failed' | 'skipped';
      orderId?: string;
      reason?: string;
    }>;
  }> {
    // Validate that CLOB credentials are available
    const apiKey = this.config.get<string>('POLYMARKET_API_KEY');
    if (!apiKey) {
      throw new Error(
        'CLOB API credentials not configured. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE.',
      );
    }

    // Find paper trades to convert
    const conditions: any[] = [
      eq(schema.polymarketTrades.mode, 'paper'),
      eq(schema.polymarketTrades.status, 'open'),
    ];

    if (params.tradeIds && params.tradeIds.length > 0) {
      conditions.push(inArray(schema.polymarketTrades.id, params.tradeIds));
    } else if (params.month && params.year) {
      const startDate = new Date(params.year, params.month - 1, 1);
      const endDate = new Date(params.year, params.month, 1);
      conditions.push(gte(schema.polymarketTrades.createdAt, startDate));
      conditions.push(lte(schema.polymarketTrades.createdAt, endDate));
    } else if (!params.all) {
      throw new Error(
        'Must provide tradeIds, month+year, or all=true to specify which trades to convert.',
      );
    }

    const paperTrades = await this.db
      .select({
        trade: schema.polymarketTrades,
        market: schema.polymarketMarkets,
      })
      .from(schema.polymarketTrades)
      .innerJoin(
        schema.polymarketMarkets,
        eq(
          schema.polymarketTrades.polymarketMarketId,
          schema.polymarketMarkets.id,
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.polymarketTrades.createdAt));

    if (paperTrades.length === 0) {
      return { converted: 0, failed: 0, skipped: 0, results: [] };
    }

    this.logger.log(
      `Go-live: found ${paperTrades.length} paper trades to convert`,
    );

    // Get or create a live bankroll
    const liveBankroll = await this.getOrCreateLiveBankroll();

    let converted = 0;
    let failed = 0;
    let skipped = 0;
    const results: Array<{
      tradeId: number;
      status: 'converted' | 'failed' | 'skipped';
      orderId?: string;
      reason?: string;
    }> = [];

    for (const { trade, market } of paperTrades) {
      // Skip if market is closed or not accepting orders
      if (market.closed || !market.acceptingOrders) {
        skipped++;
        results.push({
          tradeId: trade.id,
          status: 'skipped',
          reason: market.closed
            ? 'Market is closed'
            : 'Market not accepting orders',
        });
        continue;
      }

      // Get the token ID for the trade's outcome
      const clobTokenIds = market.clobTokenIds as string[];
      const tokenId = clobTokenIds?.[trade.outcomeIndex];
      if (!tokenId) {
        failed++;
        results.push({
          tradeId: trade.id,
          status: 'failed',
          reason: `No token ID for outcome index ${trade.outcomeIndex}`,
        });
        continue;
      }

      try {
        // Re-fetch live bankroll for accurate balance
        const freshBankroll = await this.getOrCreateLiveBankroll();
        const liveBalance = Number(freshBankroll.currentBalance);
        const positionSizeUsd = Number(trade.positionSizeUsd);

        // Budget guard: skip if insufficient balance
        if (liveBalance < positionSizeUsd) {
          skipped++;
          results.push({
            tradeId: trade.id,
            status: 'skipped',
            reason: `Insufficient live bankroll: $${liveBalance.toFixed(2)} available, $${positionSizeUsd.toFixed(2)} needed`,
          });
          continue;
        }

        if (liveBalance <= 0) {
          skipped++;
          results.push({
            tradeId: trade.id,
            status: 'skipped',
            reason: 'Live bankroll exhausted',
          });
          break; // No point continuing
        }

        // Fetch current CLOB pricing
        const currentPricing =
          await this.clobService.getMarketPricingSnapshot(tokenId);

        if (!currentPricing) {
          failed++;
          results.push({
            tradeId: trade.id,
            status: 'failed',
            reason: 'Could not fetch current CLOB pricing',
          });
          continue;
        }

        // Use the current buy price (ask) or midpoint as the limit price
        const limitPrice = currentPricing.buyPrice || currentPricing.midpoint;
        const tokensToReceive = positionSizeUsd / limitPrice;

        // Place the real order
        const orderResult = await this.clobService.placeLimitOrder({
          tokenId,
          side: 'BUY',
          price: limitPrice,
          size: tokensToReceive,
        });

        if (!orderResult) {
          failed++;
          results.push({
            tradeId: trade.id,
            status: 'failed',
            reason: 'Order placement returned null — check CLOB credentials',
          });
          continue;
        }

        // Update the trade record
        await this.db
          .update(schema.polymarketTrades)
          .set({
            mode: 'live',
            orderId: orderResult.orderId,
            orderStatus: orderResult.status,
            fillPrice: String(limitPrice),
            fillTimestamp: new Date(),
            entryPrice: String(limitPrice), // Update entry price to actual live price
            midpointAtEntry: String(currentPricing.midpoint),
            spreadAtEntry: String(currentPricing.spread),
            updatedAt: new Date(),
          })
          .where(eq(schema.polymarketTrades.id, trade.id));

        // Update live bankroll (use freshBankroll for accurate balance)
        const newBalance =
          Number(freshBankroll.currentBalance) - positionSizeUsd;
        await this.db
          .update(schema.polymarketBankroll)
          .set({
            currentBalance: String(newBalance),
            openPositionsCount: freshBankroll.openPositionsCount + 1,
            openPositionsValue: String(
              Number(freshBankroll.openPositionsValue) + positionSizeUsd,
            ),
            updatedAt: new Date(),
          })
          .where(eq(schema.polymarketBankroll.id, freshBankroll.id));

        converted++;
        results.push({
          tradeId: trade.id,
          status: 'converted',
          orderId: orderResult.orderId,
        });

        this.logger.log(
          `Go-live: trade #${trade.id} (${trade.outcomeName}) → order ${orderResult.orderId} ` +
            `$${positionSizeUsd.toFixed(2)} @ ${limitPrice.toFixed(3)}`,
        );
      } catch (error) {
        failed++;
        results.push({
          tradeId: trade.id,
          status: 'failed',
          reason: error.message,
        });
        this.logger.error(
          `Go-live: failed to convert trade #${trade.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Go-live complete: ${converted} converted, ${failed} failed, ${skipped} skipped`,
    );

    return { converted, failed, skipped, results };
  }

  // ─── Switch trade mode (paper ↔ live) ────────────────────────────────

  /**
   * Switch open trades between paper and live mode (or vice versa).
   *
   * This is a lightweight mode flip — it does NOT place or cancel CLOB orders.
   * Use `goLiveTrades` if you want to actually place real orders on the CLOB.
   *
   * Moves position value between the source and target bankrolls:
   * - paper→live: deducts from live bankroll, frees paper bankroll
   * - live→paper: deducts from paper bankroll, frees live bankroll
   */
  async switchTradeMode(params: {
    tradeIds?: number[];
    month?: number;
    year?: number;
    all?: boolean;
    to: 'paper' | 'live'; // Target mode
  }): Promise<{
    switched: number;
    skipped: number;
    results: Array<{
      tradeId: number;
      outcomeName: string;
      status: 'switched' | 'skipped';
      from: string;
      to: string;
      positionSizeUsd: number;
      reason?: string;
    }>;
  }> {
    const targetMode = params.to;
    const sourceMode = targetMode === 'live' ? 'paper' : 'live';

    // Build conditions — only select trades currently in the source mode
    const conditions: any[] = [
      eq(schema.polymarketTrades.status, 'open'),
      eq(schema.polymarketTrades.mode, sourceMode),
    ];

    if (params.tradeIds && params.tradeIds.length > 0) {
      conditions.push(inArray(schema.polymarketTrades.id, params.tradeIds));
    } else if (params.month && params.year) {
      const startDate = new Date(params.year, params.month - 1, 1);
      const endDate = new Date(params.year, params.month, 1);
      conditions.push(gte(schema.polymarketTrades.createdAt, startDate));
      conditions.push(lte(schema.polymarketTrades.createdAt, endDate));
    } else if (!params.all) {
      throw new Error(
        'Must provide tradeIds, month+year, or all=true to specify which trades to switch.',
      );
    }

    const trades = await this.db
      .select()
      .from(schema.polymarketTrades)
      .where(and(...conditions))
      .orderBy(desc(schema.polymarketTrades.createdAt));

    if (trades.length === 0) {
      return { switched: 0, skipped: 0, results: [] };
    }

    // Get both bankrolls
    const sourceBankroll = await this.getBankrollByMode(sourceMode);
    const targetBankroll = await this.getBankrollByMode(targetMode);

    let switched = 0;
    let skipped = 0;
    let totalMoved = 0;
    const results: Array<{
      tradeId: number;
      outcomeName: string;
      status: 'switched' | 'skipped';
      from: string;
      to: string;
      positionSizeUsd: number;
      reason?: string;
    }> = [];

    for (const trade of trades) {
      const positionSize = Number(trade.positionSizeUsd);

      // Check target bankroll has enough balance
      const targetBalance = Number(targetBankroll.currentBalance) - totalMoved;
      if (positionSize > targetBalance && targetMode === 'live') {
        skipped++;
        results.push({
          tradeId: trade.id,
          outcomeName: trade.outcomeName,
          status: 'skipped',
          from: sourceMode,
          to: targetMode,
          positionSizeUsd: positionSize,
          reason: `Insufficient ${targetMode} bankroll: $${targetBalance.toFixed(2)} available, $${positionSize.toFixed(2)} needed`,
        });
        continue;
      }

      // Switch the mode
      await this.db
        .update(schema.polymarketTrades)
        .set({
          mode: targetMode,
          updatedAt: new Date(),
        })
        .where(eq(schema.polymarketTrades.id, trade.id));

      totalMoved += positionSize;
      switched++;

      results.push({
        tradeId: trade.id,
        outcomeName: trade.outcomeName,
        status: 'switched',
        from: sourceMode,
        to: targetMode,
        positionSizeUsd: positionSize,
      });

      this.logger.log(
        `Switched trade #${trade.id} (${trade.outcomeName}): ${sourceMode} → ${targetMode} ($${positionSize.toFixed(2)})`,
      );
    }

    // Update both bankrolls: move position value from source to target
    if (totalMoved > 0) {
      // Source bankroll: free up the position value
      await this.db
        .update(schema.polymarketBankroll)
        .set({
          currentBalance: String(
            Number(sourceBankroll.currentBalance) + totalMoved,
          ),
          openPositionsCount: Math.max(
            0,
            sourceBankroll.openPositionsCount - switched,
          ),
          openPositionsValue: String(
            Math.max(0, Number(sourceBankroll.openPositionsValue) - totalMoved),
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.polymarketBankroll.id, sourceBankroll.id));

      // Target bankroll: absorb the position value
      await this.db
        .update(schema.polymarketBankroll)
        .set({
          currentBalance: String(
            Number(targetBankroll.currentBalance) - totalMoved,
          ),
          openPositionsCount: targetBankroll.openPositionsCount + switched,
          openPositionsValue: String(
            Number(targetBankroll.openPositionsValue) + totalMoved,
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.polymarketBankroll.id, targetBankroll.id));
    }

    this.logger.log(
      `Mode switch complete: ${switched} trades ${sourceMode}→${targetMode}, ${skipped} skipped, $${totalMoved.toFixed(2)} moved`,
    );

    return { switched, skipped, results };
  }

  /**
   * Get bankroll by mode, creating it if it doesn't exist.
   */
  private async getBankrollByMode(mode: string): Promise<any> {
    if (mode === 'live') return this.getOrCreateLiveBankroll();
    return this.getOrCreateBankroll();
  }

  /**
   * Get or create a live-mode bankroll record (separate from paper bankroll).
   */
  private async getOrCreateLiveBankroll(): Promise<any> {
    const existing = await this.db
      .select()
      .from(schema.polymarketBankroll)
      .where(eq(schema.polymarketBankroll.mode, 'live'))
      .orderBy(desc(schema.polymarketBankroll.updatedAt))
      .limit(1);

    if (existing.length > 0) return existing[0];

    const budget = this.config.get<number>('POLYMARKET_BUDGET') || 500;

    const [created] = await this.db
      .insert(schema.polymarketBankroll)
      .values({
        mode: 'live',
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

    this.logger.log(`Created live bankroll with initial budget: $${budget}`);

    return created;
  }
}
