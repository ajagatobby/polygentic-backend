import { Controller, Get, Post, Query, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { PolymarketService } from './polymarket.service';
import { polymarketScanTask } from '../trigger/polymarket-scan';

@ApiTags('Polymarket Trading Agent')
@ApiBearerAuth('firebase-auth')
@Controller('api/polymarket')
export class PolymarketController {
  private readonly logger = new Logger(PolymarketController.name);

  constructor(private readonly polymarketService: PolymarketService) {}

  @Get('performance')
  @ApiOperation({
    summary:
      'Get Polymarket trading performance summary (bankroll, P&L, recent trades)',
  })
  async getPerformance() {
    return this.polymarketService.getPerformanceSummary();
  }

  @Get('markets')
  @ApiOperation({ summary: 'Get discovered Polymarket soccer markets' })
  @ApiQuery({
    name: 'active',
    required: false,
    type: Boolean,
    description: 'Filter by active markets',
  })
  @ApiQuery({
    name: 'matched',
    required: false,
    type: Boolean,
    description: 'Filter by matched/unmatched to fixtures',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max markets to return (default: 50)',
  })
  async getMarkets(
    @Query('active') active?: string,
    @Query('matched') matched?: string,
    @Query('limit') limit?: string,
  ) {
    const markets = await this.polymarketService.getMarkets({
      active: active !== undefined ? active === 'true' : undefined,
      matched: matched !== undefined ? matched === 'true' : undefined,
      limit: limit ? Number(limit) : undefined,
    });

    return {
      data: markets,
      count: markets.length,
    };
  }

  @Get('bankroll')
  @ApiOperation({ summary: 'Get current bankroll state' })
  async getBankroll() {
    return this.polymarketService.getOrCreateBankroll();
  }

  @Get('open-positions')
  @ApiOperation({ summary: 'Get current open positions' })
  async getOpenPositions() {
    const positions = await this.polymarketService.getOpenPositionsSummary();
    return {
      data: positions,
      count: positions.length,
      totalValue: positions.reduce((sum, p) => sum + p.positionSizeUsd, 0),
    };
  }

  @Roles('admin')
  @Post('scan')
  @ApiOperation({
    summary:
      '[Admin] Trigger a Polymarket scan cycle — discover markets, evaluate opportunities, place trades',
  })
  async triggerScan() {
    this.logger.log('Triggering Polymarket scan cycle via API');

    const handle = await polymarketScanTask.trigger(undefined as void);

    return {
      message: 'Polymarket scan cycle triggered',
      taskRunId: handle.id,
    };
  }

  @Roles('admin')
  @Post('resolve')
  @ApiOperation({
    summary: '[Admin] Resolve completed Polymarket trades for finished matches',
  })
  async resolveTrades() {
    this.logger.log('Triggering Polymarket trade resolution');

    const result = await this.polymarketService.resolveCompletedTrades();

    return {
      message: `Resolved ${result.resolved} trades`,
      ...result,
    };
  }
}
