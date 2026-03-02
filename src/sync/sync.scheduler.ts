import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncService } from './sync.service';
import { AgentsService } from '../agents/agents.service';

@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private isRunning: Record<string, boolean> = {};

  constructor(
    private readonly syncService: SyncService,
    private readonly configService: ConfigService,
    private readonly agentsService: AgentsService,
  ) {}

  async onModuleInit() {
    this.logger.log(
      'Sync scheduler initialized. Cron jobs will run on schedule.',
    );
  }

  // Every 30 minutes: Sync fixtures
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

  // Daily at 6 AM UTC: Generate predictions for upcoming fixtures (next 48hrs)
  @Cron('0 6 * * *')
  async generateDailyPredictions() {
    if (this.isRunning['daily_predictions']) {
      this.logger.warn('Daily predictions already running, skipping...');
      return;
    }
    this.isRunning['daily_predictions'] = true;
    try {
      this.logger.log('Starting daily prediction generation...');
      const result = await this.agentsService.generateDailyPredictions();
      this.logger.log(
        `Daily predictions: ${result.generated} generated, ${result.skipped} skipped, ${result.failed} failed`,
      );
    } catch (error) {
      this.logger.error(`Daily predictions failed: ${error.message}`);
    } finally {
      this.isRunning['daily_predictions'] = false;
    }
  }

  // Every 15 minutes: Generate pre-match predictions for fixtures within 1hr
  @Cron('*/15 * * * *')
  async generatePreMatchPredictions() {
    if (this.isRunning['pre_match_predictions']) {
      this.logger.warn('Pre-match predictions already running, skipping...');
      return;
    }
    this.isRunning['pre_match_predictions'] = true;
    try {
      const result = await this.agentsService.generatePreMatchPredictions();
      if (result.generated > 0) {
        this.logger.log(
          `Pre-match predictions: ${result.generated} generated, ${result.skipped} skipped`,
        );
      }
    } catch (error) {
      this.logger.error(`Pre-match predictions failed: ${error.message}`);
    } finally {
      this.isRunning['pre_match_predictions'] = false;
    }
  }

  // Every 2 hours: Resolve predictions for finished matches
  @Cron('30 */2 * * *')
  async resolvePredictions() {
    if (this.isRunning['resolve_predictions']) {
      this.logger.warn('Prediction resolution already running, skipping...');
      return;
    }
    this.isRunning['resolve_predictions'] = true;
    try {
      const result = await this.agentsService.resolvePredictions();
      if (result.resolved > 0) {
        this.logger.log(`Resolved ${result.resolved} predictions`);
      }
    } catch (error) {
      this.logger.error(`Prediction resolution failed: ${error.message}`);
    } finally {
      this.isRunning['resolve_predictions'] = false;
    }
  }
}
