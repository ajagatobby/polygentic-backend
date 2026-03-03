import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FootballModule } from '../football/football.module';
import { OddsModule } from '../odds/odds.module';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [ConfigModule, FootballModule, OddsModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
