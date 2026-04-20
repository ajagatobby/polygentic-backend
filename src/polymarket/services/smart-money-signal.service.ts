import { Injectable, Logger } from '@nestjs/common';
import {
  PolymarketDataService,
  PolymarketHolder,
  HoldersByOutcome,
  LeaderboardEntry,
  UserPosition,
} from './polymarket-data.service';

/**
 * Signal that captures *informed* whale positioning on a Polymarket market.
 *
 * Why this exists: top-holders alone is a noisy signal — it includes hedgers,
 * retail with conviction, and one-trick-pony specialists outside their domain.
 * The agent can produce real edge over the bookmaker line if and only if it
 * uses smart-money positioning, where "smart" is filtered for:
 *
 *   1. **Lifetime ROI** above a floor over a non-trivial sample (n ≥
 *      `minResolvedBets`). Eliminates lucky/short-track-record wallets.
 *   2. **Position sized meaningfully relative to that wallet's typical bet**
 *      — a whale's $1k tip is noise; their $200k position is a thesis.
 *   3. **Independent traders only** — wallets that move in lockstep with
 *      another whale are deduplicated (proxy for "same Telegram group").
 *
 * The output is a leanScore in [-1, +1] where +1 means strong sharp
 * conviction on outcome 0 (typically YES) and -1 means strong conviction on
 * outcome 1 (NO). signalConfidence (0..1) reflects how much we trust the
 * lean — driven by sample of qualifying sharps and the dollar weight behind
 * them. When fewer than `minSharpCount` qualifying sharps appear, we return
 * a null signal: explicitly "no read" rather than a weak guess.
 */

export interface SmartMoneySignal {
  /**
   * Signal source. 'direct' = read from a per-match moneyline market —
   * strong signal, apply symmetric confidence ±1. 'backdrop' = aggregated
   * from season-long outright markets on the involved teams — weaker
   * signal, only use for agreement confirmation (never disagreement
   * penalty), since team-season-quality ≠ this-match-outcome.
   */
  signalKind?: 'direct' | 'backdrop';
  /** Lean toward outcome 0 (+) vs outcome 1 (-). null = no qualifying signal. */
  leanScore: number | null;
  /** 0..1; higher = more confident in the lean. */
  signalConfidence: number;
  /** How many distinct sharp wallets backed the lean. */
  sharpCount: number;
  /** USD on each side after filtering. */
  sharpDollarsOutcome0: number;
  sharpDollarsOutcome1: number;
  /** Outcome strings for display. */
  outcome0Name: string;
  outcome1Name: string;
  /** Top contributing sharps (for explainability). */
  topSharps: Array<{
    proxyWallet: string;
    name: string;
    outcomeIndex: number;
    amount: number;
    lifetimePnl: number;
    lifetimeRoi: number;
    typicalBetSize: number;
    positionMultiple: number;
    /** Consecutive wins from most recent resolved position. 0 if the
     *  latest resolution was a loss. */
    currentWinStreak: number;
    /** Win rate over the last 10 resolved positions (0..1). */
    last10WinRate: number;
    /** Wins out of last 10 (0..10). Null if they haven't resolved 10 yet. */
    last10Wins: number | null;
    /** Win rate over the last 20 resolved positions (0..1). */
    last20WinRate: number;
    /** Wins out of last 20 (0..20). Null if they haven't resolved 20 yet. */
    last20Wins: number | null;
    /** Why this wallet qualified — `base` (lifetime PnL ≥ floor) or
     *  `hot-streak` (lower PnL floor + strong recent form). */
    qualifiedVia?: 'base' | 'hot-streak';
  }>;
  /** Number of contributing markets (1 for direct; multiple for backdrop). */
  contributingMarkets?: number;
}

export interface SmartMoneyOptions {
  /** Base minimum lifetime PnL to consider a wallet "sharp". Default $50k. */
  minLifetimePnl?: number;
  /** Lower lifetime-PnL floor that applies ONLY when a wallet also has a
   *  strong recent streak (see minLast10WinRate / minCurrentStreak).
   *  Default $20k. A proven mid-size trader who's hot right now is as
   *  informative as a whale who's coasting on old wins. */
  minLifetimePnlWithStreak?: number;
  /** Min lifetime ROI fraction (0.10 = 10%). Default 0.10. Applies to
   *  BOTH qualification paths. */
  minLifetimeRoi?: number;
  /** Min number of resolved positions for lifetime stats to count.
   *  Applies to both paths — we never qualify unknown wallets. */
  minResolvedBets?: number;
  /** Min sharps needed before the signal is non-null. */
  minSharpCount?: number;
  /** Position must be >= this multiple of trader's typical bet to count
   *  as conviction. Default 0.5 (half their normal size). */
  minPositionMultiple?: number;
  /** Dedup tolerance: two wallets share the same lean & their positions are
   *  within this fraction of each other → counted as one. Default 0.15. */
  correlationThreshold?: number;
  /** For the hot-streak exception: minimum win rate over the most recent
   *  10 resolved positions. Default 0.80 (8 of 10 wins). */
  minLast10WinRate?: number;
  /** For the hot-streak exception: alternative to win-rate. Current
   *  consecutive-wins streak. Default 7 — genuinely rare in binary
   *  markets absent skill. */
  minCurrentStreak?: number;
  /** Expand the candidate pool beyond Polymarket's 20-holder cap using
   *  /trades aggregation (and optionally leaderboard cross-check).
   *  Default false → use the native top-20 per outcome. */
  expandPool?: boolean;
  /** Target number of candidate holders per outcome when expandPool is
   *  true. Default 100. The signal still filters aggressively after
   *  expansion — this sets the haystack, not the hay. */
  targetHoldersPerOutcome?: number;
  /** Include a leaderboard cross-check when expanding — more expensive
   *  (~100 extra HTTP calls to /positions) but surfaces proven sharps
   *  below the top-20 holder cutoff. Default false. */
  includeLeaderboardInPool?: boolean;
  /** How many recent /trades records to pull when reconstructing net
   *  positions. Default 1000. Higher = deeper wallet discovery at the
   *  cost of one larger HTTP response. */
  tradeSampleSize?: number;
  /** How many leaderboard entries to cross-check against this market.
   *  Default 100, clamped to 200 upstream. Higher surfaces more proven
   *  sharps at N additional /positions calls (cached 30min). */
  leaderboardSize?: number;
}

/** Aggregated lifetime stats for a single wallet, used by the sharp
 *  qualification path and exposed for enrichment in other services. */
export interface LifetimeStats {
  totalPnl: number;
  totalBought: number;
  resolvedCount: number;
  typicalBetSize: number;
  currentWinStreak: number;
  last10WinRate: number;
  last10Wins: number | null;
  /** Wins out of last 20 resolved positions. Null if < 20 resolved. */
  last20Wins: number | null;
  last20WinRate: number;
}

@Injectable()
export class SmartMoneySignalService {
  private readonly logger = new Logger(SmartMoneySignalService.name);
  private readonly DEFAULTS: Required<SmartMoneyOptions> = {
    minLifetimePnl: 50_000,
    minLifetimePnlWithStreak: 20_000,
    minLifetimeRoi: 0.1,
    minResolvedBets: 50,
    minSharpCount: 3,
    minPositionMultiple: 0.5,
    correlationThreshold: 0.15,
    minLast10WinRate: 0.8,
    minCurrentStreak: 7,
    expandPool: false,
    targetHoldersPerOutcome: 100,
    includeLeaderboardInPool: false,
    tradeSampleSize: 1000,
    leaderboardSize: 100,
  };

  constructor(private readonly data: PolymarketDataService) {}

  /**
   * Public: compute lifetime stats for a single wallet by pulling its
   * open and closed positions from Polymarket, then running the same
   * aggregation the signal computation uses. Exposed so other services
   * (e.g. the top-holders endpoint) can enrich wallet records without
   * duplicating the stats logic.
   */
  async getWalletLifetimeStats(wallet: string): Promise<LifetimeStats> {
    const [open, closed] = await Promise.all([
      this.data.getUserPositions(wallet, { limit: 200 }),
      this.data.getUserClosedPositions(wallet, { limit: 200 }),
    ]);
    return this.lifetimeStats([...open, ...closed]);
  }

  /**
   * Compute the smart-money signal for a single market.
   *
   * Returns `leanScore: null` when fewer than `minSharpCount` qualifying
   * sharps appear — in that case, callers should not act on the signal.
   */
  async computeSignal(
    conditionId: string,
    opts: SmartMoneyOptions = {},
  ): Promise<SmartMoneySignal> {
    const cfg = { ...this.DEFAULTS, ...opts };

    // 1. Fetch holders for both outcomes. Native /holders caps at 20/outcome;
    //    expandPool widens the pool via /trades (+ optional leaderboard).
    const holdersByOutcome = cfg.expandPool
      ? await this.data.getExpandedHolders(conditionId, {
          targetPerOutcome: cfg.targetHoldersPerOutcome,
          includeLeaderboard: cfg.includeLeaderboardInPool,
          tradeSampleSize: cfg.tradeSampleSize,
          leaderboardSize: cfg.leaderboardSize,
        })
      : await this.data.getTopHolders(conditionId);
    if (holdersByOutcome.length < 2) {
      // Either market doesn't exist or only one outcome has holders — no
      // meaningful signal either way.
      return this.emptySignal('—', '—');
    }

    // Polymarket returns one entry per outcome token in `outcomeIndex` order.
    const o0 = holdersByOutcome.find((h) => h.holders[0]?.outcomeIndex === 0);
    const o1 = holdersByOutcome.find((h) => h.holders[0]?.outcomeIndex === 1);
    if (!o0 || !o1) {
      return this.emptySignal('—', '—');
    }
    const outcome0Name = (o0.holders[0]?.name as any)?.outcome ?? 'Yes';
    const outcome1Name = (o1.holders[0]?.name as any)?.outcome ?? 'No';

    // 2. Pull all candidate wallets, dedup (a wallet might appear on both
    //    sides if they're hedging — we treat each side independently).
    const candidates = [...o0.holders, ...o1.holders];
    if (candidates.length === 0) return this.emptySignal(outcome0Name, outcome1Name);

    // 3. For each candidate, fetch their lifetime stats. Concurrency is
    //    bounded by the data service's per-call cache — repeated calls
    //    within a TTL are free.
    const sharps = await this.classifyAsSharp(candidates, cfg);

    // 4. Apply position-size-relative-to-typical filter
    const conviction = sharps.filter(
      (s) => s.positionMultiple >= cfg.minPositionMultiple,
    );

    // 5. Dedup correlated wallets — same lean + similar size → count once
    const independent = this.dedupCorrelated(conviction, cfg.correlationThreshold);

    if (independent.length < cfg.minSharpCount) {
      return {
        leanScore: null,
        signalConfidence: 0,
        sharpCount: independent.length,
        sharpDollarsOutcome0: independent
          .filter((s) => s.outcomeIndex === 0)
          .reduce((sum, s) => sum + s.amount, 0),
        sharpDollarsOutcome1: independent
          .filter((s) => s.outcomeIndex === 1)
          .reduce((sum, s) => sum + s.amount, 0),
        outcome0Name,
        outcome1Name,
        topSharps: independent.slice(0, 5),
      };
    }

    // 6. Compute the count + streak weighted lean.
    //    Each sharp gets a weighted vote (not a dollar-weighted one) so a
    //    lone whale can't override the collective read. The weight rises
    //    with recent form (last10 + current streak) — a sharp on a 9/10
    //    tear votes roughly 1.5x, one on 0/10 votes 0.5x, unknown form = 1x.
    const votes0 = independent
      .filter((s) => s.outcomeIndex === 0)
      .reduce((sum, s) => sum + this.sharpVoteWeight(s), 0);
    const votes1 = independent
      .filter((s) => s.outcomeIndex === 1)
      .reduce((sum, s) => sum + this.sharpVoteWeight(s), 0);
    const totalVotes = votes0 + votes1;
    const leanScore = totalVotes > 0 ? (votes0 - votes1) / totalVotes : 0;

    // Dollars kept for display only — no longer feed leanScore.
    const dollars0 = independent
      .filter((s) => s.outcomeIndex === 0)
      .reduce((sum, s) => sum + s.amount, 0);
    const dollars1 = independent
      .filter((s) => s.outcomeIndex === 1)
      .reduce((sum, s) => sum + s.amount, 0);

    // 7. Confidence: more sharps + stronger consensus → higher confidence.
    const sampleConf = Math.min(1, independent.length / 10);
    const magnitudeConf = Math.abs(leanScore);
    const signalConfidence = sampleConf * magnitudeConf;

    return {
      signalKind: 'direct',
      leanScore,
      signalConfidence,
      sharpCount: independent.length,
      sharpDollarsOutcome0: dollars0,
      sharpDollarsOutcome1: dollars1,
      outcome0Name,
      outcome1Name,
      // All qualifying sharps, sorted hottest-first by recent form.
      // Priority:
      //   1. last10Wins DESC   — most recent form dominates
      //   2. last20Wins DESC   — broader recent form as tiebreaker
      //   3. currentWinStreak DESC
      //   4. lifetimePnl DESC  — final tiebreak
      topSharps: independent.sort((a, b) => {
        const a10 = a.last10Wins ?? -1;
        const b10 = b.last10Wins ?? -1;
        if (a10 !== b10) return b10 - a10;
        const a20 = a.last20Wins ?? -1;
        const b20 = b.last20Wins ?? -1;
        if (a20 !== b20) return b20 - a20;
        if (a.currentWinStreak !== b.currentWinStreak) {
          return b.currentWinStreak - a.currentWinStreak;
        }
        return b.lifetimePnl - a.lifetimePnl;
      }),
      contributingMarkets: 1,
    };
  }

  /**
   * Per-sharp vote weight for leanScore aggregation.
   *
   * Base vote = 1, modulated by recent form so hot wallets count more and
   * cold ones less — without letting a single position size dominate.
   *
   *   last10WinRate 1.0 + streak ≥10 → ~1.5
   *   last10WinRate 0.5 (or unknown) → ~1.0
   *   last10WinRate 0.0 + no streak  → ~0.5
   */
  /**
   * Per-sharp vote weight for leanScore aggregation.
   *
   * Recent form is the single most predictive signal of active skill in
   * prediction markets — more than lifetime PnL or ROI. A wallet that
   * went 8-2 in its last 10 and 16-4 in its last 20 is almost certainly
   * reading the current market correctly; a 1/10 whale is likely either
   * slumping, on tilt, or over-extended in markets they don't
   * specialise in. So we weight aggressively on recent form.
   *
   * Formula (range 0.15..2.5):
   *
   *   last10Score  = last10WinRate (null → 0.5 neutral)     // 0..1
   *   last20Score  = last20WinRate (null → 0.5 neutral)     // 0..1
   *   formScore    = (2·last10 + last20) / 3                // 0..1, last10 weighted 2x
   *   streakBonus  = min(1, currentWinStreak / 10)          // 0..1
   *   combined     = (5·formScore + streakBonus) / 6        // 0..1, form dominates
   *   weight       = 0.15 + 2.35·combined                   // 0.15..2.5
   *
   * Key ratios:
   *   10/10 + 20/20 + streak 10   → weight ~2.50 (elite hot hand)
   *   9/10  + 19/20 + streak 0    → weight ~2.15
   *   8/10  + 16/20 + streak 0    → weight ~1.92
   *   5/10  + 10/20 + streak 0    → weight ~1.32 (neutral)
   *   2/10  + 3/20  + streak 0    → weight ~0.60 (cold)
   *   1/10  + 8/20  + streak 0    → weight ~0.65
   *   0/10  + 0/20  + streak 0    → weight ~0.15 (ice cold, near-zero vote)
   *
   * So a hot wallet (9/10) counts roughly 3.3x a cold one (2/10) and
   * ~14x an ice-cold one (0/10). The previous formula only had a ~2.5x
   * spread, which let $500k of cold-whale dollars outvote $40k of
   * hot-hand dollars.
   */
  private sharpVoteWeight(s: {
    last10WinRate: number;
    last10Wins: number | null;
    last20WinRate: number;
    last20Wins: number | null;
    currentWinStreak: number;
  }): number {
    const last10 = s.last10Wins != null ? s.last10WinRate : 0.5;
    const last20 = s.last20Wins != null ? s.last20WinRate : 0.5;
    const formScore = (2 * last10 + last20) / 3;
    const streakBonus = Math.min(1, s.currentWinStreak / 10);
    const combined = (5 * formScore + streakBonus) / 6;
    return 0.15 + 2.35 * combined;
  }

  /**
   * For each candidate holder, fetch their lifetime stats and decide if they
   * qualify as "sharp" given the config. Returns a unified sharp record
   * (one per holder, including non-qualifiers — caller filters).
   */
  private async classifyAsSharp(
    candidates: PolymarketHolder[],
    cfg: Required<SmartMoneyOptions>,
  ): Promise<
    Array<{
      proxyWallet: string;
      name: string;
      outcomeIndex: number;
      amount: number;
      lifetimePnl: number;
      lifetimeRoi: number;
      typicalBetSize: number;
      positionMultiple: number;
      currentWinStreak: number;
      last10WinRate: number;
      last10Wins: number | null;
      last20WinRate: number;
      last20Wins: number | null;
      qualifies: boolean;
      qualifiedVia?: 'base' | 'hot-streak';
    }>
  > {
    // Dedup by proxyWallet — but track BOTH outcomes for hedgers. Most
    // whales appear on only one side so this is rare.
    const byWallet = new Map<string, PolymarketHolder[]>();
    for (const h of candidates) {
      const arr = byWallet.get(h.proxyWallet) ?? [];
      arr.push(h);
      byWallet.set(h.proxyWallet, arr);
    }

    // Fetch lifetime data for each unique wallet in parallel (cache-aware).
    const walletList = Array.from(byWallet.keys());
    const lifetimes = await Promise.all(
      walletList.map(async (w) => {
        const [open, closed] = await Promise.all([
          this.data.getUserPositions(w, { limit: 200 }),
          this.data.getUserClosedPositions(w, { limit: 200 }),
        ]);
        return { wallet: w, positions: [...open, ...closed] };
      }),
    );
    const lifetimeMap = new Map<string, UserPosition[]>();
    for (const l of lifetimes) lifetimeMap.set(l.wallet, l.positions);

    const out: Array<{
      proxyWallet: string;
      name: string;
      outcomeIndex: number;
      amount: number;
      lifetimePnl: number;
      lifetimeRoi: number;
      typicalBetSize: number;
      positionMultiple: number;
      currentWinStreak: number;
      last10WinRate: number;
      last10Wins: number | null;
      last20WinRate: number;
      last20Wins: number | null;
      qualifies: boolean;
      qualifiedVia?: 'base' | 'hot-streak';
    }> = [];
    for (const [wallet, holders] of byWallet) {
      const lifetimePositions = lifetimeMap.get(wallet) ?? [];
      const stats = this.lifetimeStats(lifetimePositions);
      for (const h of holders) {
        out.push(this.recordFor(h, stats, cfg));
      }
    }
    return out;
  }

  private recordFor(
    h: PolymarketHolder,
    stats: LifetimeStats,
    cfg: Required<SmartMoneyOptions>,
  ) {
    const lifetimeRoi =
      stats.totalBought > 0 ? stats.totalPnl / stats.totalBought : 0;
    const positionMultiple =
      stats.typicalBetSize > 0 ? h.amount / stats.typicalBetSize : 0;

    // Baseline gates shared across both qualification paths.
    const passesCoreFilters =
      lifetimeRoi >= cfg.minLifetimeRoi &&
      stats.resolvedCount >= cfg.minResolvedBets;

    // Path A: base PnL threshold
    const passesBase =
      passesCoreFilters && stats.totalPnl >= cfg.minLifetimePnl;

    // Path B: lower PnL threshold IF the wallet has a very good recent
    // streak. Proves they're not a dormant whale coasting on old wins —
    // they're actively performing right now. A mid-size trader who's 8-2
    // in their last 10 resolved bets carries as much signal as a whale
    // who's been treading water for a year.
    const hasHotStreak =
      (stats.last10Wins != null && stats.last10WinRate >= cfg.minLast10WinRate) ||
      stats.currentWinStreak >= cfg.minCurrentStreak;
    const passesStreakPath =
      passesCoreFilters &&
      stats.totalPnl >= cfg.minLifetimePnlWithStreak &&
      hasHotStreak;

    const qualifies = passesBase || passesStreakPath;
    const qualifiedVia: 'base' | 'hot-streak' | undefined = passesBase
      ? 'base'
      : passesStreakPath
        ? 'hot-streak'
        : undefined;

    return {
      proxyWallet: h.proxyWallet,
      name: h.name || h.pseudonym || 'unknown',
      outcomeIndex: h.outcomeIndex,
      amount: h.amount,
      lifetimePnl: stats.totalPnl,
      lifetimeRoi,
      typicalBetSize: stats.typicalBetSize,
      positionMultiple,
      currentWinStreak: stats.currentWinStreak,
      last10WinRate: stats.last10WinRate,
      last10Wins: stats.last10Wins,
      last20WinRate: stats.last20WinRate,
      last20Wins: stats.last20Wins,
      qualifies,
      qualifiedVia,
    };
  }

  /**
   * Rolled-up lifetime stats from a wallet's closed positions.
   *
   * Winners = realizedPnl > 0. Losers = realizedPnl < 0. Positions that
   * haven't resolved yet (null realizedPnl) are excluded from ALL stats
   * so they don't skew streak calculations.
   *
   * Streaks: positions sorted by endDate desc, so "current streak" =
   * consecutive wins starting from the most recent resolution. 0 if the
   * last resolution was a loss.
   *
   * last10WinRate: win rate across the most recent 10 resolved positions.
   * null (as last10Wins) if < 10 positions resolved total — small samples
   * shouldn't produce a phantom streak signal.
   */
  private lifetimeStats(positions: UserPosition[]): LifetimeStats {
    if (positions.length === 0) {
      return {
        totalPnl: 0,
        totalBought: 0,
        resolvedCount: 0,
        typicalBetSize: 0,
        currentWinStreak: 0,
        last10WinRate: 0,
        last10Wins: null,
        last20WinRate: 0,
        last20Wins: null,
      };
    }
    let totalPnl = 0;
    let totalBought = 0;
    let resolved = 0;
    const sizes: number[] = [];
    const resolvedWithDate: Array<{ win: boolean; endDate: string }> = [];
    for (const p of positions) {
      // Realized PnL is the cleanest signal of skill — counts only positions
      // that have been closed. cashPnl includes unrealized.
      totalPnl += Number(p.realizedPnl ?? 0);
      totalBought += Number(p.totalBought ?? 0);
      if (p.realizedPnl != null && p.totalBought > 0) {
        resolved++;
        resolvedWithDate.push({
          win: Number(p.realizedPnl) > 0,
          endDate: String(p.endDate ?? ''),
        });
      }
      if (p.totalBought > 0) sizes.push(p.totalBought);
    }
    // Median bet size is more robust to outliers than mean.
    sizes.sort((a, b) => a - b);
    const typicalBetSize =
      sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 0;

    // Sort resolved positions by endDate desc (most recent first). Empty
    // endDate sorts last (treated as oldest).
    resolvedWithDate.sort((a, b) => {
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return b.endDate.localeCompare(a.endDate);
    });

    // Current streak: consecutive wins from most recent. Breaks on first loss.
    let currentWinStreak = 0;
    for (const r of resolvedWithDate) {
      if (r.win) currentWinStreak++;
      else break;
    }

    // Last-10 win rate: only meaningful if at least 10 resolved positions.
    let last10WinRate = 0;
    let last10Wins: number | null = null;
    if (resolvedWithDate.length >= 10) {
      const last10 = resolvedWithDate.slice(0, 10);
      last10Wins = last10.filter((r) => r.win).length;
      last10WinRate = last10Wins / 10;
    }

    // Last-20 win rate: broader form read, same gate — only meaningful
    // when a wallet has resolved at least 20 positions.
    let last20WinRate = 0;
    let last20Wins: number | null = null;
    if (resolvedWithDate.length >= 20) {
      const last20 = resolvedWithDate.slice(0, 20);
      last20Wins = last20.filter((r) => r.win).length;
      last20WinRate = last20Wins / 20;
    }

    return {
      totalPnl,
      totalBought,
      resolvedCount: resolved,
      typicalBetSize,
      currentWinStreak,
      last10WinRate,
      last10Wins,
      last20WinRate,
      last20Wins,
    };
  }

  /**
   * Coalesce wallets that look like the same trader / same group:
   * if A and B both bet on the same outcome AND their position sizes are
   * within `tolerance` of each other, they count as one sharp signal.
   *
   * This is a simple heuristic. A future iteration could check historical
   * correlation across many markets via a wallet-pair similarity index.
   */
  private dedupCorrelated<
    T extends { proxyWallet: string; outcomeIndex: number; amount: number; qualifies: boolean }
  >(items: T[], tolerance: number): T[] {
    const qualified = items.filter((i) => i.qualifies);
    qualified.sort((a, b) => b.amount - a.amount);
    const kept: T[] = [];
    for (const item of qualified) {
      const dup = kept.find(
        (k) =>
          k.outcomeIndex === item.outcomeIndex &&
          Math.abs(k.amount - item.amount) / Math.max(k.amount, item.amount) <
            tolerance,
      );
      if (!dup) kept.push(item);
    }
    return kept;
  }

  private emptySignal(o0: string, o1: string): SmartMoneySignal {
    return {
      leanScore: null,
      signalConfidence: 0,
      sharpCount: 0,
      sharpDollarsOutcome0: 0,
      sharpDollarsOutcome1: 0,
      outcome0Name: o0,
      outcome1Name: o1,
      topSharps: [],
    };
  }
}
