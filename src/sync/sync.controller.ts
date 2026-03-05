import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { FootballService } from '../football/football.service';
import {
  syncFixturesTask,
  syncCompletedFixturesTask,
  syncInjuriesTask,
  syncStandingsTask,
  syncOddsTask,
  fullSyncTask,
} from '../trigger/sync-data';

/**
 * Sync endpoints — all POST endpoints trigger Trigger.dev tasks and
 * return immediately with a taskRunId. Data saves to the DB
 * incrementally as each league completes in the background.
 *
 * Track progress via the Trigger.dev dashboard or the run ID.
 */
@ApiTags('Sync')
@ApiBearerAuth('firebase-auth')
@Controller('api/sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly syncService: SyncService,
    private readonly footballService: FootballService,
  ) {}

  // ─── Trigger.dev task endpoints ────────────────────────────────────

  @Post('full')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Launch a full sync (fixtures, standings, injuries, odds). Returns immediately — data saves incrementally.',
  })
  async fullSync() {
    const handle = await fullSyncTask.trigger(undefined as void);
    return {
      message:
        'Full sync started. Data is being saved as each league completes.',
      taskRunId: handle.id,
    };
  }

  @Post('fixtures')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Launch fixtures sync for all tracked leagues. Returns immediately.',
  })
  async syncFixtures() {
    const handle = await syncFixturesTask.trigger(undefined as void);
    return {
      message: 'Fixtures sync started.',
      taskRunId: handle.id,
    };
  }

  @Post('completed-fixtures')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Launch completed fixtures sync (final scores). Returns immediately.',
  })
  async syncCompletedFixtures() {
    const handle = await syncCompletedFixturesTask.trigger(undefined as void);
    return {
      message: 'Completed fixtures sync started.',
      taskRunId: handle.id,
    };
  }

  @Post('injuries')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Launch injuries sync for all tracked leagues. Returns immediately.',
  })
  async syncInjuries() {
    const handle = await syncInjuriesTask.trigger(undefined as void);
    return {
      message: 'Injuries sync started.',
      taskRunId: handle.id,
    };
  }

  @Post('standings')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Launch standings sync for all tracked leagues. Returns immediately.',
  })
  async syncStandings() {
    const handle = await syncStandingsTask.trigger(undefined as void);
    return {
      message: 'Standings sync started.',
      taskRunId: handle.id,
    };
  }

  @Post('odds')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Launch odds sync. Returns immediately.',
  })
  async syncOdds() {
    const handle = await syncOddsTask.trigger(undefined as void);
    return {
      message: 'Odds sync started.',
      taskRunId: handle.id,
    };
  }

  // ─── Manual league sync ─────────────────────────────────────────────

  @Post('league')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sync a specific league — fixtures, teams, injuries, and standings. Runs inline and returns results.',
  })
  async syncLeague(@Body() body: { leagueId: number }) {
    const { leagueId } = body;
    if (!leagueId) {
      return { success: false, message: 'leagueId is required' };
    }

    this.logger.log(`Manual sync triggered for league ${leagueId}`);
    const startTime = Date.now();
    const results: Record<string, { count: number; error?: string }> = {};

    // Run all sync operations for this league in parallel
    const [fixtures, teams, injuries, standings] = await Promise.allSettled([
      this.footballService.syncFixtures([leagueId]),
      this.footballService.syncTeams(
        leagueId,
        FootballService.getCurrentSeason(),
      ),
      this.footballService.syncInjuries(leagueId),
      this.footballService.syncStandings(leagueId),
    ]);

    results.fixtures = {
      count: fixtures.status === 'fulfilled' ? (fixtures.value as number) : 0,
      ...(fixtures.status === 'rejected'
        ? { error: fixtures.reason?.message }
        : {}),
    };
    results.teams = {
      count: teams.status === 'fulfilled' ? (teams.value as number) : 0,
      ...(teams.status === 'rejected' ? { error: teams.reason?.message } : {}),
    };
    results.injuries = {
      count: injuries.status === 'fulfilled' ? (injuries.value as number) : 0,
      ...(injuries.status === 'rejected'
        ? { error: injuries.reason?.message }
        : {}),
    };
    results.standings = {
      count: standings.status === 'fulfilled' ? (standings.value as number) : 0,
      ...(standings.status === 'rejected'
        ? { error: standings.reason?.message }
        : {}),
    };

    const duration = Date.now() - startTime;
    const succeeded = [fixtures, teams, injuries, standings].filter(
      (r) => r.status === 'fulfilled',
    ).length;

    this.logger.log(
      `League ${leagueId} sync complete in ${duration}ms: ${succeeded}/4 succeeded`,
    );

    return {
      success: succeeded > 0,
      leagueId,
      durationMs: duration,
      results,
    };
  }

  // ─── Sync log (database-persisted history) ─────────────────────────

  @Get('history')
  @ApiOperation({ summary: 'Get sync history from database log' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max records to return (default 50)',
  })
  async getSyncHistory(@Query('limit') limit?: string) {
    return this.syncService.getSyncHistory(limit ? parseInt(limit, 10) : 50);
  }
}
