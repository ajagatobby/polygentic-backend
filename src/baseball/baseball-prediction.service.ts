import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import {
  BaseballService,
  BASEBALL_COMPLETED_STATUSES,
  BASEBALL_VOID_STATUSES,
} from './baseball.service';
import { MlbStatsService } from './mlb-stats.service';
import { StatcastService } from './statcast.service';
import { BaseballTeamMapService } from './baseball-team-map.service';
import { BaseballMarketService } from './baseball-market.service';
import {
  BaseballRunModelService,
  LineProb,
  lineProbsFromTotal,
} from './baseball-run-model.service';
import { BaseballResearchAgent } from './agents/baseball-research.agent';
import { BaseballAnalysisAgent } from './agents/baseball-analysis.agent';
import { BaseballCriticAgent } from './agents/baseball-critic.agent';

export const BASEBALL_MODEL_VERSION = 'mlb-totals-v1';

export type BaseballPredictionType = 'daily' | 'pre_game' | 'on_demand';

interface BlendedLine {
  line: number;
  pOver: number;
  pUnder: number;
  push: number;
  model: number;
  agent: number;
  market: number | null;
}

/**
 * Orchestrates an MLB run-total prediction: enrich (probables/weather/market)
 * → research → statistical model → analysis agent → critic → blend
 * (model/agent/market) → persist. Calibration (Phase 3) plugs into
 * `calibrate()`. Mirrors the soccer AgentsService.generatePrediction flow.
 */
@Injectable()
export class BaseballPredictionService {
  private readonly logger = new Logger(BaseballPredictionService.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly baseball: BaseballService,
    private readonly mlbStats: MlbStatsService,
    private readonly statcast: StatcastService,
    private readonly teamMap: BaseballTeamMapService,
    private readonly market: BaseballMarketService,
    private readonly runModel: BaseballRunModelService,
    private readonly research: BaseballResearchAgent,
    private readonly analysis: BaseballAnalysisAgent,
    private readonly critic: BaseballCriticAgent,
  ) {}

  /** Generate (or refresh) the over/under prediction for one game. */
  async generatePrediction(
    gameId: number,
    type: BaseballPredictionType = 'daily',
  ): Promise<any | null> {
    let game = await this.baseball.getGameById(gameId);
    if (!game) {
      this.logger.warn(`generatePrediction: game ${gameId} not found`);
      return null;
    }

    // 1. Enrich with probables + weather from MLB StatsAPI.
    game = await this.enrichGame(game);

    const homeSeed = this.teamMap.getByApiSports(game.homeTeamId);
    const awaySeed = this.teamMap.getByApiSports(game.awayTeamId);
    const homeName = homeSeed?.fullName ?? `Team ${game.homeTeamId}`;
    const awayName = awaySeed?.fullName ?? `Team ${game.awayTeamId}`;

    // 2. Sharp market total (predictor + benchmark).
    const marketTotal = await this.market.getLatestTotal(gameId);

    // 3. Statistical model (anchor).
    const model = await this.runModel.predict(gameId);
    if (!model) {
      this.logger.warn(`No model output for game ${gameId}`);
      return null;
    }

    // 4. Research (Perplexity).
    const research = await this.research.research({
      homeTeam: homeName,
      awayTeam: awayName,
      dateISO: new Date(game.date).toISOString(),
      venue: game.venueName,
      homeStarter: game.homeProbablePitcherId
        ? String(game.homeProbablePitcherId)
        : null,
      awayStarter: game.awayProbablePitcherId
        ? String(game.awayProbablePitcherId)
        : null,
    });

    // 5. Analysis agent (Claude), anchored on the model.
    const analysis = await this.analysis.analyze({
      homeTeam: homeName,
      awayTeam: awayName,
      venue: game.venueName,
      model,
      research,
      marketTotal: marketTotal?.totalLine ?? null,
      parkRunFactor: model.inputs?.parkRunFactor,
      weather: game.weather,
    });

    // 6. Critic (fast model) — can pull extreme calls back.
    const crit = await this.critic.critique(model, analysis, research);
    const agentTotal = crit.adjustedExpectedTotal;
    const agentLineProbs = lineProbsFromTotal(agentTotal);

    // 7. Market predictor: NB built from the sharp total as a mean.
    const marketLineProbs = marketTotal
      ? lineProbsFromTotal(marketTotal.totalLine)
      : null;

    // 8. Blend per line (market-anchored fixed weights for v1).
    const blended = this.blend(model.lineProbs, agentLineProbs, marketLineProbs);

    // 9. Calibrate (identity until Phase 3 fits calibrators).
    const calibrated = await this.calibrate(blended);

    // 10. Primary line = market line if present, else nearest to expected.
    const primary = this.pickPrimary(
      calibrated,
      marketTotal?.totalLine ?? model.expectedTotal,
    );

    // 11. Confidence: model + agent, dinged by critic + staleness.
    const confidence = Math.max(
      1,
      Math.min(
        10,
        Math.round((model.confidence + analysis.confidence) / 2) +
          crit.confidenceDelta,
      ),
    );

    const lineProbsOut = calibrated.map((l) => ({
      line: l.line,
      pOverRaw: round4(blendRawFor(blended, l.line)),
      pOverCalibrated: round4(l.pOver),
      pUnder: round4(l.pUnder),
      push: round4(l.push),
    }));
    const predictorProbs = blended.map((l) => ({
      line: l.line,
      model: round4(l.model),
      agent: round4(l.agent),
      market: l.market == null ? null : round4(l.market),
    }));

    const row = {
      gameId,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      expectedHomeRuns: String(model.expectedHomeRuns),
      expectedAwayRuns: String(model.expectedAwayRuns),
      expectedTotal: String(round2((model.expectedTotal + agentTotal) / 2)),
      dispersion: String(model.dispersion),
      lineProbs: lineProbsOut,
      primaryLine: String(primary.line),
      primaryPOver: String(round4(primary.pOver)),
      predictorProbs,
      marketTotal: marketTotal ? String(marketTotal.totalLine) : null,
      marketPOver: marketTotal ? String(round4(marketTotal.overImpliedProb)) : null,
      confidence,
      predictionType: type,
      modelVersion: BASEBALL_MODEL_VERSION,
      keyFactors: analysis.keyFactors,
      riskFactors: [...analysis.riskFactors, ...(crit.critique ? [crit.critique] : [])],
      researchContext: { content: research.content, citations: research.citations },
      detailedAnalysis: analysis.reasoning,
      predictionStatus: 'pending',
      updatedAt: new Date(),
    };

    await this.db
      .insert(schema.baseballPredictions)
      .values(row)
      .onConflictDoUpdate({
        target: schema.baseballPredictions.gameId,
        set: { ...row, updatedAt: new Date() },
      });

    this.logger.log(
      `Predicted game ${gameId} (${awayName} @ ${homeName}): ` +
        `total ${row.expectedTotal}, primary ${primary.line} ` +
        `P(over)=${(primary.pOver * 100).toFixed(0)}% conf ${confidence}`,
    );
    return row;
  }

  /** Batch-generate for upcoming games lacking a prediction (daily task). */
  async generateForUpcoming(
    hoursAhead = 48,
    type: BaseballPredictionType = 'daily',
  ): Promise<{ generated: number; skipped: number; failed: number }> {
    const games = await this.baseball.getUpcomingGames(hoursAhead);
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    for (const g of games) {
      if (type === 'daily') {
        const existing = await this.db
          .select({ id: schema.baseballPredictions.id })
          .from(schema.baseballPredictions)
          .where(eq(schema.baseballPredictions.gameId, g.id))
          .limit(1);
        if (existing.length) {
          skipped++;
          continue;
        }
      }
      try {
        await this.generatePrediction(g.id, type);
        generated++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to predict game ${g.id}: ${(err as Error).message}`,
        );
      }
    }
    return { generated, skipped, failed };
  }

  /**
   * Resolve completed/void games: score each line over/under vs actual total,
   * compute Brier on the primary line. Mirrors soccer resolvePredictions.
   */
  async resolvePredictions(): Promise<{ resolved: number; voided: number }> {
    const pending = await this.db
      .select()
      .from(schema.baseballPredictions)
      .where(eq(schema.baseballPredictions.predictionStatus, 'pending'));

    let resolved = 0;
    let voided = 0;
    for (const p of pending) {
      const game = await this.baseball.getGameById(p.gameId);
      if (!game) continue;

      if (BASEBALL_VOID_STATUSES.includes(game.status)) {
        await this.db
          .update(schema.baseballPredictions)
          .set({ predictionStatus: 'void', resolvedAt: new Date() })
          .where(eq(schema.baseballPredictions.id, p.id));
        voided++;
        continue;
      }
      if (
        !BASEBALL_COMPLETED_STATUSES.includes(game.status) ||
        game.runsHome == null ||
        game.runsAway == null
      ) {
        continue;
      }

      const total = game.runsHome + game.runsAway;
      const perLineResults = (p.lineProbs ?? []).map((l: any) => {
        const line = Number(l.line);
        let outcome: 'over' | 'under' | 'push';
        if (total > line) outcome = 'over';
        else if (total < line) outcome = 'under';
        else outcome = 'push';
        return { line, outcome };
      });

      // Brier on primary line (skip push).
      const primaryLine = Number(p.primaryLine);
      const pOver = Number(p.primaryPOver);
      let brier: number | null = null;
      if (total !== primaryLine) {
        const wasOver = total > primaryLine ? 1 : 0;
        brier = (pOver - wasOver) ** 2;
      }

      await this.db
        .update(schema.baseballPredictions)
        .set({
          predictionStatus: 'resolved',
          actualTotalRuns: total,
          perLineResults,
          brier: brier == null ? null : String(round4(brier)),
          resolvedAt: new Date(),
        })
        .where(eq(schema.baseballPredictions.id, p.id));
      resolved++;
    }
    this.logger.log(`Resolved ${resolved} baseball predictions, voided ${voided}`);
    return { resolved, voided };
  }

  // ─── internals ─────────────────────────────────────────────────────

  /** Match game to MLB StatsAPI schedule for gamePk + probables + weather. */
  private async enrichGame(game: any): Promise<any> {
    if (game.gamePk && game.weather && game.homeProbablePitcherId) return game;
    const homeSeed = this.teamMap.getByApiSports(game.homeTeamId);
    const awaySeed = this.teamMap.getByApiSports(game.awayTeamId);
    if (!homeSeed || !awaySeed) return game;

    const date = new Date(game.date).toISOString().split('T')[0];
    const sched = await this.mlbStats.getSchedule(date);
    const match = sched.find(
      (s) =>
        s.homeTeamMlbamId === homeSeed.mlbamTeamId &&
        s.awayTeamMlbamId === awaySeed.mlbamTeamId,
    );
    if (!match) return game;

    let weather = game.weather;
    let lineupsConfirmed = game.lineupsConfirmed;
    try {
      const ctx = await this.mlbStats.getGameContext(match.gamePk);
      weather = ctx.weather;
      lineupsConfirmed = ctx.lineupsConfirmed;
    } catch {
      /* keep existing */
    }

    const patch = {
      gamePk: match.gamePk,
      homeProbablePitcherId: match.homeProbable?.mlbamId,
      awayProbablePitcherId: match.awayProbable?.mlbamId,
      lineupsConfirmed,
      weather,
    };
    await this.baseball.setGamePk(game.id, patch);
    return { ...game, ...patch };
  }

  /** Linear-pool blend per line. Market-anchored when a sharp total exists. */
  private blend(
    model: LineProb[],
    agent: LineProb[],
    market: LineProb[] | null,
  ): BlendedLine[] {
    const byLine = (arr: LineProb[]) => new Map(arr.map((l) => [l.line, l]));
    const mModel = byLine(model);
    const mAgent = byLine(agent);
    const mMarket = market ? byLine(market) : null;

    const lines = [...mModel.keys()].sort((a, b) => a - b);
    const w = mMarket
      ? { model: 0.3, agent: 0.2, market: 0.5 }
      : { model: 0.6, agent: 0.4, market: 0 };

    return lines.map((line) => {
      const pm = mModel.get(line)!;
      const pa = mAgent.get(line)?.pOver ?? pm.pOver;
      const pk = mMarket?.get(line)?.pOver ?? null;
      // When the market line is missing, renormalize over model+agent only.
      const pOver =
        pk == null
          ? clampProb((w.model * pm.pOver + w.agent * pa) / (w.model + w.agent))
          : clampProb(w.model * pm.pOver + w.agent * pa + w.market * pk);
      const push = pm.push;
      return {
        line,
        pOver,
        pUnder: clampProb(1 - pOver - push),
        push,
        model: pm.pOver,
        agent: pa,
        market: pk,
      };
    });
  }

  /** Calibration hook — identity until Phase 3 fits binary calibrators. */
  private async calibrate(blended: BlendedLine[]): Promise<BlendedLine[]> {
    return blended;
  }

  private pickPrimary(
    lines: BlendedLine[],
    target: number,
  ): { line: number; pOver: number } {
    let best = lines[0];
    let bestDist = Infinity;
    for (const l of lines) {
      const d = Math.abs(l.line - target);
      if (d < bestDist) {
        bestDist = d;
        best = l;
      }
    }
    return { line: best.line, pOver: best.pOver };
  }
}

function blendRawFor(blended: BlendedLine[], line: number): number {
  const l = blended.find((x) => x.line === line);
  return l ? l.pOver : 0.5;
}
function clampProb(x: number): number {
  return Math.max(0.001, Math.min(0.999, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
