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
 */
@Injectable()
export class PolymarketGammaService {
  private readonly logger = new Logger(PolymarketGammaService.name);
  private readonly client: AxiosInstance;

  // Tags to search for soccer markets
  private static readonly SOCCER_TAGS = [
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
  ];

  // Keywords for search fallback
  private static readonly SOCCER_KEYWORDS = [
    'premier league',
    'champions league',
    'la liga',
    'serie a',
    'bundesliga',
    'world cup',
    'europa league',
    'soccer',
    'football match',
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
   * Searches multiple tags and deduplicates by event ID.
   */
  async fetchSoccerEvents(): Promise<ParsedPolymarketEvent[]> {
    const eventMap = new Map<string, ParsedPolymarketEvent>();

    // Search by tags in parallel
    const tagResults = await Promise.allSettled(
      PolymarketGammaService.SOCCER_TAGS.map((tag) =>
        this.fetchEventsByTag(tag),
      ),
    );

    for (const result of tagResults) {
      if (result.status === 'fulfilled') {
        for (const event of result.value) {
          if (!eventMap.has(event.eventId)) {
            eventMap.set(event.eventId, event);
          }
        }
      }
    }

    // Also do keyword searches for broader coverage
    const keywordResults = await Promise.allSettled(
      PolymarketGammaService.SOCCER_KEYWORDS.slice(0, 4).map((kw) =>
        this.searchEvents(kw),
      ),
    );

    for (const result of keywordResults) {
      if (result.status === 'fulfilled') {
        for (const event of result.value) {
          if (!eventMap.has(event.eventId)) {
            eventMap.set(event.eventId, event);
          }
        }
      }
    }

    const events = [...eventMap.values()];
    this.logger.log(
      `Fetched ${events.length} unique soccer events from Polymarket`,
    );

    return events;
  }

  /**
   * Fetch events by a specific tag.
   */
  async fetchEventsByTag(tag: string): Promise<ParsedPolymarketEvent[]> {
    try {
      const allEvents: ParsedPolymarketEvent[] = [];
      let offset = 0;
      const limit = 100;

      // Paginate through results
      while (true) {
        const response = await this.client.get('/events', {
          params: {
            tag,
            active: true,
            closed: false,
            limit,
            offset,
          },
        });

        const rawEvents: GammaEvent[] = response.data ?? [];
        if (rawEvents.length === 0) break;

        const parsed = rawEvents
          .map((e) => this.parseEvent(e))
          .filter((e) => e.markets.length > 0);

        allEvents.push(...parsed);
        offset += limit;

        // Safety: max 5 pages
        if (offset >= 500) break;
      }

      return allEvents;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch events for tag "${tag}": ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Search events by keyword.
   */
  async searchEvents(query: string): Promise<ParsedPolymarketEvent[]> {
    try {
      const response = await this.client.get('/public-search', {
        params: { query, limit: 20 },
      });

      const rawEvents: GammaEvent[] = response.data ?? [];
      return rawEvents
        .map((e) => this.parseEvent(e))
        .filter((e) => e.markets.length > 0);
    } catch (error) {
      this.logger.warn(
        `Failed to search events for "${query}": ${error.message}`,
      );
      return [];
    }
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

  // ─── Private helpers ────────────────────────────────────────────────

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
      liquidity: raw.liquidity ?? 0,
      volume: raw.volume ?? 0,
      volume24hr: raw.volume24hr ?? 0,
      tags: raw.tags ?? [],
      markets: (raw.markets ?? [])
        .filter((m) => m.active && !m.closed)
        .map((m) => this.parseMarket(m)),
    };
  }

  private parseMarket(raw: GammaMarket): ParsedMarket {
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    let clobTokenIds: string[] = [];

    try {
      outcomes = JSON.parse(raw.outcomes || '[]');
    } catch {
      outcomes = [];
    }

    try {
      outcomePrices = JSON.parse(raw.outcomePrices || '[]').map(Number);
    } catch {
      outcomePrices = [];
    }

    try {
      clobTokenIds = JSON.parse(raw.clobTokenIds || '[]');
    } catch {
      clobTokenIds = [];
    }

    return {
      marketId: raw.id,
      question: raw.question,
      conditionId: raw.conditionId,
      slug: raw.slug,
      outcomes,
      outcomePrices,
      clobTokenIds,
      volume: raw.volume ?? 0,
      volume24hr: raw.volume24hr ?? 0,
      liquidity: raw.liquidity ?? 0,
      active: raw.active,
      closed: raw.closed,
      acceptingOrders: raw.acceptingOrders ?? false,
    };
  }
}
