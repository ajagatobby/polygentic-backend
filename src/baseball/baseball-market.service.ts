import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BaseballTeamMapService } from './baseball-team-map.service';

export interface MarketTotal {
  totalLine: number;
  overImpliedProb: number; // vig-removed
  bookmaker: string;
  capturedAt: Date;
}

/** Books we trust most for a sharp total, in priority order. */
const SHARP_BOOKS = ['pinnacle', 'betfair_ex_eu', 'circasports', 'lowvig'];

/**
 * The Odds API adapter for MLB run totals. The sharp closing total is the
 * strongest single predictor and the CLV benchmark, so we snapshot lines
 * over time (open→close drift) into baseball_market_lines.
 */
@Injectable()
export class BaseballMarketService {
  private readonly logger = new Logger(BaseballMarketService.name);
  private readonly client: AxiosInstance;
  private readonly apiKey: string;
  private readonly regions: string;

  constructor(
    private readonly config: ConfigService,
    @Inject('DRIZZLE') private db: any,
    private readonly teamMap: BaseballTeamMapService,
  ) {
    this.apiKey = this.config.get<string>('ODDS_API_KEY') || '';
    this.regions = this.config.get<string>('ODDS_API_REGIONS') || 'us,eu';
    this.client = axios.create({
      baseURL:
        this.config.get<string>('ODDS_API_BASE_URL') ||
        'https://api.the-odds-api.com',
      timeout: 15_000,
    });
  }

  /**
   * Fetch MLB totals from The Odds API and snapshot a sharp line per upcoming
   * game (matched to baseball_games via team map + date). Returns # snapshots.
   */
  async syncMarketTotals(): Promise<number> {
    if (!this.apiKey) {
      this.logger.warn('ODDS_API_KEY not set — skipping market totals sync');
      return 0;
    }
    await this.refreshReverseIndex();
    let events: any[];
    try {
      const { data } = await this.client.get(
        '/v4/sports/baseball_mlb/odds',
        {
          params: {
            apiKey: this.apiKey,
            regions: this.regions,
            markets: 'totals',
            oddsFormat: 'decimal',
          },
        },
      );
      events = data ?? [];
    } catch (err) {
      this.logger.warn(`syncMarketTotals failed: ${(err as Error).message}`);
      return 0;
    }

    let snapshots = 0;
    for (const ev of events) {
      const gameId = await this.matchEventToGame(ev);
      if (!gameId) continue;
      const sharp = this.pickSharpTotal(ev);
      if (!sharp) continue;
      await this.db.insert(schema.baseballMarketLines).values({
        gameId,
        bookmaker: sharp.bookmaker,
        totalLine: String(sharp.totalLine),
        overImpliedProb: String(sharp.overImpliedProb.toFixed(4)),
        capturedAt: new Date(),
      });
      snapshots++;
    }
    this.logger.log(`Snapshotted ${snapshots} MLB market totals`);
    return snapshots;
  }

  /** Most recent sharp total snapshot for a game. */
  async getLatestTotal(gameId: number): Promise<MarketTotal | null> {
    const rows = await this.db
      .select()
      .from(schema.baseballMarketLines)
      .where(eq(schema.baseballMarketLines.gameId, gameId))
      .orderBy(desc(schema.baseballMarketLines.capturedAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      totalLine: Number(r.totalLine),
      overImpliedProb: r.overImpliedProb != null ? Number(r.overImpliedProb) : 0.5,
      bookmaker: r.bookmaker,
      capturedAt: new Date(r.capturedAt),
    };
  }

  // ─── internals ─────────────────────────────────────────────────────

  /** Resolve an Odds API event to a baseball_games.id via teams + date. */
  private async matchEventToGame(ev: any): Promise<number | null> {
    const home = this.teamMap.resolve(ev.home_team ?? '');
    const away = this.teamMap.resolve(ev.away_team ?? '');
    if (!home || !away) return null;
    const homeApi = this.apiSportsIdFor(home.mlbamTeamId);
    const awayApi = this.apiSportsIdFor(away.mlbamTeamId);
    if (!homeApi || !awayApi) return null;

    const commence = new Date(ev.commence_time);
    const lo = new Date(commence.getTime() - 36 * 60 * 60 * 1000);
    const hi = new Date(commence.getTime() + 36 * 60 * 60 * 1000);

    const rows = await this.db
      .select()
      .from(schema.baseballGames)
      .where(
        and(
          eq(schema.baseballGames.homeTeamId, homeApi),
          eq(schema.baseballGames.awayTeamId, awayApi),
          gte(schema.baseballGames.date, lo),
          lte(schema.baseballGames.date, hi),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private cachedReverse = new Map<number, number>();

  /** MLBAM team id → API-Sports team id, from the reverse index. */
  private apiSportsIdFor(mlbamId: number): number | null {
    return this.cachedReverse.get(mlbamId) ?? null;
  }

  /** Refresh the MLBAM→api-sports reverse index from baseball_team_map. */
  async refreshReverseIndex(): Promise<void> {
    const rows = await this.db.select().from(schema.baseballTeamMap);
    this.cachedReverse.clear();
    for (const r of rows) {
      if (r.apiSportsTeamId != null) {
        this.cachedReverse.set(r.mlbamTeamId, r.apiSportsTeamId);
      }
    }
  }

  /** Choose a sharp book's total + vig-removed over prob from an event. */
  private pickSharpTotal(ev: any): MarketTotal | null {
    const books: any[] = ev.bookmakers ?? [];
    if (!books.length) return null;
    let chosen =
      SHARP_BOOKS.map((k) => books.find((b) => b.key === k)).find(Boolean) ??
      books[0];

    const market = (chosen.markets ?? []).find((m: any) => m.key === 'totals');
    if (!market) return null;
    const over = (market.outcomes ?? []).find((o: any) => /over/i.test(o.name));
    const under = (market.outcomes ?? []).find((o: any) =>
      /under/i.test(o.name),
    );
    if (!over?.price || !under?.price || over.point == null) return null;

    const pOverRaw = 1 / over.price;
    const pUnderRaw = 1 / under.price;
    const overImpliedProb = pOverRaw / (pOverRaw + pUnderRaw); // de-vig
    return {
      totalLine: Number(over.point),
      overImpliedProb,
      bookmaker: chosen.key,
      capturedAt: new Date(),
    };
  }
}
