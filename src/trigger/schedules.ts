import { schedules, logger } from '@trigger.dev/sdk/v3';
import {
  generateDailyPredictionsTask,
  generatePreMatchPredictionsTask,
} from './generate-daily-predictions';
import { lineupPredictionTask } from './lineup-prediction';
import { syncCompletedFixturesAndResolveTask } from './sync-and-resolve';
import {
  syncFixturesTask,
  syncInjuriesTask,
  syncStandingsTask,
  syncOddsTask,
} from './sync-data';

/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Trigger.dev Scheduled Tasks                                     │
 * │                                                                  │
 * │  ALL scheduled work runs through Trigger.dev for durable         │
 * │  execution, automatic retries, and observability.                │
 * │                                                                  │
 * │  Prediction-critical:                                            │
 * │  - Daily predictions        — daily at 6 AM UTC                  │
 * │  - Pre-match predictions    — every 15 min                       │
 * │  - Lineup predictions       — every 5 min                        │
 * │  - Sync + resolve           — every hour                         │
 * │                                                                  │
 * │  Data sync:                                                      │
 * │  - Fixtures (upcoming)      — every 30 min                       │
 * │  - Injuries                 — every 2 hours                      │
 * │  - Standings                — every 2 hours                      │
 * │  - Odds                     — every 6 hours                      │
 * └──────────────────────────────────────────────────────────────────┘
 */

// ─── Prediction schedules ───────────────────────────────────────────

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
 * Every 5 minutes: Check for newly available lineups and regenerate predictions.
 */
export const lineupPredictionSchedule = schedules.task({
  id: 'scheduled-lineup-prediction',
  cron: '*/5 * * * *',
  run: async () => {
    logger.info('Scheduled: lineup-aware prediction check');
    const handle = await lineupPredictionTask.trigger(undefined as void);
    logger.info('Triggered lineup prediction task', { runId: handle.id });
  },
});

/**
 * Every hour: Sync completed fixtures then resolve predictions.
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

// ─── Data sync schedules ────────────────────────────────────────────

/**
 * Every 30 minutes: Sync upcoming fixtures for all tracked leagues.
 */
export const fixturesSyncSchedule = schedules.task({
  id: 'scheduled-sync-fixtures',
  cron: '*/30 * * * *',
  run: async () => {
    logger.info('Scheduled: fixtures sync');
    const handle = await syncFixturesTask.trigger(undefined as void);
    logger.info('Triggered fixtures sync task', { runId: handle.id });
  },
});

/**
 * Every 2 hours: Sync injuries for all tracked leagues.
 */
export const injuriesSyncSchedule = schedules.task({
  id: 'scheduled-sync-injuries',
  cron: '0 */2 * * *',
  run: async () => {
    logger.info('Scheduled: injuries sync');
    const handle = await syncInjuriesTask.trigger(undefined as void);
    logger.info('Triggered injuries sync task', { runId: handle.id });
  },
});

/**
 * Every 2 hours: Sync standings for all tracked leagues.
 */
export const standingsSyncSchedule = schedules.task({
  id: 'scheduled-sync-standings',
  cron: '0 */2 * * *',
  run: async () => {
    logger.info('Scheduled: standings sync');
    const handle = await syncStandingsTask.trigger(undefined as void);
    logger.info('Triggered standings sync task', { runId: handle.id });
  },
});

/**
 * Every 6 hours: Sync odds for all tracked leagues.
 */
export const oddsSyncSchedule = schedules.task({
  id: 'scheduled-sync-odds',
  cron: '0 */6 * * *',
  run: async () => {
    logger.info('Scheduled: odds sync');
    const handle = await syncOddsTask.trigger(undefined as void);
    logger.info('Triggered odds sync task', { runId: handle.id });
  },
});
