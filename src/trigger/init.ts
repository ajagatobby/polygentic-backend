/**
 * Standalone service initialization for Trigger.dev tasks.
 *
 * Trigger.dev tasks run outside the NestJS DI container, so we
 * manually instantiate the database and service dependencies here.
 * Each call returns fresh instances (no global singletons) to avoid
 * stale connections across long-running Trigger.dev workers.
 */
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../database/schema';

import { FootballService } from '../football/football.service';
import { BasketballService } from '../basketball/basketball.service';
import { OddsService } from '../odds/odds.service';
import { AlertsService } from '../alerts/alerts.service';
import { PerplexityService } from '../agents/perplexity.service';
import { DataCollectorAgent } from '../agents/data-collector.agent';
import { ResearchAgent } from '../agents/research.agent';
import { AnalysisAgent } from '../agents/analysis.agent';
import { CriticAgent } from '../agents/critic.agent';
import { FirstPrinciplesAgent } from '../agents/first-principles.agent';
import { PoissonModelService } from '../agents/poisson-model.service';
import { PlayerImpactService } from '../agents/player-impact.service';
import { AgentsService } from '../agents/agents.service';
import { SyncService } from '../sync/sync.service';
import { PolymarketGammaService } from '../polymarket/services/polymarket-gamma.service';
import { PolymarketClobService } from '../polymarket/services/polymarket-clob.service';
import { PolymarketMatcherService } from '../polymarket/services/polymarket-matcher.service';
import { PolymarketTradingAgent } from '../polymarket/services/polymarket-trading.agent';
import { PolymarketDataService } from '../polymarket/services/polymarket-data.service';
import { SmartMoneySignalService } from '../polymarket/services/smart-money-signal.service';
import { CopyTraderService } from '../polymarket/services/copy-trader.service';
import { PredictionMemoryService } from '../agents/prediction-memory.service';
import { LeaguePriorsService } from '../agents/league-priors.service';
import { VenueContextService } from '../agents/venue-context.service';
import { IsotonicCalibrationService } from '../agents/isotonic-calibration.service';
import { DirichletCalibrationService } from '../agents/dirichlet-calibration.service';
import { FormBasedNudgeService } from '../agents/form-based-nudge.service';
import { ClosingLineService } from '../agents/closing-line.service';
import { PiRatingService } from '../agents/pi-rating.service';
import { MetaBlenderService } from '../agents/meta-blender.service';
import { LineupRestFeaturesService } from '../agents/lineup-rest-features.service';
import { MatchInsightsService } from '../agents/match-insights.service';
import { MarketAnalysisService } from '../agents/market-analysis.service';
import { MatchContextService } from '../agents/match-context.service';
import { PolymarketService } from '../polymarket/polymarket.service';
import { BaseballService } from '../baseball/baseball.service';
import { BaseballTeamMapService } from '../baseball/baseball-team-map.service';
import { MlbStatsService } from '../baseball/mlb-stats.service';
import { StatcastService } from '../baseball/statcast.service';
import { BaseballMarketService } from '../baseball/baseball-market.service';
import { BaseballLeaguePriorsService } from '../baseball/baseball-league-priors.service';
import { BaseballRunModelService } from '../baseball/baseball-run-model.service';
import { BaseballResearchAgent } from '../baseball/agents/baseball-research.agent';
import { BaseballAnalysisAgent } from '../baseball/agents/baseball-analysis.agent';
import { BaseballCriticAgent } from '../baseball/agents/baseball-critic.agent';
import { BaseballPredictionService } from '../baseball/baseball-prediction.service';
import { BaseballBlenderService } from '../baseball/baseball-blender.service';
import { BaseballCalibrationService } from '../baseball/baseball-calibration.service';

// Handle both ESM default export and CJS module.exports for postgres
const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

function createDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const ssl = process.env.DATABASE_SSL === 'true' ? 'require' : false;
  const rawClient = (postgres as any)(connectionString, {
    ssl,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  // Drizzle calls client.unsafe(query, params) for every query. With prepare
  // disabled (which postgres-js's unsafe always sets), Date parameters reach
  // an internal Buffer.byteLength path that throws ERR_INVALID_ARG_TYPE
  // because the value isn't pre-serialized. Coerce Dates → ISO strings here
  // before postgres-js sees them. Also tee a .catch onto the query so the
  // underlying PG error is logged before Drizzle wraps it as the generic
  // "Failed query" error with no cause attached.
  const unsafeFn = rawClient.unsafe.bind(rawClient);
  rawClient.unsafe = (queryString: string, params?: unknown[], opts?: any) => {
    const safeParams = Array.isArray(params)
      ? params.map((p) => (p instanceof Date ? p.toISOString() : p))
      : params;
    const query = unsafeFn(queryString, safeParams, opts);
    query.catch((err: any) => {
      // eslint-disable-next-line no-console
      console.error('[postgres-js] query failed', {
        message: err?.message,
        code: err?.code,
        detail: err?.detail,
        hint: err?.hint,
        where: err?.where,
        severity: err?.severity_local ?? err?.severity,
        routine: err?.routine,
        query: String(queryString ?? '').slice(0, 300),
      });
    });
    return query;
  };

  return drizzle(rawClient, { schema });
}

function createConfigService(): ConfigService {
  // ConfigService reads from process.env when instantiated standalone
  return new ConfigService(process.env);
}

export interface Services {
  db: ReturnType<typeof createDb>;
  config: ConfigService;
  footballService: FootballService;
  basketballService: BasketballService;
  oddsService: OddsService;
  alertsService: AlertsService;
  perplexityService: PerplexityService;
  dataCollector: DataCollectorAgent;
  researchAgent: ResearchAgent;
  analysisAgent: AnalysisAgent;
  criticAgent: CriticAgent;
  firstPrinciplesAgent: FirstPrinciplesAgent;
  poissonModel: PoissonModelService;
  agentsService: AgentsService;
  syncService: SyncService;
  polymarketService: PolymarketService;
  polymarketDataService: PolymarketDataService;
  smartMoneySignalService: SmartMoneySignalService;
  copyTraderService: CopyTraderService;
  isotonicCalibrationService: IsotonicCalibrationService;
  dirichletCalibrationService: DirichletCalibrationService;
  piRatingService: PiRatingService;
  metaBlenderService: MetaBlenderService;
  lineupRestFeaturesService: LineupRestFeaturesService;
  // ── Baseball (MLB run-totals) ──
  baseballService: BaseballService;
  baseballTeamMap: BaseballTeamMapService;
  mlbStatsService: MlbStatsService;
  statcastService: StatcastService;
  baseballMarketService: BaseballMarketService;
  baseballRunModel: BaseballRunModelService;
  baseballPredictionService: BaseballPredictionService;
  baseballBlenderService: BaseballBlenderService;
  baseballCalibrationService: BaseballCalibrationService;
}

/**
 * Create all service instances needed by Trigger.dev tasks.
 * Call this at the start of each task run.
 */
export function initServices(): Services {
  const db = createDb();
  const config = createConfigService();

  const footballService = new FootballService(config, db as any);
  const basketballService = new BasketballService(config, db as any);
  const oddsService = new OddsService(config, db as any);
  const alertsService = new AlertsService(db as any);
  const perplexityService = new PerplexityService(config);

  const dataCollector = new DataCollectorAgent(
    db as any,
    footballService,
    oddsService,
  );
  const researchAgent = new ResearchAgent(perplexityService);
  const analysisAgent = new AnalysisAgent(config);
  const criticAgent = new CriticAgent(config);
  const firstPrinciplesAgent = new FirstPrinciplesAgent(config);
  const poissonModel = new PoissonModelService(db as any);
  const playerImpactService = new PlayerImpactService(db as any);

  const predictionMemory = new PredictionMemoryService(config);
  const leaguePriorsService = new LeaguePriorsService(db as any);
  const venueContextService = new VenueContextService(db as any);
  const isotonicCalibrationService = new IsotonicCalibrationService(db as any);
  const dirichletCalibrationService = new DirichletCalibrationService(db as any);
  const formBasedNudgeService = new FormBasedNudgeService();
  const closingLineService = new ClosingLineService(db as any);
  const piRatingService = new PiRatingService(db as any);
  const metaBlenderService = new MetaBlenderService(db as any);
  const lineupRestFeaturesService = new LineupRestFeaturesService(db as any);
  const matchInsightsService = new MatchInsightsService(
    db as any,
    footballService,
  );
  const marketAnalysisService = new MarketAnalysisService();
  const matchContextService = new MatchContextService(db as any);

  // Build Polymarket services up front so AgentsService can take
  // PolymarketService as a dependency (used for on-demand fixture linking
  // during prediction generation).
  const polymarketDataService = new PolymarketDataService();
  const smartMoneySignalService = new SmartMoneySignalService(
    polymarketDataService,
  );
  const polymarketGamma = new PolymarketGammaService(config);
  const polymarketClob = new PolymarketClobService(config);
  const polymarketMatcher = new PolymarketMatcherService(db as any);
  const polymarketTradingAgent = new PolymarketTradingAgent(config);
  const polymarketService = new PolymarketService(
    db as any,
    config,
    polymarketGamma,
    polymarketClob,
    polymarketMatcher,
    polymarketTradingAgent,
    smartMoneySignalService,
    polymarketDataService,
  );
  const copyTraderService = new CopyTraderService(
    db as any,
    polymarketDataService,
    polymarketClob,
    smartMoneySignalService,
  );

  const agentsService = new AgentsService(
    db as any,
    config,
    dataCollector,
    researchAgent,
    analysisAgent,
    criticAgent,
    firstPrinciplesAgent,
    poissonModel,
    playerImpactService,
    footballService,
    oddsService,
    alertsService,
    predictionMemory,
    leaguePriorsService,
    venueContextService,
    isotonicCalibrationService,
    dirichletCalibrationService,
    formBasedNudgeService,
    closingLineService,
    piRatingService,
    metaBlenderService,
    lineupRestFeaturesService,
    smartMoneySignalService,
    polymarketService,
    matchInsightsService,
    marketAnalysisService,
    matchContextService,
  );

  const syncService = new SyncService(
    db as any,
    config,
    footballService,
    oddsService,
  );

  // ── Baseball (MLB run-totals) ──
  const baseballTeamMap = new BaseballTeamMapService(db as any);
  const baseballService = new BaseballService(
    config,
    db as any,
    baseballTeamMap,
  );
  const mlbStatsService = new MlbStatsService(config);
  const statcastService = new StatcastService(
    config,
    db as any,
    baseballTeamMap,
  );
  const baseballMarketService = new BaseballMarketService(
    config,
    db as any,
    baseballTeamMap,
  );
  const baseballLeaguePriors = new BaseballLeaguePriorsService(db as any);
  const baseballRunModel = new BaseballRunModelService(
    baseballService,
    statcastService,
    baseballTeamMap,
    baseballLeaguePriors,
  );
  const baseballResearchAgent = new BaseballResearchAgent(config);
  const baseballAnalysisAgent = new BaseballAnalysisAgent(config);
  const baseballCriticAgent = new BaseballCriticAgent(config);
  const baseballBlenderService = new BaseballBlenderService(db as any);
  const baseballCalibrationService = new BaseballCalibrationService(db as any);
  const baseballPredictionService = new BaseballPredictionService(
    db as any,
    baseballService,
    mlbStatsService,
    statcastService,
    baseballTeamMap,
    baseballMarketService,
    baseballRunModel,
    baseballResearchAgent,
    baseballAnalysisAgent,
    baseballCriticAgent,
    baseballBlenderService,
    baseballCalibrationService,
  );

  return {
    db,
    config,
    footballService,
    basketballService,
    oddsService,
    alertsService,
    perplexityService,
    dataCollector,
    researchAgent,
    analysisAgent,
    criticAgent,
    firstPrinciplesAgent,
    poissonModel,
    agentsService,
    syncService,
    polymarketService,
    polymarketDataService,
    smartMoneySignalService,
    copyTraderService,
    isotonicCalibrationService,
    dirichletCalibrationService,
    piRatingService,
    metaBlenderService,
    lineupRestFeaturesService,
    baseballService,
    baseballTeamMap,
    mlbStatsService,
    statcastService,
    baseballMarketService,
    baseballRunModel,
    baseballPredictionService,
    baseballBlenderService,
    baseballCalibrationService,
  };
}
