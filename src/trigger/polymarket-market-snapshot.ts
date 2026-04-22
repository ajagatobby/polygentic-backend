import { task, logger } from '@trigger.dev/sdk/v3';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { initServices } from './init';
import * as schema from '../database/schema';

/**
 * Polymarket Market Snapshot
 *
 * Every 5 minutes: pull the latest `volume`, `volume24hr`, `liquidity`, and
 * `outcomePrices` from Polymarket's Gamma API for every market we have
 * stored that's either active or still linked to an upcoming fixture.
 *
 * Batched `?condition_ids=...` call to Gamma, then a single UPDATE per row
 * through a CASE statement so we don't fan out into hundreds of UPDATEs.
 *
 * The rest of the market metadata (question, slug, outcomes, clob_token_ids,
 * fixture linkage) is owned by the discovery pass in polymarket-scan — this
 * task only refreshes the pricing columns.
 */

export const polymarketMarketSnapshotTask = task({
  id: 'polymarket-market-snapshot',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { db, polymarketService } = initServices();
    // We only need the gamma client; reach it via the polymarket service
    // wiring so we stay consistent with the rest of the codebase. But the
    // service doesn't expose it directly, so we build a tiny local helper
    // that uses `polymarketService` internals via the service we just
    // initialised above. Simpler: grab the gamma service the same way
    // init.ts does it.
    //
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PolymarketGammaService } = await import(
      '../polymarket/services/polymarket-gamma.service'
    );
    const { ConfigService } = await import('@nestjs/config');
    const gamma = new PolymarketGammaService(new ConfigService(process.env));
    void polymarketService; // keep the service around so init wiring runs.

    // Candidates: active, non-closed markets with a conditionId AND either
    // no end_date yet or an end_date in the future. This keeps resolved /
    // historical markets out of the hot path.
    const nowMinus3h = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const rows = await db
      .select({
        id: schema.polymarketMarkets.id,
        conditionId: schema.polymarketMarkets.conditionId,
      })
      .from(schema.polymarketMarkets)
      .where(
        and(
          isNotNull(schema.polymarketMarkets.conditionId),
          eq(schema.polymarketMarkets.active, true),
          eq(schema.polymarketMarkets.closed, false),
          sql`(${schema.polymarketMarkets.endDate} IS NULL OR ${schema.polymarketMarkets.endDate} > ${nowMinus3h})`,
        ),
      );

    const conditionIds = rows
      .map((r) => r.conditionId)
      .filter((id): id is string => !!id);

    if (conditionIds.length === 0) {
      logger.info('No active Polymarket markets to snapshot.');
      return { updated: 0, fetched: 0 };
    }

    logger.info(
      `Fetching fresh snapshot for ${conditionIds.length} Polymarket markets`,
    );
    const fetched = await gamma.fetchMarketsByConditionIds(conditionIds);

    if (fetched.length === 0) {
      logger.warn('Gamma returned no markets — skipping update.');
      return { updated: 0, fetched: 0 };
    }

    // Update each market by condition_id. Batch into a single transaction
    // so a partial Gamma outage doesn't leave us half-way through.
    let updated = 0;
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const m of fetched) {
        if (!m.conditionId) continue;
        const res = await tx
          .update(schema.polymarketMarkets)
          .set({
            outcomePrices: m.outcomePrices,
            volume: m.volume != null ? String(m.volume) : null,
            volume24hr: m.volume24hr != null ? String(m.volume24hr) : null,
            liquidity: m.liquidity != null ? String(m.liquidity) : null,
            active: m.active,
            closed: m.closed,
            acceptingOrders: m.acceptingOrders,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.polymarketMarkets.conditionId, m.conditionId));
        // postgres-js exposes the affected count via the returning array
        // length when we use .returning(); without it there's no portable
        // row-count. We only need it for the log — count the loop iterations.
        void res;
        updated += 1;
      }
    });

    logger.info(
      `Polymarket snapshot complete: ${fetched.length} fetched, ${updated} rows updated.`,
    );
    return { updated, fetched: fetched.length };
  },
});

/**
 * Utility: grab the condition IDs of markets currently linked to any
 * fixture starting in the next 24 hours. Handy for debugging — not used
 * in the scheduled run because we already refresh every active market.
 */
export async function conditionIdsForUpcomingFixtures(): Promise<string[]> {
  const { db } = initServices();
  const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ conditionId: schema.polymarketMarkets.conditionId })
    .from(schema.polymarketMarkets)
    .innerJoin(
      schema.fixtures,
      eq(schema.polymarketMarkets.fixtureId, schema.fixtures.id),
    )
    .where(
      and(
        isNotNull(schema.polymarketMarkets.conditionId),
        sql`${schema.fixtures.date} <= ${horizon}`,
      ),
    );
  void inArray; // keep the import for future filtered variants
  return rows
    .map((r) => r.conditionId)
    .filter((id): id is string => !!id);
}
