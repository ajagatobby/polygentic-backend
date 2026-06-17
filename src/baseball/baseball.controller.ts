import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { BaseballService } from './baseball.service';
import { BaseballTeamMapService } from './baseball-team-map.service';
import { StatcastService } from './statcast.service';
import { BaseballMarketService } from './baseball-market.service';
import { BaseballPredictionService } from './baseball-prediction.service';
import { BaseballPolymarketService } from './baseball-polymarket.service';

@ApiTags('Baseball')
@ApiBearerAuth('firebase-auth')
@Controller('api/baseball')
export class BaseballController {
  private readonly logger = new Logger(BaseballController.name);

  constructor(
    private readonly baseball: BaseballService,
    private readonly teamMap: BaseballTeamMapService,
    private readonly statcast: StatcastService,
    private readonly market: BaseballMarketService,
    private readonly prediction: BaseballPredictionService,
    private readonly polymarket: BaseballPolymarketService,
  ) {}

  // ─── READ ────────────────────────────────────────────────────────────

  @Get('games/upcoming')
  @ApiOperation({ summary: 'List upcoming MLB games (next 48h)' })
  @ApiResponse({ status: 200, description: 'Upcoming games' })
  async upcoming(@Query('hours', new ParseIntPipe({ optional: true }))
  hours?: number) {
    return this.baseball.getUpcomingGames(hours ?? 48);
  }

  @Get('games/:id')
  @ApiOperation({ summary: 'Get one MLB game by id' })
  async game(@Param('id', ParseIntPipe) id: number) {
    const g = await this.baseball.getGameById(id);
    if (!g) throw new NotFoundException(`Game ${id} not found`);
    return g;
  }

  @Get('teams/map')
  @ApiOperation({ summary: 'MLB team map (API-Sports ↔ MLBAM + park factors)' })
  teams() {
    return this.teamMap.all();
  }

  @Get('budget')
  @ApiOperation({ summary: 'API-Sports baseball daily request budget' })
  budget() {
    return this.baseball.getRemainingRequests();
  }

  @Get('predictions/:gameId')
  @ApiOperation({
    summary:
      'Over/under prediction for a game, with both teams’ last 10 games + H2H',
  })
  async prediction_(@Param('gameId', ParseIntPipe) gameId: number) {
    const game = await this.baseball.getGameById(gameId);
    if (!game) throw new NotFoundException(`Game ${gameId} not found`);

    const [prediction, homeRecent, awayRecent, h2h] = await Promise.all([
      this.baseball.getPredictionByGame(gameId),
      this.baseball.getRecentCompletedForTeam(game.homeTeamId, 10),
      this.baseball.getRecentCompletedForTeam(game.awayTeamId, 10),
      this.baseball.getH2H(game.homeTeamId, game.awayTeamId, 10),
    ]);

    const summarize = (rows: any[], perspectiveTeamId?: number) =>
      rows.map((r) => this.summarizeGame(r, perspectiveTeamId));

    return {
      game,
      prediction,
      homeTeam: {
        teamId: game.homeTeamId,
        last10: summarize(homeRecent, game.homeTeamId),
      },
      awayTeam: {
        teamId: game.awayTeamId,
        last10: summarize(awayRecent, game.awayTeamId),
      },
      h2h: summarize(h2h),
    };
  }

  /** Compact game summary; if perspectiveTeamId given, adds result/runs for/against. */
  private summarizeGame(r: any, perspectiveTeamId?: number) {
    const total =
      r.runsHome != null && r.runsAway != null ? r.runsHome + r.runsAway : null;
    const base = {
      gameId: r.id,
      date: r.date,
      homeTeamId: r.homeTeamId,
      awayTeamId: r.awayTeamId,
      runsHome: r.runsHome,
      runsAway: r.runsAway,
      total,
      status: r.status,
    };
    if (!perspectiveTeamId || total == null) return base;
    const isHome = r.homeTeamId === perspectiveTeamId;
    const runsFor = isHome ? r.runsHome : r.runsAway;
    const runsAgainst = isHome ? r.runsAway : r.runsHome;
    return {
      ...base,
      isHome,
      runsFor,
      runsAgainst,
      result: runsFor > runsAgainst ? 'W' : runsFor < runsAgainst ? 'L' : 'T',
    };
  }

  @Get('edges')
  @ApiOperation({
    summary: 'Compute model-vs-Polymarket edges across MLB totals markets',
  })
  async edges(
    @Query('minEdge') minEdge?: string,
  ) {
    const min = minEdge ? Number(minEdge) : 0.03;
    return this.polymarket.computeEdges(Number.isFinite(min) ? min : 0.03);
  }

  @Post('predict/:gameId')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate an on-demand over/under prediction' })
  async predict(@Param('gameId', ParseIntPipe) gameId: number) {
    const row = await this.prediction.generatePrediction(gameId, 'on_demand');
    if (!row) throw new NotFoundException(`Could not predict game ${gameId}`);
    return row;
  }

  // ─── ADMIN: manual triggers ─────────────────────────────────────────

  @Post('sync/games')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync upcoming MLB games from API-Sports' })
  async syncGames() {
    try {
      const upserted = await this.baseball.syncGames();
      return { upserted };
    } catch (err) {
      this.logger.error(`syncGames failed: ${(err as Error).message}`);
      throw new InternalServerErrorException('Failed to sync MLB games');
    }
  }

  @Post('sync/results')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync recently completed MLB games (scores)' })
  async syncResults() {
    const upserted = await this.baseball.syncCompletedGames();
    return { upserted };
  }

  @Post('sync/statcast')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh Statcast pitcher + team batting caches' })
  async syncStatcast() {
    const pitchers = await this.statcast.refreshPitcherExpectedStats();
    const teams = await this.statcast.refreshTeamBatting();
    return { pitchers, teams };
  }

  @Post('sync/market')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Snapshot sharp MLB totals from The Odds API' })
  async syncMarket() {
    const snapshots = await this.market.syncMarketTotals();
    return { snapshots };
  }

  @Post('teams/seed')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-seed the MLB team map' })
  async seedTeams() {
    await this.teamMap.seed();
    return { seeded: this.teamMap.all().length };
  }
}
