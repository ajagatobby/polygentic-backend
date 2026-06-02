import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { and, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BaseballTeamMapService } from './baseball-team-map.service';
import { nbPOverAtLine } from './baseball-run-model.service';

export interface BaseballEdge {
  gameId: number;
  matchup: string;
  line: number;
  marketPOver: number;
  modelPOver: number;
  edge: number; // modelPOver - marketPOver (positive ⇒ value on OVER)
  side: 'over' | 'under';
  marketSlug: string;
  conditionId: string | null;
  liquidity: number | null;
  gameDate: string;
}

/**
 * Read-only Polymarket MLB totals edge surfacing (v1 — no trading). Fetches
 * live MLB totals markets from the Gamma API, matches each to a baseball_game
 * + our stored prediction, and computes edge = model P(over) − market P(over).
 * Self-contained to avoid touching the shared (soccer) Polymarket pipeline.
 */
@Injectable()
export class BaseballPolymarketService {
  private readonly logger = new Logger(BaseballPolymarketService.name);
  private readonly gamma: AxiosInstance;

  constructor(
    private readonly config: ConfigService,
    @Inject('DRIZZLE') private db: any,
    private readonly teamMap: BaseballTeamMapService,
  ) {
    this.gamma = axios.create({
      baseURL:
        this.config.get<string>('POLYMARKET_GAMMA_URL') ||
        'https://gamma-api.polymarket.com',
      timeout: 20_000,
    });
  }

  /** Compute edges across all open MLB totals markets matched to our games. */
  async computeEdges(minAbsEdge = 0): Promise<BaseballEdge[]> {
    await this.ensureReverse();
    const events = await this.fetchMlbEvents();
    const edges: BaseballEdge[] = [];

    for (const ev of events) {
      const teams = this.parseTeams(ev.title);
      if (!teams) continue;
      const game = await this.matchGame(teams.a, teams.b, ev.startDate);
      if (!game) continue;

      const pred = await this.getPrediction(game.id);
      if (!pred) continue;
      const expectedTotal = Number(pred.expectedTotal);
      const dispersion = pred.dispersion ? Number(pred.dispersion) : 2.2;

      for (const market of ev.markets ?? []) {
        const parsed = this.parseTotalsMarket(market);
        if (!parsed) continue;

        const modelPOver = this.modelPOverForLine(
          pred,
          parsed.line,
          expectedTotal,
          dispersion,
        );
        const edge = modelPOver - parsed.marketPOver;
        if (Math.abs(edge) < minAbsEdge) continue;

        edges.push({
          gameId: game.id,
          matchup: ev.title,
          line: parsed.line,
          marketPOver: round4(parsed.marketPOver),
          modelPOver: round4(modelPOver),
          edge: round4(edge),
          side: edge > 0 ? 'over' : 'under',
          marketSlug: market.slug ?? ev.slug ?? '',
          conditionId: market.conditionId ?? null,
          liquidity: market.liquidityNum ?? market.liquidity ?? null,
          gameDate: new Date(game.date).toISOString(),
        });
      }
    }

    edges.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    this.logger.log(`Computed ${edges.length} MLB totals edges`);
    return edges;
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async fetchMlbEvents(): Promise<any[]> {
    try {
      const { data } = await this.gamma.get('/events', {
        params: { tag_slug: 'mlb', closed: false, limit: 200 },
      });
      // Keep per-game events (title "Away vs. Home"); drop futures/outrights.
      return (data ?? []).filter((e: any) => /\bvs\.?\b/i.test(e.title ?? ''));
    } catch (err) {
      this.logger.warn(`fetchMlbEvents failed: ${(err as Error).message}`);
      return [];
    }
  }

  private parseTeams(title: string): { a: string; b: string } | null {
    const m = (title ?? '').split(/\s+vs\.?\s+/i);
    if (m.length !== 2) return null;
    return { a: m[0].trim(), b: m[1].split(':')[0].trim() };
  }

  private parseTotalsMarket(
    market: any,
  ): { line: number; marketPOver: number } | null {
    const type = market.sportsMarketType ?? '';
    const q: string = market.question ?? market.groupItemTitle ?? '';
    const isTotals = type === 'totals' || /\bo\/u\b|\bover\b|\btotal\b/i.test(q);
    if (!isTotals) return null;

    // Line from "O/U 8.5" / "Over 8.5".
    const lineMatch = q.match(/(\d+(?:\.\d+)?)/);
    if (!lineMatch) return null;
    const line = Number(lineMatch[1]);
    if (!Number.isFinite(line) || line < 4 || line > 20) return null;

    const outcomes = parseJson(market.outcomes);
    const prices = parseJson(market.outcomePrices)?.map((p: any) => Number(p));
    if (!Array.isArray(outcomes) || !Array.isArray(prices)) return null;
    const overIdx = outcomes.findIndex((o: any) => /over/i.test(String(o)));
    const underIdx = outcomes.findIndex((o: any) => /under/i.test(String(o)));
    if (overIdx < 0 || underIdx < 0) return null;
    const pOver = prices[overIdx];
    const pUnder = prices[underIdx];
    if (!(pOver > 0) || !(pUnder > 0)) return null;
    // De-vig.
    const marketPOver = pOver / (pOver + pUnder);
    return { line, marketPOver };
  }

  private modelPOverForLine(
    pred: any,
    line: number,
    expectedTotal: number,
    dispersion: number,
  ): number {
    const lineProbs = (pred.lineProbs ?? []) as any[];
    const exact = lineProbs.find((l) => Number(l.line) === line);
    if (exact && exact.pOverCalibrated != null) {
      return Number(exact.pOverCalibrated);
    }
    // Off-grid market line → compute from the model's expected total.
    const phi =
      expectedTotal > 0 && dispersion > 0
        ? expectedTotal / dispersion + 1 // recover phi from r = mu/(phi-1)
        : 2.2;
    return nbPOverAtLine(expectedTotal, line, phi);
  }

  private async matchGame(
    teamA: string,
    teamB: string,
    startDate?: string,
  ): Promise<any | null> {
    const sa = this.teamMap.resolve(teamA);
    const sb = this.teamMap.resolve(teamB);
    if (!sa || !sb) return null;
    const apiA = this.apiSportsId(sa.mlbamTeamId);
    const apiB = this.apiSportsId(sb.mlbamTeamId);
    if (!apiA || !apiB) return null;

    const center = startDate ? new Date(startDate) : new Date();
    const lo = new Date(center.getTime() - 36 * 3600 * 1000);
    const hi = new Date(center.getTime() + 36 * 3600 * 1000);

    // Either home/away orientation.
    const rows = await this.db
      .select()
      .from(schema.baseballGames)
      .where(
        and(
          gte(schema.baseballGames.date, lo),
          lte(schema.baseballGames.date, hi),
        ),
      );
    return (
      rows.find(
        (g: any) =>
          (g.homeTeamId === apiA && g.awayTeamId === apiB) ||
          (g.homeTeamId === apiB && g.awayTeamId === apiA),
      ) ?? null
    );
  }

  private reverse = new Map<number, number>();
  private reverseLoaded = false;
  private apiSportsId(mlbamId: number): number | null {
    return this.reverse.get(mlbamId) ?? null;
  }

  private async ensureReverse(): Promise<void> {
    if (this.reverseLoaded) return;
    const rows = await this.db.select().from(schema.baseballTeamMap);
    for (const r of rows) {
      if (r.apiSportsTeamId != null) this.reverse.set(r.mlbamTeamId, r.apiSportsTeamId);
    }
    this.reverseLoaded = true;
  }

  private async getPrediction(gameId: number): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(schema.baseballPredictions)
      .where(eq(schema.baseballPredictions.gameId, gameId))
      .limit(1);
    return rows[0] ?? null;
  }
}

function parseJson(v: any): any {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
