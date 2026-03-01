import { Injectable } from '@nestjs/common';

/**
 * Sharpness weights for bookmakers.
 * Higher weight = sharper (more accurate) bookmaker lines.
 */
const BOOKMAKER_WEIGHTS: Record<string, number> = {
  pinnacle: 0.35,
  betfair_ex_eu: 0.25,
  marathonbet: 0.1,
  onexbet: 0.1,
  unibet_eu: 0.05,
  williamhill: 0.05,
};

const NAMED_TOTAL_WEIGHT = Object.values(BOOKMAKER_WEIGHTS).reduce(
  (sum, w) => sum + w,
  0,
);
const OTHERS_TOTAL_WEIGHT = 1 - NAMED_TOTAL_WEIGHT; // 0.10

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
   * Uses sharpness weights:
   *   pinnacle=0.35, betfair_ex_eu=0.25, marathonbet=0.10, onexbet=0.10,
   *   unibet_eu=0.05, williamhill=0.05, others=split of 0.10
   *
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
}
