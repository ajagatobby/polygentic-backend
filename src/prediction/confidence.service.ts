import { Injectable, Logger } from '@nestjs/common';
import { Recommendation } from './dto/prediction-query.dto';

export interface ConfidenceInput {
  /** Mispricing signal result */
  mispricingGap: number | null;
  mispricingDirection: string | null;
  /** Statistical model probability for the outcome */
  statisticalProb: number | null;
  /** Bookmaker consensus probability for the outcome */
  consensusProb: number | null;
  /** API-Football prediction probability */
  apiFootballProb: number | null;
  /** Polymarket market liquidity */
  liquidity: number | null;
  /** Polymarket market volume */
  volume: number | null;
  /** Days until the event */
  daysToEvent: number | null;
  /** Number of bookmakers with odds */
  numBookmakers: number | null;
  /** Whether injury data is available */
  hasInjuryData: boolean;
  /** Whether form data is available */
  hasFormData: boolean;
  /** Whether H2H data is available */
  hasH2HData: boolean;
}

export interface ConfidenceResult {
  score: number;
  label: string;
  breakdown: {
    signalAgreement: number;
    mispricingSize: number;
    dataCompleteness: number;
    marketLiquidity: number;
    timeToEvent: number;
    historicalAccuracy: number;
  };
}

@Injectable()
export class ConfidenceService {
  private readonly logger = new Logger(ConfidenceService.name);

  /**
   * Calculate a confidence score from 0-100 based on:
   *   Signal agreement:      max 30 pts
   *   Mispricing gap size:   max 25 pts
   *   Data completeness:     max 15 pts
   *   Market liquidity:      max 15 pts
   *   Time to event:         max 10 pts
   *   Historical accuracy:   max  5 pts (placeholder)
   */
  calculateConfidence(input: ConfidenceInput): ConfidenceResult {
    const signalAgreement = this.scoreSignalAgreement(input);
    const mispricingSize = this.scoreMispricingSize(input.mispricingGap);
    const dataCompleteness = this.scoreDataCompleteness(input);
    const marketLiquidity = this.scoreMarketLiquidity(
      input.liquidity,
      input.volume,
    );
    const timeToEvent = this.scoreTimeToEvent(input.daysToEvent);
    const historicalAccuracy = this.scoreHistoricalAccuracy();

    const score = Math.round(
      signalAgreement +
        mispricingSize +
        dataCompleteness +
        marketLiquidity +
        timeToEvent +
        historicalAccuracy,
    );

    const clampedScore = Math.max(0, Math.min(100, score));
    const label = this.getConfidenceLabel(clampedScore);

    return {
      score: clampedScore,
      label,
      breakdown: {
        signalAgreement,
        mispricingSize,
        dataCompleteness,
        marketLiquidity,
        timeToEvent,
        historicalAccuracy,
      },
    };
  }

  /**
   * Determine the trading recommendation based on confidence and mispricing gap.
   *
   * Rules (from docs):
   *   confidence >= 60 AND gap > 0.05  → BUY_YES
   *   confidence >= 60 AND gap < -0.05 → BUY_NO
   *   confidence >= 40 AND |gap| > 0.03 → HOLD
   *   else → NO_SIGNAL
   */
  getRecommendation(
    confidence: number,
    mispricingGap: number | null,
  ): Recommendation {
    const gap = mispricingGap ?? 0;
    const absGap = Math.abs(gap);

    if (confidence >= 60 && gap > 0.05) {
      return Recommendation.BUY_YES;
    }

    if (confidence >= 60 && gap < -0.05) {
      return Recommendation.BUY_NO;
    }

    if (confidence >= 40 && absGap > 0.03) {
      return Recommendation.HOLD;
    }

    return Recommendation.NO_SIGNAL;
  }

  // ─── Private scoring methods ─────────────────────────────────────────

  /**
   * Score signal agreement (max 30 pts).
   * All 3 signals within 5% of each other = 30 pts.
   * Wider disagreement = fewer points.
   */
  private scoreSignalAgreement(input: ConfidenceInput): number {
    const signals: number[] = [];

    if (input.consensusProb != null && input.consensusProb > 0) {
      signals.push(input.consensusProb);
    }
    if (input.statisticalProb != null && input.statisticalProb > 0) {
      signals.push(input.statisticalProb);
    }
    if (input.apiFootballProb != null && input.apiFootballProb > 0) {
      signals.push(input.apiFootballProb);
    }

    if (signals.length < 2) {
      // Can't measure agreement with fewer than 2 signals
      return 5;
    }

    const maxVal = Math.max(...signals);
    const minVal = Math.min(...signals);
    const spread = maxVal - minVal;

    if (spread <= 0.05) return 30;
    if (spread <= 0.1) return 22;
    if (spread <= 0.15) return 15;
    if (spread <= 0.2) return 10;
    return 5;
  }

  /**
   * Score mispricing gap size (max 25 pts).
   * > 15% gap = 25 pts.
   */
  private scoreMispricingSize(gap: number | null): number {
    if (gap == null) return 0;
    const absGap = Math.abs(gap);

    if (absGap >= 0.15) return 25;
    if (absGap >= 0.1) return 20;
    if (absGap >= 0.07) return 15;
    if (absGap >= 0.05) return 10;
    if (absGap >= 0.03) return 5;
    return 2;
  }

  /**
   * Score data completeness (max 15 pts).
   * All data sources available = 15.
   * Missing injury data = -3, missing odds = -5, etc.
   */
  private scoreDataCompleteness(input: ConfidenceInput): number {
    let score = 15;

    if (input.consensusProb == null || input.consensusProb <= 0) {
      score -= 5; // missing bookmaker odds
    }
    if (!input.hasInjuryData) {
      score -= 3;
    }
    if (!input.hasFormData) {
      score -= 2;
    }
    if (!input.hasH2HData) {
      score -= 2;
    }
    if (input.apiFootballProb == null || input.apiFootballProb <= 0) {
      score -= 2;
    }
    if (input.numBookmakers != null && input.numBookmakers < 3) {
      score -= 2; // thin market
    }

    return Math.max(0, score);
  }

  /**
   * Score market liquidity (max 15 pts).
   * > $50K volume = 15 pts.
   */
  private scoreMarketLiquidity(
    liquidity: number | null,
    volume: number | null,
  ): number {
    const vol = volume ?? 0;
    const liq = liquidity ?? 0;

    // Use the larger of volume or liquidity
    const metric = Math.max(vol, liq);

    if (metric >= 50_000) return 15;
    if (metric >= 25_000) return 12;
    if (metric >= 10_000) return 9;
    if (metric >= 5_000) return 6;
    if (metric >= 1_000) return 3;
    return 1;
  }

  /**
   * Score time to event (max 10 pts).
   * 1-7 days = 10 pts (optimal).
   * Too far out = less data. Too close = less time to act.
   */
  private scoreTimeToEvent(daysToEvent: number | null): number {
    if (daysToEvent == null) return 5;

    if (daysToEvent >= 1 && daysToEvent <= 7) return 10;
    if (daysToEvent > 7 && daysToEvent <= 14) return 8;
    if (daysToEvent > 14 && daysToEvent <= 30) return 5;
    if (daysToEvent > 30) return 3;

    // Less than 1 day (same-day)
    if (daysToEvent >= 0 && daysToEvent < 1) return 7;

    return 3;
  }

  /**
   * Score historical accuracy (max 5 pts).
   * Placeholder — will be populated once we have enough resolved predictions.
   */
  private scoreHistoricalAccuracy(): number {
    // Default mid-range value until we have historical data
    return 3;
  }

  /**
   * Convert confidence score to a human-readable label.
   */
  private getConfidenceLabel(score: number): string {
    if (score >= 80) return 'Very High';
    if (score >= 60) return 'High';
    if (score >= 40) return 'Medium';
    if (score >= 20) return 'Low';
    return 'Very Low';
  }
}
