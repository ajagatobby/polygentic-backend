import { task, logger } from '@trigger.dev/sdk/v3';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { initServices } from './init';
import * as schema from '../database/schema';

/**
 * Polymarket Market Backfill
 *
 * For every active Polymarket market that has ZERO rows in
 * polymarket_price_snapshots, pull its CLOB /prices-history endpoint
 * and insert a real historical curve (~288 points / 24h at fidelity=5).
 *
 * Runs on demand (invoke from controller or manually from the dashboard).
 * Safe to re-run — the "zero rows" filter makes it idempotent.
 *
 * Throttle: ~250ms between token calls so Polymarket's rate limiter
 * doesn't trip.
 */

const CLOB_BASE = 'https://clob.polymarket.com';
const REQUEST_DELAY_MS = 250;

type PriceHistoryResponse = {
  history?: Array<{ t: number; p: number }>;
};

async function fetchPriceHistory(
  tokenId: string,
  interval = '1d',
  fidelity = 5,
): Promise<Array<{ t: number; p: number }>> {
  const url = `${CLOB_BASE}/prices-history?market=${encodeURIComponent(
    tokenId,
  )}&interval=${interval}&fidelity=${fidelity}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as PriceHistoryResponse;
    return body?.history ?? [];
  } catch (err) {
    logger.warn(
      `CLOB history fetch failed for ${tokenId.slice(0, 10)}…: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const polymarketBackfillHistoryTask = task({
  id: 'polymarket-backfill-history',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async (payload: { limit?: number } = {}) => {
    const { db } = initServices();
    const limit = Math.max(1, Math.min(1_000, payload.limit ?? 500));

    // Find active markets with zero snapshot history. A left-join +
    // null-check is the cleanest way; we only care about conditionIds
    // that don't appear in polymarket_price_snapshots at all.
    const candidates = (await db
      .select({
        id: schema.polymarketMarkets.id,
        marketId: schema.polymarketMarkets.marketId,
        conditionId: schema.polymarketMarkets.conditionId,
        clobTokenIds: schema.polymarketMarkets.clobTokenIds,
        volume24hr: schema.polymarketMarkets.volume24hr,
      })
      .from(schema.polymarketMarkets)
      .where(
        and(
          isNotNull(schema.polymarketMarkets.conditionId),
          eq(schema.polymarketMarkets.active, true),
          eq(schema.polymarketMarkets.closed, false),
          sql`NOT EXISTS (
            SELECT 1 FROM ${schema.polymarketPriceSnapshots} s
            WHERE s.condition_id = ${schema.polymarketMarkets.conditionId}
          )`,
        ),
      )
      .orderBy(sql`${schema.polymarketMarkets.volume24hr} DESC NULLS LAST`)
      .limit(limit)) as Array<{
      id: number;
      marketId: string;
      conditionId: string;
      clobTokenIds: string[] | null;
      volume24hr: string | null;
    }>;

    logger.info(
      `Backfilling history for ${candidates.length} markets (no existing snapshots)`,
    );

    let filled = 0;
    let skipped = 0;
    let totalRows = 0;

    for (const market of candidates) {
      const tokens = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : [];
      if (tokens.length === 0) {
        skipped++;
        continue;
      }

      const yesToken = tokens[0];
      const noToken = tokens[1] ?? null;

      const yesHistory = await fetchPriceHistory(yesToken);
      await delay(REQUEST_DELAY_MS);
      const noHistory = noToken ? await fetchPriceHistory(noToken) : [];
      if (noToken) await delay(REQUEST_DELAY_MS);

      if (yesHistory.length === 0) {
        skipped++;
        continue;
      }

      const noMap = new Map(noHistory.map((p) => [p.t, p.p]));

      const batch = yesHistory.map((p) => {
        const otherRaw = noMap.has(p.t) ? noMap.get(p.t) : 1 - p.p;
        const other = otherRaw ?? 1 - p.p;
        return {
          marketId: market.marketId,
          conditionId: market.conditionId,
          snapshotAt: new Date(p.t * 1000),
          outcomePrices: [String(p.p), String(other)] as string[],
          volume: null,
          volume24hr: market.volume24hr,
          liquidity: null,
        };
      });

      if (batch.length > 0) {
        await db.insert(schema.polymarketPriceSnapshots).values(batch);
        filled++;
        totalRows += batch.length;
      } else {
        skipped++;
      }
    }

    logger.info(
      `Backfill complete: ${filled} markets filled (${totalRows} rows), ${skipped} skipped.`,
    );
    return { filled, skipped, totalRows };
  },
});
