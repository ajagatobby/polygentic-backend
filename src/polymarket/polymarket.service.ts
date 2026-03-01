import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { eq, desc, like, and, count } from 'drizzle-orm';
import {
  polymarketEvents,
  polymarketMarkets,
  polymarketPriceHistory,
} from '../database/schema';
import {
  MarketType,
  MarketQueryDto,
  PaginatedMarketsResponseDto,
  SyncResultDto,
} from './dto/market-query.dto';

/**
 * Tags used to discover soccer/football markets on Polymarket.
 * Polymarket uses various tags — we cast a wide net and deduplicate.
 */
const SOCCER_TAGS = [
  'soccer',
  'football',
  'premier-league',
  'la-liga',
  'serie-a',
  'bundesliga',
  'ligue-1',
  'champions-league',
  'europa-league',
  'world-cup',
  'euro',
  'mls',
  'copa-america',
  'nations-league',
];

@Injectable()
export class PolymarketService {
  private readonly logger = new Logger(PolymarketService.name);
  private readonly gammaApi: AxiosInstance;
  private readonly clobApi: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    @Inject('DRIZZLE') private db: any,
  ) {
    const gammaBaseUrl = this.configService.get<string>(
      'POLYMARKET_GAMMA_URL',
      'https://gamma-api.polymarket.com',
    );
    const clobBaseUrl = this.configService.get<string>(
      'POLYMARKET_CLOB_URL',
      'https://clob.polymarket.com',
    );

    this.gammaApi = axios.create({
      baseURL: gammaBaseUrl,
      timeout: 30_000,
      headers: { Accept: 'application/json' },
    });

    this.clobApi = axios.create({
      baseURL: clobBaseUrl,
      timeout: 30_000,
      headers: { Accept: 'application/json' },
    });
  }

  // ─── Sync Soccer Events from Gamma API ──────────────────────────────────────

  async syncSoccerEvents(): Promise<SyncResultDto> {
    this.logger.log('Starting soccer events sync from Polymarket Gamma API');

    let eventsUpserted = 0;
    let marketsUpserted = 0;
    const errors: string[] = [];
    const seenEventIds = new Set<string>();

    for (const tag of SOCCER_TAGS) {
      try {
        const events = await this.fetchEventsByTag(tag);

        for (const event of events) {
          if (seenEventIds.has(event.id)) continue;
          seenEventIds.add(event.id);

          try {
            await this.upsertEvent(event);
            eventsUpserted++;

            if (Array.isArray(event.markets)) {
              for (const market of event.markets) {
                try {
                  await this.upsertMarket(event, market);
                  marketsUpserted++;
                } catch (err) {
                  const msg = `Failed to upsert market ${market.id}: ${err.message}`;
                  this.logger.warn(msg);
                  errors.push(msg);
                }
              }
            }
          } catch (err) {
            const msg = `Failed to upsert event ${event.id}: ${err.message}`;
            this.logger.warn(msg);
            errors.push(msg);
          }
        }
      } catch (err) {
        const msg = `Failed to fetch events for tag "${tag}": ${err.message}`;
        this.logger.warn(msg);
        errors.push(msg);
      }
    }

    this.logger.log(
      `Sync complete: ${eventsUpserted} events, ${marketsUpserted} markets upserted`,
    );

    return {
      eventsUpserted,
      marketsUpserted,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // ─── Sync Prices for Active Markets ─────────────────────────────────────────

  async syncPrices(): Promise<SyncResultDto> {
    this.logger.log('Starting price sync for active Polymarket markets');

    let pricesInserted = 0;
    const errors: string[] = [];

    try {
      const activeMarkets = await this.db
        .select()
        .from(polymarketMarkets)
        .where(
          and(
            eq(polymarketMarkets.active, true),
            eq(polymarketMarkets.closed, false),
          ),
        );

      // Build a mapping: tokenId → { marketId, side }
      // clobTokenIds is stored as jsonb, typically ["yesTokenId", "noTokenId"]
      const tokenEntries: {
        tokenId: string;
        marketId: string;
        index: number;
      }[] = [];

      for (const market of activeMarkets) {
        const tokenIds = market.clobTokenIds;
        if (!Array.isArray(tokenIds)) continue;

        tokenIds.forEach((tokenId: string, idx: number) => {
          if (typeof tokenId === 'string' && tokenId.length > 0) {
            tokenEntries.push({ tokenId, marketId: market.id, index: idx });
          }
        });
      }

      if (tokenEntries.length === 0) {
        this.logger.log('No active tokens found to sync prices for');
        return { eventsUpserted: 0, marketsUpserted: 0, pricesInserted: 0 };
      }

      // Group token entries by market for batch lookup
      const marketTokenMap = new Map<
        string,
        { yesTokenId?: string; noTokenId?: string }
      >();

      for (const entry of tokenEntries) {
        if (!marketTokenMap.has(entry.marketId)) {
          marketTokenMap.set(entry.marketId, {});
        }
        const m = marketTokenMap.get(entry.marketId);
        if (entry.index === 0) m.yesTokenId = entry.tokenId;
        if (entry.index === 1) m.noTokenId = entry.tokenId;
      }

      // Fetch prices in batches via the CLOB /prices endpoint
      const allTokenIds = tokenEntries.map((e) => e.tokenId);
      const batchSize = 50;
      const priceMap = new Map<string, { buy?: string; sell?: string }>();

      for (let i = 0; i < allTokenIds.length; i += batchSize) {
        const batch = allTokenIds.slice(i, i + batchSize);

        try {
          const response = await this.clobApi.get('/prices', {
            params: { token_ids: batch.join(',') },
          });

          const data = response.data;
          for (const [tokenId, priceData] of Object.entries<any>(data)) {
            priceMap.set(tokenId, priceData);
          }
        } catch (err) {
          const msg = `Failed to fetch prices for batch starting at index ${i}: ${err.message}`;
          this.logger.warn(msg);
          errors.push(msg);
        }
      }

      // Insert price history records per market
      for (const [marketId, tokens] of marketTokenMap.entries()) {
        try {
          const yesPriceData = tokens.yesTokenId
            ? priceMap.get(tokens.yesTokenId)
            : undefined;
          const noPriceData = tokens.noTokenId
            ? priceMap.get(tokens.noTokenId)
            : undefined;

          const yesPrice = this.midpointFromPriceData(yesPriceData);
          const noPrice = this.midpointFromPriceData(noPriceData);

          if (yesPrice === null && noPrice === null) continue;

          // If we only have one side, derive the other (probabilities sum to 1)
          const finalYes = yesPrice ?? (noPrice !== null ? 1 - noPrice : 0);
          const finalNo = noPrice ?? (yesPrice !== null ? 1 - yesPrice : 0);
          const midpoint = finalYes;
          const spread = this.spreadFromPriceData(yesPriceData);

          // Fetch current market-level volume/liquidity for snapshot
          const [currentMarket] = await this.db
            .select({
              volume24hr: polymarketMarkets.volume24hr,
              liquidity: polymarketMarkets.liquidity,
            })
            .from(polymarketMarkets)
            .where(eq(polymarketMarkets.id, marketId))
            .limit(1);

          await this.db.insert(polymarketPriceHistory).values({
            marketId,
            yesPrice: finalYes.toFixed(4),
            noPrice: finalNo.toFixed(4),
            midpoint: midpoint.toFixed(4),
            spread: spread?.toFixed(4) ?? null,
            volume24hr: currentMarket?.volume24hr ?? null,
            liquidity: currentMarket?.liquidity ?? null,
            recordedAt: new Date(),
          });

          pricesInserted++;
        } catch (err) {
          const msg = `Failed to insert price for market ${marketId}: ${err.message}`;
          this.logger.warn(msg);
          errors.push(msg);
        }
      }
    } catch (err) {
      const msg = `Price sync failed: ${err.message}`;
      this.logger.error(msg);
      errors.push(msg);
    }

    this.logger.log(`Price sync complete: ${pricesInserted} prices inserted`);

    return {
      eventsUpserted: 0,
      marketsUpserted: 0,
      pricesInserted,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // ─── Query Markets ──────────────────────────────────────────────────────────

  async getMarkets(
    filters?: MarketQueryDto,
  ): Promise<PaginatedMarketsResponseDto> {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (filters?.type) {
      conditions.push(eq(polymarketMarkets.marketType, filters.type));
    }

    if (filters?.active !== undefined) {
      conditions.push(eq(polymarketMarkets.active, filters.active));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [markets, totalResult] = await Promise.all([
      this.db
        .select()
        .from(polymarketMarkets)
        .where(whereClause)
        .orderBy(desc(polymarketMarkets.volume))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(polymarketMarkets)
        .where(whereClause),
    ]);

    const total = totalResult[0]?.count ?? 0;

    return {
      data: markets,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Get Single Market with Price History ──────────────────────────────────

  async getMarketById(id: string) {
    const [market] = await this.db
      .select()
      .from(polymarketMarkets)
      .where(eq(polymarketMarkets.id, id))
      .limit(1);

    if (!market) {
      return null;
    }

    const [priceHistory, event] = await Promise.all([
      this.db
        .select()
        .from(polymarketPriceHistory)
        .where(eq(polymarketPriceHistory.marketId, id))
        .orderBy(desc(polymarketPriceHistory.recordedAt))
        .limit(500),
      this.db
        .select()
        .from(polymarketEvents)
        .where(eq(polymarketEvents.id, market.eventId))
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null),
    ]);

    return {
      ...market,
      priceHistory,
      event,
    };
  }

  // ─── Search Markets ─────────────────────────────────────────────────────────

  async searchMarkets(query: string, limit = 20) {
    const searchPattern = `%${query}%`;

    const markets = await this.db
      .select()
      .from(polymarketMarkets)
      .where(like(polymarketMarkets.question, searchPattern))
      .orderBy(desc(polymarketMarkets.volume))
      .limit(limit);

    return markets;
  }

  // ─── Classify Market Type ───────────────────────────────────────────────────

  classifyMarketType(title: string, description: string): MarketType {
    const text = `${title} ${description}`.toLowerCase();

    // Match outcome — specific match between two teams
    const matchPatterns = [
      /will .+ (beat|defeat|win against) .+/,
      /\bvs\.?\b/,
      /\bversus\b/,
      /.+ (to win|to beat) .+ on/,
      /match (result|outcome|winner)/,
      /who will win .+ vs/,
    ];
    if (matchPatterns.some((p) => p.test(text))) {
      return MarketType.MATCH_OUTCOME;
    }

    // Transfer markets
    const transferPatterns = [
      /\btransfer\b/,
      /\bjoin\b/,
      /\bsign(ed|ing)?\b/,
      /\bmove to\b/,
      /\btransfer window\b/,
      /\btransfer fee\b/,
      /\bleave\b.*\bclub\b/,
    ];
    if (transferPatterns.some((p) => p.test(text))) {
      return MarketType.TRANSFER;
    }

    // Manager markets
    const managerPatterns = [
      /\bmanager\b/,
      /\bcoach\b/,
      /\bsacked\b/,
      /\bfired\b/,
      /\bappointed\b/,
      /\bhead coach\b/,
      /\breplaced as\b/,
    ];
    if (managerPatterns.some((p) => p.test(text))) {
      return MarketType.MANAGER;
    }

    // Player props
    const playerPropPatterns = [
      /\bgoals?\b.*\bseason\b/,
      /\bassists?\b/,
      /\bscor(e|ing)\b.*\d+/,
      /\btop scorer\b/,
      /\bgolden boot\b/,
      /\bhat[- ]?trick\b/,
      /\bclean sheet/,
      /\bballon d'or\b/,
      /\bplayer of\b/,
    ];
    if (playerPropPatterns.some((p) => p.test(text))) {
      return MarketType.PLAYER_PROP;
    }

    // Top-finish / relegation
    const topFinishPatterns = [
      /\btop\s*\d+\b/,
      /\bfinish (in|inside)\b/,
      /\bqualify for\b.*\b(champions|europa)\b/,
    ];
    if (topFinishPatterns.some((p) => p.test(text))) {
      return MarketType.TOP_FINISH;
    }

    const relegationPatterns = [
      /\brelegat(ed|ion)\b/,
      /\bavoid relegation\b/,
      /\bdrop down\b/,
    ];
    if (relegationPatterns.some((p) => p.test(text))) {
      return MarketType.RELEGATION;
    }

    // Tournament winner
    const tournamentPatterns = [
      /\bworld cup\b/,
      /\beuro\s*\d+\b/,
      /\bcopa america\b/,
      /\bnations league\b/,
      /\bchampions league\b.*\bwin/,
      /\bwin\b.*\bchampions league\b/,
      /\bwin\b.*\beuropa league\b/,
    ];
    if (tournamentPatterns.some((p) => p.test(text))) {
      return MarketType.TOURNAMENT;
    }

    // League winner
    const leagueWinnerPatterns = [
      /\bwin\b.*\b(league|premier league|la liga|serie a|bundesliga|ligue 1)\b/,
      /\b(league|premier league|la liga|serie a|bundesliga|ligue 1)\b.*\bwin/,
      /\bchampion(s)?\b.*\b(league title|premier league|la liga|serie a|bundesliga|ligue 1)\b/,
      /\btitle\b/,
    ];
    if (leagueWinnerPatterns.some((p) => p.test(text))) {
      return MarketType.LEAGUE_WINNER;
    }

    return MarketType.OTHER;
  }

  // ─── Private: Upsert Helpers ────────────────────────────────────────────────

  private async upsertEvent(event: any): Promise<void> {
    await this.db
      .insert(polymarketEvents)
      .values({
        id: event.id,
        slug: event.slug || `event-${event.id}`,
        title: event.title || '',
        description: event.description || null,
        startDate: event.startDate ? new Date(event.startDate) : null,
        endDate: event.endDate ? new Date(event.endDate) : null,
        active: event.active ?? true,
        closed: event.closed ?? false,
        liquidity: event.liquidity?.toString() ?? null,
        volume: event.volume?.toString() ?? null,
        volume24hr: event.volume24hr?.toString() ?? null,
        tags: event.tags ?? null,
        rawData: event,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: polymarketEvents.id,
        set: {
          title: event.title || '',
          description: event.description || null,
          startDate: event.startDate ? new Date(event.startDate) : null,
          endDate: event.endDate ? new Date(event.endDate) : null,
          active: event.active ?? true,
          closed: event.closed ?? false,
          liquidity: event.liquidity?.toString() ?? null,
          volume: event.volume?.toString() ?? null,
          volume24hr: event.volume24hr?.toString() ?? null,
          tags: event.tags ?? null,
          rawData: event,
          updatedAt: new Date(),
        },
      });
  }

  private async upsertMarket(event: any, market: any): Promise<void> {
    const marketType = this.classifyMarketType(
      market.question || event.title || '',
      event.description || '',
    );

    const outcomes = this.safeParseJson(market.outcomes) ?? ['Yes', 'No'];
    const outcomePrices = this.safeParseJson(market.outcomePrices) ?? [
      '0',
      '0',
    ];
    const clobTokenIds = this.safeParseJson(market.clobTokenIds) ?? [];

    await this.db
      .insert(polymarketMarkets)
      .values({
        id: market.id,
        eventId: event.id,
        question: market.question || event.title || '',
        conditionId: market.conditionId || null,
        questionId: market.questionId || null,
        slug: market.slug || null,
        outcomes,
        outcomePrices,
        clobTokenIds,
        volume: market.volume?.toString() ?? null,
        volume24hr: market.volume24hr?.toString() ?? null,
        liquidity: market.liquidity?.toString() ?? null,
        spread: null,
        active: market.active ?? true,
        closed: market.closed ?? false,
        marketType,
        rawData: market,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: polymarketMarkets.id,
        set: {
          question: market.question || event.title || '',
          conditionId: market.conditionId || null,
          outcomes,
          outcomePrices,
          clobTokenIds,
          volume: market.volume?.toString() ?? null,
          volume24hr: market.volume24hr?.toString() ?? null,
          liquidity: market.liquidity?.toString() ?? null,
          active: market.active ?? true,
          closed: market.closed ?? false,
          marketType,
          rawData: market,
          updatedAt: new Date(),
        },
      });
  }

  // ─── Private: API Fetching ──────────────────────────────────────────────────

  private async fetchEventsByTag(tag: string, limit = 100): Promise<any[]> {
    const allEvents: any[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.gammaApi.get('/events', {
        params: {
          tag,
          active: true,
          closed: false,
          limit,
          offset,
        },
      });

      const events = response.data;
      if (!Array.isArray(events) || events.length === 0) {
        hasMore = false;
        break;
      }

      allEvents.push(...events);

      if (events.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    this.logger.debug(`Fetched ${allEvents.length} events for tag "${tag}"`);

    return allEvents;
  }

  // ─── Private: Price Utilities ───────────────────────────────────────────────

  /**
   * Extract midpoint price from CLOB /prices response entry.
   * Returns null if data is missing or unparseable.
   */
  private midpointFromPriceData(
    data: { buy?: string; sell?: string } | undefined,
  ): number | null {
    if (!data) return null;

    const buy = parseFloat(data.buy);
    const sell = parseFloat(data.sell);

    if (!isNaN(buy) && !isNaN(sell)) return (buy + sell) / 2;
    if (!isNaN(buy)) return buy;
    if (!isNaN(sell)) return sell;

    return null;
  }

  /**
   * Calculate spread from CLOB price data.
   */
  private spreadFromPriceData(
    data: { buy?: string; sell?: string } | undefined,
  ): number | null {
    if (!data) return null;

    const buy = parseFloat(data.buy);
    const sell = parseFloat(data.sell);

    if (!isNaN(buy) && !isNaN(sell)) return Math.abs(buy - sell);

    return null;
  }

  /**
   * Safely parse a value that may be a JSON string or already parsed.
   * The Gamma API returns outcomes/outcomePrices/clobTokenIds as JSON strings.
   */
  private safeParseJson(value: any): any {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value) || typeof value === 'object') return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
}
