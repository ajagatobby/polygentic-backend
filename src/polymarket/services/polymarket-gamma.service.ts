import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * Raw event shape returned by Polymarket Gamma API.
 */
export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  archived: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  tags: Array<{ id: string; slug: string; label: string }>;
  markets: GammaMarket[];
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  questionId: string;
  slug: string;
  outcomes: string; // JSON string: '["Yes","No"]'
  outcomePrices: string; // JSON string: '["0.35","0.65"]'
  clobTokenIds: string; // JSON string: '["token_yes","token_no"]'
  volume: number;
  volume24hr: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  // /markets endpoint returns these as top-level fields
  groupItemTitle?: string;
  events?: GammaEvent[];
}

/**
 * Parsed market with deserialized JSON fields.
 */
export interface ParsedPolymarketEvent {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  tags: Array<{ id: string; slug: string; label: string }>;
  markets: ParsedMarket[];
}

export interface ParsedMarket {
  marketId: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  volume: number;
  volume24hr: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
}

/**
 * PolymarketGammaService
 *
 * Client for Polymarket's Gamma API — market/event discovery.
 * No authentication required.
 *
 * NOTE: The Gamma API's `tag` parameter on /events is broken — it returns
 * generic events regardless of tag value. We instead paginate through the
 * /markets endpoint and filter client-side using soccer keywords in the
 * question, slug, and groupItemTitle fields.
 */
@Injectable()
export class PolymarketGammaService {
  private readonly logger = new Logger(PolymarketGammaService.name);
  private readonly client: AxiosInstance;

  /**
   * Soccer keywords used for client-side filtering.
   * Covers leagues, competitions, teams, and generic terms.
   */
  private static readonly SOCCER_KEYWORDS = [
    // Competitions / leagues
    'premier league',
    'champions league',
    'europa league',
    'la liga',
    'serie a',
    'bundesliga',
    'ligue 1',
    'world cup',
    'euro 2026',
    'euro 2028',
    'copa america',
    'copa libertadores',
    'conference league',
    'fa cup',
    'carabao cup',
    'copa del rey',
    'dfb-pokal',
    'coppa italia',
    'coupe de france',
    'mls',
    'liga mx',
    'eredivisie',
    'primeira liga',
    'scottish premiership',
    'super lig',
    // Generic soccer terms
    'soccer',
    'football club',
    // Note: We intentionally do NOT include bare club names here (e.g. "chelsea",
    // "arsenal") as they cause false positives ("Chelsea Clinton" etc.).
    // Club names are handled by the matcher service when classifying events.
  ];

  /**
   * Patterns that exclude false positives — markets that mention
   * soccer-sounding words but aren't actually soccer.
   */
  private static readonly EXCLUSION_PATTERNS = [
    /\bamerican football\b/i,
    /\bnfl\b/i,
    /\bsuper bowl\b/i,
    /\bfootball.*nfl/i,
    /\bnfl.*football/i,
    /\bpresidential\b/i,
    /\bdemocratic\b/i,
    /\brepublican\b/i,
    /\belection\b/i,
    /\bnomination\b/i,
  ];

  constructor(private readonly config: ConfigService) {
    const baseURL =
      this.config.get<string>('POLYMARKET_GAMMA_URL') ||
      'https://gamma-api.polymarket.com';

    this.client = axios.create({
      baseURL,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Fetch all active soccer events from Polymarket.
   *
   * Strategy: Paginate through /markets (limit=100), filter client-side
   * by soccer keywords, group markets into events by their parent event.
   */
  async fetchSoccerEvents(): Promise<ParsedPolymarketEvent[]> {
    const eventMap = new Map<string, ParsedPolymarketEvent>();
    let offset = 0;
    const limit = 100;
    const maxPages = 20; // Safety cap: 2000 markets max
    let pagesScanned = 0;
    let totalMarketsScanned = 0;

    this.logger.log(
      'Scanning Polymarket /markets endpoint for soccer markets (client-side filter)',
    );

    while (pagesScanned < maxPages) {
      try {
        const response = await this.client.get('/markets', {
          params: {
            active: true,
            closed: false,
            limit,
            offset,
          },
        });

        const rawMarkets: GammaMarket[] = response.data ?? [];
        if (rawMarkets.length === 0) break;

        totalMarketsScanned += rawMarkets.length;

        for (const raw of rawMarkets) {
          if (!this.isSoccerMarket(raw)) continue;

          // Markets from /markets may have nested events[] or be standalone
          const parentEvent = raw.events?.[0];
          const eventId = parentEvent?.id ?? raw.id;

          if (!eventMap.has(eventId)) {
            // Build event from parent if available, or synthesize from market
            eventMap.set(eventId, this.buildEventFromMarket(raw, parentEvent));
          } else {
            // Add this market to the existing event
            const existing = eventMap.get(eventId)!;
            const parsed = this.parseMarket(raw);
            if (
              parsed &&
              !existing.markets.find((m) => m.marketId === parsed.marketId)
            ) {
              existing.markets.push(parsed);
              // Update event-level stats (coerce to number — API may return strings)
              existing.liquidity += Number(raw.liquidity ?? 0) || 0;
              existing.volume += Number(raw.volume ?? 0) || 0;
              existing.volume24hr += Number(raw.volume24hr ?? 0) || 0;
            }
          }
        }

        offset += limit;
        pagesScanned++;

        // If we got fewer than limit, we've reached the end
        if (rawMarkets.length < limit) break;
      } catch (error) {
        this.logger.warn(
          `Failed to fetch markets page at offset ${offset}: ${error.message}`,
        );
        break;
      }
    }

    const events = [...eventMap.values()];
    this.logger.log(
      `Scanned ${totalMarketsScanned} markets across ${pagesScanned} pages → ` +
        `found ${events.length} soccer events with ${events.reduce((sum, e) => sum + e.markets.length, 0)} markets`,
    );

    return events;
  }

  /**
   * Fetch a single event by ID.
   */
  async fetchEventById(eventId: string): Promise<ParsedPolymarketEvent | null> {
    try {
      const response = await this.client.get(`/events/${eventId}`);
      if (!response.data) return null;
      return this.parseEvent(response.data);
    } catch (error) {
      this.logger.warn(`Failed to fetch event ${eventId}: ${error.message}`);
      return null;
    }
  }

  // ─── Client-side soccer filtering ───────────────────────────────────

  /**
   * Determine if a raw market from /markets is soccer-related by
   * checking question, slug, groupItemTitle, and parent event title
   * against our keyword list.
   */
  private isSoccerMarket(raw: GammaMarket): boolean {
    // Skip inactive or closed
    if (!raw.active || raw.closed) return false;

    const searchText = [
      raw.question ?? '',
      raw.slug ?? '',
      raw.groupItemTitle ?? '',
      ...(raw.events ?? []).map((e) => `${e.title ?? ''} ${e.slug ?? ''}`),
    ]
      .join(' ')
      .toLowerCase();

    // Check exclusions first
    for (const pattern of PolymarketGammaService.EXCLUSION_PATTERNS) {
      if (pattern.test(searchText)) return false;
    }

    // Check if any soccer keyword appears in the text
    for (const keyword of PolymarketGammaService.SOCCER_KEYWORDS) {
      if (searchText.includes(keyword.toLowerCase())) return true;
    }

    return false;
  }

  // ─── Parsing helpers ────────────────────────────────────────────────

  /**
   * Build a ParsedPolymarketEvent from a /markets response item.
   * /markets returns individual markets, optionally with parent events[].
   */
  private buildEventFromMarket(
    raw: GammaMarket,
    parentEvent?: GammaEvent,
  ): ParsedPolymarketEvent {
    const parsed = this.parseMarket(raw);

    if (parentEvent) {
      return {
        eventId: parentEvent.id,
        slug: parentEvent.slug,
        title: parentEvent.title,
        description: parentEvent.description ?? '',
        startDate: parentEvent.startDate,
        endDate: parentEvent.endDate,
        active: parentEvent.active,
        closed: parentEvent.closed,
        liquidity: Number(parentEvent.liquidity ?? raw.liquidity ?? 0) || 0,
        volume: Number(parentEvent.volume ?? raw.volume ?? 0) || 0,
        volume24hr: Number(parentEvent.volume24hr ?? raw.volume24hr ?? 0) || 0,
        tags: parentEvent.tags ?? [],
        markets: parsed ? [parsed] : [],
      };
    }

    // No parent event — synthesize from the market itself
    return {
      eventId: raw.id,
      slug: raw.slug ?? '',
      title: raw.question ?? '',
      description: '',
      startDate: null,
      endDate: null,
      active: raw.active,
      closed: raw.closed,
      liquidity: Number(raw.liquidity ?? 0) || 0,
      volume: Number(raw.volume ?? 0) || 0,
      volume24hr: Number(raw.volume24hr ?? 0) || 0,
      tags: [],
      markets: parsed ? [parsed] : [],
    };
  }

  private parseEvent(raw: GammaEvent): ParsedPolymarketEvent {
    return {
      eventId: raw.id,
      slug: raw.slug,
      title: raw.title,
      description: raw.description ?? '',
      startDate: raw.startDate,
      endDate: raw.endDate,
      active: raw.active,
      closed: raw.closed,
      liquidity: Number(raw.liquidity ?? 0) || 0,
      volume: Number(raw.volume ?? 0) || 0,
      volume24hr: Number(raw.volume24hr ?? 0) || 0,
      tags: raw.tags ?? [],
      markets: (raw.markets ?? [])
        .filter((m) => m.active && !m.closed)
        .map((m) => this.parseMarket(m))
        .filter((m): m is ParsedMarket => m !== null),
    };
  }

  private parseMarket(raw: GammaMarket): ParsedMarket | null {
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    let clobTokenIds: string[] = [];

    try {
      outcomes =
        typeof raw.outcomes === 'string'
          ? JSON.parse(raw.outcomes || '[]')
          : (raw.outcomes ?? []);
    } catch {
      outcomes = [];
    }

    try {
      outcomePrices = (
        typeof raw.outcomePrices === 'string'
          ? JSON.parse(raw.outcomePrices || '[]')
          : (raw.outcomePrices ?? [])
      ).map(Number);
    } catch {
      outcomePrices = [];
    }

    try {
      clobTokenIds =
        typeof raw.clobTokenIds === 'string'
          ? JSON.parse(raw.clobTokenIds || '[]')
          : (raw.clobTokenIds ?? []);
    } catch {
      clobTokenIds = [];
    }

    // Skip markets with no token IDs
    if (clobTokenIds.length === 0) return null;

    return {
      marketId: raw.id,
      question: raw.question ?? raw.groupItemTitle ?? '',
      conditionId: raw.conditionId,
      slug: raw.slug ?? '',
      outcomes,
      outcomePrices,
      clobTokenIds,
      volume: Number(raw.volume ?? 0) || 0,
      volume24hr: Number(raw.volume24hr ?? 0) || 0,
      liquidity: Number(raw.liquidity ?? 0) || 0,
      active: raw.active,
      closed: raw.closed,
      acceptingOrders: raw.acceptingOrders ?? false,
    };
  }
}
