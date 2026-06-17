import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface ProbablePitcher {
  mlbamId: number;
  name: string;
  throws?: string;
}

export interface MlbScheduleGame {
  gamePk: number;
  gameDate: string; // ISO
  homeTeamMlbamId: number;
  awayTeamMlbamId: number;
  homeTeamName: string;
  awayTeamName: string;
  venueName: string | null;
  homeProbable: ProbablePitcher | null;
  awayProbable: ProbablePitcher | null;
}

export interface GameWeather {
  tempF: number | null;
  condition: string | null;
  windMph: number | null;
  windDir: string | null; // e.g. "Out To CF", "In From LF"
}

/**
 * Free official MLB StatsAPI adapter (no key). Source of truth for the
 * data API-Sports lacks: probable starting pitchers, confirmed lineups,
 * weather. Cache aggressively — it's public but we hit it per-game daily.
 */
@Injectable()
export class MlbStatsService {
  private readonly logger = new Logger(MlbStatsService.name);
  private readonly client: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL:
        this.config.get<string>('MLB_STATS_BASE_URL') ||
        'https://statsapi.mlb.com',
      timeout: 15_000,
    });
  }

  /**
   * Schedule for a date with probable pitchers hydrated. Returns one entry
   * per game with MLBAM team ids + gamePk so callers can join to
   * baseball_games via the team map.
   */
  async getSchedule(date: string): Promise<MlbScheduleGame[]> {
    try {
      const { data } = await this.client.get('/api/v1/schedule', {
        params: {
          sportId: 1,
          date,
          hydrate: 'probablePitcher,team',
        },
      });
      const out: MlbScheduleGame[] = [];
      for (const day of data?.dates ?? []) {
        for (const g of day?.games ?? []) {
          const home = g?.teams?.home;
          const away = g?.teams?.away;
          if (!home?.team?.id || !away?.team?.id) continue;
          out.push({
            gamePk: g.gamePk,
            gameDate: g.gameDate,
            homeTeamMlbamId: home.team.id,
            awayTeamMlbamId: away.team.id,
            homeTeamName: home.team.name,
            awayTeamName: away.team.name,
            venueName: g?.venue?.name ?? null,
            homeProbable: this.parseProbable(home?.probablePitcher),
            awayProbable: this.parseProbable(away?.probablePitcher),
          });
        }
      }
      return out;
    } catch (err) {
      this.logger.warn(`getSchedule(${date}) failed: ${(err as Error).message}`);
      return [];
    }
  }

  private parseProbable(p: any): ProbablePitcher | null {
    if (!p?.id) return null;
    return { mlbamId: p.id, name: p.fullName ?? p.fullFMLName ?? 'Unknown' };
  }

  /** Pitcher handedness + bio. */
  async getPitcherHand(mlbamId: number): Promise<string | null> {
    try {
      const { data } = await this.client.get(`/api/v1/people/${mlbamId}`);
      return data?.people?.[0]?.pitchHand?.code ?? null;
    } catch (err) {
      this.logger.warn(
        `getPitcherHand(${mlbamId}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Season pitching stats (fallback when Statcast unavailable). */
  async getPitcherSeasonStats(
    mlbamId: number,
    season = new Date().getFullYear(),
  ): Promise<any | null> {
    try {
      const { data } = await this.client.get(`/api/v1/people/${mlbamId}`, {
        params: {
          hydrate: `stats(group=[pitching],type=[season],season=${season})`,
        },
      });
      const splits = data?.people?.[0]?.stats?.[0]?.splits ?? [];
      return splits[0]?.stat ?? null;
    } catch (err) {
      this.logger.warn(
        `getPitcherSeasonStats(${mlbamId}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Weather + confirmed-lineup flag from the live feed gameData. */
  async getGameContext(
    gamePk: number,
  ): Promise<{ weather: GameWeather; lineupsConfirmed: boolean }> {
    const empty: GameWeather = {
      tempF: null,
      condition: null,
      windMph: null,
      windDir: null,
    };
    try {
      const { data } = await this.client.get(
        `/api/v1.1/game/${gamePk}/feed/live`,
      );
      const w = data?.gameData?.weather ?? {};
      const wind: string = w?.wind ?? ''; // e.g. "8 mph, Out To CF"
      const windMph = wind ? parseFloat(wind) : null;
      const windDir = wind.includes(',')
        ? wind.split(',').slice(1).join(',').trim()
        : null;
      const lineups = data?.liveData?.boxscore?.teams;
      const lineupsConfirmed =
        (lineups?.home?.battingOrder?.length ?? 0) >= 9 &&
        (lineups?.away?.battingOrder?.length ?? 0) >= 9;
      return {
        weather: {
          tempF: w?.temp ? parseFloat(w.temp) : null,
          condition: w?.condition ?? null,
          windMph: Number.isFinite(windMph) ? windMph : null,
          windDir,
        },
        lineupsConfirmed,
      };
    } catch (err) {
      this.logger.warn(
        `getGameContext(${gamePk}) failed: ${(err as Error).message}`,
      );
      return { weather: empty, lineupsConfirmed: false };
    }
  }
}
