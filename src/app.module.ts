import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { PolymarketModule } from './polymarket/polymarket.module';
import { FootballModule } from './football/football.module';
import { OddsModule } from './odds/odds.module';
import { MatcherModule } from './matcher/matcher.module';
import { PredictionModule } from './prediction/prediction.module';
import { AlertsModule } from './alerts/alerts.module';
import { SyncModule } from './sync/sync.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    DatabaseModule,
    PolymarketModule,
    FootballModule,
    OddsModule,
    MatcherModule,
    PredictionModule,
    AlertsModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}
