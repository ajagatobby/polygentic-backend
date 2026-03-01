import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PolymarketService } from './polymarket.service';
import {
  MarketQueryDto,
  MarketSearchDto,
  MarketDetailResponseDto,
  PaginatedMarketsResponseDto,
  SyncResultDto,
} from './dto/market-query.dto';

@ApiTags('markets')
@Controller('api/markets')
export class PolymarketController {
  private readonly logger = new Logger(PolymarketController.name);

  constructor(private readonly polymarketService: PolymarketService) {}

  @Get()
  @ApiOperation({ summary: 'List Polymarket soccer markets with pagination' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of markets',
    type: PaginatedMarketsResponseDto,
  })
  async getMarkets(
    @Query() query: MarketQueryDto,
  ): Promise<PaginatedMarketsResponseDto> {
    return this.polymarketService.getMarkets(query);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search markets by text query' })
  @ApiQuery({ name: 'query', required: true, description: 'Search text' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max results',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Matching markets',
  })
  async searchMarkets(@Query() searchDto: MarketSearchDto) {
    const results = await this.polymarketService.searchMarkets(
      searchDto.query,
      searchDto.limit,
    );
    return { data: results, total: results.length };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get market detail with price history and event data',
  })
  @ApiParam({ name: 'id', description: 'Polymarket market ID' })
  @ApiResponse({
    status: 200,
    description: 'Market detail',
    type: MarketDetailResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Market not found' })
  async getMarketById(@Param('id') id: string) {
    const market = await this.polymarketService.getMarketById(id);

    if (!market) {
      throw new NotFoundException(`Market with id "${id}" not found`);
    }

    return market;
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger manual sync of soccer events and prices from Polymarket',
  })
  @ApiResponse({
    status: 200,
    description: 'Sync results',
    type: SyncResultDto,
  })
  async triggerSync() {
    this.logger.log('Manual sync triggered');

    const eventResult = await this.polymarketService.syncSoccerEvents();
    const priceResult = await this.polymarketService.syncPrices();

    const allErrors = [
      ...(eventResult.errors ?? []),
      ...(priceResult.errors ?? []),
    ];

    return {
      eventsUpserted: eventResult.eventsUpserted,
      marketsUpserted: eventResult.marketsUpserted,
      pricesInserted: priceResult.pricesInserted,
      errors: allErrors.length > 0 ? allErrors : undefined,
    };
  }
}
