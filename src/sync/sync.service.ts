import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as schema from '../database/schema';
import { FootballService, TRACKED_LEAGUES } from '../football/football.service';
import { OddsService } from '../odds/odds.service';
import { desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// ─── Job tracking types ────────────────────────────────────────────────

export type SyncJobStatus = 'running' | 'completed' | 'failed';

export interface SyncJobStep {
  name: string;
  status: SyncJobStatus;
  recordsProcessed: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface SyncJob {
  id: string;
  type: string;
  status: SyncJobStatus;
  steps: SyncJobStep[];
  totalRecordsProcessed: number;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  /** In-memory store for active and recently completed sync jobs. */
  private readonly jobs = new Map<string, SyncJob>();

  /** Max number of completed jobs to keep in memory. */
  private readonly MAX_COMPLETED_JOBS = 50;

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly configService: ConfigService,
    private readonly footballService: FootballService,
    private readonly oddsService: OddsService,
  ) {}

  // ─── Fire-and-forget launchers ─────────────────────────────────────

  /**
   * Launch a sync operation in the background and return immediately
   * with a job ID that can be polled via GET /api/sync/jobs/:id.
   */
  launchSync(type: string, fn: () => Promise<void>): SyncJob {
    const job: SyncJob = {
      id: randomUUID(),
      type,
      status: 'running',
      steps: [],
      totalRecordsProcessed: 0,
      startedAt: new Date(),
    };

    this.jobs.set(job.id, job);
    this.pruneOldJobs();

    // Fire and forget — the promise runs in the background
    fn().catch((error) => {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();
      this.logger.error(
        `Sync job ${job.id} (${type}) failed: ${error.message}`,
      );
    });

    return job;
  }

  launchFullSync(): SyncJob {
    return this.launchSync('full', () => this.runFullSync());
  }

  launchFixturesSync(): SyncJob {
    return this.launchSync('fixtures', () => this.syncFixtures());
  }

  launchCompletedFixturesSync(): SyncJob {
    return this.launchSync('completed_fixtures', () =>
      this.syncCompletedFixtures(),
    );
  }

  launchInjuriesSync(): SyncJob {
    return this.launchSync('injuries', () => this.syncInjuries());
  }

  launchStandingsSync(): SyncJob {
    return this.launchSync('standings', () => this.syncStandings());
  }

  launchOddsSync(): SyncJob {
    return this.launchSync('odds', () => this.syncOdds());
  }

  getJob(id: string): SyncJob | undefined {
    return this.jobs.get(id);
  }

  getActiveJobs(): SyncJob[] {
    return [...this.jobs.values()].filter((j) => j.status === 'running');
  }

  getRecentJobs(limit = 20): SyncJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  // ─── Core sync methods (called internally / by scheduler) ──────────

  async syncFixtures(): Promise<void> {
    const startedAt = new Date();
    const job = this.findRunningJob('fixtures');
    try {
      this.logger.log('Starting fixtures sync...');
      let totalProcessed = 0;

      for (const leagueId of TRACKED_LEAGUES) {
        const step = this.addStep(job, `fixtures_league_${leagueId}`);
        try {
          const result: any = await this.footballService.syncFixtures([
            leagueId,
          ]);
          const count = result || 0;
          totalProcessed += count;
          this.completeStep(step, count);
        } catch (error) {
          this.failStep(step, error.message);
          this.logger.warn(
            `Failed to sync fixtures for league ${leagueId}: ${error.message}`,
          );
        }
      }

      this.updateJobTotal(job, totalProcessed);
      await this.logSync(
        'api_football',
        'sync_fixtures',
        'completed',
        startedAt,
        { recordsProcessed: totalProcessed },
      );
      this.logger.log(
        `Fixtures sync completed. ${totalProcessed} fixtures processed.`,
      );
    } catch (error) {
      this.logger.error(`Fixtures sync failed: ${error.message}`);
      await this.logSync('api_football', 'sync_fixtures', 'failed', startedAt, {
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async syncInjuries(): Promise<void> {
    const startedAt = new Date();
    const job = this.findRunningJob('injuries');
    try {
      this.logger.log('Starting injuries sync...');
      let totalProcessed = 0;

      for (const leagueId of TRACKED_LEAGUES) {
        const step = this.addStep(job, `injuries_league_${leagueId}`);
        try {
          const result: any = await this.footballService.syncInjuries(leagueId);
          const count = result || 0;
          totalProcessed += count;
          this.completeStep(step, count);
        } catch (error) {
          this.failStep(step, error.message);
          this.logger.warn(
            `Failed to sync injuries for league ${leagueId}: ${error.message}`,
          );
        }
      }

      this.updateJobTotal(job, totalProcessed);
      await this.logSync(
        'api_football',
        'sync_injuries',
        'completed',
        startedAt,
        { recordsProcessed: totalProcessed },
      );
      this.logger.log(
        `Injuries sync completed. ${totalProcessed} records processed.`,
      );
    } catch (error) {
      this.logger.error(`Injuries sync failed: ${error.message}`);
      await this.logSync('api_football', 'sync_injuries', 'failed', startedAt, {
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async syncStandings(): Promise<void> {
    const startedAt = new Date();
    const job = this.findRunningJob('standings');
    try {
      this.logger.log('Starting standings sync...');
      let totalProcessed = 0;

      for (const leagueId of TRACKED_LEAGUES) {
        const step = this.addStep(job, `standings_league_${leagueId}`);
        try {
          const count = await this.footballService.syncStandings(leagueId);
          totalProcessed += count || 0;
          this.completeStep(step, count || 0);
        } catch (error) {
          this.failStep(step, error.message);
          this.logger.warn(
            `Failed to sync standings for league ${leagueId}: ${error.message}`,
          );
        }
      }

      this.updateJobTotal(job, totalProcessed);
      await this.logSync(
        'api_football',
        'sync_standings',
        'completed',
        startedAt,
      );
      this.logger.log(`Standings sync completed. ${totalProcessed} records.`);
    } catch (error) {
      this.logger.error(`Standings sync failed: ${error.message}`);
      await this.logSync(
        'api_football',
        'sync_standings',
        'failed',
        startedAt,
        { errorMessage: error.message },
      );
      throw error;
    }
  }

  async syncCompletedFixtures(): Promise<void> {
    const startedAt = new Date();
    const job = this.findRunningJob('completed_fixtures');
    try {
      this.logger.log('Starting completed fixtures sync...');
      let totalProcessed = 0;

      for (const leagueId of TRACKED_LEAGUES) {
        const step = this.addStep(job, `completed_fixtures_league_${leagueId}`);
        try {
          const result: any = await this.footballService.syncCompletedFixtures([
            leagueId,
          ]);
          const count = result || 0;
          totalProcessed += count;
          this.completeStep(step, count);
        } catch (error) {
          this.failStep(step, error.message);
          this.logger.warn(
            `Failed to sync completed fixtures for league ${leagueId}: ${error.message}`,
          );
        }
      }

      this.updateJobTotal(job, totalProcessed);
      await this.logSync(
        'api_football',
        'sync_completed_fixtures',
        'completed',
        startedAt,
        { recordsProcessed: totalProcessed },
      );
      this.logger.log(
        `Completed fixtures sync finished. ${totalProcessed} fixtures processed.`,
      );
    } catch (error) {
      this.logger.error(`Completed fixtures sync failed: ${error.message}`);
      await this.logSync(
        'api_football',
        'sync_completed_fixtures',
        'failed',
        startedAt,
        { errorMessage: error.message },
      );
      throw error;
    }
  }

  async syncOdds(): Promise<void> {
    const startedAt = new Date();
    const job = this.findRunningJob('odds');
    try {
      this.logger.log('Starting odds sync...');
      await this.oddsService.syncAllSoccerOdds();

      await this.logSync('odds_api', 'sync_odds', 'completed', startedAt);
      this.logger.log('Odds sync completed.');
    } catch (error) {
      this.logger.error(`Odds sync failed: ${error.message}`);
      await this.logSync('odds_api', 'sync_odds', 'failed', startedAt, {
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async runFullSync(): Promise<void> {
    this.logger.log('=== Starting full sync cycle ===');
    const job = this.findRunningJob('full');

    const steps = [
      { name: 'fixtures', fn: () => this.syncFixtures() },
      { name: 'completed_fixtures', fn: () => this.syncCompletedFixtures() },
      { name: 'standings', fn: () => this.syncStandings() },
      { name: 'injuries', fn: () => this.syncInjuries() },
      { name: 'odds', fn: () => this.syncOdds() },
    ];

    for (const step of steps) {
      const jobStep = this.addStep(job, step.name);
      try {
        await step.fn();
        this.completeStep(jobStep, 0);
      } catch (error) {
        this.failStep(jobStep, error.message);
      }
    }

    if (job) {
      job.status = 'completed';
      job.completedAt = new Date();
    }

    this.logger.log('=== Full sync cycle finished ===');
  }

  async getSyncHistory(limit = 50): Promise<any[]> {
    return this.db
      .select()
      .from(schema.syncLog)
      .orderBy(desc(schema.syncLog.startedAt))
      .limit(limit);
  }

  // ─── Job tracking helpers ──────────────────────────────────────────

  /**
   * Find the most recent running job of a given type.
   * Used by sync methods to update progress on the job that launched them.
   */
  private findRunningJob(type: string): SyncJob | undefined {
    for (const job of this.jobs.values()) {
      // Direct match (e.g. type = 'injuries' for launchInjuriesSync)
      if (job.type === type && job.status === 'running') return job;
      // Full sync delegates to individual sync methods — find the parent
      if (job.type === 'full' && job.status === 'running') return job;
    }
    return undefined;
  }

  private addStep(
    job: SyncJob | undefined,
    name: string,
  ): SyncJobStep | undefined {
    if (!job) return undefined;
    const step: SyncJobStep = {
      name,
      status: 'running',
      recordsProcessed: 0,
      startedAt: new Date(),
    };
    job.steps.push(step);
    return step;
  }

  private completeStep(
    step: SyncJobStep | undefined,
    recordsProcessed: number,
  ): void {
    if (!step) return;
    step.status = 'completed';
    step.recordsProcessed = recordsProcessed;
    step.completedAt = new Date();
  }

  private failStep(step: SyncJobStep | undefined, error: string): void {
    if (!step) return;
    step.status = 'failed';
    step.error = error;
    step.completedAt = new Date();
  }

  private updateJobTotal(
    job: SyncJob | undefined,
    totalProcessed: number,
  ): void {
    if (!job) return;
    job.totalRecordsProcessed += totalProcessed;
    // If this is a single-type job (not full), mark it completed
    if (job.type !== 'full') {
      job.status = 'completed';
      job.completedAt = new Date();
    }
  }

  /** Remove oldest completed jobs when we exceed the limit. */
  private pruneOldJobs(): void {
    const completed = [...this.jobs.entries()]
      .filter(([, j]) => j.status !== 'running')
      .sort(
        ([, a], [, b]) =>
          (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0),
      );

    while (completed.length > this.MAX_COMPLETED_JOBS) {
      const [id] = completed.shift()!;
      this.jobs.delete(id);
    }
  }

  // ─── Sync log persistence ─────────────────────────────────────────

  private async logSync(
    source: string,
    task: string,
    status: 'started' | 'completed' | 'failed',
    startedAt: Date,
    extra?: {
      recordsProcessed?: number;
      errorMessage?: string;
      apiRequestsUsed?: number;
    },
  ): Promise<void> {
    try {
      const completedAt = status !== 'started' ? new Date() : null;
      const durationMs = completedAt
        ? completedAt.getTime() - startedAt.getTime()
        : null;

      await this.db.insert(schema.syncLog).values({
        source,
        task,
        status,
        recordsProcessed: extra?.recordsProcessed || null,
        errorMessage: extra?.errorMessage || null,
        apiRequestsUsed: extra?.apiRequestsUsed || null,
        durationMs,
        startedAt,
        completedAt,
      });
    } catch (error) {
      this.logger.error(`Failed to log sync: ${error.message}`);
    }
  }
}
