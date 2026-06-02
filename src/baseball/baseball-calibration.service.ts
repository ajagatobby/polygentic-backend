import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as schema from '../database/schema';

interface Breakpoint {
  xMin: number;
  xMax: number;
  y: number;
  count: number;
}

/** Coarse line buckets so each calibrator has enough samples. */
export function lineBucket(line: number): string {
  if (line < 8) return 'low';
  if (line < 9.5) return 'mid';
  return 'high';
}

/**
 * Binary isotonic (PAV) calibration of P(over) for MLB totals. Reuses the
 * soccer calibrator's algorithm, specialized to a single binary outcome and
 * grouped by line bucket. Identity until enough resolved samples accrue.
 */
@Injectable()
export class BaseballCalibrationService {
  private readonly logger = new Logger(BaseballCalibrationService.name);
  private static readonly GLOBAL_MIN = 200;
  private static readonly BUCKET_MIN = 100;

  private cache = new Map<string, Breakpoint[]>();
  private loadedAt = 0;
  private static readonly TTL_MS = 30 * 60 * 1000;

  constructor(@Inject('DRIZZLE') private db: any) {}

  /** Apply calibration to a raw P(over) for a given line. */
  async apply(pOverRaw: number, line: number): Promise<number> {
    await this.ensureLoaded();
    const bucket = lineBucket(line);
    const bp = this.cache.get(bucket) ?? this.cache.get('global');
    if (!bp || !bp.length) return pOverRaw;
    return applyMapping(bp, pOverRaw);
  }

  /** Refit PAV calibrators from resolved predictions. Returns summary. */
  async refit(): Promise<{ fitted: string[]; skipped: string[] }> {
    const rows = await this.db
      .select()
      .from(schema.baseballPredictions)
      .where(
        and(
          eq(schema.baseballPredictions.predictionStatus, 'resolved'),
          isNotNull(schema.baseballPredictions.actualTotalRuns),
        ),
      );

    // Collect (rawPOver, wasOver) pairs per bucket + global.
    const byBucket = new Map<string, Array<[number, number]>>();
    const global: Array<[number, number]> = [];
    for (const p of rows) {
      const total = p.actualTotalRuns;
      const lineProbs = (p.lineProbs ?? []) as any[];
      for (const lp of lineProbs) {
        const line = Number(lp.line);
        if (total === line) continue; // push — no binary label
        const raw = Number(lp.pOverRaw ?? lp.pOverCalibrated);
        if (!Number.isFinite(raw)) continue;
        const wasOver = total > line ? 1 : 0;
        const b = lineBucket(line);
        if (!byBucket.has(b)) byBucket.set(b, []);
        byBucket.get(b)!.push([raw, wasOver]);
        global.push([raw, wasOver]);
      }
    }

    const fitted: string[] = [];
    const skipped: string[] = [];

    if (global.length >= BaseballCalibrationService.GLOBAL_MIN) {
      await this.persist('global', fitPav(global));
      fitted.push(`global(${global.length})`);
    } else {
      skipped.push(`global(${global.length})`);
    }

    for (const [bucket, pairs] of byBucket) {
      if (pairs.length >= BaseballCalibrationService.BUCKET_MIN) {
        await this.persist(bucket, fitPav(pairs));
        fitted.push(`${bucket}(${pairs.length})`);
      } else {
        skipped.push(`${bucket}(${pairs.length})`);
      }
    }

    this.cache.clear();
    this.loadedAt = 0;
    this.logger.log(
      `Baseball calibration refit — fitted: ${fitted.join(', ') || 'none'}; ` +
        `skipped: ${skipped.join(', ') || 'none'}`,
    );
    return { fitted, skipped };
  }

  private async persist(key: string, bp: Breakpoint[]): Promise<void> {
    await this.db
      .insert(schema.baseballModelParams)
      .values({
        kind: 'calibration',
        key,
        params: bp,
        sampleSize: bp.reduce((a, b) => a + b.count, 0),
        fittedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.baseballModelParams.kind,
          schema.baseballModelParams.key,
        ],
        set: {
          params: bp,
          sampleSize: bp.reduce((a, b) => a + b.count, 0),
          fittedAt: new Date(),
        },
      });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache.size && Date.now() - this.loadedAt < BaseballCalibrationService.TTL_MS) {
      return;
    }
    this.cache.clear();
    try {
      const rows = await this.db
        .select()
        .from(schema.baseballModelParams)
        .where(eq(schema.baseballModelParams.kind, 'calibration'));
      for (const r of rows) this.cache.set(r.key, r.params as Breakpoint[]);
    } catch {
      /* table may not exist yet */
    }
    this.loadedAt = Date.now();
  }
}

// ─── PAV (pool-adjacent-violators) ─────────────────────────────────────

export function fitPav(pairs: Array<[number, number]>): Breakpoint[] {
  if (!pairs.length) return [];
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  // Initialize blocks: one per point.
  let blocks = sorted.map(([x, y]) => ({ xMin: x, xMax: x, y, count: 1 }));
  // Merge adjacent violators (y must be non-decreasing).
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].y > blocks[i + 1].y) {
        const a = blocks[i];
        const b = blocks[i + 1];
        const count = a.count + b.count;
        const y = (a.y * a.count + b.y * b.count) / count;
        blocks.splice(i, 2, {
          xMin: a.xMin,
          xMax: b.xMax,
          y,
          count,
        });
        merged = true;
        break;
      }
    }
  }
  return blocks;
}

export function applyMapping(bp: Breakpoint[], x: number): number {
  if (!bp.length) return x;
  if (x <= bp[0].xMin) return bp[0].y;
  if (x >= bp[bp.length - 1].xMax) return bp[bp.length - 1].y;
  for (const b of bp) {
    if (x >= b.xMin && x <= b.xMax) return b.y;
  }
  // Between blocks: linear interpolation across the gap.
  for (let i = 0; i < bp.length - 1; i++) {
    if (x > bp[i].xMax && x < bp[i + 1].xMin) {
      const t = (x - bp[i].xMax) / (bp[i + 1].xMin - bp[i].xMax);
      return bp[i].y + t * (bp[i + 1].y - bp[i].y);
    }
  }
  return x;
}
