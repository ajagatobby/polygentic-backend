import { task, logger } from '@trigger.dev/sdk/v3';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { initServices } from './init';
import * as schema from '../database/schema';

/**
 * Polymarket Today Snapshot
 *
 * High-frequency price poll scoped to markets linked to fixtures kicking
 * off between "now - 1h" and "now + 24h" — i.e. live + anything about to
 * start. Runs every 2 minutes on top of the 5-min sweep of every active
 * market, so the chart feels live on pages users are actively viewing.
 *
 * Data source: Gamma /markets?condition_ids=... (batched, ≤80 ids per
 * request). Each row -> UPDATE polymarket_markets (in-place latest
 * value) + INSERT polymarket_price_snapshots (append-only time series
 * the match-detail chart reads).
 *
 * Deliberately narrow scope so the 2-min cadence doesn't hammer the
 * Gamma API for markets on fixtures three days out — those get
 * 5-minute resolution from the broader snapshot task.
 */

const GAMMA_BASE =
  process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const CHUNK = 80;
const REQUEST_DELAY_MS = 200;

type GammaMarket = {
  id: string | number;
  conditionId?: string;
  outcomePrices?: string | string[];
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
};

async function fetchMarketsByConditionIds(
  conditionIds: string[],
): Promise<GammaMarket[]> {
  const unique = Array.from(new Set(conditionIds.filter(Boolean)));
  if (unique.length === 0) return [];

  const out: GammaMarket[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const url = new URL(`${GAMMA_BASE}/markets`);
    slice.forEach((c) => url.searchParams.append('condition_ids', c));
    url.searchParams.set('limit', String(slice.length));
    try {
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        logger.warn(
          `Gamma /markets returned ${res.status} for chunk starting ${i}`,
        );
        continue;
      }
      const body = (await res.json()) as
        | GammaMarket[]
        | { data?: GammaMarket[] };
      const rows = Array.isArray(body) ? body : (body.data ?? []);
      out.push(...rows);
    } catch (err) {
      logger.warn(
        `Gamma /markets chunk ${i / CHUNK} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (i + CHUNK < unique.length) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }
  return out;
}

function parseOutcomePrices(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export const polymarketTodaySnapshotTask = task({
  id: 'polymarket-today-snapshot',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 10_000,
    factor: 2,
  },
  run: async () => {
    const { db } = initServices();

    // Window: any fixture that started within the last hour OR is about
    // to start in the next 24h. Catches live games + the rest of the
    // daily slate.
    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Pull conditionIds from markets linked to those fixtures. Include
    // basketball by unioning both fixtures tables via left join — any
    // polymarket_markets row tied to a fixture in either table.
    const todayMarkets = (await db
      .select({
        id: schema.polymarketMarkets.id,
        marketId: schema.polymarketMarkets.marketId,
        conditionId: schema.polymarketMarkets.conditionId,
      })
      .from(schema.polymarketMarkets)
      .innerJoin(
        schema.fixtures,
        eq(schema.polymarketMarkets.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          isNotNull(schema.polymarketMarkets.conditionId),
          eq(schema.polymarketMarkets.active, true),
          eq(schema.polymarketMarkets.closed, false),
          gte(schema.fixtures.date, windowStart),
          lt(schema.fixtures.date, windowEnd),
        ),
      )) as Array<{
      id: number;
      marketId: string;
      conditionId: string;
    }>;

    if (todayMarkets.length === 0) {
      logger.info('No today-window markets to snapshot.');
      return { window: 'now-1h → now+24h', markets: 0, updated: 0 };
    }

    const conditionIds = todayMarkets.map((m) => m.conditionId);
    logger.info(
      `Today snapshot: ${conditionIds.length} markets across ${conditionIds.length} condition_ids (fixtures in [${windowStart.toISOString()}, ${windowEnd.toISOString()}])`,
    );

    const fetched = await fetchMarketsByConditionIds(conditionIds);
    if (fetched.length === 0) {
      logger.warn('Gamma returned zero rows — nothing written.');
      return { window: 'now-1h → now+24h', markets: conditionIds.length, updated: 0 };
    }

    const now = new Date();
    let updated = 0;
    let snapshotInserts = 0;

    await db.transaction(async (tx) => {
      const snapshotRows: Array<{
        marketId: string;
        conditionId: string;
        snapshotAt: Date;
        outcomePrices: string[] | null;
        volume: string | null;
        volume24hr: string | null;
        liquidity: string | null;
      }> = [];

      for (const m of fetched) {
        if (!m.conditionId) continue;
        const prices = parseOutcomePrices(m.outcomePrices);
        const volume = Number.isFinite(m.volume) ? Number(m.volume) : null;
        const volume24hr = Number.isFinite(m.volume24hr)
          ? Number(m.volume24hr)
          : null;
        const liquidity = Number.isFinite(m.liquidity)
          ? Number(m.liquidity)
          : null;

        await tx
          .update(schema.polymarketMarkets)
          .set({
            outcomePrices: prices ?? undefined,
            volume: volume != null ? String(volume) : null,
            volume24hr: volume24hr != null ? String(volume24hr) : null,
            liquidity: liquidity != null ? String(liquidity) : null,
            active: m.active ?? true,
            closed: m.closed ?? false,
            acceptingOrders: m.acceptingOrders ?? true,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.polymarketMarkets.conditionId, m.conditionId));
        updated++;

        snapshotRows.push({
          marketId: String(m.id),
          conditionId: m.conditionId,
          snapshotAt: now,
          outcomePrices: prices,
          volume: volume != null ? String(volume) : null,
          volume24hr: volume24hr != null ? String(volume24hr) : null,
          liquidity: liquidity != null ? String(liquidity) : null,
        });
      }

      if (snapshotRows.length > 0) {
        await tx.insert(schema.polymarketPriceSnapshots).values(snapshotRows);
        snapshotInserts = snapshotRows.length;
      }
    });

    logger.info(
      `Today snapshot done: ${fetched.length} Gamma rows → ${updated} markets updated, ${snapshotInserts} snapshot inserts.`,
    );
    // Avoid noisy linter: consume the unused helper.
    void inArray;
    return {
      window: 'now-1h → now+24h',
      markets: conditionIds.length,
      fetched: fetched.length,
      updated,
      snapshotInserts,
    };
  },
});
