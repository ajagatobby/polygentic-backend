import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { eq, and, gte, lte, sql, desc, asc } from 'drizzle-orm';
import * as schema from '../database/schema';
import { FixtureQueryDto } from './dto/fixture-query.dto';

/** League IDs we actively track across all sync operations. */
export const TRACKED_LEAGUES = [
  39, 140, 135, 78, 61, 2, 3, 848, 253, 88, 94, 71, 128, 307, 45, 143, 81,
] as const;

interface ApiFootballResponse<T = any> {
  get: string;
  parameters: Record<string, string>;
  errors: Record<string, string> | any[];
  results: number;
  paging: { current: number; total: number };
  response: T[];
}

@Injectable()
export class FootballService {
  private readonly logger = new Logger(FootballService.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    @Inject('DRIZZLE') private db: any,
  ) {
    this.baseUrl =
      this.config.get<string>('API_FOOTBALL_BASE_URL') ||
      'https://v3.football.api-sports.io';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: {
        'x-apisports-key': this.config.get<string>('API_FOOTBALL_KEY'),
      },
    });
  }

  // ─── SYNC METHODS ────────────────────────────────────────────────────

  /**
   * Fetch upcoming fixtures for the given leagues and upsert into the
   * fixtures table. Defaults to TRACKED_LEAGUES.
   */
  async syncFixtures(leagueIds: number[] = [...TRACKED_LEAGUES]): Promise<number> {
    this.logger.log(`Syncing fixtures for ${leagueIds.length} leagues`);
    let totalUpserted = 0;

    for (const leagueId of leagueIds) {
      try {
        const data = await this.apiRequest<any>('/fixtures', {
          league: String(leagueId),
          season: String(this.getCurrentSeason()),
          next: '50',
        });

        if (!data.response?.length) {
          this.logger.debug(`No upcoming fixtures for league ${leagueId}`);
          continue;
        }

        for (const item of data.response) {
          await this.upsertFixture(item);
          totalUpserted++;
        }

        this.logger.debug(
          `Synced ${data.response.length} fixtures for league ${leagueId}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to sync fixtures for league ${leagueId}: ${error.message}`,
        );
      }
    }

    this.logger.log(`Fixture sync complete — ${totalUpserted} fixtures upserted`);
    return totalUpserted;
  }

  /**
   * Fetch all teams for a league/season and upsert into the teams table.
   */
  async syncTeams(leagueId: number, season: number): Promise<number> {
    this.logger.log(`Syncing teams for league ${leagueId}, season ${season}`);

    const data = await this.apiRequest<any>('/teams', {
      league: String(leagueId),
      season: String(season),
    });

    if (!data.response?.length) {
      this.logger.warn(`No teams returned for league ${leagueId}`);
      return 0;
    }

    let count = 0;
    for (const item of data.response) {
      const team = item.team;
      const venue = item.venue;

      await this.db
        .insert(schema.teams)
        .values({
          id: team.id,
          name: team.name,
          shortName: team.code ?? null,
          country: team.country,
          logo: team.logo,
          founded: team.founded,
          venueName: venue?.name,
          venueCapacity: venue?.capacity,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.teams.id,
          set: {
            name: team.name,
            shortName: team.code ?? null,
            country: team.country,
            logo: team.logo,
            founded: team.founded,
            venueName: venue?.name,
            venueCapacity: venue?.capacity,
            updatedAt: new Date(),
          },
        });

      count++;
    }

    this.logger.log(`Synced ${count} teams for league ${leagueId}`);
    return count;
  }

  /**
   * Fetch injuries for a league/season and upsert into the injuries table.
   */
  async syncInjuries(leagueId: number, season: number): Promise<number> {
    this.logger.log(`Syncing injuries for league ${leagueId}, season ${season}`);

    const data = await this.apiRequest<any>('/injuries', {
      league: String(leagueId),
      season: String(season),
    });

    if (!data.response?.length) {
      this.logger.debug(`No injuries for league ${leagueId}`);
      return 0;
    }

    let count = 0;
    for (const item of data.response) {
      await this.db
        .insert(schema.injuries)
        .values({
          playerId: item.player.id,
          playerName: item.player.name,
          type: item.player.type,
          reason: item.player.reason,
          teamId: item.team.id,
          fixtureId: item.fixture?.id ?? null,
          leagueId: item.league.id,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      count++;
    }

    this.logger.log(`Synced ${count} injuries for league ${leagueId}`);
    return count;
  }

  /**
   * Fetch standings for a league/season and update the team_form table.
   */
  async syncStandings(leagueId: number, season: number): Promise<number> {
    this.logger.log(`Syncing standings for league ${leagueId}, season ${season}`);

    const data = await this.apiRequest<any>('/standings', {
      league: String(leagueId),
      season: String(season),
    });

    if (!data.response?.length) {
      this.logger.warn(`No standings for league ${leagueId}`);
      return 0;
    }

    let count = 0;
    // Standings response is nested: response[0].league.standings[0] = array of team rows
    const leagueData = data.response[0]?.league;
    if (!leagueData?.standings?.length) return 0;

    for (const group of leagueData.standings) {
      for (const standing of group) {
        const allStats = standing.all;
        const homeStats = standing.home;
        const awayStats = standing.away;

        await this.db
          .insert(schema.teamForm)
          .values({
            teamId: standing.team.id,
            leagueId,
            season,
            formString: standing.form ?? null,
            leaguePosition: standing.rank,
            points: standing.points,
            last5Wins: allStats.win,
            last5Draws: allStats.draw,
            last5Losses: allStats.lose,
            last5GoalsFor: allStats.goals.for,
            last5GoalsAgainst: allStats.goals.against,
            homeWins: homeStats.win,
            homeDraws: homeStats.draw,
            homeLosses: homeStats.lose,
            awayWins: awayStats.win,
            awayDraws: awayStats.draw,
            awayLosses: awayStats.lose,
            goalsForAvg:
              allStats.played > 0
                ? String((allStats.goals.for / allStats.played).toFixed(2))
                : null,
            goalsAgainstAvg:
              allStats.played > 0
                ? String((allStats.goals.against / allStats.played).toFixed(2))
                : null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              schema.teamForm.teamId,
              schema.teamForm.leagueId,
              schema.teamForm.season,
            ],
            set: {
              formString: standing.form ?? null,
              leaguePosition: standing.rank,
              points: standing.points,
              last5Wins: allStats.win,
              last5Draws: allStats.draw,
              last5Losses: allStats.lose,
              last5GoalsFor: allStats.goals.for,
              last5GoalsAgainst: allStats.goals.against,
              homeWins: homeStats.win,
              homeDraws: homeStats.draw,
              homeLosses: homeStats.lose,
              awayWins: awayStats.win,
              awayDraws: awayStats.draw,
              awayLosses: awayStats.lose,
              goalsForAvg:
                allStats.played > 0
                  ? String((allStats.goals.for / allStats.played).toFixed(2))
                  : null,
              goalsAgainstAvg:
                allStats.played > 0
                  ? String((allStats.goals.against / allStats.played).toFixed(2))
                  : null,
              updatedAt: new Date(),
            },
          });

        count++;
      }
    }

    this.logger.log(`Synced ${count} standings for league ${leagueId}`);
    return count;
  }

  // ─── FETCH METHODS (Read-only from API, optionally persist) ──────────

  /**
   * Fetch API-Football's built-in prediction for a fixture.
   */
  async fetchPrediction(fixtureId: number): Promise<any> {
    this.logger.debug(`Fetching prediction for fixture ${fixtureId}`);

    const data = await this.apiRequest<any>('/predictions', {
      fixture: String(fixtureId),
    });

    return data.response?.[0] ?? null;
  }

  /**
   * Fetch head-to-head record between two teams.
   */
  async fetchH2H(
    team1Id: number,
    team2Id: number,
    last: number = 10,
  ): Promise<any[]> {
    this.logger.debug(`Fetching H2H: ${team1Id} vs ${team2Id}, last ${last}`);

    const data = await this.apiRequest<any>('/fixtures/headtohead', {
      h2h: `${team1Id}-${team2Id}`,
      last: String(last),
    });

    return data.response ?? [];
  }

  /**
   * Fetch lineups for a fixture (typically available ~1hr before kickoff).
   */
  async fetchLineups(fixtureId: number): Promise<any[]> {
    this.logger.debug(`Fetching lineups for fixture ${fixtureId}`);

    const data = await this.apiRequest<any>('/fixtures/lineups', {
      fixture: String(fixtureId),
    });

    return data.response ?? [];
  }

  /**
   * Fetch match statistics and upsert into fixture_statistics table.
   */
  async fetchFixtureStatistics(fixtureId: number): Promise<any[]> {
    this.logger.debug(`Fetching statistics for fixture ${fixtureId}`);

    const data = await this.apiRequest<any>('/fixtures/statistics', {
      fixture: String(fixtureId),
    });

    if (!data.response?.length) return [];

    for (const teamStats of data.response) {
      const statsMap: Record<string, any> = {};
      for (const stat of teamStats.statistics) {
        statsMap[stat.type] = stat.value;
      }

      await this.db
        .insert(schema.fixtureStatistics)
        .values({
          fixtureId,
          teamId: teamStats.team.id,
          shotsOnGoal: this.parseStatInt(statsMap['Shots on Goal']),
          shotsOffGoal: this.parseStatInt(statsMap['Shots off Goal']),
          totalShots: this.parseStatInt(statsMap['Total Shots']),
          blockedShots: this.parseStatInt(statsMap['Blocked Shots']),
          shotsInsideBox: this.parseStatInt(statsMap['Shots insidebox']),
          shotsOutsideBox: this.parseStatInt(statsMap['Shots outsidebox']),
          fouls: this.parseStatInt(statsMap['Fouls']),
          cornerKicks: this.parseStatInt(statsMap['Corner Kicks']),
          offsides: this.parseStatInt(statsMap['Offsides']),
          possession: this.parseStatPercentStr(statsMap['Ball Possession']),
          yellowCards: this.parseStatInt(statsMap['Yellow Cards']),
          redCards: this.parseStatInt(statsMap['Red Cards']),
          goalkeeperSaves: this.parseStatInt(statsMap['Goalkeeper Saves']),
          totalPasses: this.parseStatInt(statsMap['Total passes']),
          passesAccurate: this.parseStatInt(statsMap['Passes accurate']),
          passesPct: this.parseStatPercentStr(statsMap['Passes %']),
          expectedGoals: this.parseStatFloatStr(statsMap['expected_goals']),
          recordedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.fixtureStatistics.fixtureId,
            schema.fixtureStatistics.teamId,
          ],
          set: {
            shotsOnGoal: this.parseStatInt(statsMap['Shots on Goal']),
            shotsOffGoal: this.parseStatInt(statsMap['Shots off Goal']),
            totalShots: this.parseStatInt(statsMap['Total Shots']),
            blockedShots: this.parseStatInt(statsMap['Blocked Shots']),
            shotsInsideBox: this.parseStatInt(statsMap['Shots insidebox']),
            shotsOutsideBox: this.parseStatInt(statsMap['Shots outsidebox']),
            fouls: this.parseStatInt(statsMap['Fouls']),
            cornerKicks: this.parseStatInt(statsMap['Corner Kicks']),
            offsides: this.parseStatInt(statsMap['Offsides']),
            possession: this.parseStatPercentStr(statsMap['Ball Possession']),
            yellowCards: this.parseStatInt(statsMap['Yellow Cards']),
            redCards: this.parseStatInt(statsMap['Red Cards']),
            goalkeeperSaves: this.parseStatInt(statsMap['Goalkeeper Saves']),
            totalPasses: this.parseStatInt(statsMap['Total passes']),
            passesAccurate: this.parseStatInt(statsMap['Passes accurate']),
            passesPct: this.parseStatPercentStr(statsMap['Passes %']),
            expectedGoals: this.parseStatFloatStr(statsMap['expected_goals']),
            recordedAt: new Date(),
          },
        });
    }

    return data.response;
  }

  /**
   * Fetch match events (goals, cards, subs) and upsert into fixture_events.
   */
  async fetchFixtureEvents(fixtureId: number): Promise<any[]> {
    this.logger.debug(`Fetching events for fixture ${fixtureId}`);

    const data = await this.apiRequest<any>('/fixtures/events', {
      fixture: String(fixtureId),
    });

    if (!data.response?.length) return [];

    for (const event of data.response) {
      await this.db
        .insert(schema.fixtureEvents)
        .values({
          fixtureId,
          elapsed: event.time.elapsed,
          extraTime: event.time.extra ?? null,
          teamId: event.team.id,
          playerId: event.player?.id ?? null,
          playerName: event.player?.name ?? null,
          assistId: event.assist?.id ?? null,
          assistName: event.assist?.name ?? null,
          type: event.type,
          detail: event.detail,
          comments: event.comments ?? null,
        })
        .onConflictDoNothing();
    }

    return data.response;
  }

  // ─── DATABASE QUERY METHODS ──────────────────────────────────────────

  /**
   * Query fixtures from the database with optional filters and pagination.
   */
  async getFixtures(filters?: FixtureQueryDto): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (filters?.leagueId) {
      conditions.push(eq(schema.fixtures.leagueId, filters.leagueId));
    }

    if (filters?.status) {
      conditions.push(eq(schema.fixtures.status, filters.status));
    }

    if (filters?.teamId) {
      conditions.push(
        sql`(${schema.fixtures.homeTeamId} = ${filters.teamId} OR ${schema.fixtures.awayTeamId} = ${filters.teamId})`,
      );
    }

    if (filters?.date) {
      const startOfDay = new Date(`${filters.date}T00:00:00Z`);
      const endOfDay = new Date(`${filters.date}T23:59:59Z`);
      conditions.push(gte(schema.fixtures.date, startOfDay));
      conditions.push(lte(schema.fixtures.date, endOfDay));
    }

    if (filters?.season) {
      conditions.push(eq(schema.fixtures.season, filters.season));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(schema.fixtures)
        .where(whereClause)
        .orderBy(asc(schema.fixtures.date))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.fixtures)
        .where(whereClause),
    ]);

    return {
      data,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  /**
   * Get a single fixture by its API-Football ID with all related data.
   */
  async getFixtureById(id: number): Promise<{
    fixture: any;
    statistics: any[];
    events: any[];
    injuries: any[];
    prediction: any;
  } | null> {
    const fixtureRows = await this.db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, id))
      .limit(1);

    const fixture = fixtureRows?.[0];
    if (!fixture) return null;

    const [statistics, events, injuries] = await Promise.all([
      this.db
        .select()
        .from(schema.fixtureStatistics)
        .where(eq(schema.fixtureStatistics.fixtureId, id)),
      this.db
        .select()
        .from(schema.fixtureEvents)
        .where(eq(schema.fixtureEvents.fixtureId, id))
        .orderBy(asc(schema.fixtureEvents.elapsed)),
      this.db
        .select()
        .from(schema.injuries)
        .where(eq(schema.injuries.fixtureId, id)),
    ]);

    // Fetch live prediction from API if fixture hasn't started yet
    let prediction = null;
    if (fixture.status === 'NS') {
      try {
        prediction = await this.fetchPrediction(id);
      } catch {
        this.logger.debug(`Could not fetch prediction for fixture ${id}`);
      }
    }

    return { fixture, statistics, events, injuries, prediction };
  }

  /**
   * Fetch all currently live fixtures from the API.
   */
  async fetchLiveFixtures(leagueId?: number): Promise<any[]> {
    const params: Record<string, string> = { live: 'all' };
    if (leagueId) {
      params.league = String(leagueId);
    }

    const data = await this.apiRequest<any>('/fixtures', params);
    return data.response ?? [];
  }

  /**
   * Get team info from the database, including form data.
   */
  async getTeamById(teamId: number): Promise<{ team: any; form: any[] } | null> {
    const teamRows = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .limit(1);

    const team = teamRows?.[0];
    if (!team) return null;

    const form = await this.db
      .select()
      .from(schema.teamForm)
      .where(eq(schema.teamForm.teamId, teamId))
      .orderBy(desc(schema.teamForm.season));

    return { team, form };
  }

  /**
   * Get all tracked leagues with their current season info.
   */
  async getTrackedLeagues(): Promise<any[]> {
    const data = await this.apiRequest<any>('/leagues', {
      current: 'true',
    });

    if (!data.response?.length) return [];

    return data.response.filter((item: any) =>
      TRACKED_LEAGUES.includes(item.league.id),
    );
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────────────────────

  /**
   * Makes an authenticated GET request to the API-Football endpoint.
   * Handles rate limiting (429) with exponential backoff retry.
   */
  private async apiRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    retries: number = 2,
  ): Promise<ApiFootballResponse<T>> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.client.get<ApiFootballResponse<T>>(endpoint, {
          params,
        });

        const body = response.data;

        // API-Football may return errors inside a 200 response
        const errors = body.errors;
        if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
          const errorKeys = Object.keys(errors);
          if (errorKeys.length > 0) {
            const errorMsg = errorKeys
              .map((k) => `${k}: ${errors[k]}`)
              .join('; ');
            throw new Error(`API-Football error: ${errorMsg}`);
          }
        }

        this.logger.debug(
          `API ${endpoint} — ${body.results} results (page ${body.paging?.current}/${body.paging?.total})`,
        );

        return body;
      } catch (error) {
        if (error instanceof AxiosError) {
          const status = error.response?.status;

          // Rate limited — back off and retry
          if (status === 429 && attempt < retries) {
            const backoff = Math.pow(2, attempt + 1) * 1000;
            this.logger.warn(
              `Rate limited on ${endpoint}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`,
            );
            await this.sleep(backoff);
            continue;
          }

          // Server error — exponential backoff retry
          if (status && status >= 500 && attempt < retries) {
            const backoff = Math.pow(2, attempt + 1) * 1000;
            this.logger.warn(
              `Server error ${status} on ${endpoint}, retrying in ${backoff}ms`,
            );
            await this.sleep(backoff);
            continue;
          }

          // Timeout — retry
          if (error.code === 'ECONNABORTED' && attempt < retries) {
            const backoff = Math.pow(2, attempt + 1) * 1000;
            this.logger.warn(
              `Timeout on ${endpoint}, retrying in ${backoff}ms`,
            );
            await this.sleep(backoff);
            continue;
          }

          this.logger.error(
            `API request failed: ${endpoint} — ${status ?? error.code} ${error.message}`,
          );
        } else {
          this.logger.error(
            `API request failed: ${endpoint} — ${(error as Error).message}`,
          );
        }

        throw error;
      }
    }

    // Unreachable in practice, but satisfies TypeScript
    throw new Error(`API request to ${endpoint} exhausted all retries`);
  }

  /**
   * Upsert a single fixture from the API response into the database.
   */
  private async upsertFixture(item: any): Promise<void> {
    const f = item.fixture;
    const league = item.league;
    const teams = item.teams;
    const goals = item.goals;
    const score = item.score;

    await this.db
      .insert(schema.fixtures)
      .values({
        id: f.id,
        referee: f.referee,
        date: new Date(f.date),
        timestamp: f.timestamp,
        venueName: f.venue?.name,
        venueCity: f.venue?.city,
        statusLong: f.status.long,
        status: f.status.short,
        elapsed: f.status.elapsed,
        leagueId: league.id,
        leagueName: league.name,
        leagueCountry: league.country,
        season: league.season,
        round: league.round,
        homeTeamId: teams.home.id,
        awayTeamId: teams.away.id,
        goalsHome: goals?.home,
        goalsAway: goals?.away,
        scoreHalftimeHome: score?.halftime?.home,
        scoreHalftimeAway: score?.halftime?.away,
        scoreFulltimeHome: score?.fulltime?.home,
        scoreFulltimeAway: score?.fulltime?.away,
        scoreExtratimeHome: score?.extratime?.home,
        scoreExtratimeAway: score?.extratime?.away,
        scorePenaltyHome: score?.penalty?.home,
        scorePenaltyAway: score?.penalty?.away,
        rawData: item,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.fixtures.id,
        set: {
          referee: f.referee,
          date: new Date(f.date),
          timestamp: f.timestamp,
          venueName: f.venue?.name,
          venueCity: f.venue?.city,
          statusLong: f.status.long,
          status: f.status.short,
          elapsed: f.status.elapsed,
          round: league.round,
          goalsHome: goals?.home,
          goalsAway: goals?.away,
          scoreHalftimeHome: score?.halftime?.home,
          scoreHalftimeAway: score?.halftime?.away,
          scoreFulltimeHome: score?.fulltime?.home,
          scoreFulltimeAway: score?.fulltime?.away,
          scoreExtratimeHome: score?.extratime?.home,
          scoreExtratimeAway: score?.extratime?.away,
          scorePenaltyHome: score?.penalty?.home,
          scorePenaltyAway: score?.penalty?.away,
          rawData: item,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Determine the current football season year. Most European leagues run
   * August–May, so if we're past July we use the current calendar year.
   */
  private getCurrentSeason(): number {
    const now = new Date();
    return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  }

  private parseStatInt(value: any): number | null {
    if (value === null || value === undefined) return null;
    const parsed = parseInt(String(value), 10);
    return isNaN(parsed) ? null : parsed;
  }

  /** Parse a numeric string for a `numeric` column — returns string for Drizzle. */
  private parseStatFloatStr(value: any): string | null {
    if (value === null || value === undefined) return null;
    const parsed = parseFloat(String(value));
    return isNaN(parsed) ? null : String(parsed);
  }

  /** Parse a percentage string like "58%" for a `numeric` column — returns string. */
  private parseStatPercentStr(value: any): string | null {
    if (value === null || value === undefined) return null;
    const cleaned = String(value).replace('%', '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? null : String(parsed);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
