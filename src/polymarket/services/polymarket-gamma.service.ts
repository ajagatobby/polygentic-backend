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
  /** Sports-specific fields present on soccer match events */
  seriesSlug?: string;
  negRisk?: boolean;
  eventDate?: string;
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
  /** Sports-specific fields */
  sportsMarketType?: string; // e.g. "moneyline", "spread", "total"
  gameStartTime?: string; // e.g. "2026-03-06 20:00:00+00"
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
  /** The Polymarket tag_slug used to discover this event (e.g. "la-liga") */
  polymarketTagSlug?: string;
  /** Sports-specific metadata */
  seriesSlug?: string;
  negRisk?: boolean;
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
  /** Sports-specific market type (moneyline, spread, total) */
  sportsMarketType?: string;
  /** Game start time for sports match markets */
  gameStartTime?: string;
}

// ─── Polymarket Soccer Tag Slugs ──────────────────────────────────────
// These are the tag_slug values that work with GET /events?tag_slug=<slug>
// to fetch soccer events for specific leagues from the Gamma API.

export interface PolymarketLeagueTag {
  tagSlug: string;
  label: string;
  /** Internal API-Football league ID (null if no direct mapping) */
  apiFootballLeagueId: number | null;
}

/**
 * Comprehensive list of Polymarket soccer league tag slugs.
 *
 * - "soccer" tag returns outright/futures markets (World Cup winner, UCL winner, etc.)
 * - Individual league tags return match-level markets for that league
 *
 * The tag slugs come from Polymarket's sports/soccer sidebar categories.
 */
export const POLYMARKET_SOCCER_TAGS: PolymarketLeagueTag[] = [
  // ── Top-level soccer (outrights, futures) ───────────────────────
  { tagSlug: 'soccer', label: 'Soccer (Outrights)', apiFootballLeagueId: null },

  // ── European club competitions ──────────────────────────────────
  { tagSlug: 'ucl', label: 'UEFA Champions League', apiFootballLeagueId: 2 },
  { tagSlug: 'uel', label: 'UEFA Europa League', apiFootballLeagueId: 3 },
  {
    tagSlug: 'uefa-europa-conference-league',
    label: 'UEFA Europa Conference League',
    apiFootballLeagueId: 848,
  },

  // ── Top 5 European domestic leagues ─────────────────────────────
  { tagSlug: 'epl', label: 'English Premier League', apiFootballLeagueId: 39 },
  { tagSlug: 'la-liga', label: 'La Liga', apiFootballLeagueId: 140 },
  { tagSlug: 'serie-a', label: 'Serie A', apiFootballLeagueId: 135 },
  { tagSlug: 'bundesliga', label: 'Bundesliga', apiFootballLeagueId: 78 },
  { tagSlug: 'ligue-1', label: 'Ligue 1', apiFootballLeagueId: 61 },

  // ── Other European domestic leagues ─────────────────────────────
  { tagSlug: 'eredivisie', label: 'Eredivisie', apiFootballLeagueId: 88 },
  { tagSlug: 'primeira-liga', label: 'Primeira Liga', apiFootballLeagueId: 94 },
  {
    tagSlug: 'super-lig',
    label: 'Turkish Super Lig',
    apiFootballLeagueId: 203,
  },
  {
    tagSlug: 'scottish-premiership',
    label: 'Scottish Premiership',
    apiFootballLeagueId: 179,
  },
  {
    tagSlug: 'romania-superliga',
    label: 'Romania SuperLiga',
    apiFootballLeagueId: 283,
  },
  {
    tagSlug: 'czechia-fortuna-liga',
    label: 'Czechia Fortuna Liga',
    apiFootballLeagueId: 345,
  },
  {
    tagSlug: 'norway-eliteserien',
    label: 'Norway Eliteserien',
    apiFootballLeagueId: 103,
  },

  // ── Americas ────────────────────────────────────────────────────
  { tagSlug: 'mls', label: 'MLS', apiFootballLeagueId: 253 },
  { tagSlug: 'liga-mx', label: 'Liga MX', apiFootballLeagueId: 262 },
  {
    tagSlug: 'brazil-serie-a',
    label: 'Brazil Serie A',
    apiFootballLeagueId: 71,
  },
  {
    tagSlug: 'colombia-primera-a',
    label: 'Colombia Primera A',
    apiFootballLeagueId: 239,
  },
  {
    tagSlug: 'copa-libertadores',
    label: 'Copa Libertadores',
    apiFootballLeagueId: 13,
  },
  {
    tagSlug: 'copa-sudamericana',
    label: 'Copa Sudamericana',
    apiFootballLeagueId: 11,
  },
  {
    tagSlug: 'chile-primera',
    label: 'Chile Primera Division',
    apiFootballLeagueId: 265,
  },
  { tagSlug: 'peru-liga-1', label: 'Peru Liga 1', apiFootballLeagueId: 281 },

  // ── Asia / Africa / Oceania ─────────────────────────────────────
  {
    tagSlug: 'saudi-professional-league',
    label: 'Saudi Professional League',
    apiFootballLeagueId: 307,
  },
  { tagSlug: 'j-league', label: 'Japan J. League', apiFootballLeagueId: 98 },
  { tagSlug: 'j2-league', label: 'Japan J2 League', apiFootballLeagueId: 99 },
  { tagSlug: 'k-league', label: 'K-League', apiFootballLeagueId: 292 },
  { tagSlug: 'a-league', label: 'A-League', apiFootballLeagueId: 188 },
  {
    tagSlug: 'egypt-premier-league',
    label: 'Egypt Premier League',
    apiFootballLeagueId: 233,
  },
  {
    tagSlug: 'morocco-botola-pro',
    label: 'Morocco Botola Pro',
    apiFootballLeagueId: 200,
  },

  // ── International ───────────────────────────────────────────────
  {
    tagSlug: 'fifa-friendlies',
    label: 'FIFA Friendlies',
    apiFootballLeagueId: 10,
  },
  {
    tagSlug: 'europe-wc-qualifiers',
    label: 'Europe WC Qualifiers',
    apiFootballLeagueId: 32,
  },
];

/**
 * PolymarketGammaService
 *
 * Client for Polymarket's Gamma API — market/event discovery.
 * No authentication required.
 *
 * Uses `tag_slug` parameter on the /events endpoint to fetch soccer events
 * per league. This is the only reliable way to discover soccer markets —
 * the generic /markets pagination and other filter params are broken.
 */
@Injectable()
export class PolymarketGammaService {
  private readonly logger = new Logger(PolymarketGammaService.name);
  private readonly client: AxiosInstance;

  /** Delay between API calls to avoid rate limiting (ms) */
  private static readonly REQUEST_DELAY_MS = 250;

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
   * Fetch all active soccer events from Polymarket across all leagues.
   *
   * Strategy: For each known soccer league tag_slug, call
   * GET /events?tag_slug=<slug>&active=true&closed=false and collect all
   * events with their nested markets. Deduplicates across leagues since
   * some events may appear under multiple tags.
   */
  async fetchSoccerEvents(): Promise<ParsedPolymarketEvent[]> {
    const eventMap = new Map<string, ParsedPolymarketEvent>();
    let totalEventsFromApi = 0;
    let leaguesScanned = 0;
    let leaguesWithResults = 0;

    this.logger.log(
      `Scanning Polymarket /events endpoint for soccer markets across ${POLYMARKET_SOCCER_TAGS.length} league tags`,
    );

    for (const tag of POLYMARKET_SOCCER_TAGS) {
      try {
        const events = await this.fetchEventsForTag(tag);
        totalEventsFromApi += events.length;
        leaguesScanned++;

        if (events.length > 0) {
          leaguesWithResults++;
          this.logger.debug(
            `[${tag.tagSlug}] ${tag.label}: ${events.length} events, ` +
              `${events.reduce((sum, e) => sum + e.markets.length, 0)} markets`,
          );
        }

        // Deduplicate — same event may appear under multiple tags
        for (const event of events) {
          if (!eventMap.has(event.eventId)) {
            eventMap.set(event.eventId, event);
          } else {
            // Merge any new markets from this tag into the existing event
            const existing = eventMap.get(event.eventId)!;
            for (const market of event.markets) {
              if (
                !existing.markets.find((m) => m.marketId === market.marketId)
              ) {
                existing.markets.push(market);
              }
            }
          }
        }

        // Rate-limit between requests
        if (leaguesScanned < POLYMARKET_SOCCER_TAGS.length) {
          await this.delay(PolymarketGammaService.REQUEST_DELAY_MS);
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch events for tag "${tag.tagSlug}": ${error.message}`,
        );
        // Continue with other tags — don't let one failure stop the scan
      }
    }

    const events = [...eventMap.values()];
    const totalMarkets = events.reduce((sum, e) => sum + e.markets.length, 0);

    this.logger.log(
      `Scanned ${leaguesScanned} league tags (${leaguesWithResults} had results) → ` +
        `${totalEventsFromApi} raw events → ${events.length} unique events with ${totalMarkets} markets`,
    );

    return events;
  }

  /**
   * Fetch all active events for a specific tag_slug, paginating through results.
   */
  private async fetchEventsForTag(
    tag: PolymarketLeagueTag,
  ): Promise<ParsedPolymarketEvent[]> {
    const events: ParsedPolymarketEvent[] = [];
    let offset = 0;
    const limit = 100;
    const maxPages = 10; // Safety cap: 1000 events per tag
    let page = 0;

    while (page < maxPages) {
      const response = await this.client.get('/events', {
        params: {
          tag_slug: tag.tagSlug,
          active: true,
          closed: false,
          limit,
          offset,
        },
      });

      const rawEvents: GammaEvent[] = response.data ?? [];
      if (rawEvents.length === 0) break;

      for (const raw of rawEvents) {
        // Skip events with no markets
        if (!raw.markets || raw.markets.length === 0) continue;

        const parsed = this.parseEvent(raw, tag.tagSlug);
        if (parsed.markets.length > 0) {
          events.push(parsed);
        }
      }

      offset += limit;
      page++;

      // If we got fewer than limit, we've reached the end
      if (rawEvents.length < limit) break;

      // Rate-limit between pages of the same tag
      await this.delay(100);
    }

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

  /**
   * Fetch a single market by ID — including closed/resolved markets.
   * Used for trade resolution: we need to see final outcome prices ($1/$0).
   *
   * Returns raw market data without filtering out closed markets.
   */
  async fetchMarketForResolution(marketId: string): Promise<{
    closed: boolean;
    active: boolean;
    outcomePrices: number[];
    outcomes: string[];
  } | null> {
    try {
      const response = await this.client.get(`/markets/${marketId}`);
      const raw = response.data;
      if (!raw) return null;

      let outcomePrices: number[] = [];
      try {
        outcomePrices = (
          typeof raw.outcomePrices === 'string'
            ? JSON.parse(raw.outcomePrices || '[]')
            : (raw.outcomePrices ?? [])
        ).map(Number);
      } catch {
        outcomePrices = [];
      }

      let outcomes: string[] = [];
      try {
        outcomes =
          typeof raw.outcomes === 'string'
            ? JSON.parse(raw.outcomes || '[]')
            : (raw.outcomes ?? []);
      } catch {
        outcomes = [];
      }

      return {
        closed: raw.closed ?? false,
        active: raw.active ?? true,
        outcomePrices,
        outcomes,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch market ${marketId} for resolution: ${error.message}`,
      );
      return null;
    }
  }

  // ─── Parsing helpers ────────────────────────────────────────────────

  private parseEvent(raw: GammaEvent, tagSlug?: string): ParsedPolymarketEvent {
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
      polymarketTagSlug: tagSlug,
      seriesSlug: raw.seriesSlug,
      negRisk: raw.negRisk,
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
      sportsMarketType: raw.sportsMarketType,
      gameStartTime: raw.gameStartTime,
    };
  }

  // ─── Utility ────────────────────────────────────────────────────────

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
