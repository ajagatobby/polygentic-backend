import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../database/schema';

/**
 * Per-league 1X2 base rate with sample size so callers can decide whether to
 * trust the league-specific estimate vs shrink toward the global prior.
 */
export interface LeaguePriors {
  leagueId: number;
  homeRate: number;
  drawRate: number;
  awayRate: number;
  /** Actual number of completed matches used (un-shrunk). */
  sampleSize: number;
  /** True when we have at least `minSample` matches; shrinkage will have
   *  limited effect. False when caller should treat the result as essentially
   *  the global prior. */
  isReliable: boolean;
}

/** Global 1X2 base rate — used as the shrinkage target. These are the
 *  empirical rates across all major football leagues (post-COVID era). */
export const GLOBAL_PRIORS = {
  homeRate: 0.45,
  drawRate: 0.27,
  awayRate: 0.28,
};

/**
 * Computes per-league 1X2 base rates from completed fixtures with Bayesian
 * shrinkage toward the global prior. Shrinkage strength κ acts like an
 * effective sample of 40 matches at the global rate: for a league with N
 * observed matches and counts (h, d, a):
 *
 *   rate_home = (h + κ · global_home) / (N + κ)
 *
 * This means:
 *   - With N=0:  result ≈ global prior (κ · global / κ)
 *   - With N=40: result is a 50/50 blend of observed and prior
 *   - With N=200+: result ≈ observed rates (shrinkage negligible)
 *
 * Fixtures (not predictions) are used so the prior isn't biased by the
 * sampling pattern of what our own system chose to predict on.
 */
@Injectable()
export class LeaguePriorsService {
  private readonly logger = new Logger(LeaguePriorsService.name);
  private readonly SHRINKAGE_KAPPA = 40;
  private readonly MIN_RELIABLE_SAMPLE = 30;
  /** In-memory cache — league rates don't change fast. TTL 1h. */
  private readonly cache = new Map<
    number,
    { priors: LeaguePriors; cachedAt: number }
  >();
  private readonly CACHE_TTL_MS = 60 * 60 * 1000;

  constructor(@Inject('DRIZZLE') private readonly db: any) {}

  /**
   * Get per-league 1X2 rates shrunk toward the global prior.
   * Returns the global prior (still wrapped in a LeaguePriors object) when
   * the league has no completed fixtures on file.
   */
  async getLeaguePriors(leagueId: number): Promise<LeaguePriors> {
    const cached = this.cache.get(leagueId);
    const now = Date.now();
    if (cached && now - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.priors;
    }

    // Count 1X2 outcomes across all completed fixtures in the league.
    const row = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        home: sql<number>`count(*) FILTER (WHERE ${schema.fixtures.goalsHome} > ${schema.fixtures.goalsAway})::int`,
        draw: sql<number>`count(*) FILTER (WHERE ${schema.fixtures.goalsHome} = ${schema.fixtures.goalsAway})::int`,
        away: sql<number>`count(*) FILTER (WHERE ${schema.fixtures.goalsHome} < ${schema.fixtures.goalsAway})::int`,
      })
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.leagueId, leagueId),
          isNotNull(schema.fixtures.goalsHome),
          isNotNull(schema.fixtures.goalsAway),
          sql`${schema.fixtures.status} IN ('FT', 'AET', 'PEN')`,
        ),
      );

    const n = Number(row[0]?.total ?? 0);
    const h = Number(row[0]?.home ?? 0);
    const d = Number(row[0]?.draw ?? 0);
    const a = Number(row[0]?.away ?? 0);

    const κ = this.SHRINKAGE_KAPPA;
    const homeRate =
      (h + κ * GLOBAL_PRIORS.homeRate) / (n + κ);
    const drawRate =
      (d + κ * GLOBAL_PRIORS.drawRate) / (n + κ);
    const awayRate =
      (a + κ * GLOBAL_PRIORS.awayRate) / (n + κ);
    // Normalise to exactly 1.0 (drops any floating-point drift).
    const sum = homeRate + drawRate + awayRate;

    const priors: LeaguePriors = {
      leagueId,
      homeRate: homeRate / sum,
      drawRate: drawRate / sum,
      awayRate: awayRate / sum,
      sampleSize: n,
      isReliable: n >= this.MIN_RELIABLE_SAMPLE,
    };

    this.cache.set(leagueId, { priors, cachedAt: now });
    return priors;
  }

  /** Convenience: fetch priors for several leagues in parallel. */
  async getManyLeaguePriors(
    leagueIds: number[],
  ): Promise<Map<number, LeaguePriors>> {
    const out = new Map<number, LeaguePriors>();
    const unique = Array.from(new Set(leagueIds));
    const results = await Promise.all(
      unique.map((id) => this.getLeaguePriors(id)),
    );
    for (const p of results) out.set(p.leagueId, p);
    return out;
  }
}
