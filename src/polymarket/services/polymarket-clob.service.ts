import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet, Contract, providers } from 'ethers';
import axios, { AxiosInstance } from 'axios';

// USDC on Polygon (6 decimals)
const POLYGON_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_BALANCE_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

export interface ClobPrice {
  tokenId: string;
  buy: number;
  sell: number;
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
 * Read-only operations use direct HTTP (no auth needed).
 * Order placement uses the official @polymarket/clob-client SDK with wallet signing.
 *
 * Required env vars for live trading:
 * - POLYMARKET_PRIVATE_KEY: Hex private key of the trading wallet
 * - POLYMARKET_API_KEY: API key (from createOrDeriveApiKey)
 * - POLYMARKET_API_SECRET: API secret
 * - POLYMARKET_API_PASSPHRASE: API passphrase
 * - POLYMARKET_FUNDER_ADDRESS: The Polymarket proxy wallet address (funder)
 * - POLYMARKET_SIGNATURE_TYPE: 0 (EOA), 1 (POLY_PROXY), or 2 (GNOSIS_SAFE) — default 2
 */
@Injectable()
export class PolymarketClobService implements OnModuleInit {
  private readonly logger = new Logger(PolymarketClobService.name);

  /** Direct HTTP client for read-only endpoints (no auth) */
  private readonly httpClient: AxiosInstance;

  /** Official SDK client for authenticated trading */
  private clobClient: ClobClient | null = null;
  private hasCredentials = false;
  private initPromise: Promise<void> | null = null;

  private readonly host: string;
  private readonly chainId = 137; // Polygon mainnet

  constructor(private readonly config: ConfigService) {
    this.host =
      this.config.get<string>('POLYMARKET_CLOB_URL') ||
      'https://clob.polymarket.com';

    this.httpClient = axios.create({
      baseURL: this.host,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async onModuleInit() {
    await this.initializeClobClient();
  }

  /**
   * Ensures the CLOB client is initialized before use.
   * Handles the case where the service is constructed outside NestJS DI
   * (e.g. Trigger.dev workers) where onModuleInit is never called.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.clobClient) return; // Already initialized
    if (this.initPromise) return this.initPromise; // Init in progress
    this.initPromise = this.initializeClobClient();
    await this.initPromise;
  }

  /**
   * Initialize the authenticated ClobClient using the official SDK.
   * Called once on NestJS module init, and must be called manually
   * when constructing the service outside NestJS DI (e.g. Trigger.dev workers).
   */
  async initializeClobClient(): Promise<void> {
    const privateKey = this.config.get<string>('POLYMARKET_PRIVATE_KEY');
    const apiKey = this.config.get<string>('POLYMARKET_API_KEY');
    const apiSecret = this.config.get<string>('POLYMARKET_API_SECRET');
    const passphrase = this.config.get<string>('POLYMARKET_API_PASSPHRASE');
    const funderAddress = this.config.get<string>('POLYMARKET_FUNDER_ADDRESS');
    const sigType = Number(
      this.config.get<string>('POLYMARKET_SIGNATURE_TYPE') ?? '2',
    );

    if (!privateKey) {
      this.logger.log(
        'No POLYMARKET_PRIVATE_KEY — read-only mode (paper trading only)',
      );
      return;
    }

    try {
      const signer = new Wallet(privateKey);

      if (apiKey && apiSecret && passphrase) {
        // Use existing API credentials
        // SDK's ApiKeyCreds uses "key" not "apiKey"
        this.clobClient = new ClobClient(
          this.host,
          this.chainId,
          signer,
          { key: apiKey, secret: apiSecret, passphrase },
          sigType,
          funderAddress || signer.address,
        );
        this.hasCredentials = true;
        this.logger.log(
          `CLOB client initialized with existing credentials (sigType=${sigType}, funder=${funderAddress || signer.address})`,
        );
      } else {
        // Derive API credentials from private key
        this.logger.log('Deriving API credentials from private key...');
        const tempClient = new ClobClient(this.host, this.chainId, signer);
        // createOrDeriveApiKey returns { apiKey, secret, passphrase } at runtime
        // but the TS types say ApiKeyCreds { key, secret, passphrase }
        const rawCreds: any = await tempClient.createOrDeriveApiKey();
        const derivedKey = rawCreds.apiKey ?? rawCreds.key;

        const creds = {
          key: derivedKey,
          secret: rawCreds.secret,
          passphrase: rawCreds.passphrase,
        };

        this.clobClient = new ClobClient(
          this.host,
          this.chainId,
          signer,
          creds,
          sigType,
          funderAddress || signer.address,
        );
        this.hasCredentials = true;

        this.logger.log(
          `CLOB client initialized with derived credentials — ` +
            `apiKey=${derivedKey}, sigType=${sigType}`,
        );
        this.logger.log(
          `Save these to .env to skip derivation next time:\n` +
            `  POLYMARKET_API_KEY=${derivedKey}\n` +
            `  POLYMARKET_API_SECRET=${rawCreds.secret}\n` +
            `  POLYMARKET_API_PASSPHRASE=${rawCreds.passphrase}`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to initialize CLOB client: ${error.message}`);
      this.logger.warn('Falling back to read-only mode');
    }
  }

  // ─── Read-only endpoints (no auth, direct HTTP) ─────────────────────

  /**
   * Get current buy/sell prices for a token.
   */
  async getPrice(tokenId: string): Promise<ClobPrice | null> {
    try {
      const [buyRes, sellRes] = await Promise.all([
        this.httpClient.get('/price', {
          params: { token_id: tokenId, side: 'buy' },
        }),
        this.httpClient.get('/price', {
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
   * Get midpoint price (average of best bid and ask).
   */
  async getMidpoint(tokenId: string): Promise<number | null> {
    try {
      const response = await this.httpClient.get('/midpoint', {
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
   * Get bid-ask spread.
   */
  async getSpread(tokenId: string): Promise<number | null> {
    try {
      const response = await this.httpClient.get('/spread', {
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
      const response = await this.httpClient.get('/book', {
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
      const response = await this.httpClient.get('/prices-history', {
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
   * Get a complete pricing snapshot for a market.
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

      if (mid == null && priceData == null) return null;

      const effectiveMid =
        mid ?? (priceData ? (priceData.buy + priceData.sell) / 2 : 0);

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

  // ─── Authenticated endpoints (via official SDK) ─────────────────────

  /**
   * Place a limit order on the CLOB using the official SDK.
   * Handles order signing, tick size, and negRisk automatically.
   */
  async placeLimitOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number; // 0-1
    size: number; // Number of tokens
    conditionId?: string; // Needed to look up tick size + negRisk
    negRisk?: boolean;
  }): Promise<{ orderId: string; status: string } | null> {
    // Lazy-initialize if running outside NestJS DI (e.g. Trigger.dev worker)
    await this.ensureInitialized();

    if (!this.clobClient || !this.hasCredentials) {
      this.logger.warn(
        'Cannot place order — CLOB client not initialized (missing POLYMARKET_PRIVATE_KEY)',
      );
      return null;
    }

    try {
      // Get tick size and negRisk from the market if conditionId provided
      let tickSize = '0.01';
      let negRisk = params.negRisk ?? false;

      if (params.conditionId) {
        try {
          const market = await this.clobClient.getMarket(params.conditionId);
          if (market) {
            tickSize = String((market as any).minimum_tick_size || '0.01');
            negRisk = (market as any).neg_risk ?? negRisk;
          }
        } catch {
          // Fall back to defaults
          this.logger.debug(
            `Could not fetch market details for ${params.conditionId} — using tick_size=${tickSize}`,
          );
        }
      }

      // Round price to tick size
      const tickNum = Number(tickSize);
      const roundedPrice = Math.round(params.price / tickNum) * tickNum;

      this.logger.log(
        `Placing order: ${params.side} ${params.size.toFixed(2)} tokens @ ${roundedPrice.toFixed(4)} ` +
          `(tickSize=${tickSize}, negRisk=${negRisk})`,
      );

      const response = await this.clobClient.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: roundedPrice,
          size: params.size,
          side: params.side === 'BUY' ? Side.BUY : Side.SELL,
        },
        {
          tickSize: tickSize as any,
          negRisk,
        },
        OrderType.GTC,
      );

      const orderId = (response as any)?.orderID ?? '';
      const status = (response as any)?.status ?? 'unknown';

      this.logger.log(
        `Order placed: ${params.side} ${params.size.toFixed(2)} tokens @ ${roundedPrice.toFixed(4)} — ` +
          `ID: ${orderId}, status: ${status}`,
      );

      return { orderId, status };
    } catch (error) {
      this.logger.error(
        `Failed to place order: ${error.message}`,
        error.response?.data ?? error.stack,
      );
      return null;
    }
  }

  /**
   * Cancel an existing order.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.clobClient || !this.hasCredentials) return false;

    try {
      await this.clobClient.cancelOrder({ orderID: orderId });
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
    await this.ensureInitialized();
    if (!this.clobClient || !this.hasCredentials) return [];

    try {
      const orders = await this.clobClient.getOpenOrders();
      return orders ?? [];
    } catch (error) {
      this.logger.warn(`Failed to get open orders: ${error.message}`);
      return [];
    }
  }

  /**
   * Get the USDC balance of the Polymarket trading wallet (proxy/funder address).
   * Returns the balance in USD (USDC has 6 decimals).
   * Returns null if the wallet address is not configured or the query fails.
   */
  async getWalletBalance(): Promise<number | null> {
    const privateKey = this.config.get<string>('POLYMARKET_PRIVATE_KEY');
    if (!privateKey) {
      this.logger.warn(
        'Cannot check wallet balance — no POLYMARKET_PRIVATE_KEY configured',
      );
      return null;
    }

    const signer = new Wallet(privateKey);
    const funderAddress =
      this.config.get<string>('POLYMARKET_FUNDER_ADDRESS') || signer.address;

    const rpcUrl =
      this.config.get<string>('POLYGON_RPC_URL') || 'https://polygon-rpc.com';

    try {
      const provider = new providers.JsonRpcProvider(rpcUrl);
      const usdc = new Contract(
        POLYGON_USDC_ADDRESS,
        ERC20_BALANCE_ABI,
        provider,
      );

      const rawBalance = await usdc.balanceOf(funderAddress);
      // USDC has 6 decimals
      const balance = Number(rawBalance) / 1e6;

      this.logger.log(
        `Wallet USDC balance for ${funderAddress}: $${balance.toFixed(2)}`,
      );
      return balance;
    } catch (error) {
      this.logger.error(
        `Failed to query wallet USDC balance: ${error.message}`,
      );
      return null;
    }
  }
}
