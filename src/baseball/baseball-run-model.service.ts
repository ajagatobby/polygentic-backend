import { Injectable, Logger } from '@nestjs/common';
import { BaseballService } from './baseball.service';
import { StatcastService } from './statcast.service';
import { BaseballTeamMapService } from './baseball-team-map.service';
import {
  BaseballLeaguePriorsService,
  BaseballLeaguePriors,
} from './baseball-league-priors.service';

export interface LineProb {
  line: number;
  pOver: number;
  pUnder: number;
  push: number;
}

export interface RunModelOutput {
  gameId: number;
  expectedHomeRuns: number;
  expectedAwayRuns: number;
  expectedTotal: number;
  dispersion: number; // NB size parameter r
  lineProbs: LineProb[];
  confidence: number; // 1-10
  inputs: Record<string, any>;
}

export interface RunModelOverrides {
  homeStarterId?: number;
  awayStarterId?: number;
  /** Overdispersion factor phi (var = phi*mean); tuned in backtest. */
  phi?: number;
  /** IP share carried by the starter (rest = bullpen). */
  starterIpShare?: number;
}

/**
 * Statistical MLB run-total model. Builds expected runs per side from
 * Statcast true-talent (offense xwOBA, opposing starter xERA) blended with
 * recent team run rates, park, and weather, then models the game total as a
 * Negative-Binomial (runs are overdispersed) to get P(over) per line.
 *
 * Lives in the baseball module (not agents/) to keep DI on the baseball
 * data services clean; it is the "model" base predictor in the ensemble.
 */
@Injectable()
export class BaseballRunModelService {
  private readonly logger = new Logger(BaseballRunModelService.name);

  private static readonly DEFAULT_PHI = 2.2;
  private static readonly DEFAULT_STARTER_IP_SHARE = 0.6;

  constructor(
    private readonly baseball: BaseballService,
    private readonly statcast: StatcastService,
    private readonly teamMap: BaseballTeamMapService,
    private readonly leaguePriors: BaseballLeaguePriorsService,
  ) {}

  async predict(
    gameId: number,
    overrides: RunModelOverrides = {},
  ): Promise<RunModelOutput | null> {
    const game = await this.baseball.getGameById(gameId);
    if (!game) {
      this.logger.warn(`predict: game ${gameId} not found`);
      return null;
    }
    const priors = await this.leaguePriors.get(game.season ?? undefined);

    const homeSeed = this.teamMap.getByApiSports(game.homeTeamId);
    const awaySeed = this.teamMap.getByApiSports(game.awayTeamId);

    // Park: game is at the home team's venue.
    const parkRunFactor = homeSeed ? homeSeed.parkRunFactor : 1.0;
    const weatherFactor = this.weatherFactor(game.weather, homeSeed);

    // Offense factors (team xwOBA vs league, regressed; blended with run rate).
    const homeOffense = await this.offenseFactor(
      game.homeTeamId,
      homeSeed?.mlbamTeamId,
      priors,
    );
    const awayOffense = await this.offenseFactor(
      game.awayTeamId,
      awaySeed?.mlbamTeamId,
      priors,
    );

    // Suppression factors for the opposing pitching staff (starter + bullpen).
    const homeSuppression = await this.suppressionFactor(
      game.homeTeamId,
      overrides.homeStarterId ?? game.homeProbablePitcherId,
      priors,
      overrides,
    );
    const awaySuppression = await this.suppressionFactor(
      game.awayTeamId,
      overrides.awayStarterId ?? game.awayProbablePitcherId,
      priors,
      overrides,
    );

    // Expected runs: own offense × opponent suppression × park × weather.
    const base = priors.avgRunsPerTeam;
    let expHome =
      base *
      homeOffense.factor *
      awaySuppression.factor *
      parkRunFactor *
      weatherFactor;
    let expAway =
      base *
      awayOffense.factor *
      homeSuppression.factor *
      parkRunFactor *
      weatherFactor;

    // Small home-field nudge on offense (~+2%, mostly from batting last/park
    // familiarity); keep modest — most home edge is already in the park.
    expHome *= 1.02;

    expHome = clamp(expHome, 1.5, 9);
    expAway = clamp(expAway, 1.5, 9);
    const expectedTotal = expHome + expAway;

    // Negative-binomial on the game total.
    const phi = overrides.phi ?? BaseballRunModelService.DEFAULT_PHI;
    const r = nbSizeFromMeanPhi(expectedTotal, phi);
    const pmf = nbPmfArray(expectedTotal, r, 45);

    const lineProbs = this.buildLineProbs(expectedTotal, pmf);

    const confidence = this.scoreConfidence(
      homeOffense,
      awayOffense,
      homeSuppression,
      awaySuppression,
      priors,
    );

    return {
      gameId,
      expectedHomeRuns: round2(expHome),
      expectedAwayRuns: round2(expAway),
      expectedTotal: round2(expectedTotal),
      dispersion: round2(r),
      lineProbs,
      confidence,
      inputs: {
        parkRunFactor,
        weatherFactor: round2(weatherFactor),
        homeOffense,
        awayOffense,
        homeSuppression,
        awaySuppression,
        priors,
        phi,
      },
    };
  }

  // ─── factor estimators ─────────────────────────────────────────────

  private async offenseFactor(
    apiSportsTeamId: number,
    mlbamId: number | undefined,
    priors: BaseballLeaguePriors,
  ): Promise<{ factor: number; xwobaUsed: boolean; runRateUsed: boolean }> {
    let xwobaFactor: number | null = null;
    if (mlbamId) {
      const batting = await this.statcast.getTeamBatting(mlbamId);
      if (batting?.xwoba && priors.avgTeamXwoba > 0) {
        // xwOBA→runs is roughly linear; scale around league mean with gain ~1.5.
        xwobaFactor = 1 + ((batting.xwoba - priors.avgTeamXwoba) / priors.avgTeamXwoba) * 1.5;
      }
    }

    // Recent run rate from completed games.
    const recent = await this.baseball.getRecentCompletedForTeam(
      apiSportsTeamId,
      25,
    );
    let runRateFactor: number | null = null;
    if (recent.length >= 5) {
      const rs = recent.map((g: any) =>
        g.homeTeamId === apiSportsTeamId ? g.runsHome : g.runsAway,
      );
      const avg = mean(rs.filter((x: any) => x != null));
      if (Number.isFinite(avg) && priors.avgRunsPerTeam > 0) {
        const raw = avg / priors.avgRunsPerTeam;
        // Regress toward 1.0 by sample size (k=20 games).
        const w = recent.length / (recent.length + 20);
        runRateFactor = 1 + (raw - 1) * w;
      }
    }

    const parts = [xwobaFactor, runRateFactor].filter(
      (x): x is number => x != null,
    );
    const factor = parts.length ? clamp(mean(parts), 0.7, 1.4) : 1.0;
    return {
      factor,
      xwobaUsed: xwobaFactor != null,
      runRateUsed: runRateFactor != null,
    };
  }

  /**
   * Suppression factor for the staff facing a given offense: starter
   * true-talent (xERA vs league) over `starterIpShare`, blended with the
   * team's recent runs-allowed rate (bullpen + defense proxy).
   */
  private async suppressionFactor(
    apiSportsTeamId: number,
    starterMlbamId: number | null | undefined,
    priors: BaseballLeaguePriors,
    overrides: RunModelOverrides,
  ): Promise<{
    factor: number;
    starterUsed: boolean;
    starterStale: boolean;
    bullpenUsed: boolean;
  }> {
    const ipShare =
      overrides.starterIpShare ??
      BaseballRunModelService.DEFAULT_STARTER_IP_SHARE;

    let starterFactor: number | null = null;
    let starterStale = false;
    if (starterMlbamId) {
      const tt = await this.statcast.getPitcherTrueTalent(starterMlbamId);
      const era = tt?.xera ?? tt?.era ?? null;
      if (era && priors.avgStarterEra > 0) {
        starterFactor = era / priors.avgStarterEra;
        starterStale = !!tt?.stale;
      }
    }

    // Bullpen + defense proxy: team runs-allowed per game.
    let bullpenFactor: number | null = null;
    const recent = await this.baseball.getRecentCompletedForTeam(
      apiSportsTeamId,
      25,
    );
    if (recent.length >= 5) {
      const ra = recent.map((g: any) =>
        g.homeTeamId === apiSportsTeamId ? g.runsAway : g.runsHome,
      );
      const avg = mean(ra.filter((x: any) => x != null));
      if (Number.isFinite(avg) && priors.avgRunsPerTeam > 0) {
        const raw = avg / priors.avgRunsPerTeam;
        const w = recent.length / (recent.length + 20);
        bullpenFactor = 1 + (raw - 1) * w;
      }
    }

    let factor: number;
    if (starterFactor != null && bullpenFactor != null) {
      factor = ipShare * starterFactor + (1 - ipShare) * bullpenFactor;
    } else if (starterFactor != null) {
      // No bullpen data: blend starter toward neutral for the relief innings.
      factor = ipShare * starterFactor + (1 - ipShare) * 1.0;
    } else if (bullpenFactor != null) {
      factor = bullpenFactor;
    } else {
      factor = 1.0;
    }

    return {
      factor: clamp(factor, 0.65, 1.5),
      starterUsed: starterFactor != null,
      starterStale,
      bullpenUsed: bullpenFactor != null,
    };
  }

  private weatherFactor(weather: any, homeSeed: any): number {
    if (!weather) return 1.0;
    let f = 1.0;
    const wind: number = Number(weather.windMph) || 0;
    const dir: string = (weather.windDir || '').toLowerCase();
    if (wind > 0) {
      if (dir.includes('out')) f *= 1 + Math.min(wind, 25) * 0.005;
      else if (dir.includes('in')) f *= 1 - Math.min(wind, 25) * 0.004;
    }
    const temp = Number(weather.tempF);
    if (Number.isFinite(temp)) {
      // ~ +0.6% offense per 10°F above 70.
      f *= 1 + ((temp - 70) / 10) * 0.006;
    }
    void homeSeed; // park orientation × wind vector reserved for v2
    return clamp(f, 0.9, 1.15);
  }

  // ─── line probabilities ────────────────────────────────────────────

  private buildLineProbs(mu: number, pmf: number[]): LineProb[] {
    const cdf: number[] = [];
    let acc = 0;
    for (let k = 0; k < pmf.length; k++) {
      acc += pmf[k];
      cdf[k] = acc;
    }
    const survAtLeast = (k: number) => 1 - (k - 1 >= 0 ? cdf[k - 1] ?? 0 : 0);

    const center = Math.round(mu);
    const lines: number[] = [];
    for (let base = center - 3; base <= center + 3; base++) {
      if (base >= 5) {
        lines.push(base); // integer line (push possible)
        lines.push(base + 0.5); // half line (no push)
      }
    }

    return lines
      .filter((l, i, a) => a.indexOf(l) === i)
      .sort((a, b) => a - b)
      .map((line) => {
        if (Number.isInteger(line)) {
          const push = pmf[line] ?? 0;
          const pOver = survAtLeast(line + 1); // total > line
          const pUnder = 1 - pOver - push;
          return {
            line,
            pOver: clampProb(pOver),
            pUnder: clampProb(pUnder),
            push: clampProb(push),
          };
        }
        const k = Math.ceil(line); // e.g. 7.5 → over means >=8
        const pOver = survAtLeast(k);
        return {
          line,
          pOver: clampProb(pOver),
          pUnder: clampProb(1 - pOver),
          push: 0,
        };
      });
  }

  private scoreConfidence(
    ho: any,
    ao: any,
    hs: any,
    as_: any,
    priors: BaseballLeaguePriors,
  ): number {
    let score = 3;
    if (hs.starterUsed && as_.starterUsed) score += 2.5;
    else if (hs.starterUsed || as_.starterUsed) score += 1;
    if (hs.starterStale || as_.starterStale) score -= 1;
    if (ho.xwobaUsed && ao.xwobaUsed) score += 1.5;
    if (hs.bullpenUsed && as_.bullpenUsed) score += 1;
    if (priors.isReliable) score += 1;
    return Math.max(1, Math.min(10, Math.round(score)));
  }
}

// ─── Negative-Binomial helpers ─────────────────────────────────────────

/** NB size r so that var = phi*mean (phi>1 ⇒ overdispersed). */
export function nbSizeFromMeanPhi(mean: number, phi: number): number {
  const p = Math.max(phi, 1.01);
  return mean / (p - 1);
}

/** PMF array P(X=k) for k=0..kMax under NB(mean, size r). */
export function nbPmfArray(mean: number, r: number, kMax: number): number[] {
  const p = r / (r + mean); // success prob in NB(r,p)
  const lnP = Math.log(p);
  const ln1mP = Math.log(1 - p);
  const out: number[] = [];
  let sum = 0;
  for (let k = 0; k <= kMax; k++) {
    const lpmf =
      logGamma(k + r) -
      logGamma(r) -
      logGamma(k + 1) +
      r * lnP +
      k * ln1mP;
    const pmf = Math.exp(lpmf);
    out[k] = pmf;
    sum += pmf;
  }
  // Renormalize to absorb the truncated tail.
  if (sum > 0) for (let k = 0; k <= kMax; k++) out[k] /= sum;
  return out;
}

/** Lanczos approximation of ln Γ(x). */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
    );
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function clampProb(x: number): number {
  return Math.max(0.001, Math.min(0.999, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
