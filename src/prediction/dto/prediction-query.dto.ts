import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  IsNumber,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum Recommendation {
  BUY_YES = 'BUY_YES',
  BUY_NO = 'BUY_NO',
  HOLD = 'HOLD',
  NO_SIGNAL = 'NO_SIGNAL',
}

export class PredictionQueryDto {
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
    description: 'Filter by recommendation',
    enum: Recommendation,
  })
  @IsOptional()
  @IsEnum(Recommendation)
  recommendation?: Recommendation;

  @ApiPropertyOptional({
    description: 'Minimum confidence score (0-100)',
    example: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minConfidence?: number;

  @ApiPropertyOptional({ description: 'Filter by status (active, resolved)' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class MispricingQueryDto {
  @ApiPropertyOptional({
    description: 'Minimum absolute mispricing gap to include',
    example: 0.05,
    default: 0.05,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  minGap?: number = 0.05;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class PredictionResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  polymarketMarketId: string;

  @ApiPropertyOptional()
  fixtureId?: number;

  @ApiProperty()
  polymarketPrice: number;

  @ApiPropertyOptional()
  bookmakerConsensus?: number;

  @ApiPropertyOptional()
  pinnacleProbability?: number;

  @ApiPropertyOptional()
  statisticalModelProb?: number;

  @ApiPropertyOptional()
  apiFootballPrediction?: number;

  @ApiProperty()
  predictedProbability: number;

  @ApiPropertyOptional()
  mispricingGap?: number;

  @ApiPropertyOptional()
  mispricingPct?: number;

  @ApiPropertyOptional()
  confidenceScore?: number;

  @ApiPropertyOptional()
  recommendation?: string;

  @ApiPropertyOptional()
  reasoning?: string;

  @ApiPropertyOptional()
  signals?: any;

  @ApiPropertyOptional()
  isLive?: boolean;

  @ApiPropertyOptional()
  status?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}

export class PredictionDetailResponseDto extends PredictionResponseDto {
  @ApiPropertyOptional({ description: 'Polymarket market data' })
  market?: any;

  @ApiPropertyOptional({ description: 'Fixture data' })
  fixture?: any;

  @ApiPropertyOptional({ description: 'Consensus odds data' })
  consensus?: any;
}

export class GeneratePredictionsResultDto {
  @ApiProperty()
  predictionsGenerated: number;

  @ApiProperty()
  marketsProcessed: number;

  @ApiPropertyOptional()
  errors?: string[];
}
