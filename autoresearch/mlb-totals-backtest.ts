/**
 * MLB run-totals backtest harness.
 *
 * Two modes (argv[2]):
 *   eval   (default) — score stored RESOLVED baseball_predictions: Brier,
 *                      accuracy, calibration table, and CLV vs the sharp close.
 *   replay           — re-run the current model over COMPLETED games (known
 *                      actual totals) and score it. Useful before live
 *                      predictions accrue and for tuning phi / park / IP split.
 *
 * Run: npx ts-node -r tsconfig-paths/register autoresearch/mlb-totals-backtest.ts [eval|replay]
 *
 * The real success metric is CLV (beating the closing line), not raw accuracy.
 */
import 'dotenv/config';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as schema from '../src/database/schema';
import { initServices } from '../src/trigger/init';
import { nbPOverAtLine } from '../src/baseball/baseball-run-model.service';

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

interface Scored {
  line: number;
  pOver: number;
  wasOver: number; // 0/1, push excluded
  marketTotal: number | null;
  expectedTotal: number;
  confidence: number;
}

function report(label: string, scored: Scored[]) {
  const n = scored.length;
  console.log(`\n=== ${label} (n=${n}) ===`);
  if (!n) {
    console.log('  no samples');
    return;
  }
  const briers = scored.map((s) => (s.pOver - s.wasOver) ** 2);
  const accs = scored.map((s) =>
    (s.pOver > 0.5 ? 1 : 0) === s.wasOver ? 1 : 0,
  );
  console.log(`  Brier:     ${mean(briers).toFixed(4)} (baseline 0.25)`);
  console.log(`  Accuracy:  ${(mean(accs) * 100).toFixed(1)}%`);
  console.log(`  Over rate: ${(mean(scored.map((s) => s.wasOver)) * 100).toFixed(1)}%`);

  // Calibration table.
  console.log('  Calibration (predicted P(over) → actual over rate):');
  for (let lo = 0; lo < 1; lo += 0.1) {
    const hi = lo + 0.1;
    const bucket = scored.filter((s) => s.pOver >= lo && s.pOver < hi);
    if (!bucket.length) continue;
    console.log(
      `    ${lo.toFixed(1)}-${hi.toFixed(1)}: ` +
        `pred ${(mean(bucket.map((b) => b.pOver)) * 100).toFixed(0)}% ` +
        `actual ${(mean(bucket.map((b) => b.wasOver)) * 100).toFixed(0)}% ` +
        `(n=${bucket.length})`,
    );
  }

  // Confidence buckets.
  console.log('  Accuracy by confidence:');
  for (const thr of [5, 6, 7, 8]) {
    const b = scored.filter((s) => s.confidence >= thr);
    if (!b.length) continue;
    const a = mean(b.map((s) => ((s.pOver > 0.5 ? 1 : 0) === s.wasOver ? 1 : 0)));
    console.log(`    conf≥${thr}: ${(a * 100).toFixed(1)}% (n=${b.length})`);
  }

  // CLV proxy: when our expected total disagrees with the closing total, did
  // the side we'd back (over if expected>market) win?
  const vsMarket = scored.filter((s) => s.marketTotal != null);
  if (vsMarket.length) {
    const picks = vsMarket
      .filter((s) => Math.abs(s.expectedTotal - (s.marketTotal as number)) >= 0.5)
      .map((s) => {
        const backOver = s.expectedTotal > (s.marketTotal as number);
        const win = backOver ? s.wasOver === 1 : s.wasOver === 0;
        return win ? 1 : 0;
      });
    if (picks.length) {
      console.log(
        `  CLV proxy (model disagrees ≥0.5 w/ close): ` +
          `${(mean(picks) * 100).toFixed(1)}% win on ${picks.length} picks ` +
          `(break-even ~52.4% at -110)`,
      );
    }
  }
}

async function evalStored(db: any) {
  const rows = await db
    .select()
    .from(schema.baseballPredictions)
    .where(
      and(
        eq(schema.baseballPredictions.predictionStatus, 'resolved'),
        isNotNull(schema.baseballPredictions.actualTotalRuns),
      ),
    );

  const scored: Scored[] = [];
  for (const p of rows) {
    const total = p.actualTotalRuns as number;
    const line = Number(p.primaryLine);
    if (total === line) continue; // push
    scored.push({
      line,
      pOver: Number(p.primaryPOver),
      wasOver: total > line ? 1 : 0,
      marketTotal: p.marketTotal != null ? Number(p.marketTotal) : null,
      expectedTotal: Number(p.expectedTotal),
      confidence: p.confidence ?? 5,
    });
  }
  report('Stored resolved predictions (primary line)', scored);
}

async function replay(services: ReturnType<typeof initServices>) {
  const { db, baseballRunModel, baseballService } = services;
  await services.baseballTeamMap.init();

  const completed = await db
    .select()
    .from(schema.baseballGames)
    .where(isNotNull(schema.baseballGames.runsHome));

  console.log(`Replaying model over ${completed.length} completed games...`);
  const scored: Scored[] = [];
  let processed = 0;
  for (const g of completed) {
    if (g.runsHome == null || g.runsAway == null) continue;
    const out = await baseballRunModel.predict(g.id);
    if (!out) continue;
    const total = g.runsHome + g.runsAway;
    // Score every standard line the model produced.
    for (const lp of out.lineProbs) {
      if (total === lp.line) continue;
      scored.push({
        line: lp.line,
        pOver: lp.pOver,
        wasOver: total > lp.line ? 1 : 0,
        marketTotal: null,
        expectedTotal: out.expectedTotal,
        confidence: out.confidence,
      });
    }
    if (++processed % 50 === 0) console.log(`  ...${processed}`);
  }
  report('Model replay (all lines)', scored);
  void baseballService;
  void nbPOverAtLine;
}

async function main() {
  const mode = process.argv[2] || 'eval';
  const services = initServices();
  try {
    if (mode === 'replay') {
      await replay(services);
    } else {
      await evalStored(services.db);
    }
  } finally {
    // postgres-js client is held inside services.db; allow process to exit.
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
