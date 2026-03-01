import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { eq, and, desc } from 'drizzle-orm';
import { bookmakerOdds, consensusOdds } from '../database/schema';
import { ProbabilityUtil } from './probability.util';

/**
 * All tracked soccer leagues on The Odds API.
 */
export const SOCCER_SPORT_KEYS = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_germany_bundesliga',
  'soccer_italy_serie_a',
  'soccer_france_ligue_one',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_usa_mls',
  'soccer_brazil_campeonato',
  'soccer_netherlands_eredivisie',
] as const;

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

interface CreditUsage {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
}

@Injectable()
export class OddsService {
  private readonly logger = new Logger(OddsService.name);
  private readonly api: AxiosInstance;
  private readonly apiKey: string;
  private readonly regions: string;
  private creditUsage: CreditUsage = {
    remaining: null,
    used: null,
    lastCost: null,
  };

  constructor(
    private readonly configService: ConfigService,
    @Inject('DRIZZLE') private db: any,
  ) {
    this.apiKey = this.configService.get<string>('ODDS_API_KEY', '');
    this.regions = this.configService.get<string>('ODDS_API_REGIONS', 'uk,eu');

    const baseURL = this.configService.get<string>(
      'ODDS_API_BASE_URL',
      'https://api.the-odds-api.com',
    );

    this.api = axios.create({
      baseURL,
      timeout: 30_000,
      headers: { Accept: 'application/json' },
    });
  }

  // ─── Public Methods ──────────────────────────────────────────────────

  /**
   * Fetch and store odds for the given sport keys.
   * For each event returned, store individual bookmaker odds and
   * then compute the weighted consensus.
   */
  async syncOdds(
    sportKeys: string[],
  ): Promise<{
    eventsProcessed: number;
    oddsRecordsInserted: number;
    consensusCalculated: number;
    creditsUsed: number | null;
    creditsRemaining: number | null;
    errors: string[];
  }> {
    this.logger.log(
      `Syncing odds for ${sportKeys.length} sport key(s): ${sportKeys.join(', ')}`,
    );

    let eventsProcessed = 0;
    let oddsRecordsInserted = 0;
    let consensusCalculated = 0;
    const errors: string[] = [];

    for (const sportKey of sportKeys) {
      try {
        const events = await this.fetchOddsForSport(sportKey);

        for (const event of events) {
          try {
            const inserted = await this.storeBookmakerOdds(event);
            oddsRecordsInserted += inserted;
            eventsProcessed++;

            // Calculate consensus for h2h market
            try {
              await this.calculateConsensus(event.id);
              consensusCalculated++;
            } catch (err) {
              const msg = `Failed to calculate consensus for event ${event.id}: ${err.message}`;
              this.logger.warn(msg);
              errors.push(msg);
            }
          } catch (err) {
            const msg = `Failed to store odds for event ${event.id}: ${err.message}`;
            this.logger.warn(msg);
            errors.push(msg);
          }
        }
      } catch (err) {
        const msg = `Failed to fetch odds for sport "${sportKey}": ${err.message}`;
        this.logger.error(msg);
        errors.push(msg);
      }
    }

    this.logger.log(
      `Odds sync complete: ${eventsProcessed} events, ${oddsRecordsInserted} odds records, ${consensusCalculated} consensus calculated`,
    );

    return {
      eventsProcessed,
      oddsRecordsInserted,
      consensusCalculated,
      creditsUsed: this.creditUsage.used,
      creditsRemaining: this.creditUsage.remaining,
      errors: errors.length > 0 ? errors : [],
    };
  }

  /**
   * Calculate the weighted consensus probability for all markets
   * of a given Odds API event from stored bookmaker odds.
   */
  async calculateConsensus(oddsApiEventId: string): Promise<void> {
    // Fetch all stored bookmaker odds for this event
    const storedOdds = await this.db
      .select()
      .from(bookmakerOdds)
      .where(eq(bookmakerOdds.oddsApiEventId, oddsApiEventId))
      .orderBy(desc(bookmakerOdds.recordedAt));

    if (storedOdds.length === 0) {
      this.logger.debug(
        `No bookmaker odds found for event ${oddsApiEventId}`,
      );
      return;
    }

    // Group by market key; for each event we may have h2h, totals, spreads
    const byMarket = new Map<string, typeof storedOdds>();

    for (const row of storedOdds) {
      // Keep only the most recent entry per bookmaker per market
      const key = row.marketKey as string;
      if (!byMarket.has(key)) byMarket.set(key, []);
      byMarket.get(key)!.push(row);
    }

    // Take event metadata from the first row
    const firstRow = storedOdds[0];

    for (const [marketKey, odds] of byMarket) {
      // Deduplicate: keep only the most recent per bookmaker
      const latestByBookmaker = new Map<string, (typeof odds)[0]>();
      for (const row of odds) {
        const bk = row.bookmakerKey as string;
        if (
          !latestByBookmaker.has(bk) ||
          new Date(row.recordedAt) >
            new Date(latestByBookmaker.get(bk)!.recordedAt)
        ) {
          latestByBookmaker.set(bk, row);
        }
      }

      const uniqueOdds = Array.from(latestByBookmaker.values());

      if (marketKey === 'h2h') {
        await this.calculateH2HConsensus(
          oddsApiEventId,
          firstRow,
          marketKey,
          uniqueOdds,
        );
      } else if (marketKey === 'totals') {
        await this.calculateTotalsConsensus(
          oddsApiEventId,
          firstRow,
          marketKey,
          uniqueOdds,
        );
      }
    }
  }

  /**
   * Sync odds for all tracked soccer leagues.
   */
  async syncAllSoccerOdds() {
    return this.syncOdds([...SOCCER_SPORT_KEYS]);
  }

  /**
   * Get all stored bookmaker odds for a given Odds API event ID.
   */
  async getOddsForEvent(eventId: string) {
    const odds = await this.db
      .select()
      .from(bookmakerOdds)
      .where(eq(bookmakerOdds.oddsApiEventId, eventId))
      .orderBy(desc(bookmakerOdds.recordedAt));

    return odds;
  }

  /**
   * Get the latest consensus odds for a given Odds API event ID.
   */
  async getConsensusForEvent(eventId: string) {
    const consensus = await this.db
      .select()
      .from(consensusOdds)
      .where(eq(consensusOdds.oddsApiEventId, eventId))
      .orderBy(desc(consensusOdds.calculatedAt));

    return consensus;
  }

  /**
   * Return the current credit usage from the last API response.
   */
  getCreditUsage(): CreditUsage {
    return { ...this.creditUsage };
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  /**
   * Make a GET request to The Odds API with the apiKey query parameter.
   * Tracks credit usage from response headers.
   */
  private async apiRequest<T = any>(
    endpoint: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<AxiosResponse<T>> {
    const pauseThreshold = this.configService.get<number>(
      'ODDS_API_CREDIT_PAUSE_THRESHOLD',
      0.1,
    );
    const monthlyLimit = this.configService.get<number>(
      'ODDS_API_MONTHLY_CREDIT_LIMIT',
      20000,
    );

    // Check if we should pause due to low credits
    if (
      this.creditUsage.remaining !== null &&
      this.creditUsage.remaining < monthlyLimit * pauseThreshold
    ) {
      throw new Error(
        `Odds API credit pause: only ${this.creditUsage.remaining} credits remaining ` +
          `(threshold: ${Math.round(monthlyLimit * pauseThreshold)})`,
      );
    }

    const response = await this.api.get<T>(endpoint, {
      params: {
        apiKey: this.apiKey,
        ...params,
      },
    });

    // Track credit usage from response headers
    const remaining = response.headers['x-requests-remaining'];
    const used = response.headers['x-requests-used'];
    const lastCost = response.headers['x-requests-last'];

    this.creditUsage = {
      remaining: remaining != null ? parseInt(remaining, 10) : this.creditUsage.remaining,
      used: used != null ? parseInt(used, 10) : this.creditUsage.used,
      lastCost: lastCost != null ? parseInt(lastCost, 10) : this.creditUsage.lastCost,
    };

    this.logger.debug(
      `Odds API credits — remaining: ${this.creditUsage.remaining}, used: ${this.creditUsage.used}, last request cost: ${this.creditUsage.lastCost}`,
    );

    return response;
  }

  /**
   * Fetch odds for a specific sport key from The Odds API.
   */
  private async fetchOddsForSport(sportKey: string): Promise<OddsApiEvent[]> {
    const response = await this.apiRequest<OddsApiEvent[]>(
      `/v4/sports/${sportKey}/odds/`,
      {
        regions: this.regions,
        markets: 'h2h,totals',
        oddsFormat: 'decimal',
      },
    );

    this.logger.debug(
      `Fetched ${response.data.length} events for ${sportKey}`,
    );

    return response.data;
  }

  /**
   * Store all bookmaker odds from an Odds API event response.
   */
  private async storeBookmakerOdds(event: OddsApiEvent): Promise<number> {
    let inserted = 0;

    for (const bookmaker of event.bookmakers) {
      for (const market of bookmaker.markets) {
        const outcomes = market.outcomes.map((o) => ({
          name: o.name,
          price: o.price,
          ...(o.point !== undefined ? { point: o.point } : {}),
        }));

        // Calculate implied and true probabilities
        const impliedProbs = outcomes.map((o) =>
          ProbabilityUtil.decimalToImplied(o.price),
        );
        const trueProbs = ProbabilityUtil.removeVig(impliedProbs);
        const overround = ProbabilityUtil.calculateOverround(impliedProbs);

        const impliedProbabilities = outcomes.map((o, i) => ({
          name: o.name,
          implied: impliedProbs[i],
        }));
        const trueProbabilities = outcomes.map((o, i) => ({
          name: o.name,
          true: trueProbs[i],
        }));

        await this.db.insert(bookmakerOdds).values({
          oddsApiEventId: event.id,
          sportKey: event.sport_key,
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          commenceTime: new Date(event.commence_time),
          bookmakerKey: bookmaker.key,
          bookmakerName: bookmaker.title,
          marketKey: market.key,
          outcomes,
          impliedProbabilities,
          trueProbabilities,
          overround: overround.toFixed(4),
          lastUpdate: market.last_update
            ? new Date(market.last_update)
            : null,
          recordedAt: new Date(),
        });

        inserted++;
      }
    }

    return inserted;
  }

  /**
   * Calculate weighted consensus for h2h (3-way) market.
   */
  private async calculateH2HConsensus(
    oddsApiEventId: string,
    meta: any,
    marketKey: string,
    bookmakerRows: any[],
  ): Promise<void> {
    const homeProbs: Array<{ bookmaker: string; probability: number }> = [];
    const drawProbs: Array<{ bookmaker: string; probability: number }> = [];
    const awayProbs: Array<{ bookmaker: string; probability: number }> = [];

    let pinnacleHome: number | null = null;
    let pinnacleDraw: number | null = null;
    let pinnacleAway: number | null = null;

    for (const row of bookmakerRows) {
      const trueProbsArr = row.trueProbabilities as Array<{
        name: string;
        true: number;
      }>;
      if (!Array.isArray(trueProbsArr)) continue;

      const homeEntry = trueProbsArr.find(
        (p) => p.name === meta.homeTeam,
      );
      const drawEntry = trueProbsArr.find(
        (p) => p.name === 'Draw',
      );
      const awayEntry = trueProbsArr.find(
        (p) => p.name === meta.awayTeam,
      );

      if (homeEntry) {
        homeProbs.push({
          bookmaker: row.bookmakerKey,
          probability: homeEntry.true,
        });
      }
      if (drawEntry) {
        drawProbs.push({
          bookmaker: row.bookmakerKey,
          probability: drawEntry.true,
        });
      }
      if (awayEntry) {
        awayProbs.push({
          bookmaker: row.bookmakerKey,
          probability: awayEntry.true,
        });
      }

      // Track Pinnacle specifically
      if (row.bookmakerKey === 'pinnacle') {
        pinnacleHome = homeEntry?.true ?? null;
        pinnacleDraw = drawEntry?.true ?? null;
        pinnacleAway = awayEntry?.true ?? null;
      }
    }

    const consensusHome =
      ProbabilityUtil.calculateWeightedConsensus(homeProbs);
    const consensusDraw =
      ProbabilityUtil.calculateWeightedConsensus(drawProbs);
    const consensusAway =
      ProbabilityUtil.calculateWeightedConsensus(awayProbs);

    await this.db.insert(consensusOdds).values({
      oddsApiEventId,
      sportKey: meta.sportKey,
      homeTeam: meta.homeTeam,
      awayTeam: meta.awayTeam,
      commenceTime: new Date(meta.commenceTime),
      marketKey,
      consensusHomeWin: consensusHome.toFixed(4),
      consensusDraw: consensusDraw.toFixed(4),
      consensusAwayWin: consensusAway.toFixed(4),
      pinnacleHomeWin: pinnacleHome?.toFixed(4) ?? null,
      pinnacleDraw: pinnacleDraw?.toFixed(4) ?? null,
      pinnacleAwayWin: pinnacleAway?.toFixed(4) ?? null,
      numBookmakers: bookmakerRows.length,
      calculatedAt: new Date(),
    });
  }

  /**
   * Calculate weighted consensus for totals (over/under) market.
   */
  private async calculateTotalsConsensus(
    oddsApiEventId: string,
    meta: any,
    marketKey: string,
    bookmakerRows: any[],
  ): Promise<void> {
    const overProbs: Array<{ bookmaker: string; probability: number }> = [];
    const underProbs: Array<{ bookmaker: string; probability: number }> = [];
    let consensusPoint: number | null = null;

    for (const row of bookmakerRows) {
      const trueProbsArr = row.trueProbabilities as Array<{
        name: string;
        true: number;
      }>;
      if (!Array.isArray(trueProbsArr)) continue;

      const overEntry = trueProbsArr.find((p) => p.name === 'Over');
      const underEntry = trueProbsArr.find((p) => p.name === 'Under');

      if (overEntry) {
        overProbs.push({
          bookmaker: row.bookmakerKey,
          probability: overEntry.true,
        });
      }
      if (underEntry) {
        underProbs.push({
          bookmaker: row.bookmakerKey,
          probability: underEntry.true,
        });
      }

      // Extract the point (e.g. 2.5) from outcomes
      const outcomes = row.outcomes as Array<{
        name: string;
        price: number;
        point?: number;
      }>;
      if (Array.isArray(outcomes) && consensusPoint === null) {
        const overOutcome = outcomes.find((o) => o.name === 'Over');
        if (overOutcome?.point !== undefined) {
          consensusPoint = overOutcome.point;
        }
      }
    }

    const consensusOver =
      ProbabilityUtil.calculateWeightedConsensus(overProbs);
    const consensusUnder =
      ProbabilityUtil.calculateWeightedConsensus(underProbs);

    await this.db.insert(consensusOdds).values({
      oddsApiEventId,
      sportKey: meta.sportKey,
      homeTeam: meta.homeTeam,
      awayTeam: meta.awayTeam,
      commenceTime: new Date(meta.commenceTime),
      marketKey,
      consensusOver: consensusOver.toFixed(4),
      consensusUnder: consensusUnder.toFixed(4),
      consensusPoint: consensusPoint?.toFixed(2) ?? null,
      numBookmakers: bookmakerRows.length,
      calculatedAt: new Date(),
    });
  }
}
