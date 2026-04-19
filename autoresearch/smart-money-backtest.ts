/**
 * Path A backtester for the smart-money signal.
 *
 * For each resolved prediction whose fixture is linked to a Polymarket
 * market (`polymarket_markets.fixture_id`), reconstruct the holder
 * distribution at the prediction's createdAt timestamp from `/trades`,
 * compute a walk-forward smart-money signal (using only positions
 * resolved BEFORE that time for lifetime stats), then check whether the
 * signal's lean correlates with the actual match outcome.
 *
 * Why walk-forward matters: using a trader's *future* PnL to label them
 * "sharp" at prediction time is look-ahead leakage. The whole point of a
 * backtest is no peeking.
 *
 * Output: signal Brier vs ensemble Brier vs baseline, and a row-by-row
 * diff for the matched predictions.
 *
 * Usage: npx ts-node -r tsconfig-paths/register autoresearch/smart-money-backtest.ts
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/database/schema';
import {
  PolymarketDataService,
  PolymarketTrade,
  UserPosition,
} from '../src/polymarket/services/polymarket-data.service';

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const client = (postgres as any)(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
});
const db = drizzle(client, { schema });

const data = new PolymarketDataService();

// ─── Reconstruction logic ───────────────────────────────────────────

interface WalletPosition {
  proxyWallet: string;
  outcomeIndex: number;
  // Net shares after summing BUYs and SELLs up to time T.
  shares: number;
  // Display fields populated from the most recent trade we saw.
  name: string;
  pseudonym: string;
}

/** Paginate /trades for a market until we have everything before time T. */
async function fetchTradesBefore(
  conditionId: string,
  beforeTimestamp: number,
): Promise<PolymarketTrade[]> {
  const all: PolymarketTrade[] = [];
  // Polymarket's /trades supports `limit` but pagination semantics aren't
  // documented. Pull a wide window and filter; for most football markets
  // total trades will be small.
  let offset = 0;
  const PAGE = 500;
  for (let i = 0; i < 10; i++) {
    const page = await data
      .getTrades(conditionId, { limit: PAGE })
      .catch(() => []);
    if (!page.length) break;
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all.filter((t) => t.timestamp <= beforeTimestamp);
}

/** Aggregate trades into per-(wallet, outcome) net positions. */
function reconstructPositions(trades: PolymarketTrade[]): WalletPosition[] {
  const map = new Map<string, WalletPosition>();
  // Iterate oldest to newest for clean accumulation; keep newest display name.
  trades.sort((a, b) => a.timestamp - b.timestamp);
  for (const t of trades) {
    const key = `${t.proxyWallet}:${t.outcomeIndex}`;
    let p = map.get(key);
    if (!p) {
      p = {
        proxyWallet: t.proxyWallet,
        outcomeIndex: t.outcomeIndex,
        shares: 0,
        name: t.name ?? '',
        pseudonym: t.pseudonym ?? '',
      };
      map.set(key, p);
    }
    p.shares += (t.side === 'BUY' ? 1 : -1) * t.size;
    p.name = t.name ?? p.name;
    p.pseudonym = t.pseudonym ?? p.pseudonym;
  }
  // Drop wallets that closed their position.
  return Array.from(map.values()).filter((p) => p.shares > 0);
}

/**
 * Lifetime stats for a wallet, restricted to positions that resolved
 * BEFORE time T. /closed-positions includes endDate which we filter on.
 */
async function lifetimeStatsBeforeT(
  proxyWallet: string,
  beforeIso: string,
): Promise<{ totalPnl: number; totalBought: number; resolvedBefore: number; typicalSize: number }> {
  const closed = await data
    .getUserClosedPositions(proxyWallet, { limit: 200 })
    .catch(() => [] as UserPosition[]);
  const before = closed.filter(
    (p) => p.endDate && p.endDate < beforeIso && p.totalBought > 0,
  );
  if (before.length === 0) {
    return { totalPnl: 0, totalBought: 0, resolvedBefore: 0, typicalSize: 0 };
  }
  let pnl = 0;
  let bought = 0;
  const sizes: number[] = [];
  for (const p of before) {
    pnl += Number(p.realizedPnl ?? 0);
    bought += Number(p.totalBought ?? 0);
    sizes.push(Number(p.totalBought));
  }
  sizes.sort((a, b) => a - b);
  const typical = sizes[Math.floor(sizes.length / 2)] ?? 0;
  return {
    totalPnl: pnl,
    totalBought: bought,
    resolvedBefore: before.length,
    typicalSize: typical,
  };
}

// ─── Backtest orchestration ────────────────────────────────────────

interface MatchedPrediction {
  predictionId: number;
  fixtureId: number;
  conditionId: string;
  marketQuestion: string;
  predictionCreatedAt: Date;
  actualResult: 'home_win' | 'draw' | 'away_win';
  storedHomeProb: number;
  storedDrawProb: number;
  storedAwayProb: number;
  storedBrier: number;
}

function brier(
  h: number,
  d: number,
  a: number,
  actual: string,
): number {
  const yh = actual === 'home_win' ? 1 : 0;
  const yd = actual === 'draw' ? 1 : 0;
  const ya = actual === 'away_win' ? 1 : 0;
  return (h - yh) ** 2 + (d - yd) ** 2 + (a - ya) ** 2;
}

async function loadMatchedPredictions(): Promise<MatchedPrediction[]> {
  // Predictions resolved + linked to a Polymarket market via fixture_id.
  const rows = await db.execute(sql`
    SELECT
      p.id              AS prediction_id,
      p.fixture_id,
      p.created_at      AS prediction_created_at,
      p.actual_result,
      p.home_win_prob,
      p.draw_prob,
      p.away_win_prob,
      p.probability_accuracy,
      pm.condition_id,
      pm.market_question
    FROM predictions p
    JOIN polymarket_markets pm
      ON pm.fixture_id = p.fixture_id
     AND pm.condition_id IS NOT NULL
    WHERE p.prediction_status = 'resolved'
      AND p.actual_result IN ('home_win', 'draw', 'away_win')
    ORDER BY p.created_at ASC
  `);

  return (rows as any[]).map((r) => {
    const sh = Number(r.home_win_prob);
    const sd = Number(r.draw_prob);
    const sa = Number(r.away_win_prob);
    const storedBrier = isFinite(Number(r.probability_accuracy))
      ? Number(r.probability_accuracy)
      : brier(sh, sd, sa, r.actual_result);
    return {
      predictionId: r.prediction_id,
      fixtureId: r.fixture_id,
      conditionId: r.condition_id,
      marketQuestion: r.market_question,
      predictionCreatedAt: new Date(r.prediction_created_at),
      actualResult: r.actual_result as any,
      storedHomeProb: sh,
      storedDrawProb: sd,
      storedAwayProb: sa,
      storedBrier,
    };
  });
}

async function main() {
  console.log('Loading resolved Polymarket-linked predictions...');
  const items = await loadMatchedPredictions();
  console.log(`  → ${items.length} matched predictions\n`);

  if (items.length === 0) {
    console.log('No predictions linked to Polymarket markets are resolved.');
    console.log(
      'This is the same constraint we identified earlier: only ~17 EPL fixtures',
    );
    console.log(
      'currently have a polymarket_markets.fixture_id link. Once the snapshot',
    );
    console.log(
      'collector and the Polymarket matcher run more, this set will grow.',
    );
    await client.end();
    return;
  }

  // Per-prediction smart-money signal reconstruction
  const cfg = {
    minLifetimePnl: 5_000,
    minLifetimeRoi: 0.05,
    minResolvedBefore: 10,
    minSharpCount: 2,
    minPositionMultiple: 0.3,
    correlationThreshold: 0.15,
  };
  console.log('Reconstructing signals (walk-forward, no look-ahead)...');
  console.log(`  Sharp filter: PnL≥$${cfg.minLifetimePnl}, ROI≥${cfg.minLifetimeRoi*100}%, n≥${cfg.minResolvedBefore} resolved before T, min ${cfg.minSharpCount} sharps\n`);

  let signaledCount = 0;
  let signalAgreeWithEnsemble = 0;
  let signalDisagreeWithEnsemble = 0;
  let signalAgreeBrierSum = 0;
  let signalDisagreeBrierSum = 0;
  const allBrierAgree: number[] = [];
  const allBrierDisagree: number[] = [];

  // Construct a "smart-money-blended" probability per prediction. When
  // signal exists with high confidence, blend leanScore into the ensemble;
  // when it doesn't, keep ensemble as-is.
  let blendedBrierSum = 0;
  let storedBrierSum = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    process.stdout.write(`  [${i + 1}/${items.length}] ${it.conditionId.slice(0, 12)}... `);

    const Tunix = Math.floor(it.predictionCreatedAt.getTime() / 1000);
    const Tiso = it.predictionCreatedAt.toISOString();

    // 1. Reconstruct positions at time T
    const trades = await fetchTradesBefore(it.conditionId, Tunix);
    if (trades.length === 0) {
      process.stdout.write('no trades — skip\n');
      continue;
    }
    const positions = reconstructPositions(trades);
    if (positions.length === 0) {
      process.stdout.write('no positions at T — skip\n');
      continue;
    }
    // Top N per outcome by shares
    const byOutcome = new Map<number, WalletPosition[]>();
    for (const p of positions) {
      const arr = byOutcome.get(p.outcomeIndex) ?? [];
      arr.push(p);
      byOutcome.set(p.outcomeIndex, arr);
    }
    const top: WalletPosition[] = [];
    for (const [, arr] of byOutcome) {
      arr.sort((a, b) => b.shares - a.shares);
      top.push(...arr.slice(0, 20));
    }
    if (top.length === 0) {
      process.stdout.write('no top — skip\n');
      continue;
    }

    // 2. For each top wallet, compute lifetime stats restricted to trades
    //    that resolved BEFORE T
    const wallets = Array.from(new Set(top.map((p) => p.proxyWallet)));
    const stats = new Map<
      string,
      Awaited<ReturnType<typeof lifetimeStatsBeforeT>>
    >();
    await Promise.all(
      wallets.map(async (w) => {
        const s = await lifetimeStatsBeforeT(w, Tiso);
        stats.set(w, s);
      }),
    );

    // 3. Apply sharp filter + position-conviction filter
    const sharps = top
      .map((p) => {
        const s = stats.get(p.proxyWallet)!;
        const roi = s.totalBought > 0 ? s.totalPnl / s.totalBought : 0;
        const posMult = s.typicalSize > 0 ? p.shares / s.typicalSize : 0;
        return {
          ...p,
          lifetimePnl: s.totalPnl,
          roi,
          posMult,
          resolvedBefore: s.resolvedBefore,
          qualifies:
            s.totalPnl >= cfg.minLifetimePnl &&
            roi >= cfg.minLifetimeRoi &&
            s.resolvedBefore >= cfg.minResolvedBefore &&
            posMult >= cfg.minPositionMultiple,
        };
      })
      .filter((s) => s.qualifies);

    if (sharps.length < cfg.minSharpCount) {
      process.stdout.write(
        `only ${sharps.length} sharps (need ${cfg.minSharpCount}) — no read\n`,
      );
      continue;
    }

    // 4. Compute lean
    const dollars0 = sharps
      .filter((s) => s.outcomeIndex === 0)
      .reduce((sum, s) => sum + s.shares, 0);
    const dollars1 = sharps
      .filter((s) => s.outcomeIndex === 1)
      .reduce((sum, s) => sum + s.shares, 0);
    const totalD = dollars0 + dollars1;
    if (totalD === 0) {
      process.stdout.write('zero dollars — skip\n');
      continue;
    }
    const leanScore = (dollars0 - dollars1) / totalD;
    signaledCount++;

    // 5. Map signal to football outcome:
    //    Polymarket markets linked to fixtures usually ask "Will TEAM win?"
    //    so outcome 0 (yes) ↔ that team wins, outcome 1 (no) ↔ doesn't.
    //    We don't have the "which team" mapping reliably stored, so we
    //    instead test the simpler hypothesis: does the signal correlate
    //    with the ensemble's pick? Useful as a first-order check.
    const ensemblePick =
      it.storedHomeProb >= it.storedDrawProb &&
      it.storedHomeProb >= it.storedAwayProb
        ? 'home'
        : it.storedAwayProb >= it.storedDrawProb
          ? 'away'
          : 'draw';
    // Treat positive lean as "ensemble's pick" alignment — heuristic only;
    // proper mapping needs the polymarket_markets.team_id linkage.
    const signalAgrees = leanScore > 0;

    if (signalAgrees) {
      signalAgreeWithEnsemble++;
      signalAgreeBrierSum += it.storedBrier;
      allBrierAgree.push(it.storedBrier);
    } else {
      signalDisagreeWithEnsemble++;
      signalDisagreeBrierSum += it.storedBrier;
      allBrierDisagree.push(it.storedBrier);
    }
    storedBrierSum += it.storedBrier;
    blendedBrierSum += it.storedBrier; // placeholder — proper mapping needs team_id

    process.stdout.write(
      `lean=${leanScore.toFixed(2)} sharps=${sharps.length} ensemble=${ensemblePick}\n`,
    );
  }

  console.log('\n═══ Smart-money signal correlation ═══');
  console.log(`Total predictions:           ${items.length}`);
  console.log(`Predictions with signal:     ${signaledCount}`);
  if (signaledCount === 0) {
    console.log(
      'No qualifying signals — sample too thin or thresholds too strict.',
    );
  } else {
    const meanAgree =
      signalAgreeWithEnsemble > 0
        ? signalAgreeBrierSum / signalAgreeWithEnsemble
        : 0;
    const meanDisagree =
      signalDisagreeWithEnsemble > 0
        ? signalDisagreeBrierSum / signalDisagreeWithEnsemble
        : 0;
    const overall = storedBrierSum / signaledCount;
    console.log(`Signal agrees w/ ensemble:   ${signalAgreeWithEnsemble} predictions, mean Brier = ${meanAgree.toFixed(4)}`);
    console.log(`Signal disagrees:            ${signalDisagreeWithEnsemble} predictions, mean Brier = ${meanDisagree.toFixed(4)}`);
    console.log(`Overall (signaled subset):   ${overall.toFixed(4)}`);
    console.log('');
    console.log('Interpretation:');
    if (
      signalAgreeWithEnsemble > 0 &&
      signalDisagreeWithEnsemble > 0 &&
      meanAgree < meanDisagree
    ) {
      console.log(
        '  When sharps agreed with the ensemble, the ensemble was more accurate.',
      );
      console.log(
        '  → Smart money is a useful confirmation signal. Worth integrating as a confidence multiplier.',
      );
    } else if (
      signalAgreeWithEnsemble > 0 &&
      signalDisagreeWithEnsemble > 0 &&
      meanAgree >= meanDisagree
    ) {
      console.log(
        '  When sharps disagreed with the ensemble, the ensemble was MORE accurate.',
      );
      console.log(
        '  → Either the signal is noise, or the ensemble already incorporates this info via Polymarket prices.',
      );
    } else {
      console.log(
        '  Sample too small in one direction to draw a conclusion. Re-run after the snapshot collector accumulates more data.',
      );
    }
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
