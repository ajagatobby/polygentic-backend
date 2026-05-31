import { Injectable, Logger } from '@nestjs/common';
import { CollectedMatchData } from './data-collector.agent';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ProbCompare {
  /** Our model probability (0..1). */
  model: number;
  /** Market (devigged) probability, null when no market line. */
  market: number | null;
  /** Edge in percentage points (model − market) × 100. Positive = value. */
  edgePct: number | null;
}

export interface ScorelineProb {
  score: string; // "2-1"
  prob: number;
}

export interface ValueBet {
  market: string; // "Over 2.5", "BTTS: Yes", "Home", "AH Home -0.5"
  modelProb: number;
  marketProb: number | null;
  edgePct: number;
  /** Fair decimal odds implied by our model. */
  fairOdds: number;
  note: string;
}

export interface MarketAnalysis {
  expectedGoals: { home: number; away: number; total: number };
  topScorelines: ScorelineProb[];
  /** 1X2 model vs market vs Polymarket. */
  matchResult: {
    home: ProbCompare;
    draw: ProbCompare;
    away: ProbCompare;
    polymarketLean: string | null;
  };
  doubleChance: { homeOrDraw: number; homeOrAway: number; drawOrAway: number };
  overUnder: Array<{ line: number; over: ProbCompare; under: ProbCompare }>;
  btts: { yes: number; no: number };
  teamTotals: {
    homeOver15: number;
    homeOver05: number;
    awayOver15: number;
    awayOver05: number;
  };
  asianHandicap: Array<{ line: number; home: number; away: number }>;
  cleanSheet: { home: number; away: number };
  /** Best edges across all markets, sorted by edge desc. */
  valueBets: ValueBet[];
  /** Plain-English odds-movement read. */
  oddsRead: string | null;
}

const FACTORIAL: number[] = (() => {
  const f = [1];
  for (let i = 1; i <= 12; i++) f[i] = f[i - 1] * i;
  return f;
})();

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / FACTORIAL[k];
}

/**
 * Derives a full slate of betting markets from the model's expected goals and
 * 1X2 probabilities, then compares against the market's devigged lines to
 * surface value. Display + value-detection only — it does not change the
 * stored probabilities.
 */
@Injectable()
export class MarketAnalysisService {
  private readonly logger = new Logger(MarketAnalysisService.name);

  build(
    data: CollectedMatchData,
    prediction: {
      homeWinProb: number;
      drawProb: number;
      awayWinProb: number;
      predictedHomeGoals: number;
      predictedAwayGoals: number;
    },
  ): MarketAnalysis | null {
    try {
      const lh = Math.max(0.05, Number(prediction.predictedHomeGoals) || 1.3);
      const la = Math.max(0.05, Number(prediction.predictedAwayGoals) || 1.1);

      // Build the independent-Poisson scoreline grid (0..10 each side).
      const MAX = 10;
      const hp = Array.from({ length: MAX + 1 }, (_, k) => poissonPmf(k, lh));
      const ap = Array.from({ length: MAX + 1 }, (_, k) => poissonPmf(k, la));
      const grid: number[][] = [];
      let gridSum = 0;
      for (let i = 0; i <= MAX; i++) {
        grid[i] = [];
        for (let j = 0; j <= MAX; j++) {
          const p = hp[i] * ap[j];
          grid[i][j] = p;
          gridSum += p;
        }
      }

      // Derived market probabilities from the grid.
      const scorelines: ScorelineProb[] = [];
      let bttsYes = 0;
      let homeCS = 0; // away fails to score
      let awayCS = 0;
      const overCount: Record<string, number> = {};
      const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
      for (const l of lines) overCount[l] = 0;
      const ahLines = [-1.5, -0.5, 0.5, 1.5];
      const ahHome: Record<string, number> = {};
      for (const l of ahLines) ahHome[l] = 0;
      let homeOver05 = 0,
        homeOver15 = 0,
        awayOver05 = 0,
        awayOver15 = 0;

      for (let i = 0; i <= MAX; i++) {
        for (let j = 0; j <= MAX; j++) {
          const p = grid[i][j] / gridSum;
          scorelines.push({ score: `${i}-${j}`, prob: p });
          const total = i + j;
          if (i > 0 && j > 0) bttsYes += p;
          if (j === 0) homeCS += p;
          if (i === 0) awayCS += p;
          for (const l of lines) if (total > l) overCount[l] += p;
          if (i >= 1) homeOver05 += p;
          if (i >= 2) homeOver15 += p;
          if (j >= 1) awayOver05 += p;
          if (j >= 2) awayOver15 += p;
          // Asian handicap on home: home margin (i-j) + line > 0 => home covers.
          for (const l of ahLines) if (i - j + l > 0) ahHome[l] += p;
        }
      }

      const topScorelines = scorelines
        .sort((a, b) => b.prob - a.prob)
        .slice(0, 6)
        .map((s) => ({ score: s.score, prob: round4(s.prob) }));

      // Market (devig) comparisons from consensus odds.
      const h2h = this.findConsensus(data, 'h2h');
      const totals = this.findConsensus(data, 'totals');
      const marketH2H = this.devigTriple(
        num(h2h?.consensusHomeWin),
        num(h2h?.consensusDraw),
        num(h2h?.consensusAwayWin),
      );
      const marketTotals = this.devigPair(
        num(totals?.consensusOver),
        num(totals?.consensusUnder),
      );
      const totalsPoint = num(totals?.consensusPoint);

      const cmp = (model: number, market: number | null): ProbCompare => ({
        model: round4(model),
        market: market != null ? round4(market) : null,
        edgePct: market != null ? round2((model - market) * 100) : null,
      });

      const overUnder = lines.map((l) => {
        const over = overCount[l];
        const isMarketLine = totalsPoint != null && Math.abs(totalsPoint - l) < 0.01;
        return {
          line: l,
          over: cmp(over, isMarketLine ? marketTotals?.over ?? null : null),
          under: cmp(1 - over, isMarketLine ? marketTotals?.under ?? null : null),
        };
      });

      const sm = (data as any).smartMoneySignal ?? null;
      const polymarketLean =
        sm && sm.leanScore != null
          ? `${sm.leanScore > 0 ? sm.outcome0Name : sm.outcome1Name} (${sm.sharpCount} sharps, conf ${(sm.signalConfidence * 100).toFixed(0)}%)`
          : null;

      const analysis: MarketAnalysis = {
        expectedGoals: { home: round2(lh), away: round2(la), total: round2(lh + la) },
        topScorelines,
        matchResult: {
          home: cmp(prediction.homeWinProb, marketH2H?.home ?? null),
          draw: cmp(prediction.drawProb, marketH2H?.draw ?? null),
          away: cmp(prediction.awayWinProb, marketH2H?.away ?? null),
          polymarketLean,
        },
        doubleChance: {
          homeOrDraw: round4(prediction.homeWinProb + prediction.drawProb),
          homeOrAway: round4(prediction.homeWinProb + prediction.awayWinProb),
          drawOrAway: round4(prediction.drawProb + prediction.awayWinProb),
        },
        overUnder,
        btts: { yes: round4(bttsYes), no: round4(1 - bttsYes) },
        teamTotals: {
          homeOver15: round4(homeOver15),
          homeOver05: round4(homeOver05),
          awayOver15: round4(awayOver15),
          awayOver05: round4(awayOver05),
        },
        asianHandicap: ahLines.map((l) => ({
          line: l,
          home: round4(ahHome[l]),
          away: round4(1 - ahHome[l]),
        })),
        cleanSheet: { home: round4(homeCS), away: round4(awayCS) },
        valueBets: this.collectValueBets(prediction, marketH2H, marketTotals, totalsPoint, overCount),
        oddsRead: this.describeOddsMovement(data),
      };

      return analysis;
    } catch (error: any) {
      this.logger.warn(`Market analysis failed: ${error.message}`);
      return null;
    }
  }

  private collectValueBets(
    prediction: { homeWinProb: number; drawProb: number; awayWinProb: number },
    marketH2H: { home: number; draw: number; away: number } | null,
    marketTotals: { over: number; under: number } | null,
    totalsPoint: number | null,
    overCount: Record<string, number>,
  ): ValueBet[] {
    const out: ValueBet[] = [];
    const EDGE_MIN = 4; // percentage points
    const add = (
      market: string,
      modelProb: number,
      marketProb: number | null,
    ) => {
      if (marketProb == null) return;
      const edge = (modelProb - marketProb) * 100;
      if (edge >= EDGE_MIN) {
        out.push({
          market,
          modelProb: round4(modelProb),
          marketProb: round4(marketProb),
          edgePct: round2(edge),
          fairOdds: round2(1 / modelProb),
          note: `Model ${(modelProb * 100).toFixed(0)}% vs market ${(marketProb * 100).toFixed(0)}% → +${edge.toFixed(1)}pp`,
        });
      }
    };
    if (marketH2H) {
      add('Home win', prediction.homeWinProb, marketH2H.home);
      add('Draw', prediction.drawProb, marketH2H.draw);
      add('Away win', prediction.awayWinProb, marketH2H.away);
    }
    if (marketTotals && totalsPoint != null) {
      const key = String(totalsPoint);
      if (overCount[key] != null) {
        add(`Over ${totalsPoint}`, overCount[key], marketTotals.over);
        add(`Under ${totalsPoint}`, 1 - overCount[key], marketTotals.under);
      }
    }
    return out.sort((a, b) => b.edgePct - a.edgePct);
  }

  private describeOddsMovement(data: CollectedMatchData): string | null {
    const cl = (data as any).closingLineSignal;
    if (!cl) return null;
    const parts: string[] = [];
    if (cl.sourceUsed && cl.sourceUsed !== 'none')
      parts.push(`Sharpest line: ${cl.sourceUsed.replace('_', ' ')}`);
    if (cl.drift && cl.driftMagnitude > 0.01) {
      const d = cl.drift;
      const dirs: string[] = [];
      if (Math.abs(d.home) >= 0.02)
        dirs.push(`home ${d.home > 0 ? 'shortened' : 'drifted'} ${(Math.abs(d.home) * 100).toFixed(1)}pp`);
      if (Math.abs(d.away) >= 0.02)
        dirs.push(`away ${d.away > 0 ? 'shortened' : 'drifted'} ${(Math.abs(d.away) * 100).toFixed(1)}pp`);
      if (dirs.length) parts.push(`Open→close: ${dirs.join(', ')}`);
    }
    if (cl.pinnacleOverround != null)
      parts.push(`book overround ${(cl.pinnacleOverround * 100).toFixed(1)}%`);
    return parts.length ? parts.join('. ') + '.' : null;
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private findConsensus(data: CollectedMatchData, marketKey: string): any | null {
    const rows = (data.odds?.consensus ?? []) as any[];
    return rows.find((r) => r.marketKey === marketKey) ?? null;
  }

  /** Decimal odds → devigged probability triple. */
  private devigTriple(
    h: number | null,
    d: number | null,
    a: number | null,
  ): { home: number; draw: number; away: number } | null {
    if (!h || !d || !a) return null;
    const ph = 1 / h,
      pd = 1 / d,
      pa = 1 / a;
    const s = ph + pd + pa;
    if (s <= 0) return null;
    return { home: ph / s, draw: pd / s, away: pa / s };
  }

  private devigPair(
    o: number | null,
    u: number | null,
  ): { over: number; under: number } | null {
    if (!o || !u) return null;
    const po = 1 / o,
      pu = 1 / u;
    const s = po + pu;
    if (s <= 0) return null;
    return { over: po / s, under: pu / s };
  }
}

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) || n <= 0 ? null : n;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
