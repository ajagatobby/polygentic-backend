import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export enum MarketType {
  MATCH_OUTCOME = 'match_outcome',
  LEAGUE_WINNER = 'league_winner',
  TOP_FINISH = 'top_finish',
  RELEGATION = 'relegation',
  TRANSFER = 'transfer',
  TOURNAMENT = 'tournament',
  PLAYER_PROP = 'player_prop',
  MANAGER = 'manager',
  OTHER = 'other',
}

export class MarketQueryDto {
  @ApiPropertyOptional({ description: 'Page number (1-indexed)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 20,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Filter by market type',
    enum: MarketType,
  })
  @IsOptional()
  @IsEnum(MarketType)
  type?: MarketType;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

export class MarketSearchDto {
  @ApiProperty({ description: 'Search query string' })
  @IsString()
  query: string;

  @ApiPropertyOptional({ description: 'Maximum results', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class MarketResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  question: string;

  @ApiProperty()
  eventId: string;

  @ApiPropertyOptional()
  slug?: string;

  @ApiPropertyOptional()
  conditionId?: string;

  @ApiProperty()
  outcomes: string[];

  @ApiProperty()
  outcomePrices: string[];

  @ApiProperty()
  clobTokenIds: string[];

  @ApiPropertyOptional()
  volume?: string;

  @ApiPropertyOptional()
  volume24hr?: string;

  @ApiPropertyOptional()
  liquidity?: string;

  @ApiPropertyOptional()
  spread?: string;

  @ApiPropertyOptional()
  active?: boolean;

  @ApiPropertyOptional()
  closed?: boolean;

  @ApiPropertyOptional()
  marketType?: string;

  @ApiPropertyOptional()
  createdAt?: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}

export class PriceHistoryEntryDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  marketId: string;

  @ApiProperty()
  yesPrice: string;

  @ApiProperty()
  noPrice: string;

  @ApiPropertyOptional()
  midpoint?: string;

  @ApiPropertyOptional()
  spread?: string;

  @ApiPropertyOptional()
  volume24hr?: string;

  @ApiPropertyOptional()
  liquidity?: string;

  @ApiProperty()
  recordedAt: Date;
}

export class EventResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  slug?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  startDate?: Date;

  @ApiPropertyOptional()
  endDate?: Date;

  @ApiPropertyOptional()
  active?: boolean;

  @ApiPropertyOptional()
  closed?: boolean;

  @ApiPropertyOptional()
  tags?: any;
}

export class MarketDetailResponseDto extends MarketResponseDto {
  @ApiPropertyOptional({
    description: 'Recent price history entries',
    type: [PriceHistoryEntryDto],
  })
  priceHistory?: PriceHistoryEntryDto[];

  @ApiPropertyOptional({ description: 'Parent event data' })
  event?: EventResponseDto;
}

export class PaginatedMarketsResponseDto {
  @ApiProperty({ type: [MarketResponseDto] })
  data: MarketResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  totalPages: number;
}

export class SyncResultDto {
  @ApiProperty()
  eventsUpserted: number;

  @ApiProperty()
  marketsUpserted: number;

  @ApiPropertyOptional()
  pricesInserted?: number;

  @ApiPropertyOptional()
  errors?: string[];
}
