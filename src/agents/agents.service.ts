import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  eq,
  and,
  gte,
  lte,
  desc,
  isNull,
  isNotNull,
  sql,
  asc,
  inArray,
} from 'drizzle-orm';
import * as schema from '../database/schema';
import { DataCollectorAgent, CollectedMatchData } from './data-collector.agent';
import { ResearchAgent, ResearchResult } from './research.agent';
import { AnalysisAgent, PredictionOutput } from './analysis.agent';
import { CriticAgent, CriticOutput } from './critic.agent';
import {
  FirstPrinciplesAgent,
  FirstPrinciplesOutput,
} from './first-principles.agent';
import { PoissonModelService } from './poisson-model.service';
import {
  PlayerImpactService,
  TeamAbsenceImpact,
} from './player-impact.service';
import { FootballService } from '../football/football.service';
import { OddsService } from '../odds/odds.service';
import { AlertsService } from '../alerts/alerts.service';
import { PredictionMemoryService } from './prediction-memory.service';
import {
  LeaguePriorsService,
  type LeaguePriors,
} from './league-priors.service';
import {
  VenueContextService,
  type VenueContext,
} from './venue-context.service';
import { IsotonicCalibrationService } from './isotonic-calibration.service';
import { DirichletCalibrationService } from './dirichlet-calibration.service';
import { FormBasedNudgeService } from './form-based-nudge.service';
import { MatchInsightsService } from './match-insights.service';
import { MarketAnalysisService } from './market-analysis.service';
import { MatchContextService } from './match-context.service';
import {
  ClosingLineService,
  type ClosingLineSignal,
} from './closing-line.service';
import {
  PiRatingService,
  type PiRatingPrediction,
} from './pi-rating.service';
import {
  MetaBlenderService,
  type MetaBlendInputs,
} from './meta-blender.service';
import { LineupRestFeaturesService } from './lineup-rest-features.service';
import { SmartMoneySignalService } from '../polymarket/services/smart-money-signal.service';
import type { SmartMoneySignal } from '../polymarket/services/smart-money-signal.service';
import { PolymarketService } from '../polymarket/polymarket.service';
import {
  PredictionType,
  PerformanceFeedback,
  PoissonModelOutput,
} from './types';

// Re-export so existing importers don't break
export { PredictionType, PerformanceFeedback } from './types';

export interface DailyBreakdown {
  date: string;
  summary: {
    total: number;
    resolved: number;
    correct: number;
    incorrect: number;
    pending: number;
    accuracy: number;
    avgConfidence: number;
    avgBrierScore: number | null;
  };
  byResult: {
    home_win: { predicted: number; correct: number; accuracy: number };
    draw: { predicted: number; correct: number; accuracy: number };
    away_win: { predicted: number; correct: number; accuracy: number };
  };
  predictions: Array<{
    predictionId: number;
    fixtureId: number;
    matchDate: Date;
    matchStatus: string;
    league: { id: number; name: string | null; country: string | null };
    homeTeam: { id: number; name: string | null; logo: string | null };
    awayTeam: { id: number; name: string | null; logo: string | null };
    predicted: {
      result: string;
      homeWinProb: number;
      drawProb: number;
      awayWinProb: number;
      homeGoals: number | null;
      awayGoals: number | null;
      confidence: number | null;
    };
    actual: {
      result: string | null;
      homeGoals: number | null;
      awayGoals: number | null;
    };
    wasCorrect: boolean | null;
    brierScore: number | null;
    predictionType: string;
    polymarketLink: string | null;
    createdAt: Date;
  }>;
}

export interface DailyBreakdownRange {
  range: { from: string; to: string; days: number };
  summary: DailyBreakdown['summary'];
  byResult: DailyBreakdown['byResult'];
  days: DailyBreakdown[];
}

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);
  private readonly openai?: OpenAI;
  private readonly insightsModel: string;

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly config: ConfigService,
    private readonly dataCollector: DataCollectorAgent,
    private readonly researchAgent: ResearchAgent,
    private readonly analysisAgent: AnalysisAgent,
    private readonly criticAgent: CriticAgent,
    private readonly firstPrinciplesAgent: FirstPrinciplesAgent,
    private readonly poissonModel: PoissonModelService,
    private readonly playerImpact: PlayerImpactService,
    private readonly footballService: FootballService,
    private readonly oddsService: OddsService,
    private readonly alertsService: AlertsService,
    private readonly predictionMemory: PredictionMemoryService,
    private readonly leaguePriorsService: LeaguePriorsService,
    private readonly venueContextService: VenueContextService,
    private readonly isotonicCalibrationService: IsotonicCalibrationService,
    private readonly dirichletCalibrationService: DirichletCalibrationService,
    private readonly formBasedNudgeService: FormBasedNudgeService,
    private readonly closingLineService: ClosingLineService,
    private readonly piRatingService: PiRatingService,
    private readonly metaBlenderService: MetaBlenderService,
    private readonly lineupRestFeaturesService: LineupRestFeaturesService,
    private readonly smartMoneySignalService: SmartMoneySignalService,
    private readonly polymarketService: PolymarketService,
    private readonly matchInsightsService: MatchInsightsService,
    private readonly marketAnalysisService: MarketAnalysisService,
    private readonly matchContextService: MatchContextService,
  ) {
    const openaiKey = this.config.get<string>('OPENAI_API_KEY');
    if (openaiKey) this.openai = new OpenAI({ apiKey: openaiKey });
    this.insightsModel =
      this.config.get<string>('PREDICTION_INSIGHTS_MODEL') || 'gpt-5.4';
  }

  // ─── Core prediction pipeline ───────────────────────────────────────

  /**
   * Run the full 3-agent prediction pipeline for a single fixture.
   * 1. Data Collector  — gathers structured data from DB + APIs
   * 2. Research Agent   — Perplexity Sonar web search
   * 3. Analysis Agent   — Claude reasoning + structured prediction output
   */
  async generatePrediction(
    fixtureId: number,
    predictionType: PredictionType,
  ): Promise<any> {
    this.logger.log(
      `Starting prediction pipeline for fixture ${fixtureId} (type: ${predictionType})`,
    );

    const startTime = Date.now();

    // Step 0: Freshen all data sources before prediction
    await this.freshenDataForFixture(fixtureId);

    // Step 1: Collect data
    let matchData: CollectedMatchData;
    try {
      matchData = await this.dataCollector.collect(fixtureId);
    } catch (error) {
      this.logger.error(
        `Data collection failed for fixture ${fixtureId}: ${error.message}`,
      );
      throw error;
    }

    // Step 1b: Compute player impact scores for injuries/absences
    let playerImpactScores: {
      home: TeamAbsenceImpact;
      away: TeamAbsenceImpact;
    } | null = null;
    try {
      playerImpactScores = await this.playerImpact.computeImpactScores(
        matchData.injuries,
        matchData.fixture.homeTeamId,
        matchData.fixture.awayTeamId,
        matchData.fixture.leagueId,
        fixtureId,
      );

      const homeAbsences = playerImpactScores.home.players.filter(
        (p) => p.impactLabel !== 'MINIMAL',
      );
      const awayAbsences = playerImpactScores.away.players.filter(
        (p) => p.impactLabel !== 'MINIMAL',
      );
      if (homeAbsences.length > 0 || awayAbsences.length > 0) {
        this.logger.log(
          `Player impact for fixture ${fixtureId}: ` +
            `Home absences=${homeAbsences.length} (xG×${playerImpactScores.home.xgMultiplier}, xGA×${playerImpactScores.home.xgaMultiplier}), ` +
            `Away absences=${awayAbsences.length} (xG×${playerImpactScores.away.xgMultiplier}, xGA×${playerImpactScores.away.xgaMultiplier})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Player impact scoring failed for fixture ${fixtureId}: ${error.message}`,
      );
    }

    // Attach player impact to matchData so downstream agents can use it
    matchData.playerImpact = playerImpactScores;

    // Step 1c: Compute venue / contextual flags (derby, altitude, stakes).
    // Cheap CPU-only operation, no DB or API calls — done synchronously.
    let venueContext: VenueContext | null = null;
    try {
      venueContext = this.venueContextService.compute({
        fixture: matchData.fixture,
        homeTeam: matchData.homeTeam?.team
          ? {
              id: matchData.homeTeam.team.id,
              name: matchData.homeTeam.team.name,
              venueName: matchData.homeTeam.team.venueName ?? null,
            }
          : null,
        awayTeam: matchData.awayTeam?.team
          ? {
              id: matchData.awayTeam.team.id,
              name: matchData.awayTeam.team.name,
              venueName: matchData.awayTeam.team.venueName ?? null,
            }
          : null,
        homeStandings: matchData.standings.home
          ? {
              leaguePosition: matchData.standings.home.leaguePosition ?? null,
              totalTeams: matchData.standings.home.totalTeams ?? null,
            }
          : null,
        awayStandings: matchData.standings.away
          ? {
              leaguePosition: matchData.standings.away.leaguePosition ?? null,
              totalTeams: matchData.standings.away.totalTeams ?? null,
            }
          : null,
      });
      if (
        venueContext.derbyType ||
        venueContext.altitudeBoost > 0 ||
        venueContext.lateSeasonStakes
      ) {
        this.logger.log(
          `Venue context for ${fixtureId}: derby=${venueContext.derbyType ?? 'none'}, ` +
            `altitude=${venueContext.altitudeBoost.toFixed(2)} (${venueContext.altitudeVenue ?? '—'}), ` +
            `stakes=${venueContext.lateSeasonStakes ?? 'none'}`,
        );
      }
    } catch (error) {
      this.logger.debug(
        `Venue context failed for fixture ${fixtureId}: ${(error as Error).message}`,
      );
      venueContext = null;
    }
    matchData.venueContext = venueContext;

    // Step 1d: Deep-analysis insights (head-to-head history, last-20 form,
    // streaks, full player-by-player roster). Display-only — surfaced in the
    // response and as read-only narrative context to the analysis prompt, but
    // it does NOT feed the probability blend (H2H + streak signals were shown
    // to hurt Brier in our back-tests).
    try {
      matchData.matchInsights = await this.matchInsightsService.build(
        matchData,
      );
      // Context layer (referee / weather / discipline / stakes). Computed here
      // (pre-analysis) so its narrative flows into the analysis prompt as
      // display context. Markets are added later (they need the prediction).
      if (matchData.matchInsights) {
        try {
          const context = await this.matchContextService.build(
            matchData,
            matchData.matchInsights,
          );
          matchData.matchInsights.context = context;
          if (context.narrative) {
            matchData.matchInsights.narrative +=
              `\n\nCONTEXT\n${context.narrative}`;
          }
        } catch (ctxErr) {
          this.logger.debug(
            `Match context failed for fixture ${fixtureId}: ${(ctxErr as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.debug(
        `Match insights failed for fixture ${fixtureId}: ${(error as Error).message}`,
      );
      matchData.matchInsights = null;
    }

    // Step 2: Web research + performance feedback + Poisson model + memory recall + league priors (in parallel)
    let research: ResearchResult;
    let feedback: PerformanceFeedback | null = null;
    let poissonOutput: PoissonModelOutput | null = null;
    let memories: string | null = null;
    let leaguePriors: LeaguePriors | null = null;
    try {
      const homeName =
        matchData.homeTeam?.team?.name ??
        `Team ${matchData.fixture.homeTeamId}`;
      const awayName =
        matchData.awayTeam?.team?.name ??
        `Team ${matchData.fixture.awayTeamId}`;

      // League priors are fetched FIRST so the Poisson model can use them
      // as its cold-start fallback (instead of the global 45/26/29 default).
      // The cache TTL means this is essentially free after the first call
      // per league.
      try {
        leaguePriors = await this.leaguePriorsService.getLeaguePriors(
          matchData.fixture.leagueId,
        );
      } catch (error) {
        this.logger.debug(
          `League priors unavailable for league ${matchData.fixture.leagueId}: ${(error as Error).message}`,
        );
        leaguePriors = null;
      }

      const [
        researchResult,
        feedbackResult,
        poissonResult,
        memoriesResult,
      ] = await Promise.allSettled([
        this.researchAgent.research(matchData),
        this.getPerformanceFeedback(),
        this.poissonModel.predict(
          matchData.fixture.homeTeamId,
          matchData.fixture.awayTeamId,
          matchData.fixture.leagueId,
          fixtureId,
          playerImpactScores ?? undefined,
          leaguePriors,
          venueContext,
        ),
        this.predictionMemory.recallForPrediction({
          homeTeamName: homeName,
          awayTeamName: awayName,
          homeTeamId: matchData.fixture.homeTeamId,
          awayTeamId: matchData.fixture.awayTeamId,
          leagueId: matchData.fixture.leagueId,
          leagueName:
            matchData.fixture.leagueName ??
            `League ${matchData.fixture.leagueId}`,
        }),
      ]);

      research =
        researchResult.status === 'fulfilled'
          ? researchResult.value
          : {
              matchPreview: null,
              teamNews: null,
              tacticalAnalysis: null,
              combinedResearch:
                'Research unavailable — proceeding with structured data only.',
              citations: [],
            };

      if (researchResult.status === 'rejected') {
        this.logger.warn(
          `Research failed for fixture ${fixtureId}, proceeding with data only: ${researchResult.reason?.message}`,
        );
      }

      feedback =
        feedbackResult.status === 'fulfilled' ? feedbackResult.value : null;

      poissonOutput =
        poissonResult.status === 'fulfilled' ? poissonResult.value : null;

      memories =
        memoriesResult.status === 'fulfilled' ? memoriesResult.value : null;

      if (poissonOutput) {
        this.logger.log(
          `Poisson model for fixture ${fixtureId}: H=${(poissonOutput.homeWinProb * 100).toFixed(1)}% ` +
            `D=${(poissonOutput.drawProb * 100).toFixed(1)}% A=${(poissonOutput.awayWinProb * 100).toFixed(1)}% ` +
            `(conf=${poissonOutput.confidence}, data=${poissonOutput.dataPoints})`,
        );
      }

      if (memories) {
        this.logger.log(
          `Recalled prediction memories for fixture ${fixtureId} (${homeName} vs ${awayName})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Research/feedback/model failed for fixture ${fixtureId}: ${error.message}`,
      );
      research = {
        matchPreview: null,
        teamNews: null,
        tacticalAnalysis: null,
        combinedResearch:
          'Research unavailable — proceeding with structured data only.',
        citations: [],
      };
    }

    // Step 3: Analysis (main reasoner)
    let prediction: PredictionOutput;
    try {
      prediction = await this.analysisAgent.analyze(
        matchData,
        research,
        feedback,
        poissonOutput,
        memories,
        leaguePriors,
      );
    } catch (error) {
      this.logger.error(
        `Analysis failed for fixture ${fixtureId}: ${error.message}`,
      );
      throw error;
    }

    // Step 3a: Critic + First-principles challenge pass
    let criticReview: CriticOutput | null = null;
    let firstPrinciples: FirstPrinciplesOutput | null = null;
    try {
      const [criticResult, fpResult] = await Promise.allSettled([
        this.criticAgent.review(matchData, research, prediction),
        this.firstPrinciplesAgent.rethink(matchData),
      ]);

      if (criticResult.status === 'fulfilled') {
        criticReview = criticResult.value;
      }
      if (fpResult.status === 'fulfilled') {
        firstPrinciples = fpResult.value;
      }

      prediction = this.applyChallengePass(
        prediction,
        firstPrinciples,
        criticReview,
      );
    } catch (error) {
      this.logger.warn(
        `Challenge pass failed for fixture ${fixtureId}: ${error.message}`,
      );
    }

    // Step 3a': Build closing-line signal (Pinnacle close + open→close drift)
    // so the ensemble can blend against the sharpest available book rather
    // than the generic multi-book consensus.
    try {
      const kickoff = matchData.fixture?.date
        ? new Date(matchData.fixture.date)
        : null;
      const closingLineSignal = await this.closingLineService.build(
        matchData.fixture?.oddsApiEventId ?? null,
        kickoff,
      );
      matchData.closingLineSignal = closingLineSignal;
      if (closingLineSignal) {
        this.logger.debug(
          `Closing-line signal for ${fixtureId}: source=${closingLineSignal.sourceUsed}, ` +
            `drift|=${closingLineSignal.driftMagnitude.toFixed(3)} (n=${closingLineSignal.driftSampleSize}), ` +
            `overround=${closingLineSignal.pinnacleOverround?.toFixed(4) ?? 'n/a'}, ` +
            `ageSec=${closingLineSignal.snapshotAgeSeconds ?? 'n/a'}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Closing-line signal build failed for fixture ${fixtureId}: ${(error as Error).message}`,
      );
      matchData.closingLineSignal = null;
    }

    // Step 3a''.5: Lineup-delta + rest-day features. Acute fatigue
    // (rest_diff, 3-in-7 congestion) and rotation/injury surprises
    // (XI vs typical XI delta in goal involvement) — surfaces directly
    // in the LLM context block via `lineupRestFeatures.promptSummary`.
    try {
      if (
        matchData.fixture?.homeTeamId &&
        matchData.fixture?.awayTeamId &&
        matchData.fixture?.date
      ) {
        matchData.lineupRestFeatures =
          await this.lineupRestFeaturesService.compute({
            fixtureId,
            homeTeamId: matchData.fixture.homeTeamId,
            awayTeamId: matchData.fixture.awayTeamId,
            fixtureDate: new Date(matchData.fixture.date),
          });
        if (matchData.lineupRestFeatures?.promptSummary) {
          this.logger.debug(
            `Lineup/rest for ${fixtureId}: ${matchData.lineupRestFeatures.promptSummary}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Lineup-rest features failed for fixture ${fixtureId}: ${(error as Error).message}`,
      );
      matchData.lineupRestFeatures = null;
    }

    // Step 3a'': Pi-rating prediction (Constantinou-Fenton). Adds a
    // fourth base predictor whose residuals are orthogonal to xG-based
    // Poisson — independent enough to deliver meaningful ensemble lift
    // even though each model alone is only marginally accurate.
    try {
      if (
        matchData.fixture?.homeTeamId &&
        matchData.fixture?.awayTeamId &&
        matchData.fixture?.leagueId != null
      ) {
        const piPrediction = await this.piRatingService.predict(
          matchData.fixture.homeTeamId,
          matchData.fixture.awayTeamId,
          matchData.fixture.leagueId,
        );
        matchData.piRatingPrediction = piPrediction;
        if (piPrediction.mappingApplied) {
          this.logger.debug(
            `Pi-rating for ${fixtureId}: ĝ=${piPrediction.predictedGoalDiff.toFixed(2)} ` +
              `(${piPrediction.mappingScope}) → H=${(piPrediction.homeWinProb * 100).toFixed(1)}% ` +
              `D=${(piPrediction.drawProb * 100).toFixed(1)}% A=${(piPrediction.awayWinProb * 100).toFixed(1)}%`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Pi-rating prediction failed for fixture ${fixtureId}: ${(error as Error).message}`,
      );
      matchData.piRatingPrediction = null;
    }

    // Step 3b: Ensemble — prefer the learned meta-blender (4-predictor
    // log-pool) when fitted; fall back to the legacy flat 30/30/40 blend.
    prediction = await this.ensemblePredictions(
      prediction,
      poissonOutput,
      matchData,
    );

    // Step 3c: Smart-money signal (when fixture is linked to a Polymarket
    // market).
    //
    // We currently use the signal ONLY as a confidence modifier — agreement
    // gets +1, disagreement on a direct market gets -1. The original April
    // 2026 backtest of 583 signaled predictions showed agreement → mean
    // Brier 0.560 vs disagreement → 0.602, a 0.042 gap that justifies the
    // confidence move.
    //
    // We previously also applied a probability blend (push probs toward
    // sharp positioning). The April 2026 backtest of that blend on 37
    // qualifying predictions showed it HURT Brier monotonically across
    // every weight cap (0.05 → +0.005, 0.20 → +0.013, 0.50 → +0.020) and
    // every cohort (high-lean cases hurt MOST: +0.048 at |lean|≥0.80).
    // The 0.042 Brier gap above came from agreement cases being
    // intrinsically more predictable (Claude + bookmakers + Poisson
    // converged), not from sharp positioning adding new directional signal.
    // See autoresearch/smart-money-blend-backtest.ts for the full data.
    //
    // applySmartMoneyProbabilityBlend remains defined below for future
    // re-introduction with stricter gating once more sharp-money samples
    // accumulate, but it is intentionally NOT wired into the pipeline.
    let smartMoneySignal:
      | (SmartMoneySignal & { marketTeamId?: number | null })
      | null = null;
    try {
      smartMoneySignal = await this.computeSmartMoneySignal(fixtureId);
      if (smartMoneySignal && smartMoneySignal.leanScore != null) {
        prediction = this.applySmartMoneyConfidenceAdjustment(
          prediction,
          smartMoneySignal,
          matchData,
        );
      }
    } catch (error) {
      this.logger.debug(
        `Smart-money signal unavailable for ${fixtureId}: ${
          (error as Error).message
        }`,
      );
    }

    // Step 3d: Empirical calibration. Native-multiclass Dirichlet
    // calibration (Kull et al., NeurIPS 2019) is preferred — it learns a
    // 3×3 weight matrix + bias over the log-probability triple and
    // softmaxes, which both fixes per-class biases *and* preserves the
    // simplex constraint without a manual renormalisation step. The
    // legacy per-outcome isotonic mapping runs as a safety fallback when
    // no Dirichlet row has been fitted yet.
    //
    // Both no-op gracefully when no fitted row exists (e.g. before the
    // first refit). Calibration runs LAST so all upstream signals
    // (Claude, Poisson, bookmaker/Pinnacle, sharps, draw floors) compose
    // into a coherent input distribution first.
    try {
      const dirichlet = await this.dirichletCalibrationService.applyToTriple(
        {
          homeWinProb: prediction.homeWinProb,
          drawProb: prediction.drawProb,
          awayWinProb: prediction.awayWinProb,
        },
        matchData.fixture.leagueId,
      );
      if (dirichlet.applied) {
        this.logger.log(
          `Dirichlet calibration (${dirichlet.scope}): ` +
            `H=${(prediction.homeWinProb * 100).toFixed(1)}→${(dirichlet.homeWinProb * 100).toFixed(1)}%, ` +
            `D=${(prediction.drawProb * 100).toFixed(1)}→${(dirichlet.drawProb * 100).toFixed(1)}%, ` +
            `A=${(prediction.awayWinProb * 100).toFixed(1)}→${(dirichlet.awayWinProb * 100).toFixed(1)}%`,
        );
        prediction = {
          ...prediction,
          homeWinProb: dirichlet.homeWinProb,
          drawProb: dirichlet.drawProb,
          awayWinProb: dirichlet.awayWinProb,
        };
      } else {
        // Fallback: legacy per-outcome isotonic.
        const isotonic =
          await this.isotonicCalibrationService.applyToTriple(
            {
              homeWinProb: prediction.homeWinProb,
              drawProb: prediction.drawProb,
              awayWinProb: prediction.awayWinProb,
            },
            matchData.fixture.leagueId,
          );
        if (isotonic.applied) {
          this.logger.log(
            `Isotonic calibration fallback (${isotonic.scope}): ` +
              `H=${(prediction.homeWinProb * 100).toFixed(1)}→${(isotonic.homeWinProb * 100).toFixed(1)}%, ` +
              `D=${(prediction.drawProb * 100).toFixed(1)}→${(isotonic.drawProb * 100).toFixed(1)}%, ` +
              `A=${(prediction.awayWinProb * 100).toFixed(1)}→${(isotonic.awayWinProb * 100).toFixed(1)}%`,
          );
          prediction = {
            ...prediction,
            homeWinProb: isotonic.homeWinProb,
            drawProb: isotonic.drawProb,
            awayWinProb: isotonic.awayWinProb,
          };
        }
      }
    } catch (error) {
      this.logger.debug(
        `Calibration failed (no-op fallback): ${(error as Error).message}`,
      );
    }

    // Step 3e: Form-based nudges. Three home-side rules derived from a
    // 100-game study with 100-game holdout validation — see
    // FormBasedNudgeService for the rules and their hit-rate evidence.
    // No-ops when matchData.formWindows is missing or no rule conditions
    // are met.
    try {
      const nudge = this.formBasedNudgeService.applyToTriple(
        {
          homeWinProb: prediction.homeWinProb,
          drawProb: prediction.drawProb,
          awayWinProb: prediction.awayWinProb,
        },
        matchData.formWindows,
      );
      if (nudge.applied) {
        this.logger.log(
          `Form-based nudge [${nudge.firedRules.join(',')}]: ` +
            `H=${(prediction.homeWinProb * 100).toFixed(1)}→${(nudge.homeWinProb * 100).toFixed(1)}%, ` +
            `D=${(prediction.drawProb * 100).toFixed(1)}→${(nudge.drawProb * 100).toFixed(1)}%, ` +
            `A=${(prediction.awayWinProb * 100).toFixed(1)}→${(nudge.awayWinProb * 100).toFixed(1)}%`,
        );
        prediction = {
          ...prediction,
          homeWinProb: nudge.homeWinProb,
          drawProb: nudge.drawProb,
          awayWinProb: nudge.awayWinProb,
        };
      }
    } catch (error) {
      this.logger.debug(
        `Form-based nudge failed (no-op fallback): ${(error as Error).message}`,
      );
    }

    // Step 3f: Multi-market analysis (derived from the FINAL probabilities +
    // expected goals). Display + value-detection only — never feeds the blend.
    if (matchData.matchInsights) {
      try {
        const markets = this.marketAnalysisService.build(matchData, {
          homeWinProb: prediction.homeWinProb,
          drawProb: prediction.drawProb,
          awayWinProb: prediction.awayWinProb,
          predictedHomeGoals: prediction.predictedHomeGoals,
          predictedAwayGoals: prediction.predictedAwayGoals,
        });
        matchData.matchInsights.markets = markets;
        if (markets?.valueBets?.length) {
          matchData.matchInsights.narrative +=
            `\n\nMARKETS — value: ${markets.valueBets
              .map((v) => `${v.market} (+${v.edgePct}pp)`)
              .join(', ')}`;
        }
      } catch (error) {
        this.logger.debug(
          `Market analysis failed for fixture ${fixtureId}: ${(error as Error).message}`,
        );
      }
    }

    // Step 4: Store prediction
    const modelVersion =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-opus-4-7';
    const stored = await this.storePrediction(
      fixtureId,
      matchData,
      research,
      prediction,
      predictionType,
      modelVersion,
      smartMoneySignal,
    );

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Prediction pipeline complete for fixture ${fixtureId} in ${durationMs}ms — ` +
        `confidence: ${prediction.confidence}/10, result: ${this.getPredictedResult(prediction)}`,
    );

    // Step 5: Create alert if high confidence
    const threshold =
      this.config.get<number>('PREDICTION_HIGH_CONFIDENCE_THRESHOLD') || 7;
    if (prediction.confidence >= threshold) {
      const homeName =
        matchData.homeTeam?.team?.name ??
        `Team ${matchData.fixture.homeTeamId}`;
      const awayName =
        matchData.awayTeam?.team?.name ??
        `Team ${matchData.fixture.awayTeamId}`;

      try {
        await this.alertsService.createHighConfidenceAlert(
          stored.id,
          fixtureId,
          `${homeName} vs ${awayName}`,
          prediction.confidence,
          this.getPredictedResult(prediction),
        );
      } catch (error) {
        this.logger.warn(`Failed to create alert: ${error.message}`);
      }
    }

    return {
      ...stored,
      homeTeamName: matchData.homeTeam?.team?.name ?? null,
      awayTeamName: matchData.awayTeam?.team?.name ?? null,
    };
  }

  // ─── Batch generation ───────────────────────────────────────────────

  /**
   * Generate daily predictions for all upcoming fixtures within the next 48 hours.
   */
  async generateDailyPredictions(): Promise<{
    generated: number;
    skipped: number;
    failed: number;
    errors: string[];
  }> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    // Get upcoming fixtures that don't have a daily prediction yet
    const upcomingFixtures = await this.db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, now),
          lte(schema.fixtures.date, cutoff),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    this.logger.log(
      `Daily predictions: found ${upcomingFixtures.length} upcoming fixtures`,
    );

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    const maxConcurrent =
      this.config.get<number>('PREDICTION_MAX_CONCURRENT') || 5;

    // Process in batches
    for (let i = 0; i < upcomingFixtures.length; i += maxConcurrent) {
      const batch = upcomingFixtures.slice(i, i + maxConcurrent);

      const results = await Promise.allSettled(
        batch.map(async (fixture: any) => {
          // Check if prediction already exists
          const existing = await this.db
            .select()
            .from(schema.predictions)
            .where(
              and(
                eq(schema.predictions.fixtureId, fixture.id),
                eq(schema.predictions.predictionType, 'daily'),
              ),
            )
            .limit(1);

          if (existing.length > 0) {
            return { status: 'skipped', fixtureId: fixture.id };
          }

          await this.generatePrediction(fixture.id, 'daily');
          return { status: 'generated', fixtureId: fixture.id };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.status === 'generated') generated++;
          else skipped++;
        } else {
          failed++;
          errors.push(result.reason?.message ?? 'Unknown error');
        }
      }
    }

    this.logger.log(
      `Daily predictions complete: ${generated} generated, ${skipped} skipped, ${failed} failed`,
    );

    return { generated, skipped, failed, errors };
  }

  /**
   * Generate pre-match predictions for fixtures starting within 1 hour
   * that don't already have a pre_match prediction.
   */
  async generatePreMatchPredictions(): Promise<{
    generated: number;
    skipped: number;
    failed: number;
  }> {
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    const fixtures = await this.db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, now),
          lte(schema.fixtures.date, oneHourFromNow),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (const fixture of fixtures) {
      // Check if pre_match prediction already exists
      const existing = await this.db
        .select()
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, fixture.id),
            eq(schema.predictions.predictionType, 'pre_match'),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        await this.generatePrediction(fixture.id, 'pre_match');
        generated++;
      } catch (error) {
        this.logger.warn(
          `Pre-match prediction failed for fixture ${fixture.id}: ${error.message}`,
        );
        failed++;
      }
    }

    if (generated > 0) {
      this.logger.log(
        `Pre-match predictions: ${generated} generated, ${skipped} skipped, ${failed} failed`,
      );
    }

    return { generated, skipped, failed };
  }

  // ─── Resolution ─────────────────────────────────────────────────────

  /**
   * Resolve predictions for finished matches — compute accuracy metrics.
   */
  async resolvePredictions(): Promise<{
    resolved: number;
    voided: number;
    errors: string[];
  }> {
    // Completed fixture statuses: Full Time, After Extra Time, Penalties
    const COMPLETED_STATUSES = ['FT', 'AET', 'PEN'];
    // Void fixture statuses: Postponed, Cancelled, Abandoned, Awarded, Walkover
    const VOID_STATUSES = ['PST', 'CANC', 'ABD', 'AWD', 'WO'];

    // Get unresolved predictions where the fixture is now finished or voided
    const unresolved = await this.db
      .select({
        prediction: schema.predictions,
        fixture: schema.fixtures,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          eq(schema.predictions.predictionStatus, 'pending'),
          inArray(schema.fixtures.status, [
            ...COMPLETED_STATUSES,
            ...VOID_STATUSES,
          ]),
        ),
      );

    let resolved = 0;
    let voided = 0;
    const errors: string[] = [];

    for (const { prediction, fixture } of unresolved) {
      try {
        // ── Handle voided fixtures (postponed/cancelled/abandoned) ──
        if (VOID_STATUSES.includes(fixture.status)) {
          await this.db
            .update(schema.predictions)
            .set({
              predictionStatus: 'void',
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.predictions.id, prediction.id));
          voided++;
          this.logger.log(
            `Voided prediction ${prediction.id} — fixture ${fixture.id} status: ${fixture.status}`,
          );
          continue;
        }

        // ── Handle completed fixtures ──
        const actualHomeGoals = fixture.goalsHome;
        const actualAwayGoals = fixture.goalsAway;

        if (actualHomeGoals == null || actualAwayGoals == null) continue;

        // Determine actual result
        let actualResult: string;
        if (actualHomeGoals > actualAwayGoals) actualResult = 'home_win';
        else if (actualHomeGoals < actualAwayGoals) actualResult = 'away_win';
        else actualResult = 'draw';

        // Use stored predictedResult (locked at prediction time).
        // Fall back to re-deriving from probs for legacy predictions without it.
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        const predictedResult =
          prediction.predictedResult ??
          this.getPredictedResultFromProbs(homeProb, drawProb, awayProb);

        const wasCorrect = predictedResult === actualResult;

        // Calculate Brier score (lower is better, 0 = perfect)
        const brierScore = this.calculateBrierScore(
          homeProb,
          drawProb,
          awayProb,
          actualResult,
        );

        await this.db
          .update(schema.predictions)
          .set({
            actualHomeGoals,
            actualAwayGoals,
            actualResult,
            wasCorrect,
            predictedResult, // backfill for legacy rows that had null
            predictionStatus: 'resolved',
            probabilityAccuracy: String(brierScore.toFixed(6)),
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.predictions.id, prediction.id));

        // Store memory in Supermemory for future predictions (best-effort, non-blocking)
        this.storeResolutionMemory(prediction, fixture, {
          predictedResult,
          actualResult,
          wasCorrect,
          brierScore,
          homeProb,
          drawProb,
          awayProb,
        }).catch((err) =>
          this.logger.warn(`Memory storage failed: ${err.message}`),
        );

        resolved++;
      } catch (error) {
        errors.push(
          `Failed to resolve prediction ${prediction.id}: ${error.message}`,
        );
      }
    }

    if (resolved > 0 || voided > 0) {
      this.logger.log(
        `Resolved ${resolved} predictions, voided ${voided} predictions`,
      );
    }

    return { resolved, voided, errors };
  }

  // ─── Query methods ──────────────────────────────────────────────────

  async getPredictions(filters: {
    predictionType?: string;
    leagueId?: number;
    minConfidence?: number;
    date?: string;
    unresolved?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (filters.predictionType) {
      conditions.push(
        eq(schema.predictions.predictionType, filters.predictionType),
      );
    }

    if (filters.minConfidence) {
      conditions.push(
        sql`${schema.predictions.confidence} >= ${filters.minConfidence}`,
      );
    }

    if (filters.unresolved) {
      conditions.push(isNull(schema.predictions.resolvedAt));
    }

    if (filters.date) {
      const startOfDay = new Date(`${filters.date}T00:00:00Z`);
      const endOfDay = new Date(`${filters.date}T23:59:59Z`);
      conditions.push(gte(schema.predictions.createdAt, startOfDay));
      conditions.push(lte(schema.predictions.createdAt, endOfDay));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // If filtering by leagueId, join with fixtures + teams
    if (filters.leagueId) {
      const [data, countResult] = await Promise.all([
        this.db
          .select({
            prediction: schema.predictions,
            fixture: schema.fixtures,
            homeTeam: schema.teams,
          })
          .from(schema.predictions)
          .innerJoin(
            schema.fixtures,
            eq(schema.predictions.fixtureId, schema.fixtures.id),
          )
          .leftJoin(
            schema.teams,
            eq(schema.predictions.homeTeamId, schema.teams.id),
          )
          .where(and(where, eq(schema.fixtures.leagueId, filters.leagueId)))
          .orderBy(desc(schema.predictions.createdAt))
          .limit(limit)
          .offset(offset),
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.predictions)
          .innerJoin(
            schema.fixtures,
            eq(schema.predictions.fixtureId, schema.fixtures.id),
          )
          .where(and(where, eq(schema.fixtures.leagueId, filters.leagueId))),
      ]);

      return {
        data: await this.enrichPredictionsWithTeamNames(
          data.map((r: any) => ({ ...r.prediction, fixture: r.fixture })),
        ),
        total: Number(countResult[0]?.count ?? 0),
        page,
        limit,
      };
    }

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(schema.predictions)
        .where(where)
        .orderBy(desc(schema.predictions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.predictions)
        .where(where),
    ]);

    return {
      data: await this.enrichPredictionsWithTeamNames(data),
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  /**
   * Get predictions for football fixtures by match date.
   *
   * Unlike `getPredictions` (which filters on `predictions.created_at`),
   * this joins with `fixtures` and filters on the actual **match date**.
   *
   * Supports:
   *  - Single date: `date` (YYYY-MM-DD, defaults to today)
   *  - Date range:  `from` + `to` (YYYY-MM-DD)
   *  - Shorthand:   `days` (e.g. 2 = today + next 2 days)
   *
   * For each fixture, picks the most recent prediction — an on_demand
   * rerun supersedes older pre_match / daily runs.
   */
  async getPredictionsByMatchDate(filters: {
    date?: string;
    from?: string;
    to?: string;
    days?: number;
    leagueId?: number;
    leagueName?: string;
    minConfidence?: number;
    unresolved?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{
    data: any[];
    total: number;
    page: number;
    limit: number;
    dateRange: { from: string; to: string };
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const offset = (page - 1) * limit;

    // ── Resolve date range ──────────────────────────────────────────
    let fromDate: Date;
    let toDate: Date;

    if (filters.from && filters.to) {
      fromDate = new Date(`${filters.from}T00:00:00Z`);
      toDate = new Date(`${filters.to}T23:59:59Z`);
    } else if (filters.days != null) {
      fromDate = new Date();
      fromDate.setUTCHours(0, 0, 0, 0);
      toDate = new Date(fromDate);
      toDate.setUTCDate(toDate.getUTCDate() + filters.days);
      toDate.setUTCHours(23, 59, 59, 999);
    } else {
      const dateStr = filters.date ?? new Date().toISOString().split('T')[0];
      fromDate = new Date(`${dateStr}T00:00:00Z`);
      toDate = new Date(`${dateStr}T23:59:59Z`);
    }

    // ── Build conditions ────────────────────────────────────────────
    const conditions: any[] = [
      gte(schema.fixtures.date, fromDate),
      lte(schema.fixtures.date, toDate),
    ];

    if (filters.leagueId) {
      conditions.push(eq(schema.fixtures.leagueId, filters.leagueId));
    }

    if (filters.leagueName) {
      conditions.push(
        sql`${schema.fixtures.leagueName} ILIKE ${'%' + filters.leagueName + '%'}`,
      );
    }

    if (filters.minConfidence) {
      conditions.push(
        sql`${schema.predictions.confidence} >= ${filters.minConfidence}`,
      );
    }

    if (filters.unresolved) {
      conditions.push(isNull(schema.predictions.resolvedAt));
    }

    const whereClause = and(...conditions);

    // ── Query: predictions joined with fixtures and teams ───────────
    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          prediction: schema.predictions,
          fixtureId: schema.fixtures.id,
          fixtureDate: schema.fixtures.date,
          fixtureStatus: schema.fixtures.status,
          fixtureStatusLong: schema.fixtures.statusLong,
          leagueId: schema.fixtures.leagueId,
          leagueName: schema.fixtures.leagueName,
          leagueCountry: schema.fixtures.leagueCountry,
          homeTeamId: schema.fixtures.homeTeamId,
          awayTeamId: schema.fixtures.awayTeamId,
          goalsHome: schema.fixtures.goalsHome,
          goalsAway: schema.fixtures.goalsAway,
        })
        .from(schema.predictions)
        .innerJoin(
          schema.fixtures,
          eq(schema.predictions.fixtureId, schema.fixtures.id),
        )
        .where(whereClause)
        .orderBy(asc(schema.fixtures.date), desc(schema.predictions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.predictions)
        .innerJoin(
          schema.fixtures,
          eq(schema.predictions.fixtureId, schema.fixtures.id),
        )
        .where(whereClause),
    ]);

    // ── Batch-fetch team names ──────────────────────────────────────
    const teamIds = new Set<number>();
    for (const row of rows) {
      if (row.homeTeamId) teamIds.add(row.homeTeamId);
      if (row.awayTeamId) teamIds.add(row.awayTeamId);
    }

    const teamMap = new Map<number, { name: string; logo: string | null }>();
    if (teamIds.size > 0) {
      const teamRows = await this.db
        .select({
          id: schema.teams.id,
          name: schema.teams.name,
          logo: schema.teams.logo,
        })
        .from(schema.teams)
        .where(
          sql`${schema.teams.id} IN (${sql.join(
            [...teamIds].map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );

      for (const t of teamRows) {
        teamMap.set(t.id, { name: t.name, logo: t.logo });
      }
    }

    // ── Shape response: group by fixture, pick best prediction ──────
    const fixtureMap = new Map<number, any>();

    for (const row of rows) {
      const fId = row.fixtureId;

      if (!fixtureMap.has(fId)) {
        const homeTeam = teamMap.get(row.homeTeamId);
        const awayTeam = teamMap.get(row.awayTeamId);

        fixtureMap.set(fId, {
          fixtureId: fId,
          date: row.fixtureDate,
          status: row.fixtureStatus,
          statusLong: row.fixtureStatusLong,
          league: {
            id: row.leagueId,
            name: row.leagueName,
            country: row.leagueCountry,
          },
          homeTeam: homeTeam
            ? { id: row.homeTeamId, ...homeTeam }
            : { id: row.homeTeamId, name: null, logo: null },
          awayTeam: awayTeam
            ? { id: row.awayTeamId, ...awayTeam }
            : { id: row.awayTeamId, name: null, logo: null },
          goalsHome: row.goalsHome,
          goalsAway: row.goalsAway,
          prediction: null as any,
          allPredictions: [] as any[],
        });
      }

      const entry = fixtureMap.get(fId)!;
      entry.allPredictions.push(row.prediction);
    }

    // Pick best prediction per fixture: the most recent run wins. An
    // on_demand rerun is explicitly triggered with fresher data, so it
    // should supersede older pre_match / daily predictions.
    for (const entry of fixtureMap.values()) {
      entry.allPredictions.sort(
        (a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      entry.prediction = entry.allPredictions[0] ?? null;
      entry.allPredictions = entry.allPredictions.map((p: any) => ({
        id: p.id,
        predictionType: p.predictionType,
        confidence: p.confidence,
        createdAt: p.createdAt,
      }));
    }

    const data = Array.from(fixtureMap.values());

    return {
      data,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
      dateRange: {
        from: fromDate.toISOString().split('T')[0],
        to: toDate.toISOString().split('T')[0],
      },
    };
  }

  async getPredictionByFixtureId(fixtureId: number): Promise<any[]> {
    const rows = await this.db
      .select()
      .from(schema.predictions)
      .where(eq(schema.predictions.fixtureId, fixtureId))
      .orderBy(desc(schema.predictions.createdAt));

    return this.enrichPredictionsWithTeamNames(rows);
  }

  /**
   * Data-driven prediction analytics endpoint.
   * Returns raw metrics + LLM-generated pattern insights.
   */
  async getPredictionInsights(filters?: {
    predictionType?: PredictionType;
    limit?: number;
    minLeagueSample?: number;
  }): Promise<any> {
    const limit = Math.min(Math.max(filters?.limit ?? 500, 50), 2000);
    const minLeagueSample = Math.min(
      Math.max(filters?.minLeagueSample ?? 10, 3),
      100,
    );

    const conditions = [eq(schema.predictions.predictionStatus, 'resolved')];
    if (filters?.predictionType) {
      conditions.push(
        eq(schema.predictions.predictionType, filters.predictionType),
      );
    }

    const resolved = await this.db
      .select({
        prediction: schema.predictions,
        fixture: schema.fixtures,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.predictions.resolvedAt))
      .limit(limit);

    if (resolved.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        filters: {
          predictionType: filters?.predictionType ?? 'all',
          limit,
          minLeagueSample,
        },
        totals: {
          sampleSize: 0,
          resolved: 0,
          correct: 0,
          accuracy: 0,
          avgBrier: null,
        },
        patterns: {
          summary: 'No resolved predictions available yet for insights.',
          keyPatterns: [],
          strongestLeagues: [],
          weakestLeagues: [],
          confidenceCalibration: [],
          improvementSignals: [],
        },
      };
    }

    const total = resolved.length;
    const correct = resolved.filter(
      (r: any) => r.prediction.wasCorrect === true,
    ).length;
    const accuracy = total > 0 ? correct / total : 0;
    const avgBrier =
      total > 0
        ? resolved.reduce(
            (sum: number, r: any) =>
              sum + (Number(r.prediction.probabilityAccuracy) || 0),
            0,
          ) / total
        : null;

    const byTypeMap: Record<
      string,
      { total: number; correct: number; avgBrierSum: number }
    > = {};
    const byLeagueMap: Record<
      string,
      {
        total: number;
        correct: number;
        avgBrierSum: number;
        leagueId: number;
        country: string | null;
      }
    > = {};

    const confidenceBuckets = {
      high: { total: 0, correct: 0 }, // 8-10
      medium: { total: 0, correct: 0 }, // 5-7
      low: { total: 0, correct: 0 }, // 1-4
    };

    const predictedOutcomeCounts = { home_win: 0, draw: 0, away_win: 0 };
    const actualOutcomeCounts = { home_win: 0, draw: 0, away_win: 0 };

    for (const { prediction, fixture } of resolved) {
      const type = prediction.predictionType as string;
      if (!byTypeMap[type]) {
        byTypeMap[type] = { total: 0, correct: 0, avgBrierSum: 0 };
      }
      byTypeMap[type].total++;
      if (prediction.wasCorrect) byTypeMap[type].correct++;
      byTypeMap[type].avgBrierSum +=
        Number(prediction.probabilityAccuracy) || 0;

      const leagueName = fixture.leagueName ?? `League ${fixture.leagueId}`;
      if (!byLeagueMap[leagueName]) {
        byLeagueMap[leagueName] = {
          total: 0,
          correct: 0,
          avgBrierSum: 0,
          leagueId: fixture.leagueId,
          country: fixture.leagueCountry,
        };
      }
      byLeagueMap[leagueName].total++;
      if (prediction.wasCorrect) byLeagueMap[leagueName].correct++;
      byLeagueMap[leagueName].avgBrierSum +=
        Number(prediction.probabilityAccuracy) || 0;

      const conf = Number(prediction.confidence ?? 5);
      if (conf >= 8) {
        confidenceBuckets.high.total++;
        if (prediction.wasCorrect) confidenceBuckets.high.correct++;
      } else if (conf >= 5) {
        confidenceBuckets.medium.total++;
        if (prediction.wasCorrect) confidenceBuckets.medium.correct++;
      } else {
        confidenceBuckets.low.total++;
        if (prediction.wasCorrect) confidenceBuckets.low.correct++;
      }

      const predictedResult =
        prediction.predictedResult ??
        this.getPredictedResultFromProbs(
          Number(prediction.homeWinProb),
          Number(prediction.drawProb),
          Number(prediction.awayWinProb),
        );

      if (
        predictedResult === 'home_win' ||
        predictedResult === 'draw' ||
        predictedResult === 'away_win'
      ) {
        predictedOutcomeCounts[predictedResult]++;
      }

      if (
        prediction.actualResult === 'home_win' ||
        prediction.actualResult === 'draw' ||
        prediction.actualResult === 'away_win'
      ) {
        actualOutcomeCounts[prediction.actualResult]++;
      }
    }

    const byType = Object.entries(byTypeMap).map(([type, v]) => ({
      predictionType: type,
      total: v.total,
      correct: v.correct,
      accuracy: v.total > 0 ? Number((v.correct / v.total).toFixed(4)) : 0,
      avgBrier:
        v.total > 0 ? Number((v.avgBrierSum / v.total).toFixed(6)) : null,
    }));

    const leagueRows = Object.entries(byLeagueMap).map(([league, v]) => ({
      league,
      leagueId: v.leagueId,
      country: v.country,
      total: v.total,
      correct: v.correct,
      accuracy: v.total > 0 ? Number((v.correct / v.total).toFixed(4)) : 0,
      avgBrier:
        v.total > 0 ? Number((v.avgBrierSum / v.total).toFixed(6)) : null,
    }));

    const leaguesWithSample = leagueRows.filter(
      (r) => r.total >= minLeagueSample,
    );

    const strongestLeagues = [...leaguesWithSample]
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, 5);

    const weakestLeagues = [...leaguesWithSample]
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 5);

    // Simple time trend: recent half vs previous half
    const midpoint = Math.floor(resolved.length / 2);
    const recentHalf = resolved.slice(0, midpoint);
    const previousHalf = resolved.slice(midpoint);

    const calcAcc = (rows: any[]) =>
      rows.length > 0
        ? rows.filter((r: any) => r.prediction.wasCorrect === true).length /
          rows.length
        : 0;

    const calcBrier = (rows: any[]) =>
      rows.length > 0
        ? rows.reduce(
            (sum: number, r: any) =>
              sum + (Number(r.prediction.probabilityAccuracy) || 0),
            0,
          ) / rows.length
        : null;

    const recentAccuracy = calcAcc(recentHalf);
    const previousAccuracy = calcAcc(previousHalf);
    const recentBrier = calcBrier(recentHalf);
    const previousBrier = calcBrier(previousHalf);

    const predictionTestRows = await this.db
      .select({
        test: schema.predictionTests,
        fixture: schema.fixtures,
      })
      .from(schema.predictionTests)
      .leftJoin(
        schema.fixtures,
        eq(schema.predictionTests.fixtureId, schema.fixtures.id),
      )
      .orderBy(desc(schema.predictionTests.createdAt))
      .limit(1000);

    const testsTotal = predictionTestRows.length;
    const testsImproved = predictionTestRows.filter(
      (r: any) => r.test.improved === true,
    ).length;
    const testsRetestCorrect = predictionTestRows.filter(
      (r: any) => r.test.retestWasCorrect === true,
    ).length;

    const rawMetrics = {
      sampleSize: total,
      overall: {
        accuracy: Number(accuracy.toFixed(4)),
        avgBrier: avgBrier != null ? Number(avgBrier.toFixed(6)) : null,
      },
      trend: {
        recentHalfSize: recentHalf.length,
        previousHalfSize: previousHalf.length,
        recentAccuracy: Number(recentAccuracy.toFixed(4)),
        previousAccuracy: Number(previousAccuracy.toFixed(4)),
        accuracyDelta: Number((recentAccuracy - previousAccuracy).toFixed(4)),
        recentBrier:
          recentBrier != null ? Number(recentBrier.toFixed(6)) : null,
        previousBrier:
          previousBrier != null ? Number(previousBrier.toFixed(6)) : null,
        brierDelta:
          recentBrier != null && previousBrier != null
            ? Number((recentBrier - previousBrier).toFixed(6))
            : null,
      },
      byType,
      leagueCount: leagueRows.length,
      strongestLeagues,
      weakestLeagues,
      confidenceBuckets: {
        high: {
          ...confidenceBuckets.high,
          accuracy:
            confidenceBuckets.high.total > 0
              ? Number(
                  (
                    confidenceBuckets.high.correct /
                    confidenceBuckets.high.total
                  ).toFixed(4),
                )
              : 0,
        },
        medium: {
          ...confidenceBuckets.medium,
          accuracy:
            confidenceBuckets.medium.total > 0
              ? Number(
                  (
                    confidenceBuckets.medium.correct /
                    confidenceBuckets.medium.total
                  ).toFixed(4),
                )
              : 0,
        },
        low: {
          ...confidenceBuckets.low,
          accuracy:
            confidenceBuckets.low.total > 0
              ? Number(
                  (
                    confidenceBuckets.low.correct / confidenceBuckets.low.total
                  ).toFixed(4),
                )
              : 0,
        },
      },
      predictedOutcomeCounts,
      actualOutcomeCounts,
      retestSummary: {
        total: testsTotal,
        improved: testsImproved,
        improvedRate:
          testsTotal > 0 ? Number((testsImproved / testsTotal).toFixed(4)) : 0,
        retestCorrect: testsRetestCorrect,
        retestCorrectRate:
          testsTotal > 0
            ? Number((testsRetestCorrect / testsTotal).toFixed(4))
            : 0,
      },
    };

    const patterns = await this.generateInsightsWithOpenAI(rawMetrics);

    return {
      generatedAt: new Date().toISOString(),
      model: this.insightsModel,
      filters: {
        predictionType: filters?.predictionType ?? 'all',
        limit,
        minLeagueSample,
      },
      totals: {
        sampleSize: total,
        resolved: total,
        correct,
        accuracy: Number(accuracy.toFixed(4)),
        avgBrier: avgBrier != null ? Number(avgBrier.toFixed(6)) : null,
      },
      rawMetrics,
      patterns,
    };
  }

  /**
   * Get accuracy stats for resolved predictions.
   */
  async getAccuracyStats(): Promise<{
    totalResolved: number;
    correct: number;
    accuracy: number;
    avgBrierScore: number;
    byType: Record<
      string,
      { total: number; correct: number; accuracy: number }
    >;
  }> {
    const resolved = await this.db
      .select()
      .from(schema.predictions)
      .where(sql`${schema.predictions.resolvedAt} IS NOT NULL`);

    const total = resolved.length;
    const correct = resolved.filter((p: any) => p.wasCorrect === true).length;
    const avgBrier =
      total > 0
        ? resolved.reduce(
            (sum: number, p: any) => sum + (Number(p.probabilityAccuracy) || 0),
            0,
          ) / total
        : 0;

    // Group by type
    const byType: Record<
      string,
      { total: number; correct: number; accuracy: number }
    > = {};
    for (const p of resolved) {
      const type = p.predictionType as string;
      if (!byType[type]) byType[type] = { total: 0, correct: 0, accuracy: 0 };
      byType[type].total++;
      if (p.wasCorrect) byType[type].correct++;
    }
    for (const type of Object.keys(byType)) {
      byType[type].accuracy =
        byType[type].total > 0 ? byType[type].correct / byType[type].total : 0;
    }

    return {
      totalResolved: total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      avgBrierScore: Number(avgBrier.toFixed(6)),
      byType,
    };
  }

  /**
   * Get a detailed breakdown of prediction performance for a specific day.
   *
   * Returns:
   * - Summary stats: total, correct, incorrect, pending (unresolved), accuracy
   * - Each prediction with: match info, predicted vs actual result, correctness,
   *   confidence, and a link to the Polymarket game (if one exists)
   */
  async getDailyBreakdown(date?: string): Promise<DailyBreakdown> {
    const dateStr = date ?? new Date().toISOString().split('T')[0];
    return this.computeDailyBreakdown(dateStr);
  }

  /**
   * Return per-day breakdowns plus an aggregated summary across a range.
   * Accepts either `days` (rolling window ending today) or explicit `from`/`to`.
   */
  async getDailyBreakdownRange(opts: {
    days?: number;
    from?: string;
    to?: string;
  }): Promise<DailyBreakdownRange> {
    const today = new Date().toISOString().split('T')[0];

    let fromStr: string;
    let toStr: string;
    if (opts.days != null) {
      const days = Math.max(1, Math.min(90, Math.floor(opts.days)));
      const end = new Date(`${today}T00:00:00Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - (days - 1));
      fromStr = start.toISOString().split('T')[0];
      toStr = today;
    } else {
      fromStr = opts.from ?? opts.to ?? today;
      toStr = opts.to ?? opts.from ?? today;
      if (new Date(fromStr).getTime() > new Date(toStr).getTime()) {
        [fromStr, toStr] = [toStr, fromStr];
      }
    }

    const dateList: string[] = [];
    const cursor = new Date(`${fromStr}T00:00:00Z`);
    const end = new Date(`${toStr}T00:00:00Z`);
    const maxDays = 90;
    while (cursor.getTime() <= end.getTime() && dateList.length < maxDays) {
      dateList.push(cursor.toISOString().split('T')[0]);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const days = await Promise.all(
      dateList.map((d) => this.computeDailyBreakdown(d)),
    );

    // Aggregate summary + byResult across days
    const summary = {
      total: 0,
      resolved: 0,
      correct: 0,
      incorrect: 0,
      pending: 0,
      accuracy: 0,
      avgConfidence: 0,
      avgBrierScore: null as number | null,
    };
    const byResult = {
      home_win: { predicted: 0, correct: 0, accuracy: 0 },
      draw: { predicted: 0, correct: 0, accuracy: 0 },
      away_win: { predicted: 0, correct: 0, accuracy: 0 },
    };

    let confidenceWeighted = 0;
    let confidenceCount = 0;
    let brierWeighted = 0;
    let brierCount = 0;

    for (const day of days) {
      summary.total += day.summary.total;
      summary.resolved += day.summary.resolved;
      summary.correct += day.summary.correct;
      summary.incorrect += day.summary.incorrect;
      summary.pending += day.summary.pending;

      // avgConfidence is rounded per-day but we re-weight by per-day count.
      // The per-day count of non-null confidences is (day.summary.total
      // minus predictions without a confidence) — we don't expose that, so
      // fall back to weighting by total when resolved is zero.
      if (day.summary.avgConfidence > 0) {
        const weight = day.summary.total;
        confidenceWeighted += day.summary.avgConfidence * weight;
        confidenceCount += weight;
      }
      if (day.summary.avgBrierScore != null) {
        brierWeighted += day.summary.avgBrierScore * day.summary.resolved;
        brierCount += day.summary.resolved;
      }

      for (const k of Object.keys(byResult) as Array<keyof typeof byResult>) {
        byResult[k].predicted += day.byResult[k].predicted;
        byResult[k].correct += day.byResult[k].correct;
      }
    }

    summary.accuracy = summary.resolved > 0 ? summary.correct / summary.resolved : 0;
    summary.avgConfidence =
      confidenceCount > 0
        ? Number((confidenceWeighted / confidenceCount).toFixed(1))
        : 0;
    summary.avgBrierScore =
      brierCount > 0 ? Number((brierWeighted / brierCount).toFixed(6)) : null;

    for (const k of Object.keys(byResult) as Array<keyof typeof byResult>) {
      byResult[k].accuracy =
        byResult[k].predicted > 0
          ? byResult[k].correct / byResult[k].predicted
          : 0;
    }

    return {
      range: { from: fromStr, to: toStr, days: dateList.length },
      summary,
      byResult,
      days,
    };
  }

  private async computeDailyBreakdown(dateStr: string): Promise<DailyBreakdown> {
    const startOfDay = new Date(`${dateStr}T00:00:00Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59Z`);

    // Get all predictions for fixtures on this date
    const rows = await this.db
      .select({
        prediction: schema.predictions,
        fixtureId: schema.fixtures.id,
        fixtureDate: schema.fixtures.date,
        fixtureStatus: schema.fixtures.status,
        leagueId: schema.fixtures.leagueId,
        leagueName: schema.fixtures.leagueName,
        leagueCountry: schema.fixtures.leagueCountry,
        homeTeamId: schema.fixtures.homeTeamId,
        awayTeamId: schema.fixtures.awayTeamId,
        goalsHome: schema.fixtures.goalsHome,
        goalsAway: schema.fixtures.goalsAway,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          gte(schema.fixtures.date, startOfDay),
          lte(schema.fixtures.date, endOfDay),
        ),
      )
      .orderBy(asc(schema.fixtures.date), desc(schema.predictions.createdAt));

    // Deduplicate: keep the most recent prediction per fixture. Rows come
    // back ordered by createdAt DESC, so the first row per fixtureId is
    // already the newest — an on_demand rerun supersedes older runs.
    const fixtureMap = new Map<number, (typeof rows)[0]>();
    for (const row of rows) {
      if (!fixtureMap.has(row.fixtureId)) {
        fixtureMap.set(row.fixtureId, row);
      }
    }

    const dedupedRows = Array.from(fixtureMap.values());

    // Batch-fetch team names + logos
    const teamIds = new Set<number>();
    for (const row of dedupedRows) {
      if (row.homeTeamId) teamIds.add(row.homeTeamId);
      if (row.awayTeamId) teamIds.add(row.awayTeamId);
    }

    const teamMap = new Map<number, { name: string; logo: string | null }>();
    if (teamIds.size > 0) {
      const teamRows = await this.db
        .select({
          id: schema.teams.id,
          name: schema.teams.name,
          logo: schema.teams.logo,
        })
        .from(schema.teams)
        .where(
          sql`${schema.teams.id} IN (${sql.join(
            [...teamIds].map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      for (const t of teamRows) {
        teamMap.set(t.id, { name: t.name, logo: t.logo });
      }
    }

    // Batch-fetch Polymarket market links for these fixtures
    const fixtureIds = dedupedRows.map((r) => r.fixtureId);
    const polymarketMap = new Map<number, string>();
    if (fixtureIds.length > 0) {
      const marketRows = await this.db
        .select({
          fixtureId: schema.polymarketMarkets.fixtureId,
          eventSlug: schema.polymarketMarkets.eventSlug,
          slug: schema.polymarketMarkets.slug,
        })
        .from(schema.polymarketMarkets)
        .where(
          and(
            sql`${schema.polymarketMarkets.fixtureId} IN (${sql.join(
              fixtureIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            eq(schema.polymarketMarkets.marketType, 'match_outcome'),
          ),
        );

      for (const m of marketRows) {
        if (m.fixtureId && (m.eventSlug || m.slug)) {
          const slug = m.eventSlug || m.slug;
          polymarketMap.set(
            m.fixtureId,
            `https://polymarket.com/event/${slug}`,
          );
        }
      }
    }

    // Build per-prediction results and compute summary
    let totalResolved = 0;
    let totalCorrect = 0;
    let totalIncorrect = 0;
    let totalPending = 0;
    let totalConfidence = 0;
    let confidenceCount = 0;
    let brierSum = 0;
    let brierCount = 0;

    const byResult = {
      home_win: { predicted: 0, correct: 0, accuracy: 0 },
      draw: { predicted: 0, correct: 0, accuracy: 0 },
      away_win: { predicted: 0, correct: 0, accuracy: 0 },
    };

    const predictionDetails = dedupedRows.map((row) => {
      const p = row.prediction;
      const homeProb = Number(p.homeWinProb);
      const drawProb = Number(p.drawProb);
      const awayProb = Number(p.awayWinProb);
      const predictedResult = this.getPredictedResultFromProbs(
        homeProb,
        drawProb,
        awayProb,
      );

      // Track predicted outcomes
      if (
        predictedResult === 'home_win' ||
        predictedResult === 'draw' ||
        predictedResult === 'away_win'
      ) {
        byResult[predictedResult].predicted++;
      }

      if (p.resolvedAt) {
        totalResolved++;
        if (p.wasCorrect === true) {
          totalCorrect++;
          if (
            predictedResult === 'home_win' ||
            predictedResult === 'draw' ||
            predictedResult === 'away_win'
          ) {
            byResult[predictedResult].correct++;
          }
        } else if (p.wasCorrect === false) {
          totalIncorrect++;
        }
      } else {
        totalPending++;
      }

      if (p.confidence != null) {
        totalConfidence += p.confidence;
        confidenceCount++;
      }

      const brier = p.probabilityAccuracy
        ? Number(p.probabilityAccuracy)
        : null;
      if (brier != null) {
        brierSum += brier;
        brierCount++;
      }

      const homeTeam = teamMap.get(row.homeTeamId) ?? {
        name: null,
        logo: null,
      };
      const awayTeam = teamMap.get(row.awayTeamId) ?? {
        name: null,
        logo: null,
      };

      return {
        predictionId: p.id,
        fixtureId: row.fixtureId,
        matchDate: row.fixtureDate,
        matchStatus: row.fixtureStatus,
        league: {
          id: row.leagueId,
          name: row.leagueName,
          country: row.leagueCountry,
        },
        homeTeam: { id: row.homeTeamId, ...homeTeam },
        awayTeam: { id: row.awayTeamId, ...awayTeam },
        predicted: {
          result: predictedResult,
          homeWinProb: homeProb,
          drawProb,
          awayWinProb: awayProb,
          homeGoals: p.predictedHomeGoals ? Number(p.predictedHomeGoals) : null,
          awayGoals: p.predictedAwayGoals ? Number(p.predictedAwayGoals) : null,
          confidence: p.confidence,
        },
        actual: {
          result: p.actualResult ?? null,
          homeGoals: p.actualHomeGoals ?? null,
          awayGoals: p.actualAwayGoals ?? null,
        },
        wasCorrect: p.wasCorrect ?? null,
        brierScore: brier,
        predictionType: p.predictionType,
        polymarketLink: polymarketMap.get(row.fixtureId) ?? null,
        createdAt: p.createdAt,
      };
    });

    // Compute by-result accuracies
    for (const key of Object.keys(byResult) as Array<keyof typeof byResult>) {
      byResult[key].accuracy =
        byResult[key].predicted > 0
          ? byResult[key].correct / byResult[key].predicted
          : 0;
    }

    return {
      date: dateStr,
      summary: {
        total: dedupedRows.length,
        resolved: totalResolved,
        correct: totalCorrect,
        incorrect: totalIncorrect,
        pending: totalPending,
        accuracy: totalResolved > 0 ? totalCorrect / totalResolved : 0,
        avgConfidence:
          confidenceCount > 0
            ? Number((totalConfidence / confidenceCount).toFixed(1))
            : 0,
        avgBrierScore:
          brierCount > 0 ? Number((brierSum / brierCount).toFixed(6)) : null,
      },
      byResult,
      predictions: predictionDetails,
    };
  }

  /**
   * Generate performance feedback from historical predictions to inform future predictions.
   * This creates a self-improving feedback loop by identifying systematic biases.
   */
  async getPerformanceFeedback(): Promise<PerformanceFeedback | null> {
    try {
      const resolved = await this.db
        .select({
          prediction: schema.predictions,
          fixture: schema.fixtures,
        })
        .from(schema.predictions)
        .innerJoin(
          schema.fixtures,
          eq(schema.predictions.fixtureId, schema.fixtures.id),
        )
        .where(sql`${schema.predictions.resolvedAt} IS NOT NULL`)
        .orderBy(desc(schema.predictions.resolvedAt))
        .limit(500); // Last 500 resolved predictions for better statistical reliability

      if (resolved.length < 5) {
        // Not enough data for meaningful feedback
        return null;
      }

      const total = resolved.length;
      const correct = resolved.filter(
        (r: any) => r.prediction.wasCorrect === true,
      ).length;
      const avgBrier =
        resolved.reduce(
          (sum: number, r: any) =>
            sum + (Number(r.prediction.probabilityAccuracy) || 0),
          0,
        ) / total;

      // Track what we predicted vs what actually happened
      const byResult = {
        home_win: { predicted: 0, correct: 0, accuracy: 0 },
        draw: { predicted: 0, correct: 0, accuracy: 0 },
        away_win: { predicted: 0, correct: 0, accuracy: 0 },
      };

      const actualCounts = { home_win: 0, draw: 0, away_win: 0 };
      let totalHomeProb = 0;
      let totalDrawProb = 0;
      let totalAwayProb = 0;

      // Confidence calibration buckets
      const confidenceBuckets = {
        high: { total: 0, correct: 0 }, // confidence 8-10
        med: { total: 0, correct: 0 }, // confidence 5-7
        low: { total: 0, correct: 0 }, // confidence 1-4
      };

      // League breakdown
      const leagueMap: Record<string, { total: number; correct: number }> = {};

      for (const { prediction, fixture } of resolved) {
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        totalHomeProb += homeProb;
        totalDrawProb += drawProb;
        totalAwayProb += awayProb;

        // Determine predicted result
        const predictedResult = this.getPredictedResultFromProbs(
          homeProb,
          drawProb,
          awayProb,
        );

        // Track predicted outcomes
        if (
          predictedResult === 'home_win' ||
          predictedResult === 'draw' ||
          predictedResult === 'away_win'
        ) {
          byResult[predictedResult].predicted++;
          if (prediction.wasCorrect) byResult[predictedResult].correct++;
        }

        // Track actual outcomes
        const actual = prediction.actualResult as string;
        if (
          actual === 'home_win' ||
          actual === 'draw' ||
          actual === 'away_win'
        ) {
          actualCounts[actual]++;
        }

        // Confidence calibration
        const conf = prediction.confidence ?? 5;
        if (conf >= 8) {
          confidenceBuckets.high.total++;
          if (prediction.wasCorrect) confidenceBuckets.high.correct++;
        } else if (conf >= 5) {
          confidenceBuckets.med.total++;
          if (prediction.wasCorrect) confidenceBuckets.med.correct++;
        } else {
          confidenceBuckets.low.total++;
          if (prediction.wasCorrect) confidenceBuckets.low.correct++;
        }

        // League breakdown
        const leagueName = fixture.leagueName ?? `League ${fixture.leagueId}`;
        if (!leagueMap[leagueName]) {
          leagueMap[leagueName] = { total: 0, correct: 0 };
        }
        leagueMap[leagueName].total++;
        if (prediction.wasCorrect) leagueMap[leagueName].correct++;
      }

      // Compute accuracies
      for (const key of Object.keys(byResult) as Array<keyof typeof byResult>) {
        byResult[key].accuracy =
          byResult[key].predicted > 0
            ? byResult[key].correct / byResult[key].predicted
            : 0;
      }

      // Generate bias insights
      const biasInsights: string[] = [];
      const avgHomeProb = totalHomeProb / total;
      const avgDrawProb = totalDrawProb / total;
      const avgAwayProb = totalAwayProb / total;
      const actualHomePct = actualCounts.home_win / total;
      const actualDrawPct = actualCounts.draw / total;
      const actualAwayPct = actualCounts.away_win / total;

      // Check for systematic probability miscalibration
      // Use tighter thresholds (3% instead of 5%) to catch biases earlier
      if (avgDrawProb < actualDrawPct - 0.03) {
        biasInsights.push(
          `CRITICAL: You have been UNDERESTIMATING draw probability. Your average draw prob is ${(avgDrawProb * 100).toFixed(1)}% but draws actually occur ${(actualDrawPct * 100).toFixed(1)}% of the time. Increase draw probability by at least ${((actualDrawPct - avgDrawProb) * 100).toFixed(1)} percentage points.`,
        );
      }
      if (avgDrawProb > actualDrawPct + 0.03) {
        biasInsights.push(
          `You have been OVERESTIMATING draw probability. Your average is ${(avgDrawProb * 100).toFixed(1)}% but draws actually occur ${(actualDrawPct * 100).toFixed(1)}% of the time.`,
        );
      }
      if (avgHomeProb > actualHomePct + 0.03) {
        biasInsights.push(
          `CRITICAL: You have been OVERESTIMATING home win probability. Your average is ${(avgHomeProb * 100).toFixed(1)}% but home wins occur ${(actualHomePct * 100).toFixed(1)}% of the time. Reduce home win probability by at least ${((avgHomeProb - actualHomePct) * 100).toFixed(1)} percentage points.`,
        );
      }
      if (avgHomeProb < actualHomePct - 0.03) {
        biasInsights.push(
          `You have been UNDERESTIMATING home win probability. Your average is ${(avgHomeProb * 100).toFixed(1)}% but home wins occur ${(actualHomePct * 100).toFixed(1)}% of the time.`,
        );
      }
      if (avgAwayProb > actualAwayPct + 0.03) {
        biasInsights.push(
          `You have been OVERESTIMATING away win probability. Your average is ${(avgAwayProb * 100).toFixed(1)}% but away wins occur ${(actualAwayPct * 100).toFixed(1)}% of the time. Reduce away win probability by at least ${((avgAwayProb - actualAwayPct) * 100).toFixed(1)} percentage points.`,
        );
      }
      if (avgAwayProb < actualAwayPct - 0.03) {
        biasInsights.push(
          `You have been UNDERESTIMATING away win probability. Your average is ${(avgAwayProb * 100).toFixed(1)}% but away wins occur ${(actualAwayPct * 100).toFixed(1)}% of the time.`,
        );
      }

      // Check for draw prediction rate (separate from probability)
      const drawPredRate =
        byResult.draw.predicted > 0 ? byResult.draw.predicted / total : 0;
      if (drawPredRate < 0.15) {
        biasInsights.push(
          `CRITICAL: You are only predicting draws ${(drawPredRate * 100).toFixed(1)}% of the time, but draws occur ${(actualDrawPct * 100).toFixed(1)}% of the time. You are missing ~${((actualDrawPct - drawPredRate) * total).toFixed(0)} draw outcomes. Increase draw predictions significantly.`,
        );
      }

      // Check for overconfident favorite predictions
      const homeWinAcc =
        byResult.home_win.predicted > 0
          ? byResult.home_win.correct / byResult.home_win.predicted
          : 0;
      const awayWinAcc =
        byResult.away_win.predicted > 0
          ? byResult.away_win.correct / byResult.away_win.predicted
          : 0;
      if (homeWinAcc < 0.45 && byResult.home_win.predicted > 10) {
        biasInsights.push(
          `Your home win predictions are only ${(homeWinAcc * 100).toFixed(1)}% accurate. You are predicting too many home wins. Be more conservative — consider draw predictions for close matches.`,
        );
      }
      if (awayWinAcc < 0.35 && byResult.away_win.predicted > 10) {
        biasInsights.push(
          `Your away win predictions are only ${(awayWinAcc * 100).toFixed(1)}% accurate. You are predicting too many away wins. Consider draws more often.`,
        );
      }

      // Check confidence calibration
      const highAcc =
        confidenceBuckets.high.total > 0
          ? confidenceBuckets.high.correct / confidenceBuckets.high.total
          : 0;
      const medAcc =
        confidenceBuckets.med.total > 0
          ? confidenceBuckets.med.correct / confidenceBuckets.med.total
          : 0;
      const lowAcc =
        confidenceBuckets.low.total > 0
          ? confidenceBuckets.low.correct / confidenceBuckets.low.total
          : 0;

      if (confidenceBuckets.high.total > 3 && highAcc < 0.55) {
        biasInsights.push(
          `CRITICAL: High-confidence predictions (8-10) are only ${(highAcc * 100).toFixed(1)}% accurate (${confidenceBuckets.high.correct}/${confidenceBuckets.high.total}). You are SEVERELY OVERCONFIDENT. Reserve high confidence for genuinely clear-cut matches only.`,
        );
      }
      if (confidenceBuckets.high.total > 3 && highAcc < 0.7) {
        biasInsights.push(
          `High-confidence predictions (8-10) are ${(highAcc * 100).toFixed(1)}% accurate. For confidence 8-10 to be meaningful, accuracy should be >70%. Lower your confidence scores.`,
        );
      }
      if (confidenceBuckets.low.total > 3 && lowAcc > medAcc) {
        biasInsights.push(
          `Low-confidence predictions (${(lowAcc * 100).toFixed(1)}%) are more accurate than medium-confidence ones (${(medAcc * 100).toFixed(1)}%). Your confidence scoring is inverted — recalibrate.`,
        );
      }

      // Overall accuracy warning
      const overallAcc = correct / total;
      if (overallAcc < 0.4) {
        biasInsights.push(
          `CRITICAL: Overall accuracy is only ${(overallAcc * 100).toFixed(1)}%. This is BELOW RANDOM for 3-way prediction (~33%). Your model has systematic biases. Focus on: (1) predicting more draws, (2) being less confident in favorites, (3) using base rates as anchors.`,
        );
      } else if (overallAcc < 0.5) {
        biasInsights.push(
          `Overall accuracy is ${(overallAcc * 100).toFixed(1)}%. Target is >50%. Focus on improving draw detection and reducing overconfidence in favorites.`,
        );
      }

      // Find worst-performing leagues
      const leagueBreakdown: Record<
        string,
        { total: number; correct: number; accuracy: number }
      > = {};
      for (const [name, data] of Object.entries(leagueMap)) {
        const acc = data.total > 0 ? data.correct / data.total : 0;
        leagueBreakdown[name] = { ...data, accuracy: acc };
        if (data.total >= 3 && acc < 0.35) {
          biasInsights.push(
            `POOR performance in ${name}: ${(acc * 100).toFixed(1)}% accuracy over ${data.total} predictions. This league may have different dynamics (different draw rates, home advantage, etc.). Adjust your priors.`,
          );
        }
      }

      return {
        totalResolved: total,
        overallAccuracy: correct / total,
        avgBrierScore: Number(avgBrier.toFixed(6)),
        byResult,
        avgProbabilities: {
          homeWinProb: Number(avgHomeProb.toFixed(4)),
          drawProb: Number(avgDrawProb.toFixed(4)),
          awayWinProb: Number(avgAwayProb.toFixed(4)),
        },
        actualDistribution: {
          homeWinPct: Number(actualHomePct.toFixed(4)),
          drawPct: Number(actualDrawPct.toFixed(4)),
          awayWinPct: Number(actualAwayPct.toFixed(4)),
        },
        biasInsights,
        confidenceCalibration: {
          highConfidence: {
            total: confidenceBuckets.high.total,
            correct: confidenceBuckets.high.correct,
            accuracy: highAcc,
          },
          medConfidence: {
            total: confidenceBuckets.med.total,
            correct: confidenceBuckets.med.correct,
            accuracy: medAcc,
          },
          lowConfidence: {
            total: confidenceBuckets.low.total,
            correct: confidenceBuckets.low.correct,
            accuracy: lowAcc,
          },
        },
        leagueBreakdown,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to compute performance feedback: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get the predictions the model is most bullish on.
   *
   * "Bullish" = high confidence + a strongly dominant outcome probability.
   * Sorted by a composite bullish score that combines:
   *   - Confidence (1-10 scale)
   *   - Dominant probability (how lopsided the prediction is)
   *   - Value edge vs bookmaker odds (if available)
   *
   * Only returns unresolved predictions for upcoming matches.
   */
  async getBullishPredictions(options?: {
    limit?: number;
    minConfidence?: number;
    minDominantProb?: number;
  }): Promise<any[]> {
    const limit = options?.limit ?? 10;
    const minConfidence = options?.minConfidence ?? 6;
    const minDominantProb = options?.minDominantProb ?? 0.45;

    // Get unresolved predictions for upcoming fixtures with high confidence
    const rows = await this.db
      .select({
        prediction: schema.predictions,
        fixture: schema.fixtures,
      })
      .from(schema.predictions)
      .innerJoin(
        schema.fixtures,
        eq(schema.predictions.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          isNull(schema.predictions.resolvedAt),
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, new Date()),
          gte(schema.predictions.confidence, minConfidence),
        ),
      )
      .orderBy(desc(schema.predictions.confidence), asc(schema.fixtures.date));

    if (rows.length === 0) return [];

    // Score and rank each prediction by "bullishness"
    const scored = rows
      .map(({ prediction, fixture }: any) => {
        const homeProb = Number(prediction.homeWinProb);
        const drawProb = Number(prediction.drawProb);
        const awayProb = Number(prediction.awayWinProb);
        const confidence = prediction.confidence ?? 5;

        // Dominant probability — the highest of the three outcomes
        const dominantProb = Math.max(homeProb, drawProb, awayProb);

        // Skip if dominant probability is too low (close match)
        if (dominantProb < minDominantProb) return null;

        // Determine the predicted outcome
        let predictedOutcome: string;
        if (homeProb >= drawProb && homeProb >= awayProb)
          predictedOutcome = 'Home Win';
        else if (awayProb >= homeProb && awayProb >= drawProb)
          predictedOutcome = 'Away Win';
        else predictedOutcome = 'Draw';

        // Value edge from value bets (if available)
        const valueBets = (prediction.valueBets as any[]) ?? [];
        const maxEdge =
          valueBets.length > 0
            ? Math.max(
                ...valueBets.map((vb: any) => Number(vb.edgePercent) || 0),
              )
            : 0;

        // Composite bullish score (0-100):
        // - Confidence contributes 40% (scaled from 1-10 to 0-40)
        // - Dominant probability contributes 40% (scaled from 0.33-1.0 to 0-40)
        // - Value edge contributes 20% (capped at 20% edge = 20 points)
        const confidenceScore = (confidence / 10) * 40;
        const probScore = ((dominantProb - 0.33) / 0.67) * 40;
        const edgeScore = Math.min(20, maxEdge);
        const bullishScore = Number(
          (confidenceScore + probScore + edgeScore).toFixed(1),
        );

        return {
          predictionId: prediction.id,
          fixtureId: prediction.fixtureId,
          homeTeamId: prediction.homeTeamId,
          awayTeamId: prediction.awayTeamId,
          predictedOutcome,
          dominantProb: Number(dominantProb.toFixed(4)),
          homeWinProb: homeProb,
          drawProb,
          awayWinProb: awayProb,
          predictedHomeGoals: prediction.predictedHomeGoals,
          predictedAwayGoals: prediction.predictedAwayGoals,
          confidence,
          bullishScore,
          keyFactors: prediction.keyFactors,
          riskFactors: prediction.riskFactors,
          valueBets: prediction.valueBets,
          detailedAnalysis: prediction.detailedAnalysis,
          matchInsights: prediction.matchInsights,
          predictionType: prediction.predictionType,
          fixture: {
            id: fixture.id,
            date: fixture.date,
            status: fixture.status,
            round: fixture.round,
            leagueId: fixture.leagueId,
            leagueName: fixture.leagueName,
            leagueCountry: fixture.leagueCountry,
            venueName: fixture.venueName,
          },
          createdAt: prediction.createdAt,
        };
      })
      .filter(Boolean);

    // Sort by bullish score descending
    scored.sort((a: any, b: any) => b.bullishScore - a.bullishScore);

    // Take top N
    const topPicks = scored.slice(0, limit);

    // Enrich with team names, lineups, and injuries
    const teamIds = new Set<number>();
    const fixtureIds: number[] = [];
    for (const p of topPicks) {
      if (p.homeTeamId) teamIds.add(p.homeTeamId);
      if (p.awayTeamId) teamIds.add(p.awayTeamId);
      fixtureIds.push(p.fixtureId);
    }

    const [teamRows, lineupsAndInjuries] = await Promise.all([
      teamIds.size > 0
        ? this.db
            .select({
              id: schema.teams.id,
              name: schema.teams.name,
              logo: schema.teams.logo,
            })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                [...teamIds].map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [],
      this.footballService.getLineupsAndInjuriesForFixtures(fixtureIds),
    ]);

    const teamMap = new Map<number, { name: string; logo: string | null }>();
    for (const t of teamRows) {
      teamMap.set(t.id, { name: t.name, logo: t.logo });
    }

    return topPicks.map((p: any) => {
      const homeTeam = teamMap.get(p.homeTeamId);
      const awayTeam = teamMap.get(p.awayTeamId);
      const fixtureLineups =
        lineupsAndInjuries.lineupsByFixture.get(p.fixtureId) ?? null;
      const homeInjuries =
        lineupsAndInjuries.injuriesByTeam.get(p.homeTeamId) ?? [];
      const awayInjuries =
        lineupsAndInjuries.injuriesByTeam.get(p.awayTeamId) ?? [];

      return {
        ...p,
        homeTeam: {
          id: p.homeTeamId,
          name: homeTeam?.name ?? null,
          logo: homeTeam?.logo ?? null,
          injuries: homeInjuries,
        },
        awayTeam: {
          id: p.awayTeamId,
          name: awayTeam?.name ?? null,
          logo: awayTeam?.logo ?? null,
          injuries: awayInjuries,
        },
        lineups: fixtureLineups,
      };
    });
  }

  // ─── Pre-prediction data freshening ──────────────────────────────────

  /**
   * Ensure all data sources are fresh before generating a prediction.
   * Fetches injuries, lineups, standings, and odds from external APIs
   * and persists them to the database so the DataCollector reads fresh data.
   *
   * Each fetch is best-effort — failures are logged but don't block the prediction.
   */
  /**
   * Track when each league was last freshened to avoid redundant API calls.
   * Key = leagueId, Value = timestamp of last sync.
   */
  private lastFreshened = new Map<number, number>();
  private static readonly FRESHEN_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  private async freshenDataForFixture(fixtureId: number): Promise<void> {
    // Get the fixture to know the league
    const fixtureRows = await this.db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, fixtureId))
      .limit(1);

    const fixture = fixtureRows?.[0];
    if (!fixture) {
      this.logger.warn(
        `Fixture ${fixtureId} not found, skipping data freshening`,
      );
      return;
    }

    const leagueId = fixture.leagueId;
    const now = Date.now();

    // Skip heavy syncs (injuries, standings) if this league was freshened recently
    const lastTime = this.lastFreshened.get(leagueId) ?? 0;
    const needsLeagueSync = now - lastTime > AgentsService.FRESHEN_COOLDOWN_MS;

    const freshenStart = now;
    const tasks: Promise<{ type: string; count: number }>[] = [];

    // Always fetch lineups — lightweight, fixture-specific, and critical
    tasks.push(
      this.footballService
        .fetchAndPersistLineups(fixtureId)
        .then((count) => ({ type: 'lineups', count }))
        .catch(() => ({ type: 'lineups', count: 0 })),
    );

    // Always freshen each team's recent results straight from API-Football
    // (one cheap /fixtures?team=&last call per team, upserted to the DB). This
    // keeps form windows + recent-game history current regardless of sync
    // gaps — the root fix for stale last-5/last-10 data.
    tasks.push(
      this.footballService
        .getTeamRecentFixtures(fixture.homeTeamId)
        .then((count) => ({ type: 'homeRecent', count }))
        .catch(() => ({ type: 'homeRecent', count: 0 })),
    );
    tasks.push(
      this.footballService
        .getTeamRecentFixtures(fixture.awayTeamId)
        .then((count) => ({ type: 'awayRecent', count }))
        .catch(() => ({ type: 'awayRecent', count: 0 })),
    );

    // Always freshen this fixture's injuries (one cheap /injuries?fixture call,
    // both teams) so absences are current — not gated by the league cooldown.
    tasks.push(
      this.footballService
        .syncInjuriesForFixture(fixtureId)
        .then((count) => ({ type: 'fixtureInjuries', count }))
        .catch(() => ({ type: 'fixtureInjuries', count: 0 })),
    );

    // Only sync injuries and standings if not recently done for this league
    if (needsLeagueSync) {
      this.logger.log(
        `Freshening injuries + standings for league ${leagueId} (fixture ${fixtureId})`,
      );
      tasks.push(
        this.footballService
          .syncInjuries(leagueId)
          .then((count) => ({ type: 'injuries', count }))
          .catch(() => ({ type: 'injuries', count: 0 })),
      );
      tasks.push(
        this.footballService
          .syncStandings(leagueId)
          .then((count) => ({ type: 'standings', count }))
          .catch(() => ({ type: 'standings', count: 0 })),
      );
    }

    // Odds sync is too heavy to run per-prediction — handled by the 6-hourly cron.
    // No odds sync here.

    const results = await Promise.all(tasks);

    if (needsLeagueSync) {
      this.lastFreshened.set(leagueId, Date.now());
    }

    const duration = Date.now() - freshenStart;
    const summary = results
      .filter((r) => r.count > 0)
      .map((r) => `${r.type}=${r.count}`)
      .join(', ');

    this.logger.log(
      `Data freshened for fixture ${fixtureId} in ${duration}ms` +
        (summary ? `: ${summary}` : ' (all cached)'),
    );
  }

  // ─── Supermemory helpers ─────────────────────────────────────────────

  /**
   * Store a resolved prediction as a Supermemory memory.
   * Fetches team names for readable memory content.
   */
  private async storeResolutionMemory(
    prediction: any,
    fixture: any,
    resolution: {
      predictedResult: string;
      actualResult: string;
      wasCorrect: boolean;
      brierScore: number;
      homeProb: number;
      drawProb: number;
      awayProb: number;
    },
  ): Promise<void> {
    // Fetch team names
    const teamIds = [fixture.homeTeamId, fixture.awayTeamId].filter(Boolean);
    const teamRows =
      teamIds.length > 0
        ? await this.db
            .select({ id: schema.teams.id, name: schema.teams.name })
            .from(schema.teams)
            .where(
              sql`${schema.teams.id} IN (${sql.join(
                teamIds.map((id: number) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [];

    const teamMap = new Map<number, string>();
    for (const t of teamRows) {
      teamMap.set(t.id, t.name);
    }

    await this.predictionMemory.storeResolvedPrediction({
      predictionId: prediction.id,
      fixtureId: prediction.fixtureId,
      homeTeamName:
        teamMap.get(fixture.homeTeamId) ?? `Team ${fixture.homeTeamId}`,
      awayTeamName:
        teamMap.get(fixture.awayTeamId) ?? `Team ${fixture.awayTeamId}`,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      leagueId: fixture.leagueId,
      leagueName: fixture.leagueName ?? `League ${fixture.leagueId}`,
      round: fixture.round,
      matchDate: fixture.date,
      predictedResult: resolution.predictedResult,
      actualResult: resolution.actualResult,
      wasCorrect: resolution.wasCorrect,
      homeWinProb: resolution.homeProb,
      drawProb: resolution.drawProb,
      awayWinProb: resolution.awayProb,
      predictedHomeGoals: Number(prediction.predictedHomeGoals),
      predictedAwayGoals: Number(prediction.predictedAwayGoals),
      actualHomeGoals: fixture.goalsHome,
      actualAwayGoals: fixture.goalsAway,
      confidence: prediction.confidence ?? 5,
      brierScore: resolution.brierScore,
      keyFactors: prediction.keyFactors,
      riskFactors: prediction.riskFactors,
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Ensemble Claude's prediction with Poisson model and the sharpest
   * available book (Pinnacle close → consensus close fallback).
   *
   * KEY INSIGHT: Bookmaker closing odds are well-calibrated for probabilities,
   * but they're not optimised for 1X2 prediction accuracy. Their draw
   * probabilities are often accurate but always "second place" to a win
   * outcome — so a pure bookmaker-weighted model structurally under-predicts
   * draws.
   *
   * Book selection (preferred → fallback):
   * 1. Pinnacle close (from consensus_odds.pinnacleHomeWin/Draw/Away) — the
   *    sharpest widely-available book. Empirically the hardest single
   *    forecast to beat. Used when present and sanity-passes the sum ≈ 1.0
   *    check.
   * 2. Multi-book consensus close — used when Pinnacle is missing for the
   *    fixture (about 3% of events, mostly small leagues).
   *
   * Weights (when all three signals available):
   * - Bookmaker: 40% — best-calibrated signal but reduced to prevent the
   *   system from just echoing the market favourite
   * - Poisson:   30% — mathematical, xG-based, independent from market
   * - Claude:    30% — contextual reasoning (injuries, motivation, tactical
   *   matchups, form) that bookmakers price in slowly
   *
   * If any signal is unavailable, weights are redistributed proportionally.
   */
  private async ensemblePredictions(
    claudePrediction: PredictionOutput,
    poissonOutput: PoissonModelOutput | null,
    matchData: CollectedMatchData,
  ): Promise<PredictionOutput> {
    // Rebalanced weights v2: less bookmaker dominance, more contextual analysis
    const baseBookmakerWeight = 0.4;
    const basePoissonWeight = 0.3;
    const baseClaudeWeight = 0.3;

    // Pinnacle close (preferred) → consensus close (fallback) → null.
    // Computed once in generatePrediction and attached to matchData.
    const closingLineSignal: ClosingLineSignal | null =
      matchData.closingLineSignal ?? null;
    const selected = this.closingLineService.selectBlendProbs(closingLineSignal);
    let bookmakerProbs: {
      home: number;
      draw: number;
      away: number;
    } | null = selected
      ? { home: selected.home, draw: selected.draw, away: selected.away }
      : null;

    // ── Meta-blender path ───────────────────────────────────────────
    // When learned weights exist, the meta-blender produces the four-
    // predictor log-pool. We substitute its output for the legacy
    // claude-weight*claudeProb + poisson-weight*poissonProb + ... blend
    // and let the existing draw-floor + dampening + confidence post-
    // processing run on top.
    const piPred = matchData.piRatingPrediction ?? null;
    const piProbsForBlend = piPred
      ? {
          home: piPred.homeWinProb,
          draw: piPred.drawProb,
          away: piPred.awayWinProb,
        }
      : null;
    const blendInputs: MetaBlendInputs = {
      claudeProbs: {
        home: claudePrediction.homeWinProb,
        draw: claudePrediction.drawProb,
        away: claudePrediction.awayWinProb,
      },
      poissonProbs:
        poissonOutput && poissonOutput.dataPoints >= 6
          ? {
              home: poissonOutput.homeWinProb,
              draw: poissonOutput.drawProb,
              away: poissonOutput.awayWinProb,
            }
          : null,
      bookmakerProbs,
      piRatingProbs: piProbsForBlend,
    };
    let metaBlenderProbs: { home: number; draw: number; away: number } | null =
      null;
    let metaBlenderLog: string | null = null;
    try {
      const metaResult = await this.metaBlenderService.blend(
        blendInputs,
        matchData.fixture?.leagueId ?? -1,
      );
      if (metaResult?.applied && metaResult.params) {
        metaBlenderProbs = metaResult.blended;
        const ws = metaResult.params.weights
          .map(
            (w, i) =>
              `${metaResult.params!.predictorOrder[i]}=${w.toFixed(2)}`,
          )
          .join(' ');
        metaBlenderLog =
          `Meta-blender (${metaResult.scope}) [${ws}]: ` +
          `H=${(metaResult.blended.home * 100).toFixed(1)}% ` +
          `D=${(metaResult.blended.draw * 100).toFixed(1)}% ` +
          `A=${(metaResult.blended.away * 100).toFixed(1)}%`;
      }
    } catch (error) {
      this.logger.warn(
        `Meta-blender failed, falling back to flat blend: ${(error as Error).message}`,
      );
    }

    // Legacy fallback path: if the closing-line service returned nothing
    // (e.g. odds rows present but malformed in a way the new validator
    // rejects), try the original inline extraction so we don't regress
    // versus the previous behaviour.
    if (!bookmakerProbs) {
      const h2hConsensus = matchData.odds?.consensus?.find(
        (c: any) => c.marketKey === 'h2h',
      );
      if (h2hConsensus) {
        const bHome = Number(h2hConsensus.consensusHomeWin) || 0;
        const bDraw = Number(h2hConsensus.consensusDraw) || 0;
        const bAway = Number(h2hConsensus.consensusAwayWin) || 0;
        const bTotal = bHome + bDraw + bAway;
        if (bTotal > 0.9 && bTotal < 1.1) {
          bookmakerProbs = {
            home: bHome / bTotal,
            draw: bDraw / bTotal,
            away: bAway / bTotal,
          };
        }
      }
    }

    if (closingLineSignal) {
      this.logger.log(
        `Ensemble book source: ${closingLineSignal.sourceUsed}` +
          (closingLineSignal.driftSampleSize >= 2
            ? `, Pinnacle open→close drift mag=${closingLineSignal.driftMagnitude.toFixed(3)}`
            : ''),
      );
    }

    // Determine available signals and redistribute weights
    const hasPoissonData =
      poissonOutput != null &&
      poissonOutput.dataPoints >= 6 &&
      poissonOutput.confidence > 0;
    const hasBookmakerData = bookmakerProbs != null;

    let claudeWeight: number;
    let poissonWeight: number;
    let bookmakerWeight: number;

    if (hasPoissonData && hasBookmakerData) {
      // All three signals available — use evidence-based weights
      // Scale Poisson weight by its confidence, but use a floor so it always
      // contributes meaningfully (minimum 50% of its base weight)
      const poissonConfMultiplier = Math.max(
        0.5,
        Math.min(1.0, poissonOutput!.confidence * 1.5),
      );
      claudeWeight = baseClaudeWeight;
      poissonWeight = basePoissonWeight * poissonConfMultiplier;
      bookmakerWeight = baseBookmakerWeight;
    } else if (hasPoissonData && !hasBookmakerData) {
      // No bookmaker data — Poisson takes the lead, Claude secondary
      const poissonConfMultiplier = Math.max(
        0.5,
        Math.min(1.0, poissonOutput!.confidence * 1.5),
      );
      claudeWeight = 0.35;
      poissonWeight = 0.65 * poissonConfMultiplier;
      bookmakerWeight = 0;
    } else if (!hasPoissonData && hasBookmakerData) {
      // No Poisson data — avoid fully shadowing Claude with market priors.
      // Heavy bookmaker dominance tended to over-pick favourites and suppress draws.
      claudeWeight = 0.45;
      poissonWeight = 0;
      bookmakerWeight = 0.55;
    } else {
      // Only Claude available — worst case, use historical calibration adjustment
      claudeWeight = 1.0;
      poissonWeight = 0;
      bookmakerWeight = 0;
    }

    // Normalize weights to sum to 1.0
    const totalWeight = claudeWeight + poissonWeight + bookmakerWeight;
    claudeWeight /= totalWeight;
    poissonWeight /= totalWeight;
    bookmakerWeight /= totalWeight;

    // Blend probabilities — prefer meta-blender output when fitted,
    // otherwise the legacy flat-weighted average.
    let homeWinProb: number;
    let drawProb: number;
    let awayWinProb: number;
    if (metaBlenderProbs) {
      homeWinProb = metaBlenderProbs.home;
      drawProb = metaBlenderProbs.draw;
      awayWinProb = metaBlenderProbs.away;
      if (metaBlenderLog) this.logger.log(metaBlenderLog);
    } else {
      homeWinProb =
        claudeWeight * claudePrediction.homeWinProb +
        (hasPoissonData ? poissonWeight * poissonOutput!.homeWinProb : 0) +
        (hasBookmakerData ? bookmakerWeight * bookmakerProbs!.home : 0);
      drawProb =
        claudeWeight * claudePrediction.drawProb +
        (hasPoissonData ? poissonWeight * poissonOutput!.drawProb : 0) +
        (hasBookmakerData ? bookmakerWeight * bookmakerProbs!.draw : 0);
      awayWinProb =
        claudeWeight * claudePrediction.awayWinProb +
        (hasPoissonData ? poissonWeight * poissonOutput!.awayWinProb : 0) +
        (hasBookmakerData ? bookmakerWeight * bookmakerProbs!.away : 0);
    }

    // Normalize
    let total = homeWinProb + drawProb + awayWinProb;
    homeWinProb /= total;
    drawProb /= total;
    awayWinProb /= total;

    // ── Post-ensemble calibration: draw floor adjustment ──────────────
    // Football draws occur ~25-28% of the time across major leagues.
    // Both LLMs and naive models systematically underestimate draw probability.
    //
    // Two-tier floor:
    // - Tier 1 (close matches, max win < 0.50): draw floor = 0.25
    //   These matches are genuinely uncertain; draws are common (~30%+)
    // - Tier 2 (moderate matches, max win < 0.60): draw floor = 0.23
    //   Slight favourite, but draw is still realistic (~25%)
    // - Tier 3 (clear favourite, max win >= 0.60): draw floor = 0.20
    //   Only extreme mismatches should have draw below this
    const dominantProb = Math.max(homeWinProb, awayWinProb);
    let drawFloor: number;
    if (dominantProb < 0.5) {
      drawFloor = 0.25; // Close match — draws very common
    } else if (dominantProb < 0.6) {
      drawFloor = 0.23; // Moderate favourite — draw still realistic
    } else {
      drawFloor = 0.2; // Clear favourite — lower draw floor
    }

    // Context-aware draw uplift for parity matches.
    // These are high-draw profiles that pure probability blending often misses.
    const homePos = Number(matchData.standings?.home?.leaguePosition ?? 0);
    const awayPos = Number(matchData.standings?.away?.leaguePosition ?? 0);
    if (homePos > 0 && awayPos > 0) {
      const posGap = Math.abs(homePos - awayPos);
      if (posGap <= 3) {
        drawFloor = Math.max(drawFloor, 0.28);
      } else if (posGap <= 5) {
        drawFloor = Math.max(drawFloor, 0.26);
      }
    }

    const homeXgDiff =
      (matchData.recentStats?.home?.averages?.xG ?? 0) -
      (matchData.recentStats?.home?.averages?.xGA ?? 0);
    const awayXgDiff =
      (matchData.recentStats?.away?.averages?.xG ?? 0) -
      (matchData.recentStats?.away?.averages?.xGA ?? 0);
    if (homeXgDiff !== 0 || awayXgDiff !== 0) {
      const xgGap = Math.abs(homeXgDiff - awayXgDiff);
      if (xgGap < 0.2) {
        drawFloor = Math.max(drawFloor, 0.27);
      } else if (xgGap < 0.35) {
        drawFloor = Math.max(drawFloor, 0.25);
      }
    }

    // Venue-context draw nudges. Effect sizes are small but consistent in
    // the literature: derbies and dead-rubbers both lift draw rates a few
    // points. We don't apply altitude here — that's already in the Poisson
    // home-advantage factor.
    const venueCtx = matchData.venueContext;
    if (venueCtx) {
      if (venueCtx.derbyType === 'same_city') {
        drawFloor = Math.max(drawFloor, 0.28);
      } else if (venueCtx.derbyType === 'rivalry') {
        drawFloor = Math.max(drawFloor, 0.27);
      }
      if (venueCtx.lateSeasonStakes === 'mid_table_dead_rubber') {
        drawFloor = Math.max(drawFloor, 0.28);
      }
    }

    if (drawProb < drawFloor) {
      // Draw is underweighted — apply stronger calibration with 85% gap closure
      const drawBoost = (drawFloor - drawProb) * 0.85;
      drawProb += drawBoost;
      // Subtract proportionally from home and away
      const homeShare = homeWinProb / (homeWinProb + awayWinProb);
      homeWinProb -= drawBoost * homeShare;
      awayWinProb -= drawBoost * (1 - homeShare);

      // Re-normalize
      total = homeWinProb + drawProb + awayWinProb;
      homeWinProb /= total;
      drawProb /= total;
      awayWinProb /= total;
    }

    // ── Competitive-match dampening ───────────────────────────────────
    // When the favourite's probability is modest (< 0.50), the match is
    // genuinely uncertain. Dampen toward equal probabilities to avoid
    // false confidence in a marginal favourite.
    let maxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    if (maxProb < 0.5 && maxProb > 0.38) {
      // Tight match — pull probabilities 5% toward the mean (1/3)
      const dampeningFactor = 0.95;
      const mean = 1 / 3;
      homeWinProb =
        homeWinProb * dampeningFactor + mean * (1 - dampeningFactor);
      drawProb = drawProb * dampeningFactor + mean * (1 - dampeningFactor);
      awayWinProb =
        awayWinProb * dampeningFactor + mean * (1 - dampeningFactor);

      // Re-normalize
      total = homeWinProb + drawProb + awayWinProb;
      homeWinProb /= total;
      drawProb /= total;
      awayWinProb /= total;

      maxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    }

    // ── Overconfidence dampening ──────────────────────────────────────
    // If any single outcome probability exceeds 0.65, dampen it.
    // Even heavy favorites lose 20-25% of the time.
    if (maxProb > 0.65) {
      const dampeningFactor = 0.9; // Pull extreme probs 10% toward the mean
      const mean = 1 / 3;
      homeWinProb =
        homeWinProb * dampeningFactor + mean * (1 - dampeningFactor);
      drawProb = drawProb * dampeningFactor + mean * (1 - dampeningFactor);
      awayWinProb =
        awayWinProb * dampeningFactor + mean * (1 - dampeningFactor);

      // Re-normalize
      total = homeWinProb + drawProb + awayWinProb;
      homeWinProb /= total;
      drawProb /= total;
      awayWinProb /= total;
    }

    // Blend expected goals (Poisson model is better calibrated for goals)
    let predictedHomeGoals = claudePrediction.predictedHomeGoals;
    let predictedAwayGoals = claudePrediction.predictedAwayGoals;
    if (hasPoissonData) {
      // Poisson model should dominate goal expectations
      const poissonGoalWeight = 0.65;
      predictedHomeGoals =
        (1 - poissonGoalWeight) * claudePrediction.predictedHomeGoals +
        poissonGoalWeight * poissonOutput!.expectedHomeGoals;
      predictedAwayGoals =
        (1 - poissonGoalWeight) * claudePrediction.predictedAwayGoals +
        poissonGoalWeight * poissonOutput!.expectedAwayGoals;
    }

    // ── Confidence adjustment ─────────────────────────────────────────
    // Confidence should correlate with actual prediction difficulty.
    // Previous logic used hard caps by ensembleMaxProb that collapsed ~80%
    // of predictions to confidence=4 — confidence became a useless signal.
    // New logic: softer nudges (±1 each) so the final distribution has
    // actual dynamic range while still punishing genuinely uncertain
    // predictions.
    let adjustedConfidence = claudePrediction.confidence;

    // Decisiveness nudge: tight matches get a single point off, not a hard
    // cap. Very competitive matches get two points off. Clear favourites get
    // a small boost.
    const ensembleMaxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    if (ensembleMaxProb < 0.4) {
      adjustedConfidence = adjustedConfidence - 2;
    } else if (ensembleMaxProb < 0.48) {
      adjustedConfidence = adjustedConfidence - 1;
    } else if (ensembleMaxProb >= 0.6) {
      adjustedConfidence = adjustedConfidence + 1;
    }

    if (hasBookmakerData) {
      // Check if Claude and bookmakers agree on the likely outcome
      const claudePredResult = this.getArgmax(
        claudePrediction.homeWinProb,
        claudePrediction.drawProb,
        claudePrediction.awayWinProb,
      );
      const bookPredResult = this.getArgmax(
        bookmakerProbs!.home,
        bookmakerProbs!.draw,
        bookmakerProbs!.away,
      );

      if (claudePredResult !== bookPredResult) {
        // Claude and bookmakers disagree on the outcome — reduce (but don't
        // demolish) confidence. Previous −2 was too aggressive given
        // bookmaker odds are often absent.
        adjustedConfidence = adjustedConfidence - 1;
      } else {
        // They agree — check probability magnitude alignment
        const claudeMaxOutcome = Math.max(
          claudePrediction.homeWinProb,
          claudePrediction.drawProb,
          claudePrediction.awayWinProb,
        );
        const bookmakerMaxOutcome = Math.max(
          bookmakerProbs!.home,
          bookmakerProbs!.draw,
          bookmakerProbs!.away,
        );
        const probDivergence = Math.abs(claudeMaxOutcome - bookmakerMaxOutcome);
        if (probDivergence > 0.15) {
          // Large magnitude disagreement
          adjustedConfidence = adjustedConfidence - 1;
        } else {
          // They agree on outcome AND magnitude — bonus
          adjustedConfidence = adjustedConfidence + 1;
        }
      }

      // Poisson agreement bonus: if all three signals converge strongly,
      // allow confidence to climb higher than the old +1 cap at 8.
      if (hasPoissonData) {
        const poissonPredResult = this.getArgmax(
          poissonOutput!.homeWinProb,
          poissonOutput!.drawProb,
          poissonOutput!.awayWinProb,
        );
        if (
          claudePredResult === bookPredResult &&
          claudePredResult === poissonPredResult &&
          ensembleMaxProb >= 0.5
        ) {
          adjustedConfidence = adjustedConfidence + 1;
        }
      }
    }

    // Final clamp to the 1..9 range. We exclude 10 (per prompt guidance "no
    // football match warrants 10") but allow the upper band so confidence
    // is a real signal.
    adjustedConfidence = Math.max(
      1,
      Math.min(9, Math.round(adjustedConfidence)),
    );

    this.logger.log(
      `Ensemble: Bookmaker(${(bookmakerWeight * 100).toFixed(0)}%) + ` +
        `Poisson(${(poissonWeight * 100).toFixed(0)}%) + ` +
        `Claude(${(claudeWeight * 100).toFixed(0)}%) → ` +
        `H=${(homeWinProb * 100).toFixed(1)}% D=${(drawProb * 100).toFixed(1)}% A=${(awayWinProb * 100).toFixed(1)}% ` +
        `(conf: ${claudePrediction.confidence}→${adjustedConfidence})`,
    );

    return {
      ...claudePrediction,
      homeWinProb: Number(homeWinProb.toFixed(4)),
      drawProb: Number(drawProb.toFixed(4)),
      awayWinProb: Number(awayWinProb.toFixed(4)),
      predictedHomeGoals: Number(predictedHomeGoals.toFixed(1)),
      predictedAwayGoals: Number(predictedAwayGoals.toFixed(1)),
      confidence: adjustedConfidence,
    };
  }

  /**
   * Get the argmax outcome from three probabilities.
   */
  private getArgmax(
    homeProb: number,
    drawProb: number,
    awayProb: number,
  ): string {
    if (homeProb >= drawProb && homeProb >= awayProb) return 'home_win';
    if (awayProb >= homeProb && awayProb >= drawProb) return 'away_win';
    return 'draw';
  }

  /**
   * Enrich prediction rows with homeTeamName / awayTeamName by looking up the teams table.
   * Batches team ID lookups to avoid N+1 queries.
   */
  private async enrichPredictionsWithTeamNames(
    predictions: any[],
  ): Promise<any[]> {
    if (predictions.length === 0) return predictions;

    // Collect unique team IDs
    const teamIds = new Set<number>();
    for (const p of predictions) {
      if (p.homeTeamId) teamIds.add(p.homeTeamId);
      if (p.awayTeamId) teamIds.add(p.awayTeamId);
    }

    if (teamIds.size === 0) return predictions;

    // Batch lookup
    const teamRows = await this.db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(
        sql`${schema.teams.id} IN (${sql.join(
          [...teamIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const teamMap = new Map<number, string>();
    for (const t of teamRows) {
      teamMap.set(t.id, t.name);
    }

    return predictions.map((p: any) => ({
      ...p,
      homeTeamName: teamMap.get(p.homeTeamId) ?? null,
      awayTeamName: teamMap.get(p.awayTeamId) ?? null,
    }));
  }

  private async storePrediction(
    fixtureId: number,
    data: CollectedMatchData,
    research: ResearchResult,
    prediction: PredictionOutput,
    predictionType: PredictionType,
    modelVersion: string,
    smartMoneySignal: SmartMoneySignal | null = null,
  ): Promise<any> {
    // Lock in the predicted result at prediction time — never re-derived later
    const predictedResult = this.getPredictedResult(prediction);

    const values = {
      fixtureId,
      homeTeamId: data.fixture.homeTeamId,
      awayTeamId: data.fixture.awayTeamId,
      homeWinProb: String(prediction.homeWinProb),
      drawProb: String(prediction.drawProb),
      awayWinProb: String(prediction.awayWinProb),
      predictedHomeGoals: String(prediction.predictedHomeGoals),
      predictedAwayGoals: String(prediction.predictedAwayGoals),
      predictedResult,
      confidence: prediction.confidence,
      predictionType,
      keyFactors: prediction.keyFactors,
      riskFactors: prediction.riskFactors,
      valueBets: prediction.valueBets,
      matchContext: this.buildMatchContext(data),
      matchInsights: (data.matchInsights ?? null) as any,
      researchContext: {
        combinedResearch: research.combinedResearch,
        citations: research.citations,
      },
      detailedAnalysis: prediction.detailedAnalysis,
      smartMoneySignal: smartMoneySignal as any,
      modelVersion,
      predictionStatus: 'pending' as const,
      updatedAt: new Date(),
    };

    const [stored] = await this.db
      .insert(schema.predictions)
      .values(values)
      .onConflictDoUpdate({
        // One prediction per fixture: the latest run overwrites the existing
        // row in place (id preserved, so FK references stay valid). The new
        // predictionType is part of `values`, so the row reflects the most
        // recent run.
        target: [schema.predictions.fixtureId],
        set: {
          ...values,
          updatedAt: new Date(),
        },
      })
      .returning();

    return stored;
  }

  /**
   * Look up Polymarket markets linked to this fixture and compute the
   * smart-money signal across them. Returns null when no Polymarket
   * market exists or the signal can't be formed (insufficient sharps).
   *
   * The output is stored on `predictions.smart_money_signal` so we can
   * analyse the signal's value retrospectively without re-fetching from
   * Polymarket — and crucially, without any walk-forward leakage.
   */
  /**
   * Fetch all Polymarket markets linked to a fixture, then pick the one we
   * can actually use for direction-matching: a "Will TEAM win on DATE?"
   * moneyline where the team name matches either the home or away team of
   * the fixture. O/U, spreads, draw, BTTS markets are intentionally skipped
   * — they don't answer the 1X2 question we care about.
   *
   * We prefer the HOME-team moneyline (so outcome 0 = home win) so the
   * direction mapping downstream is consistent across fixtures. If only an
   * away-team moneyline exists, we use that and flip the interpretation.
   *
   * Returns null when no usable market exists.
   */
  private async computeSmartMoneySignal(
    fixtureId: number,
  ): Promise<(SmartMoneySignal & { marketTeamId?: number | null }) | null> {
    // Step 0: on-demand linking.
    // If this fixture isn't in polymarket_markets yet, try to discover it on
    // Polymarket right now instead of waiting for the 30-min scheduled scan.
    // Polymarket may have added the market between the last scan and this
    // prediction, and lower-league fixtures often don't get caught by the
    // league-specific tag scan. `linkFixtureOnDemand` handles both cases,
    // caches negative lookups for 2h to avoid hammering Gamma, and persists
    // any matches so subsequent predictions / scans see the link.
    const initialCheck = await this.db
      .select({ id: schema.polymarketMarkets.id })
      .from(schema.polymarketMarkets)
      .where(eq(schema.polymarketMarkets.fixtureId, fixtureId))
      .limit(1);
    if (initialCheck.length === 0) {
      const result = await this.polymarketService.linkFixtureOnDemand(
        fixtureId,
      );
      if (result.linked > 0) {
        this.logger.log(
          `Smart-money: on-demand linked fixture ${fixtureId} to ${result.linked} Polymarket market(s)`,
        );
      } else if (!result.alreadyLinked && !result.cached) {
        // Fresh miss — Polymarket simply doesn't have this fixture.
        this.logger.debug(
          `Smart-money: fixture ${fixtureId} not on Polymarket (no signal available)`,
        );
      }
    }

    const linkedMarkets = await this.db
      .select({
        conditionId: schema.polymarketMarkets.conditionId,
        teamId: schema.polymarketMarkets.teamId,
        marketQuestion: schema.polymarketMarkets.marketQuestion,
      })
      .from(schema.polymarketMarkets)
      .where(
        and(
          eq(schema.polymarketMarkets.fixtureId, fixtureId),
          isNotNull(schema.polymarketMarkets.conditionId),
        ),
      );
    if (linkedMarkets.length === 0) return null;

    // Look up the fixture's home + away team names so we can match the
    // market question against them.
    const [fixture] = await this.db
      .select({
        homeTeamId: schema.fixtures.homeTeamId,
        awayTeamId: schema.fixtures.awayTeamId,
      })
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, fixtureId))
      .limit(1);
    if (!fixture) return null;
    const teamRows = await this.db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(
        sql`${schema.teams.id} IN (${fixture.homeTeamId}, ${fixture.awayTeamId})`,
      );
    const homeName =
      teamRows.find((t: any) => t.id === fixture.homeTeamId)?.name ?? '';
    const awayName =
      teamRows.find((t: any) => t.id === fixture.awayTeamId)?.name ?? '';
    if (!homeName || !awayName) return null;

    // Parse each market's question to find usable moneyline markets.
    // Expected form: "Will TEAM_NAME win on YYYY-MM-DD?"
    const candidates: Array<{
      conditionId: string;
      storedTeamId: number | null;
      teamName: string;
      matchSide: 'home' | 'away';
      similarity: number;
    }> = [];
    const MONEYLINE_RX = /^Will\s+(.+?)\s+win\s+on\s+\d{4}-\d{2}-\d{2}\??$/i;
    for (const m of linkedMarkets) {
      const q = String(m.marketQuestion ?? '').trim();
      const match = q.match(MONEYLINE_RX);
      if (!match) continue; // skip O/U, spreads, draw, BTTS, season-long
      const teamInQuestion = match[1].trim();
      const homeSim = this.nameSimilarity(teamInQuestion, homeName);
      const awaySim = this.nameSimilarity(teamInQuestion, awayName);
      if (homeSim < 0.5 && awaySim < 0.5) continue;
      const matchSide: 'home' | 'away' = homeSim >= awaySim ? 'home' : 'away';
      candidates.push({
        conditionId: m.conditionId as string,
        storedTeamId: m.teamId as number | null,
        teamName: teamInQuestion,
        matchSide,
        similarity: Math.max(homeSim, awaySim),
      });
    }
    if (candidates.length === 0) return null;

    // Prefer home-team moneyline (so outcome 0 = YES = home team wins).
    candidates.sort((a, b) => {
      // HOME before AWAY, then higher similarity wins
      if (a.matchSide !== b.matchSide) return a.matchSide === 'home' ? -1 : 1;
      return b.similarity - a.similarity;
    });
    const chosen = candidates[0];
    const marketTeamId =
      chosen.matchSide === 'home'
        ? fixture.homeTeamId
        : fixture.awayTeamId;

    this.logger.debug(
      `Smart-money market selected for fixture ${fixtureId}: ` +
        `"${chosen.teamName}" (${chosen.matchSide}, sim=${chosen.similarity.toFixed(2)})`,
    );

    const signal = await this.smartMoneySignalService.computeSignal(
      chosen.conditionId,
    );
    // Direct signal found — return it. If the direct market yielded no
    // qualifying sharps (leanScore null) we still prefer the direct
    // source rather than falling back to backdrop for the same fixture —
    // the direct market is the most relevant evidence and its absence of
    // sharp conviction is itself informative.
    if (signal.leanScore != null) {
      return { ...signal, marketTeamId };
    }

    // No qualifying sharps on the direct market — fall back to backdrop.
    const backdrop = await this.computeBackdropSignal(
      fixture.homeTeamId,
      fixture.awayTeamId,
    );
    if (backdrop && backdrop.leanScore != null) {
      return backdrop;
    }
    // Return the direct signal with null leanScore (informative "no read").
    return { ...signal, marketTeamId };
  }

  /**
   * Backdrop smart-money signal built from season-long outright markets.
   *
   * When no per-match Polymarket moneyline exists for a fixture, we can
   * still learn something about the teams' relative standing by reading
   * sharp-money positioning on their season-long outrights: league_winner,
   * qualification (UCL/UEL/UECL), top_4, tournament_winner.
   *
   * Logic:
   *   1. Pull outright markets linked (via polymarket_markets.team_id) to
   *      either the home or away team of this fixture.
   *   2. For each market, compute the per-market smart-money signal.
   *      A positive leanScore means sharps are bullish on the team that
   *      market is about (since outcome 0 = YES = "Will X happen?"),
   *      negative means bearish.
   *   3. Aggregate per team: sum sharp dollars × leanScore across markets.
   *   4. Compare homeConviction vs awayConviction to get a fixture-level
   *      lean (home-biased +1 to away-biased -1).
   *
   * Returns null when there aren't enough sharps across any of the
   * involved outright markets to form a signal.
   *
   * Intentionally skips any market whose question contains "relegate" —
   * polarity on that is negative (YES = team loses) and requires inversion
   * the first cut doesn't attempt.
   */
  private async computeBackdropSignal(
    homeTeamId: number,
    awayTeamId: number,
  ): Promise<
    | (SmartMoneySignal & { marketTeamId?: number | null })
    | null
  > {
    // Outright market types we trust to have YES = positive-for-team polarity.
    const POSITIVE_OUTRIGHT_TYPES = [
      'league_winner',
      'qualification',
      'top_4',
      'tournament_winner',
    ];

    const markets = await this.db
      .select({
        conditionId: schema.polymarketMarkets.conditionId,
        teamId: schema.polymarketMarkets.teamId,
        marketType: schema.polymarketMarkets.marketType,
        marketQuestion: schema.polymarketMarkets.marketQuestion,
      })
      .from(schema.polymarketMarkets)
      .where(
        and(
          isNotNull(schema.polymarketMarkets.conditionId),
          isNotNull(schema.polymarketMarkets.teamId),
          inArray(schema.polymarketMarkets.teamId, [homeTeamId, awayTeamId]),
          inArray(schema.polymarketMarkets.marketType, POSITIVE_OUTRIGHT_TYPES),
        ),
      );

    if (markets.length === 0) return null;

    // Per-team conviction aggregation. conviction = Σ leanScore × dollars
    //   (higher = more sharp bullishness on that team)
    let homeConviction = 0;
    let awayConviction = 0;
    let homeSharpDollars = 0;
    let awaySharpDollars = 0;
    let totalSharps = 0;
    let contributingMarkets = 0;
    const allTopSharps: SmartMoneySignal['topSharps'] = [];

    for (const m of markets) {
      // Skip relegation-style markets (negative polarity) defensively even
      // if they were accidentally tagged with a positive market_type.
      const q = String(m.marketQuestion ?? '').toLowerCase();
      if (q.includes('relegat')) continue;

      const sig = await this.smartMoneySignalService.computeSignal(
        m.conditionId as string,
      );
      if (sig.leanScore == null) continue;
      contributingMarkets++;
      // Dollars that were on YES (outcome 0 = "Will this team do the thing?")
      const teamId = m.teamId as number;
      const yesDollars = sig.sharpDollarsOutcome0;
      const noDollars = sig.sharpDollarsOutcome1;
      // Sharp conviction on this team = leanScore × dollars behind signal.
      // Positive leanScore → YES = team achieves it → bullish.
      const conviction = sig.leanScore * (yesDollars + noDollars);
      if (teamId === homeTeamId) {
        homeConviction += conviction;
        homeSharpDollars += yesDollars + noDollars;
      } else if (teamId === awayTeamId) {
        awayConviction += conviction;
        awaySharpDollars += yesDollars + noDollars;
      }
      totalSharps += sig.sharpCount;
      for (const s of sig.topSharps) allTopSharps.push(s);
    }

    if (contributingMarkets === 0) return null;

    // Normalise conviction to a comparable scale per team then compute
    // fixture-level lean: +1 = home strongly favoured by sharps, -1 = away.
    const normHome =
      homeSharpDollars > 0 ? homeConviction / homeSharpDollars : 0;
    const normAway =
      awaySharpDollars > 0 ? awayConviction / awaySharpDollars : 0;
    const leanScore = Math.max(-1, Math.min(1, (normHome - normAway) / 2));

    // Signal confidence: sample size × magnitude, capped at 1.
    const sampleConf = Math.min(1, totalSharps / 15);
    const signalConfidence = sampleConf * Math.abs(leanScore);

    return {
      signalKind: 'backdrop',
      leanScore,
      signalConfidence,
      sharpCount: totalSharps,
      sharpDollarsOutcome0: homeSharpDollars,
      sharpDollarsOutcome1: awaySharpDollars,
      outcome0Name: 'Home team (season-long conviction)',
      outcome1Name: 'Away team (season-long conviction)',
      topSharps: allTopSharps
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5),
      contributingMarkets,
      // Backdrop signal has no single marketTeamId — home wins → leanScore +
      marketTeamId: homeTeamId,
    };
  }

  /**
   * Lightweight team-name similarity. Lower-cased, FC/AFC/SC/etc. stripped,
   * punctuation normalised. Returns 0..1; 1 = exact or substring match.
   * Mirrors (and simplifies) OddsService.teamNameSimilarity — the two live
   * in different modules and a shared util would force a new dependency.
   */
  private nameSimilarity(a: string, b: string): number {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/\b(fc|cf|sc|afc|ac|as|ss|us|rc|cd|ud|rcd|sd|ca|se)\b/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.85;
    // Word overlap
    const wa = new Set(na.split(' '));
    const wb = new Set(nb.split(' '));
    const overlap = [...wa].filter((w) => wb.has(w)).length;
    const denom = Math.min(wa.size, wb.size);
    if (denom === 0) return 0;
    return overlap / denom;
  }

  /**
   * ⚠ NOT WIRED INTO THE PIPELINE — see Step 3c in generatePrediction.
   *
   * Backtest on 37 qualifying historical predictions (April 2026) showed
   * the probability blend hurts Brier monotonically across every weight
   * cap and every sub-cohort:
   *
   *   weightCap=0.05 → +0.005 Brier
   *   weightCap=0.20 → +0.013 Brier  (what we initially shipped)
   *   weightCap=0.50 → +0.020 Brier
   *
   * The harm gets worst when sharps are MOST confident (|lean|≥0.80
   * → +0.048), which is the opposite of what a real predictive signal
   * would show. The signal correlates with predictability (sharps tend
   * to crowd in well-modelled matches) but does not add new directional
   * information beyond what the ensemble already extracts.
   *
   * The function stays defined for future re-introduction with stricter
   * gating (e.g. only sharpCount≥8 cohort showed a tiny -0.001 helps).
   * Re-wire only after another backtest confirms a meaningful Brier win.
   * See autoresearch/smart-money-blend-backtest.ts for the data.
   *
   * ----- ORIGINAL DESIGN NOTES (kept for context if re-introduced) -----
   *
   * Convert a direct smart-money signal into a probability blend over the
   * ensemble's existing probabilities.
   *
   * The signal gives us a lean toward Polymarket outcome 0 (typically YES =
   * "team X wins") with strength `leanScore` ∈ [-1, +1] and sample-driven
   * `signalConfidence` ∈ [0, 1]. We map this to a "sharp-implied" 1X2
   * vector and blend with a small weight:
   *
   *   weight = min(0.20, signalConfidence × min(1, sharpCount / 8))
   *
   * The cap is intentional. We trust this as a fourth signal, not a
   * fourth-and-a-half — a single hot streak among 3 sharps shouldn't
   * dominate a Claude/Poisson/bookmaker consensus that points the other way.
   *
   * Mapping leanScore → 1X2 implied probabilities:
   *   - The market's YES side maps to "marketTeamId wins". Sharp
   *     positioning gives us p_yes ≈ 0.5 + leanScore × 0.5 (e.g. lean=+1
   *     → 100% YES, lean=0 → 50/50, lean=-1 → 0% YES).
   *   - The remaining (1 - p_yes) is distributed between the OTHER 1X2
   *     outcomes proportionally to the ensemble's current split — i.e.
   *     if the ensemble has draw and away in a 60/40 ratio, the NO
   *     mass gets split 60/40 between them. This avoids putting all NO
   *     mass on one outcome and creating spurious shifts.
   *
   * Skipped when:
   *   - sharpCount < 3 or signalConfidence < 0.2 (too thin)
   *   - marketTeamId not present or doesn't match either side
   *   - leanScore magnitude < 0.2 (essentially neutral)
   */
  private applySmartMoneyProbabilityBlend(
    prediction: PredictionOutput,
    signal: SmartMoneySignal & { marketTeamId?: number | null },
    matchData: CollectedMatchData,
  ): PredictionOutput {
    if (
      signal.leanScore == null ||
      signal.signalConfidence < 0.2 ||
      signal.sharpCount < 3 ||
      Math.abs(signal.leanScore) < 0.2 ||
      signal.marketTeamId == null
    ) {
      return prediction;
    }

    // Identify which 1X2 slot the market's YES outcome corresponds to.
    let yesSlot: 'home' | 'away' | null = null;
    if (signal.marketTeamId === matchData.fixture.homeTeamId) yesSlot = 'home';
    else if (signal.marketTeamId === matchData.fixture.awayTeamId)
      yesSlot = 'away';
    if (yesSlot == null) return prediction;

    // Sharp-implied YES probability. Bound away from 0/1 so we never
    // collapse the blend; even +1 lean among 5 sharps is "very high",
    // not "certainty".
    const pYesRaw = 0.5 + signal.leanScore * 0.5;
    const pYes = Math.max(0.05, Math.min(0.95, pYesRaw));

    // Existing ensemble probs by 1X2 slot.
    const ens = {
      home: prediction.homeWinProb,
      draw: prediction.drawProb,
      away: prediction.awayWinProb,
    };

    // Build a 1X2 vector from the signal: yesSlot → pYes; remaining mass
    // is split between the other two slots proportionally to ensemble.
    const noSlots: Array<'home' | 'draw' | 'away'> =
      yesSlot === 'home' ? ['draw', 'away'] : ['home', 'draw'];
    const noMass = 1 - pYes;
    const noTotal = ens[noSlots[0]] + ens[noSlots[1]];
    const sharpVec: { home: number; draw: number; away: number } = {
      home: 0,
      draw: 0,
      away: 0,
    };
    sharpVec[yesSlot] = pYes;
    if (noTotal > 0) {
      sharpVec[noSlots[0]] = (ens[noSlots[0]] / noTotal) * noMass;
      sharpVec[noSlots[1]] = (ens[noSlots[1]] / noTotal) * noMass;
    } else {
      // Degenerate case (shouldn't happen post-ensemble, but be safe).
      sharpVec[noSlots[0]] = noMass / 2;
      sharpVec[noSlots[1]] = noMass / 2;
    }

    // Blend weight. Caps at 0.20.
    const sampleScale = Math.min(1, signal.sharpCount / 8);
    const weight = Math.min(0.2, signal.signalConfidence * sampleScale);

    const blended = {
      home: ens.home * (1 - weight) + sharpVec.home * weight,
      draw: ens.draw * (1 - weight) + sharpVec.draw * weight,
      away: ens.away * (1 - weight) + sharpVec.away * weight,
    };
    // Renormalise for any floating-point drift.
    const sum = blended.home + blended.draw + blended.away;
    blended.home /= sum;
    blended.draw /= sum;
    blended.away /= sum;

    this.logger.log(
      `Smart-money probability blend: leanScore=${signal.leanScore.toFixed(2)}, ` +
        `sharps=${signal.sharpCount}, weight=${weight.toFixed(2)}, ` +
        `slot=${yesSlot} → ` +
        `H=${(ens.home * 100).toFixed(1)}→${(blended.home * 100).toFixed(1)}%, ` +
        `D=${(ens.draw * 100).toFixed(1)}→${(blended.draw * 100).toFixed(1)}%, ` +
        `A=${(ens.away * 100).toFixed(1)}→${(blended.away * 100).toFixed(1)}%`,
    );

    return {
      ...prediction,
      homeWinProb: Number(blended.home.toFixed(4)),
      drawProb: Number(blended.draw.toFixed(4)),
      awayWinProb: Number(blended.away.toFixed(4)),
    };
  }

  /**
   * Smart-money confidence adjustment, calibrated against the Apr-2026
   * backtest of 583 signaled predictions:
   *
   *   - Signal AGREES with ensemble pick: mean Brier 0.560
   *   - Signal DISAGREES with ensemble pick: mean Brier 0.602
   *   - Difference: -0.042 in favour of agreement
   *
   * That gap is large enough (the autoresearch loop spent months fighting
   * for 0.001) that we trust the signal as a confidence modifier:
   *   • agreement → +1 confidence (we're more likely right)
   *   • disagreement → −1 confidence and demote the prediction's
   *     "high-conviction" tier (we're more likely wrong)
   *
   * We do NOT modify probabilities — the signal's direction-prediction
   * power is unverified. Probability shifts wait for a separate study
   * that maps Polymarket outcome 0/1 to football outcomes per market.
   *
   * `marketTeamId` enables proper agreement detection: outcome 0 (YES)
   * usually means "team X wins", so agreement = (sharps lean YES AND
   * ensemble picks team X to win).
   */
  private applySmartMoneyConfidenceAdjustment(
    prediction: PredictionOutput,
    signal: SmartMoneySignal & { marketTeamId?: number | null },
    matchData: CollectedMatchData,
  ): PredictionOutput {
    if (
      signal.leanScore == null ||
      signal.signalConfidence < 0.2 ||
      signal.sharpCount < 3
    ) {
      return prediction;
    }

    // Determine which football outcome the ensemble is picking
    const ensemblePick =
      prediction.homeWinProb >= prediction.drawProb &&
      prediction.homeWinProb >= prediction.awayWinProb
        ? 'home'
        : prediction.awayWinProb >= prediction.drawProb
          ? 'away'
          : 'draw';

    // Determine which side of the Polymarket market the ensemble corresponds to
    let ensembleAlignsWithYes: boolean | null = null;
    if (signal.marketTeamId != null) {
      if (signal.marketTeamId === matchData.fixture.homeTeamId) {
        ensembleAlignsWithYes = ensemblePick === 'home';
      } else if (signal.marketTeamId === matchData.fixture.awayTeamId) {
        ensembleAlignsWithYes = ensemblePick === 'away';
      }
    }

    let adjustedConfidence = prediction.confidence;
    const sharpsLeanYes = signal.leanScore > 0;
    const sharpsLeanStrong = Math.abs(signal.leanScore) >= 0.3;

    if (ensembleAlignsWithYes === null || !sharpsLeanStrong) {
      // No clean direction comparison — just log
      this.logger.log(
        `Smart-money: ${signal.sharpCount} sharps lean=${signal.leanScore.toFixed(2)} (no direction match available)`,
      );
      return prediction;
    }

    const agree = sharpsLeanYes === ensembleAlignsWithYes;
    const kind = signal.signalKind ?? 'direct';
    if (agree) {
      adjustedConfidence = Math.min(9, adjustedConfidence + 1);
      this.logger.log(
        `Smart-money (${kind}): ${signal.sharpCount} sharps AGREE with ensemble ` +
          `(lean=${signal.leanScore.toFixed(2)}) — confidence +1`,
      );
    } else if (kind === 'direct') {
      // Direct per-match market: the backtest showed a 0.042 Brier gap
      // favouring agreement, so disagreement is a genuine warning.
      adjustedConfidence = Math.max(1, adjustedConfidence - 1);
      this.logger.log(
        `Smart-money (direct): ${signal.sharpCount} sharps DISAGREE with ensemble ` +
          `(lean=${signal.leanScore.toFixed(2)}) — confidence −1 (Brier degrades on disagreement)`,
      );
    } else {
      // Backdrop: season-long outrights don't directly predict a single
      // match outcome, so disagreement is too weak to justify a penalty.
      // Log it for visibility but leave confidence alone.
      this.logger.log(
        `Smart-money (backdrop): ${signal.sharpCount} sharps disagree with ensemble ` +
          `(lean=${signal.leanScore.toFixed(2)}) — no penalty, season-long signal is only used for agreement`,
      );
    }

    return { ...prediction, confidence: adjustedConfidence };
  }

  private buildMatchContext(data: CollectedMatchData): Record<string, any> {
    return {
      fixture: {
        id: data.fixture.id,
        date: data.fixture.date,
        league: data.fixture.leagueName,
        round: data.fixture.round,
        venue: data.fixture.venueName,
      },
      seasonRematch: data.seasonRematch,
      homeTeam: data.homeTeam?.team?.name ?? null,
      awayTeam: data.awayTeam?.team?.name ?? null,
      overallFormWindows: data.formWindows,
      opponentStrength: data.opponentStrength,
      h2hCount: data.h2h.length,
      injuriesCount: data.injuries.length,
      lineupsAvailable: data.lineups.length > 0,
      oddsAvailable: data.odds.consensus.length > 0,
      apiPredictionAvailable: data.apiPrediction != null,
    };
  }

  private getPredictedResult(prediction: PredictionOutput): string {
    return this.getPredictedResultFromProbs(
      prediction.homeWinProb,
      prediction.drawProb,
      prediction.awayWinProb,
    );
  }

  /**
   * Determine the predicted result from probabilities.
   *
   * Draw-aware argmax. The pure-argmax baseline systematically under-predicts
   * draws because draw probability is distributed across all matches but
   * rarely becomes the single highest outcome. The old aggressive thresholds
   * (max ≤ 0.53, spread < 0.08, draw ≥ 0.28) were cannibalising away_wins —
   * a back-test on n=1181 resolved games showed 111 cases where argmax said
   * away_win but the old logic overrode to draw, and most of those actual
   * results were away_wins.
   *
   * Tightened thresholds (Option B) preserve the intent of catching draws
   * in genuinely uncertain matches while stopping the spillover into clear
   * wins. Back-tested impact vs old logic on n=1181:
   *   home_win recall:  76.4% → 83.3%  (+38 correct)
   *   draw recall:      26.2% →  6.8%  (−60 correct)
   *   away_win recall:  16.9% → 31.9%  (+48 correct)
   *   overall accuracy: 47.2% → 49.4%  (+26 correct)
   * The draw-recall loss is the intended trade — recovered upstream by
   * FormBasedNudgeService's home-4D-last10 nudge which boosts drawProb so
   * more draws become a genuine argmax.
   */
  private getPredictedResultFromProbs(
    homeProb: number,
    drawProb: number,
    awayProb: number,
  ): string {
    // 1. If draw is already the highest probability, always predict draw
    if (drawProb >= homeProb && drawProb >= awayProb) {
      return 'draw';
    }

    const maxWinProb = Math.max(homeProb, awayProb);
    const winSpread = Math.abs(homeProb - awayProb);

    // 2. GENUINELY TIGHT MATCH: max win prob ≤ 0.45 AND home/away within
    //    5pp of each other AND draw is essentially tied with the leader
    //    (within 3pp). These are the matches where draw is a real outcome
    //    rather than a tie-break dump.
    if (maxWinProb <= 0.45 && winSpread < 0.05 && drawProb >= maxWinProb - 0.03) {
      return 'draw';
    }

    // 3. MODERATE FAVOURITE: still allow draw when it is very close to the
    //    leader (within 3pp) and draw is ≥ 0.30. Preserved from the prior
    //    logic — it doesn't cause the away_win cannibalisation.
    if (maxWinProb <= 0.58 && drawProb >= 0.3 && maxWinProb - drawProb < 0.03) {
      return 'draw';
    }

    // 4. Otherwise, pick the higher of home or away
    if (homeProb >= awayProb) return 'home_win';
    return 'away_win';
  }

  /**
   * Calculate Brier score for a 3-outcome prediction.
   * Lower is better (0 = perfect, 2 = worst possible).
   */
  private calculateBrierScore(
    homeProb: number,
    drawProb: number,
    awayProb: number,
    actualResult: string,
  ): number {
    const actual = {
      home_win: actualResult === 'home_win' ? 1 : 0,
      draw: actualResult === 'draw' ? 1 : 0,
      away_win: actualResult === 'away_win' ? 1 : 0,
    };

    return (
      Math.pow(homeProb - actual.home_win, 2) +
      Math.pow(drawProb - actual.draw, 2) +
      Math.pow(awayProb - actual.away_win, 2)
    );
  }

  /**
   * Blends the main prediction with first-principles re-estimate and applies
   * critic-derived confidence penalty and risk annotations.
   */
  private applyChallengePass(
    base: PredictionOutput,
    firstPrinciples: FirstPrinciplesOutput | null,
    critic: CriticOutput | null,
  ): PredictionOutput {
    let home = base.homeWinProb;
    let draw = base.drawProb;
    let away = base.awayWinProb;

    if (firstPrinciples) {
      const wBase = 0.75;
      const wFp = 0.25;
      home = home * wBase + firstPrinciples.homeWinProb * wFp;
      draw = draw * wBase + firstPrinciples.drawProb * wFp;
      away = away * wBase + firstPrinciples.awayWinProb * wFp;
    }

    const total = home + draw + away;
    if (total > 0) {
      home /= total;
      draw /= total;
      away /= total;
    }

    let confidence = base.confidence;
    if (firstPrinciples) {
      confidence =
        Math.round((confidence * 0.7 + firstPrinciples.confidence * 0.3) * 10) /
        10;
    }
    if (critic) {
      confidence = confidence - critic.confidencePenalty;
    }
    // Clamp to [1, 9] so the critic can't floor confidence below a sensible
    // minimum, and the full range is preserved for downstream filtering.
    confidence = Math.max(1, Math.min(9, Math.round(confidence)));

    const keyFactors = [...base.keyFactors];
    const riskFactors = [...base.riskFactors];

    if (firstPrinciples?.rationale?.length) {
      for (const r of firstPrinciples.rationale.slice(0, 2)) {
        keyFactors.push(`First-principles check: ${r}`);
      }
    }

    if (critic?.concerns?.length) {
      for (const c of critic.concerns.slice(0, 3)) {
        riskFactors.push(`Critic concern: ${c}`);
      }
    }

    if (critic?.missedFactors?.length) {
      for (const m of critic.missedFactors.slice(0, 2)) {
        riskFactors.push(`Potential missed factor: ${m}`);
      }
    }

    const lines: string[] = [base.detailedAnalysis];
    if (firstPrinciples) {
      lines.push(
        `First-principles cross-check blended at 25%: H=${firstPrinciples.homeWinProb.toFixed(2)} D=${firstPrinciples.drawProb.toFixed(2)} A=${firstPrinciples.awayWinProb.toFixed(2)} (conf ${firstPrinciples.confidence}/10).`,
      );
    }
    if (critic) {
      lines.push(
        `Critic review verdict=${critic.verdict}, confidence penalty=${critic.confidencePenalty.toFixed(1)}.`,
      );
    }

    return {
      ...base,
      homeWinProb: Number(home.toFixed(4)),
      drawProb: Number(draw.toFixed(4)),
      awayWinProb: Number(away.toFixed(4)),
      confidence: Math.max(1, Math.min(10, Math.round(confidence))),
      keyFactors: keyFactors.slice(0, 8),
      riskFactors: riskFactors.slice(0, 8),
      detailedAnalysis: lines.join(' '),
    };
  }

  private async generateInsightsWithOpenAI(rawMetrics: any): Promise<any> {
    if (!this.openai) {
      return {
        summary:
          'OpenAI insights unavailable because OPENAI_API_KEY is not configured.',
        keyPatterns: [],
        strongestLeagues: [],
        weakestLeagues: [],
        confidenceCalibration: [],
        improvementSignals: [],
      };
    }

    const prompt = `You are a football prediction performance analyst.

Analyze the metrics and return ONLY JSON with this shape:
{
  "summary": "short executive summary",
  "keyPatterns": ["..."],
  "strongestLeagues": ["..."],
  "weakestLeagues": ["..."],
  "confidenceCalibration": ["..."],
  "improvementSignals": ["..."]
}

Requirements:
- Be strictly data-driven from the supplied metrics.
- Mention trend direction (accuracy/brier improving or worsening) with exact numbers when possible.
- Mention best/worst leagues by accuracy.
- Mention where confidence appears over/under calibrated.
- Keep each bullet short and concrete.

Metrics JSON:
${JSON.stringify(rawMetrics)}`;

    try {
      const model = this.insightsModel;
      const lower = model.toLowerCase();
      const isReasoning =
        lower.startsWith('o1') ||
        lower.startsWith('o3') ||
        lower.startsWith('o4') ||
        lower.startsWith('gpt-5');

      let content = '';
      if (isReasoning) {
        const response = await this.openai.chat.completions.create({
          model,
          messages: [{ role: 'developer', content: prompt }],
          reasoning_effort: 'high',
          max_completion_tokens: 1400,
        } as any);
        content = response.choices[0]?.message?.content ?? '';
      } else {
        const response = await this.openai.chat.completions.create({
          model,
          messages: [{ role: 'system', content: prompt }],
          temperature: 0.2,
          max_tokens: 1400,
        });
        content = response.choices[0]?.message?.content ?? '';
      }

      const parsed = this.parseJsonLoose(content);
      return {
        summary: parsed?.summary ?? 'No summary returned by model.',
        keyPatterns: Array.isArray(parsed?.keyPatterns)
          ? parsed.keyPatterns.slice(0, 8).map(String)
          : [],
        strongestLeagues: Array.isArray(parsed?.strongestLeagues)
          ? parsed.strongestLeagues.slice(0, 6).map(String)
          : [],
        weakestLeagues: Array.isArray(parsed?.weakestLeagues)
          ? parsed.weakestLeagues.slice(0, 6).map(String)
          : [],
        confidenceCalibration: Array.isArray(parsed?.confidenceCalibration)
          ? parsed.confidenceCalibration.slice(0, 6).map(String)
          : [],
        improvementSignals: Array.isArray(parsed?.improvementSignals)
          ? parsed.improvementSignals.slice(0, 8).map(String)
          : [],
      };
    } catch (error) {
      this.logger.warn(`OpenAI insights generation failed: ${error.message}`);
      return {
        summary: 'OpenAI insights generation failed; raw metrics are returned.',
        keyPatterns: [],
        strongestLeagues: [],
        weakestLeagues: [],
        confidenceCalibration: [],
        improvementSignals: [],
        error: error.message,
      };
    }
  }

  private parseJsonLoose(raw: string): any {
    const cleaned = String(raw ?? '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      }
      throw new Error('Invalid JSON response from model');
    }
  }
}
