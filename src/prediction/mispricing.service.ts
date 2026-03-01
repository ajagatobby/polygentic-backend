import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import {
  polymarketMarkets,
  polymarketPriceHistory,
  consensusOdds,
} from '../database/schema';

export interface MispricingResult {
  /** Signed gap: positive = Polymarket underpriced, negative = overpriced */
  gap: number;
  /** Percentage mispricing relative to consensus */
  pct: number;
  /** Signal strength from 0 to 1 */
  signalStrength: number;
  /** Direction of the mispricing signal */
  direction: 'BUY_YES' | 'BUY_NO' | 'NEUTRAL';
  /** The Polymarket price used */
  polymarketPrice: number;
  /** The bookmaker consensus probability used */
  consensusProbability: number;
}

@Injectable()
export class MispricingService {
  private readonly logger = new Logger(MispricingService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  /**
   * Compare a Polymarket price against the bookmaker consensus probability.
   *
   * mispricing_gap = consensus - polymarket_price
   * mispricing_pct = gap / consensus * 100
   *
   * Positive gap → Polymarket is underpriced (BUY_YES signal)
   * Negative gap → Polymarket is overpriced (BUY_NO signal)
   */
  detectMispricing(
    polymarketPrice: number,
    consensusData: {
      consensusHomeWin?: number | string | null;
      consensusDraw?: number | string | null;
      consensusAwayWin?: number | string | null;
    },
    mappedOutcome: string = 'home_win',
  ): MispricingResult {
    // Pick the consensus probability for the mapped outcome
    let consensusProbability: number;

    switch (mappedOutcome) {
      case 'home_win':
        consensusProbability = parseFloat(
          String(consensusData.consensusHomeWin ?? '0'),
        );
        break;
      case 'away_win':
        consensusProbability = parseFloat(
          String(consensusData.consensusAwayWin ?? '0'),
        );
        break;
      case 'draw':
        consensusProbability = parseFloat(
          String(consensusData.consensusDraw ?? '0'),
        );
        break;
      default:
        consensusProbability = parseFloat(
          String(consensusData.consensusHomeWin ?? '0'),
        );
    }

    if (
      isNaN(consensusProbability) ||
      consensusProbability <= 0 ||
      isNaN(polymarketPrice) ||
      polymarketPrice <= 0
    ) {
      return {
        gap: 0,
        pct: 0,
        signalStrength: 0,
        direction: 'NEUTRAL',
        polymarketPrice,
        consensusProbability: consensusProbability || 0,
      };
    }

    const gap = consensusProbability - polymarketPrice;
    const pct =
      consensusProbability !== 0 ? (gap / consensusProbability) * 100 : 0;

    // Determine signal direction and strength
    let direction: 'BUY_YES' | 'BUY_NO' | 'NEUTRAL' = 'NEUTRAL';
    let signalStrength = 0;

    const absGap = Math.abs(gap);

    if (gap > 0.10) {
      // Strong BUY_YES: Polymarket significantly underpriced
      direction = 'BUY_YES';
      signalStrength = Math.min(1.0, 0.7 + (absGap - 0.10) * 3);
    } else if (gap > 0.05) {
      // Moderate BUY_YES
      direction = 'BUY_YES';
      signalStrength = 0.3 + ((absGap - 0.05) / 0.05) * 0.4;
    } else if (gap < -0.10) {
      // Strong BUY_NO: Polymarket significantly overpriced
      direction = 'BUY_NO';
      signalStrength = Math.min(1.0, 0.7 + (absGap - 0.10) * 3);
    } else if (gap < -0.05) {
      // Moderate BUY_NO
      direction = 'BUY_NO';
      signalStrength = 0.3 + ((absGap - 0.05) / 0.05) * 0.4;
    } else {
      // Within noise range (-0.05 to +0.05)
      direction = 'NEUTRAL';
      signalStrength = absGap / 0.05 * 0.3;
    }

    return {
      gap,
      pct,
      signalStrength,
      direction,
      polymarketPrice,
      consensusProbability,
    };
  }

  /**
   * Full mispricing calculation with database lookups.
   * Fetches the latest Polymarket price and consensus odds,
   * then runs mispricing detection.
   */
  async calculateMispricingSignal(
    polymarketMarketId: string,
    oddsApiEventId: string,
    mappedOutcome: string = 'home_win',
  ): Promise<MispricingResult | null> {
    // Get the latest Polymarket price
    const [latestPrice] = await this.db
      .select()
      .from(polymarketPriceHistory)
      .where(eq(polymarketPriceHistory.marketId, polymarketMarketId))
      .orderBy(desc(polymarketPriceHistory.recordedAt))
      .limit(1);

    // Also check the market itself for current price
    const [market] = await this.db
      .select()
      .from(polymarketMarkets)
      .where(eq(polymarketMarkets.id, polymarketMarketId))
      .limit(1);

    let polymarketPrice = 0;

    if (latestPrice) {
      polymarketPrice = parseFloat(String(latestPrice.yesPrice ?? '0'));
    } else if (market?.outcomePrices) {
      // Fallback to market's outcome prices
      const prices = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : [];
      polymarketPrice = parseFloat(String(prices[0] ?? '0'));
    }

    if (polymarketPrice <= 0) {
      this.logger.debug(
        `No valid Polymarket price found for market ${polymarketMarketId}`,
      );
      return null;
    }

    // Get the latest consensus odds for this event (h2h market)
    const [consensus] = await this.db
      .select()
      .from(consensusOdds)
      .where(eq(consensusOdds.oddsApiEventId, oddsApiEventId))
      .orderBy(desc(consensusOdds.calculatedAt))
      .limit(1);

    if (!consensus) {
      this.logger.debug(
        `No consensus odds found for event ${oddsApiEventId}`,
      );
      return null;
    }

    return this.detectMispricing(polymarketPrice, consensus, mappedOutcome);
  }
}
