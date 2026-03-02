import { schedules, logger } from '@trigger.dev/sdk/v3';
import {
  generateDailyPredictionsTask,
  generatePreMatchPredictionsTask,
} from './generate-daily-predictions';
import { syncCompletedFixturesAndResolveTask } from './sync-and-resolve';

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Trigger.dev Scheduled Tasks                                     │
 * │                                                                  │
 * │  These replace the NestJS @Cron jobs for prediction-critical     │
 * │  workloads. Simple data sync crons (fixtures, injuries,          │
 * │  standings, odds) remain in NestJS @nestjs/schedule.             │
 * └──────────────────────────────────────────────────────────────────┘
 */

/**
 * Daily at 6 AM UTC: Generate predictions for upcoming fixtures (next 48h).
 */
export const dailyPredictionsSchedule = schedules.task({
  id: 'scheduled-daily-predictions',
  cron: '0 6 * * *',
  run: async () => {
    logger.info('Scheduled: daily prediction generation');
    const handle = await generateDailyPredictionsTask.trigger(
      undefined as void,
    );
    logger.info('Triggered daily predictions task', { runId: handle.id });
  },
});

/**
 * Every 15 minutes: Generate pre-match predictions for fixtures within 1 hour.
 */
export const preMatchPredictionsSchedule = schedules.task({
  id: 'scheduled-pre-match-predictions',
  cron: '*/15 * * * *',
  run: async () => {
    logger.info('Scheduled: pre-match prediction generation');
    const handle = await generatePreMatchPredictionsTask.trigger(
      undefined as void,
    );
    logger.info('Triggered pre-match predictions task', { runId: handle.id });
  },
});

/**
 * Every hour: Sync completed fixtures then resolve predictions.
 * This is the critical path that ensures prediction resolution actually happens.
 */
export const syncAndResolveSchedule = schedules.task({
  id: 'scheduled-sync-and-resolve',
  cron: '0 * * * *',
  run: async () => {
    logger.info('Scheduled: sync completed fixtures and resolve predictions');
    const handle = await syncCompletedFixturesAndResolveTask.trigger(
      undefined as void,
    );
    logger.info('Triggered sync and resolve task', { runId: handle.id });
  },
});
