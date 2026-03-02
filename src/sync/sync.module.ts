import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FootballModule } from '../football/football.module';
import { OddsModule } from '../odds/odds.module';
import { SyncService } from './sync.service';
import { SyncScheduler } from './sync.scheduler';

@Module({
  imports: [ConfigModule, ScheduleModule.forRoot(), FootballModule, OddsModule],
  providers: [SyncService, SyncScheduler],
  exports: [SyncService],
})
export class SyncModule {}
