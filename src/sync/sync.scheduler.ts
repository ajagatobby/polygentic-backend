import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncService } from './sync.service';

/**
 * NestJS scheduler for lightweight, idempotent data sync crons.
 *
 * Prediction-critical workloads (daily predictions, pre-match predictions,
 * completed fixture sync + prediction resolution) have been moved to
 * Trigger.dev for durable execution, automatic retries, and observability.
 * See: src/trigger/schedules.ts
 *
 * What remains here:
 * - Fixture sync (upcoming)    — every 30 min
 * - Injuries sync              — every 2 hours
 * - Standings sync             — every 2 hours
 * - Odds sync                  — every 6 hours
 */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private isRunning: Record<string, boolean> = {};

  constructor(
    private readonly syncService: SyncService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log(
      'Sync scheduler initialized. Data sync crons will run on schedule. ' +
        'Prediction tasks are managed by Trigger.dev.',
    );
  }

  // Every 30 minutes: Sync upcoming fixtures
  @Cron(CronExpression.EVERY_30_MINUTES)
  async syncFixtures() {
    if (this.isRunning['fixtures']) {
      this.logger.warn('Fixtures sync already running, skipping...');
      return;
    }
    this.isRunning['fixtures'] = true;
    try {
      await this.syncService.syncFixtures();
    } finally {
      this.isRunning['fixtures'] = false;
    }
  }

  // Every 2 hours: Sync injuries
  @Cron('0 */2 * * *')
  async syncInjuries() {
    if (this.isRunning['injuries']) {
      this.logger.warn('Injuries sync already running, skipping...');
      return;
    }
    this.isRunning['injuries'] = true;
    try {
      await this.syncService.syncInjuries();
    } finally {
      this.isRunning['injuries'] = false;
    }
  }

  // Every 2 hours: Sync standings
  @Cron('0 */2 * * *')
  async syncStandings() {
    if (this.isRunning['standings']) {
      this.logger.warn('Standings sync already running, skipping...');
      return;
    }
    this.isRunning['standings'] = true;
    try {
      await this.syncService.syncStandings();
    } finally {
      this.isRunning['standings'] = false;
    }
  }

  // Every 6 hours: Sync odds
  @Cron('0 */6 * * *')
  async syncOdds() {
    if (this.isRunning['odds']) {
      this.logger.warn('Odds sync already running, skipping...');
      return;
    }
    this.isRunning['odds'] = true;
    try {
      await this.syncService.syncOdds();
    } finally {
      this.isRunning['odds'] = false;
    }
  }
}
