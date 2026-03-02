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
import { generatePredictionTask } from '../trigger/generate-prediction';
import { generateDailyPredictionsTask } from '../trigger/generate-daily-predictions';
import {
  resolvePredictionsTask,
  syncCompletedFixturesAndResolveTask,
} from '../trigger/sync-and-resolve';

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
    summary:
      'Trigger an on-demand prediction for a specific fixture (runs as background task)',
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
      `Triggering prediction task for fixture ${fixtureId} (type: ${predictionType})`,
    );

    const handle = await generatePredictionTask.trigger({
      fixtureId,
      predictionType,
    });

    return {
      message: `Prediction task triggered for fixture ${fixtureId}`,
      taskRunId: handle.id,
      fixtureId,
      predictionType,
    };
  }

  @Post('generate-daily')
  @ApiOperation({
    summary:
      'Trigger daily predictions for all upcoming fixtures (runs as background task)',
  })
  async generateDailyPredictions() {
    this.logger.log('Triggering daily prediction generation via API');

    const handle = await generateDailyPredictionsTask.trigger(
      undefined as void,
    );

    return {
      message: 'Daily prediction generation task triggered',
      taskRunId: handle.id,
    };
  }

  @Post('resolve')
  @ApiOperation({
    summary:
      'Trigger prediction resolution for finished matches (runs as background task)',
  })
  async resolvePredictions() {
    this.logger.log('Triggering prediction resolution via API');

    const handle = await resolvePredictionsTask.trigger(undefined as void);

    return {
      message: 'Prediction resolution task triggered',
      taskRunId: handle.id,
    };
  }

  @Post('sync-and-resolve')
  @ApiOperation({
    summary:
      'Trigger completed fixture sync + prediction resolution (runs as background task)',
  })
  async syncAndResolve() {
    this.logger.log('Triggering completed fixtures sync + resolve via API');

    const handle = await syncCompletedFixturesAndResolveTask.trigger(
      undefined as void,
    );

    return {
      message: 'Sync and resolve task triggered',
      taskRunId: handle.id,
    };
  }
}
