import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { SyncService } from './sync.service';

@ApiTags('Sync')
@Controller('api/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  // ─── Fire-and-forget sync endpoints ────────────────────────────────
  // All POST endpoints return immediately with a job ID.
  // Data is saved to the DB incrementally as each league completes.
  // Poll GET /api/sync/jobs/:id to track progress.

  @Post('full')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Launch a full sync (fixtures, standings, injuries, odds). Returns immediately — data saves incrementally.',
  })
  fullSync() {
    const job = this.syncService.launchFullSync();
    return {
      message:
        'Full sync started. Data is being saved as each league completes.',
      jobId: job.id,
      status: job.status,
      pollUrl: `/api/sync/jobs/${job.id}`,
    };
  }

  @Post('fixtures')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Launch fixtures sync. Returns immediately.',
  })
  syncFixtures() {
    const job = this.syncService.launchFixturesSync();
    return {
      message: 'Fixtures sync started.',
      jobId: job.id,
      pollUrl: `/api/sync/jobs/${job.id}`,
    };
  }

  @Post('completed-fixtures')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Launch completed fixtures sync. Returns immediately.',
  })
  syncCompletedFixtures() {
    const job = this.syncService.launchCompletedFixturesSync();
    return {
      message: 'Completed fixtures sync started.',
      jobId: job.id,
      pollUrl: `/api/sync/jobs/${job.id}`,
    };
  }

  @Post('injuries')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Launch injuries sync. Returns immediately.',
  })
  syncInjuries() {
    const job = this.syncService.launchInjuriesSync();
    return {
      message: 'Injuries sync started.',
      jobId: job.id,
      pollUrl: `/api/sync/jobs/${job.id}`,
    };
  }

  @Post('standings')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Launch standings sync. Returns immediately.',
  })
  syncStandings() {
    const job = this.syncService.launchStandingsSync();
    return {
      message: 'Standings sync started.',
      jobId: job.id,
      pollUrl: `/api/sync/jobs/${job.id}`,
    };
  }

  @Post('odds')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Launch odds sync. Returns immediately.',
  })
  syncOdds() {
    const job = this.syncService.launchOddsSync();
    return {
      message: 'Odds sync started.',
      jobId: job.id,
      pollUrl: `/api/sync/jobs/${job.id}`,
    };
  }

  // ─── Job tracking endpoints ────────────────────────────────────────

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get sync job status and progress' })
  @ApiParam({ name: 'id', description: 'Sync job ID' })
  getJob(@Param('id') id: string) {
    const job = this.syncService.getJob(id);
    if (!job) {
      throw new NotFoundException(`Sync job ${id} not found`);
    }

    const completedSteps = job.steps.filter(
      (s) => s.status === 'completed',
    ).length;
    const failedSteps = job.steps.filter((s) => s.status === 'failed').length;
    const totalSteps = job.steps.length;

    return {
      ...job,
      progress: {
        completedSteps,
        failedSteps,
        totalSteps,
        runningSteps: totalSteps - completedSteps - failedSteps,
      },
    };
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List recent sync jobs' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max jobs to return (default 20)',
  })
  getRecentJobs(@Query('limit') limit?: string) {
    return this.syncService.getRecentJobs(limit ? parseInt(limit, 10) : 20);
  }

  @Get('jobs/active')
  @ApiOperation({ summary: 'List currently running sync jobs' })
  getActiveJobs() {
    return this.syncService.getActiveJobs();
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
