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
