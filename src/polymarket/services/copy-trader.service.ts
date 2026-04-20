import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../../database/schema';
import { PolymarketDataService, UserPosition } from './polymarket-data.service';
import { PolymarketClobService } from './polymarket-clob.service';
import { SmartMoneySignalService } from './smart-money-signal.service';

/**
 * Copy-trader system. Admin adds wallets to a global follow list; a
 * periodic sync polls each wallet's positions on Polymarket, diffs
 * against the last snapshot, and (optionally) places matching trades
 * via the CLOB.
 *
 * Safety:
 *   - copy_enabled default false — follow = detect only until
 *     operator flips it on
 *   - Per-wallet max_position_usd cap
 *   - Optional min_last_10_wins / min_lifetime_pnl / min_lifetime_roi
 *     re-check at execution time (skip if the followed wallet
 *     cooled off)
 *   - Honors global polymarket_config gates
 *     (liveTradingEnabled, stop-loss, max-consecutive-losses)
 *     via the standard placeLimitOrder path
 */
@Injectable()
export class CopyTraderService {
  private readonly logger = new Logger(CopyTraderService.name);

  constructor(
    @Inject('DRIZZLE') private readonly db: any,
    private readonly data: PolymarketDataService,
    private readonly clob: PolymarketClobService,
    private readonly smartMoneyService: SmartMoneySignalService,
  ) {}

  // ─── Follow-list CRUD ──────────────────────────────────────────────

  async follow(input: {
    proxyWallet: string;
    nickname?: string;
    copyEnabled?: boolean;
    sizingMode?: 'fixed' | 'fraction' | 'kelly';
    sizingValue?: number;
    maxPositionUsd?: number;
    minLast10Wins?: number;
    minLifetimePnl?: number;
    minLifetimeRoi?: number;
    notes?: string;
  }) {
    const values = {
      proxyWallet: input.proxyWallet.toLowerCase(),
      nickname: input.nickname ?? null,
      copyEnabled: input.copyEnabled ?? false,
      sizingMode: input.sizingMode ?? 'fraction',
      sizingValue: String(input.sizingValue ?? 0.005),
      maxPositionUsd: String(input.maxPositionUsd ?? 50),
      minLast10Wins: input.minLast10Wins ?? null,
      minLifetimePnl:
        input.minLifetimePnl != null ? String(input.minLifetimePnl) : null,
      minLifetimeRoi:
        input.minLifetimeRoi != null ? String(input.minLifetimeRoi) : null,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    };

    const [row] = await this.db
      .insert(schema.copiedTraders)
      .values({ ...values, active: true })
      .onConflictDoUpdate({
        target: schema.copiedTraders.proxyWallet,
        set: { ...values, active: true },
      })
      .returning();
    return row;
  }

  async unfollow(proxyWallet: string) {
    const [row] = await this.db
      .update(schema.copiedTraders)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.copiedTraders.proxyWallet, proxyWallet.toLowerCase()))
      .returning();
    return row ?? null;
  }

  async update(
    proxyWallet: string,
    patch: Partial<{
      nickname: string | null;
      copyEnabled: boolean;
      sizingMode: 'fixed' | 'fraction' | 'kelly';
      sizingValue: number;
      maxPositionUsd: number;
      minLast10Wins: number | null;
      minLifetimePnl: number | null;
      minLifetimeRoi: number | null;
      notes: string | null;
      active: boolean;
    }>,
  ) {
    const set: any = { updatedAt: new Date() };
    if (patch.nickname !== undefined) set.nickname = patch.nickname;
    if (patch.copyEnabled !== undefined) set.copyEnabled = patch.copyEnabled;
    if (patch.sizingMode !== undefined) set.sizingMode = patch.sizingMode;
    if (patch.sizingValue !== undefined)
      set.sizingValue = String(patch.sizingValue);
    if (patch.maxPositionUsd !== undefined)
      set.maxPositionUsd = String(patch.maxPositionUsd);
    if (patch.minLast10Wins !== undefined)
      set.minLast10Wins = patch.minLast10Wins;
    if (patch.minLifetimePnl !== undefined)
      set.minLifetimePnl =
        patch.minLifetimePnl != null ? String(patch.minLifetimePnl) : null;
    if (patch.minLifetimeRoi !== undefined)
      set.minLifetimeRoi =
        patch.minLifetimeRoi != null ? String(patch.minLifetimeRoi) : null;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.active !== undefined) set.active = patch.active;

    const [row] = await this.db
      .update(schema.copiedTraders)
      .set(set)
      .where(eq(schema.copiedTraders.proxyWallet, proxyWallet.toLowerCase()))
      .returning();
    return row ?? null;
  }

  async list(opts: { activeOnly?: boolean } = {}) {
    const rows = opts.activeOnly
      ? await this.db
          .select()
          .from(schema.copiedTraders)
          .where(eq(schema.copiedTraders.active, true))
          .orderBy(desc(schema.copiedTraders.addedAt))
      : await this.db
          .select()
          .from(schema.copiedTraders)
          .orderBy(desc(schema.copiedTraders.addedAt));
    return rows;
  }

  async getDetectedTrades(filters: {
    since?: Date;
    wallet?: string;
    executionStatus?: string;
    limit?: number;
  } = {}) {
    const conds: any[] = [];
    if (filters.since)
      conds.push(gte(schema.copiedTraderTrades.detectedAt, filters.since));
    if (filters.wallet)
      conds.push(
        eq(
          schema.copiedTraderTrades.proxyWallet,
          filters.wallet.toLowerCase(),
        ),
      );
    if (filters.executionStatus)
      conds.push(
        eq(
          schema.copiedTraderTrades.executionStatus,
          filters.executionStatus,
        ),
      );

    const base = this.db
      .select()
      .from(schema.copiedTraderTrades)
      .orderBy(desc(schema.copiedTraderTrades.detectedAt))
      .limit(Math.min(500, Math.max(1, filters.limit ?? 100)));
    return conds.length > 0 ? base.where(and(...conds)) : base;
  }

  // ─── Sync (detection + optional execution) ────────────────────────

  /**
   * Poll every active followed wallet for its current positions, diff
   * against our stored snapshot, and (if copy_enabled) place matching
   * CLOB orders for new/increased positions. Idempotent-ish — running
   * it twice without new trades is a no-op except for snapshot
   * last_seen_at bumps.
   */
  async sync(): Promise<{
    scanned: number;
    newTradesDetected: number;
    executed: number;
    paper: number;
    skipped: number;
    failed: number;
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const traders = await this.list({ activeOnly: true });
    if (traders.length === 0) {
      return {
        scanned: 0,
        newTradesDetected: 0,
        executed: 0,
        paper: 0,
        skipped: 0,
        failed: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    let newTradesDetected = 0;
    let executed = 0;
    let paper = 0;
    let skipped = 0;
    let failed = 0;

    // Process wallets serially — each syncTrader runs its own bounded
    // parallelism internally. Serial here prevents us from hammering
    // the data-api with a burst of positions calls.
    for (const trader of traders) {
      try {
        const result = await this.syncTrader(trader);
        newTradesDetected += result.newTrades.length;
        for (const t of result.newTrades) {
          if (t.executionStatus === 'executed') executed++;
          else if (t.executionStatus === 'paper') paper++;
          else if (t.executionStatus === 'failed') failed++;
          else if (t.executionStatus === 'skipped') skipped++;
        }
      } catch (err) {
        this.logger.warn(
          `syncTrader(${trader.proxyWallet}) failed: ${
            (err as Error).message
          }`,
        );
      }
    }

    return {
      scanned: traders.length,
      newTradesDetected,
      executed,
      paper,
      skipped,
      failed,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Sync a single followed wallet: fetch positions, diff, log, execute.
   */
  async syncTrader(
    trader: any,
  ): Promise<{
    newTrades: Array<{ executionStatus: string }>;
  }> {
    const wallet = (trader.proxyWallet as string).toLowerCase();

    const positions = await this.data.getUserPositions(wallet, { limit: 200 });
    if (!positions || positions.length === 0) {
      return { newTrades: [] };
    }

    // Load existing snapshots for this wallet so we can diff.
    const existingRows = await this.db
      .select()
      .from(schema.copiedTraderPositions)
      .where(eq(schema.copiedTraderPositions.proxyWallet, wallet));
    const snapshotByKey = new Map<string, any>();
    for (const r of existingRows) {
      snapshotByKey.set(
        `${r.conditionId}:${r.outcomeIndex}`,
        r,
      );
    }

    // Filter positions we care about: open, binary markets, non-trivial.
    const activePositions = positions.filter(
      (p) => p.size > 0 && p.conditionId && p.asset,
    );

    const newTrades: Array<{ executionStatus: string }> = [];
    const seenKeys = new Set<string>();

    for (const p of activePositions) {
      const key = `${p.conditionId}:${p.outcomeIndex}`;
      seenKeys.add(key);
      const existing = snapshotByKey.get(key);

      let tradeType: 'new' | 'increased' | null = null;
      let sizeDelta = 0;
      const currentSize = Number(p.size ?? 0);
      const previousSize = Number(existing?.size ?? 0);
      if (!existing) {
        tradeType = 'new';
        sizeDelta = currentSize;
      } else if (currentSize > previousSize * 1.05) {
        // 5% grace — ignore rounding noise from PnL updates
        tradeType = 'increased';
        sizeDelta = currentSize - previousSize;
      }

      // Upsert snapshot regardless — last_seen tracking
      await this.db
        .insert(schema.copiedTraderPositions)
        .values({
          proxyWallet: wallet,
          conditionId: p.conditionId,
          outcomeIndex: p.outcomeIndex,
          asset: p.asset,
          marketQuestion: p.title ?? null,
          slug: p.slug ?? null,
          eventSlug: p.eventSlug ?? null,
          size: String(currentSize),
          avgPrice: String(p.avgPrice ?? 0),
          totalBought: String(p.totalBought ?? 0),
          currentValue: String(p.currentValue ?? 0),
          lastSize: String(previousSize),
          firstSeenAt: existing?.firstSeenAt ?? new Date(),
          lastSeenAt: new Date(),
          status: 'open',
        })
        .onConflictDoUpdate({
          target: [
            schema.copiedTraderPositions.proxyWallet,
            schema.copiedTraderPositions.conditionId,
            schema.copiedTraderPositions.outcomeIndex,
          ],
          set: {
            size: String(currentSize),
            avgPrice: String(p.avgPrice ?? 0),
            totalBought: String(p.totalBought ?? 0),
            currentValue: String(p.currentValue ?? 0),
            lastSize: String(previousSize),
            lastSeenAt: new Date(),
            status: 'open',
          },
        });

      if (tradeType == null) continue; // no change worth logging

      // Detected trade — log it and maybe execute.
      const detection = await this.recordAndMaybeExecute(trader, p, {
        tradeType,
        sizeDelta,
      });
      newTrades.push({ executionStatus: detection.executionStatus });
    }

    // Mark positions that disappeared as closed.
    for (const [key, existing] of snapshotByKey) {
      if (seenKeys.has(key)) continue;
      if (existing.status === 'closed') continue;
      await this.db
        .update(schema.copiedTraderPositions)
        .set({ status: 'closed', lastSeenAt: new Date() })
        .where(eq(schema.copiedTraderPositions.id, existing.id));
    }

    return { newTrades };
  }

  // ─── Per-trade detect + execute ───────────────────────────────────

  private async recordAndMaybeExecute(
    trader: any,
    position: UserPosition,
    delta: { tradeType: 'new' | 'increased'; sizeDelta: number },
  ): Promise<{ executionStatus: string }> {
    const wallet = trader.proxyWallet as string;
    const copyEnabled = trader.copyEnabled === true;

    // Start with a pending log row; we'll overwrite executionStatus
    // when we're done.
    const [row] = await this.db
      .insert(schema.copiedTraderTrades)
      .values({
        proxyWallet: wallet,
        nickname: trader.nickname ?? null,
        conditionId: position.conditionId,
        outcomeIndex: position.outcomeIndex,
        outcomeName: position.outcome ?? null,
        marketQuestion: position.title ?? null,
        slug: position.slug ?? null,
        eventSlug: position.eventSlug ?? null,
        followedSize: String(position.size),
        followedAvgPrice: String(position.avgPrice ?? 0),
        sizeDelta: String(delta.sizeDelta),
        tradeType: delta.tradeType,
        executionStatus: 'pending',
      })
      .returning();

    // If copy is off for this trader, we just want a detection log.
    if (!copyEnabled) {
      await this.db
        .update(schema.copiedTraderTrades)
        .set({
          executionStatus: 'skipped',
          executionReason: 'copy_enabled=false — detection only',
        })
        .where(eq(schema.copiedTraderTrades.id, row.id));
      return { executionStatus: 'skipped' };
    }

    // Optional gate: check the followed wallet's current sharp form
    // and skip if they cooled off since we added them.
    if (
      trader.minLast10Wins != null ||
      trader.minLifetimePnl != null ||
      trader.minLifetimeRoi != null
    ) {
      try {
        const stats = await this.smartMoneyService.getWalletLifetimeStats(
          wallet,
        );
        const roi =
          stats.totalBought > 0 ? stats.totalPnl / stats.totalBought : 0;
        const fails: string[] = [];
        if (
          trader.minLast10Wins != null &&
          (stats.last10Wins ?? -1) < Number(trader.minLast10Wins)
        ) {
          fails.push(
            `last10Wins ${stats.last10Wins ?? 'n/a'} < ${trader.minLast10Wins}`,
          );
        }
        if (
          trader.minLifetimePnl != null &&
          stats.totalPnl < Number(trader.minLifetimePnl)
        ) {
          fails.push(
            `lifetimePnl ${stats.totalPnl.toFixed(0)} < ${trader.minLifetimePnl}`,
          );
        }
        if (
          trader.minLifetimeRoi != null &&
          roi < Number(trader.minLifetimeRoi)
        ) {
          fails.push(
            `lifetimeRoi ${roi.toFixed(3)} < ${trader.minLifetimeRoi}`,
          );
        }
        if (fails.length > 0) {
          await this.db
            .update(schema.copiedTraderTrades)
            .set({
              executionStatus: 'skipped',
              executionReason: `Trader cooled off: ${fails.join('; ')}`,
            })
            .where(eq(schema.copiedTraderTrades.id, row.id));
          return { executionStatus: 'skipped' };
        }
      } catch (err) {
        this.logger.warn(
          `Cooldown re-check failed for ${wallet}: ${(err as Error).message}`,
        );
      }
    }

    // Compute our position size based on the trader's sizing config.
    const sizingMode = (trader.sizingMode as string) ?? 'fraction';
    const sizingValue = Number(trader.sizingValue ?? 0.005);
    const maxPositionUsd = Number(trader.maxPositionUsd ?? 50);
    const followedDollars =
      delta.sizeDelta * Number(position.avgPrice ?? position.curPrice ?? 0.5);

    let ourPositionUsd = 0;
    if (sizingMode === 'fixed') {
      ourPositionUsd = sizingValue;
    } else if (sizingMode === 'fraction') {
      ourPositionUsd = followedDollars * sizingValue;
    } else if (sizingMode === 'kelly') {
      // Kelly requires edge estimation; fall back to fraction for now.
      // A real Kelly path would go through the trading agent's
      // position-sizing flow.
      ourPositionUsd = followedDollars * 0.01;
    }
    ourPositionUsd = Math.min(ourPositionUsd, maxPositionUsd);
    ourPositionUsd = Math.max(1, Math.round(ourPositionUsd * 100) / 100);

    // Price to target: use their avg price (good-faith copy of their
    // cost basis). CLOB price tick-rounds internally.
    const targetPrice = Math.max(
      0.01,
      Math.min(0.99, Number(position.avgPrice ?? 0.5)),
    );
    const tokenSize = ourPositionUsd / targetPrice;

    try {
      const order = await this.clob.placeLimitOrder({
        tokenId: position.asset,
        side: 'BUY',
        price: targetPrice,
        size: tokenSize,
        conditionId: position.conditionId,
        negRisk: position.negativeRisk,
      });

      if (!order) {
        // CLOB not available or live trading disabled → paper.
        await this.db
          .update(schema.copiedTraderTrades)
          .set({
            executionStatus: 'paper',
            executionReason:
              'CLOB order skipped — client not available or live trading disabled',
            ourPositionSizeUsd: String(ourPositionUsd),
            executedAt: new Date(),
          })
          .where(eq(schema.copiedTraderTrades.id, row.id));
        return { executionStatus: 'paper' };
      }

      await this.db
        .update(schema.copiedTraderTrades)
        .set({
          executionStatus: 'executed',
          executionReason: `Copy-trade placed: ${tokenSize.toFixed(2)} tokens @ $${targetPrice.toFixed(4)}`,
          ourPositionSizeUsd: String(ourPositionUsd),
          ourClobOrderId: order.orderId,
          executedAt: new Date(),
        })
        .where(eq(schema.copiedTraderTrades.id, row.id));
      return { executionStatus: 'executed' };
    } catch (err) {
      await this.db
        .update(schema.copiedTraderTrades)
        .set({
          executionStatus: 'failed',
          executionReason: (err as Error).message,
        })
        .where(eq(schema.copiedTraderTrades.id, row.id));
      return { executionStatus: 'failed' };
    }
  }
}
