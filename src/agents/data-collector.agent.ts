import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { FootballService } from '../football/football.service';
import { OddsService } from '../odds/odds.service';

/**
 * All structured data collected for a single fixture,
 * to be passed to the Research and Analysis agents.
 */
export interface TeamMatchStats {
  fixtureId: number;
  teamId: number;
  shotsOnGoal: number | null;
  shotsOffGoal: number | null;
  totalShots: number | null;
  blockedShots: number | null;
  shotsInsideBox: number | null;
  shotsOutsideBox: number | null;
  fouls: number | null;
  cornerKicks: number | null;
  offsides: number | null;
  possession: number | null;
  yellowCards: number | null;
  redCards: number | null;
  goalkeeperSaves: number | null;
  totalPasses: number | null;
  passesAccurate: number | null;
  passesPct: number | null;
  expectedGoals: number | null;
}

export interface TeamRecentStats {
  teamId: number;
  matchCount: number;
  stats: TeamMatchStats[];
  averages: {
    xG: number;
    xGA: number;
    shotsOnGoal: number;
    shotsOnGoalAgainst: number;
    totalShots: number;
    possession: number;
    passAccuracy: number;
    cornerKicks: number;
  };
}

export interface TeamFormWindowSummary {
  sampleSize: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  pointsPerGame: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  winRate: number;
  unbeatenRate: number;
}

export interface TeamFormWindows {
  last5: TeamFormWindowSummary;
  last10: TeamFormWindowSummary;
}

export interface SeasonRematchContext {
  isSeasonRematch: boolean;
  previousMeeting: {
    fixtureId: number;
    date: string;
    round: string | null;
    homeTeamId: number;
    awayTeamId: number;
    homeGoals: number | null;
    awayGoals: number | null;
    result: 'home_win' | 'away_win' | 'draw' | 'unknown';
    winnerTeamId: number | null;
    wasReverseFixture: boolean;
  } | null;
}

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
  recentStats: {
    home: TeamRecentStats | null;
    away: TeamRecentStats | null;
  };
  formWindows: {
    home: TeamFormWindows | null;
    away: TeamFormWindows | null;
  };
  seasonRematch: SeasonRematchContext;
  /** Quantified player absence impact scores (set by agents.service after data collection) */
  playerImpact?: {
    home: any;
    away: any;
  } | null;
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
      homeRecentStats,
      awayRecentStats,
      homeFormWindows,
      awayFormWindows,
      seasonRematch,
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
      this.getTeamRecentStats(fixture.homeTeamId, fixtureId, fixture.leagueId),
      this.getTeamRecentStats(fixture.awayTeamId, fixtureId, fixture.leagueId),
      this.getTeamFormWindows(fixture.homeTeamId, fixtureId, fixture.leagueId),
      this.getTeamFormWindows(fixture.awayTeamId, fixtureId, fixture.leagueId),
      this.getSeasonRematchContext(fixture),
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
      recentStats: {
        home: this.unwrap(homeRecentStats),
        away: this.unwrap(awayRecentStats),
      },
      formWindows: {
        home: this.unwrap(homeFormWindows),
        away: this.unwrap(awayFormWindows),
      },
      seasonRematch: this.unwrap(seasonRematch) ?? {
        isSeasonRematch: false,
        previousMeeting: null,
      },
    };

    this.logger.log(
      `Data collected for fixture ${fixtureId}: ` +
        `h2h=${result.h2h.length}, injuries=${result.injuries.length}, ` +
        `lineups=${result.lineups.length}, odds_consensus=${result.odds.consensus.length}, ` +
        `homeStats=${result.recentStats.home?.matchCount ?? 0}, awayStats=${result.recentStats.away?.matchCount ?? 0}, ` +
        `seasonRematch=${result.seasonRematch.isSeasonRematch}`,
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
        `External prediction not available for fixture ${fixtureId}`,
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

      return injuries.filter((inj: any) =>
        this.isConfirmedUnavailable(inj.type, inj.reason),
      );
    } catch (error) {
      this.logger.warn(`Injuries fetch failed: ${error.message}`);
      return [];
    }
  }

  private isConfirmedUnavailable(
    type: string | null,
    reason: string | null,
  ): boolean {
    const t = String(type ?? '').toLowerCase();
    const r = String(reason ?? '').toLowerCase();

    if (!t && !r) return false;

    if (
      t.includes('questionable') ||
      t.includes('doubtful') ||
      t.includes('probable') ||
      t.includes('fitness')
    ) {
      return false;
    }

    if (
      t.includes('missing') ||
      t.includes('out') ||
      t.includes('suspended') ||
      t.includes('ban')
    ) {
      return true;
    }

    // Fallback when provider omits type but reason clearly confirms absence.
    if (r.includes('suspended') || r.includes('ban')) {
      return true;
    }

    return false;
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
      // Use the pre-linked oddsApiEventId on the fixture (set by the proper
      // fuzzy matching in OddsService.matchEventToFixture during odds sync).
      // This replaces the previous fragile substring-based team name matching.
      const eventId = fixture.oddsApiEventId;

      if (!eventId) {
        this.logger.debug(
          `Fixture ${fixture.id} has no linked oddsApiEventId — no odds available`,
        );
        return { consensus: [], bookmakers: [] };
      }

      // Get consensus odds for this event
      const consensus = await this.db
        .select()
        .from(schema.consensusOdds)
        .where(eq(schema.consensusOdds.oddsApiEventId, eventId))
        .orderBy(desc(schema.consensusOdds.calculatedAt));

      // Get bookmaker odds
      let bookmakers: any[] = [];
      if (consensus.length > 0) {
        bookmakers = await this.oddsService.getOddsForEvent(eventId);
      }

      return { consensus, bookmakers };
    } catch (error) {
      this.logger.warn(`Odds fetch for fixture failed: ${error.message}`);
      return { consensus: [], bookmakers: [] };
    }
  }

  /**
   * Build overall-form windows from completed league matches only.
   */
  private async getTeamFormWindows(
    teamId: number,
    currentFixtureId: number,
    leagueId: number,
  ): Promise<TeamFormWindows | null> {
    try {
      const recentFixtures = await this.db
        .select()
        .from(schema.fixtures)
        .where(
          and(
            sql`(${schema.fixtures.homeTeamId} = ${teamId} OR ${schema.fixtures.awayTeamId} = ${teamId})`,
            eq(schema.fixtures.status, 'FT'),
            eq(schema.fixtures.leagueId, leagueId),
            sql`${schema.fixtures.id} != ${currentFixtureId}`,
          ),
        )
        .orderBy(desc(schema.fixtures.date))
        .limit(10);

      if (recentFixtures.length === 0) return null;

      const summarize = (fixtures: any[]): TeamFormWindowSummary => {
        let wins = 0;
        let draws = 0;
        let losses = 0;
        let goalsFor = 0;
        let goalsAgainst = 0;

        for (const f of fixtures) {
          const isHome = f.homeTeamId === teamId;
          const gf = Number(isHome ? f.goalsHome : f.goalsAway) || 0;
          const ga = Number(isHome ? f.goalsAway : f.goalsHome) || 0;

          goalsFor += gf;
          goalsAgainst += ga;

          if (gf > ga) wins++;
          else if (gf < ga) losses++;
          else draws++;
        }

        const sampleSize = fixtures.length;
        const points = wins * 3 + draws;

        return {
          sampleSize,
          wins,
          draws,
          losses,
          points,
          pointsPerGame:
            sampleSize > 0 ? Number((points / sampleSize).toFixed(2)) : 0,
          goalsFor,
          goalsAgainst,
          goalDiff: goalsFor - goalsAgainst,
          winRate: sampleSize > 0 ? Number((wins / sampleSize).toFixed(2)) : 0,
          unbeatenRate:
            sampleSize > 0
              ? Number(((wins + draws) / sampleSize).toFixed(2))
              : 0,
        };
      };

      return {
        last5: summarize(recentFixtures.slice(0, 5)),
        last10: summarize(recentFixtures),
      };
    } catch (error) {
      this.logger.warn(
        `Form windows fetch failed for team ${teamId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Detects whether this is a same-competition, same-season rematch,
   * and returns the latest prior meeting context.
   */
  private async getSeasonRematchContext(
    fixture: any,
  ): Promise<SeasonRematchContext> {
    try {
      if (!fixture?.season) {
        return { isSeasonRematch: false, previousMeeting: null };
      }

      const previousRows = await this.db
        .select()
        .from(schema.fixtures)
        .where(
          and(
            eq(schema.fixtures.leagueId, fixture.leagueId),
            eq(schema.fixtures.season, fixture.season),
            sql`${schema.fixtures.id} != ${fixture.id}`,
            sql`${schema.fixtures.date} < ${fixture.date}`,
            sql`(
              (${schema.fixtures.homeTeamId} = ${fixture.homeTeamId} AND ${schema.fixtures.awayTeamId} = ${fixture.awayTeamId}) OR
              (${schema.fixtures.homeTeamId} = ${fixture.awayTeamId} AND ${schema.fixtures.awayTeamId} = ${fixture.homeTeamId})
            )`,
          ),
        )
        .orderBy(desc(schema.fixtures.date))
        .limit(1);

      const previous = previousRows?.[0];
      if (!previous) {
        return { isSeasonRematch: false, previousMeeting: null };
      }

      const homeGoals = previous.goalsHome;
      const awayGoals = previous.goalsAway;

      let result: 'home_win' | 'away_win' | 'draw' | 'unknown' = 'unknown';
      let winnerTeamId: number | null = null;

      if (homeGoals != null && awayGoals != null) {
        if (homeGoals > awayGoals) {
          result = 'home_win';
          winnerTeamId = previous.homeTeamId;
        } else if (awayGoals > homeGoals) {
          result = 'away_win';
          winnerTeamId = previous.awayTeamId;
        } else {
          result = 'draw';
        }
      }

      return {
        isSeasonRematch: true,
        previousMeeting: {
          fixtureId: previous.id,
          date: new Date(previous.date).toISOString(),
          round: previous.round ?? null,
          homeTeamId: previous.homeTeamId,
          awayTeamId: previous.awayTeamId,
          homeGoals,
          awayGoals,
          result,
          winnerTeamId,
          wasReverseFixture:
            previous.homeTeamId === fixture.awayTeamId &&
            previous.awayTeamId === fixture.homeTeamId,
        },
      };
    } catch (error) {
      this.logger.warn(
        `Season rematch context failed for fixture ${fixture?.id}: ${error.message}`,
      );
      return { isSeasonRematch: false, previousMeeting: null };
    }
  }

  /**
   * Fetch the last N matches' statistics for a team from fixture_statistics.
   * Computes rolling averages for xG, shots, possession, pass accuracy, etc.
   * Also computes xGA (expected goals against) by looking up opponent stats in the same fixtures.
   */
  private async getTeamRecentStats(
    teamId: number,
    currentFixtureId: number,
    leagueId: number,
    matchCount: number = 10,
  ): Promise<TeamRecentStats> {
    try {
      // Get the team's recent fixture stats — filtered by league to avoid
      // cross-competition contamination (cup matches, continental fixtures)
      const recentStats = await this.db
        .select({
          stat: schema.fixtureStatistics,
          fixture: schema.fixtures,
        })
        .from(schema.fixtureStatistics)
        .innerJoin(
          schema.fixtures,
          eq(schema.fixtureStatistics.fixtureId, schema.fixtures.id),
        )
        .where(
          and(
            eq(schema.fixtureStatistics.teamId, teamId),
            eq(schema.fixtures.status, 'FT'),
            eq(schema.fixtures.leagueId, leagueId),
            sql`${schema.fixtureStatistics.fixtureId} != ${currentFixtureId}`,
          ),
        )
        .orderBy(desc(schema.fixtures.date))
        .limit(matchCount);

      if (recentStats.length === 0) {
        return {
          teamId,
          matchCount: 0,
          stats: [],
          averages: {
            xG: 0,
            xGA: 0,
            shotsOnGoal: 0,
            shotsOnGoalAgainst: 0,
            totalShots: 0,
            possession: 0,
            passAccuracy: 0,
            cornerKicks: 0,
          },
        };
      }

      // Get opponent stats for xGA calculation (opponent's xG in same fixtures)
      const fixtureIds = recentStats.map((r: any) => r.stat.fixtureId);
      const opponentStats = await this.db
        .select()
        .from(schema.fixtureStatistics)
        .where(
          and(
            sql`${schema.fixtureStatistics.fixtureId} IN (${sql.join(
              fixtureIds.map((id: number) => sql`${id}`),
              sql`, `,
            )})`,
            sql`${schema.fixtureStatistics.teamId} != ${teamId}`,
          ),
        );

      // Build a map of fixtureId -> opponent stats
      const opponentStatsMap = new Map<number, any>();
      for (const os of opponentStats) {
        opponentStatsMap.set(os.fixtureId, os);
      }

      const stats: TeamMatchStats[] = recentStats.map((r: any) => ({
        fixtureId: r.stat.fixtureId,
        teamId: r.stat.teamId,
        shotsOnGoal: r.stat.shotsOnGoal,
        shotsOffGoal: r.stat.shotsOffGoal,
        totalShots: r.stat.totalShots,
        blockedShots: r.stat.blockedShots,
        shotsInsideBox: r.stat.shotsInsideBox,
        shotsOutsideBox: r.stat.shotsOutsideBox,
        fouls: r.stat.fouls,
        cornerKicks: r.stat.cornerKicks,
        offsides: r.stat.offsides,
        possession: r.stat.possession ? Number(r.stat.possession) : null,
        yellowCards: r.stat.yellowCards,
        redCards: r.stat.redCards,
        goalkeeperSaves: r.stat.goalkeeperSaves,
        totalPasses: r.stat.totalPasses,
        passesAccurate: r.stat.passesAccurate,
        passesPct: r.stat.passesPct ? Number(r.stat.passesPct) : null,
        expectedGoals: r.stat.expectedGoals
          ? Number(r.stat.expectedGoals)
          : null,
      }));

      // Compute averages
      const validXG = stats.filter((s) => s.expectedGoals != null);
      const validShots = stats.filter((s) => s.shotsOnGoal != null);
      const validTotalShots = stats.filter((s) => s.totalShots != null);
      const validPossession = stats.filter((s) => s.possession != null);
      const validPassAcc = stats.filter((s) => s.passesPct != null);
      const validCorners = stats.filter((s) => s.cornerKicks != null);

      // xGA: average of opponent's xG in these fixtures
      const opponentXGs = fixtureIds
        .map((fid: number) => {
          const os = opponentStatsMap.get(fid);
          return os?.expectedGoals ? Number(os.expectedGoals) : null;
        })
        .filter((v: number | null): v is number => v != null);

      // Opponent shots on goal against this team
      const opponentShotsOnGoal = fixtureIds
        .map((fid: number) => {
          const os = opponentStatsMap.get(fid);
          return os?.shotsOnGoal ?? null;
        })
        .filter((v: number | null): v is number => v != null);

      const avg = (arr: number[]) =>
        arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      return {
        teamId,
        matchCount: stats.length,
        stats,
        averages: {
          xG: Number(avg(validXG.map((s) => s.expectedGoals!)).toFixed(2)),
          xGA: Number(avg(opponentXGs).toFixed(2)),
          shotsOnGoal: Number(
            avg(validShots.map((s) => s.shotsOnGoal!)).toFixed(1),
          ),
          shotsOnGoalAgainst: Number(avg(opponentShotsOnGoal).toFixed(1)),
          totalShots: Number(
            avg(validTotalShots.map((s) => s.totalShots!)).toFixed(1),
          ),
          possession: Number(
            avg(validPossession.map((s) => s.possession!)).toFixed(1),
          ),
          passAccuracy: Number(
            avg(validPassAcc.map((s) => s.passesPct!)).toFixed(1),
          ),
          cornerKicks: Number(
            avg(validCorners.map((s) => s.cornerKicks!)).toFixed(1),
          ),
        },
      };
    } catch (error) {
      this.logger.warn(
        `Recent stats fetch failed for team ${teamId}: ${error.message}`,
      );
      return {
        teamId,
        matchCount: 0,
        stats: [],
        averages: {
          xG: 0,
          xGA: 0,
          shotsOnGoal: 0,
          shotsOnGoalAgainst: 0,
          totalShots: 0,
          possession: 0,
          passAccuracy: 0,
          cornerKicks: 0,
        },
      };
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
