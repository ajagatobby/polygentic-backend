import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FootballModule } from '../football/football.module';
import { OddsModule } from '../odds/odds.module';
import { AlertsModule } from '../alerts/alerts.module';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { PerplexityService } from './perplexity.service';
import { DataCollectorAgent } from './data-collector.agent';
import { ResearchAgent } from './research.agent';
import { AnalysisAgent } from './analysis.agent';
import { CriticAgent } from './critic.agent';
import { FirstPrinciplesAgent } from './first-principles.agent';
import { PoissonModelService } from './poisson-model.service';
import { PlayerImpactService } from './player-impact.service';
import { PredictionMemoryService } from './prediction-memory.service';
import { LeaguePriorsService } from './league-priors.service';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';

@Module({
  imports: [
    ConfigModule,
    FootballModule,
    OddsModule,
    AlertsModule,
    PolymarketModule,
  ],
  controllers: [AgentsController],
  providers: [
    PerplexityService,
    DataCollectorAgent,
    ResearchAgent,
    AnalysisAgent,
    CriticAgent,
    FirstPrinciplesAgent,
    PoissonModelService,
    PlayerImpactService,
    PredictionMemoryService,
    LeaguePriorsService,
    AgentsService,
  ],
  exports: [AgentsService],
})
export class AgentsModule {}
