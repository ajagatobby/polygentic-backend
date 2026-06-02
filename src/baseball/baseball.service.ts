import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { and, asc, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BaseballTeamMapService } from './baseball-team-map.service';

interface ApiBaseballResponse<T = any> {
  get: string;
  parameters: Record<string, string>;
  errors: Record<string, string> | any[];
  results: number;
  response: T[];
}

/** Statuses that mean a game has a final result. */
export const BASEBALL_COMPLETED_STATUSES = ['FT', 'AET'];
/** Statuses that void a prediction (no result will come). */
export const BASEBALL_VOID_STATUSES = ['CANC', 'PST', 'ABD', 'SUSP'];

/**
 * API-Sports baseball client (league 1 = MLB). Mirrors BasketballService:
 * same `x-apisports-key` auth, daily-quota limiter, retry/backoff. Baseball
 * is calendar-year seasoned, so season = current year.
 *
 * Note: API-Sports baseball has NO pitcher/lineup/box-score data — those
 * come from MlbStatsService + StatcastService. This service owns schedule,
 * scores, and resolution only.
 */
@Injectable()
export class BaseballService {
  private readonly logger = new Logger(BaseballService.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly mlbLeagueId: number;

  private static dailyRequestCount = 0;
  private static dailyLimitDate = '';
  private readonly dailyLimit: number;

  constructor(
    private readonly config: ConfigService,
    @Inject('DRIZZLE') private db: any,
    private readonly teamMap: BaseballTeamMapService,
  ) {
    this.baseUrl =
      this.config.get<string>('API_BASEBALL_BASE_URL') ||
      'https://v1.baseball.api-sports.io';
    this.dailyLimit = this.config.get<number>('API_BASEBALL_DAILY_LIMIT', 7500);
    this.mlbLeagueId = this.config.get<number>('API_BASEBALL_MLB_LEAGUE_ID', 1);

    const key =
      this.config.get<string>('API_BASEBALL_KEY') ||
      this.config.get<string>('API_FOOTBALL_KEY');

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: { 'x-apisports-key': key },
    });
  }

  // ─── Rate limiter ────────────────────────────────────────────────────

  private acquireDailySlot(): void {
    const todayUTC = new Date().toISOString().split('T')[0];
    if (BaseballService.dailyLimitDate !== todayUTC) {
      BaseballService.dailyRequestCount = 0;
      BaseballService.dailyLimitDate = todayUTC;
    }
    if (BaseballService.dailyRequestCount >= this.dailyLimit) {
      throw new Error(
        `API-Baseball daily limit exhausted (${this.dailyLimit}/day). ` +
          `Resets midnight UTC. Set API_BASEBALL_DAILY_LIMIT to raise it.`,
      );
    }
    BaseballService.dailyRequestCount++;
  }

  getRemainingRequests(): { used: number; remaining: number; limit: number } {
    const todayUTC = new Date().toISOString().split('T')[0];
    if (BaseballService.dailyLimitDate !== todayUTC) {
      return { used: 0, remaining: this.dailyLimit, limit: this.dailyLimit };
    }
    return {
      used: BaseballService.dailyRequestCount,
      remaining: Math.max(0, this.dailyLimit - BaseballService.dailyRequestCount),
      limit: this.dailyLimit,
    };
  }

  /** MLB is calendar-year seasoned (Apr–Oct). */
  static getCurrentSeason(): number {
    return new Date().getFullYear();
  }

  // ─── SYNC ────────────────────────────────────────────────────────────

  /**
   * Sync MLB games. With no `date`, fetches the season's upcoming games;
   * with a `date` (YYYY-MM-DD), fetches that day (used for completed-game
   * sweeps). Upserts into baseball_games.
   */
  async syncGames(date?: string): Promise<number> {
    const season = BaseballService.getCurrentSeason();
    const params: Record<string, string> = {
      league: String(this.mlbLeagueId),
      season: String(season),
      timezone: 'UTC',
    };
    if (date) params.date = date;

    this.logger.log(
      `Syncing MLB games (season ${season}${date ? `, date ${date}` : ''})`,
    );

    let upserted = 0;
    try {
      const data = await this.apiRequest<any>('/games', params);
      for (const item of data.response ?? []) {
        await this.upsertGame(item);
        upserted++;
      }
    } catch (err) {
      this.logger.error(`syncGames failed: ${(err as Error).message}`);
    }
    this.logger.log(`MLB games sync complete — ${upserted} upserted`);
    return upserted;
  }

  /** Sweep the last 2 days + today to capture final scores for resolution. */
  async syncCompletedGames(): Promise<number> {
    const now = new Date();
    let total = 0;
    for (let dayOffset = 2; dayOffset >= 0; dayOffset--) {
      const d = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      total += await this.syncGames(d.toISOString().split('T')[0]);
    }
    return total;
  }

  private async ensureTeam(team: {
    id: number;
    name: string;
    logo?: string;
  }): Promise<void> {
    await this.db
      .insert(schema.baseballTeams)
      .values({
        id: team.id,
        name: team.name,
        logo: team.logo ?? null,
        leagueId: this.mlbLeagueId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.baseballTeams.id,
        set: { name: team.name, logo: team.logo ?? null, updatedAt: new Date() },
      });
  }

  /**
   * Upsert one API-Sports baseball game. Response shape:
   * {
   *   id, date, time, timestamp, timezone, week,
   *   status: { long, short },
   *   country, league: { id, name, season },
   *   teams: { home: {id,name,logo}, away: {...} },
   *   scores: { home: { hits, errors, innings: {1..9, extra}, total }, away: {...} }
   * }
   */
  private async upsertGame(item: any): Promise<void> {
    const teams = item.teams;
    const scores = item.scores;
    const league = item.league;
    const status = item.status;
    if (!teams?.home?.id || !teams?.away?.id) return;

    await Promise.all([
      this.ensureTeam(teams.home),
      this.ensureTeam(teams.away),
    ]);

    // Reconcile both teams to MLBAM (fills baseball_team_map.apiSportsTeamId).
    await Promise.all([
      this.teamMap.reconcileApiSportsTeam(teams.home.id, teams.home.name),
      this.teamMap.reconcileApiSportsTeam(teams.away.id, teams.away.name),
    ]);

    const inningScores = this.buildInningScores(scores);
    const values = {
      id: item.id,
      leagueId: league?.id ?? this.mlbLeagueId,
      leagueName: league?.name ?? 'MLB',
      season:
        typeof league?.season === 'number'
          ? league.season
          : parseInt(String(league?.season), 10) ||
            BaseballService.getCurrentSeason(),
      homeTeamId: teams.home.id,
      awayTeamId: teams.away.id,
      date: new Date(item.date),
      timestamp: item.timestamp ?? null,
      venueName: item.venue ?? null,
      status: status?.short ?? 'NS',
      statusLong: status?.long ?? null,
      runsHome: scores?.home?.total ?? null,
      runsAway: scores?.away?.total ?? null,
      inningScores,
      rawData: item,
      updatedAt: new Date(),
    };

    await this.db
      .insert(schema.baseballGames)
      .values(values)
      .onConflictDoUpdate({
        target: schema.baseballGames.id,
        set: {
          date: values.date,
          timestamp: values.timestamp,
          status: values.status,
          statusLong: values.statusLong,
          runsHome: values.runsHome,
          runsAway: values.runsAway,
          inningScores: values.inningScores,
          rawData: values.rawData,
          updatedAt: new Date(),
        },
      });
  }

  private buildInningScores(scores: any): any[] | null {
    if (!scores?.home?.innings && !scores?.away?.innings) return null;
    const home = scores?.home?.innings ?? {};
    const away = scores?.away?.innings ?? {};
    const keys = new Set([...Object.keys(home), ...Object.keys(away)]);
    const out: any[] = [];
    for (const k of keys) {
      out.push({ inning: k, home: home[k] ?? null, away: away[k] ?? null });
    }
    return out.length ? out : null;
  }

  // ─── QUERIES ─────────────────────────────────────────────────────────

  /** Upcoming MLB games within `hoursAhead` (default 48h), NS status. */
  async getUpcomingGames(hoursAhead = 48): Promise<any[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    return this.db
      .select()
      .from(schema.baseballGames)
      .where(
        and(
          eq(schema.baseballGames.status, 'NS'),
          gte(schema.baseballGames.date, now),
          lte(schema.baseballGames.date, cutoff),
        ),
      )
      .orderBy(asc(schema.baseballGames.date));
  }

  async getGameById(gameId: number): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(schema.baseballGames)
      .where(eq(schema.baseballGames.id, gameId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Completed games for a team (most recent first) — for run-rate estimation. */
  async getRecentCompletedForTeam(teamId: number, limit = 25): Promise<any[]> {
    return this.db
      .select()
      .from(schema.baseballGames)
      .where(
        and(
          inArray(schema.baseballGames.status, BASEBALL_COMPLETED_STATUSES),
          or(
            eq(schema.baseballGames.homeTeamId, teamId),
            eq(schema.baseballGames.awayTeamId, teamId),
          ),
        ),
      )
      .orderBy(desc(schema.baseballGames.date))
      .limit(limit);
  }

  /** Games needing resolution: pending prediction + final/void status. */
  async getResolvableGames(): Promise<any[]> {
    return this.db
      .select()
      .from(schema.baseballGames)
      .where(
        inArray(schema.baseballGames.status, [
          ...BASEBALL_COMPLETED_STATUSES,
          ...BASEBALL_VOID_STATUSES,
        ]),
      );
  }

  async setGamePk(
    gameId: number,
    patch: {
      gamePk?: number;
      homeProbablePitcherId?: number;
      awayProbablePitcherId?: number;
      lineupsConfirmed?: boolean;
      weather?: any;
      oddsApiEventId?: string;
    },
  ): Promise<void> {
    await this.db
      .update(schema.baseballGames)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.baseballGames.id, gameId));
  }

  // ─── HTTP ────────────────────────────────────────────────────────────

  private async apiRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    retries = 3,
  ): Promise<ApiBaseballResponse<T>> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        this.acquireDailySlot();
        const response = await this.client.get<ApiBaseballResponse<T>>(
          endpoint,
          { params },
        );
        const errors = response.data.errors;
        if (errors && !Array.isArray(errors) && Object.keys(errors).length > 0) {
          const msg = JSON.stringify(errors);
          if (msg.includes('rateLimit') && attempt < retries - 1) {
            await this.sleep(Math.pow(2, attempt + 1) * 2000);
            continue;
          }
          throw new Error(`API-Baseball error: ${msg}`);
        }
        return response.data;
      } catch (error) {
        if ((error as Error).message?.includes('daily limit exhausted')) {
          throw error;
        }
        if (error instanceof AxiosError) {
          if (error.response?.status === 429 && attempt < retries - 1) {
            await this.sleep(Math.pow(2, attempt + 1) * 2000);
            continue;
          }
          this.logger.error(
            `API request failed: ${endpoint} — ${error.message} (status ${error.response?.status})`,
          );
        } else {
          this.logger.error(
            `API request failed: ${endpoint} — ${(error as Error).message}`,
          );
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
