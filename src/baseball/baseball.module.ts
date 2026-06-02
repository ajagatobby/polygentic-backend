import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BaseballService } from './baseball.service';
import { BaseballTeamMapService } from './baseball-team-map.service';
import { MlbStatsService } from './mlb-stats.service';
import { StatcastService } from './statcast.service';
import { BaseballMarketService } from './baseball-market.service';
import { BaseballLeaguePriorsService } from './baseball-league-priors.service';
import { BaseballRunModelService } from './baseball-run-model.service';
import { BaseballResearchAgent } from './agents/baseball-research.agent';
import { BaseballAnalysisAgent } from './agents/baseball-analysis.agent';
import { BaseballCriticAgent } from './agents/baseball-critic.agent';
import { BaseballPredictionService } from './baseball-prediction.service';
import { BaseballController } from './baseball.controller';

/**
 * MLB run-totals (over/under) module. Phase 0 data foundation: API-Sports
 * games + MLB StatsAPI probables + Statcast true-talent + sharp market.
 * The prediction model, agents, and orchestration (Phases 1-2) are added
 * as additional providers here.
 */
@Module({
  imports: [ConfigModule],
  controllers: [BaseballController],
  providers: [
    BaseballTeamMapService,
    BaseballService,
    MlbStatsService,
    StatcastService,
    BaseballMarketService,
    BaseballLeaguePriorsService,
    BaseballRunModelService,
    BaseballResearchAgent,
    BaseballAnalysisAgent,
    BaseballCriticAgent,
    BaseballPredictionService,
  ],
  exports: [
    BaseballTeamMapService,
    BaseballService,
    MlbStatsService,
    StatcastService,
    BaseballMarketService,
    BaseballLeaguePriorsService,
    BaseballRunModelService,
    BaseballResearchAgent,
    BaseballAnalysisAgent,
    BaseballCriticAgent,
    BaseballPredictionService,
  ],
})
export class BaseballModule {}
