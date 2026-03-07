import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import {
  BasketballService,
  TRACKED_BASKETBALL_LEAGUES,
} from './basketball.service';
import { BasketballLiveScoreService } from './live/live-score.service';
import {
  BasketballFixtureQueryDto,
  BasketballSyncFixturesDto,
  BasketballLeagueQueryDto,
} from './dto/fixture-query.dto';

@ApiTags('Basketball')
@ApiBearerAuth('firebase-auth')
@Controller('api/basketball')
export class BasketballController {
  private readonly logger = new Logger(BasketballController.name);

  constructor(
    private readonly basketballService: BasketballService,
    private readonly liveScoreService: BasketballLiveScoreService,
  ) {}

  // ─── FIXTURES ────────────────────────────────────────────────────────

  @Get('fixtures')
  @ApiOperation({
    summary: 'List basketball fixtures with optional filters and pagination',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of fixtures' })
  async getFixtures(@Query() query: BasketballFixtureQueryDto) {
    try {
      return await this.basketballService.getFixtures(query);
    } catch (error) {
      this.logger.error(`Failed to get basketball fixtures: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to retrieve basketball fixtures',
      );
    }
  }

  @Roles('admin')
  @Post('fixtures/live/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Start basketball live match monitoring' })
  @ApiResponse({ status: 200, description: 'Monitoring started' })
  startLiveMonitoring() {
    this.liveScoreService.startMonitoring();
    return {
      success: true,
      message: 'Basketball live monitoring started',
      activeGames: this.liveScoreService.getActiveGames().length,
    };
  }

  @Roles('admin')
  @Post('fixtures/live/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Stop basketball live match monitoring' })
  @ApiResponse({ status: 200, description: 'Monitoring stopped' })
  stopLiveMonitoring() {
    this.liveScoreService.stopMonitoring();
    return {
      success: true,
      message: 'Basketball live monitoring stopped',
    };
  }

  @Get('fixtures/today')
  @ApiOperation({
    summary: "Get today's basketball fixtures with team details",
    description:
      'Filter by state: upcoming (not started), live (in play), finished (completed), cancelled. ' +
      'Or use exact status codes: NS, Q1, Q2, Q3, Q4, OT, FT, etc. ' +
      'Also supports filtering by league name, country, team, club name search.',
  })
  @ApiResponse({
    status: 200,
    description: "Today's basketball fixtures with team details",
  })
  async getTodayFixtures(
    @Query('leagueId') leagueId?: string,
    @Query('leagueName') leagueName?: string,
    @Query('leagueCountry') leagueCountry?: string,
    @Query('status') status?: string,
    @Query('state') state?: string,
    @Query('teamId') teamId?: string,
    @Query('club') club?: string,
    @Query('date') date?: string,
  ) {
    try {
      const data = await this.basketballService.getTodayFixtures({
        leagueId: leagueId ? Number(leagueId) : undefined,
        leagueName,
        leagueCountry,
        status,
        state,
        teamId: teamId ? Number(teamId) : undefined,
        club,
        date,
      });

      return {
        data,
        count: data.length,
        date: date ?? new Date().toISOString().split('T')[0],
        filters: {
          leagueId: leagueId ? Number(leagueId) : null,
          leagueName: leagueName ?? null,
          leagueCountry: leagueCountry ?? null,
          status: status ?? null,
          state: state ?? null,
          teamId: teamId ? Number(teamId) : null,
          club: club ?? null,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to get today's basketball fixtures: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Failed to retrieve today's basketball fixtures",
      );
    }
  }

  @Get('fixtures/upcoming')
  @ApiOperation({
    summary: 'Get upcoming basketball fixtures',
    description:
      'Returns fixtures from today onwards (or a custom date range). ' +
      'Supports all the same filters as /fixtures/today plus from/to date range.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upcoming basketball fixtures with team details',
  })
  async getUpcomingFixtures(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('date') date?: string,
    @Query('leagueId') leagueId?: string,
    @Query('leagueName') leagueName?: string,
    @Query('leagueCountry') leagueCountry?: string,
    @Query('status') status?: string,
    @Query('state') state?: string,
    @Query('teamId') teamId?: string,
    @Query('club') club?: string,
  ) {
    try {
      const defaultFrom =
        from ?? date ?? new Date().toISOString().split('T')[0];
      const defaultTo =
        to ??
        (date
          ? undefined
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0]);

      const data = await this.basketballService.getTodayFixtures({
        from: defaultFrom,
        to: defaultTo,
        leagueId: leagueId ? Number(leagueId) : undefined,
        leagueName,
        leagueCountry,
        status: status ?? 'NS',
        state,
        teamId: teamId ? Number(teamId) : undefined,
        club,
      });

      return {
        data,
        count: data.length,
        filters: {
          from: defaultFrom,
          to: defaultTo ?? null,
          leagueId: leagueId ? Number(leagueId) : null,
          leagueName: leagueName ?? null,
          leagueCountry: leagueCountry ?? null,
          status: status ?? 'NS',
          state: state ?? null,
          teamId: teamId ? Number(teamId) : null,
          club: club ?? null,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to get upcoming basketball fixtures: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve upcoming basketball fixtures',
      );
    }
  }

  @Get('fixtures/live')
  @ApiOperation({
    summary: 'Get currently live basketball games',
  })
  @ApiResponse({ status: 200, description: 'List of live basketball games' })
  async getLiveFixtures() {
    try {
      const activeGames = this.liveScoreService.getActiveGames();

      if (activeGames.length > 0) {
        return {
          data: activeGames,
          count: activeGames.length,
          source: 'live-monitor',
        };
      }

      // No active monitoring — fetch directly from API
      const liveGames = await this.basketballService.fetchLiveGames();
      const tracked = liveGames.filter((g: any) =>
        TRACKED_BASKETBALL_LEAGUES.includes(g.league?.id),
      );

      return {
        data: tracked,
        count: tracked.length,
        source: 'api',
      };
    } catch (error) {
      this.logger.error(
        `Failed to get live basketball games: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve live basketball games',
      );
    }
  }

  @Get('fixtures/:id')
  @ApiOperation({
    summary: 'Get basketball fixture details with statistics',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Basketball game ID',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Full fixture detail' })
  @ApiResponse({ status: 404, description: 'Fixture not found' })
  async getFixtureById(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.basketballService.getFixtureById(id);

      if (!result) {
        throw new NotFoundException(`Basketball fixture ${id} not found`);
      }

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to get basketball fixture ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve basketball fixture',
      );
    }
  }

  // ─── TEAMS ───────────────────────────────────────────────────────────

  @Get('teams/:id')
  @ApiOperation({ summary: 'Get basketball team details with form data' })
  @ApiParam({
    name: 'id',
    description: 'API-Basketball team ID',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Team with form data' })
  @ApiResponse({ status: 404, description: 'Team not found' })
  async getTeamById(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.basketballService.getTeamById(id);

      if (!result) {
        throw new NotFoundException(`Basketball team ${id} not found`);
      }

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to get basketball team ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve basketball team',
      );
    }
  }

  @Get('teams/:id/history')
  @ApiOperation({
    summary: 'Get basketball team match history with results',
    description:
      'Returns completed games for a team with scores and W/L results. ' +
      'Useful for plotting form charts and scoring trends.',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Basketball team ID',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Team match history',
  })
  @ApiResponse({ status: 404, description: 'Team not found' })
  async getTeamHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('leagueId') leagueId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    try {
      const result = await this.basketballService.getTeamMatchHistory(id, {
        leagueId: leagueId ? Number(leagueId) : undefined,
        limit: limit ? Number(limit) : 30,
        offset: offset ? Number(offset) : 0,
      });

      if (!result.team) {
        throw new NotFoundException(`Basketball team ${id} not found`);
      }

      return {
        team: result.team,
        matches: result.matches,
        total: result.total,
        page: {
          limit: limit ? Number(limit) : 30,
          offset: offset ? Number(offset) : 0,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to get basketball team history for ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve basketball team match history',
      );
    }
  }

  // ─── LEAGUES ─────────────────────────────────────────────────────────

  @Get('leagues')
  @ApiOperation({
    summary: 'Get tracked basketball leagues with current season info',
  })
  @ApiResponse({
    status: 200,
    description: 'List of tracked basketball leagues',
  })
  async getLeagues(@Query() _query: BasketballLeagueQueryDto) {
    try {
      const leagues = await this.basketballService.getTrackedLeagues();

      return {
        data: leagues,
        count: leagues.length,
        trackedIds: [...TRACKED_BASKETBALL_LEAGUES],
      };
    } catch (error) {
      this.logger.error(`Failed to get basketball leagues: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to retrieve basketball leagues',
      );
    }
  }

  // ─── API BUDGET ──────────────────────────────────────────────────────

  @Get('api-budget')
  @ApiOperation({
    summary: 'Get remaining API-Basketball request budget for today',
    description:
      'Shows how many API requests have been used and how many remain. ' +
      'The limit is controlled by the API_BASKETBALL_DAILY_LIMIT env var ' +
      '(default: 100 for free plan). To upgrade, set a higher value.',
  })
  @ApiResponse({ status: 200, description: 'API request budget status' })
  getApiBudget() {
    return this.basketballService.getRemainingRequests();
  }

  // ─── SYNC OPERATIONS ────────────────────────────────────────────────

  @Roles('admin')
  @Post('fixtures/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Trigger a manual basketball fixture sync',
    description:
      'Send an empty JSON body {} to sync all tracked leagues. ' +
      'Optionally provide { "leagueIds": [12, 116] } to sync specific leagues.',
  })
  @ApiResponse({ status: 200, description: 'Sync result with counts' })
  async syncFixtures(@Body() body: BasketballSyncFixturesDto) {
    this.logger.log('Manual basketball fixture sync triggered');

    try {
      const leagueIds = body?.leagueIds?.length
        ? body.leagueIds
        : [...TRACKED_BASKETBALL_LEAGUES];

      // Run fixture sync
      const fixtureCount = await this.basketballService.syncFixtures(leagueIds);

      // Sync standings for the requested leagues
      let standingsCount = 0;
      for (const leagueId of leagueIds) {
        try {
          standingsCount +=
            await this.basketballService.syncStandings(leagueId);
        } catch (error) {
          this.logger.error(
            `Failed to sync basketball standings for league ${leagueId}: ${error.message}`,
          );
        }
      }

      return {
        success: true,
        fixturesSynced: fixtureCount,
        standingsSynced: standingsCount,
        leaguesProcessed: leagueIds.length,
        season: BasketballService.getCurrentSeason(),
      };
    } catch (error) {
      this.logger.error(`Manual basketball sync failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Basketball sync operation failed',
      );
    }
  }
}
