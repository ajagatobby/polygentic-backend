import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { OddsService, SOCCER_SPORT_KEYS } from './odds.service';
import {
  OddsSyncDto,
  OddsSyncResultDto,
  BookmakerOddsResponseDto,
  ConsensusOddsResponseDto,
} from './dto/odds-query.dto';

@ApiTags('Odds')
@ApiBearerAuth('firebase-auth')
@Controller('api/odds')
export class OddsController {
  private readonly logger = new Logger(OddsController.name);

  constructor(private readonly oddsService: OddsService) {}

  // ─── Comparison endpoints (must come before :eventId param routes) ──

  @Get('compare/:eventId')
  @ApiOperation({
    summary:
      'Compare odds across all bookmakers for an event — best price per outcome, value bets, and full comparison table',
  })
  @ApiParam({ name: 'eventId', description: 'The Odds API event ID' })
  @ApiResponse({
    status: 200,
    description:
      'Best odds per outcome, spread between best/worst, value bets with edge %, and per-bookmaker breakdown',
  })
  async compareOdds(@Param('eventId') eventId: string) {
    try {
      const comparison = await this.oddsService.getOddsComparison(eventId);

      if (!comparison) {
        throw new HttpException(
          `No odds found for event ${eventId}`,
          HttpStatus.NOT_FOUND,
        );
      }

      return comparison;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `Failed to compare odds for event ${eventId}: ${err.message}`,
      );
      throw new HttpException(
        'Failed to compare odds',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('credits')
  @ApiOperation({ summary: 'Get current Odds API credit usage' })
  async getCreditUsage() {
    return this.oddsService.getCreditUsage();
  }

  // ─── Standard odds endpoints ───────────────────────────────────────

  @Get('consensus/:eventId')
  @ApiOperation({ summary: 'Get consensus probability for an event' })
  @ApiParam({ name: 'eventId', description: 'The Odds API event ID' })
  @ApiResponse({ status: 200, type: [ConsensusOddsResponseDto] })
  async getConsensusForEvent(@Param('eventId') eventId: string) {
    try {
      const consensus = await this.oddsService.getConsensusForEvent(eventId);

      if (!consensus || consensus.length === 0) {
        throw new HttpException(
          `No consensus odds found for event ${eventId}`,
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        eventId,
        consensus,
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `Failed to get consensus for event ${eventId}: ${err.message}`,
      );
      throw new HttpException(
        'Failed to retrieve consensus odds',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':eventId')
  @ApiOperation({ summary: 'Get all bookmaker odds for an event' })
  @ApiParam({ name: 'eventId', description: 'The Odds API event ID' })
  @ApiResponse({ status: 200, type: [BookmakerOddsResponseDto] })
  async getOddsForEvent(@Param('eventId') eventId: string) {
    try {
      const odds = await this.oddsService.getOddsForEvent(eventId);

      if (!odds || odds.length === 0) {
        throw new HttpException(
          `No odds found for event ${eventId}`,
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        eventId,
        bookmakerCount: new Set(odds.map((o: any) => o.bookmakerKey)).size,
        odds,
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `Failed to get odds for event ${eventId}: ${err.message}`,
      );
      throw new HttpException(
        'Failed to retrieve odds',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Roles('admin')
  @Post('sync')
  @ApiOperation({
    summary: '[Admin] Manually trigger odds sync for soccer leagues',
  })
  @ApiResponse({ status: 201, type: OddsSyncResultDto })
  async syncOdds(@Body() body: OddsSyncDto) {
    try {
      const sportKeys = body.sportKeys ?? [...SOCCER_SPORT_KEYS];

      this.logger.log(
        `Manual odds sync triggered for ${sportKeys.length} sport key(s)`,
      );

      const result = await this.oddsService.syncOdds(sportKeys);

      return result;
    } catch (err) {
      this.logger.error(`Odds sync failed: ${err.message}`);
      throw new HttpException(
        `Odds sync failed: ${err.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
