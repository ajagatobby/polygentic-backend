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

  @Roles('admin')
  @Post('trades/deduplicate')
  @ApiOperation({
    summary:
      '[Admin] Find and delete duplicate open trades, keeping the oldest per market+outcome',
  })
  async deduplicateTrades() {
    this.logger.log('Triggering trade deduplication');

    const result = await this.polymarketService.deduplicateTrades();

    return {
      message:
        result.deleted > 0
          ? `Deleted ${result.deleted} duplicate trades, freed $${result.freedAmount.toFixed(2)} back to bankroll`
          : 'No duplicates found',
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

  @Get('trades/upcoming')
  @ApiOperation({
    summary:
      'Get upcoming open trades sorted by soonest resolution, with profit projections',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max trades to return (default: 5)',
  })
  @ApiQuery({
    name: 'month',
    required: false,
    type: Number,
    description: 'Filter by month created (1-12)',
  })
  @ApiQuery({
    name: 'year',
    required: false,
    type: Number,
    description: 'Filter by year created',
  })
  @ApiQuery({
    name: 'mode',
    required: false,
    type: String,
    description: 'Filter by mode: paper or live',
  })
  async getUpcomingTrades(
    @Query('limit') limit?: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('mode') mode?: string,
  ) {
    const filters: {
      limit?: number;
      month?: number;
      year?: number;
      mode?: string;
    } = {};

    if (limit) filters.limit = Math.max(1, Math.min(100, Number(limit)));
    if (month && year) {
      const m = Number(month);
      const y = Number(year);
      if (m >= 1 && m <= 12) filters.month = m;
      if (y >= 2020 && y <= 2100) filters.year = y;
    }
    if (mode && ['paper', 'live'].includes(mode)) filters.mode = mode;

    const trades = await this.polymarketService.getUpcomingTrades(filters);

    const totalCost = trades.reduce((s, t) => s + t.positionSizeUsd, 0);
    const totalProfitIfAllWin = trades.reduce((s, t) => s + t.profitIfWin, 0);
    const totalExpectedValue = trades.reduce((s, t) => s + t.expectedValue, 0);

    return {
      data: trades,
      count: trades.length,
      summary: {
        totalCost: Number(totalCost.toFixed(2)),
        totalProfitIfAllWin: Number(totalProfitIfAllWin.toFixed(2)),
        totalRoiIfAllWin:
          totalCost > 0
            ? Number(((totalProfitIfAllWin / totalCost) * 100).toFixed(2))
            : 0,
        totalExpectedValue: Number(totalExpectedValue.toFixed(2)),
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
  @Post('trades/adjust-budget')
  @ApiOperation({
    summary: '[Admin] Increase or decrease the position size of open trades',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tradeIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Specific trade IDs to adjust',
        },
        month: {
          type: 'number',
          description: 'Adjust all open trades from this month (1-12)',
        },
        year: {
          type: 'number',
          description: 'Year for month filter',
        },
        all: {
          type: 'boolean',
          description: 'Adjust all open trades',
        },
        amount: {
          type: 'number',
          description:
            'Total budget to distribute across targeted trades proportionally (e.g. 200 = spread $200 across all targeted trades weighted by current size)',
        },
        multiplier: {
          type: 'number',
          description:
            'Scale factor relative to current size (e.g. 2 = double, 0.5 = halve)',
        },
      },
    },
  })
  async adjustTradeBudgets(
    @Body()
    body: {
      tradeIds?: number[];
      month?: number;
      year?: number;
      all?: boolean;
      amount?: number;
      multiplier?: number;
    },
  ) {
    this.logger.log(`Adjust budget request: ${JSON.stringify(body)}`);

    const result = await this.polymarketService.adjustTradeBudgets(body);

    return {
      message: `Adjusted ${result.adjusted} trades (${result.skipped} skipped), net change: ${result.totalDelta >= 0 ? '+' : ''}$${result.totalDelta.toFixed(2)}`,
      ...result,
    };
  }

  @Roles('admin')
  @Post('trades/switch-mode')
  @ApiOperation({
    summary:
      '[Admin] Switch open trades between paper and live mode (lightweight — no CLOB orders placed)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['to'],
      properties: {
        tradeIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Specific trade IDs to switch',
        },
        month: {
          type: 'number',
          description: 'Switch all matching trades from this month (1-12)',
        },
        year: {
          type: 'number',
          description: 'Year for month filter',
        },
        all: {
          type: 'boolean',
          description: 'Switch all open trades in the source mode',
        },
        to: {
          type: 'string',
          enum: ['paper', 'live'],
          description:
            'Target mode — trades currently in the opposite mode will be switched',
        },
      },
    },
  })
  async switchTradeMode(
    @Body()
    body: {
      tradeIds?: number[];
      month?: number;
      year?: number;
      all?: boolean;
      to: 'paper' | 'live';
    },
  ) {
    if (!body.to || !['paper', 'live'].includes(body.to)) {
      return { error: '"to" must be "paper" or "live"' };
    }

    this.logger.log(`Switch mode request: ${JSON.stringify(body)}`);

    const result = await this.polymarketService.switchTradeMode(body);
    const sourceMode = body.to === 'live' ? 'paper' : 'live';

    return {
      message: `Switched ${result.switched} trades from ${sourceMode} → ${body.to} (${result.skipped} skipped)`,
      ...result,
    };
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
