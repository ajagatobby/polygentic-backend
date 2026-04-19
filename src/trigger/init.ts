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
import { PredictionMemoryService } from '../agents/prediction-memory.service';
import { LeaguePriorsService } from '../agents/league-priors.service';
import { PolymarketService } from '../polymarket/polymarket.service';

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
    smartMoneySignalService,
    polymarketService,
  );

  const syncService = new SyncService(
    db as any,
    config,
    footballService,
    oddsService,
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
  };
}
