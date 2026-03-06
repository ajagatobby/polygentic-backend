import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BasketballService } from './basketball.service';
import { BasketballController } from './basketball.controller';
import { BasketballLiveScoreService } from './live/live-score.service';
import { BasketballLiveScoreGateway } from './live/live-score.gateway';
import { BasketballLiveEventHandler } from './live/live-event-handler';

@Module({
  imports: [ConfigModule],
  controllers: [BasketballController],
  providers: [
    BasketballService,
    BasketballLiveScoreService,
    BasketballLiveScoreGateway,
    BasketballLiveEventHandler,
  ],
  exports: [BasketballService, BasketballLiveScoreService],
})
export class BasketballModule {}
