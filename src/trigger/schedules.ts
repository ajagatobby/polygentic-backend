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
import { polymarketScanTask, polymarketTradeTask } from './polymarket-scan';
import {
  syncBasketballFixturesTask,
  syncBasketballCompletedFixturesTask,
  syncBasketballStandingsTask,
} from './basketball-sync-data';

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
 * │  Polymarket:                                                      │
 * │  - Market scan (Gamma API)  — every 30 min                       │
 * │  - Trading cycle            — every 2 hours                      │
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

// ─── Basketball data sync schedules ─────────────────────────────────
//
// Conservative schedules for the API-Basketball free tier (100 req/day).
// Each sync run uses ~10 requests (1 per tracked league).
// Total daily API usage: ~40-50 requests, leaving headroom for manual calls.
//
// To increase frequency, upgrade your API plan and set
// API_BASKETBALL_DAILY_LIMIT in .env accordingly.
// ────────────────────────────────────────────────────────────────────

/**
 * Every 12 hours (6 AM and 6 PM UTC): Sync upcoming basketball fixtures.
 * ~10 API requests per run.
 */
export const basketballFixturesSyncSchedule = schedules.task({
  id: 'scheduled-sync-basketball-fixtures',
  cron: '0 6,18 * * *',
  run: async () => {
    logger.info('Scheduled: basketball fixtures sync');
    const handle = await syncBasketballFixturesTask.trigger(undefined as void);
    logger.info('Triggered basketball fixtures sync task', {
      runId: handle.id,
    });
  },
});

/**
 * Once per day at 7 AM UTC: Sync basketball standings.
 * ~10 API requests per run.
 */
export const basketballStandingsSyncSchedule = schedules.task({
  id: 'scheduled-sync-basketball-standings',
  cron: '0 7 * * *',
  run: async () => {
    logger.info('Scheduled: basketball standings sync');
    const handle = await syncBasketballStandingsTask.trigger(undefined as void);
    logger.info('Triggered basketball standings sync task', {
      runId: handle.id,
    });
  },
});

/**
 * Once per day at 8 AM UTC: Sync completed basketball fixtures (final scores).
 * ~20 API requests per run (2 dates x 10 leagues).
 */
export const basketballCompletedFixturesSyncSchedule = schedules.task({
  id: 'scheduled-sync-basketball-completed-fixtures',
  cron: '0 8 * * *',
  run: async () => {
    logger.info('Scheduled: basketball completed fixtures sync');
    const handle = await syncBasketballCompletedFixturesTask.trigger(
      undefined as void,
    );
    logger.info('Triggered basketball completed fixtures sync task', {
      runId: handle.id,
    });
  },
});

// ─── Polymarket trading agent ───────────────────────────────────────

/**
 * Every 30 minutes: Scan Polymarket for soccer markets, evaluate
 * trading opportunities, and place paper/live trades.
 */
export const polymarketScanSchedule = schedules.task({
  id: 'scheduled-polymarket-scan',
  cron: '*/30 * * * *',
  run: async () => {
    logger.info('Scheduled: Polymarket trading agent scan');
    const handle = await polymarketScanTask.trigger(undefined as void);
    logger.info('Triggered Polymarket scan task', { runId: handle.id });
  },
});

/**
 * Every 2 hours: Evaluate persisted Polymarket markets, generate predictions
 * for fixtures that need them (soonest-first), and place trades.
 */
export const polymarketTradeSchedule = schedules.task({
  id: 'scheduled-polymarket-trade',
  cron: '15 */2 * * *',
  run: async () => {
    logger.info('Scheduled: Polymarket trading cycle');
    const handle = await polymarketTradeTask.trigger(undefined as void);
    logger.info('Triggered Polymarket trade task', { runId: handle.id });
  },
});
