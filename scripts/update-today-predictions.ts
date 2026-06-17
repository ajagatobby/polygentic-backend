/**
 * Regenerate predictions for all of today's fixtures.
 *
 * Bootstraps the NestJS application context (no HTTP server), finds every
 * fixture kicking off today (UTC), and re-runs the full prediction pipeline for
 * each one. Because predictions are now one-per-fixture (upsert on fixture_id),
 * this overwrites the existing row in place — so it's safe to run repeatedly to
 * refresh today's slate with the latest model + insights.
 *
 * Runs the live pipeline, so it needs a VALID API_FOOTBALL_KEY in the
 * environment (web research, /players, /teams/statistics). Run it where the
 * production key is set, not against a dead local key.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/update-today-predictions.ts
 *   npx ts-node -r tsconfig-paths/register scripts/update-today-predictions.ts --date 2026-05-31
 *   npx ts-node -r tsconfig-paths/register scripts/update-today-predictions.ts --concurrency 4 --type daily
 *   npx ts-node -r tsconfig-paths/register scripts/update-today-predictions.ts --all-statuses
 */

import { NestFactory } from '@nestjs/core';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { AgentsService } from '../src/agents/agents.service';
import * as schema from '../src/database/schema';

interface Options {
  date: Date; // start-of-day UTC
  concurrency: number;
  predictionType: 'daily' | 'on_demand' | 'pre_match';
  allStatuses: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  let date: Date | null = null;
  let concurrency = 3;
  let predictionType: Options['predictionType'] = 'daily';
  let allStatuses = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--date':
      case '-d': {
        const v = args[++i];
        const [y, m, day] = v.split('-').map(Number);
        date = new Date(Date.UTC(y, m - 1, day));
        break;
      }
      case '--concurrency':
      case '-c':
        concurrency = Math.max(1, parseInt(args[++i], 10) || 3);
        break;
      case '--type':
      case '-t':
        predictionType = args[++i] as Options['predictionType'];
        break;
      case '--all-statuses':
        allStatuses = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Regenerate predictions for all of a day's fixtures.

Options:
  --date, -d <YYYY-MM-DD>  Day to process (UTC). Defaults to today.
  --concurrency, -c <n>    Parallel predictions (default 3). Keep modest — each
                           run makes many rate-limited API + LLM calls.
  --type, -t <type>        Prediction type label: daily | on_demand | pre_match
                           (default daily).
  --all-statuses           Include fixtures of any status, not just NS.
  --help, -h               Show this help.
        `);
        process.exit(0);
    }
  }

  if (!date) {
    const now = new Date();
    date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  return { date, concurrency, predictionType, allStatuses };
}

/** Run `worker` over `items` with a fixed concurrency. */
async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const opts = parseArgs();
  const dayStart = opts.date;
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayLabel = dayStart.toISOString().split('T')[0];

  console.log('=== Update Today\'s Predictions ===');
  console.log(`Date:        ${dayLabel} (UTC)`);
  console.log(`Type:        ${opts.predictionType}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  console.log(`Statuses:    ${opts.allStatuses ? 'any' : 'NS only'}`);
  console.log('');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const agentsService = app.get(AgentsService);
  const db: any = (agentsService as any).db;

  const whereClause = opts.allStatuses
    ? and(
        gte(schema.fixtures.date, dayStart),
        lte(schema.fixtures.date, dayEnd),
      )
    : and(
        eq(schema.fixtures.status, 'NS'),
        gte(schema.fixtures.date, dayStart),
        lte(schema.fixtures.date, dayEnd),
      );

  const fixtures = await db
    .select({
      id: schema.fixtures.id,
      date: schema.fixtures.date,
      league: schema.fixtures.leagueName,
      home: schema.fixtures.homeTeamId,
      away: schema.fixtures.awayTeamId,
    })
    .from(schema.fixtures)
    .where(whereClause)
    .orderBy(asc(schema.fixtures.date));

  console.log(`Found ${fixtures.length} fixture(s) for ${dayLabel}.\n`);
  if (fixtures.length === 0) {
    await app.close();
    return;
  }

  const startTime = Date.now();
  let done = 0;
  let generated = 0;
  let failed = 0;
  const errors: string[] = [];

  await pool(fixtures, opts.concurrency, async (f: any) => {
    const tag = `[${++done}/${fixtures.length}] fixture ${f.id} (${f.league ?? '?'})`;
    try {
      await agentsService.generatePrediction(f.id, opts.predictionType as any);
      generated++;
      console.log(`  ✓ ${tag}`);
    } catch (error: any) {
      failed++;
      const msg = `${tag} — ${error.message}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
    }
  });

  const secs = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=== Summary ===');
  console.log(`  Date:      ${dayLabel}`);
  console.log(`  Total:     ${fixtures.length}`);
  console.log(`  Generated: ${generated}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Duration:  ${secs}s`);
  if (errors.length) {
    console.log('\n  Errors:');
    for (const e of errors.slice(0, 20)) console.log(`   - ${e}`);
  }

  await app.close();
  process.exit(failed > 0 && generated === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
