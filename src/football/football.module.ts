import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FootballService } from './football.service';
import { FootballController } from './football.controller';
import { LiveScoreService } from './live/live-score.service';
import { LiveScoreGateway } from './live/live-score.gateway';

@Module({
  imports: [ConfigModule],
  controllers: [FootballController],
  providers: [FootballService, LiveScoreService, LiveScoreGateway],
  exports: [FootballService, LiveScoreService],
})
export class FootballModule {}
