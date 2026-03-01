import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsArray,
  IsNumber,
  IsInt,
  Min,
  Max,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OddsSyncDto {
  @ApiPropertyOptional({
    description: 'Sport keys to sync odds for. Defaults to all tracked soccer leagues.',
    type: [String],
    example: ['soccer_epl', 'soccer_spain_la_liga'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  sportKeys?: string[];
}

export class BookmakerOddsResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  oddsApiEventId: string;

  @ApiProperty()
  sportKey: string;

  @ApiProperty()
  homeTeam: string;

  @ApiProperty()
  awayTeam: string;

  @ApiProperty()
  commenceTime: Date;

  @ApiProperty()
  bookmakerKey: string;

  @ApiPropertyOptional()
  bookmakerName?: string;

  @ApiProperty()
  marketKey: string;

  @ApiProperty()
  outcomes: any;

  @ApiPropertyOptional()
  impliedProbabilities?: any;

  @ApiPropertyOptional()
  trueProbabilities?: any;

  @ApiPropertyOptional()
  overround?: number;

  @ApiPropertyOptional()
  lastUpdate?: Date;

  @ApiProperty()
  recordedAt: Date;
}

export class ConsensusOddsResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  oddsApiEventId: string;

  @ApiProperty()
  sportKey: string;

  @ApiProperty()
  homeTeam: string;

  @ApiProperty()
  awayTeam: string;

  @ApiProperty()
  commenceTime: Date;

  @ApiProperty()
  marketKey: string;

  @ApiPropertyOptional()
  consensusHomeWin?: number;

  @ApiPropertyOptional()
  consensusDraw?: number;

  @ApiPropertyOptional()
  consensusAwayWin?: number;

  @ApiPropertyOptional()
  consensusOver?: number;

  @ApiPropertyOptional()
  consensusUnder?: number;

  @ApiPropertyOptional()
  consensusPoint?: number;

  @ApiPropertyOptional()
  pinnacleHomeWin?: number;

  @ApiPropertyOptional()
  pinnacleDraw?: number;

  @ApiPropertyOptional()
  pinnacleAwayWin?: number;

  @ApiPropertyOptional()
  numBookmakers?: number;

  @ApiProperty()
  calculatedAt: Date;
}

export class OddsSyncResultDto {
  @ApiProperty()
  eventsProcessed: number;

  @ApiProperty()
  oddsRecordsInserted: number;

  @ApiProperty()
  consensusCalculated: number;

  @ApiPropertyOptional()
  creditsUsed?: number;

  @ApiPropertyOptional()
  creditsRemaining?: number;

  @ApiPropertyOptional()
  errors?: string[];
}

export class EventOddsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by market type (h2h, totals, spreads)', example: 'h2h' })
  @IsOptional()
  @IsString()
  marketKey?: string;
}
