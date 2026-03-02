import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AgentsService, PredictionType } from './agents.service';
import { PredictionQueryDto } from './dto/prediction-query.dto';

@ApiTags('Predictions')
@Controller('api/predictions')
export class AgentsController {
  private readonly logger = new Logger(AgentsController.name);

  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get predictions with optional filters' })
  async getPredictions(@Query() query: PredictionQueryDto) {
    return this.agentsService.getPredictions({
      predictionType: query.predictionType,
      leagueId: query.leagueId,
      minConfidence: query.minConfidence,
      date: query.date,
      unresolved: query.unresolved === 'true',
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('accuracy')
  @ApiOperation({ summary: 'Get prediction accuracy statistics' })
  async getAccuracy() {
    return this.agentsService.getAccuracyStats();
  }

  @Get(':fixtureId')
  @ApiOperation({ summary: 'Get predictions for a specific fixture' })
  @ApiParam({ name: 'fixtureId', type: Number })
  async getPredictionsByFixture(
    @Param('fixtureId', ParseIntPipe) fixtureId: number,
  ) {
    const predictions =
      await this.agentsService.getPredictionByFixtureId(fixtureId);

    if (predictions.length === 0) {
      throw new NotFoundException(
        `No predictions found for fixture ${fixtureId}`,
      );
    }

    return predictions;
  }

  @Post('generate/:fixtureId')
  @ApiOperation({
    summary: 'Generate an on-demand prediction for a specific fixture',
  })
  @ApiParam({ name: 'fixtureId', type: Number })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['daily', 'pre_match', 'on_demand'],
    description: 'Prediction type (defaults to on_demand)',
  })
  async generatePrediction(
    @Param('fixtureId', ParseIntPipe) fixtureId: number,
    @Query('type') type?: string,
  ) {
    const predictionType = (type as PredictionType) || 'on_demand';
    this.logger.log(
      `On-demand prediction requested for fixture ${fixtureId} (type: ${predictionType})`,
    );

    return this.agentsService.generatePrediction(fixtureId, predictionType);
  }

  @Post('generate-daily')
  @ApiOperation({
    summary:
      'Generate daily predictions for all upcoming fixtures (next 48 hours)',
  })
  async generateDailyPredictions() {
    this.logger.log('Daily prediction generation triggered via API');
    return this.agentsService.generateDailyPredictions();
  }

  @Post('resolve')
  @ApiOperation({
    summary: 'Resolve predictions for finished matches (compute accuracy)',
  })
  async resolvePredictions() {
    return this.agentsService.resolvePredictions();
  }
}
