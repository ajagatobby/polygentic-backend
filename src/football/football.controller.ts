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
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { FootballService, TRACKED_LEAGUES } from './football.service';
import { LiveScoreService } from './live/live-score.service';
import {
  FixtureQueryDto,
  SyncFixturesDto,
  TeamQueryDto,
  LeagueQueryDto,
} from './dto/fixture-query.dto';

@ApiTags('Football')
@Controller('api')
export class FootballController {
  private readonly logger = new Logger(FootballController.name);

  constructor(
    private readonly footballService: FootballService,
    private readonly liveScoreService: LiveScoreService,
  ) {}

  // ─── FIXTURES ────────────────────────────────────────────────────────

  @Get('fixtures')
  @ApiOperation({
    summary: 'List fixtures with optional filters and pagination',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of fixtures' })
  async getFixtures(@Query() query: FixtureQueryDto) {
    try {
      return await this.footballService.getFixtures(query);
    } catch (error) {
      this.logger.error(`Failed to get fixtures: ${error.message}`);
      throw new InternalServerErrorException('Failed to retrieve fixtures');
    }
  }

  @Get('fixtures/live')
  @ApiOperation({ summary: 'Get currently live matches' })
  @ApiResponse({ status: 200, description: 'List of live matches' })
  async getLiveFixtures() {
    try {
      // Return locally tracked state first; fall back to API if not monitoring
      const activeMatches = this.liveScoreService.getActiveMatches();

      if (activeMatches.length > 0) {
        return {
          data: activeMatches,
          count: activeMatches.length,
          source: 'live-monitor',
        };
      }

      // No active monitoring — fetch directly from API
      const liveFixtures = await this.footballService.fetchLiveFixtures();
      const tracked = liveFixtures.filter((f: any) =>
        TRACKED_LEAGUES.includes(f.league?.id),
      );

      return {
        data: tracked,
        count: tracked.length,
        source: 'api',
      };
    } catch (error) {
      this.logger.error(`Failed to get live fixtures: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to retrieve live fixtures',
      );
    }
  }

  @Get('fixtures/:id')
  @ApiOperation({
    summary:
      'Get fixture details with statistics, events, injuries, and predictions',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Football fixture ID',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Full fixture detail' })
  @ApiResponse({ status: 404, description: 'Fixture not found' })
  async getFixtureById(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.footballService.getFixtureById(id);

      if (!result) {
        throw new NotFoundException(`Fixture ${id} not found`);
      }

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get fixture ${id}: ${error.message}`);
      throw new InternalServerErrorException('Failed to retrieve fixture');
    }
  }

  // ─── TEAMS ───────────────────────────────────────────────────────────

  @Get('teams/:id')
  @ApiOperation({ summary: 'Get team details with form data' })
  @ApiParam({ name: 'id', description: 'API-Football team ID', type: Number })
  @ApiResponse({ status: 200, description: 'Team with form data' })
  @ApiResponse({ status: 404, description: 'Team not found' })
  async getTeamById(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.footballService.getTeamById(id);

      if (!result) {
        throw new NotFoundException(`Team ${id} not found`);
      }

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get team ${id}: ${error.message}`);
      throw new InternalServerErrorException('Failed to retrieve team');
    }
  }

  // ─── LEAGUES ─────────────────────────────────────────────────────────

  @Get('leagues')
  @ApiOperation({ summary: 'Get tracked leagues with current season info' })
  @ApiResponse({ status: 200, description: 'List of tracked leagues' })
  async getLeagues(@Query() _query: LeagueQueryDto) {
    try {
      const leagues = await this.footballService.getTrackedLeagues();

      return {
        data: leagues,
        count: leagues.length,
        trackedIds: [...TRACKED_LEAGUES],
      };
    } catch (error) {
      this.logger.error(`Failed to get leagues: ${error.message}`);
      throw new InternalServerErrorException('Failed to retrieve leagues');
    }
  }

  // ─── SYNC OPERATIONS ────────────────────────────────────────────────

  @Post('fixtures/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger a manual fixture sync' })
  @ApiResponse({ status: 200, description: 'Sync result with counts' })
  async syncFixtures(@Body() body: SyncFixturesDto) {
    this.logger.log('Manual fixture sync triggered');

    try {
      const leagueIds = body.leagueIds?.length
        ? body.leagueIds
        : [...TRACKED_LEAGUES];

      const season = body.season ?? this.getCurrentSeason();

      // Run fixture sync
      const fixtureCount = await this.footballService.syncFixtures(leagueIds);

      // Optionally sync standings for the requested leagues
      let standingsCount = 0;
      for (const leagueId of leagueIds) {
        try {
          standingsCount += await this.footballService.syncStandings(
            leagueId,
            season,
          );
        } catch (error) {
          this.logger.error(
            `Failed to sync standings for league ${leagueId}: ${error.message}`,
          );
        }
      }

      return {
        success: true,
        fixturesSynced: fixtureCount,
        standingsSynced: standingsCount,
        leaguesProcessed: leagueIds.length,
        season,
      };
    } catch (error) {
      this.logger.error(`Manual sync failed: ${error.message}`);
      throw new InternalServerErrorException('Sync operation failed');
    }
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────

  private getCurrentSeason(): number {
    const now = new Date();
    return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  }
}
