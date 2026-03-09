import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { eq, and, gte, lte, sql, desc, asc } from 'drizzle-orm';
import * as schema from '../database/schema';
import { FixtureQueryDto, MATCH_STATE_STATUSES } from './dto/fixture-query.dto';
import { inArray } from 'drizzle-orm';

/** League IDs we actively track across all sync operations. */
export const TRACKED_LEAGUES = [
  // ── Top 5 European domestic leagues ─────────────────────────────
  39, // Premier League
  140, // La Liga
  141, // La Liga 2
  135, // Serie A
  78, // Bundesliga
  61, // Ligue 1
  // ── Other European domestic leagues ─────────────────────────────
  88, // Eredivisie
  94, // Primeira Liga
  203, // Turkish Super Lig
  179, // Scottish Premiership
  283, // Romania SuperLiga
  345, // Czechia Fortuna Liga
  103, // Norway Eliteserien
  307, // Saudi Professional League
  // ── European club competitions ──────────────────────────────────
  2, // Champions League
  3, // Europa League
  848, // Conference League
  // ── Americas ────────────────────────────────────────────────────
  253, // MLS
  262, // Liga MX
  71, // Brazil Serie A
  128, // Argentina Liga
  239, // Colombia Primera A
  265, // Chile Primera Division
  281, // Peru Liga 1
  13, // Copa Libertadores
  11, // Copa Sudamericana
  // ── Asia / Africa / Oceania ─────────────────────────────────────
  98, // Japan J. League
  99, // Japan J2 League
  292, // K-League
  188, // A-League
  233, // Egypt Premier League
  200, // Morocco Botola Pro
  // ── Domestic cups ───────────────────────────────────────────────
  45, // FA Cup
  143, // Copa del Rey
  81, // DFB-Pokal
  66, // Coupe de France
  // ── International tournaments ───────────────────────────────────
  1, // World Cup
  15, // FIFA Club World Cup
  4, // Euro Championship
  6, // Africa Cup of Nations
  9, // Copa America
  29, // CONCACAF Gold Cup
  5, // UEFA Nations League
  10, // FIFA Friendlies
  // ── World Cup qualifiers ────────────────────────────────────────
  32, // Europe
  34, // South America
  36, // Africa
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

  // ─── Sliding-window rate limiter (shared across all callers) ─────────
  // API-Football allows 300 req/min; we enforce 250 to leave headroom.
  private static readonly RATE_LIMIT = 250;
  private static readonly RATE_WINDOW_MS = 60_000;
  // Static so the limiter is shared even if multiple FootballService
  // instances are created (e.g. Trigger.dev workers via initServices()).
  private static requestTimestamps: number[] = [];
  private static rateLimitQueue: Array<{
    resolve: () => void;
  }> = [];
  private static drainScheduled = false;

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

  /**
   * Wait until a request slot is available within the rate window.
   * Uses a simple sliding-window counter with FIFO queuing so
   * concurrent callers don't stampede past the limit.
   */
  private async acquireRateSlot(): Promise<void> {
    const now = Date.now();
    const cutoff = now - FootballService.RATE_WINDOW_MS;

    // Prune timestamps outside the window
    FootballService.requestTimestamps =
      FootballService.requestTimestamps.filter((t) => t > cutoff);

    if (FootballService.requestTimestamps.length < FootballService.RATE_LIMIT) {
      // Slot available — record and proceed
      FootballService.requestTimestamps.push(Date.now());
      return;
    }

    // No slot — queue and wait
    return new Promise<void>((resolve) => {
      FootballService.rateLimitQueue.push({ resolve });
      this.scheduleDrain();
    });
  }

  /**
   * Periodically drains the wait queue as slots open up.
   */
  private scheduleDrain(): void {
    if (FootballService.drainScheduled) return;
    FootballService.drainScheduled = true;

    const drain = () => {
      if (FootballService.rateLimitQueue.length === 0) {
        FootballService.drainScheduled = false;
        return;
      }

      const now = Date.now();
      const cutoff = now - FootballService.RATE_WINDOW_MS;
      FootballService.requestTimestamps =
        FootballService.requestTimestamps.filter((t) => t > cutoff);

      while (
        FootballService.rateLimitQueue.length > 0 &&
        FootballService.requestTimestamps.length < FootballService.RATE_LIMIT
      ) {
        FootballService.requestTimestamps.push(Date.now());
        const waiter = FootballService.rateLimitQueue.shift()!;
        waiter.resolve();
      }

      if (FootballService.rateLimitQueue.length > 0) {
        // Next slot opens when the oldest request expires from the window
        const oldest = FootballService.requestTimestamps[0];
        const waitMs = Math.max(
          100,
          oldest + FootballService.RATE_WINDOW_MS - Date.now() + 50,
        );
        setTimeout(drain, waitMs);
      } else {
        FootballService.drainScheduled = false;
      }
    };

    // First drain attempt after a short delay
    setTimeout(drain, 250);
  }

  // ─── SYNC METHODS ────────────────────────────────────────────────────

  /**
   * Leagues that follow a calendar-year season (Jan–Dec) rather than the
   * European Aug–May cycle. For these, we need to try both the "European"
   * season (getCurrentSeason()) and the current calendar year.
   */
  private static readonly CALENDAR_YEAR_LEAGUES = new Set([
    253, // MLS
    262, // Liga MX
    71, // Brasileirao
    128, // Argentina Liga
  ]);

  /**
   * Fetch upcoming fixtures for the given leagues and upsert into the
   * fixtures table. Defaults to TRACKED_LEAGUES.
   *
   * For calendar-year leagues (MLS, Brasileirao, etc.), also tries
   * the current calendar year as the season to avoid missing fixtures
   * when getCurrentSeason() returns the previous year.
   */
  async syncFixtures(
    leagueIds: number[] = [...TRACKED_LEAGUES],
  ): Promise<number> {
    this.logger.log(`Syncing fixtures for ${leagueIds.length} leagues`);
    let totalUpserted = 0;

    for (const leagueId of leagueIds) {
      try {
        const seasonsToTry = FootballService.getSeasonsForLeague(leagueId);
        let leagueUpserted = 0;

        for (const season of seasonsToTry) {
          const data = await this.apiRequest<any>('/fixtures', {
            league: String(leagueId),
            season: String(season),
            next: '50',
          });

          if (!data.response?.length) continue;

          for (const item of data.response) {
            await this.upsertFixture(item);
            leagueUpserted++;
          }
        }

        if (leagueUpserted === 0) {
          this.logger.debug(`No upcoming fixtures for league ${leagueId}`);
        } else {
          this.logger.debug(
            `Synced ${leagueUpserted} fixtures for league ${leagueId}`,
          );
        }

        totalUpserted += leagueUpserted;
      } catch (error) {
        this.logger.error(
          `Failed to sync fixtures for league ${leagueId}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Fixture sync complete — ${totalUpserted} fixtures upserted`,
    );
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
   * Fetch injuries for a league and upsert into the injuries table.
   *
   * Automatically determines the correct season(s) to query. For calendar-year
   * leagues (MLS, Brasileirao, etc.) both the current calendar year and the
   * European season are tried, accumulating results from all seasons.
   *
   * Key behaviours:
   * - Ensures the referenced team exists (via ensureTeam) before inserting to
   *   avoid FK constraint violations on teamId.
   * - Injuries that reference a fixtureId not yet in our database are inserted
   *   with fixtureId = null to avoid FK constraint violations.
   * - Uses (playerId, teamId, leagueId, type) as the conflict target instead
   *   of fixtureId to avoid duplicate rows caused by NULL != NULL in PG
   *   unique indexes.
   */
  async syncInjuries(leagueId: number): Promise<number> {
    const seasonsToTry = FootballService.getSeasonsForLeague(leagueId);
    let totalCount = 0;

    for (const season of seasonsToTry) {
      this.logger.log(
        `Syncing injuries for league ${leagueId}, season ${season}`,
      );

      const data = await this.apiRequest<any>('/injuries', {
        league: String(leagueId),
        season: String(season),
      });

      if (!data.response?.length) {
        this.logger.debug(
          `No injuries for league ${leagueId} season ${season}`,
        );
        continue;
      }

      const allItems: any[] = data.response;

      this.logger.log(
        `Fetched ${allItems.length} injury records for league ${leagueId} (season ${season})`,
      );

      // ── Check which referenced fixtures exist in our DB ───────────
      const referencedFixtureIds = new Set<number>();
      for (const item of allItems) {
        if (item.fixture?.id) referencedFixtureIds.add(item.fixture.id);
      }

      const existingFixtureIds = new Set<number>();
      if (referencedFixtureIds.size > 0) {
        const rows = await this.db
          .select({ id: schema.fixtures.id })
          .from(schema.fixtures)
          .where(
            sql`${schema.fixtures.id} IN (${sql.join(
              [...referencedFixtureIds].map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
        for (const row of rows) {
          existingFixtureIds.add(row.id);
        }
      }

      // ── Upsert each injury ────────────────────────────────────────
      let count = 0;
      let skippedFixtures = 0;
      let errors = 0;

      for (const item of allItems) {
        // Use null for fixtureId if the referenced fixture is not in our DB
        const rawFixtureId = item.fixture?.id ?? null;
        const safeFixtureId =
          rawFixtureId !== null && existingFixtureIds.has(rawFixtureId)
            ? rawFixtureId
            : null;

        if (rawFixtureId !== null && safeFixtureId === null) {
          skippedFixtures++;
        }

        try {
          // Ensure the team exists to avoid FK violations on teamId
          if (item.team?.id && item.team?.name) {
            await this.ensureTeam({
              id: item.team.id,
              name: item.team.name,
              logo: item.team.logo,
            });
          }

          await this.db
            .insert(schema.injuries)
            .values({
              playerId: item.player.id,
              playerName: item.player.name,
              type: item.player.type,
              reason: item.player.reason,
              teamId: item.team.id,
              fixtureId: safeFixtureId,
              leagueId: item.league.id,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                schema.injuries.playerId,
                schema.injuries.teamId,
                schema.injuries.leagueId,
                schema.injuries.type,
              ],
              set: {
                playerName: item.player.name,
                reason: item.player.reason,
                fixtureId: safeFixtureId,
                updatedAt: new Date(),
              },
            });

          count++;
        } catch (error) {
          errors++;
          this.logger.warn(
            `Failed to upsert injury for player ${item.player?.id} (${item.player?.name}), team ${item.team?.id}: ${error.message}`,
          );
        }
      }

      if (skippedFixtures > 0) {
        this.logger.log(
          `${skippedFixtures} injuries for league ${leagueId} had missing fixture refs (fixtureId set to null)`,
        );
      }

      if (errors > 0) {
        this.logger.warn(
          `${errors}/${allItems.length} injuries failed to upsert for league ${leagueId} (season ${season})`,
        );
      }

      this.logger.log(
        `Synced ${count} injuries for league ${leagueId} (season ${season})`,
      );
      totalCount += count;
    }

    return totalCount;
  }

  /**
   * Fetch standings for a league and update the team_form table.
   *
   * Automatically determines the correct season(s) to query. For calendar-year
   * leagues (MLS, Brasileirao, etc.) the current calendar year is tried first;
   * the first season that returns data wins (standings are a snapshot, not
   * something we need to merge across seasons).
   */
  async syncStandings(leagueId: number): Promise<number> {
    const seasonsToTry = FootballService.getSeasonsForLeague(leagueId);

    for (const season of seasonsToTry) {
      this.logger.log(
        `Syncing standings for league ${leagueId}, season ${season}`,
      );

      const data = await this.apiRequest<any>('/standings', {
        league: String(leagueId),
        season: String(season),
      });

      if (!data.response?.length) {
        this.logger.debug(
          `No standings for league ${leagueId} season ${season}, trying next...`,
        );
        continue;
      }

      let count = 0;
      // Standings response is nested: response[0].league.standings[0] = array of team rows
      const leagueData = data.response[0]?.league;
      if (!leagueData?.standings?.length) continue;

      for (const group of leagueData.standings) {
        for (const standing of group) {
          const allStats = standing.all;
          const homeStats = standing.home;
          const awayStats = standing.away;

          // Ensure team exists before inserting team_form (FK constraint)
          await this.ensureTeam({
            id: standing.team.id,
            name: standing.team.name,
            logo: standing.team.logo,
          });

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
                  ? String(
                      (allStats.goals.against / allStats.played).toFixed(2),
                    )
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
                    ? String(
                        (allStats.goals.against / allStats.played).toFixed(2),
                      )
                    : null,
                updatedAt: new Date(),
              },
            });

          count++;
        }
      }

      this.logger.log(
        `Synced ${count} standings for league ${leagueId} (season ${season})`,
      );
      return count;
    }

    this.logger.warn(`No standings found for league ${leagueId} in any season`);
    return 0;
  }

  /**
   * Fetch recently completed fixtures (last 2 days) for tracked leagues
   * and upsert into the fixtures table. This ensures fixtures that were
   * previously synced as upcoming (NS) get their final status (FT),
   * goals, and scores updated — which is required for prediction resolution.
   */
  async syncCompletedFixtures(
    leagueIds: number[] = [...TRACKED_LEAGUES],
  ): Promise<number> {
    this.logger.log(
      `Syncing completed fixtures for ${leagueIds.length} leagues`,
    );
    let totalUpserted = 0;

    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    // Format dates as YYYY-MM-DD for the API
    const fromDate = twoDaysAgo.toISOString().split('T')[0];
    const toDate = now.toISOString().split('T')[0];

    for (const leagueId of leagueIds) {
      try {
        const seasonsToTry = FootballService.getSeasonsForLeague(leagueId);

        for (const season of seasonsToTry) {
          const data = await this.apiRequest<any>('/fixtures', {
            league: String(leagueId),
            season: String(season),
            from: fromDate,
            to: toDate,
          });

          if (!data.response?.length) continue;

          for (const item of data.response) {
            await this.upsertFixture(item);
            totalUpserted++;
          }

          this.logger.debug(
            `Synced ${data.response.length} recent fixtures for league ${leagueId} (season ${season})`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to sync completed fixtures for league ${leagueId}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Completed fixtures sync done — ${totalUpserted} fixtures upserted`,
    );
    return totalUpserted;
  }

  /**
   * Fetch fixtures for a specific league within a date range and upsert them.
   * Used for historical backfill — does NOT use the `next` param.
   *
   * The API-Football `/fixtures` endpoint supports `from` and `to` params
   * (YYYY-MM-DD format). Seasons are auto-detected per league.
   *
   * @returns Number of fixtures upserted
   */
  async syncFixturesByDateRange(
    leagueId: number,
    from: string,
    to: string,
  ): Promise<number> {
    const seasonsToTry = FootballService.getSeasonsForLeague(leagueId);
    let totalUpserted = 0;

    for (const season of seasonsToTry) {
      this.logger.log(
        `Syncing fixtures for league ${leagueId}, season ${season}, ${from} to ${to}`,
      );

      const data = await this.apiRequest<any>('/fixtures', {
        league: String(leagueId),
        season: String(season),
        from,
        to,
      });

      if (!data.response?.length) {
        this.logger.debug(
          `No fixtures for league ${leagueId} season ${season} in range ${from}–${to}`,
        );
        continue;
      }

      for (const item of data.response) {
        await this.upsertFixture(item);
        totalUpserted++;
      }

      this.logger.debug(
        `Synced ${data.response.length} fixtures for league ${leagueId} season ${season} (${from}–${to})`,
      );
    }

    return totalUpserted;
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
   * Fetch lineups from API-Football and persist them to the fixture_lineups table.
   * Returns the number of lineup rows upserted (typically 2 per fixture — home + away).
   *
   * If lineups are not yet available for the fixture, returns 0.
   */
  async fetchAndPersistLineups(fixtureId: number): Promise<number> {
    const lineups = await this.fetchLineups(fixtureId);
    if (!lineups.length) return 0;

    let count = 0;
    for (const lineup of lineups) {
      const teamId = lineup.team?.id;
      if (!teamId) continue;

      // Normalize startXI: API returns [{ player: { id, name, number, pos, grid } }]
      const startXI = (lineup.startXI ?? []).map((p: any) => ({
        id: p.player?.id,
        name: p.player?.name,
        number: p.player?.number,
        pos: p.player?.pos,
        grid: p.player?.grid ?? null,
      }));

      const substitutes = (lineup.substitutes ?? []).map((p: any) => ({
        id: p.player?.id,
        name: p.player?.name,
        number: p.player?.number,
        pos: p.player?.pos,
        grid: p.player?.grid ?? null,
      }));

      const teamColors = lineup.team?.colors ?? null;

      await this.db
        .insert(schema.fixtureLineups)
        .values({
          fixtureId,
          teamId,
          formation: lineup.formation ?? null,
          coachId: lineup.coach?.id ?? null,
          coachName: lineup.coach?.name ?? null,
          coachPhoto: lineup.coach?.photo ?? null,
          startXI,
          substitutes,
          teamColors,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.fixtureLineups.fixtureId,
            schema.fixtureLineups.teamId,
          ],
          set: {
            formation: lineup.formation ?? null,
            coachId: lineup.coach?.id ?? null,
            coachName: lineup.coach?.name ?? null,
            coachPhoto: lineup.coach?.photo ?? null,
            startXI,
            substitutes,
            teamColors,
            updatedAt: new Date(),
          },
        });

      count++;
    }

    if (count > 0) {
      this.logger.log(`Persisted ${count} lineup(s) for fixture ${fixtureId}`);
    }

    return count;
  }

  /**
   * Get persisted lineups for a fixture from the database.
   * Returns both teams' lineups with team names resolved.
   */
  async getLineupsForFixture(fixtureId: number): Promise<any[]> {
    const lineups = await this.db
      .select({
        id: schema.fixtureLineups.id,
        fixtureId: schema.fixtureLineups.fixtureId,
        teamId: schema.fixtureLineups.teamId,
        teamName: schema.teams.name,
        teamLogo: schema.teams.logo,
        formation: schema.fixtureLineups.formation,
        coachId: schema.fixtureLineups.coachId,
        coachName: schema.fixtureLineups.coachName,
        coachPhoto: schema.fixtureLineups.coachPhoto,
        startXI: schema.fixtureLineups.startXI,
        substitutes: schema.fixtureLineups.substitutes,
        teamColors: schema.fixtureLineups.teamColors,
        updatedAt: schema.fixtureLineups.updatedAt,
      })
      .from(schema.fixtureLineups)
      .leftJoin(schema.teams, eq(schema.fixtureLineups.teamId, schema.teams.id))
      .where(eq(schema.fixtureLineups.fixtureId, fixtureId));

    return lineups;
  }

  /**
   * Batch fetch lineups and injuries for multiple fixtures.
   * Returns Maps keyed by fixtureId (lineups) and teamId (injuries).
   * Used to enrich list endpoints without N+1 queries.
   */
  async getLineupsAndInjuriesForFixtures(fixtureIds: number[]): Promise<{
    lineupsByFixture: Map<number, any[]>;
    injuriesByTeam: Map<number, any[]>;
  }> {
    if (fixtureIds.length === 0) {
      return {
        lineupsByFixture: new Map(),
        injuriesByTeam: new Map(),
      };
    }

    // Get team IDs for these fixtures
    const fixtures = await this.db
      .select({
        id: schema.fixtures.id,
        homeTeamId: schema.fixtures.homeTeamId,
        awayTeamId: schema.fixtures.awayTeamId,
      })
      .from(schema.fixtures)
      .where(
        sql`${schema.fixtures.id} IN (${sql.join(
          fixtureIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const teamIds = new Set<number>();
    for (const f of fixtures) {
      if (f.homeTeamId) teamIds.add(f.homeTeamId);
      if (f.awayTeamId) teamIds.add(f.awayTeamId);
    }

    const [allLineups, allInjuries] = await Promise.all([
      this.db
        .select({
          fixtureId: schema.fixtureLineups.fixtureId,
          teamId: schema.fixtureLineups.teamId,
          teamName: schema.teams.name,
          formation: schema.fixtureLineups.formation,
          coachName: schema.fixtureLineups.coachName,
          startXI: schema.fixtureLineups.startXI,
          substitutes: schema.fixtureLineups.substitutes,
        })
        .from(schema.fixtureLineups)
        .leftJoin(
          schema.teams,
          eq(schema.fixtureLineups.teamId, schema.teams.id),
        )
        .where(
          sql`${schema.fixtureLineups.fixtureId} IN (${sql.join(
            fixtureIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      teamIds.size > 0
        ? this.db
            .select()
            .from(schema.injuries)
            .where(
              sql`${schema.injuries.teamId} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .orderBy(desc(schema.injuries.updatedAt))
        : [],
    ]);

    const lineupsByFixture = new Map<number, any[]>();
    for (const l of allLineups) {
      const existing = lineupsByFixture.get(l.fixtureId) ?? [];
      existing.push({
        teamId: l.teamId,
        teamName: l.teamName,
        formation: l.formation,
        coachName: l.coachName,
        startXI: l.startXI,
        substitutes: l.substitutes,
      });
      lineupsByFixture.set(l.fixtureId, existing);
    }

    const injuriesByTeam = new Map<number, any[]>();
    for (const inj of allInjuries) {
      const existing = injuriesByTeam.get(inj.teamId) ?? [];
      existing.push({
        playerId: inj.playerId,
        playerName: inj.playerName,
        type: inj.type,
        reason: inj.reason,
      });
      injuriesByTeam.set(inj.teamId, existing);
    }

    return { lineupsByFixture, injuriesByTeam };
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
        .onConflictDoUpdate({
          target: [
            schema.fixtureEvents.fixtureId,
            schema.fixtureEvents.teamId,
            schema.fixtureEvents.elapsed,
            schema.fixtureEvents.type,
            schema.fixtureEvents.playerId,
          ],
          set: {
            detail: event.detail,
            extraTime: event.time.extra ?? null,
            playerName: event.player?.name ?? null,
            assistId: event.assist?.id ?? null,
            assistName: event.assist?.name ?? null,
            comments: event.comments ?? null,
          },
        });
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

    // ── Search (league name OR team name) ──
    // If 'club' is provided, we need to resolve team IDs first
    // If 'search' is provided, we search both league name and team name
    let teamIdsByName: number[] | null = null;

    if (filters?.club || filters?.search) {
      const searchTerm = filters.club || filters.search;
      const matchingTeams = await this.db
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(
          sql`LOWER(${schema.teams.name}) LIKE LOWER(${'%' + searchTerm + '%'})`,
        );

      teamIdsByName = matchingTeams.map((t: any) => t.id);
    }

    if (filters?.club) {
      // Filter fixtures where home or away team matches the club name
      if (teamIdsByName && teamIdsByName.length > 0) {
        conditions.push(
          sql`(${schema.fixtures.homeTeamId} IN (${sql.join(
            teamIdsByName.map((id: number) => sql`${id}`),
            sql`, `,
          )}) OR ${schema.fixtures.awayTeamId} IN (${sql.join(
            teamIdsByName.map((id: number) => sql`${id}`),
            sql`, `,
          )}))`,
        );
      } else {
        // No teams match — return empty result
        return { data: [], total: 0, page, limit };
      }
    }

    if (filters?.search) {
      // Search across league name OR team name
      const searchPattern = '%' + filters.search + '%';
      const leagueCondition = sql`LOWER(${schema.fixtures.leagueName}) LIKE LOWER(${searchPattern})`;

      if (teamIdsByName && teamIdsByName.length > 0) {
        const teamCondition = sql`(${schema.fixtures.homeTeamId} IN (${sql.join(
          teamIdsByName.map((id: number) => sql`${id}`),
          sql`, `,
        )}) OR ${schema.fixtures.awayTeamId} IN (${sql.join(
          teamIdsByName.map((id: number) => sql`${id}`),
          sql`, `,
        )}))`;
        conditions.push(sql`(${leagueCondition} OR ${teamCondition})`);
      } else {
        conditions.push(leagueCondition);
      }
    }

    if (filters?.leagueId) {
      conditions.push(eq(schema.fixtures.leagueId, filters.leagueId));
    }

    // Filter by league name (partial, case-insensitive)
    if (filters?.leagueName) {
      conditions.push(
        sql`LOWER(${schema.fixtures.leagueName}) LIKE LOWER(${'%' + filters.leagueName + '%'})`,
      );
    }

    // Exact status filter (e.g. status=NS)
    if (filters?.status) {
      conditions.push(eq(schema.fixtures.status, filters.status));
    }

    // Friendly state group filter (e.g. state=live)
    // state is ignored if an exact status is already provided
    if (filters?.state && !filters?.status) {
      const statuses = MATCH_STATE_STATUSES[filters.state];
      if (statuses?.length) {
        conditions.push(inArray(schema.fixtures.status, statuses));
      }
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

    if (data.length === 0) {
      return {
        data: [],
        total: Number(countResult[0]?.count ?? 0),
        page,
        limit,
      };
    }

    // Enrich with team names, lineups, and injuries
    const fixtureIds = data.map((f: any) => f.id);
    const teamIds = new Set<number>();
    for (const f of data) {
      if (f.homeTeamId) teamIds.add(f.homeTeamId);
      if (f.awayTeamId) teamIds.add(f.awayTeamId);
    }

    const [teamRows, allLineups, allInjuries] = await Promise.all([
      teamIds.size > 0
        ? this.db
            .select({
              id: schema.teams.id,
              name: schema.teams.name,
              shortName: schema.teams.shortName,
              logo: schema.teams.logo,
            })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [],
      this.db
        .select({
          id: schema.fixtureLineups.id,
          fixtureId: schema.fixtureLineups.fixtureId,
          teamId: schema.fixtureLineups.teamId,
          teamName: schema.teams.name,
          formation: schema.fixtureLineups.formation,
          coachName: schema.fixtureLineups.coachName,
          startXI: schema.fixtureLineups.startXI,
          substitutes: schema.fixtureLineups.substitutes,
          teamColors: schema.fixtureLineups.teamColors,
        })
        .from(schema.fixtureLineups)
        .leftJoin(
          schema.teams,
          eq(schema.fixtureLineups.teamId, schema.teams.id),
        )
        .where(
          sql`${schema.fixtureLineups.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      teamIds.size > 0
        ? this.db
            .select()
            .from(schema.injuries)
            .where(
              sql`${schema.injuries.teamId} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .orderBy(desc(schema.injuries.updatedAt))
        : [],
    ]);

    const teamMap = new Map<
      number,
      { name: string; shortName: string | null; logo: string | null }
    >();
    for (const t of teamRows) {
      teamMap.set(t.id, {
        name: t.name,
        shortName: t.shortName,
        logo: t.logo,
      });
    }

    const lineupsByFixture = new Map<number, any[]>();
    for (const l of allLineups) {
      const existing = lineupsByFixture.get(l.fixtureId) ?? [];
      existing.push(l);
      lineupsByFixture.set(l.fixtureId, existing);
    }

    const injuriesByTeam = new Map<number, any[]>();
    for (const inj of allInjuries) {
      const existing = injuriesByTeam.get(inj.teamId) ?? [];
      existing.push(inj);
      injuriesByTeam.set(inj.teamId, existing);
    }

    const enriched = data.map((fixture: any) => {
      const homeTeam = teamMap.get(fixture.homeTeamId);
      const awayTeam = teamMap.get(fixture.awayTeamId);
      const fixtureLineups = lineupsByFixture.get(fixture.id) ?? [];
      const homeInjuries = injuriesByTeam.get(fixture.homeTeamId) ?? [];
      const awayInjuries = injuriesByTeam.get(fixture.awayTeamId) ?? [];

      // Extract team colors from lineups if available
      const homeLineup = fixtureLineups.find(
        (l: any) => l.teamId === fixture.homeTeamId,
      );
      const awayLineup = fixtureLineups.find(
        (l: any) => l.teamId === fixture.awayTeamId,
      );

      return {
        ...fixture,
        homeTeam: {
          id: fixture.homeTeamId,
          name: homeTeam?.name ?? null,
          shortName: homeTeam?.shortName ?? null,
          logo: homeTeam?.logo ?? null,
          teamColors: homeLineup?.teamColors ?? null,
          injuries: homeInjuries.map((inj: any) => ({
            playerId: inj.playerId,
            playerName: inj.playerName,
            type: inj.type,
            reason: inj.reason,
          })),
        },
        awayTeam: {
          id: fixture.awayTeamId,
          name: awayTeam?.name ?? null,
          shortName: awayTeam?.shortName ?? null,
          logo: awayTeam?.logo ?? null,
          teamColors: awayLineup?.teamColors ?? null,
          injuries: awayInjuries.map((inj: any) => ({
            playerId: inj.playerId,
            playerName: inj.playerName,
            type: inj.type,
            reason: inj.reason,
          })),
        },
        lineups:
          fixtureLineups.length > 0
            ? fixtureLineups.map((l: any) => ({
                teamId: l.teamId,
                teamName: l.teamName,
                formation: l.formation,
                coachName: l.coachName,
                startXI: l.startXI,
                substitutes: l.substitutes,
              }))
            : null,
      };
    });

    return {
      data: enriched,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  /**
   * Get today's fixtures with their predictions and team names.
   * Supports filtering by leagueId, leagueName, leagueCountry, status,
   * state group, teamId, club (team name search), round, date override,
   * and post-query filtering by hasPrediction and minConfidence.
   */
  async getTodayFixturesWithPredictions(filters?: {
    leagueId?: number;
    leagueName?: string;
    leagueCountry?: string;
    status?: string;
    state?: string;
    teamId?: number;
    club?: string;
    round?: string;
    date?: string;
    from?: string;
    to?: string;
    hasPrediction?: boolean;
    minConfidence?: number;
  }): Promise<any[]> {
    const conditions: any[] = [];

    // Helper: parse a date string safely, returning null for invalid values
    const safeDate = (str: string | undefined, suffix: string): Date | null => {
      if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
      const d = new Date(`${str}${suffix}`);
      return isNaN(d.getTime()) ? null : d;
    };

    // Date range: from/to take priority over single date
    const fromDate = safeDate(filters?.from, 'T00:00:00Z');
    const toDate = safeDate(filters?.to, 'T23:59:59Z');

    if (fromDate || toDate) {
      if (fromDate) {
        conditions.push(gte(schema.fixtures.date, fromDate));
      }
      if (toDate) {
        conditions.push(lte(schema.fixtures.date, toDate));
      }
    } else {
      // Single date, default to today
      const dateStr = filters?.date ?? new Date().toISOString().split('T')[0];
      const startOfDay = safeDate(dateStr, 'T00:00:00Z');
      const endOfDay = safeDate(dateStr, 'T23:59:59Z');
      if (startOfDay) conditions.push(gte(schema.fixtures.date, startOfDay));
      if (endOfDay) conditions.push(lte(schema.fixtures.date, endOfDay));
    }

    if (filters?.leagueId) {
      conditions.push(eq(schema.fixtures.leagueId, filters.leagueId));
    }
    if (filters?.leagueName) {
      conditions.push(
        sql`LOWER(${schema.fixtures.leagueName}) LIKE LOWER(${'%' + filters.leagueName + '%'})`,
      );
    }
    if (filters?.leagueCountry) {
      conditions.push(
        sql`LOWER(${schema.fixtures.leagueCountry}) LIKE LOWER(${'%' + filters.leagueCountry + '%'})`,
      );
    }
    if (filters?.status) {
      conditions.push(eq(schema.fixtures.status, filters.status));
    }
    if (filters?.state && !filters?.status) {
      const statuses =
        MATCH_STATE_STATUSES[
          filters.state as keyof typeof MATCH_STATE_STATUSES
        ];
      if (statuses?.length) {
        conditions.push(inArray(schema.fixtures.status, statuses));
      }
    }
    if (filters?.teamId) {
      conditions.push(
        sql`(${schema.fixtures.homeTeamId} = ${filters.teamId} OR ${schema.fixtures.awayTeamId} = ${filters.teamId})`,
      );
    }
    if (filters?.round) {
      conditions.push(
        sql`LOWER(${schema.fixtures.round}) LIKE LOWER(${'%' + filters.round + '%'})`,
      );
    }

    // If filtering by club name, resolve team IDs first
    if (filters?.club) {
      const matchingTeams = await this.db
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(
          sql`LOWER(${schema.teams.name}) LIKE LOWER(${'%' + filters.club + '%'})`,
        );

      const teamIdsByName = matchingTeams.map((t: any) => t.id);
      if (teamIdsByName.length > 0) {
        conditions.push(
          sql`(${schema.fixtures.homeTeamId} IN (${sql.join(
            teamIdsByName.map((id: number) => sql`${id}`),
            sql`, `,
          )}) OR ${schema.fixtures.awayTeamId} IN (${sql.join(
            teamIdsByName.map((id: number) => sql`${id}`),
            sql`, `,
          )}))`,
        );
      } else {
        return []; // No teams match the club name
      }
    }

    // Get today's fixtures
    const fixtures = await this.db
      .select()
      .from(schema.fixtures)
      .where(and(...conditions))
      .orderBy(asc(schema.fixtures.date));

    if (fixtures.length === 0) return [];

    // Collect fixture IDs and team IDs
    const fixtureIds = fixtures.map((f: any) => f.id);
    const teamIds = new Set<number>();
    for (const f of fixtures) {
      if (f.homeTeamId) teamIds.add(f.homeTeamId);
      if (f.awayTeamId) teamIds.add(f.awayTeamId);
    }

    // Batch fetch predictions, team names, lineups, and injuries for all fixtures
    const [predictions, teamRows, allLineups, allInjuries] = await Promise.all([
      this.db
        .select()
        .from(schema.predictions)
        .where(
          sql`${schema.predictions.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .orderBy(desc(schema.predictions.createdAt)),
      teamIds.size > 0
        ? this.db
            .select({
              id: schema.teams.id,
              name: schema.teams.name,
              shortName: schema.teams.shortName,
              logo: schema.teams.logo,
            })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [],
      // Batch fetch lineups for all fixtures
      this.db
        .select({
          id: schema.fixtureLineups.id,
          fixtureId: schema.fixtureLineups.fixtureId,
          teamId: schema.fixtureLineups.teamId,
          teamName: schema.teams.name,
          teamLogo: schema.teams.logo,
          formation: schema.fixtureLineups.formation,
          coachId: schema.fixtureLineups.coachId,
          coachName: schema.fixtureLineups.coachName,
          coachPhoto: schema.fixtureLineups.coachPhoto,
          startXI: schema.fixtureLineups.startXI,
          substitutes: schema.fixtureLineups.substitutes,
          teamColors: schema.fixtureLineups.teamColors,
          updatedAt: schema.fixtureLineups.updatedAt,
        })
        .from(schema.fixtureLineups)
        .leftJoin(
          schema.teams,
          eq(schema.fixtureLineups.teamId, schema.teams.id),
        )
        .where(
          sql`${schema.fixtureLineups.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      // Batch fetch injuries for all teams in today's fixtures
      teamIds.size > 0
        ? this.db
            .select()
            .from(schema.injuries)
            .where(
              sql`${schema.injuries.teamId} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .orderBy(desc(schema.injuries.updatedAt))
        : [],
    ]);

    const teamMap = new Map<
      number,
      { name: string; shortName: string | null; logo: string | null }
    >();
    for (const t of teamRows) {
      teamMap.set(t.id, {
        name: t.name,
        shortName: t.shortName,
        logo: t.logo,
      });
    }

    // Group lineups by fixture ID
    const lineupsByFixture = new Map<number, any[]>();
    for (const l of allLineups) {
      const existing = lineupsByFixture.get(l.fixtureId) ?? [];
      existing.push(l);
      lineupsByFixture.set(l.fixtureId, existing);
    }

    // Group injuries by team ID
    const injuriesByTeam = new Map<number, any[]>();
    for (const inj of allInjuries) {
      const existing = injuriesByTeam.get(inj.teamId) ?? [];
      existing.push(inj);
      injuriesByTeam.set(inj.teamId, existing);
    }

    // Group predictions by fixture ID
    const predictionsByFixture = new Map<number, any[]>();
    for (const p of predictions) {
      const existing = predictionsByFixture.get(p.fixtureId) ?? [];
      existing.push(p);
      predictionsByFixture.set(p.fixtureId, existing);
    }

    // Assemble response
    return fixtures.map((fixture: any) => {
      const homeTeam = teamMap.get(fixture.homeTeamId);
      const awayTeam = teamMap.get(fixture.awayTeamId);
      const fixturePredictions = predictionsByFixture.get(fixture.id) ?? [];
      const fixtureLineups = lineupsByFixture.get(fixture.id) ?? [];
      const homeInjuries = injuriesByTeam.get(fixture.homeTeamId) ?? [];
      const awayInjuries = injuriesByTeam.get(fixture.awayTeamId) ?? [];

      // Extract team colors from lineups if available
      const homeLineup = fixtureLineups.find(
        (l: any) => l.teamId === fixture.homeTeamId,
      );
      const awayLineup = fixtureLineups.find(
        (l: any) => l.teamId === fixture.awayTeamId,
      );

      // Pick the best prediction: prefer pre_match, then daily, then on_demand
      const bestPrediction =
        fixturePredictions.find((p: any) => p.predictionType === 'pre_match') ??
        fixturePredictions.find((p: any) => p.predictionType === 'daily') ??
        fixturePredictions.find((p: any) => p.predictionType === 'on_demand') ??
        null;

      return {
        fixture: {
          id: fixture.id,
          date: fixture.date,
          status: fixture.status,
          statusLong: fixture.statusLong,
          elapsed: fixture.elapsed,
          round: fixture.round,
          referee: fixture.referee,
          venueName: fixture.venueName,
          venueCity: fixture.venueCity,
          leagueId: fixture.leagueId,
          leagueName: fixture.leagueName,
          leagueCountry: fixture.leagueCountry,
          season: fixture.season,
          goalsHome: fixture.goalsHome,
          goalsAway: fixture.goalsAway,
        },
        homeTeam: {
          id: fixture.homeTeamId,
          name: homeTeam?.name ?? null,
          shortName: homeTeam?.shortName ?? null,
          logo: homeTeam?.logo ?? null,
          teamColors: homeLineup?.teamColors ?? null,
          injuries: homeInjuries.map((inj: any) => ({
            playerId: inj.playerId,
            playerName: inj.playerName,
            type: inj.type,
            reason: inj.reason,
          })),
        },
        awayTeam: {
          id: fixture.awayTeamId,
          name: awayTeam?.name ?? null,
          shortName: awayTeam?.shortName ?? null,
          logo: awayTeam?.logo ?? null,
          teamColors: awayLineup?.teamColors ?? null,
          injuries: awayInjuries.map((inj: any) => ({
            playerId: inj.playerId,
            playerName: inj.playerName,
            type: inj.type,
            reason: inj.reason,
          })),
        },
        lineups:
          fixtureLineups.length > 0
            ? fixtureLineups.map((l: any) => ({
                teamId: l.teamId,
                teamName: l.teamName,
                formation: l.formation,
                coachName: l.coachName,
                startXI: l.startXI,
                substitutes: l.substitutes,
              }))
            : null,
        prediction: bestPrediction
          ? {
              id: bestPrediction.id,
              predictionType: bestPrediction.predictionType,
              homeWinProb: bestPrediction.homeWinProb,
              drawProb: bestPrediction.drawProb,
              awayWinProb: bestPrediction.awayWinProb,
              predictedHomeGoals: bestPrediction.predictedHomeGoals,
              predictedAwayGoals: bestPrediction.predictedAwayGoals,
              confidence: bestPrediction.confidence,
              keyFactors: bestPrediction.keyFactors,
              riskFactors: bestPrediction.riskFactors,
              valueBets: bestPrediction.valueBets,
              detailedAnalysis: bestPrediction.detailedAnalysis,
              actualResult: bestPrediction.actualResult,
              wasCorrect: bestPrediction.wasCorrect,
              probabilityAccuracy: bestPrediction.probabilityAccuracy,
              resolvedAt: bestPrediction.resolvedAt,
              createdAt: bestPrediction.createdAt,
            }
          : null,
        allPredictions: fixturePredictions.map((p: any) => ({
          id: p.id,
          predictionType: p.predictionType,
          homeWinProb: p.homeWinProb,
          drawProb: p.drawProb,
          awayWinProb: p.awayWinProb,
          confidence: p.confidence,
          createdAt: p.createdAt,
        })),
      };
    });
  }

  /**
   * Get a single fixture by its API-Football ID with all related data.
   */
  async getFixtureById(id: number): Promise<{
    fixture: any;
    statistics: any[];
    events: any[];
    injuries: any[];
    lineups: any[];
    prediction: any;
  } | null> {
    const fixtureRows = await this.db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, id))
      .limit(1);

    const fixture = fixtureRows?.[0];
    if (!fixture) return null;

    const [statistics, events, injuries, lineups] = await Promise.all([
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
      this.getLineupsForFixture(id),
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

    return { fixture, statistics, events, injuries, lineups, prediction };
  }

  /**
   * Get a fixture by ID with all its predictions and team details.
   */
  async getFixtureWithPredictions(fixtureId: number): Promise<any | null> {
    const fixtureRows = await this.db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, fixtureId))
      .limit(1);

    const fixture = fixtureRows?.[0];
    if (!fixture) return null;

    // Fetch predictions, team names, lineups, and injuries in parallel
    const teamIds = [fixture.homeTeamId, fixture.awayTeamId].filter(Boolean);

    const [predictions, teamRows, lineups, injuries] = await Promise.all([
      this.db
        .select()
        .from(schema.predictions)
        .where(eq(schema.predictions.fixtureId, fixtureId))
        .orderBy(desc(schema.predictions.createdAt)),
      teamIds.length > 0
        ? this.db
            .select({
              id: schema.teams.id,
              name: schema.teams.name,
              shortName: schema.teams.shortName,
              logo: schema.teams.logo,
            })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                teamIds.map((id: number) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [],
      this.getLineupsForFixture(fixtureId),
      teamIds.length > 0
        ? this.db
            .select()
            .from(schema.injuries)
            .where(
              sql`${schema.injuries.teamId} IN (${sql.join(
                teamIds.map((id: number) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .orderBy(desc(schema.injuries.updatedAt))
        : [],
    ]);

    const teamMap = new Map<
      number,
      { name: string; shortName: string | null; logo: string | null }
    >();
    for (const t of teamRows) {
      teamMap.set(t.id, {
        name: t.name,
        shortName: t.shortName,
        logo: t.logo,
      });
    }

    const homeTeam = teamMap.get(fixture.homeTeamId);
    const awayTeam = teamMap.get(fixture.awayTeamId);

    // Extract team colors from lineups if available
    const homeLineup = lineups.find(
      (l: any) => l.teamId === fixture.homeTeamId,
    );
    const awayLineup = lineups.find(
      (l: any) => l.teamId === fixture.awayTeamId,
    );

    // Split injuries by team
    const homeInjuries = injuries.filter(
      (inj: any) => inj.teamId === fixture.homeTeamId,
    );
    const awayInjuries = injuries.filter(
      (inj: any) => inj.teamId === fixture.awayTeamId,
    );

    // Best prediction: pre_match > daily > on_demand
    const bestPrediction =
      predictions.find((p: any) => p.predictionType === 'pre_match') ??
      predictions.find((p: any) => p.predictionType === 'daily') ??
      predictions.find((p: any) => p.predictionType === 'on_demand') ??
      null;

    return {
      fixture: {
        id: fixture.id,
        date: fixture.date,
        status: fixture.status,
        statusLong: fixture.statusLong,
        elapsed: fixture.elapsed,
        round: fixture.round,
        referee: fixture.referee,
        venueName: fixture.venueName,
        venueCity: fixture.venueCity,
        leagueId: fixture.leagueId,
        leagueName: fixture.leagueName,
        leagueCountry: fixture.leagueCountry,
        season: fixture.season,
        goalsHome: fixture.goalsHome,
        goalsAway: fixture.goalsAway,
        scoreHalftimeHome: fixture.scoreHalftimeHome,
        scoreHalftimeAway: fixture.scoreHalftimeAway,
        scoreFulltimeHome: fixture.scoreFulltimeHome,
        scoreFulltimeAway: fixture.scoreFulltimeAway,
      },
      homeTeam: {
        id: fixture.homeTeamId,
        name: homeTeam?.name ?? null,
        shortName: homeTeam?.shortName ?? null,
        logo: homeTeam?.logo ?? null,
        teamColors: homeLineup?.teamColors ?? null,
        injuries: homeInjuries.map((inj: any) => ({
          playerId: inj.playerId,
          playerName: inj.playerName,
          type: inj.type,
          reason: inj.reason,
        })),
      },
      awayTeam: {
        id: fixture.awayTeamId,
        name: awayTeam?.name ?? null,
        shortName: awayTeam?.shortName ?? null,
        logo: awayTeam?.logo ?? null,
        teamColors: awayLineup?.teamColors ?? null,
        injuries: awayInjuries.map((inj: any) => ({
          playerId: inj.playerId,
          playerName: inj.playerName,
          type: inj.type,
          reason: inj.reason,
        })),
      },
      lineups:
        lineups.length > 0
          ? lineups.map((l: any) => ({
              teamId: l.teamId,
              teamName: l.teamName,
              formation: l.formation,
              coachName: l.coachName,
              startXI: l.startXI,
              substitutes: l.substitutes,
            }))
          : null,
      prediction: bestPrediction
        ? {
            id: bestPrediction.id,
            predictionType: bestPrediction.predictionType,
            homeWinProb: bestPrediction.homeWinProb,
            drawProb: bestPrediction.drawProb,
            awayWinProb: bestPrediction.awayWinProb,
            predictedHomeGoals: bestPrediction.predictedHomeGoals,
            predictedAwayGoals: bestPrediction.predictedAwayGoals,
            confidence: bestPrediction.confidence,
            keyFactors: bestPrediction.keyFactors,
            riskFactors: bestPrediction.riskFactors,
            valueBets: bestPrediction.valueBets,
            detailedAnalysis: bestPrediction.detailedAnalysis,
            matchContext: bestPrediction.matchContext,
            researchContext: bestPrediction.researchContext,
            modelVersion: bestPrediction.modelVersion,
            actualResult: bestPrediction.actualResult,
            wasCorrect: bestPrediction.wasCorrect,
            probabilityAccuracy: bestPrediction.probabilityAccuracy,
            resolvedAt: bestPrediction.resolvedAt,
            createdAt: bestPrediction.createdAt,
            updatedAt: bestPrediction.updatedAt,
          }
        : null,
      allPredictions: predictions.map((p: any) => ({
        id: p.id,
        predictionType: p.predictionType,
        homeWinProb: p.homeWinProb,
        drawProb: p.drawProb,
        awayWinProb: p.awayWinProb,
        predictedHomeGoals: p.predictedHomeGoals,
        predictedAwayGoals: p.predictedAwayGoals,
        confidence: p.confidence,
        keyFactors: p.keyFactors,
        actualResult: p.actualResult,
        wasCorrect: p.wasCorrect,
        resolvedAt: p.resolvedAt,
        createdAt: p.createdAt,
      })),
    };
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
  async getTeamById(
    teamId: number,
  ): Promise<{ team: any; form: any[] } | null> {
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
   * Get a team's match history with results and statistics.
   * Returns completed fixtures (FT/AET/PEN) for the team, ordered by date desc,
   * with match stats (xG, shots, possession) joined in.
   *
   * Used for frontend graph data (goals over time, form charts, xG trends).
   */
  async getTeamMatchHistory(
    teamId: number,
    options?: {
      leagueId?: number;
      limit?: number;
      offset?: number;
    },
  ): Promise<{
    team: any;
    matches: any[];
    total: number;
  }> {
    const limit = options?.limit ?? 30;
    const offset = options?.offset ?? 0;

    // Get team info
    const teamRows = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .limit(1);

    const team = teamRows?.[0];
    if (!team) return { team: null, matches: [], total: 0 };

    // Build conditions for completed fixtures involving this team
    const conditions: any[] = [
      sql`(${schema.fixtures.homeTeamId} = ${teamId} OR ${schema.fixtures.awayTeamId} = ${teamId})`,
      inArray(schema.fixtures.status, ['FT', 'AET', 'PEN']),
    ];

    if (options?.leagueId) {
      conditions.push(eq(schema.fixtures.leagueId, options.leagueId));
    }

    const whereClause = and(...conditions);

    // Get total count
    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.fixtures)
      .where(whereClause);

    const total = Number(countResult?.count ?? 0);

    // Get fixtures
    const fixtures = await this.db
      .select()
      .from(schema.fixtures)
      .where(whereClause)
      .orderBy(desc(schema.fixtures.date))
      .limit(limit)
      .offset(offset);

    if (fixtures.length === 0) {
      return { team, matches: [], total };
    }

    // Batch fetch stats for these fixtures
    const fixtureIds = fixtures.map((f: any) => f.id);
    const stats = await this.db
      .select()
      .from(schema.fixtureStatistics)
      .where(
        sql`${schema.fixtureStatistics.fixtureId} IN (${sql.join(
          fixtureIds.map((id: number) => sql`${id}`),
          sql`, `,
        )})`,
      );

    // Index stats by fixtureId + teamId
    const statsMap = new Map<string, any>();
    for (const s of stats) {
      statsMap.set(`${s.fixtureId}-${s.teamId}`, s);
    }

    // Batch fetch opponent team names
    const opponentIds = new Set<number>();
    for (const f of fixtures) {
      opponentIds.add(f.homeTeamId === teamId ? f.awayTeamId : f.homeTeamId);
    }
    // Also add the team itself for home/away name resolution
    opponentIds.add(teamId);

    const teamNames = await this.db
      .select({
        id: schema.teams.id,
        name: schema.teams.name,
        shortName: schema.teams.shortName,
        logo: schema.teams.logo,
      })
      .from(schema.teams)
      .where(
        sql`${schema.teams.id} IN (${sql.join(
          [...opponentIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const nameMap = new Map<
      number,
      { name: string; shortName: string | null; logo: string | null }
    >();
    for (const t of teamNames) {
      nameMap.set(t.id, {
        name: t.name,
        shortName: t.shortName,
        logo: t.logo,
      });
    }

    // Assemble match history
    const matches = fixtures.map((f: any) => {
      const isHome = f.homeTeamId === teamId;
      const opponentId = isHome ? f.awayTeamId : f.homeTeamId;
      const opponent = nameMap.get(opponentId);
      const goalsFor = isHome ? f.goalsHome : f.goalsAway;
      const goalsAgainst = isHome ? f.goalsAway : f.goalsHome;

      // Determine result from team's perspective
      let result: 'W' | 'D' | 'L' = 'D';
      if (goalsFor > goalsAgainst) result = 'W';
      else if (goalsFor < goalsAgainst) result = 'L';

      // Get this team's stats
      const teamStats = statsMap.get(`${f.id}-${teamId}`);
      const opponentStats = statsMap.get(`${f.id}-${opponentId}`);

      return {
        fixtureId: f.id,
        date: f.date,
        leagueId: f.leagueId,
        leagueName: f.leagueName,
        round: f.round,
        isHome,
        opponent: {
          id: opponentId,
          name: opponent?.name ?? null,
          logo: opponent?.logo ?? null,
        },
        goalsFor,
        goalsAgainst,
        result,
        score: `${f.goalsHome}-${f.goalsAway}`,
        stats: teamStats
          ? {
              possession: teamStats.possession,
              shotsOnGoal: teamStats.shotsOnGoal,
              totalShots: teamStats.totalShots,
              expectedGoals: teamStats.expectedGoals,
              cornerKicks: teamStats.cornerKicks,
              fouls: teamStats.fouls,
              yellowCards: teamStats.yellowCards,
              redCards: teamStats.redCards,
              passesAccurate: teamStats.passesAccurate,
              totalPasses: teamStats.totalPasses,
              passesPct: teamStats.passesPct,
            }
          : null,
        opponentStats: opponentStats
          ? {
              possession: opponentStats.possession,
              expectedGoals: opponentStats.expectedGoals,
              totalShots: opponentStats.totalShots,
            }
          : null,
      };
    });

    return { team, matches, total };
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
   * Proactively rate-limits to 250 req/min (plan allows 300).
   * Handles both HTTP 429 and in-body rate-limit errors with backoff retry.
   */
  private async apiRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    retries: number = 2,
  ): Promise<ApiFootballResponse<T>> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Wait for a rate-limit slot before sending the request
        await this.acquireRateSlot();

        const response = await this.client.get<ApiFootballResponse<T>>(
          endpoint,
          {
            params,
          },
        );

        const body = response.data;

        // API-Football may return errors inside a 200 response
        const errors = body.errors;
        if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
          const errorKeys = Object.keys(errors);
          if (errorKeys.length > 0) {
            const errorMsg = errorKeys
              .map((k) => `${k}: ${errors[k]}`)
              .join('; ');

            // In-body rate-limit error — back off and retry
            const isRateLimit = errorKeys.some(
              (k) => k.toLowerCase() === 'ratelimit',
            );
            if (isRateLimit && attempt < retries) {
              const backoff = Math.pow(2, attempt + 1) * 2000; // 4s, 8s
              this.logger.warn(
                `Rate limited (in-body) on ${endpoint}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`,
              );
              await this.sleep(backoff);
              continue;
            }

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
            const backoff = Math.pow(2, attempt + 1) * 2000; // 4s, 8s
            this.logger.warn(
              `Rate limited (429) on ${endpoint}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`,
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
          // Re-throw in-body rate-limit errors so the for-loop continue above works
          const msg = (error as Error).message ?? '';
          if (msg.includes('rateLimit') && attempt < retries) {
            const backoff = Math.pow(2, attempt + 1) * 2000;
            this.logger.warn(
              `Rate limited (in-body) on ${endpoint}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`,
            );
            await this.sleep(backoff);
            continue;
          }

          this.logger.error(`API request failed: ${endpoint} — ${msg}`);
        }

        throw error;
      }
    }

    // Unreachable in practice, but satisfies TypeScript
    throw new Error(`API request to ${endpoint} exhausted all retries`);
  }

  /**
   * Ensure a team row exists in the teams table (upsert from API response data).
   * This prevents FK violations when inserting fixtures or team_form rows.
   */
  private async ensureTeam(team: {
    id: number;
    name: string;
    logo?: string;
  }): Promise<void> {
    await this.db
      .insert(schema.teams)
      .values({
        id: team.id,
        name: team.name,
        logo: team.logo ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.teams.id,
        set: {
          name: team.name,
          logo: team.logo ?? null,
          updatedAt: new Date(),
        },
      });
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

    // Ensure both teams exist before inserting the fixture (FK constraint)
    await Promise.all([
      this.ensureTeam(teams.home),
      this.ensureTeam(teams.away),
    ]);

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
   *
   * Public + static so that other services (SyncService, controllers, scripts)
   * can call `FootballService.getCurrentSeason()` without duplicating the logic.
   */
  static getCurrentSeason(): number {
    const now = new Date();
    return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  }

  /**
   * Return the season(s) to try when fetching data for a given league.
   *
   * - European leagues: `[europeanSeason]`
   * - Calendar-year leagues (MLS, Liga MX, etc.): `[calendarYear, europeanSeason]`
   *   (calendar year first — more likely to have current data), de-duplicated.
   */
  static getSeasonsForLeague(leagueId: number): number[] {
    const europeanSeason = FootballService.getCurrentSeason();
    const calendarYear = new Date().getFullYear();

    if (
      FootballService.CALENDAR_YEAR_LEAGUES.has(leagueId) &&
      calendarYear !== europeanSeason
    ) {
      return [calendarYear, europeanSeason];
    }

    return [europeanSeason];
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
