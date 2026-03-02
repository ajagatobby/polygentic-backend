import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { FootballModule } from './football/football.module';
import { OddsModule } from './odds/odds.module';
import { AlertsModule } from './alerts/alerts.module';
import { AgentsModule } from './agents/agents.module';
import { SyncModule } from './sync/sync.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    DatabaseModule,
    FootballModule,
    OddsModule,
    AlertsModule,
    AgentsModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}
