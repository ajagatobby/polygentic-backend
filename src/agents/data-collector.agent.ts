import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { FootballService } from '../football/football.service';
import { OddsService } from '../odds/odds.service';

/**
 * All structured data collected for a single fixture,
 * to be passed to the Research and Analysis agents.
 */
export interface CollectedMatchData {
  fixture: any;
  homeTeam: { team: any; form: any[] } | null;
  awayTeam: { team: any; form: any[] } | null;
  h2h: any[];
  injuries: any[];
  lineups: any[];
  standings: { home: any | null; away: any | null };
  odds: {
    consensus: any[];
    bookmakers: any[];
  };
  apiPrediction: any | null;
}

@Injectable()
export class DataCollectorAgent {
  private readonly logger = new Logger(DataCollectorAgent.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly footballService: FootballService,
    private readonly oddsService: OddsService,
  ) {}

  /**
   * Collect all available structured data for a fixture.
   * Reads from DB first, then fetches from API where needed.
   */
  async collect(fixtureId: number): Promise<CollectedMatchData> {
    this.logger.log(`Collecting data for fixture ${fixtureId}`);

    // 1. Get fixture from DB
    const fixtureRows = await this.db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, fixtureId))
      .limit(1);

    const fixture = fixtureRows?.[0];
    if (!fixture) {
      throw new Error(`Fixture ${fixtureId} not found in database`);
    }

    // 2. Fetch all data in parallel
    const [
      homeTeam,
      awayTeam,
      h2h,
      injuries,
      lineups,
      homeForm,
      awayForm,
      apiPrediction,
    ] = await Promise.allSettled([
      this.footballService.getTeamById(fixture.homeTeamId),
      this.footballService.getTeamById(fixture.awayTeamId),
      this.fetchH2HSafe(fixture.homeTeamId, fixture.awayTeamId),
      this.getInjuriesForFixture(
        fixtureId,
        fixture.homeTeamId,
        fixture.awayTeamId,
      ),
      this.fetchLineupsSafe(fixtureId),
      this.getTeamForm(fixture.homeTeamId, fixture.leagueId),
      this.getTeamForm(fixture.awayTeamId, fixture.leagueId),
      this.fetchApiPredictionSafe(fixtureId),
    ]);

    // 3. Get odds data by matching team names
    const odds = await this.getOddsForFixture(fixture);

    const result: CollectedMatchData = {
      fixture,
      homeTeam: this.unwrap(homeTeam),
      awayTeam: this.unwrap(awayTeam),
      h2h: this.unwrap(h2h) ?? [],
      injuries: this.unwrap(injuries) ?? [],
      lineups: this.unwrap(lineups) ?? [],
      standings: {
        home: this.unwrap(homeForm),
        away: this.unwrap(awayForm),
      },
      odds,
      apiPrediction: this.unwrap(apiPrediction),
    };

    this.logger.log(
      `Data collected for fixture ${fixtureId}: ` +
        `h2h=${result.h2h.length}, injuries=${result.injuries.length}, ` +
        `lineups=${result.lineups.length}, odds_consensus=${result.odds.consensus.length}`,
    );

    return result;
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private async fetchH2HSafe(homeId: number, awayId: number): Promise<any[]> {
    try {
      return await this.footballService.fetchH2H(homeId, awayId, 10);
    } catch (error) {
      this.logger.warn(`H2H fetch failed: ${error.message}`);
      return [];
    }
  }

  private async fetchLineupsSafe(fixtureId: number): Promise<any[]> {
    try {
      // Check DB first (lineups may have been persisted by the lineup task)
      const persisted =
        await this.footballService.getLineupsForFixture(fixtureId);
      if (persisted.length > 0) {
        this.logger.debug(
          `Using ${persisted.length} persisted lineup(s) for fixture ${fixtureId}`,
        );
        // Re-shape DB rows to match the API response format expected by AnalysisAgent
        return persisted.map((row: any) => ({
          team: { id: row.teamId, name: row.teamName, logo: row.teamLogo },
          coach: {
            id: row.coachId,
            name: row.coachName,
            photo: row.coachPhoto,
          },
          formation: row.formation,
          startXI: (row.startXI ?? []).map((p: any) => ({
            player: {
              id: p.id,
              name: p.name,
              number: p.number,
              pos: p.pos,
              grid: p.grid,
            },
          })),
          substitutes: (row.substitutes ?? []).map((p: any) => ({
            player: {
              id: p.id,
              name: p.name,
              number: p.number,
              pos: p.pos,
              grid: p.grid,
            },
          })),
        }));
      }

      // Fall back to live API fetch
      return await this.footballService.fetchLineups(fixtureId);
    } catch (error) {
      this.logger.debug(`Lineups not available for fixture ${fixtureId}`);
      return [];
    }
  }

  private async fetchApiPredictionSafe(fixtureId: number): Promise<any> {
    try {
      return await this.footballService.fetchPrediction(fixtureId);
    } catch (error) {
      this.logger.debug(
        `API-Football prediction not available for fixture ${fixtureId}`,
      );
      return null;
    }
  }

  private async getInjuriesForFixture(
    fixtureId: number,
    homeTeamId: number,
    awayTeamId: number,
  ): Promise<any[]> {
    try {
      // Get injuries for both teams (fixture-specific + general)
      const injuries = await this.db
        .select()
        .from(schema.injuries)
        .where(sql`${schema.injuries.teamId} IN (${homeTeamId}, ${awayTeamId})`)
        .orderBy(desc(schema.injuries.updatedAt))
        .limit(50);

      return injuries;
    } catch (error) {
      this.logger.warn(`Injuries fetch failed: ${error.message}`);
      return [];
    }
  }

  private async getTeamForm(
    teamId: number,
    leagueId: number,
  ): Promise<any | null> {
    try {
      const rows = await this.db
        .select()
        .from(schema.teamForm)
        .where(
          and(
            eq(schema.teamForm.teamId, teamId),
            eq(schema.teamForm.leagueId, leagueId),
          ),
        )
        .orderBy(desc(schema.teamForm.season))
        .limit(1);

      return rows?.[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `Team form fetch failed for team ${teamId}: ${error.message}`,
      );
      return null;
    }
  }

  private async getOddsForFixture(fixture: any): Promise<{
    consensus: any[];
    bookmakers: any[];
  }> {
    try {
      // Search consensus_odds by matching team names and commence time
      // The odds API uses team names, not IDs, so we need to match by time window
      const fixtureDate = new Date(fixture.date);
      const windowStart = new Date(fixtureDate.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(fixtureDate.getTime() + 24 * 60 * 60 * 1000);

      const consensus = await this.db
        .select()
        .from(schema.consensusOdds)
        .where(
          and(
            gte(schema.consensusOdds.commenceTime, windowStart),
            lte(schema.consensusOdds.commenceTime, windowEnd),
          ),
        )
        .orderBy(desc(schema.consensusOdds.calculatedAt))
        .limit(20);

      // Try to find the best match by team names
      const homeTeamRows = await this.db
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, fixture.homeTeamId))
        .limit(1);
      const awayTeamRows = await this.db
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, fixture.awayTeamId))
        .limit(1);

      const homeName = homeTeamRows?.[0]?.name?.toLowerCase() ?? '';
      const awayName = awayTeamRows?.[0]?.name?.toLowerCase() ?? '';

      // Filter consensus to matching fixture
      const matchedConsensus = consensus.filter((c: any) => {
        const cHome = (c.homeTeam || '').toLowerCase();
        const cAway = (c.awayTeam || '').toLowerCase();
        return (
          (cHome.includes(homeName) || homeName.includes(cHome)) &&
          (cAway.includes(awayName) || awayName.includes(cAway))
        );
      });

      // Get bookmaker odds for matched events
      let bookmakers: any[] = [];
      if (matchedConsensus.length > 0) {
        const eventId = matchedConsensus[0].oddsApiEventId;
        bookmakers = await this.oddsService.getOddsForEvent(eventId);
      }

      return {
        consensus: matchedConsensus,
        bookmakers,
      };
    } catch (error) {
      this.logger.warn(`Odds fetch for fixture failed: ${error.message}`);
      return { consensus: [], bookmakers: [] };
    }
  }

  private unwrap<T>(result: PromiseSettledResult<T>): T | null {
    if (result.status === 'fulfilled') return result.value;
    this.logger.debug(
      `Promise rejected: ${result.reason?.message ?? result.reason}`,
    );
    return null;
  }
}
