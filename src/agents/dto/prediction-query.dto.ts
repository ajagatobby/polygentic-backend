import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PredictionQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by prediction type',
    enum: ['daily', 'pre_match', 'on_demand'],
  })
  @IsOptional()
  @IsString()
  predictionType?: string;

  @ApiPropertyOptional({ description: 'Filter by league ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  leagueId?: number;

  @ApiPropertyOptional({ description: 'Filter by minimum confidence (1-10)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  minConfidence?: number;

  @ApiPropertyOptional({ description: 'Filter by date (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiPropertyOptional({
    description: 'Only show unresolved predictions',
    default: false,
  })
  @IsOptional()
  @IsString()
  unresolved?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
