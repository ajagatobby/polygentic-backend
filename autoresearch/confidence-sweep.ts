/**
 * Confidence-filtered Brier sweep.
 *
 * For each confidence threshold c ∈ {1..10}, compute Brier score and accuracy
 * on the subset of resolved predictions with confidence ≥ c.
 *
 * If higher-confidence predictions have materially better Brier, the system
 * has signal but is diluting it by publishing everything. In that case, the
 * right move is to only publish predictions above some confidence bar.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { and, eq, isNotNull } from 'drizzle-orm';

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const client = (postgres as any)(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
});
const db = drizzle(client, { schema });

function brier(h: number, d: number, a: number, actual: string): number {
  const yh = actual === 'home_win' ? 1 : 0;
  const yd = actual === 'draw' ? 1 : 0;
  const ya = actual === 'away_win' ? 1 : 0;
  return (h - yh) ** 2 + (d - yd) ** 2 + (a - ya) ** 2;
}

async function main() {
  const rows = await db
    .select({
      homeProb: schema.predictions.homeWinProb,
      drawProb: schema.predictions.drawProb,
      awayProb: schema.predictions.awayWinProb,
      confidence: schema.predictions.confidence,
      actualResult: schema.predictions.actualResult,
    })
    .from(schema.predictions)
    .where(
      and(
        eq(schema.predictions.predictionStatus, 'resolved'),
        isNotNull(schema.predictions.actualResult),
        isNotNull(schema.predictions.confidence),
      ),
    );

  const items = rows
    .filter((r) =>
      ['home_win', 'draw', 'away_win'].includes(r.actualResult as string),
    )
    .map((r) => ({
      h: Number(r.homeProb),
      d: Number(r.drawProb),
      a: Number(r.awayProb),
      conf: r.confidence as number,
      actual: r.actualResult as string,
    }));

  console.log(`Loaded ${items.length} resolved predictions with confidence\n`);

  // Confidence distribution
  const byConf = new Map<number, number>();
  for (const x of items) {
    byConf.set(x.conf, (byConf.get(x.conf) ?? 0) + 1);
  }
  const sortedConfs = Array.from(byConf.keys()).sort((a, b) => a - b);
  console.log('Confidence distribution:');
  for (const c of sortedConfs) {
    console.log(`  confidence=${c}: ${byConf.get(c)} predictions`);
  }
  console.log('');

  // Sweep thresholds
  console.log('Brier and accuracy by confidence threshold (conf ≥ c):');
  console.log(
    `  ${'threshold'.padEnd(10)} ${'n'.padStart(5)}  ${'fraction'.padStart(8)}  ${'brier'.padStart(9)}  ${'accuracy'.padStart(9)}  ${'baseline_brier'.padStart(14)}  ${'Δ_vs_baseline'.padStart(13)}`,
  );
  for (let c = 1; c <= 10; c++) {
    const sub = items.filter((x) => x.conf >= c);
    if (sub.length === 0) continue;
    let brierSum = 0;
    let baselineBrierSum = 0;
    let correct = 0;
    for (const x of sub) {
      brierSum += brier(x.h, x.d, x.a, x.actual);
      baselineBrierSum += brier(0.468, 0.259, 0.273, x.actual); // our own global rates
      const pred =
        x.h >= x.d && x.h >= x.a
          ? 'home_win'
          : x.a >= x.d
            ? 'away_win'
            : 'draw';
      if (pred === x.actual) correct++;
    }
    const b = brierSum / sub.length;
    const bb = baselineBrierSum / sub.length;
    console.log(
      `  conf ≥ ${String(c).padEnd(3)}  ${String(sub.length).padStart(5)}  ${((sub.length / items.length) * 100).toFixed(1).padStart(7)}%  ${b.toFixed(6).padStart(9)}  ${((correct / sub.length) * 100).toFixed(2).padStart(8)}%  ${bb.toFixed(6).padStart(14)}  ${(b - bb).toFixed(6).padStart(13)}  ${b < bb ? '◀ beats baseline' : ''}`,
    );
  }

  await client.end();
}

main();
