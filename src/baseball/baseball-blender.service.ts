import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as schema from '../database/schema';

interface BlenderParams {
  weights: [number, number, number]; // [model, agent, market] in logit-pool
  bias: number;
  order: ['model', 'agent', 'market'];
}

const FALLBACK_WITH_MARKET: BlenderParams = {
  weights: [0.3, 0.2, 0.5],
  bias: 0,
  order: ['model', 'agent', 'market'],
};
const FALLBACK_NO_MARKET: BlenderParams = {
  weights: [0.6, 0.4, 0],
  bias: 0,
  order: ['model', 'agent', 'market'],
};

/**
 * Binary over/under meta-blender (log-pool of model/agent/market). Fits a
 * 3-weight logistic blend on resolved per-predictor traces; falls back to a
 * market-anchored fixed blend until ≥150 samples. The market is expected to
 * dominate — edge lives in the residual where model+agent disagree with it.
 */
@Injectable()
export class BaseballBlenderService {
  private readonly logger = new Logger(BaseballBlenderService.name);
  private static readonly MIN_SAMPLES = 150;

  private learned: BlenderParams | null = null;
  private loadedAt = 0;
  private static readonly TTL_MS = 30 * 60 * 1000;

  constructor(@Inject('DRIZZLE') private db: any) {}

  /** Blend three P(over) inputs into one. market may be null. */
  async blend(
    model: number,
    agent: number,
    market: number | null,
  ): Promise<number> {
    await this.ensureLoaded();
    const p =
      this.learned ?? (market != null ? FALLBACK_WITH_MARKET : FALLBACK_NO_MARKET);

    const terms: number[] = [
      p.weights[0] * logit(model),
      p.weights[1] * logit(agent),
    ];
    let z = p.bias + terms[0] + terms[1];
    if (market != null) {
      z += p.weights[2] * logit(market);
    } else if (this.learned) {
      // Market missing but learned weights assume it: renormalize the two
      // present weights so they sum to the original total.
      const tot = p.weights[0] + p.weights[1] + p.weights[2];
      const scale = tot / (p.weights[0] + p.weights[1] || 1);
      z = p.bias + scale * (terms[0] + terms[1]);
    }
    return clampProb(sigmoid(z));
  }

  /** Refit logistic blend weights from resolved primary-line traces. */
  async refit(): Promise<{ fitted: boolean; samples: number }> {
    const rows = await this.db
      .select()
      .from(schema.baseballPredictions)
      .where(
        and(
          eq(schema.baseballPredictions.predictionStatus, 'resolved'),
          isNotNull(schema.baseballPredictions.actualTotalRuns),
        ),
      );

    const X: number[][] = [];
    const y: number[] = [];
    for (const p of rows) {
      const total = p.actualTotalRuns;
      const primaryLine = Number(p.primaryLine);
      if (total === primaryLine) continue;
      const traces = (p.predictorProbs ?? []) as any[];
      const t = traces.find((r) => Number(r.line) === primaryLine);
      if (!t || t.market == null) continue; // need full triple to learn market weight
      X.push([logit(Number(t.model)), logit(Number(t.agent)), logit(Number(t.market))]);
      y.push(total > primaryLine ? 1 : 0);
    }

    if (X.length < BaseballBlenderService.MIN_SAMPLES) {
      this.logger.log(
        `Blender refit skipped — ${X.length}/${BaseballBlenderService.MIN_SAMPLES} samples`,
      );
      return { fitted: false, samples: X.length };
    }

    const { weights, bias } = trainLogistic(X, y);
    const params: BlenderParams = {
      weights: [weights[0], weights[1], weights[2]],
      bias,
      order: ['model', 'agent', 'market'],
    };
    await this.persist(params, X.length);
    this.learned = params;
    this.loadedAt = Date.now();
    this.logger.log(
      `Blender refit on ${X.length} samples — weights ${params.weights
        .map((w) => w.toFixed(2))
        .join('/')} bias ${bias.toFixed(2)}`,
    );
    return { fitted: true, samples: X.length };
  }

  private async persist(params: BlenderParams, n: number): Promise<void> {
    await this.db
      .insert(schema.baseballModelParams)
      .values({ kind: 'blender', key: 'global', params, sampleSize: n, fittedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.baseballModelParams.kind, schema.baseballModelParams.key],
        set: { params, sampleSize: n, fittedAt: new Date() },
      });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.learned && Date.now() - this.loadedAt < BaseballBlenderService.TTL_MS) {
      return;
    }
    try {
      const rows = await this.db
        .select()
        .from(schema.baseballModelParams)
        .where(
          and(
            eq(schema.baseballModelParams.kind, 'blender'),
            eq(schema.baseballModelParams.key, 'global'),
          ),
        )
        .limit(1);
      this.learned = rows[0]?.params ?? null;
    } catch {
      this.learned = null;
    }
    this.loadedAt = Date.now();
  }
}

// ─── math ──────────────────────────────────────────────────────────────

/** Batch gradient-descent logistic regression. */
function trainLogistic(
  X: number[][],
  y: number[],
  iters = 500,
  lr = 0.05,
): { weights: number[]; bias: number } {
  const d = X[0].length;
  const w = new Array(d).fill(1 / d);
  let b = 0;
  const n = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) {
      // L2 pull toward 0 to avoid overfit on small samples.
      w[j] -= lr * (gw[j] / n + 0.01 * w[j]);
    }
    b -= lr * (gb / n);
  }
  return { weights: w, bias: b };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}
function logit(p: number): number {
  const c = Math.max(0.001, Math.min(0.999, p));
  return Math.log(c / (1 - c));
}
function clampProb(x: number): number {
  return Math.max(0.001, Math.min(0.999, x));
}
