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
import {
  polymarketScanTask,
  polymarketTradeTask,
} from '../trigger/polymarket-scan';

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
  // ── State filters ───────────────────────────────────────────────
  @ApiQuery({
    name: 'active',
    required: false,
    type: Boolean,
    description: 'Filter by active markets',
  })
  @ApiQuery({
    name: 'closed',
    required: false,
    type: Boolean,
    description: 'Filter by closed/open markets',
  })
  @ApiQuery({
    name: 'acceptingOrders',
    required: false,
    type: Boolean,
    description: 'Filter by markets currently accepting orders',
  })
  @ApiQuery({
    name: 'matched',
    required: false,
    type: Boolean,
    description: 'Filter by matched/unmatched to internal data',
  })
  @ApiQuery({
    name: 'hasTradeOnly',
    required: false,
    type: Boolean,
    description: 'Only return markets that have at least one trade placed',
  })
  // ── Classification filters ──────────────────────────────────────
  @ApiQuery({
    name: 'marketType',
    required: false,
    type: String,
    description:
      'Market type: match_outcome, league_winner, tournament_winner, qualification, top_4, player_prop, other',
  })
  @ApiQuery({
    name: 'leagueId',
    required: false,
    type: Number,
    description: 'Filter by API-Football league ID (e.g. 39 = Premier League)',
  })
  @ApiQuery({
    name: 'leagueName',
    required: false,
    type: String,
    description: 'Filter by league name (partial match, case-insensitive)',
  })
  @ApiQuery({
    name: 'teamId',
    required: false,
    type: Number,
    description: 'Filter by internal team ID',
  })
  @ApiQuery({
    name: 'teamName',
    required: false,
    type: String,
    description: 'Filter by team name (partial match, case-insensitive)',
  })
  @ApiQuery({
    name: 'season',
    required: false,
    type: Number,
    description: 'Filter by season year (e.g. 2025)',
  })
  @ApiQuery({
    name: 'fixtureId',
    required: false,
    type: Number,
    description: 'Filter by linked fixture ID',
  })
  // ── Date filters ────────────────────────────────────────────────
  @ApiQuery({
    name: 'month',
    required: false,
    type: Number,
    description: 'Filter by market start date month (1-12)',
  })
  @ApiQuery({
    name: 'year',
    required: false,
    type: Number,
    description: 'Filter by market start date year (e.g. 2026)',
  })
  @ApiQuery({
    name: 'startFrom',
    required: false,
    type: String,
    description: 'Markets starting from this date (ISO 8601, e.g. 2026-03-01)',
  })
  @ApiQuery({
    name: 'startTo',
    required: false,
    type: String,
    description:
      'Markets starting before this date (ISO 8601, e.g. 2026-03-31)',
  })
  // ── Liquidity / volume filters ──────────────────────────────────
  @ApiQuery({
    name: 'minLiquidity',
    required: false,
    type: Number,
    description: 'Minimum liquidity in USD',
  })
  @ApiQuery({
    name: 'minVolume',
    required: false,
    type: Number,
    description: 'Minimum total volume in USD',
  })
  // ── Text search ─────────────────────────────────────────────────
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search event title and market question (case-insensitive)',
  })
  @ApiQuery({
    name: 'eventId',
    required: false,
    type: String,
    description: 'Filter by Polymarket event ID',
  })
  @ApiQuery({
    name: 'slug',
    required: false,
    type: String,
    description: 'Filter by market slug (partial match)',
  })
  // ── Sorting & pagination ────────────────────────────────────────
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description:
      'Sort field: lastSyncedAt (default), volume, liquidity, volume24hr, startDate, createdAt, matchScore',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    type: String,
    description: 'Sort direction: desc (default) or asc',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max markets to return (default: 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Offset for pagination (default: 0)',
  })
  async getMarkets(
    // State
    @Query('active') active?: string,
    @Query('closed') closed?: string,
    @Query('acceptingOrders') acceptingOrders?: string,
    @Query('matched') matched?: string,
    @Query('hasTradeOnly') hasTradeOnly?: string,
    // Classification
    @Query('marketType') marketType?: string,
    @Query('leagueId') leagueId?: string,
    @Query('leagueName') leagueName?: string,
    @Query('teamId') teamId?: string,
    @Query('teamName') teamName?: string,
    @Query('season') season?: string,
    @Query('fixtureId') fixtureId?: string,
    // Dates
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('startFrom') startFrom?: string,
    @Query('startTo') startTo?: string,
    // Liquidity / volume
    @Query('minLiquidity') minLiquidity?: string,
    @Query('minVolume') minVolume?: string,
    // Text search
    @Query('search') search?: string,
    @Query('eventId') eventId?: string,
    @Query('slug') slug?: string,
    // Sorting & pagination
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const markets = await this.polymarketService.getMarkets({
      // State
      active: active !== undefined ? active === 'true' : undefined,
      closed: closed !== undefined ? closed === 'true' : undefined,
      acceptingOrders:
        acceptingOrders !== undefined ? acceptingOrders === 'true' : undefined,
      matched: matched !== undefined ? matched === 'true' : undefined,
      hasTradeOnly: hasTradeOnly === 'true' || undefined,
      // Classification
      marketType: marketType || undefined,
      leagueId: leagueId ? Number(leagueId) : undefined,
      leagueName: leagueName || undefined,
      teamId: teamId ? Number(teamId) : undefined,
      teamName: teamName || undefined,
      season: season ? Number(season) : undefined,
      fixtureId: fixtureId ? Number(fixtureId) : undefined,
      // Dates
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
      startFrom: startFrom || undefined,
      startTo: startTo || undefined,
      // Liquidity / volume
      minLiquidity: minLiquidity ? Number(minLiquidity) : undefined,
      minVolume: minVolume ? Number(minVolume) : undefined,
      // Text search
      search: search || undefined,
      eventId: eventId || undefined,
      slug: slug || undefined,
      // Sorting & pagination
      sortBy: sortBy || undefined,
      sortOrder: (sortOrder as 'asc' | 'desc') || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
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

  @Roles('admin')
  @Post('bankroll/reset-stop-loss')
  @ApiOperation({
    summary:
      '[Admin] Reset the stop-loss flag so trading can resume. Optionally inject additional funds.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        additionalFunds: {
          type: 'number',
          description:
            'Optional amount to add to the bankroll (increases both balance and initial budget)',
        },
      },
    },
  })
  async resetStopLoss(@Body() body: { additionalFunds?: number }) {
    return this.polymarketService.resetStopLoss(body.additionalFunds);
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

  @Post('trade')
  @ApiOperation({
    summary:
      '[Admin] Trigger a Polymarket trading cycle — generate predictions for soonest fixtures and place trades',
  })
  async triggerTrade() {
    this.logger.log('Triggering Polymarket trading cycle via API');

    const handle = await polymarketTradeTask.trigger(undefined as void);

    return {
      message: 'Polymarket trading cycle triggered (soonest fixtures first)',
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
  @Post('trades/manual')
  @ApiOperation({
    summary:
      '[Admin] Manually place a trade on a Polymarket market — bypasses AI agent and all gates',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['marketId', 'outcomeIndex', 'outcomeName', 'positionSizeUsd'],
      properties: {
        marketId: {
          type: 'number',
          description:
            'Our internal polymarket_markets.id (NOT the Polymarket market ID string)',
        },
        outcomeIndex: {
          type: 'number',
          description: 'Outcome index (0 or 1 for binary, 0-2 for moneyline)',
        },
        outcomeName: {
          type: 'string',
          description:
            'Outcome name (e.g. "Yes", "No", "Arsenal", "Draw", "SC Braga")',
        },
        positionSizeUsd: {
          type: 'number',
          description: 'Position size in USD',
        },
        reasoning: {
          type: 'string',
          description: 'Optional: your reasoning for this trade',
        },
      },
    },
  })
  async placeManualTrade(
    @Body()
    body: {
      marketId: number;
      outcomeIndex: number;
      outcomeName: string;
      positionSizeUsd: number;
      reasoning?: string;
    },
  ) {
    this.logger.log(
      `Manual trade: market=${body.marketId} outcome=${body.outcomeName} $${body.positionSizeUsd}`,
    );

    const result = await this.polymarketService.placeManualTrade(body);

    return {
      message: `Trade placed: ${body.outcomeName} $${body.positionSizeUsd}`,
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
      'Get trades filtered by market start date month/year, with market details and P&L',
  })
  @ApiQuery({
    name: 'month',
    required: true,
    type: Number,
    description: 'Month (1-12) — filters by market start date',
  })
  @ApiQuery({
    name: 'year',
    required: true,
    type: Number,
    description: 'Year (e.g. 2026) — filters by market start date',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description:
      'Trade status filter (e.g. open, resolved). Use "all" for all statuses. Default: all.',
  })
  async getTradesByMonth(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('status') status?: string,
  ) {
    const m = Number(month);
    const y = Number(year);

    if (!m || m < 1 || m > 12) {
      return { error: 'month must be between 1 and 12' };
    }
    if (!y || y < 2020 || y > 2100) {
      return { error: 'year must be a valid year (2020-2100)' };
    }

    const trades = await this.polymarketService.getTradesByMonth(m, y, status);

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
