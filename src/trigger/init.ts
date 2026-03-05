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
import { OddsService } from '../odds/odds.service';
import { AlertsService } from '../alerts/alerts.service';
import { PerplexityService } from '../agents/perplexity.service';
import { DataCollectorAgent } from '../agents/data-collector.agent';
import { ResearchAgent } from '../agents/research.agent';
import { AnalysisAgent } from '../agents/analysis.agent';
import { PoissonModelService } from '../agents/poisson-model.service';
import { AgentsService } from '../agents/agents.service';
import { SyncService } from '../sync/sync.service';
import { PolymarketGammaService } from '../polymarket/services/polymarket-gamma.service';
import { PolymarketClobService } from '../polymarket/services/polymarket-clob.service';
import { PolymarketMatcherService } from '../polymarket/services/polymarket-matcher.service';
import { PolymarketTradingAgent } from '../polymarket/services/polymarket-trading.agent';
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
  const client = (postgres as any)(connectionString, {
    ssl,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema });
}

function createConfigService(): ConfigService {
  // ConfigService reads from process.env when instantiated standalone
  return new ConfigService(process.env);
}

export interface Services {
  db: ReturnType<typeof createDb>;
  config: ConfigService;
  footballService: FootballService;
  oddsService: OddsService;
  alertsService: AlertsService;
  perplexityService: PerplexityService;
  dataCollector: DataCollectorAgent;
  researchAgent: ResearchAgent;
  analysisAgent: AnalysisAgent;
  poissonModel: PoissonModelService;
  agentsService: AgentsService;
  syncService: SyncService;
  polymarketService: PolymarketService;
}

/**
 * Create all service instances needed by Trigger.dev tasks.
 * Call this at the start of each task run.
 */
export function initServices(): Services {
  const db = createDb();
  const config = createConfigService();

  const footballService = new FootballService(config, db as any);
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
  const poissonModel = new PoissonModelService(db as any);

  const agentsService = new AgentsService(
    db as any,
    config,
    dataCollector,
    researchAgent,
    analysisAgent,
    poissonModel,
    footballService,
    oddsService,
    alertsService,
  );

  const syncService = new SyncService(
    db as any,
    config,
    footballService,
    oddsService,
  );

  // Polymarket trading agent services
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
  );

  return {
    db,
    config,
    footballService,
    oddsService,
    alertsService,
    perplexityService,
    dataCollector,
    researchAgent,
    analysisAgent,
    poissonModel,
    agentsService,
    syncService,
    polymarketService,
  };
}
