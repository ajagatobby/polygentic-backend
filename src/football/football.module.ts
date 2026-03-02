import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlertsModule } from '../alerts/alerts.module';
import { FootballService } from './football.service';
import { FootballController } from './football.controller';
import { LiveScoreService } from './live/live-score.service';
import { LiveScoreGateway } from './live/live-score.gateway';
import { LiveEventHandler } from './live/live-event-handler';

@Module({
  imports: [ConfigModule, AlertsModule],
  controllers: [FootballController],
  providers: [
    FootballService,
    LiveScoreService,
    LiveScoreGateway,
    LiveEventHandler,
  ],
  exports: [FootballService, LiveScoreService],
})
export class FootballModule {}
