import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { FootballModule } from '../football/football.module';
import { OddsModule } from '../odds/odds.module';
import { MatcherModule } from '../matcher/matcher.module';
import { PredictionModule } from '../prediction/prediction.module';
import { SyncService } from './sync.service';
import { SyncScheduler } from './sync.scheduler';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    PolymarketModule,
    FootballModule,
    OddsModule,
    MatcherModule,
    PredictionModule,
  ],
  providers: [SyncService, SyncScheduler],
  exports: [SyncService],
})
export class SyncModule {}
