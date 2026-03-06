import { Controller, Get, Post, Query, Body, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBody,
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

  @Get('trades')
  @ApiOperation({
    summary:
      'Get trades filtered by month and year, with market details and P&L',
  })
  @ApiQuery({
    name: 'month',
    required: true,
    type: Number,
    description: 'Month (1-12)',
  })
  @ApiQuery({
    name: 'year',
    required: true,
    type: Number,
    description: 'Year (e.g. 2026)',
  })
  async getTradesByMonth(
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const m = Number(month);
    const y = Number(year);

    if (!m || m < 1 || m > 12) {
      return { error: 'month must be between 1 and 12' };
    }
    if (!y || y < 2020 || y > 2100) {
      return { error: 'year must be a valid year (2020-2100)' };
    }

    const trades = await this.polymarketService.getTradesByMonth(m, y);

    const totalPnl = trades.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
    const openCount = trades.filter((t) => t.status === 'open').length;
    const resolvedCount = trades.filter((t) => t.status === 'resolved').length;
    const wins = trades.filter((t) => t.resolutionOutcome === 'win').length;
    const losses = trades.filter((t) => t.resolutionOutcome === 'loss').length;

    return {
      data: trades,
      count: trades.length,
      summary: {
        month: m,
        year: y,
        totalTrades: trades.length,
        openCount,
        resolvedCount,
        wins,
        losses,
        winRate: resolvedCount > 0 ? wins / resolvedCount : null,
        totalPnl: Number(totalPnl.toFixed(2)),
      },
    };
  }

  @Get('trades/projections')
  @ApiOperation({
    summary:
      'Show potential profit per trade and grouped by market type / league if outcomes are correctly predicted',
  })
  @ApiQuery({
    name: 'month',
    required: false,
    type: Number,
    description: 'Filter by month (1-12)',
  })
  @ApiQuery({
    name: 'year',
    required: false,
    type: Number,
    description: 'Filter by year',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description:
      'Trade status filter (default: open). Use "all" for all statuses.',
  })
  async getTradeProjections(
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('status') status?: string,
  ) {
    const filters: { month?: number; year?: number; status?: string } = {};

    if (month && year) {
      const m = Number(month);
      const y = Number(year);
      if (m >= 1 && m <= 12) filters.month = m;
      if (y >= 2020 && y <= 2100) filters.year = y;
    }

    if (status && status !== 'all') {
      filters.status = status;
    } else if (status === 'all') {
      filters.status = undefined; // Remove default 'open' filter
    }

    return this.polymarketService.getPotentialProfit(filters);
  }

  @Roles('admin')
  @Post('trades/go-live')
  @ApiOperation({
    summary:
      '[Admin] Convert paper trades to live by placing real orders on Polymarket CLOB',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tradeIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Specific trade IDs to convert',
        },
        month: {
          type: 'number',
          description: 'Convert all open paper trades from this month (1-12)',
        },
        year: {
          type: 'number',
          description: 'Year for month filter',
        },
        all: {
          type: 'boolean',
          description: 'Convert all open paper trades',
        },
      },
    },
  })
  async goLiveTrades(
    @Body()
    body: {
      tradeIds?: number[];
      month?: number;
      year?: number;
      all?: boolean;
    },
  ) {
    this.logger.log(`Go-live request: ${JSON.stringify(body)}`);

    const result = await this.polymarketService.goLiveTrades(body);

    return {
      message: `Converted ${result.converted} trades to live (${result.failed} failed, ${result.skipped} skipped)`,
      ...result,
    };
  }
}
