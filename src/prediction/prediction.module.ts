import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PredictionService } from './prediction.service';
import { MispricingService } from './mispricing.service';
import { StatisticalModelService } from './statistical-model.service';
import { ConfidenceService } from './confidence.service';
import { PredictionController } from './prediction.controller';

@Module({
  imports: [ConfigModule],
  controllers: [PredictionController],
  providers: [
    PredictionService,
    MispricingService,
    StatisticalModelService,
    ConfidenceService,
  ],
  exports: [
    PredictionService,
    MispricingService,
    StatisticalModelService,
    ConfidenceService,
  ],
})
export class PredictionModule {}
