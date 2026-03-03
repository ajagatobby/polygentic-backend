import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlertsModule } from '../alerts/alerts.module';
import { OddsModule } from '../odds/odds.module';
import { FootballService } from './football.service';
import { FootballController } from './football.controller';
import { LiveScoreService } from './live/live-score.service';
import { LiveScoreGateway } from './live/live-score.gateway';
import { LiveEventHandler } from './live/live-event-handler';

@Module({
  imports: [ConfigModule, AlertsModule, OddsModule],
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
