import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { eq, and, gte, lte, sql, desc, asc, or, ilike } from 'drizzle-orm';
import { inArray } from 'drizzle-orm';
import * as schema from '../database/schema';
import {
  BasketballFixtureQueryDto,
  BASKETBALL_MATCH_STATE_STATUSES,
  BasketballMatchState,
} from './dto/fixture-query.dto';

/**
 * Basketball league IDs we actively track across all sync operations.
 *
 * League IDs are from API-Basketball (api-sports.io).
 */
export const TRACKED_BASKETBALL_LEAGUES = [
  // ── North America ───────────────────────────────────────────────
  12, // NBA
  116, // NCAAB (NCAA Division I)

  // ── Asia ────────────────────────────────────────────────────────
  88, // KBL (Korean Basketball League)

  // ── Europe ──────────────────────────────────────────────────────
  117, // Liga Endesa (Spain)
  57, // LNB Pro A (France — top tier)
  82, // Serie A (Italy — Lega Basket)
  138, // Basketball Champions League
  120, // Euroleague Basketball

  // ── Oceania ─────────────────────────────────────────────────────
  19, // NBL (Australia)

  // ── Germany ─────────────────────────────────────────────────────
  40, // Pro A (Germany — second tier; BBL = 10 for first tier)
] as const;

interface ApiBasketballResponse<T = any> {
  get: string;
  parameters: Record<string, string>;
  errors: Record<string, string> | any[];
  results: number;
  response: T[];
}

@Injectable()
export class BasketballService {
  private readonly logger = new Logger(BasketballService.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;

  // ─── Daily rate limiter ──────────────────────────────────────────────
  //
  // API-Basketball free plan: 100 requests/day.
  // To upgrade, just change API_BASKETBALL_DAILY_LIMIT in your .env:
  //   Free  → 100
  //   Mega  → 7500
  //   Ultra → 25000 (or higher on custom plans)
  //
  // The counter resets automatically at midnight UTC.
  // ─────────────────────────────────────────────────────────────────────
  private static dailyRequestCount = 0;
  private static dailyLimitDate: string = ''; // YYYY-MM-DD of last reset
  private readonly dailyLimit: number;

  constructor(
    private readonly config: ConfigService,
    @Inject('DRIZZLE') private db: any,
  ) {
    this.baseUrl =
      this.config.get<string>('API_BASKETBALL_BASE_URL') ||
      'https://v1.basketball.api-sports.io';

    this.dailyLimit = this.config.get<number>(
      'API_BASKETBALL_DAILY_LIMIT',
      100,
    );

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: {
        'x-apisports-key': this.config.get<string>('API_BASKETBALL_KEY'),
      },
    });

    this.logger.log(
      `API-Basketball daily request limit: ${this.dailyLimit} requests/day`,
    );
  }

  // ─── Rate Limiter ───────────────────────────────────────────────────

  /**
   * Check and consume one daily request slot.
   * Resets the counter at midnight UTC automatically.
   *
   * @throws Error when the daily limit is exhausted.
   */
  private acquireDailySlot(): void {
    const todayUTC = new Date().toISOString().split('T')[0];

    // Reset counter on new day
    if (BasketballService.dailyLimitDate !== todayUTC) {
      if (BasketballService.dailyRequestCount > 0) {
        this.logger.log(
          `Daily counter reset. Previous day used ${BasketballService.dailyRequestCount}/${this.dailyLimit} requests.`,
        );
      }
      BasketballService.dailyRequestCount = 0;
      BasketballService.dailyLimitDate = todayUTC;
    }

    if (BasketballService.dailyRequestCount >= this.dailyLimit) {
      throw new Error(
        `API-Basketball daily limit exhausted (${this.dailyLimit}/day). ` +
          `Used: ${BasketballService.dailyRequestCount}. ` +
          `Resets at midnight UTC. ` +
          `To increase, set API_BASKETBALL_DAILY_LIMIT in your .env file.`,
      );
    }

    BasketballService.dailyRequestCount++;
  }

  /**
   * Returns the number of API requests remaining for today.
   * Useful for admin dashboards and budget-aware sync decisions.
   */
  getRemainingRequests(): {
    used: number;
    remaining: number;
    limit: number;
    resetsAt: string;
  } {
    const todayUTC = new Date().toISOString().split('T')[0];
    if (BasketballService.dailyLimitDate !== todayUTC) {
      return {
        used: 0,
        remaining: this.dailyLimit,
        limit: this.dailyLimit,
        resetsAt: `${todayUTC}T00:00:00Z`,
      };
    }

    return {
      used: BasketballService.dailyRequestCount,
      remaining: Math.max(
        0,
        this.dailyLimit - BasketballService.dailyRequestCount,
      ),
      limit: this.dailyLimit,
      resetsAt: `${todayUTC}T00:00:00Z`,
    };
  }

  // ─── SYNC METHODS ────────────────────────────────────────────────────

  /**
   * Fetch upcoming games for the given leagues and upsert into the
   * basketball_fixtures table. Defaults to TRACKED_BASKETBALL_LEAGUES.
   */
  async syncFixtures(
    leagueIds: number[] = [...TRACKED_BASKETBALL_LEAGUES],
  ): Promise<number> {
    this.logger.log(
      `Syncing basketball fixtures for ${leagueIds.length} leagues ` +
        `(${this.getRemainingRequests().remaining} API requests remaining today)`,
    );
    let totalUpserted = 0;

    for (const leagueId of leagueIds) {
      try {
        const remaining = this.getRemainingRequests().remaining;
        if (remaining <= 0) {
          this.logger.warn(
            `Daily API limit reached, stopping fixture sync. ` +
              `Processed ${totalUpserted} fixtures so far.`,
          );
          break;
        }

        const season = BasketballService.getCurrentSeason();

        const data = await this.apiRequest<any>('/games', {
          league: String(leagueId),
          season: String(season),
          timezone: 'UTC',
        });

        if (!data.response?.length) {
          this.logger.debug(
            `No games returned for basketball league ${leagueId}`,
          );
          continue;
        }

        let leagueUpserted = 0;
        for (const item of data.response) {
          await this.upsertFixture(item);
          leagueUpserted++;
        }

        if (leagueUpserted > 0) {
          this.logger.debug(
            `Synced ${leagueUpserted} games for basketball league ${leagueId}`,
          );
        }

        totalUpserted += leagueUpserted;
      } catch (error) {
        if ((error as Error).message?.includes('daily limit exhausted')) {
          this.logger.warn(`Stopping fixture sync — daily API limit reached.`);
          break;
        }
        this.logger.error(
          `Failed to sync basketball fixtures for league ${leagueId}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Basketball fixture sync complete — ${totalUpserted} fixtures upserted ` +
        `(${this.getRemainingRequests().remaining} API requests remaining)`,
    );
    return totalUpserted;
  }

  /**
   * Fetch recently completed games (last 2 days) and upsert to ensure
   * final scores are captured for prediction resolution.
   */
  async syncCompletedFixtures(
    leagueIds: number[] = [...TRACKED_BASKETBALL_LEAGUES],
  ): Promise<number> {
    this.logger.log(
      `Syncing completed basketball games for ${leagueIds.length} leagues`,
    );
    let totalUpserted = 0;

    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const fromDate = twoDaysAgo.toISOString().split('T')[0];
    const toDate = now.toISOString().split('T')[0];

    for (const leagueId of leagueIds) {
      try {
        const remaining = this.getRemainingRequests().remaining;
        if (remaining <= 0) {
          this.logger.warn(
            `Daily API limit reached, stopping completed fixtures sync.`,
          );
          break;
        }

        const season = BasketballService.getCurrentSeason();

        const data = await this.apiRequest<any>('/games', {
          league: String(leagueId),
          season: String(season),
          date: fromDate,
          timezone: 'UTC',
        });

        if (data.response?.length) {
          for (const item of data.response) {
            await this.upsertFixture(item);
            totalUpserted++;
          }
        }

        // Also fetch today's games if we have budget
        if (this.getRemainingRequests().remaining > 0) {
          const todayData = await this.apiRequest<any>('/games', {
            league: String(leagueId),
            season: String(season),
            date: toDate,
            timezone: 'UTC',
          });

          if (todayData.response?.length) {
            for (const item of todayData.response) {
              await this.upsertFixture(item);
              totalUpserted++;
            }
          }
        }

        this.logger.debug(
          `Synced completed games for basketball league ${leagueId}`,
        );
      } catch (error) {
        if ((error as Error).message?.includes('daily limit exhausted')) {
          this.logger.warn(
            `Stopping completed fixtures sync — daily API limit reached.`,
          );
          break;
        }
        this.logger.error(
          `Failed to sync completed basketball games for league ${leagueId}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Completed basketball fixtures sync done — ${totalUpserted} fixtures upserted`,
    );
    return totalUpserted;
  }

  /**
   * Fetch standings for a basketball league and update basketball_team_form.
   */
  async syncStandings(leagueId: number): Promise<number> {
    const season = BasketballService.getCurrentSeason();

    this.logger.log(
      `Syncing basketball standings for league ${leagueId}, season ${season}`,
    );

    const data = await this.apiRequest<any>('/standings', {
      league: String(leagueId),
      season: String(season),
    });

    if (!data.response?.length) {
      this.logger.warn(
        `No standings for basketball league ${leagueId} season ${season}`,
      );
      return 0;
    }

    let count = 0;

    for (const group of data.response) {
      const standing = group;

      // Ensure team exists
      await this.ensureTeam({
        id: standing.team.id,
        name: standing.team.name,
        logo: standing.team.logo,
      });

      const wins = standing.games?.win?.total ?? 0;
      const losses = standing.games?.lose?.total ?? 0;
      const totalGames = wins + losses;

      await this.db
        .insert(schema.basketballTeamForm)
        .values({
          teamId: standing.team.id,
          leagueId,
          season,
          formString: standing.form ?? null,
          wins,
          losses,
          winPct:
            totalGames > 0 ? String((wins / totalGames).toFixed(3)) : null,
          homeWins: standing.games?.win?.home ?? null,
          homeLosses: standing.games?.lose?.home ?? null,
          awayWins: standing.games?.win?.away ?? null,
          awayLosses: standing.games?.lose?.away ?? null,
          leaguePosition: standing.position ?? null,
          pointsPerGame:
            standing.points?.for != null && totalGames > 0
              ? String((standing.points.for / totalGames).toFixed(2))
              : null,
          opponentPointsPerGame:
            standing.points?.against != null && totalGames > 0
              ? String((standing.points.against / totalGames).toFixed(2))
              : null,
          pointsDiff:
            standing.points?.for != null && standing.points?.against != null
              ? String(
                  (
                    (standing.points.for - standing.points.against) /
                    Math.max(totalGames, 1)
                  ).toFixed(2),
                )
              : null,
          conferenceName: standing.group?.name ?? null,
          divisionName: standing.description ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.basketballTeamForm.teamId,
            schema.basketballTeamForm.leagueId,
            schema.basketballTeamForm.season,
          ],
          set: {
            formString: standing.form ?? null,
            wins,
            losses,
            winPct:
              totalGames > 0 ? String((wins / totalGames).toFixed(3)) : null,
            homeWins: standing.games?.win?.home ?? null,
            homeLosses: standing.games?.lose?.home ?? null,
            awayWins: standing.games?.win?.away ?? null,
            awayLosses: standing.games?.lose?.away ?? null,
            leaguePosition: standing.position ?? null,
            pointsPerGame:
              standing.points?.for != null && totalGames > 0
                ? String((standing.points.for / totalGames).toFixed(2))
                : null,
            opponentPointsPerGame:
              standing.points?.against != null && totalGames > 0
                ? String((standing.points.against / totalGames).toFixed(2))
                : null,
            pointsDiff:
              standing.points?.for != null && standing.points?.against != null
                ? String(
                    (
                      (standing.points.for - standing.points.against) /
                      Math.max(totalGames, 1)
                    ).toFixed(2),
                  )
                : null,
            conferenceName: standing.group?.name ?? null,
            divisionName: standing.description ?? null,
            updatedAt: new Date(),
          },
        });

      count++;
    }

    this.logger.log(
      `Synced ${count} basketball standings for league ${leagueId}`,
    );
    return count;
  }

  // ─── QUERY METHODS (Read from DB) ───────────────────────────────────

  /**
   * Get basketball fixtures with pagination and filters.
   */
  async getFixtures(query: BasketballFixtureQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (query.leagueId) {
      conditions.push(eq(schema.basketballFixtures.leagueId, query.leagueId));
    }

    if (query.leagueName) {
      conditions.push(
        ilike(schema.basketballFixtures.leagueName, `%${query.leagueName}%`),
      );
    }

    if (query.season) {
      conditions.push(eq(schema.basketballFixtures.season, query.season));
    }

    if (query.status) {
      conditions.push(eq(schema.basketballFixtures.status, query.status));
    }

    if (query.state) {
      const statuses =
        BASKETBALL_MATCH_STATE_STATUSES[query.state as BasketballMatchState];
      if (statuses) {
        conditions.push(inArray(schema.basketballFixtures.status, statuses));
      }
    }

    if (query.teamId) {
      conditions.push(
        or(
          eq(schema.basketballFixtures.homeTeamId, query.teamId),
          eq(schema.basketballFixtures.awayTeamId, query.teamId),
        ),
      );
    }

    if (query.date) {
      const start = new Date(query.date);
      const end = new Date(query.date);
      end.setDate(end.getDate() + 1);
      conditions.push(
        and(
          gte(schema.basketballFixtures.date, start),
          lte(schema.basketballFixtures.date, end),
        ),
      );
    }

    if (query.club) {
      const clubPattern = `%${query.club}%`;
      const homeTeamIds = await this.db
        .select({ id: schema.basketballTeams.id })
        .from(schema.basketballTeams)
        .where(ilike(schema.basketballTeams.name, clubPattern));

      const teamIds = homeTeamIds.map((t: any) => t.id);
      if (teamIds.length > 0) {
        conditions.push(
          or(
            inArray(schema.basketballFixtures.homeTeamId, teamIds),
            inArray(schema.basketballFixtures.awayTeamId, teamIds),
          ),
        );
      } else {
        return { data: [], count: 0, page, limit };
      }
    }

    if (query.search) {
      const searchPattern = `%${query.search}%`;
      const matchingTeamIds = await this.db
        .select({ id: schema.basketballTeams.id })
        .from(schema.basketballTeams)
        .where(ilike(schema.basketballTeams.name, searchPattern));

      const teamIds = matchingTeamIds.map((t: any) => t.id);

      const searchConditions = [
        ilike(schema.basketballFixtures.leagueName, searchPattern),
      ];

      if (teamIds.length > 0) {
        searchConditions.push(
          inArray(schema.basketballFixtures.homeTeamId, teamIds),
        );
        searchConditions.push(
          inArray(schema.basketballFixtures.awayTeamId, teamIds),
        );
      }

      conditions.push(or(...searchConditions));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const fixtures = await this.db
      .select()
      .from(schema.basketballFixtures)
      .where(whereClause)
      .orderBy(desc(schema.basketballFixtures.date))
      .limit(limit)
      .offset(offset);

    // Enrich with team data
    const enriched = await Promise.all(
      fixtures.map(async (f: any) => {
        const [homeTeam, awayTeam] = await Promise.all([
          this.db
            .select()
            .from(schema.basketballTeams)
            .where(eq(schema.basketballTeams.id, f.homeTeamId))
            .then((r: any[]) => r[0]),
          this.db
            .select()
            .from(schema.basketballTeams)
            .where(eq(schema.basketballTeams.id, f.awayTeamId))
            .then((r: any[]) => r[0]),
        ]);

        return {
          ...f,
          homeTeam: homeTeam ?? null,
          awayTeam: awayTeam ?? null,
        };
      }),
    );

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.basketballFixtures)
      .where(whereClause);

    return {
      data: enriched,
      count: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  /**
   * Get today's basketball fixtures with team details.
   */
  async getTodayFixtures(filters?: {
    leagueId?: number;
    leagueName?: string;
    leagueCountry?: string;
    status?: string;
    state?: string;
    teamId?: number;
    club?: string;
    date?: string;
    from?: string;
    to?: string;
  }) {
    const conditions: any[] = [];

    // Date range
    if (filters?.from || filters?.to || filters?.date) {
      const startDate = new Date(
        filters?.from ??
          filters?.date ??
          new Date().toISOString().split('T')[0],
      );
      startDate.setHours(0, 0, 0, 0);

      const endDate = filters?.to
        ? new Date(filters.to)
        : filters?.date
          ? new Date(filters.date)
          : new Date(startDate);
      endDate.setHours(23, 59, 59, 999);

      conditions.push(
        and(
          gte(schema.basketballFixtures.date, startDate),
          lte(schema.basketballFixtures.date, endDate),
        ),
      );
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      conditions.push(
        and(
          gte(schema.basketballFixtures.date, today),
          lte(schema.basketballFixtures.date, tomorrow),
        ),
      );
    }

    if (filters?.leagueId) {
      conditions.push(eq(schema.basketballFixtures.leagueId, filters.leagueId));
    }

    if (filters?.leagueName) {
      conditions.push(
        ilike(schema.basketballFixtures.leagueName, `%${filters.leagueName}%`),
      );
    }

    if (filters?.leagueCountry) {
      conditions.push(
        ilike(
          schema.basketballFixtures.leagueCountry,
          `%${filters.leagueCountry}%`,
        ),
      );
    }

    if (filters?.status) {
      conditions.push(eq(schema.basketballFixtures.status, filters.status));
    }

    if (filters?.state) {
      const statuses =
        BASKETBALL_MATCH_STATE_STATUSES[filters.state as BasketballMatchState];
      if (statuses) {
        conditions.push(inArray(schema.basketballFixtures.status, statuses));
      }
    }

    if (filters?.teamId) {
      conditions.push(
        or(
          eq(schema.basketballFixtures.homeTeamId, filters.teamId),
          eq(schema.basketballFixtures.awayTeamId, filters.teamId),
        ),
      );
    }

    if (filters?.club) {
      const clubPattern = `%${filters.club}%`;
      const matchingTeams = await this.db
        .select({ id: schema.basketballTeams.id })
        .from(schema.basketballTeams)
        .where(ilike(schema.basketballTeams.name, clubPattern));

      const teamIds = matchingTeams.map((t: any) => t.id);
      if (teamIds.length > 0) {
        conditions.push(
          or(
            inArray(schema.basketballFixtures.homeTeamId, teamIds),
            inArray(schema.basketballFixtures.awayTeamId, teamIds),
          ),
        );
      } else {
        return [];
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const fixtures = await this.db
      .select()
      .from(schema.basketballFixtures)
      .where(whereClause)
      .orderBy(asc(schema.basketballFixtures.date));

    // Enrich with team data
    const enriched = await Promise.all(
      fixtures.map(async (f: any) => {
        const [homeTeam, awayTeam] = await Promise.all([
          this.db
            .select()
            .from(schema.basketballTeams)
            .where(eq(schema.basketballTeams.id, f.homeTeamId))
            .then((r: any[]) => r[0]),
          this.db
            .select()
            .from(schema.basketballTeams)
            .where(eq(schema.basketballTeams.id, f.awayTeamId))
            .then((r: any[]) => r[0]),
        ]);

        return {
          ...f,
          homeTeam: homeTeam ?? null,
          awayTeam: awayTeam ?? null,
        };
      }),
    );

    return enriched;
  }

  /**
   * Get a single basketball fixture by ID with team details and statistics.
   */
  async getFixtureById(id: number) {
    const fixture = await this.db
      .select()
      .from(schema.basketballFixtures)
      .where(eq(schema.basketballFixtures.id, id))
      .then((r: any[]) => r[0]);

    if (!fixture) return null;

    const [homeTeam, awayTeam, statistics] = await Promise.all([
      this.db
        .select()
        .from(schema.basketballTeams)
        .where(eq(schema.basketballTeams.id, fixture.homeTeamId))
        .then((r: any[]) => r[0]),
      this.db
        .select()
        .from(schema.basketballTeams)
        .where(eq(schema.basketballTeams.id, fixture.awayTeamId))
        .then((r: any[]) => r[0]),
      this.db
        .select()
        .from(schema.basketballFixtureStatistics)
        .where(eq(schema.basketballFixtureStatistics.fixtureId, id)),
    ]);

    return {
      ...fixture,
      homeTeam: homeTeam ?? null,
      awayTeam: awayTeam ?? null,
      statistics,
    };
  }

  /**
   * Get a team by ID with form data.
   */
  async getTeamById(id: number) {
    const team = await this.db
      .select()
      .from(schema.basketballTeams)
      .where(eq(schema.basketballTeams.id, id))
      .then((r: any[]) => r[0]);

    if (!team) return null;

    const form = await this.db
      .select()
      .from(schema.basketballTeamForm)
      .where(eq(schema.basketballTeamForm.teamId, id))
      .orderBy(desc(schema.basketballTeamForm.season))
      .limit(1)
      .then((r: any[]) => r[0]);

    return { ...team, form: form ?? null };
  }

  /**
   * Get tracked basketball leagues with fixture counts.
   */
  async getTrackedLeagues() {
    const season = BasketballService.getCurrentSeason();

    const leagues = await this.db
      .select({
        leagueId: schema.basketballFixtures.leagueId,
        leagueName: schema.basketballFixtures.leagueName,
        leagueCountry: schema.basketballFixtures.leagueCountry,
        fixtureCount: sql<number>`count(*)`,
      })
      .from(schema.basketballFixtures)
      .where(eq(schema.basketballFixtures.season, season))
      .groupBy(
        schema.basketballFixtures.leagueId,
        schema.basketballFixtures.leagueName,
        schema.basketballFixtures.leagueCountry,
      )
      .orderBy(schema.basketballFixtures.leagueName);

    return leagues;
  }

  /**
   * Fetch currently live basketball games from API-Basketball.
   */
  async fetchLiveGames(): Promise<any[]> {
    this.logger.debug('Fetching live basketball games');

    const data = await this.apiRequest<any>('/games', {
      live: 'all',
    });

    return data.response ?? [];
  }

  /**
   * Get team match history for a basketball team.
   */
  async getTeamMatchHistory(
    teamId: number,
    opts?: { leagueId?: number; limit?: number; offset?: number },
  ) {
    const team = await this.getTeamById(teamId);

    const conditions: any[] = [
      or(
        eq(schema.basketballFixtures.homeTeamId, teamId),
        eq(schema.basketballFixtures.awayTeamId, teamId),
      ),
      inArray(schema.basketballFixtures.status, ['FT', 'AOT']),
    ];

    if (opts?.leagueId) {
      conditions.push(eq(schema.basketballFixtures.leagueId, opts.leagueId));
    }

    const limit = opts?.limit ?? 30;
    const offset = opts?.offset ?? 0;

    const matches = await this.db
      .select()
      .from(schema.basketballFixtures)
      .where(and(...conditions))
      .orderBy(desc(schema.basketballFixtures.date))
      .limit(limit)
      .offset(offset);

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.basketballFixtures)
      .where(and(...conditions));

    // Enrich matches with team data and result
    const enriched = await Promise.all(
      matches.map(async (f: any) => {
        const [homeTeam, awayTeam] = await Promise.all([
          this.db
            .select()
            .from(schema.basketballTeams)
            .where(eq(schema.basketballTeams.id, f.homeTeamId))
            .then((r: any[]) => r[0]),
          this.db
            .select()
            .from(schema.basketballTeams)
            .where(eq(schema.basketballTeams.id, f.awayTeamId))
            .then((r: any[]) => r[0]),
        ]);

        const isHome = f.homeTeamId === teamId;
        const teamScore = isHome ? f.scoreHome : f.scoreAway;
        const opponentScore = isHome ? f.scoreAway : f.scoreHome;
        const result =
          teamScore > opponentScore
            ? 'W'
            : teamScore < opponentScore
              ? 'L'
              : 'D';

        return {
          ...f,
          homeTeam: homeTeam ?? null,
          awayTeam: awayTeam ?? null,
          result,
          teamScore,
          opponentScore,
        };
      }),
    );

    return {
      team,
      matches: enriched,
      total: Number(countResult[0]?.count ?? 0),
    };
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────────────────────

  /**
   * Ensure a basketball team row exists (upsert from API response data).
   */
  private async ensureTeam(team: {
    id: number;
    name: string;
    logo?: string;
  }): Promise<void> {
    await this.db
      .insert(schema.basketballTeams)
      .values({
        id: team.id,
        name: team.name,
        logo: team.logo ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.basketballTeams.id,
        set: {
          name: team.name,
          logo: team.logo ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Upsert a single basketball game from the API response into the database.
   *
   * API-Basketball response shape:
   * {
   *   id: number,
   *   date: string,
   *   timestamp: number,
   *   timezone: string,
   *   stage: string | null,
   *   week: string | null,
   *   status: { long: string, short: string, timer: string | null },
   *   league: { id, name, type, season, logo },
   *   country: { id, name, code, flag },
   *   teams: { home: { id, name, logo }, away: { id, name, logo } },
   *   scores: {
   *     home: { quarter_1, quarter_2, quarter_3, quarter_4, over_time, total },
   *     away: { quarter_1, quarter_2, quarter_3, quarter_4, over_time, total }
   *   }
   * }
   */
  private async upsertFixture(item: any): Promise<void> {
    const teams = item.teams;
    const scores = item.scores;
    const league = item.league;
    const country = item.country;
    const status = item.status;

    // Ensure both teams exist before inserting (FK constraint)
    await Promise.all([
      this.ensureTeam(teams.home),
      this.ensureTeam(teams.away),
    ]);

    await this.db
      .insert(schema.basketballFixtures)
      .values({
        id: item.id,
        date: new Date(item.date),
        timestamp: item.timestamp,
        status: status.short,
        statusLong: status.long,
        timer: status.timer ?? null,
        leagueId: league.id,
        leagueName: league.name,
        leagueCountry: country?.name ?? null,
        leagueSeason: String(league.season),
        season:
          typeof league.season === 'number'
            ? league.season
            : parseInt(String(league.season).split('-')[0], 10) || null,
        stage: item.stage ?? null,
        week: item.week ?? null,
        homeTeamId: teams.home.id,
        awayTeamId: teams.away.id,
        scoreHome: scores?.home?.total ?? null,
        scoreAway: scores?.away?.total ?? null,
        scoreQ1Home: scores?.home?.quarter_1 ?? null,
        scoreQ1Away: scores?.away?.quarter_1 ?? null,
        scoreQ2Home: scores?.home?.quarter_2 ?? null,
        scoreQ2Away: scores?.away?.quarter_2 ?? null,
        scoreQ3Home: scores?.home?.quarter_3 ?? null,
        scoreQ3Away: scores?.away?.quarter_3 ?? null,
        scoreQ4Home: scores?.home?.quarter_4 ?? null,
        scoreQ4Away: scores?.away?.quarter_4 ?? null,
        scoreOTHome: scores?.home?.over_time ?? null,
        scoreOTAway: scores?.away?.over_time ?? null,
        scoreHalftimeHome:
          scores?.home?.quarter_1 != null && scores?.home?.quarter_2 != null
            ? scores.home.quarter_1 + scores.home.quarter_2
            : null,
        scoreHalftimeAway:
          scores?.away?.quarter_1 != null && scores?.away?.quarter_2 != null
            ? scores.away.quarter_1 + scores.away.quarter_2
            : null,
        rawData: item,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.basketballFixtures.id,
        set: {
          date: new Date(item.date),
          timestamp: item.timestamp,
          status: status.short,
          statusLong: status.long,
          timer: status.timer ?? null,
          stage: item.stage ?? null,
          week: item.week ?? null,
          scoreHome: scores?.home?.total ?? null,
          scoreAway: scores?.away?.total ?? null,
          scoreQ1Home: scores?.home?.quarter_1 ?? null,
          scoreQ1Away: scores?.away?.quarter_1 ?? null,
          scoreQ2Home: scores?.home?.quarter_2 ?? null,
          scoreQ2Away: scores?.away?.quarter_2 ?? null,
          scoreQ3Home: scores?.home?.quarter_3 ?? null,
          scoreQ3Away: scores?.away?.quarter_3 ?? null,
          scoreQ4Home: scores?.home?.quarter_4 ?? null,
          scoreQ4Away: scores?.away?.quarter_4 ?? null,
          scoreOTHome: scores?.home?.over_time ?? null,
          scoreOTAway: scores?.away?.over_time ?? null,
          scoreHalftimeHome:
            scores?.home?.quarter_1 != null && scores?.home?.quarter_2 != null
              ? scores.home.quarter_1 + scores.home.quarter_2
              : null,
          scoreHalftimeAway:
            scores?.away?.quarter_1 != null && scores?.away?.quarter_2 != null
              ? scores.away.quarter_1 + scores.away.quarter_2
              : null,
          rawData: item,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Determine the current basketball season.
   *
   * NBA runs October–June, so if we're past August we use the current
   * calendar year; otherwise we use last year (the season that started
   * the previous October).
   */
  static getCurrentSeason(): number {
    const now = new Date();
    return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  }

  /**
   * Generic API request with retry and daily rate-limiting.
   */
  private async apiRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    retries = 3,
  ): Promise<ApiBasketballResponse<T>> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Daily budget check (throws if exhausted)
        this.acquireDailySlot();

        const response = await this.client.get<ApiBasketballResponse<T>>(
          endpoint,
          { params },
        );

        // API-Basketball returns errors as a non-empty object or array
        const errors = response.data.errors;
        if (
          errors &&
          !Array.isArray(errors) &&
          Object.keys(errors).length > 0
        ) {
          const errorMsg = JSON.stringify(errors);
          if (errorMsg.includes('rateLimit') && attempt < retries - 1) {
            const backoff = Math.pow(2, attempt + 1) * 2000;
            this.logger.warn(
              `Rate limited on ${endpoint}, retrying in ${backoff}ms`,
            );
            await this.sleep(backoff);
            continue;
          }
          throw new Error(`API-Basketball error: ${errorMsg}`);
        }

        return response.data;
      } catch (error) {
        // Don't retry if daily limit is exhausted — it won't recover
        if ((error as Error).message?.includes('daily limit exhausted')) {
          throw error;
        }

        if (error instanceof AxiosError) {
          if (error.response?.status === 429 && attempt < retries - 1) {
            const backoff = Math.pow(2, attempt + 1) * 2000;
            this.logger.warn(
              `Rate limited (HTTP 429) on ${endpoint}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`,
            );
            await this.sleep(backoff);
            continue;
          }

          this.logger.error(
            `API request failed: ${endpoint} — ${error.message} (status: ${error.response?.status})`,
          );
        } else {
          const msg = (error as Error).message ?? '';
          if (msg.includes('rateLimit') && attempt < retries - 1) {
            const backoff = Math.pow(2, attempt + 1) * 2000;
            this.logger.warn(
              `Rate limited (in-body) on ${endpoint}, retrying in ${backoff}ms`,
            );
            await this.sleep(backoff);
            continue;
          }
          this.logger.error(`API request failed: ${endpoint} — ${msg}`);
        }

        throw error;
      }
    }

    throw new Error(`API request to ${endpoint} exhausted all retries`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
