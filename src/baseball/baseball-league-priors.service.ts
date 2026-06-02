import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BASEBALL_COMPLETED_STATUSES } from './baseball.service';

export interface BaseballLeaguePriors {
  /** League average runs scored per team per game. */
  avgRunsPerTeam: number;
  /** League average total runs per game (both teams). */
  avgTotalRuns: number;
  /** League average starter expected-ERA (for suppression scaling). */
  avgStarterEra: number;
  /** League average team xwOBA (for offense scaling). */
  avgTeamXwoba: number;
  sampleSize: number;
  isReliable: boolean;
}

/**
 * League-level priors for MLB run totals, computed from completed games +
 * cached Statcast, with literature fallbacks. Mirrors the soccer
 * LeaguePriorsService shrinkage philosophy. Cached for 1h.
 */
@Injectable()
export class BaseballLeaguePriorsService {
  private readonly logger = new Logger(BaseballLeaguePriorsService.name);

  // Post-2015 MLB norms — used as fallback and shrinkage target.
  private static readonly FALLBACK: BaseballLeaguePriors = {
    avgRunsPerTeam: 4.4,
    avgTotalRuns: 8.8,
    avgStarterEra: 4.2,
    avgTeamXwoba: 0.318,
    sampleSize: 0,
    isReliable: false,
  };

  private cache: { value: BaseballLeaguePriors; at: number } | null = null;
  private static readonly TTL_MS = 60 * 60 * 1000;

  constructor(@Inject('DRIZZLE') private db: any) {}

  async get(season = new Date().getFullYear()): Promise<BaseballLeaguePriors> {
    if (this.cache && Date.now() - this.cache.at < BaseballLeaguePriorsService.TTL_MS) {
      return this.cache.value;
    }
    const value = await this.compute(season);
    this.cache = { value, at: Date.now() };
    return value;
  }

  private async compute(season: number): Promise<BaseballLeaguePriors> {
    const fb = BaseballLeaguePriorsService.FALLBACK;
    try {
      const games = await this.db
        .select()
        .from(schema.baseballGames)
        .where(
          and(
            inArray(schema.baseballGames.status, BASEBALL_COMPLETED_STATUSES),
            isNotNull(schema.baseballGames.runsHome),
          ),
        );

      const seasonGames = games.filter(
        (g: any) => (g.season ?? season) === season,
      );
      const use = seasonGames.length >= 50 ? seasonGames : games;

      let totalRunsSum = 0;
      let n = 0;
      for (const g of use) {
        if (g.runsHome == null || g.runsAway == null) continue;
        totalRunsSum += g.runsHome + g.runsAway;
        n++;
      }

      const avgTotalRuns = n >= 30 ? totalRunsSum / n : fb.avgTotalRuns;
      const avgRunsPerTeam = avgTotalRuns / 2;

      // Statcast-derived league means (best-effort).
      const pitchers = await this.db.select().from(schema.baseballPitchers);
      const eras = pitchers
        .map((p: any) => Number(p.xera ?? p.era))
        .filter((x: number) => Number.isFinite(x) && x > 0);
      const avgStarterEra = eras.length >= 20 ? mean(eras) : fb.avgStarterEra;

      const batting = await this.db.select().from(schema.baseballTeamBatting);
      const xwobas = batting
        .map((b: any) => Number(b.xwoba))
        .filter((x: number) => Number.isFinite(x) && x > 0);
      const avgTeamXwoba = xwobas.length >= 10 ? mean(xwobas) : fb.avgTeamXwoba;

      return {
        avgRunsPerTeam,
        avgTotalRuns,
        avgStarterEra,
        avgTeamXwoba,
        sampleSize: n,
        isReliable: n >= 200,
      };
    } catch (err) {
      this.logger.warn(
        `League priors compute failed, using fallback: ${(err as Error).message}`,
      );
      return fb;
    }
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
