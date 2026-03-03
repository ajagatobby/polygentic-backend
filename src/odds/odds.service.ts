import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { eq, and, desc, gte, lte, isNull, sql } from 'drizzle-orm';
import {
  bookmakerOdds,
  consensusOdds,
  fixtures,
  teams,
} from '../database/schema';
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

export interface CreditUsage {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
}

// ─── Odds comparison types ──────────────────────────────────────────

export interface BookmakerPrice {
  bookmakerKey: string;
  bookmakerName: string;
  price: number;
  impliedProbability: number;
  overround: number | null;
  lastUpdate: Date | null;
}

export interface ValueBet {
  bookmakerKey: string;
  bookmakerName: string;
  price: number;
  edgePercent: number;
  consensusProbability: number;
  impliedProbability: number;
}

export interface OutcomeComparison {
  outcome: string;
  bestPrice: {
    bookmakerKey: string;
    bookmakerName: string;
    price: number;
  } | null;
  worstPrice: {
    bookmakerKey: string;
    bookmakerName: string;
    price: number;
  } | null;
  spread: number;
  bookmakerCount: number;
  consensusProbability: number | null;
  valueBet: ValueBet | null;
  bookmakers: BookmakerPrice[];
}

export interface MarketComparison {
  marketKey: string;
  bookmakerCount: number;
  outcomes: OutcomeComparison[];
  valueBets: ValueBet[];
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
  async syncOdds(sportKeys: string[]): Promise<{
    eventsProcessed: number;
    oddsRecordsInserted: number;
    consensusCalculated: number;
    fixturesLinked: number;
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
    let fixturesLinked = 0;
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

            // Auto-match event to a fixture in our DB
            try {
              const fixtureId = await this.matchEventToFixture(event);
              if (fixtureId) fixturesLinked++;
            } catch (err) {
              // Non-critical — matching failure doesn't block sync
              this.logger.debug(
                `Failed to match event ${event.id} to fixture: ${err.message}`,
              );
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
      `Odds sync complete: ${eventsProcessed} events, ${oddsRecordsInserted} odds records, ${consensusCalculated} consensus, ${fixturesLinked} fixtures linked`,
    );

    return {
      eventsProcessed,
      oddsRecordsInserted,
      consensusCalculated,
      fixturesLinked,
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
      this.logger.debug(`No bookmaker odds found for event ${oddsApiEventId}`);
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

  /**
   * Compare odds across all bookmakers for a given event.
   * Returns the best price for each outcome in each market,
   * along with a full comparison table and value bet detection.
   */
  async getOddsComparison(oddsApiEventId: string): Promise<{
    eventId: string;
    homeTeam: string;
    awayTeam: string;
    commenceTime: Date;
    markets: Record<string, MarketComparison>;
  } | null> {
    // Get the latest odds per bookmaker per market
    const allOdds = await this.db
      .select()
      .from(bookmakerOdds)
      .where(eq(bookmakerOdds.oddsApiEventId, oddsApiEventId))
      .orderBy(desc(bookmakerOdds.recordedAt));

    if (allOdds.length === 0) return null;

    // Get the latest consensus for value bet detection
    const latestConsensus = await this.db
      .select()
      .from(consensusOdds)
      .where(eq(consensusOdds.oddsApiEventId, oddsApiEventId))
      .orderBy(desc(consensusOdds.calculatedAt));

    const consensusByMarket = new Map<string, any>();
    for (const c of latestConsensus) {
      if (!consensusByMarket.has(c.marketKey)) {
        consensusByMarket.set(c.marketKey, c);
      }
    }

    const meta = allOdds[0];

    // Deduplicate: keep only the latest row per bookmaker per market
    const byMarket = new Map<string, Map<string, any>>();
    for (const row of allOdds) {
      const mk = row.marketKey as string;
      if (!byMarket.has(mk)) byMarket.set(mk, new Map());
      const bookmakers = byMarket.get(mk)!;
      const bk = row.bookmakerKey as string;
      if (!bookmakers.has(bk)) {
        bookmakers.set(bk, row);
      }
    }

    const markets: Record<string, MarketComparison> = {};

    for (const [marketKey, bookmakerMap] of byMarket) {
      const consensus = consensusByMarket.get(marketKey);
      markets[marketKey] = this.buildMarketComparison(
        marketKey,
        bookmakerMap,
        meta.homeTeam,
        meta.awayTeam,
        consensus,
      );
    }

    return {
      eventId: oddsApiEventId,
      homeTeam: meta.homeTeam as string,
      awayTeam: meta.awayTeam as string,
      commenceTime: meta.commenceTime,
      markets,
    };
  }

  // ─── Fixture ↔ Odds API Event Linking ──────────────────────────────

  /**
   * Match an Odds API event to a fixture in our database by fuzzy-matching
   * team names and date proximity (±36 hours to handle timezone differences).
   *
   * Matching strategy:
   * 1. Load all fixtures within ±36h of the event's commence_time that don't
   *    already have an oddsApiEventId.
   * 2. For each fixture, load team names from the teams table.
   * 3. Score each fixture by how well the team names match (normalized,
   *    substring, contains). Pick the best match above a threshold.
   */
  async matchEventToFixture(event: {
    id: string;
    home_team: string;
    away_team: string;
    commence_time: string;
  }): Promise<number | null> {
    const eventDate = new Date(event.commence_time);
    const windowMs = 36 * 60 * 60 * 1000; // ±36 hours
    const from = new Date(eventDate.getTime() - windowMs);
    const to = new Date(eventDate.getTime() + windowMs);

    // Find candidate fixtures in the time window
    const candidates = await this.db
      .select({
        id: fixtures.id,
        date: fixtures.date,
        homeTeamId: fixtures.homeTeamId,
        awayTeamId: fixtures.awayTeamId,
        oddsApiEventId: fixtures.oddsApiEventId,
      })
      .from(fixtures)
      .where(and(gte(fixtures.date, from), lte(fixtures.date, to)));

    if (candidates.length === 0) return null;

    // Gather all team IDs we need to look up
    const teamIds = new Set<number>();
    for (const c of candidates) {
      teamIds.add(c.homeTeamId);
      teamIds.add(c.awayTeamId);
    }

    const teamRows = await this.db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(
        sql`${teams.id} IN (${sql.join(
          [...teamIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const teamNameMap = new Map<number, string>();
    for (const t of teamRows) {
      teamNameMap.set(t.id, t.name);
    }

    // Score each candidate
    let bestMatch: { fixtureId: number; score: number } | null = null;

    for (const c of candidates) {
      const homeName = teamNameMap.get(c.homeTeamId) ?? '';
      const awayName = teamNameMap.get(c.awayTeamId) ?? '';

      const homeScore = this.teamNameSimilarity(event.home_team, homeName);
      const awayScore = this.teamNameSimilarity(event.away_team, awayName);

      // Both teams must match reasonably well
      const combinedScore = (homeScore + awayScore) / 2;

      // Bonus for closer date match
      const timeDiffMs = Math.abs(
        eventDate.getTime() - new Date(c.date).getTime(),
      );
      const timeBonus = 1 - timeDiffMs / windowMs; // 0..1
      const finalScore = combinedScore * 0.85 + timeBonus * 0.15;

      if (finalScore > 0.5 && (!bestMatch || finalScore > bestMatch.score)) {
        bestMatch = { fixtureId: c.id, score: finalScore };
      }
    }

    if (!bestMatch) return null;

    // Link the fixture to this Odds API event
    await this.db
      .update(fixtures)
      .set({ oddsApiEventId: event.id, updatedAt: new Date() })
      .where(eq(fixtures.id, bestMatch.fixtureId));

    this.logger.debug(
      `Linked fixture ${bestMatch.fixtureId} to Odds event ${event.id} (score: ${bestMatch.score.toFixed(2)})`,
    );

    return bestMatch.fixtureId;
  }

  /**
   * Get all bookmaker odds for a fixture (by fixture ID).
   * Returns null if the fixture has no linked Odds API event.
   */
  async getOddsForFixture(fixtureId: number) {
    const [fixture] = await this.db
      .select({
        id: fixtures.id,
        oddsApiEventId: fixtures.oddsApiEventId,
      })
      .from(fixtures)
      .where(eq(fixtures.id, fixtureId))
      .limit(1);

    if (!fixture || !fixture.oddsApiEventId) return null;

    return {
      fixtureId: fixture.id,
      oddsApiEventId: fixture.oddsApiEventId,
      odds: await this.getOddsForEvent(fixture.oddsApiEventId),
    };
  }

  /**
   * Get odds comparison for a fixture (by fixture ID).
   * Returns null if the fixture has no linked Odds API event.
   */
  async getOddsComparisonForFixture(fixtureId: number) {
    const [fixture] = await this.db
      .select({
        id: fixtures.id,
        oddsApiEventId: fixtures.oddsApiEventId,
      })
      .from(fixtures)
      .where(eq(fixtures.id, fixtureId))
      .limit(1);

    if (!fixture || !fixture.oddsApiEventId) return null;

    const comparison = await this.getOddsComparison(fixture.oddsApiEventId);
    if (!comparison) return null;

    return {
      fixtureId: fixture.id,
      ...comparison,
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  /**
   * Calculate similarity between two team names.
   * Returns 0..1 where 1 = perfect match.
   *
   * Handles common differences between API-Football and The Odds API:
   * - "Manchester United" vs "Man United" vs "Man Utd"
   * - "FC Barcelona" vs "Barcelona"
   * - "Borussia Dortmund" vs "Dortmund"
   * - "Paris Saint Germain" vs "Paris Saint-Germain" vs "PSG"
   */
  private teamNameSimilarity(a: string, b: string): number {
    const normA = this.normalizeTeamName(a);
    const normB = this.normalizeTeamName(b);

    // Exact match after normalization
    if (normA === normB) return 1.0;

    // One contains the other
    if (normA.includes(normB) || normB.includes(normA)) return 0.85;

    // Check if all words of the shorter name appear in the longer name
    const wordsA = normA.split(' ');
    const wordsB = normB.split(' ');
    const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
    const longer = wordsA.length > wordsB.length ? wordsA : wordsB;
    const longerStr = longer.join(' ');

    const matchingWords = shorter.filter((w) => longerStr.includes(w));
    const wordOverlap = matchingWords.length / shorter.length;

    if (wordOverlap >= 0.8) return 0.75;
    if (wordOverlap >= 0.5) return 0.5;

    // Levenshtein-based similarity for close matches
    const lev = this.levenshteinDistance(normA, normB);
    const maxLen = Math.max(normA.length, normB.length);
    const levSimilarity = maxLen > 0 ? 1 - lev / maxLen : 0;

    return levSimilarity;
  }

  /**
   * Normalize a team name for comparison:
   * - lowercase
   * - remove FC, CF, SC, AFC, etc.
   * - remove punctuation/hyphens
   * - collapse whitespace
   */
  private normalizeTeamName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\b(fc|cf|sc|afc|ac|as|ss|us|rc|cd|ud|rcd|sd|ca|se)\b/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Levenshtein edit distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }

    return dp[m][n];
  }

  /**
   * Build a market comparison object with best odds, all bookmaker odds,
   * and value bets for a given market.
   */
  private buildMarketComparison(
    marketKey: string,
    bookmakerMap: Map<string, any>,
    homeTeam: string,
    awayTeam: string,
    consensus: any | undefined,
  ): MarketComparison {
    // Determine the outcome names for this market
    const outcomeNames =
      marketKey === 'h2h' ? [homeTeam, 'Draw', awayTeam] : ['Over', 'Under'];

    // Build the comparison table: for each outcome, list all bookmaker prices
    const outcomes: OutcomeComparison[] = outcomeNames.map((outcomeName) => {
      const bookmakerPrices: BookmakerPrice[] = [];

      for (const [bk, row] of bookmakerMap) {
        const outcomesArr = row.outcomes as Array<{
          name: string;
          price: number;
          point?: number;
        }>;
        if (!Array.isArray(outcomesArr)) continue;

        const outcome = outcomesArr.find((o) => o.name === outcomeName);
        if (!outcome) continue;

        bookmakerPrices.push({
          bookmakerKey: bk,
          bookmakerName: (row.bookmakerName as string) || bk,
          price: outcome.price,
          impliedProbability: ProbabilityUtil.decimalToImplied(outcome.price),
          overround: row.overround ? parseFloat(row.overround) : null,
          lastUpdate: row.lastUpdate,
        });
      }

      // Sort by price descending (best odds first)
      bookmakerPrices.sort((a, b) => b.price - a.price);

      const bestPrice = bookmakerPrices[0] ?? null;
      const worstPrice = bookmakerPrices[bookmakerPrices.length - 1] ?? null;

      // Get consensus probability for value bet detection
      let consensusProbability: number | null = null;
      if (consensus && marketKey === 'h2h') {
        if (outcomeName === homeTeam)
          consensusProbability = parseFloat(consensus.consensusHomeWin) || null;
        else if (outcomeName === 'Draw')
          consensusProbability = parseFloat(consensus.consensusDraw) || null;
        else if (outcomeName === awayTeam)
          consensusProbability = parseFloat(consensus.consensusAwayWin) || null;
      } else if (consensus && marketKey === 'totals') {
        if (outcomeName === 'Over')
          consensusProbability = parseFloat(consensus.consensusOver) || null;
        else if (outcomeName === 'Under')
          consensusProbability = parseFloat(consensus.consensusUnder) || null;
      }

      // Detect value bets: edge > 3% at best price
      let valueBet: ValueBet | null = null;
      if (consensusProbability && bestPrice) {
        const edge = ProbabilityUtil.calculateEdge(
          consensusProbability,
          bestPrice.price,
        );
        if (edge > 3) {
          valueBet = {
            bookmakerKey: bestPrice.bookmakerKey,
            bookmakerName: bestPrice.bookmakerName,
            price: bestPrice.price,
            edgePercent: parseFloat(edge.toFixed(2)),
            consensusProbability,
            impliedProbability: bestPrice.impliedProbability,
          };
        }
      }

      return {
        outcome: outcomeName,
        bestPrice: bestPrice
          ? {
              bookmakerKey: bestPrice.bookmakerKey,
              bookmakerName: bestPrice.bookmakerName,
              price: bestPrice.price,
            }
          : null,
        worstPrice: worstPrice
          ? {
              bookmakerKey: worstPrice.bookmakerKey,
              bookmakerName: worstPrice.bookmakerName,
              price: worstPrice.price,
            }
          : null,
        spread:
          bestPrice && worstPrice
            ? parseFloat((bestPrice.price - worstPrice.price).toFixed(2))
            : 0,
        bookmakerCount: bookmakerPrices.length,
        consensusProbability,
        valueBet,
        bookmakers: bookmakerPrices,
      };
    });

    const valueBets = outcomes
      .filter((o) => o.valueBet !== null)
      .map((o) => o.valueBet!);

    return {
      marketKey,
      bookmakerCount: bookmakerMap.size,
      outcomes,
      valueBets,
    };
  }

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
      remaining:
        remaining != null
          ? parseInt(remaining, 10)
          : this.creditUsage.remaining,
      used: used != null ? parseInt(used, 10) : this.creditUsage.used,
      lastCost:
        lastCost != null ? parseInt(lastCost, 10) : this.creditUsage.lastCost,
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

    this.logger.debug(`Fetched ${response.data.length} events for ${sportKey}`);

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
          lastUpdate: market.last_update ? new Date(market.last_update) : null,
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

      const homeEntry = trueProbsArr.find((p) => p.name === meta.homeTeam);
      const drawEntry = trueProbsArr.find((p) => p.name === 'Draw');
      const awayEntry = trueProbsArr.find((p) => p.name === meta.awayTeam);

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

    const consensusHome = ProbabilityUtil.calculateWeightedConsensus(homeProbs);
    const consensusDraw = ProbabilityUtil.calculateWeightedConsensus(drawProbs);
    const consensusAway = ProbabilityUtil.calculateWeightedConsensus(awayProbs);

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

    const consensusOver = ProbabilityUtil.calculateWeightedConsensus(overProbs);
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
