import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

/**
 * Polymarket public data API client.
 *
 * Wraps `data-api.polymarket.com` — the read-only endpoints that expose
 * holders, positions, trades, and the global leaderboard. None of these
 * require auth, but they're rate-limited and respond slowly under load,
 * so every result is cached in-memory with a short TTL.
 *
 * Schemas were reverse-engineered from live calls (see autoresearch probes,
 * Apr 2026). If Polymarket changes a payload, only the type aliases below
 * need to change.
 */

// ─── Types matching live API responses ────────────────────────────────

/** A single holder of one outcome's tokens. */
export interface PolymarketHolder {
  proxyWallet: string;
  bio: string;
  asset: string; // ERC-1155 token id (== outcome token id)
  pseudonym: string;
  amount: number; // shares; 1 share = $1 at resolution
  displayUsernamePublic: boolean;
  outcomeIndex: number; // 0 = yes / first outcome, 1 = no / second
  name: string;
  profileImage: string;
  profileImageOptimized: string;
  verified: boolean;
}

/** /holders returns one entry per outcome token. */
export interface HoldersByOutcome {
  token: string; // outcome token id
  holders: PolymarketHolder[];
}

/** /v1/leaderboard row. `rank` is a stringified int; `vol`/`pnl` are USD. */
export interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  xUsername: string;
  verifiedBadge: boolean;
  vol: number;
  pnl: number;
  profileImage: string;
}

/** /positions row for a single user × outcome. */
export interface UserPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon?: string;
  eventId?: string;
  eventSlug?: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

/** /trades row. */
export interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number; // unix seconds
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  transactionHash: string;
}

export type LeaderboardCategory =
  | 'OVERALL'
  | 'POLITICS'
  | 'SPORTS'
  | 'CRYPTO'
  | 'POP_CULTURE';
export type LeaderboardPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
export type LeaderboardOrderBy = 'PNL' | 'VOL';

// ─── Service ──────────────────────────────────────────────────────────

@Injectable()
export class PolymarketDataService {
  private readonly logger = new Logger(PolymarketDataService.name);
  private readonly client: AxiosInstance;

  // Different TTLs by data type. Holders/trades change live; leaderboard
  // updates infrequently; positions are user-scoped and we re-fetch only
  // when the caller really needs fresh.
  private readonly HOLDERS_TTL_MS = 5 * 60 * 1000; // 5 min
  private readonly TRADES_TTL_MS = 5 * 60 * 1000;
  private readonly LEADERBOARD_TTL_MS = 60 * 60 * 1000; // 1 h
  private readonly POSITIONS_TTL_MS = 30 * 60 * 1000; // 30 min

  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor() {
    this.client = axios.create({
      baseURL: 'https://data-api.polymarket.com',
      timeout: 20_000,
      headers: { Accept: 'application/json' },
    });
  }

  // ─── Public methods ────────────────────────────────────────────────

  /**
   * Top holders for a market. Returns one entry per outcome token (typically
   * 2 entries: yes and no). Each entry has up to 20 holders sorted by amount.
   *
   * Polymarket caps `limit` at 20 — pass higher and you still get 20.
   */
  async getTopHolders(
    conditionId: string,
    opts: { limit?: number; minBalance?: number } = {},
  ): Promise<HoldersByOutcome[]> {
    const limit = Math.min(20, opts.limit ?? 20);
    const minBalance = opts.minBalance ?? 1;
    const cacheKey = `holders:${conditionId}:${limit}:${minBalance}`;
    return this.cached(cacheKey, this.HOLDERS_TTL_MS, async () => {
      const r = await this.client.get<HoldersByOutcome[]>('/holders', {
        params: { market: conditionId, limit, minBalance },
      });
      return Array.isArray(r.data) ? r.data : [];
    });
  }

  /**
   * Top holders across many markets in one call. Polymarket accepts a
   * comma-separated `market` param. Result is keyed by conditionId for
   * easy lookup. Maintains the per-market 20-cap.
   */
  async getTopHoldersBatch(
    conditionIds: string[],
    opts: { limit?: number; minBalance?: number } = {},
  ): Promise<Map<string, HoldersByOutcome[]>> {
    if (conditionIds.length === 0) return new Map();
    const out = new Map<string, HoldersByOutcome[]>();

    // Polymarket supports comma-separated; chunk to 50 to keep URLs sane.
    const chunkSize = 50;
    for (let i = 0; i < conditionIds.length; i += chunkSize) {
      const chunk = conditionIds.slice(i, i + chunkSize);
      const cacheKey = `holders-batch:${chunk.join(',')}:${opts.limit ?? 20}:${opts.minBalance ?? 1}`;
      const data = await this.cached(
        cacheKey,
        this.HOLDERS_TTL_MS,
        async () => {
          try {
            const r = await this.client.get<HoldersByOutcome[]>('/holders', {
              params: {
                market: chunk.join(','),
                limit: Math.min(20, opts.limit ?? 20),
                minBalance: opts.minBalance ?? 1,
              },
            });
            return Array.isArray(r.data) ? r.data : [];
          } catch (err) {
            this.logger.warn(
              `getTopHoldersBatch chunk failed: ${(err as Error).message}`,
            );
            return [];
          }
        },
      );
      // Group entries by conditionId. /holders returns flat per-outcome entries
      // — but doesn't include conditionId in each entry, only the outcome
      // token id. We rely on a /trades or /positions cross-reference to
      // re-link. For simplicity here: when batched we return per-token data
      // keyed by the token id, and the caller decides how to map back.
      // For chunks of size 1 we know which condition the data belongs to.
      if (chunk.length === 1) {
        out.set(chunk[0], data);
      } else {
        // Multi-condition response: token IDs are unique per outcome, but
        // we'd need a separate lookup to map tokens → conditionId. To keep
        // this method useful, we degrade: split into 1-by-1 cached calls.
        for (const cid of chunk) {
          const single = await this.getTopHolders(cid, opts);
          out.set(cid, single);
        }
      }
    }
    return out;
  }

  /**
   * Global leaderboard. Defaults: OVERALL category, ALL-time, ranked by PNL,
   * top 50 entries (Polymarket max).
   */
  async getLeaderboard(
    opts: {
      category?: LeaderboardCategory;
      timePeriod?: LeaderboardPeriod;
      orderBy?: LeaderboardOrderBy;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<LeaderboardEntry[]> {
    const category = opts.category ?? 'OVERALL';
    const timePeriod = opts.timePeriod ?? 'ALL';
    const orderBy = opts.orderBy ?? 'PNL';
    const limit = Math.min(50, opts.limit ?? 50);
    const offset = Math.min(1000, opts.offset ?? 0);
    const cacheKey = `leaderboard:${category}:${timePeriod}:${orderBy}:${limit}:${offset}`;
    return this.cached(cacheKey, this.LEADERBOARD_TTL_MS, async () => {
      const r = await this.client.get<LeaderboardEntry[]>('/v1/leaderboard', {
        params: { category, timePeriod, orderBy, limit, offset },
      });
      return Array.isArray(r.data) ? r.data : [];
    });
  }

  /** Recent trades for a specific market. */
  async getTrades(
    conditionId: string,
    opts: { limit?: number } = {},
  ): Promise<PolymarketTrade[]> {
    const limit = opts.limit ?? 50;
    const cacheKey = `trades:${conditionId}:${limit}`;
    return this.cached(cacheKey, this.TRADES_TTL_MS, async () => {
      try {
        const r = await this.client.get<PolymarketTrade[]>('/trades', {
          params: { market: conditionId, limit },
        });
        return Array.isArray(r.data) ? r.data : [];
      } catch (err) {
        this.logger.warn(
          `getTrades failed for ${conditionId}: ${(err as Error).message}`,
        );
        return [];
      }
    });
  }

  /**
   * All current positions for a wallet (across every market they hold).
   * Returns realized + unrealized PnL data per position — the basis for
   * computing a trader's lifetime ROI.
   */
  async getUserPositions(
    proxyWallet: string,
    opts: { limit?: number } = {},
  ): Promise<UserPosition[]> {
    const limit = opts.limit ?? 200;
    const cacheKey = `positions:${proxyWallet}:${limit}`;
    return this.cached(cacheKey, this.POSITIONS_TTL_MS, async () => {
      try {
        const r = await this.client.get<UserPosition[]>('/positions', {
          params: { user: proxyWallet, limit },
        });
        return Array.isArray(r.data) ? r.data : [];
      } catch (err) {
        this.logger.warn(
          `getUserPositions failed for ${proxyWallet}: ${(err as Error).message}`,
        );
        return [];
      }
    });
  }

  /** Fetch user's closed positions — needed for full ROI calculation. */
  async getUserClosedPositions(
    proxyWallet: string,
    opts: { limit?: number } = {},
  ): Promise<UserPosition[]> {
    const limit = opts.limit ?? 200;
    const cacheKey = `closed-positions:${proxyWallet}:${limit}`;
    return this.cached(cacheKey, this.POSITIONS_TTL_MS, async () => {
      try {
        const r = await this.client.get<UserPosition[]>('/closed-positions', {
          params: { user: proxyWallet, limit },
        });
        return Array.isArray(r.data) ? r.data : [];
      } catch (err) {
        this.logger.warn(
          `getUserClosedPositions failed for ${proxyWallet}: ${(err as Error).message}`,
        );
        return [];
      }
    });
  }

  /**
   * Expanded holder pool for a market — breaks past Polymarket's 20-per-
   * outcome cap on `/holders` by unioning with traders derived from
   * `/trades` (reconstructed net positions) and optionally the global
   * leaderboard cross-checked against this specific market.
   *
   * Returns the same `HoldersByOutcome[]` shape as `getTopHolders` so
   * downstream code is a drop-in swap.
   */
  async getExpandedHolders(
    conditionId: string,
    opts: {
      targetPerOutcome?: number;
      includeLeaderboard?: boolean;
      tradeSampleSize?: number;
      leaderboardSize?: number;
    } = {},
  ): Promise<HoldersByOutcome[]> {
    const target = opts.targetPerOutcome ?? 100;
    const tradeSample = opts.tradeSampleSize ?? 1000;
    const leaderboardSize = Math.min(200, opts.leaderboardSize ?? 100);

    // Start with the native top-20 per outcome.
    const base = await this.getTopHolders(conditionId);
    if (base.length < 2) return base;

    // Build a map keyed by wallet+outcomeIndex so we can dedup and merge.
    const merged = new Map<string, PolymarketHolder>();
    for (const outcome of base) {
      for (const h of outcome.holders) {
        merged.set(`${h.proxyWallet}:${h.outcomeIndex}`, h);
      }
    }

    // Token → outcomeIndex map for trade reconstruction.
    const tokenToOutcome = new Map<string, number>();
    for (const outcome of base) {
      const idx = outcome.holders[0]?.outcomeIndex;
      if (idx != null) tokenToOutcome.set(outcome.token, idx);
    }

    // Augment with /trades. Aggregate net shares (BUY − SELL) per
    // wallet+outcome. Only add wallets with positive net positions that
    // aren't already in the top-20.
    try {
      const trades = await this.getTrades(conditionId, { limit: tradeSample });
      const netByKey = new Map<
        string,
        {
          wallet: string;
          outcomeIndex: number;
          netShares: number;
          name: string;
          pseudonym: string;
          asset: string;
        }
      >();
      for (const t of trades) {
        const key = `${t.proxyWallet}:${t.outcomeIndex}`;
        const prev = netByKey.get(key) ?? {
          wallet: t.proxyWallet,
          outcomeIndex: t.outcomeIndex,
          netShares: 0,
          name: t.name ?? '',
          pseudonym: t.pseudonym ?? '',
          asset: t.asset,
        };
        prev.netShares += t.side === 'BUY' ? t.size : -t.size;
        netByKey.set(key, prev);
      }
      for (const [key, t] of netByKey) {
        if (t.netShares <= 0) continue;
        if (merged.has(key)) continue;
        merged.set(key, {
          proxyWallet: t.wallet,
          bio: '',
          asset: t.asset,
          pseudonym: t.pseudonym,
          amount: t.netShares,
          displayUsernamePublic: true,
          outcomeIndex: t.outcomeIndex,
          name: t.name,
          profileImage: '',
          profileImageOptimized: '',
          verified: false,
        });
      }
    } catch (err) {
      this.logger.warn(
        `getExpandedHolders: trades augmentation failed for ${conditionId}: ${
          (err as Error).message
        }`,
      );
    }

    // Optional leaderboard cross-check: pull top N global leaderboard
    // wallets and check each for a current position on this market. More
    // expensive (N × /positions) but surfaces proven sharps that sit just
    // below the top-20 holder cutoff.
    if (opts.includeLeaderboard) {
      try {
        // Leaderboard is capped at 50 per page; offset up to leaderboardSize.
        const pages = Math.ceil(leaderboardSize / 50);
        const leaderboardPages = await Promise.all(
          Array.from({ length: pages }, (_, i) =>
            this.getLeaderboard({
              category: 'OVERALL',
              timePeriod: 'ALL',
              orderBy: 'PNL',
              limit: 50,
              offset: i * 50,
            }),
          ),
        );
        const leaderboard = leaderboardPages.flat().slice(0, leaderboardSize);

        // Check positions for each wallet in parallel (cached, 30min TTL).
        const positionChecks = await Promise.all(
          leaderboard.map((lb) =>
            this.getUserPositions(lb.proxyWallet, { limit: 200 }).catch(
              () => [] as UserPosition[],
            ),
          ),
        );

        for (let i = 0; i < leaderboard.length; i++) {
          const lb = leaderboard[i];
          const userPositions = positionChecks[i];
          const relevant = userPositions.filter(
            (p) => p.conditionId === conditionId && p.size > 0,
          );
          for (const p of relevant) {
            const key = `${p.proxyWallet}:${p.outcomeIndex}`;
            if (merged.has(key)) continue;
            merged.set(key, {
              proxyWallet: p.proxyWallet,
              bio: '',
              asset: p.asset,
              pseudonym: lb.userName ?? '',
              amount: p.size,
              displayUsernamePublic: true,
              outcomeIndex: p.outcomeIndex,
              name: lb.userName ?? '',
              profileImage: lb.profileImage ?? '',
              profileImageOptimized: lb.profileImage ?? '',
              verified: lb.verifiedBadge ?? false,
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `getExpandedHolders: leaderboard augmentation failed for ${conditionId}: ${
            (err as Error).message
          }`,
        );
      }
    }

    // Rebuild the `HoldersByOutcome` shape. Rank by amount desc, take
    // top `target` per outcome.
    const byOutcome = new Map<number, PolymarketHolder[]>();
    for (const h of merged.values()) {
      const list = byOutcome.get(h.outcomeIndex) ?? [];
      list.push(h);
      byOutcome.set(h.outcomeIndex, list);
    }

    return base.map((outcome) => {
      const idx = outcome.holders[0]?.outcomeIndex ?? 0;
      const all = byOutcome.get(idx) ?? [];
      all.sort((a, b) => b.amount - a.amount);
      return { token: outcome.token, holders: all.slice(0, target) };
    });
  }

  /**
   * Drop the entire in-memory cache. Use when a caller needs absolutely
   * fresh data across every endpoint (holders, trades, leaderboard,
   * per-wallet positions, closed positions). More expensive than
   * `invalidateForConditionId` because it forces re-fetch of leaderboard
   * + every wallet's positions — but guarantees no staleness.
   */
  invalidateAll(): number {
    const n = this.cache.size;
    this.cache.clear();
    return n;
  }

  /**
   * Drop every cache entry mentioning `conditionId` so the next lookup
   * hits Polymarket fresh. Used when a caller explicitly asks for live
   * data (e.g. a POST that needs the newest holder positions).
   */
  invalidateForConditionId(conditionId: string): number {
    let dropped = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(conditionId)) {
        this.cache.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /** Memoising wrapper: same key returns same result until TTL expires. */
  private async cached<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
    const value = await fetcher();
    this.cache.set(key, { value, expiresAt: now + ttlMs });
    return value;
  }
}
