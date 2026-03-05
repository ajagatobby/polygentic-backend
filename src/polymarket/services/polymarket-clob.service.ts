import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface ClobPrice {
  tokenId: string;
  buy: number;
  sell: number;
}

export interface ClobMidpoint {
  tokenId: string;
  mid: number;
}

export interface ClobSpread {
  tokenId: string;
  spread: number;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface ClobOrderBook {
  market: string;
  assetId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface PriceHistoryPoint {
  t: number; // Unix timestamp
  p: number; // Price 0-1
}

/**
 * Full market pricing snapshot — everything the trading agent needs.
 */
export interface MarketPricingSnapshot {
  tokenId: string;
  midpoint: number; // Best probability estimate
  buyPrice: number;
  sellPrice: number;
  spread: number;
  bookDepth: {
    totalBidSize: number;
    totalAskSize: number;
    topBidSize: number;
    topAskSize: number;
  };
}

/**
 * PolymarketClobService
 *
 * Client for Polymarket's CLOB API — prices, orderbook, and order placement.
 * Read-only operations require no authentication.
 * Order placement requires API key/secret/passphrase.
 */
@Injectable()
export class PolymarketClobService {
  private readonly logger = new Logger(PolymarketClobService.name);
  private readonly client: AxiosInstance;
  private readonly hasCredentials: boolean;

  constructor(private readonly config: ConfigService) {
    const baseURL =
      this.config.get<string>('POLYMARKET_CLOB_URL') ||
      'https://clob.polymarket.com';

    this.client = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.hasCredentials = !!(
      this.config.get<string>('POLYMARKET_API_KEY') &&
      this.config.get<string>('POLYMARKET_API_SECRET') &&
      this.config.get<string>('POLYMARKET_API_PASSPHRASE')
    );

    if (this.hasCredentials) {
      this.logger.log('CLOB API credentials detected — live trading available');
    } else {
      this.logger.log(
        'No CLOB API credentials — read-only mode (paper trading)',
      );
    }
  }

  // ─── Read-only endpoints (no auth) ──────────────────────────────────

  /**
   * Get current buy/sell prices for a token.
   */
  async getPrice(tokenId: string): Promise<ClobPrice | null> {
    try {
      const [buyRes, sellRes] = await Promise.all([
        this.client.get('/price', {
          params: { token_id: tokenId, side: 'buy' },
        }),
        this.client.get('/price', {
          params: { token_id: tokenId, side: 'sell' },
        }),
      ]);

      return {
        tokenId,
        buy: Number(buyRes.data?.price) || 0,
        sell: Number(sellRes.data?.price) || 0,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get price for token ${tokenId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get midpoint price (average of best bid and ask) — the most accurate probability estimate.
   */
  async getMidpoint(tokenId: string): Promise<number | null> {
    try {
      const response = await this.client.get('/midpoint', {
        params: { token_id: tokenId },
      });
      return Number(response.data?.mid) || null;
    } catch (error) {
      this.logger.warn(
        `Failed to get midpoint for token ${tokenId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get bid-ask spread — indicator of liquidity quality.
   */
  async getSpread(tokenId: string): Promise<number | null> {
    try {
      const response = await this.client.get('/spread', {
        params: { token_id: tokenId },
      });
      return Number(response.data?.spread) || null;
    } catch (error) {
      this.logger.warn(
        `Failed to get spread for token ${tokenId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get full order book for a token.
   */
  async getOrderBook(tokenId: string): Promise<ClobOrderBook | null> {
    try {
      const response = await this.client.get('/book', {
        params: { token_id: tokenId },
      });

      const data = response.data;
      return {
        market: data?.market ?? '',
        assetId: data?.asset_id ?? tokenId,
        bids: data?.bids ?? [],
        asks: data?.asks ?? [],
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get order book for token ${tokenId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get price history for a market.
   */
  async getPriceHistory(
    conditionId: string,
    interval: '1d' | '1w' | '1m' | '3m' | '6m' | 'max' = '1w',
    fidelity: 1 | 5 | 15 | 60 | 1440 = 60,
  ): Promise<PriceHistoryPoint[]> {
    try {
      const response = await this.client.get('/prices-history', {
        params: { market: conditionId, interval, fidelity },
      });
      return response.data?.history ?? [];
    } catch (error) {
      this.logger.warn(
        `Failed to get price history for ${conditionId}: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Get a complete pricing snapshot for a market — everything needed for a trading decision.
   * Fetches midpoint, prices, spread, and order book in parallel.
   */
  async getMarketPricingSnapshot(
    tokenId: string,
  ): Promise<MarketPricingSnapshot | null> {
    try {
      const [price, midpoint, spread, book] = await Promise.allSettled([
        this.getPrice(tokenId),
        this.getMidpoint(tokenId),
        this.getSpread(tokenId),
        this.getOrderBook(tokenId),
      ]);

      const priceData = price.status === 'fulfilled' ? price.value : null;
      const mid = midpoint.status === 'fulfilled' ? midpoint.value : null;
      const sprd = spread.status === 'fulfilled' ? spread.value : null;
      const bookData = book.status === 'fulfilled' ? book.value : null;

      // Need at least a midpoint to be useful
      if (mid == null && priceData == null) return null;

      const effectiveMid =
        mid ?? (priceData ? (priceData.buy + priceData.sell) / 2 : 0);

      // Calculate book depth
      const totalBidSize = bookData
        ? bookData.bids.reduce((sum, b) => sum + Number(b.size), 0)
        : 0;
      const totalAskSize = bookData
        ? bookData.asks.reduce((sum, a) => sum + Number(a.size), 0)
        : 0;
      const topBidSize =
        bookData && bookData.bids.length > 0
          ? Number(bookData.bids[0].size)
          : 0;
      const topAskSize =
        bookData && bookData.asks.length > 0
          ? Number(bookData.asks[0].size)
          : 0;

      return {
        tokenId,
        midpoint: effectiveMid,
        buyPrice: priceData?.buy ?? effectiveMid,
        sellPrice: priceData?.sell ?? effectiveMid,
        spread: sprd ?? (priceData ? priceData.buy - priceData.sell : 0),
        bookDepth: {
          totalBidSize,
          totalAskSize,
          topBidSize,
          topAskSize,
        },
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get pricing snapshot for ${tokenId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get pricing snapshots for multiple tokens (batch).
   */
  async getBatchPricingSnapshots(
    tokenIds: string[],
  ): Promise<Map<string, MarketPricingSnapshot>> {
    const results = new Map<string, MarketPricingSnapshot>();

    // Process in batches of 10 to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);
      const snapshots = await Promise.allSettled(
        batch.map((id) => this.getMarketPricingSnapshot(id)),
      );

      for (let j = 0; j < batch.length; j++) {
        const result = snapshots[j];
        if (result.status === 'fulfilled' && result.value) {
          results.set(batch[j], result.value);
        }
      }
    }

    return results;
  }

  // ─── Authenticated endpoints (for live trading) ─────────────────────

  /**
   * Get authentication headers for CLOB API requests.
   * Uses HMAC-based auth with API key/secret/passphrase.
   */
  private getAuthHeaders(): Record<string, string> {
    const apiKey = this.config.get<string>('POLYMARKET_API_KEY');
    const apiSecret = this.config.get<string>('POLYMARKET_API_SECRET');
    const passphrase = this.config.get<string>('POLYMARKET_API_PASSPHRASE');

    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error(
        'Polymarket API credentials not configured — cannot place orders',
      );
    }

    // The Polymarket CLOB API uses these headers for authentication
    return {
      POLY_API_KEY: apiKey,
      POLY_SECRET: apiSecret,
      POLY_PASSPHRASE: passphrase,
    };
  }

  /**
   * Place a limit order on the CLOB.
   * Only works in live trading mode with valid credentials.
   */
  async placeLimitOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number; // 0-1
    size: number; // Number of tokens
  }): Promise<{ orderId: string; status: string } | null> {
    if (!this.hasCredentials) {
      this.logger.warn('Cannot place order — no API credentials configured');
      return null;
    }

    try {
      const response = await this.client.post(
        '/order',
        {
          tokenID: params.tokenId,
          side: params.side,
          price: params.price.toFixed(2),
          size: params.size.toFixed(2),
          type: 'GTC', // Good Till Cancelled
        },
        {
          headers: this.getAuthHeaders(),
        },
      );

      const data = response.data;
      this.logger.log(
        `Order placed: ${params.side} ${params.size} tokens @ ${params.price} — ID: ${data?.orderID}`,
      );

      return {
        orderId: data?.orderID ?? '',
        status: data?.status ?? 'unknown',
      };
    } catch (error) {
      this.logger.error(
        `Failed to place order: ${error.message}`,
        error.response?.data,
      );
      return null;
    }
  }

  /**
   * Cancel an existing order.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.hasCredentials) return false;

    try {
      await this.client.delete(`/order/${orderId}`, {
        headers: this.getAuthHeaders(),
      });
      this.logger.log(`Order cancelled: ${orderId}`);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to cancel order ${orderId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get open orders for the authenticated user.
   */
  async getOpenOrders(): Promise<any[]> {
    if (!this.hasCredentials) return [];

    try {
      const response = await this.client.get('/orders', {
        headers: this.getAuthHeaders(),
        params: { status: 'live' },
      });
      return response.data ?? [];
    } catch (error) {
      this.logger.warn(`Failed to get open orders: ${error.message}`);
      return [];
    }
  }
}
