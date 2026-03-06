import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../../database/schema';
import {
  BasketballLiveScoreService,
  BasketballDetectedEvent,
} from './live-score.service';

/**
 * Reacts to live basketball game events detected by BasketballLiveScoreService.
 *
 * Responsibilities:
 *  - game-end       → persist final score to DB
 *  - score-update   → persist live score update
 *  - game-start     → persist status update
 *  - quarter-change → persist status update
 */
@Injectable()
export class BasketballLiveEventHandler implements OnModuleInit {
  private readonly logger = new Logger(BasketballLiveEventHandler.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly liveScoreService: BasketballLiveScoreService,
  ) {}

  onModuleInit(): void {
    this.liveScoreService.onEvent((event) => this.handleEvent(event));
    this.logger.log(
      'BasketballLiveEventHandler registered for live score events',
    );
  }

  private async handleEvent(event: BasketballDetectedEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'game-end':
          await this.onGameEnd(event);
          break;
        case 'score-update':
          await this.onScoreUpdate(event);
          break;
        case 'game-start':
          await this.onGameStart(event);
          break;
        case 'quarter-change':
          await this.onQuarterChange(event);
          break;
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle ${event.type} for basketball fixture ${event.fixtureId}: ${(error as Error).message}`,
      );
    }
  }

  private async onGameEnd(event: BasketballDetectedEvent): Promise<void> {
    const { fixtureId, data } = event;
    const matchTitle = `${event.homeTeamName} vs ${event.awayTeamName}`;

    this.logger.log(
      `Basketball game ended: ${matchTitle} — ${data.scoreHome}-${data.scoreAway} (${data.status ?? 'FT'})`,
    );

    try {
      await this.db
        .update(schema.basketballFixtures)
        .set({
          status: data.status ?? 'FT',
          statusLong: 'Game Finished',
          scoreHome: data.scoreHome,
          scoreAway: data.scoreAway,
          updatedAt: new Date(),
        })
        .where(eq(schema.basketballFixtures.id, fixtureId));

      this.logger.log(
        `Basketball fixture ${fixtureId} updated with final score: ${data.scoreHome}-${data.scoreAway}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to persist final score for basketball fixture ${fixtureId}: ${(error as Error).message}`,
      );
    }
  }

  private async onScoreUpdate(event: BasketballDetectedEvent): Promise<void> {
    const { fixtureId, data } = event;

    try {
      await this.db
        .update(schema.basketballFixtures)
        .set({
          scoreHome: data.scoreHome,
          scoreAway: data.scoreAway,
          updatedAt: new Date(),
        })
        .where(eq(schema.basketballFixtures.id, fixtureId));
    } catch (error) {
      this.logger.warn(
        `Failed to persist score update for basketball fixture ${fixtureId}: ${(error as Error).message}`,
      );
    }
  }

  private async onGameStart(event: BasketballDetectedEvent): Promise<void> {
    const matchTitle = `${event.homeTeamName} vs ${event.awayTeamName}`;
    this.logger.log(`Basketball game started: ${matchTitle}`);

    try {
      await this.db
        .update(schema.basketballFixtures)
        .set({
          status: event.data.status ?? 'Q1',
          statusLong: 'Quarter 1',
          scoreHome: 0,
          scoreAway: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.basketballFixtures.id, event.fixtureId));
    } catch (error) {
      this.logger.warn(
        `Failed to update basketball fixture status for game start: ${(error as Error).message}`,
      );
    }
  }

  private async onQuarterChange(event: BasketballDetectedEvent): Promise<void> {
    try {
      const statusLongMap: Record<string, string> = {
        Q1: 'Quarter 1',
        Q2: 'Quarter 2',
        Q3: 'Quarter 3',
        Q4: 'Quarter 4',
        OT: 'Overtime',
        HT: 'Halftime',
        BT: 'Break Time',
        SUSP: 'Suspended',
        INT: 'Interrupted',
      };

      await this.db
        .update(schema.basketballFixtures)
        .set({
          status: event.data.currentStatus,
          statusLong:
            statusLongMap[event.data.currentStatus] ?? event.data.currentStatus,
          updatedAt: new Date(),
        })
        .where(eq(schema.basketballFixtures.id, event.fixtureId));
    } catch (error) {
      this.logger.warn(
        `Failed to update basketball fixture status change: ${(error as Error).message}`,
      );
    }
  }
}
