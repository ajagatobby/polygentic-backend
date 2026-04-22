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
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { AgentsService, PredictionType } from './agents.service';
import { PredictionQueryDto } from './dto/prediction-query.dto';
import { generatePredictionTask } from '../trigger/generate-prediction';
import {
  generateDailyPredictionsTask,
  generateTodayPredictionsTask,
} from '../trigger/generate-daily-predictions';
import {
  resolvePredictionsTask,
  syncCompletedFixturesAndResolveTask,
} from '../trigger/sync-and-resolve';
import { rerunPredictionsTask } from '../trigger/rerun-predictions';
import { testFailedPredictionsTask } from '../trigger/test-failed-predictions';

@ApiTags('Predictions')
@ApiBearerAuth('firebase-auth')
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

  @Get('insights')
  @ApiOperation({
    summary:
      'Get data-driven prediction pattern insights (OpenAI-powered analytics)',
    description:
      'Analyzes resolved predictions to surface trend shifts, strongest/weakest leagues, ' +
      'confidence calibration patterns, and retest improvement signals.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['daily', 'pre_match', 'on_demand'],
    description: 'Optional prediction type filter',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description:
      'How many most-recent resolved predictions to analyze (50-2000)',
  })
  @ApiQuery({
    name: 'minLeagueSample',
    required: false,
    type: Number,
    description:
      'Minimum resolved predictions required for a league to be included in best/worst league ranking',
  })
  async getInsights(
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('minLeagueSample') minLeagueSample?: string,
  ) {
    const predictionType = type as PredictionType | undefined;
    return this.agentsService.getPredictionInsights({
      predictionType,
      limit: limit ? Number(limit) : undefined,
      minLeagueSample: minLeagueSample ? Number(minLeagueSample) : undefined,
    });
  }

  @Get('bullish')
  @ApiOperation({
    summary:
      'Get predictions the model is most bullish on — ranked by confidence, dominant probability, and value edge',
    description:
      'Returns upcoming unresolved predictions sorted by a composite "bullish score" combining ' +
      'confidence (1-10), dominant outcome probability, and value edge vs bookmaker odds. ' +
      'Includes team details, lineups, and injuries.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max predictions to return (default: 10)',
  })
  @ApiQuery({
    name: 'minConfidence',
    required: false,
    type: Number,
    description: 'Minimum confidence threshold 1-10 (default: 6)',
  })
  @ApiQuery({
    name: 'minDominantProb',
    required: false,
    type: Number,
    description: 'Minimum dominant outcome probability 0-1 (default: 0.45)',
  })
  async getBullishPredictions(
    @Query('limit') limit?: string,
    @Query('minConfidence') minConfidence?: string,
    @Query('minDominantProb') minDominantProb?: string,
  ) {
    const picks = await this.agentsService.getBullishPredictions({
      limit: limit ? Number(limit) : undefined,
      minConfidence: minConfidence ? Number(minConfidence) : undefined,
      minDominantProb: minDominantProb ? Number(minDominantProb) : undefined,
    });

    return {
      data: picks,
      count: picks.length,
      description:
        'Predictions ranked by bullish score (confidence + dominant probability + value edge)',
    };
  }

  @Get('performance-feedback')
  @ApiOperation({
    summary:
      'Get detailed performance feedback including bias analysis, confidence calibration, and league breakdown',
  })
  async getPerformanceFeedback() {
    const feedback = await this.agentsService.getPerformanceFeedback();
    if (!feedback) {
      return {
        message:
          'Not enough resolved predictions yet (need at least 10). Keep generating and resolving predictions.',
        totalResolved: 0,
      };
    }
    return feedback;
  }

  @Get('daily-breakdown')
  @ApiOperation({
    summary:
      'Get a detailed breakdown of prediction performance for today or a given day',
    description:
      'Returns summary stats (total, correct, incorrect, pending, accuracy, avg confidence, avg Brier score), ' +
      'a breakdown by predicted result (home_win, draw, away_win), and each individual prediction with ' +
      'match info, predicted vs actual result, correctness, and a link to the Polymarket game if one exists.',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'Date to get breakdown for (YYYY-MM-DD). Defaults to today.',
  })
  @ApiQuery({
    name: 'day',
    required: false,
    type: String,
    description: 'Alias for date (YYYY-MM-DD). Defaults to today.',
  })
  async getDailyBreakdown(
    @Query('date') date?: string,
    @Query('day') day?: string,
  ) {
    const target = date || day || undefined;
    return this.agentsService.getDailyBreakdown(target);
  }

  @Get('today')
  @ApiOperation({
    summary: "Get predictions for today's football matches",
    description:
      'Returns predictions joined with fixture data, filtered by the actual match date (today). ' +
      'Supports league, confidence, and resolution filters. ' +
      'Each result includes the fixture, both teams, and the best prediction.',
  })
  @ApiQuery({
    name: 'leagueId',
    required: false,
    type: Number,
    description: 'Filter by league ID',
  })
  @ApiQuery({
    name: 'leagueName',
    required: false,
    type: String,
    description: 'Filter by league name (partial, case-insensitive)',
  })
  @ApiQuery({
    name: 'minConfidence',
    required: false,
    type: Number,
    description: 'Minimum confidence threshold (1-10)',
  })
  @ApiQuery({
    name: 'unresolved',
    required: false,
    type: String,
    description: 'Only show unresolved predictions (true/false)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 50, max: 100)',
  })
  async getTodayPredictions(
    @Query('leagueId') leagueId?: string,
    @Query('leagueName') leagueName?: string,
    @Query('minConfidence') minConfidence?: string,
    @Query('unresolved') unresolved?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.agentsService.getPredictionsByMatchDate({
      leagueId: leagueId ? Number(leagueId) : undefined,
      leagueName: leagueName || undefined,
      minConfidence: minConfidence ? Number(minConfidence) : undefined,
      unresolved: unresolved === 'true',
      page: page ? Number(page) : 1,
      limit: limit ? Math.min(Number(limit), 100) : 50,
    });
  }

  @Get('upcoming')
  @ApiOperation({
    summary: 'Get predictions for upcoming football matches',
    description:
      'Returns predictions for matches within a date range. Use `days` for a quick window ' +
      '(e.g. days=2 = today + next 2 days), or `from`/`to` for a custom range. ' +
      'Defaults to the next 7 days if no date params are provided.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description:
      'Number of days ahead from today (e.g. 2 = today through 2 days from now). ' +
      'Overridden by from/to if both are provided.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'End date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'Single date (YYYY-MM-DD). Overridden by from/to or days.',
  })
  @ApiQuery({
    name: 'leagueId',
    required: false,
    type: Number,
    description: 'Filter by league ID',
  })
  @ApiQuery({
    name: 'leagueName',
    required: false,
    type: String,
    description: 'Filter by league name (partial, case-insensitive)',
  })
  @ApiQuery({
    name: 'minConfidence',
    required: false,
    type: Number,
    description: 'Minimum confidence threshold (1-10)',
  })
  @ApiQuery({
    name: 'unresolved',
    required: false,
    type: String,
    description: 'Only show unresolved predictions (true/false)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 50, max: 100)',
  })
  async getUpcomingPredictions(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('date') date?: string,
    @Query('leagueId') leagueId?: string,
    @Query('leagueName') leagueName?: string,
    @Query('minConfidence') minConfidence?: string,
    @Query('unresolved') unresolved?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.agentsService.getPredictionsByMatchDate({
      days: days ? Number(days) : from || to || date ? undefined : 7,
      from: from || undefined,
      to: to || undefined,
      date: date || undefined,
      leagueId: leagueId ? Number(leagueId) : undefined,
      leagueName: leagueName || undefined,
      minConfidence: minConfidence ? Number(minConfidence) : undefined,
      unresolved: unresolved === 'true',
      page: page ? Number(page) : 1,
      limit: limit ? Math.min(Number(limit), 100) : 50,
    });
  }

  @Roles('admin')
  @Post('rerun')
  @ApiOperation({
    summary:
      '[Admin] Re-run predictions for all fixtures on a given date (overwrites existing predictions)',
    description:
      'Clears resolution data on existing predictions, then re-generates predictions ' +
      'for every fixture on the specified date. Uses the upsert behaviour to overwrite. ' +
      'Optionally scope to specific fixture IDs or a different prediction type.',
  })
  @ApiQuery({
    name: 'date',
    required: true,
    type: String,
    description: 'Date to re-run predictions for (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['daily', 'pre_match', 'on_demand'],
    description: 'Which prediction type to overwrite (defaults to daily)',
  })
  @ApiQuery({
    name: 'fixtureIds',
    required: false,
    type: String,
    description:
      'Comma-separated fixture IDs to scope the re-run (e.g. 123,456). If omitted, all fixtures on the date are re-run.',
  })
  async rerunPredictions(
    @Query('date') date: string,
    @Query('type') type?: string,
    @Query('fixtureIds') fixtureIds?: string,
  ) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        error: 'A valid date query parameter is required (YYYY-MM-DD)',
      };
    }

    const predictionType = (type as PredictionType) || 'daily';
    const parsedFixtureIds = fixtureIds
      ? fixtureIds
          .split(',')
          .map((id) => Number(id.trim()))
          .filter((id) => !isNaN(id))
      : undefined;

    this.logger.log(
      `Triggering prediction re-run for ${date} (type: ${predictionType}, fixtures: ${parsedFixtureIds?.length ?? 'all'})`,
    );

    const handle = await rerunPredictionsTask.trigger({
      date,
      predictionType,
      fixtureIds: parsedFixtureIds,
    });

    return {
      message: `Prediction re-run triggered for ${date}`,
      taskRunId: handle.id,
      date,
      predictionType,
      fixtureIds: parsedFixtureIds ?? 'all',
    };
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

  @Roles('admin')
  @Post('generate/:fixtureId')
  @ApiOperation({
    summary:
      '[Admin] Trigger an on-demand prediction for a specific fixture (runs as background task)',
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

  @Roles('admin')
  @Post('generate-today')
  @ApiOperation({
    summary:
      "[Admin] Generate predictions for today's fixtures only (runs as background task)",
    description:
      "Finds all fixtures scheduled for today (UTC) that don't have predictions yet " +
      'and generates them. Use ?force=true to regenerate predictions even if they already exist.',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: String,
    description:
      'Force regenerate predictions even if they already exist (true/false, default: false)',
  })
  async generateTodayPredictions(@Query('force') force?: string) {
    const forceFlag = force === 'true';
    this.logger.log(
      `Triggering today's prediction generation via API (force: ${forceFlag})`,
    );

    const handle = await generateTodayPredictionsTask.trigger({
      force: forceFlag,
    });

    return {
      message: "Today's prediction generation task triggered",
      taskRunId: handle.id,
      force: forceFlag,
    };
  }

  @Roles('admin')
  @Post('generate-daily')
  @ApiOperation({
    summary:
      '[Admin] Trigger daily predictions for all upcoming fixtures in the next 48h (runs as background task)',
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

  @Roles('admin')
  @Post('test-failed')
  @ApiOperation({
    summary:
      '[Admin] Trigger failed-prediction retest run (writes to prediction_tests table)',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['daily', 'pre_match', 'on_demand'],
    description: 'Prediction type slot to retest (default: daily)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max failed predictions to retest (default: 20, max: 200)',
  })
  @ApiQuery({
    name: 'fixtureIds',
    required: false,
    type: String,
    description:
      'Optional comma-separated fixture IDs to scope retest (e.g. 101,102,103)',
  })
  async testFailedPredictions(
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('fixtureIds') fixtureIds?: string,
  ) {
    const predictionType = (type as PredictionType) || 'daily';
    const parsedLimit = limit ? Math.min(Math.max(Number(limit), 1), 200) : 20;

    const parsedFixtureIds = fixtureIds
      ? fixtureIds
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : undefined;

    this.logger.log(
      `Triggering failed-prediction test task (type=${predictionType}, limit=${parsedLimit}, fixtureIds=${parsedFixtureIds?.join(',') ?? 'all'})`,
    );

    const handle = await testFailedPredictionsTask.trigger({
      predictionType,
      limit: parsedLimit,
      fixtureIds: parsedFixtureIds,
    });

    return {
      message: 'Failed-prediction test task triggered',
      taskRunId: handle.id,
      predictionType,
      limit: parsedLimit,
      fixtureIds: parsedFixtureIds ?? 'all',
    };
  }

  @Roles('admin')
  @Post('resolve')
  @ApiOperation({
    summary:
      '[Admin] Trigger prediction resolution for finished matches (runs as background task)',
  })
  async resolvePredictions() {
    this.logger.log('Triggering prediction resolution via API');

    const handle = await resolvePredictionsTask.trigger(undefined as void);

    return {
      message: 'Prediction resolution task triggered',
      taskRunId: handle.id,
    };
  }

  @Roles('admin')
  @Post('sync-and-resolve')
  @ApiOperation({
    summary:
      '[Admin] Trigger completed fixture sync + prediction resolution (runs as background task)',
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
