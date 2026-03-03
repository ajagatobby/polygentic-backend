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

export enum FixtureStatus {
  NOT_STARTED = 'NS',
  FIRST_HALF = '1H',
  HALFTIME = 'HT',
  SECOND_HALF = '2H',
  EXTRA_TIME = 'ET',
  PENALTY = 'P',
  FINISHED = 'FT',
  FINISHED_AET = 'AET',
  FINISHED_PEN = 'PEN',
  POSTPONED = 'PST',
  CANCELLED = 'CANC',
  ABANDONED = 'ABD',
  SUSPENDED = 'SUSP',
  INTERRUPTED = 'INT',
  TBD = 'TBD',
  WALK_OVER = 'WO',
  TECHNICAL_LOSS = 'AWD',
  BREAK_TIME = 'BT',
}

/**
 * User-friendly match state groups that map to one or more FixtureStatus values.
 */
export enum MatchState {
  /** Matches not yet started (NS, TBD) */
  UPCOMING = 'upcoming',
  /** Matches currently in play (1H, HT, 2H, ET, BT, P, SUSP, INT) */
  LIVE = 'live',
  /** Matches that have finished (FT, AET, PEN) */
  FINISHED = 'finished',
  /** Postponed, cancelled, abandoned, walkover, technical loss */
  CANCELLED = 'cancelled',
}

/** Maps each MatchState to the raw API-Football status codes it includes. */
export const MATCH_STATE_STATUSES: Record<MatchState, string[]> = {
  [MatchState.UPCOMING]: ['NS', 'TBD'],
  [MatchState.LIVE]: ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT'],
  [MatchState.FINISHED]: ['FT', 'AET', 'PEN'],
  [MatchState.CANCELLED]: ['PST', 'CANC', 'ABD', 'WO', 'AWD'],
};

export class FixtureQueryDto {
  @ApiPropertyOptional({
    description:
      'Search across league names and team names (case-insensitive, partial match). ' +
      'Example: "premier", "madrid", "la liga"',
    example: 'premier',
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
      'Filter by league name (case-insensitive, partial match). Example: "premier", "la liga"',
    example: 'Premier League',
  })
  @IsOptional()
  @IsString()
  leagueName?: string;

  @ApiPropertyOptional({
    description:
      'Filter by club/team name (case-insensitive, partial match). Returns fixtures where either home or away team matches. Example: "barcelona", "real madrid"',
    example: 'Barcelona',
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
    description: 'Filter by exact fixture status code (e.g. NS, FT, 1H)',
    enum: FixtureStatus,
  })
  @IsOptional()
  @IsEnum(FixtureStatus)
  status?: FixtureStatus;

  @ApiPropertyOptional({
    description:
      'Filter by match state group: upcoming (not started), live (in play), finished (completed), cancelled',
    enum: MatchState,
  })
  @IsOptional()
  @IsEnum(MatchState)
  state?: MatchState;

  @ApiPropertyOptional({ description: 'Filter by team ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teamId?: number;

  @ApiPropertyOptional({
    description: 'Filter by season year',
    example: 2024,
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

export class SyncFixturesDto {
  @ApiPropertyOptional({
    description: 'League IDs to sync. Defaults to tracked leagues.',
    type: [Number],
    example: [39, 140, 135],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ each: true })
  leagueIds?: number[];
}

export class TeamQueryDto {
  @ApiPropertyOptional({ description: 'League ID to filter by' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  leagueId?: number;

  @ApiPropertyOptional({ description: 'Season year' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  season?: number;
}

export class LeagueQueryDto {
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
