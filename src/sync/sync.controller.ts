import {
  Controller,
  Post,
  Get,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SyncService } from './sync.service';
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
@Controller('api/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

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
