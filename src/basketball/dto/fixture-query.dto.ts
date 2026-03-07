import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  IsEnum,
  Min,
  Max,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Basketball game status codes from API-Basketball.
 */
export enum BasketballFixtureStatus {
  NOT_STARTED = 'NS',
  QUARTER_1 = 'Q1',
  QUARTER_2 = 'Q2',
  QUARTER_3 = 'Q3',
  QUARTER_4 = 'Q4',
  OVERTIME = 'OT',
  BREAK_TIME = 'BT',
  HALFTIME = 'HT',
  FINISHED = 'FT',
  AFTER_OVERTIME = 'AOT',
  POSTPONED = 'POST',
  CANCELLED = 'CANC',
  SUSPENDED = 'SUSP',
  INTERRUPTED = 'INT',
  AWARDED = 'AWD',
  ABANDONED = 'ABD',
}

/**
 * User-friendly match state groups that map to one or more BasketballFixtureStatus values.
 */
export enum BasketballMatchState {
  /** Games not yet started (NS) */
  UPCOMING = 'upcoming',
  /** Games currently in play (Q1, Q2, Q3, Q4, OT, BT, HT) */
  LIVE = 'live',
  /** Games that have finished (FT, AOT) */
  FINISHED = 'finished',
  /** Postponed, cancelled, abandoned, awarded, suspended */
  CANCELLED = 'cancelled',
}

/** Maps each BasketballMatchState to the raw API-Basketball status codes it includes. */
export const BASKETBALL_MATCH_STATE_STATUSES: Record<
  BasketballMatchState,
  string[]
> = {
  [BasketballMatchState.UPCOMING]: ['NS'],
  [BasketballMatchState.LIVE]: ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'HT'],
  [BasketballMatchState.FINISHED]: ['FT', 'AOT'],
  [BasketballMatchState.CANCELLED]: [
    'POST',
    'CANC',
    'SUSP',
    'INT',
    'AWD',
    'ABD',
  ],
};

export class BasketballFixtureQueryDto {
  @ApiPropertyOptional({
    description:
      'Search across league names and team names (case-insensitive, partial match). ' +
      'Example: "lakers", "nba", "euroleague"',
    example: 'nba',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by league ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  leagueId?: number;

  @ApiPropertyOptional({
    description:
      'Filter by league name (case-insensitive, partial match). Example: "nba", "euroleague"',
    example: 'NBA',
  })
  @IsOptional()
  @IsString()
  leagueName?: string;

  @ApiPropertyOptional({
    description:
      'Filter by club/team name (case-insensitive, partial match). Returns fixtures where either home or away team matches.',
    example: 'Lakers',
  })
  @IsOptional()
  @IsString()
  club?: string;

  @ApiPropertyOptional({
    description: 'Filter by date (YYYY-MM-DD)',
    example: '2025-03-15',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    description: 'Filter by exact fixture status code (e.g. NS, FT, Q1)',
    enum: BasketballFixtureStatus,
  })
  @IsOptional()
  @IsEnum(BasketballFixtureStatus)
  status?: BasketballFixtureStatus;

  @ApiPropertyOptional({
    description:
      'Filter by match state group: upcoming (not started), live (in play), finished (completed), cancelled',
    enum: BasketballMatchState,
  })
  @IsOptional()
  @IsEnum(BasketballMatchState)
  state?: BasketballMatchState;

  @ApiPropertyOptional({ description: 'Filter by team ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teamId?: number;

  @ApiPropertyOptional({
    description: 'Filter by season year',
    example: 2025,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  season?: number;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
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
}

export class BasketballSyncFixturesDto {
  @ApiPropertyOptional({
    description: 'League IDs to sync. Defaults to tracked basketball leagues.',
    type: [Number],
    example: [12, 116],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ each: true })
  leagueIds?: number[];
}

export class BasketballLeagueQueryDto {
  @ApiPropertyOptional({ description: 'Filter by country name' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({
    description: 'Only show currently active leagues',
    default: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  current?: boolean = true;
}
