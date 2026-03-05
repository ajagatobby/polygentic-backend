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
import { FootballService, TRACKED_LEAGUES } from './football.service';
import { LiveScoreService } from './live/live-score.service';
import { OddsService } from '../odds/odds.service';
import {
  FixtureQueryDto,
  SyncFixturesDto,
  LeagueQueryDto,
} from './dto/fixture-query.dto';

@ApiTags('Football')
@ApiBearerAuth('firebase-auth')
@Controller('api')
export class FootballController {
  private readonly logger = new Logger(FootballController.name);

  constructor(
    private readonly footballService: FootballService,
    private readonly liveScoreService: LiveScoreService,
    private readonly oddsService: OddsService,
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

  @Post('fixtures/live/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start live match monitoring' })
  @ApiResponse({ status: 200, description: 'Monitoring started' })
  startLiveMonitoring() {
    this.liveScoreService.startMonitoring();
    return {
      success: true,
      message: 'Live monitoring started',
      activeMatches: this.liveScoreService.getActiveMatches().length,
    };
  }

  @Post('fixtures/live/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop live match monitoring' })
  @ApiResponse({ status: 200, description: 'Monitoring stopped' })
  stopLiveMonitoring() {
    this.liveScoreService.stopMonitoring();
    return {
      success: true,
      message: 'Live monitoring stopped',
    };
  }

  @Get('fixtures/today')
  @ApiOperation({
    summary: "Get today's fixtures with their AI predictions and team details",
    description:
      'Filter by state: upcoming (not started), live (in play), finished (completed), cancelled. ' +
      'Or use exact status codes: NS, 1H, HT, 2H, FT, etc. ' +
      'Also supports filtering by league name, country, team, club name search, round, ' +
      'prediction availability, and minimum confidence.',
  })
  @ApiResponse({
    status: 200,
    description:
      "Today's fixtures with best prediction (pre_match > daily > on_demand) and all available predictions",
  })
  async getTodayFixtures(
    @Query('leagueId') leagueId?: string,
    @Query('leagueName') leagueName?: string,
    @Query('leagueCountry') leagueCountry?: string,
    @Query('status') status?: string,
    @Query('state') state?: string,
    @Query('teamId') teamId?: string,
    @Query('club') club?: string,
    @Query('round') round?: string,
    @Query('date') date?: string,
    @Query('hasPrediction') hasPrediction?: string,
    @Query('minConfidence') minConfidence?: string,
  ) {
    try {
      let data = await this.footballService.getTodayFixturesWithPredictions({
        leagueId: leagueId ? Number(leagueId) : undefined,
        leagueName,
        leagueCountry,
        status,
        state,
        teamId: teamId ? Number(teamId) : undefined,
        club,
        round,
        date,
      });

      // Post-query filters that depend on joined prediction data
      if (hasPrediction === 'true') {
        data = data.filter((d: any) => d.prediction != null);
      } else if (hasPrediction === 'false') {
        data = data.filter((d: any) => d.prediction == null);
      }

      if (minConfidence) {
        const minConf = Number(minConfidence);
        data = data.filter(
          (d: any) => d.prediction && d.prediction.confidence >= minConf,
        );
      }

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
          round: round ?? null,
          hasPrediction: hasPrediction ?? null,
          minConfidence: minConfidence ? Number(minConfidence) : null,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get today's fixtures: ${error.message}`);
      throw new InternalServerErrorException(
        "Failed to retrieve today's fixtures",
      );
    }
  }

  @Get('fixtures/upcoming')
  @ApiOperation({
    summary: 'Get upcoming fixtures with predictions, lineups, and injuries',
    description:
      'Returns fixtures from today onwards (or a custom date range). ' +
      'Supports all the same filters as /fixtures/today plus from/to date range.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upcoming fixtures with predictions and team details',
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
    @Query('round') round?: string,
    @Query('hasPrediction') hasPrediction?: string,
    @Query('minConfidence') minConfidence?: string,
  ) {
    try {
      // Default: from today, to 7 days out
      const defaultFrom =
        from ?? date ?? new Date().toISOString().split('T')[0];
      const defaultTo =
        to ??
        (date
          ? undefined
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0]);

      let data = await this.footballService.getTodayFixturesWithPredictions({
        from: defaultFrom,
        to: defaultTo,
        leagueId: leagueId ? Number(leagueId) : undefined,
        leagueName,
        leagueCountry,
        status: status ?? 'NS',
        state,
        teamId: teamId ? Number(teamId) : undefined,
        club,
        round,
      });

      if (hasPrediction === 'true') {
        data = data.filter((d: any) => d.prediction != null);
      } else if (hasPrediction === 'false') {
        data = data.filter((d: any) => d.prediction == null);
      }

      if (minConfidence) {
        const minConf = Number(minConfidence);
        data = data.filter(
          (d: any) => d.prediction && d.prediction.confidence >= minConf,
        );
      }

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
          round: round ?? null,
          hasPrediction: hasPrediction ?? null,
          minConfidence: minConfidence ? Number(minConfidence) : null,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get upcoming fixtures: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to retrieve upcoming fixtures',
      );
    }
  }

  @Get('fixtures/live')
  @ApiOperation({
    summary: 'Get currently live matches with lineups and injuries',
  })
  @ApiResponse({ status: 200, description: 'List of live matches' })
  async getLiveFixtures() {
    try {
      // Return locally tracked state first; fall back to API if not monitoring
      const activeMatches = this.liveScoreService.getActiveMatches();

      if (activeMatches.length > 0) {
        // Enrich live matches with lineups and injuries
        const fixtureIds = activeMatches
          .map((m: any) => m.fixtureId)
          .filter(Boolean);

        let enriched = activeMatches;
        if (fixtureIds.length > 0) {
          const enrichmentData =
            await this.footballService.getLineupsAndInjuriesForFixtures(
              fixtureIds,
            );
          enriched = activeMatches.map((match: any) => ({
            ...match,
            lineups:
              enrichmentData.lineupsByFixture.get(match.fixtureId) ?? null,
            homeInjuries:
              enrichmentData.injuriesByTeam.get(match.homeTeamId) ?? [],
            awayInjuries:
              enrichmentData.injuriesByTeam.get(match.awayTeamId) ?? [],
          }));
        }

        return {
          data: enriched,
          count: enriched.length,
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

  @Get('fixtures/:id/prediction')
  @ApiOperation({
    summary: 'Get a fixture with its AI predictions and team details',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Football fixture ID',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Fixture with predictions' })
  @ApiResponse({ status: 404, description: 'Fixture not found' })
  async getFixturePrediction(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.footballService.getFixtureWithPredictions(id);

      if (!result) {
        throw new NotFoundException(`Fixture ${id} not found`);
      }

      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to get fixture prediction for ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve fixture prediction',
      );
    }
  }

  @Get('fixtures/:id/lineups')
  @ApiOperation({
    summary:
      'Get confirmed lineups for a fixture (formation, startXI, bench, coach)',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Football fixture ID',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Lineups for both teams (empty array if not yet available)',
  })
  @ApiResponse({ status: 404, description: 'Fixture not found' })
  async getFixtureLineups(@Param('id', ParseIntPipe) id: number) {
    try {
      // First check the fixture exists
      const fixture = await this.footballService.getFixtureById(id);
      if (!fixture) {
        throw new NotFoundException(`Fixture ${id} not found`);
      }

      // Get persisted lineups from DB
      const lineups = await this.footballService.getLineupsForFixture(id);

      // If no persisted lineups, try fetching from API (might be available now)
      if (lineups.length === 0) {
        try {
          const persisted =
            await this.footballService.fetchAndPersistLineups(id);
          if (persisted > 0) {
            const freshLineups =
              await this.footballService.getLineupsForFixture(id);
            return {
              data: freshLineups,
              count: freshLineups.length,
              source: 'api-fresh',
            };
          }
        } catch {
          // API fetch failed — return empty
        }
      }

      return {
        data: lineups,
        count: lineups.length,
        source: lineups.length > 0 ? 'database' : 'unavailable',
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to get lineups for fixture ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve fixture lineups',
      );
    }
  }

  @Get('fixtures/:id')
  @ApiOperation({
    summary:
      'Get fixture details with statistics, events, injuries, lineups, and predictions',
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

  // ─── FIXTURE ODDS ──────────────────────────────────────────────────

  @Get('fixtures/:id/odds')
  @ApiOperation({
    summary:
      'Get all bookmaker odds for a fixture (auto-linked via team name + date matching)',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Football fixture ID',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'All bookmaker odds linked to this fixture',
  })
  @ApiResponse({
    status: 404,
    description: 'Fixture not found or no odds linked',
  })
  async getFixtureOdds(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.oddsService.getOddsForFixture(id);

      if (!result) {
        throw new NotFoundException(
          `No odds found for fixture ${id}. Odds are linked automatically during odds sync.`,
        );
      }

      return {
        ...result,
        bookmakerCount: new Set(result.odds.map((o: any) => o.bookmakerKey))
          .size,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to get odds for fixture ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException('Failed to retrieve fixture odds');
    }
  }

  @Get('fixtures/:id/odds/compare')
  @ApiOperation({
    summary:
      'Compare odds across all bookmakers for a fixture — best price, value bets, full breakdown',
  })
  @ApiParam({
    name: 'id',
    description: 'API-Football fixture ID',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description:
      'Best odds per outcome, spread, value bets with edge %, per-bookmaker comparison',
  })
  @ApiResponse({
    status: 404,
    description: 'Fixture not found or no odds linked',
  })
  async compareFixtureOdds(@Param('id', ParseIntPipe) id: number) {
    try {
      const comparison = await this.oddsService.getOddsComparisonForFixture(id);

      if (!comparison) {
        throw new NotFoundException(
          `No odds comparison available for fixture ${id}. Odds are linked automatically during odds sync.`,
        );
      }

      return comparison;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Failed to compare odds for fixture ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException('Failed to compare fixture odds');
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

  @Get('teams/:id/history')
  @ApiOperation({
    summary:
      'Get team match history with results and stats (for graphs and analysis)',
    description:
      'Returns completed matches for a team with goals, result (W/D/L), ' +
      'and per-match statistics (xG, shots, possession, etc.). ' +
      'Useful for plotting form charts, scoring trends, and xG timelines.',
  })
  @ApiParam({ name: 'id', description: 'API-Football team ID', type: Number })
  @ApiResponse({
    status: 200,
    description: 'Team match history with stats',
  })
  @ApiResponse({ status: 404, description: 'Team not found' })
  async getTeamHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('leagueId') leagueId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    try {
      const result = await this.footballService.getTeamMatchHistory(id, {
        leagueId: leagueId ? Number(leagueId) : undefined,
        limit: limit ? Number(limit) : 30,
        offset: offset ? Number(offset) : 0,
      });

      if (!result.team) {
        throw new NotFoundException(`Team ${id} not found`);
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
        `Failed to get team history for ${id}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve team match history',
      );
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

      // Run fixture sync
      const fixtureCount = await this.footballService.syncFixtures(leagueIds);

      // Sync standings for the requested leagues (season auto-detected per league)
      let standingsCount = 0;
      for (const leagueId of leagueIds) {
        try {
          standingsCount += await this.footballService.syncStandings(leagueId);
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
        season: FootballService.getCurrentSeason(),
      };
    } catch (error) {
      this.logger.error(`Manual sync failed: ${error.message}`);
      throw new InternalServerErrorException('Sync operation failed');
    }
  }
}
