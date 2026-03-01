import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, isNull, gte, lte, sql, desc } from 'drizzle-orm';
import Fuse from 'fuse.js';
import {
  polymarketMarkets,
  polymarketEvents,
  fixtures,
  teams,
  marketFixtureLinks,
  bookmakerOdds,
} from '../database/schema';
import { FuzzyMatchUtil } from './fuzzy-match.util';

@Injectable()
export class MatcherService {
  private readonly logger = new Logger(MatcherService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  // ─── Public Methods ──────────────────────────────────────────────────

  /**
   * Iterate over all unmatched Polymarket markets and attempt to find
   * a matching fixture and odds event for each one.
   */
  async matchAllMarkets(): Promise<{
    matched: number;
    unmatched: number;
    errors: string[];
  }> {
    this.logger.log('Starting market matching process');

    // Get all active Polymarket markets
    const allMarkets = await this.db
      .select()
      .from(polymarketMarkets)
      .where(
        and(
          eq(polymarketMarkets.active, true),
          eq(polymarketMarkets.closed, false),
        ),
      );

    // Get already-linked market IDs
    const existingLinks = await this.db
      .select({ polymarketMarketId: marketFixtureLinks.polymarketMarketId })
      .from(marketFixtureLinks);

    const linkedIds = new Set(
      existingLinks.map((l: any) => l.polymarketMarketId),
    );

    const unmatched = allMarkets.filter((m: any) => !linkedIds.has(m.id));

    this.logger.log(
      `Found ${unmatched.length} unmatched markets out of ${allMarkets.length} active markets`,
    );

    let matchedCount = 0;
    const errors: string[] = [];

    // Load all teams for fuzzy matching
    const allTeams = await this.db.select().from(teams);

    for (const market of unmatched) {
      try {
        const result = await this.matchMarketToFixture(market, allTeams);
        if (result) {
          matchedCount++;
        }
      } catch (err) {
        const msg = `Failed to match market ${market.id}: ${err.message}`;
        this.logger.warn(msg);
        errors.push(msg);
      }
    }

    this.logger.log(
      `Matching complete: ${matchedCount} matched, ${unmatched.length - matchedCount} still unmatched`,
    );

    return {
      matched: matchedCount,
      unmatched: unmatched.length - matchedCount,
      errors: errors.length > 0 ? errors : [],
    };
  }

  /**
   * Match a single Polymarket market to a fixture by extracting team names
   * from the market title and fuzzy matching against the fixtures table.
   */
  async matchMarketToFixture(
    market: any,
    allTeams?: Array<{ id: number; name: string }>,
  ): Promise<any | null> {
    const title = market.question || '';
    const marketType = FuzzyMatchUtil.determineMarketType(title);

    // For non-match markets (transfers, manager, etc.) we only link to
    // teams/leagues rather than fixtures
    if (
      ['transfer', 'manager', 'other'].includes(marketType) &&
      marketType !== 'match_outcome'
    ) {
      return this.matchNonFixtureMarket(market, marketType, allTeams);
    }

    // Extract team names from the title
    const teamNames = FuzzyMatchUtil.extractTeamNames(title);

    if (teamNames.length === 0) {
      this.logger.debug(`Could not extract team names from: "${title}"`);
      return null;
    }

    // Load teams if not provided
    const teamList = allTeams ?? (await this.db.select().from(teams));

    // Fuzzy match each extracted team name
    const matchedTeams = teamNames
      .map((name) => FuzzyMatchUtil.fuzzyMatchTeam(name, teamList))
      .filter(
        (r): r is { id: number; name: string; score: number } => r !== null,
      );

    if (matchedTeams.length === 0) {
      this.logger.debug(
        `No team matches found for: "${title}" (extracted: ${teamNames.join(', ')})`,
      );
      return null;
    }

    // Try to find a matching fixture
    const extractedDate = FuzzyMatchUtil.extractDate(title);
    let matchedFixture: any = null;

    if (matchedTeams.length >= 2) {
      // We have two teams — look for a fixture between them
      matchedFixture = await this.findFixtureBetweenTeams(
        matchedTeams[0].id,
        matchedTeams[1].id,
        extractedDate,
      );
    }

    if (!matchedFixture && matchedTeams.length >= 1) {
      // Fall back to finding any upcoming fixture for the first team
      matchedFixture = await this.findUpcomingFixtureForTeam(
        matchedTeams[0].id,
        extractedDate,
      );
    }

    // Also try to match to an odds event
    const oddsEventId = await this.matchMarketToOddsEvent(
      market,
      matchedTeams.map((t) => t.name),
    );

    // Calculate overall match confidence
    const avgScore =
      matchedTeams.reduce((sum, t) => sum + t.score, 0) / matchedTeams.length;
    const matchConfidence = Math.min(
      100,
      Math.round(avgScore * 100 * (matchedFixture ? 1.2 : 0.8)),
    );

    // Store the link
    const linkValues: any = {
      polymarketMarketId: market.id,
      fixtureId: matchedFixture?.id ?? null,
      oddsApiEventId: oddsEventId ?? null,
      leagueId: matchedFixture?.leagueId ?? null,
      teamId: matchedTeams[0]?.id ?? null,
      matchType: marketType,
      matchConfidence: matchConfidence.toFixed(2),
      matchMethod: this.determineMatchMethod(matchedTeams, matchedFixture),
      mappedOutcome: this.mapOutcome(market, matchedTeams, matchedFixture),
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.db
      .insert(marketFixtureLinks)
      .values(linkValues)
      .onConflictDoUpdate({
        target: [
          marketFixtureLinks.polymarketMarketId,
          marketFixtureLinks.fixtureId,
        ],
        set: {
          oddsApiEventId: linkValues.oddsApiEventId,
          matchConfidence: linkValues.matchConfidence,
          matchMethod: linkValues.matchMethod,
          mappedOutcome: linkValues.mappedOutcome,
          updatedAt: new Date(),
        },
      });

    this.logger.debug(
      `Matched market "${title}" → fixture ${matchedFixture?.id ?? 'none'}, odds event ${oddsEventId ?? 'none'} (confidence: ${matchConfidence}%)`,
    );

    return linkValues;
  }

  /**
   * Match a market against The Odds API events by comparing team names.
   */
  async matchMarketToOddsEvent(
    market: any,
    teamNames: string[],
  ): Promise<string | null> {
    if (teamNames.length === 0) return null;

    // Get distinct events from bookmaker_odds
    const oddsEvents = await this.db
      .selectDistinct({
        oddsApiEventId: bookmakerOdds.oddsApiEventId,
        homeTeam: bookmakerOdds.homeTeam,
        awayTeam: bookmakerOdds.awayTeam,
        commenceTime: bookmakerOdds.commenceTime,
      })
      .from(bookmakerOdds)
      .where(gte(bookmakerOdds.commenceTime, new Date()))
      .orderBy(bookmakerOdds.commenceTime);

    if (oddsEvents.length === 0) return null;

    // Build a fuse index of odds events
    const eventItems: Array<{
      id: string;
      combined: string;
      homeTeam: string;
      awayTeam: string;
    }> = oddsEvents.map((e: any) => ({
      id: e.oddsApiEventId as string,
      combined: `${e.homeTeam} ${e.awayTeam}`,
      homeTeam: e.homeTeam as string,
      awayTeam: e.awayTeam as string,
    }));

    const fuse = new Fuse(eventItems, {
      keys: ['combined', 'homeTeam', 'awayTeam'],
      threshold: 0.4,
      includeScore: true,
    });

    // Search with combined team names
    const searchQuery = teamNames.join(' ');
    const results = fuse.search(searchQuery);

    if (results.length > 0 && (results[0].score ?? 1) < 0.5) {
      return results[0].item.id;
    }

    return null;
  }

  /**
   * Return all matched market-fixture links.
   */
  async getMatchedMarkets() {
    const links = await this.db
      .select()
      .from(marketFixtureLinks)
      .orderBy(desc(marketFixtureLinks.createdAt));

    return links;
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  /**
   * Handle matching for non-fixture markets (transfer, manager, season).
   */
  private async matchNonFixtureMarket(
    market: any,
    marketType: string,
    allTeams?: Array<{ id: number; name: string }>,
  ): Promise<any | null> {
    const title = market.question || '';
    const teamNames = FuzzyMatchUtil.extractTeamNames(title);

    if (teamNames.length === 0) return null;

    const teamList = allTeams ?? (await this.db.select().from(teams));

    const matchedTeam = FuzzyMatchUtil.fuzzyMatchTeam(teamNames[0], teamList);

    if (!matchedTeam) return null;

    const linkValues: any = {
      polymarketMarketId: market.id,
      fixtureId: null,
      oddsApiEventId: null,
      leagueId: null,
      teamId: matchedTeam.id,
      matchType: marketType,
      matchConfidence: (matchedTeam.score * 100).toFixed(2),
      matchMethod: 'team_fuzzy',
      mappedOutcome: null,
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.db
      .insert(marketFixtureLinks)
      .values(linkValues)
      .onConflictDoNothing();

    return linkValues;
  }

  /**
   * Find a fixture between two specific teams, optionally near a date.
   */
  private async findFixtureBetweenTeams(
    team1Id: number,
    team2Id: number,
    nearDate: Date | null,
  ): Promise<any | null> {
    const now = new Date();
    const baseConditions = [
      gte(fixtures.date, now),
      sql`(
        (${fixtures.homeTeamId} = ${team1Id} AND ${fixtures.awayTeamId} = ${team2Id})
        OR
        (${fixtures.homeTeamId} = ${team2Id} AND ${fixtures.awayTeamId} = ${team1Id})
      )`,
    ];

    if (nearDate) {
      // Search within 3 days of the extracted date
      const start = new Date(nearDate);
      start.setDate(start.getDate() - 3);
      const end = new Date(nearDate);
      end.setDate(end.getDate() + 3);
      baseConditions.push(gte(fixtures.date, start));
      baseConditions.push(lte(fixtures.date, end));
    }

    const results = await this.db
      .select()
      .from(fixtures)
      .where(and(...baseConditions))
      .orderBy(fixtures.date)
      .limit(1);

    return results[0] ?? null;
  }

  /**
   * Find the next upcoming fixture for a specific team.
   */
  private async findUpcomingFixtureForTeam(
    teamId: number,
    nearDate: Date | null,
  ): Promise<any | null> {
    const now = new Date();

    const conditions: any[] = [
      gte(fixtures.date, now),
      sql`(${fixtures.homeTeamId} = ${teamId} OR ${fixtures.awayTeamId} = ${teamId})`,
    ];

    if (nearDate) {
      const start = new Date(nearDate);
      start.setDate(start.getDate() - 3);
      const end = new Date(nearDate);
      end.setDate(end.getDate() + 3);
      conditions.push(gte(fixtures.date, start));
      conditions.push(lte(fixtures.date, end));
    }

    const results = await this.db
      .select()
      .from(fixtures)
      .where(and(...conditions))
      .orderBy(fixtures.date)
      .limit(1);

    return results[0] ?? null;
  }

  /**
   * Determine how the match was established.
   */
  private determineMatchMethod(
    matchedTeams: Array<{ id: number; name: string; score: number }>,
    fixture: any | null,
  ): string {
    if (matchedTeams.length >= 2 && fixture) {
      return 'both_teams_fixture';
    }
    if (matchedTeams.length >= 2) {
      return 'both_teams_no_fixture';
    }
    if (fixture) {
      return 'single_team_fixture';
    }
    return 'single_team_fuzzy';
  }

  /**
   * Map the Polymarket "Yes" outcome to a specific fixture outcome
   * (e.g., "home_win", "away_win", "draw").
   */
  private mapOutcome(
    market: any,
    matchedTeams: Array<{ id: number; name: string; score: number }>,
    fixture: any | null,
  ): string | null {
    if (!fixture || matchedTeams.length < 1) return null;

    const title = (market.question || '').toLowerCase();

    // Determine which team the "Yes" outcome maps to
    const firstTeamIsHome = fixture.homeTeamId === matchedTeams[0].id;

    // "Will X win/beat Y" → first team winning
    if (/will\s+.+\s+(win|beat|defeat)/i.test(title)) {
      return firstTeamIsHome ? 'home_win' : 'away_win';
    }

    // "X vs Y: Who will win?" — typically first named team
    if (/vs/i.test(title)) {
      return firstTeamIsHome ? 'home_win' : 'away_win';
    }

    // "X to win" — first team
    if (/to\s+win/i.test(title)) {
      return firstTeamIsHome ? 'home_win' : 'away_win';
    }

    return 'home_win'; // default assumption
  }
}
