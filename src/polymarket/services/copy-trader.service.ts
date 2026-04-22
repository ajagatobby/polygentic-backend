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

  // ─── Config ────────────────────────────────────────────────────────

  async getConfig() {
    const rows = await this.db
      .select()
      .from(schema.copyTraderConfig)
      .where(eq(schema.copyTraderConfig.profile, 'default'))
      .limit(1);
    if (rows.length > 0) return rows[0];
    // Seed-if-missing so the consumer always gets a usable row.
    const [inserted] = await this.db
      .insert(schema.copyTraderConfig)
      .values({ profile: 'default' })
      .onConflictDoNothing({ target: schema.copyTraderConfig.profile })
      .returning();
    if (inserted) return inserted;
    // Row existed between check and insert — re-read.
    const [row] = await this.db
      .select()
      .from(schema.copyTraderConfig)
      .where(eq(schema.copyTraderConfig.profile, 'default'))
      .limit(1);
    return row;
  }

  async updateConfig(
    patch: Partial<{
      enabled: boolean;
      syncIntervalMinutes: number;
      defaultSizingMode: 'fixed' | 'fraction' | 'kelly';
      defaultSizingValue: number;
      defaultMaxPositionUsd: number;
      maxDailyTrades: number;
      maxDailySpendUsd: number;
      priceSlippageTolerance: number;
      maxConsecutiveLosses: number;
    }>,
  ) {
    await this.getConfig(); // ensure row exists
    const set: any = { updatedAt: new Date() };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.syncIntervalMinutes !== undefined)
      set.syncIntervalMinutes = Math.max(1, Math.round(patch.syncIntervalMinutes));
    if (patch.defaultSizingMode !== undefined)
      set.defaultSizingMode = patch.defaultSizingMode;
    if (patch.defaultSizingValue !== undefined)
      set.defaultSizingValue = String(patch.defaultSizingValue);
    if (patch.defaultMaxPositionUsd !== undefined)
      set.defaultMaxPositionUsd = String(patch.defaultMaxPositionUsd);
    if (patch.maxDailyTrades !== undefined)
      set.maxDailyTrades = Math.max(0, Math.round(patch.maxDailyTrades));
    if (patch.maxDailySpendUsd !== undefined)
      set.maxDailySpendUsd = String(patch.maxDailySpendUsd);
    if (patch.priceSlippageTolerance !== undefined)
      set.priceSlippageTolerance = String(patch.priceSlippageTolerance);
    if (patch.maxConsecutiveLosses !== undefined)
      set.maxConsecutiveLosses = Math.max(
        0,
        Math.round(patch.maxConsecutiveLosses),
      );

    const [row] = await this.db
      .update(schema.copyTraderConfig)
      .set(set)
      .where(eq(schema.copyTraderConfig.profile, 'default'))
      .returning();
    return row;
  }

  /** Count today's executed + paper copy trades and total USD spent. */
  private async getTodayStats(): Promise<{
    count: number;
    spendUsd: number;
  }> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const rows = await this.db
      .select({
        id: schema.copiedTraderTrades.id,
        ourPositionSizeUsd: schema.copiedTraderTrades.ourPositionSizeUsd,
      })
      .from(schema.copiedTraderTrades)
      .where(
        and(
          gte(schema.copiedTraderTrades.detectedAt, start),
          inArray(schema.copiedTraderTrades.executionStatus, [
            'executed',
            'paper',
          ]),
        ),
      );
    const count = rows.length;
    const spendUsd = rows.reduce(
      (s: number, r: any) => s + Number(r.ourPositionSizeUsd ?? 0),
      0,
    );
    return { count, spendUsd };
  }

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
  async sync(opts: { force?: boolean } = {}): Promise<{
    scanned: number;
    newTradesDetected: number;
    executed: number;
    paper: number;
    skipped: number;
    failed: number;
    durationMs: number;
    skippedReason?: string;
  }> {
    const startedAt = Date.now();
    const config = await this.getConfig();

    // Master kill-switch
    if (!config.enabled && !opts.force) {
      return {
        scanned: 0,
        newTradesDetected: 0,
        executed: 0,
        paper: 0,
        skipped: 0,
        failed: 0,
        durationMs: Date.now() - startedAt,
        skippedReason: 'copy_trader_config.enabled=false',
      };
    }

    // Rate-limit to sync_interval_minutes even if the cron fires faster.
    if (!opts.force && config.lastSyncAt) {
      const elapsedMs = Date.now() - new Date(config.lastSyncAt).getTime();
      const minMs = Number(config.syncIntervalMinutes) * 60_000;
      if (elapsedMs < minMs) {
        return {
          scanned: 0,
          newTradesDetected: 0,
          executed: 0,
          paper: 0,
          skipped: 0,
          failed: 0,
          durationMs: Date.now() - startedAt,
          skippedReason: `within sync_interval_minutes window (${Math.round(elapsedMs / 60_000)}min since last sync, interval=${config.syncIntervalMinutes}min)`,
        };
      }
    }

    // Mark the sync start — other parallel calls within window will bail.
    await this.db
      .update(schema.copyTraderConfig)
      .set({ lastSyncAt: new Date() })
      .where(eq(schema.copyTraderConfig.profile, 'default'));

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
        const result = await this.syncTrader(trader, config);
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
    config?: any,
  ): Promise<{
    newTrades: Array<{ executionStatus: string }>;
  }> {
    const cfg = config ?? (await this.getConfig());
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
      const detection = await this.recordAndMaybeExecute(
        trader,
        p,
        { tradeType, sizeDelta },
        cfg,
      );
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
    config: any,
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

    // If copy is off globally OR for this trader, just log the detection.
    if (!config.enabled) {
      await this.db
        .update(schema.copiedTraderTrades)
        .set({
          executionStatus: 'skipped',
          executionReason: 'copy_trader_config.enabled=false (global)',
        })
        .where(eq(schema.copiedTraderTrades.id, row.id));
      return { executionStatus: 'skipped' };
    }
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

    // Daily caps — across all followed wallets combined.
    const today = await this.getTodayStats();
    if (today.count >= Number(config.maxDailyTrades)) {
      await this.db
        .update(schema.copiedTraderTrades)
        .set({
          executionStatus: 'skipped',
          executionReason: `Daily trade cap reached (${today.count}/${config.maxDailyTrades})`,
        })
        .where(eq(schema.copiedTraderTrades.id, row.id));
      return { executionStatus: 'skipped' };
    }
    if (today.spendUsd >= Number(config.maxDailySpendUsd)) {
      await this.db
        .update(schema.copiedTraderTrades)
        .set({
          executionStatus: 'skipped',
          executionReason: `Daily spend cap reached ($${today.spendUsd.toFixed(2)} / $${Number(config.maxDailySpendUsd).toFixed(2)})`,
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

    // Compute our position size. Per-trader setting wins; config defaults
    // fill in gaps so a wallet added with `{proxyWallet}` alone still works.
    const sizingMode =
      (trader.sizingMode as string) ?? config.defaultSizingMode ?? 'fraction';
    const sizingValue = Number(
      trader.sizingValue ?? config.defaultSizingValue ?? 0.005,
    );
    const maxPositionUsd = Number(
      trader.maxPositionUsd ?? config.defaultMaxPositionUsd ?? 50,
    );
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

    // Slippage guard: if the current market is far from the followed
    // wallet's avg, skip. position.curPrice is set by the data-api.
    const currentPrice = Number(position.curPrice ?? targetPrice);
    const slippageTolerance = Number(config.priceSlippageTolerance ?? 0.05);
    if (slippageTolerance > 0 && targetPrice > 0) {
      const drift = Math.abs(currentPrice - targetPrice) / targetPrice;
      if (drift > slippageTolerance) {
        await this.db
          .update(schema.copiedTraderTrades)
          .set({
            executionStatus: 'skipped',
            executionReason: `Price drift ${(drift * 100).toFixed(2)}% > tolerance ${(slippageTolerance * 100).toFixed(2)}% (trader paid $${targetPrice.toFixed(4)}, market now $${currentPrice.toFixed(4)})`,
            ourPositionSizeUsd: String(ourPositionUsd),
          })
          .where(eq(schema.copiedTraderTrades.id, row.id));
        return { executionStatus: 'skipped' };
      }
    }

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
      await this.maybeCircuitBreak(config);
      return { executionStatus: 'failed' };
    }
  }

  /**
   * Circuit breaker. If the last N executions all have
   * execution_status='failed', flip enabled=false on the config. Admin
   * has to explicitly re-enable. Default N = 5 (configurable).
   */
  private async maybeCircuitBreak(config: any): Promise<void> {
    const maxLosses = Number(config.maxConsecutiveLosses ?? 0);
    if (maxLosses <= 0) return;

    const recent = await this.db
      .select({ executionStatus: schema.copiedTraderTrades.executionStatus })
      .from(schema.copiedTraderTrades)
      .where(
        inArray(schema.copiedTraderTrades.executionStatus, [
          'executed',
          'failed',
        ]),
      )
      .orderBy(desc(schema.copiedTraderTrades.detectedAt))
      .limit(maxLosses);

    if (recent.length < maxLosses) return;
    const allFailed = recent.every(
      (r: any) => r.executionStatus === 'failed',
    );
    if (!allFailed) return;

    await this.db
      .update(schema.copyTraderConfig)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(schema.copyTraderConfig.profile, 'default'));
    this.logger.error(
      `Copy-trader circuit breaker tripped — ${maxLosses} consecutive failed executions. Config.enabled set to false.`,
    );
  }
}
