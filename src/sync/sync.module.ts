import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FootballModule } from '../football/football.module';
import { OddsModule } from '../odds/odds.module';
import { AgentsModule } from '../agents/agents.module';
import { SyncService } from './sync.service';
import { SyncScheduler } from './sync.scheduler';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    FootballModule,
    OddsModule,
    AgentsModule,
  ],
  providers: [SyncService, SyncScheduler],
  exports: [SyncService],
})
export class SyncModule {}
