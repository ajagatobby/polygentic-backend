import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { FootballModule } from './football/football.module';
import { OddsModule } from './odds/odds.module';
import { AlertsModule } from './alerts/alerts.module';
import { AgentsModule } from './agents/agents.module';
import { SyncModule } from './sync/sync.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { UserThrottlerGuard } from './auth/user-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),

    // Rate limiting: per-user (UID) for authenticated requests,
    // per-IP for public routes. Three tiers:
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000, // 1 second window
        limit: 5, // max 5 requests per second
      },
      {
        name: 'medium',
        ttl: 60000, // 1 minute window
        limit: 60, // max 60 requests per minute
      },
      {
        name: 'long',
        ttl: 3600000, // 1 hour window
        limit: 500, // max 500 requests per hour
      },
    ]),

    AuthModule,
    DatabaseModule,
    FootballModule,
    OddsModule,
    AlertsModule,
    AgentsModule,
    SyncModule,
    HealthModule,
  ],
  providers: [
    // Apply per-user rate limiting globally
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
})
export class AppModule {}
