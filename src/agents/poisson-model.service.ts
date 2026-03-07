import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { PoissonModelOutput } from './types';

/**
 * Poisson-based statistical prediction model.
 *
 * Uses xG (expected goals) data when available, falling back to actual goals.
 * Implements a simplified Dixon-Coles approach:
 * 1. Estimate team attack and defense strength relative to league average
 * 2. Compute expected goals for each team using home/away factors
 * 3. Use Poisson distribution to calculate match outcome probabilities
 * 4. Apply low-scoring correction for 0-0, 1-0, 0-1 scorelines (Dixon-Coles adjustment)
 */
@Injectable()
export class PoissonModelService {
  private readonly logger = new Logger(PoissonModelService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  /**
   * Generate Poisson-based probabilities for a fixture.
   */
  async predict(
    homeTeamId: number,
    awayTeamId: number,
    leagueId: number,
    fixtureId: number,
  ): Promise<PoissonModelOutput> {
    try {
      // Get recent completed fixtures with stats for both teams
      const [homeStats, awayStats, leagueAvg] = await Promise.all([
        this.getTeamStrength(homeTeamId, fixtureId, leagueId, true),
        this.getTeamStrength(awayTeamId, fixtureId, leagueId, false),
        this.getLeagueAverages(leagueId, fixtureId),
      ]);

      const dataPoints = homeStats.matchCount + awayStats.matchCount;

      if (dataPoints < 6) {
        // Not enough data for reliable Poisson model
        return {
          homeWinProb: 0.4,
          drawProb: 0.27,
          awayWinProb: 0.33,
          expectedHomeGoals: 1.3,
          expectedAwayGoals: 1.1,
          confidence: 0.1,
          dataPoints,
        };
      }

      // Calculate team strengths relative to league average
      const leagueAvgGoals = leagueAvg.avgGoals || 1.35; // fallback
      const homeAdvantage = leagueAvg.homeAdvantage || 1.2; // ~20% home boost

      // Attack = team's xG / league avg xG
      // Defense = team's xGA / league avg xG (lower = better defense)
      const homeAttack =
        homeStats.avgXG > 0 ? homeStats.avgXG / leagueAvgGoals : 1.0;
      const homeDefense =
        homeStats.avgXGA > 0 ? homeStats.avgXGA / leagueAvgGoals : 1.0;
      const awayAttack =
        awayStats.avgXG > 0 ? awayStats.avgXG / leagueAvgGoals : 1.0;
      const awayDefense =
        awayStats.avgXGA > 0 ? awayStats.avgXGA / leagueAvgGoals : 1.0;

      // Expected goals
      // Home xG = league_avg * home_attack * away_defense * home_advantage
      // Away xG = league_avg * away_attack * home_defense * (1/home_advantage)
      const expectedHomeGoals =
        leagueAvgGoals * homeAttack * awayDefense * homeAdvantage;
      const expectedAwayGoals =
        leagueAvgGoals * awayAttack * homeDefense * (1 / homeAdvantage);

      // Cap expected goals at reasonable range
      const cappedHome = Math.max(0.3, Math.min(4.0, expectedHomeGoals));
      const cappedAway = Math.max(0.2, Math.min(3.5, expectedAwayGoals));

      // Calculate probabilities using Poisson distribution
      const maxGoals = 8; // Consider scorelines up to 8-8
      let homeWinProb = 0;
      let drawProb = 0;
      let awayWinProb = 0;

      for (let i = 0; i <= maxGoals; i++) {
        for (let j = 0; j <= maxGoals; j++) {
          let prob =
            this.poissonPmf(i, cappedHome) * this.poissonPmf(j, cappedAway);

          // Dixon-Coles low-scoring correction
          // Adjusts for the empirical observation that 0-0, 1-0, 0-1, 1-1
          // occur at different rates than independent Poisson would predict
          if (i <= 1 && j <= 1) {
            const rho = this.calculateRho(cappedHome, cappedAway);
            prob = this.dixonColesCorrection(
              i,
              j,
              cappedHome,
              cappedAway,
              prob,
              rho,
            );
          }

          if (i > j) homeWinProb += prob;
          else if (i === j) drawProb += prob;
          else awayWinProb += prob;
        }
      }

      // Normalize (should already be close to 1.0)
      const total = homeWinProb + drawProb + awayWinProb;
      homeWinProb = homeWinProb / total;
      drawProb = drawProb / total;
      awayWinProb = awayWinProb / total;

      // Confidence based on data quality
      // More matches + xG data available = higher confidence
      const xgAvailable = homeStats.hasXG && awayStats.hasXG ? 0.3 : 0.0;
      const matchCountFactor = Math.min(0.5, (dataPoints / 30) * 0.5);
      const confidence = Math.min(0.9, xgAvailable + matchCountFactor + 0.1);

      this.logger.debug(
        `Poisson model: home=${homeTeamId} xG=${cappedHome.toFixed(2)}, ` +
          `away=${awayTeamId} xG=${cappedAway.toFixed(2)} → ` +
          `H=${(homeWinProb * 100).toFixed(1)}% D=${(drawProb * 100).toFixed(1)}% A=${(awayWinProb * 100).toFixed(1)}%`,
      );

      return {
        homeWinProb: Number(homeWinProb.toFixed(4)),
        drawProb: Number(drawProb.toFixed(4)),
        awayWinProb: Number(awayWinProb.toFixed(4)),
        expectedHomeGoals: Number(cappedHome.toFixed(2)),
        expectedAwayGoals: Number(cappedAway.toFixed(2)),
        confidence: Number(confidence.toFixed(2)),
        dataPoints,
      };
    } catch (error) {
      this.logger.warn(`Poisson model failed: ${error.message}`);
      // Return uniform-ish default
      return {
        homeWinProb: 0.4,
        drawProb: 0.27,
        awayWinProb: 0.33,
        expectedHomeGoals: 1.3,
        expectedAwayGoals: 1.1,
        confidence: 0,
        dataPoints: 0,
      };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Get team's average attacking and defensive strength from recent matches.
   *
   * Improvements over previous version:
   * - Filters by league (avoids cross-competition contamination)
   * - Filters by home/away context (home xG differs significantly from away xG)
   * - Applies exponential recency weighting (half-life of 8 matches)
   * - Prefers xG when available, falls back to actual goals with confidence penalty
   */
  private async getTeamStrength(
    teamId: number,
    currentFixtureId: number,
    leagueId: number,
    isHome: boolean,
    matchCount: number = 20,
  ): Promise<{
    avgXG: number;
    avgXGA: number;
    matchCount: number;
    hasXG: boolean;
  }> {
    // Get team's recent stats — filtered by league and home/away context
    const teamStats = await this.db
      .select({
        stat: schema.fixtureStatistics,
        fixture: schema.fixtures,
      })
      .from(schema.fixtureStatistics)
      .innerJoin(
        schema.fixtures,
        eq(schema.fixtureStatistics.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          eq(schema.fixtureStatistics.teamId, teamId),
          eq(schema.fixtures.status, 'FT'),
          eq(schema.fixtures.leagueId, leagueId),
          sql`${schema.fixtureStatistics.fixtureId} != ${currentFixtureId}`,
          // Filter by home/away context
          isHome
            ? eq(schema.fixtures.homeTeamId, teamId)
            : eq(schema.fixtures.awayTeamId, teamId),
        ),
      )
      .orderBy(desc(schema.fixtures.date))
      .limit(matchCount);

    // If we have very few context-specific matches, supplement with all league matches
    if (teamStats.length < 4) {
      const allLeagueStats = await this.db
        .select({
          stat: schema.fixtureStatistics,
          fixture: schema.fixtures,
        })
        .from(schema.fixtureStatistics)
        .innerJoin(
          schema.fixtures,
          eq(schema.fixtureStatistics.fixtureId, schema.fixtures.id),
        )
        .where(
          and(
            eq(schema.fixtureStatistics.teamId, teamId),
            eq(schema.fixtures.status, 'FT'),
            eq(schema.fixtures.leagueId, leagueId),
            sql`${schema.fixtureStatistics.fixtureId} != ${currentFixtureId}`,
          ),
        )
        .orderBy(desc(schema.fixtures.date))
        .limit(matchCount);

      // Use all league matches if context-specific were too few
      if (allLeagueStats.length > teamStats.length) {
        teamStats.length = 0;
        teamStats.push(...allLeagueStats);
      }
    }

    if (teamStats.length === 0) {
      return { avgXG: 0, avgXGA: 0, matchCount: 0, hasXG: false };
    }

    // Get opponent stats in the same fixtures
    const fixtureIds = teamStats.map((r: any) => r.stat.fixtureId);
    const opponentStats = await this.db
      .select()
      .from(schema.fixtureStatistics)
      .where(
        and(
          sql`${schema.fixtureStatistics.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
          sql`${schema.fixtureStatistics.teamId} != ${teamId}`,
        ),
      );

    const opponentMap = new Map<number, any>();
    for (const os of opponentStats) {
      opponentMap.set(os.fixtureId, os);
    }

    // Calculate recency-weighted averages
    // Exponential decay: weight = e^(-i * ln(2) / halfLife)
    const HALF_LIFE = 8; // matches
    const decayRate = Math.log(2) / HALF_LIFE;

    let weightedXG = 0;
    let weightedXGA = 0;
    let xgWeightSum = 0;
    let weightedGoalsFor = 0;
    let weightedGoalsAgainst = 0;
    let goalsWeightSum = 0;
    let xgCount = 0;

    for (let i = 0; i < teamStats.length; i++) {
      const { stat, fixture } = teamStats[i];
      const weight = Math.exp(-i * decayRate);

      // Team's xG (attack)
      if (stat.expectedGoals && Number(stat.expectedGoals) > 0) {
        weightedXG += Number(stat.expectedGoals) * weight;
        xgWeightSum += weight;
        xgCount++;
      }

      // Opponent's xG (defense = what was created against us)
      const opp = opponentMap.get(stat.fixtureId);
      if (opp?.expectedGoals && Number(opp.expectedGoals) > 0) {
        weightedXGA += Number(opp.expectedGoals) * weight;
      }

      // Actual goals as fallback
      const teamIsHome = fixture.homeTeamId === teamId;
      const goalsFor = teamIsHome ? fixture.goalsHome : fixture.goalsAway;
      const goalsAgainst = teamIsHome ? fixture.goalsAway : fixture.goalsHome;
      if (goalsFor != null) {
        weightedGoalsFor += goalsFor * weight;
        goalsWeightSum += weight;
      }
      if (goalsAgainst != null) {
        weightedGoalsAgainst += goalsAgainst * weight;
      }
    }

    const hasXG = xgCount >= teamStats.length * 0.5; // At least half have xG
    const n = teamStats.length;

    return {
      avgXG:
        hasXG && xgWeightSum > 0
          ? weightedXG / xgWeightSum
          : goalsWeightSum > 0
            ? weightedGoalsFor / goalsWeightSum
            : 0,
      avgXGA:
        hasXG && xgWeightSum > 0
          ? weightedXGA / xgWeightSum
          : goalsWeightSum > 0
            ? weightedGoalsAgainst / goalsWeightSum
            : 0,
      matchCount: n,
      hasXG,
    };
  }

  /**
   * Get league-wide averages for normalization.
   */
  private async getLeagueAverages(
    leagueId: number,
    currentFixtureId: number,
  ): Promise<{
    avgGoals: number;
    homeAdvantage: number;
  }> {
    // Get recent completed fixtures in this league
    const recentFixtures = await this.db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.leagueId, leagueId),
          eq(schema.fixtures.status, 'FT'),
          sql`${schema.fixtures.id} != ${currentFixtureId}`,
          sql`${schema.fixtures.goalsHome} IS NOT NULL`,
        ),
      )
      .orderBy(desc(schema.fixtures.date))
      .limit(100);

    if (recentFixtures.length < 10) {
      return { avgGoals: 1.35, homeAdvantage: 1.2 };
    }

    let totalGoals = 0;
    let totalHomeGoals = 0;
    let totalAwayGoals = 0;

    for (const f of recentFixtures) {
      const hg = f.goalsHome ?? 0;
      const ag = f.goalsAway ?? 0;
      totalGoals += hg + ag;
      totalHomeGoals += hg;
      totalAwayGoals += ag;
    }

    const n = recentFixtures.length;
    const avgGoalsPerTeam = totalGoals / (2 * n);
    const avgHomeGoals = totalHomeGoals / n;
    const avgAwayGoals = totalAwayGoals / n;
    const homeAdvantage = avgAwayGoals > 0 ? avgHomeGoals / avgAwayGoals : 1.2;

    return {
      avgGoals: avgGoalsPerTeam,
      homeAdvantage: Math.max(0.8, Math.min(1.6, homeAdvantage)),
    };
  }

  /**
   * Poisson probability mass function.
   * P(X = k) = (lambda^k * e^(-lambda)) / k!
   */
  private poissonPmf(k: number, lambda: number): number {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / this.factorial(k);
  }

  /**
   * Factorial with memoization for small numbers.
   */
  private factorialCache = new Map<number, number>();
  private factorial(n: number): number {
    if (n <= 1) return 1;
    if (this.factorialCache.has(n)) return this.factorialCache.get(n)!;
    const result = n * this.factorial(n - 1);
    this.factorialCache.set(n, result);
    return result;
  }

  /**
   * Calculate the Dixon-Coles correlation parameter (rho).
   * Rho captures the dependency between low-scoring events.
   * Negative rho = more 0-0 and 1-1 than independent Poisson predicts.
   */
  private calculateRho(lambdaHome: number, lambdaAway: number): number {
    // Empirical estimate: rho is typically between -0.1 and -0.2
    // for most football leagues. More defensive leagues = more negative.
    const totalXG = lambdaHome + lambdaAway;
    if (totalXG < 2.0) return -0.15; // Defensive game
    if (totalXG > 3.5) return -0.05; // Attacking game
    return -0.1; // Average
  }

  /**
   * Dixon-Coles correction factor for low-scoring outcomes.
   * Adjusts the probability of 0-0, 1-0, 0-1, 1-1 scorelines.
   */
  private dixonColesCorrection(
    homeGoals: number,
    awayGoals: number,
    lambdaHome: number,
    lambdaAway: number,
    baseProbability: number,
    rho: number,
  ): number {
    if (homeGoals === 0 && awayGoals === 0) {
      return baseProbability * (1 - lambdaHome * lambdaAway * rho);
    }
    if (homeGoals === 0 && awayGoals === 1) {
      return baseProbability * (1 + lambdaHome * rho);
    }
    if (homeGoals === 1 && awayGoals === 0) {
      return baseProbability * (1 + lambdaAway * rho);
    }
    if (homeGoals === 1 && awayGoals === 1) {
      return baseProbability * (1 - rho);
    }
    return baseProbability;
  }
}
