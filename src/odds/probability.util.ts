import { Injectable } from '@nestjs/common';

/**
 * Sharpness weights for bookmakers.
 * Higher weight = sharper (more accurate) lines.
 *
 * Tier 1 (Sharp): Pinnacle, Betfair Exchange — lowest margins, sharpest lines
 * Tier 2 (Semi-sharp): 1xBet, Marathon, Matchbook, BetOnline, Bovada
 * Tier 3 (Market makers): DraftKings, FanDuel, BetMGM, Sportsbet AU
 * Tier 4 (Soft): William Hill, Unibet, Ladbrokes, Paddy Power, etc.
 *
 * Unnamed bookmakers share the "others" bucket (5%).
 */
const BOOKMAKER_WEIGHTS: Record<string, number> = {
  // Tier 1 — Sharp (45%)
  pinnacle: 0.25,
  betfair_ex_eu: 0.1,
  betfair_ex_uk: 0.05,
  betfair_ex_au: 0.05,

  // Tier 2 — Semi-sharp (25%)
  onexbet: 0.06,
  marathonbet: 0.06,
  matchbook: 0.05,
  betonlineag: 0.04,
  bovada: 0.04,

  // Tier 3 — US/AU market makers (15%)
  draftkings: 0.04,
  fanduel: 0.04,
  betmgm: 0.03,
  sportsbet: 0.02,
  pointsbetau: 0.02,

  // Tier 4 — Soft books (10%)
  williamhill: 0.02,
  paddypower: 0.02,
  ladbrokes_uk: 0.02,
  unibet_uk: 0.01,
  betway: 0.01,
  skybet: 0.01,
  coral: 0.01,
};

const NAMED_TOTAL_WEIGHT = Object.values(BOOKMAKER_WEIGHTS).reduce(
  (sum, w) => sum + w,
  0,
);
const OTHERS_TOTAL_WEIGHT = Math.max(0, 1 - NAMED_TOTAL_WEIGHT); // ~0.05

@Injectable()
export class ProbabilityUtil {
  /**
   * Convert decimal odds to implied probability.
   * Formula: 1 / decimalOdds
   */
  static decimalToImplied(decimalOdds: number): number {
    if (decimalOdds <= 0) return 0;
    return 1 / decimalOdds;
  }

  /**
   * Convert American odds to decimal odds.
   * Positive American: decimal = (american / 100) + 1
   * Negative American: decimal = (100 / |american|) + 1
   */
  static americanToDecimal(americanOdds: number): number {
    if (americanOdds === 0) return 1;
    if (americanOdds > 0) {
      return americanOdds / 100 + 1;
    }
    return 100 / Math.abs(americanOdds) + 1;
  }

  /**
   * Remove the vig (overround) by normalizing implied probabilities
   * so they sum to exactly 1.0.
   */
  static removeVig(impliedProbabilities: number[]): number[] {
    const sum = impliedProbabilities.reduce((acc, p) => acc + p, 0);
    if (sum === 0) return impliedProbabilities.map(() => 0);
    return impliedProbabilities.map((p) => p / sum);
  }

  /**
   * Calculate a weighted consensus probability from multiple bookmaker probabilities.
   *
   * Uses tiered sharpness weights. Bookmakers not in the weight table
   * share the "others" bucket (~5% total, split evenly).
   * Bookmakers not present are excluded and weights are re-normalised.
   */
  static calculateWeightedConsensus(
    bookmakerProbabilities: Array<{
      bookmaker: string;
      probability: number;
    }>,
  ): number {
    if (bookmakerProbabilities.length === 0) return 0;

    // Separate named and "other" bookmakers
    const named: Array<{
      bookmaker: string;
      probability: number;
      weight: number;
    }> = [];
    const others: Array<{ bookmaker: string; probability: number }> = [];

    for (const bp of bookmakerProbabilities) {
      const w = BOOKMAKER_WEIGHTS[bp.bookmaker];
      if (w !== undefined) {
        named.push({ ...bp, weight: w });
      } else {
        others.push(bp);
      }
    }

    let totalWeight = 0;
    let weightedSum = 0;

    // Add named bookmaker contributions
    for (const n of named) {
      weightedSum += n.weight * n.probability;
      totalWeight += n.weight;
    }

    // Split the "others" bucket evenly among unnamed bookmakers
    if (others.length > 0) {
      const perOtherWeight = OTHERS_TOTAL_WEIGHT / others.length;
      for (const o of others) {
        weightedSum += perOtherWeight * o.probability;
        totalWeight += perOtherWeight;
      }
    }

    // Re-normalise so weights of present bookmakers sum to 1
    if (totalWeight === 0) return 0;
    return weightedSum / totalWeight;
  }

  /**
   * Calculate the overround for a set of implied probabilities.
   */
  static calculateOverround(impliedProbabilities: number[]): number {
    return impliedProbabilities.reduce((acc, p) => acc + p, 0) - 1;
  }

  /**
   * Convert a true probability back to decimal odds.
   * Formula: 1 / probability
   */
  static probabilityToDecimal(probability: number): number {
    if (probability <= 0) return 0;
    return 1 / probability;
  }

  /**
   * Calculate the edge (value) percentage between a true probability
   * and the bookmaker's decimal odds.
   * Positive edge = value bet (bookmaker odds are higher than they should be).
   */
  static calculateEdge(
    trueProbability: number,
    bookmakerDecimalOdds: number,
  ): number {
    if (trueProbability <= 0 || bookmakerDecimalOdds <= 0) return 0;
    const impliedFromOdds = 1 / bookmakerDecimalOdds;
    // edge = trueProbability - impliedProbability
    // positive means "the bookmaker is offering better odds than the true probability warrants"
    return (trueProbability - impliedFromOdds) * 100;
  }
}
