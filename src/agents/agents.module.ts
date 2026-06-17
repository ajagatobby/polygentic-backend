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
import { VenueContextService } from './venue-context.service';
import { IsotonicCalibrationService } from './isotonic-calibration.service';
import { DirichletCalibrationService } from './dirichlet-calibration.service';
import { ClosingLineService } from './closing-line.service';
import { PiRatingService } from './pi-rating.service';
import { MetaBlenderService } from './meta-blender.service';
import { LineupRestFeaturesService } from './lineup-rest-features.service';
import { FormBasedNudgeService } from './form-based-nudge.service';
import { MatchInsightsService } from './match-insights.service';
import { MarketAnalysisService } from './market-analysis.service';
import { MatchContextService } from './match-context.service';
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
    VenueContextService,
    IsotonicCalibrationService,
    DirichletCalibrationService,
    ClosingLineService,
    PiRatingService,
    MetaBlenderService,
    LineupRestFeaturesService,
    FormBasedNudgeService,
    MatchInsightsService,
    MarketAnalysisService,
    MatchContextService,
    AgentsService,
  ],
  exports: [AgentsService],
})
export class AgentsModule {}
