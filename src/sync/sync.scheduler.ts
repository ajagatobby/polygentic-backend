import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncService } from './sync.service';

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
      'Sync scheduler initialized. Cron jobs will run on schedule.',
    );
    this.logger.log('Running initial Polymarket sync on startup...');

    // Run initial sync after a short delay to let the app finish bootstrapping
    setTimeout(async () => {
      try {
        await this.syncPolymarket();
      } catch (error) {
        this.logger.error(`Initial sync failed: ${error.message}`);
      }
    }, 5000);
  }

  // Every 15 minutes: Sync Polymarket events and prices
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncPolymarket() {
    if (this.isRunning['polymarket']) {
      this.logger.warn('Polymarket sync already running, skipping...');
      return;
    }
    this.isRunning['polymarket'] = true;
    try {
      await this.syncService.syncPolymarket();
    } finally {
      this.isRunning['polymarket'] = false;
    }
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

  // Every 20 minutes: Match markets and generate predictions
  @Cron('*/20 * * * *')
  async matchAndPredict() {
    if (this.isRunning['predictions']) {
      this.logger.warn('Prediction generation already running, skipping...');
      return;
    }
    this.isRunning['predictions'] = true;
    try {
      await this.syncService.matchMarkets();
      await this.syncService.generatePredictions();
    } finally {
      this.isRunning['predictions'] = false;
    }
  }
}
