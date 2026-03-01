import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OddsService } from './odds.service';
import { OddsController } from './odds.controller';
import { ProbabilityUtil } from './probability.util';

@Module({
  imports: [ConfigModule],
  controllers: [OddsController],
  providers: [OddsService, ProbabilityUtil],
  exports: [OddsService, ProbabilityUtil],
})
export class OddsModule {}
