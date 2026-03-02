import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../../database/schema';
import { LiveScoreService, DetectedEvent } from './live-score.service';
import { AlertsService } from '../../alerts/alerts.service';
import { FootballService } from '../football.service';
import { syncCompletedFixturesAndResolveTask } from '../../trigger/sync-and-resolve';

/**
 * Reacts to live match events detected by LiveScoreService.
 *
 * Responsibilities:
 *  - match-end   → persist final score to DB, trigger immediate prediction resolution
 *  - goal        → create live_event alert, persist score update
 *  - red-card    → create live_event alert
 *  - match-start → persist status update
 */
@Injectable()
export class LiveEventHandler implements OnModuleInit {
  private readonly logger = new Logger(LiveEventHandler.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly liveScoreService: LiveScoreService,
    private readonly alertsService: AlertsService,
    private readonly footballService: FootballService,
  ) {}

  onModuleInit(): void {
    this.liveScoreService.onEvent((event) => this.handleEvent(event));
    this.logger.log('LiveEventHandler registered for live score events');
  }

  // ─── Event Router ───────────────────────────────────────────────────

  private async handleEvent(event: DetectedEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'match-end':
          await this.onMatchEnd(event);
          break;
        case 'goal':
          await this.onGoal(event);
          break;
        case 'red-card':
          await this.onRedCard(event);
          break;
        case 'match-start':
          await this.onMatchStart(event);
          break;
        case 'status-change':
          await this.onStatusChange(event);
          break;
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle ${event.type} for fixture ${event.fixtureId}: ${(error as Error).message}`,
      );
    }
  }

  // ─── Event Handlers ─────────────────────────────────────────────────

  /**
   * When a match ends:
   * 1. Persist the final score and FT status directly to the fixtures table
   * 2. Trigger the sync-and-resolve Trigger.dev task for immediate prediction resolution
   *    (rather than waiting for the hourly cron)
   */
  private async onMatchEnd(event: DetectedEvent): Promise<void> {
    const { fixtureId, data } = event;
    const matchTitle = `${event.homeTeamName} vs ${event.awayTeamName}`;

    this.logger.log(
      `Match ended: ${matchTitle} — ${data.goalsHome}-${data.goalsAway} (${data.status ?? 'FT'})`,
    );

    // 1. Persist final score to DB immediately (don't wait for sync cron)
    try {
      await this.db
        .update(schema.fixtures)
        .set({
          status: data.status ?? 'FT',
          statusLong: 'Match Finished',
          goalsHome: data.goalsHome,
          goalsAway: data.goalsAway,
          scoreFulltimeHome: data.goalsHome,
          scoreFulltimeAway: data.goalsAway,
          updatedAt: new Date(),
        })
        .where(eq(schema.fixtures.id, fixtureId));

      this.logger.log(
        `Fixture ${fixtureId} updated with final score: ${data.goalsHome}-${data.goalsAway}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to persist final score for fixture ${fixtureId}: ${(error as Error).message}`,
      );
    }

    // 2. Trigger immediate prediction resolution via Trigger.dev
    try {
      const handle = await syncCompletedFixturesAndResolveTask.trigger(
        undefined as void,
      );
      this.logger.log(
        `Triggered immediate prediction resolution (taskRunId: ${handle.id})`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to trigger prediction resolution: ${(error as Error).message}. ` +
          `Predictions will be resolved by the next hourly cron.`,
      );
    }

    // 3. Create alert
    try {
      await this.alertsService.createLiveEventAlert(
        fixtureId,
        'match_end',
        matchTitle,
        {
          goalsHome: data.goalsHome,
          goalsAway: data.goalsAway,
          status: data.status ?? 'FT',
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to create match-end alert: ${(error as Error).message}`,
      );
    }
  }

  /**
   * When a goal is scored:
   * 1. Update the live score in the fixtures table
   * 2. Create a live_event alert
   */
  private async onGoal(event: DetectedEvent): Promise<void> {
    const { fixtureId, data } = event;
    const matchTitle = `${event.homeTeamName} vs ${event.awayTeamName}`;

    this.logger.log(
      `Goal in ${matchTitle}: ${data.scoringTeamName} (${data.goalsHome}-${data.goalsAway}, ${data.elapsed}')`,
    );

    // Update live score in DB
    try {
      await this.db
        .update(schema.fixtures)
        .set({
          goalsHome: data.goalsHome,
          goalsAway: data.goalsAway,
          elapsed: data.elapsed,
          updatedAt: new Date(),
        })
        .where(eq(schema.fixtures.id, fixtureId));
    } catch (error) {
      this.logger.warn(
        `Failed to persist goal update for fixture ${fixtureId}: ${(error as Error).message}`,
      );
    }

    // Create alert
    try {
      await this.alertsService.createLiveEventAlert(
        fixtureId,
        'goal',
        matchTitle,
        {
          scoringTeamId: data.scoringTeamId,
          scoringTeamName: data.scoringTeamName,
          goalsHome: data.goalsHome,
          goalsAway: data.goalsAway,
          elapsed: data.elapsed,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to create goal alert: ${(error as Error).message}`,
      );
    }
  }

  /**
   * When a red card is shown:
   * Create a live_event alert.
   */
  private async onRedCard(event: DetectedEvent): Promise<void> {
    const matchTitle = `${event.homeTeamName} vs ${event.awayTeamName}`;

    this.logger.log(`Red card in ${matchTitle}: ${event.detail}`);

    try {
      await this.alertsService.createLiveEventAlert(
        event.fixtureId,
        'red_card',
        matchTitle,
        {
          playerName: event.data.playerName,
          teamName: event.data.teamName,
          elapsed: event.data.elapsed,
          cardDetail: event.data.cardDetail,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to create red card alert: ${(error as Error).message}`,
      );
    }
  }

  /**
   * When a match kicks off:
   * Update the fixture status in DB.
   */
  private async onMatchStart(event: DetectedEvent): Promise<void> {
    const matchTitle = `${event.homeTeamName} vs ${event.awayTeamName}`;
    this.logger.log(`Match started: ${matchTitle}`);

    try {
      await this.db
        .update(schema.fixtures)
        .set({
          status: event.data.status ?? '1H',
          statusLong: 'First Half',
          elapsed: 0,
          goalsHome: 0,
          goalsAway: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.fixtures.id, event.fixtureId));
    } catch (error) {
      this.logger.warn(
        `Failed to update fixture status for match start: ${(error as Error).message}`,
      );
    }
  }

  /**
   * On generic status changes (1H -> HT, HT -> 2H, etc.):
   * Update the fixture status in DB.
   */
  private async onStatusChange(event: DetectedEvent): Promise<void> {
    try {
      const statusLongMap: Record<string, string> = {
        '1H': 'First Half',
        HT: 'Halftime',
        '2H': 'Second Half',
        ET: 'Extra Time',
        P: 'Penalty Shootout',
        BT: 'Break Time',
        SUSP: 'Suspended',
        INT: 'Interrupted',
      };

      await this.db
        .update(schema.fixtures)
        .set({
          status: event.data.currentStatus,
          statusLong:
            statusLongMap[event.data.currentStatus] ?? event.data.currentStatus,
          updatedAt: new Date(),
        })
        .where(eq(schema.fixtures.id, event.fixtureId));
    } catch (error) {
      this.logger.warn(
        `Failed to update fixture status change: ${(error as Error).message}`,
      );
    }
  }
}
