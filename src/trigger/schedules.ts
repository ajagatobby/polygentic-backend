import { schedules, logger } from '@trigger.dev/sdk/v3';
import {
  generateDailyPredictionsTask,
  generatePreMatchPredictionsTask,
} from './generate-daily-predictions';
import { lineupPredictionTask } from './lineup-prediction';
import { lateResearchRefreshTask } from './late-research-refresh';
import { refitIsotonicCalibrationTask } from './refit-isotonic-calibration';
import { syncCompletedFixturesAndResolveTask } from './sync-and-resolve';
import {
  syncFixturesTask,
  syncInjuriesTask,
  syncStandingsTask,
  syncOddsTask,
  snapshotPolymarketHoldersTask,
} from './sync-data';
import { polymarketScanTask, polymarketTradeTask } from './polymarket-scan';
import { polymarketMarketSnapshotTask } from './polymarket-market-snapshot';
import { polymarketBackfillHistoryTask } from './polymarket-backfill-history';
import { polymarketTodaySnapshotTask } from './polymarket-today-snapshot';
import { copyTraderSyncTask } from './copy-trader-sync';
import {
  syncBasketballFixturesTask,
  syncBasketballCompletedFixturesTask,
  syncBasketballStandingsTask,
} from './basketball-sync-data';
import {
  baseballSyncGamesTask,
  baseballSyncResultsTask,
  baseballRefreshStatcastTask,
} from './baseball-sync-games';
import {
  baseballGeneratePredictionsTask,
  baseballPreGameRefreshTask,
  baseballResolvePredictionsTask,
  baseballRefitModelsTask,
} from './baseball-predictions';

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
 * Every 15 minutes: T-2h late-news refresh. Re-runs the prediction
 * pipeline for fixtures starting in ~105–145 minutes that already have a
 * pre_match prediction, so we capture late team-news / weather / lineup
 * leaks that move the line. Each fixture is refreshed at most once via
 * the matchContext.lateRefreshed flag.
 */
export const lateResearchRefreshSchedule = schedules.task({
  id: 'scheduled-late-research-refresh',
  cron: '*/15 * * * *',
  run: async () => {
    logger.info('Scheduled: late-news refresh (T-2h window)');
    const handle = await lateResearchRefreshTask.trigger(undefined as void);
    logger.info('Triggered late-news refresh task', { runId: handle.id });
  },
});

/**
 * Weekly Mondays at 4 AM UTC: refit the isotonic calibration mappings
 * from the latest resolved predictions. Mappings shift slowly so a
 * weekly cadence is fine; the operation is also a no-op when fewer
 * than 200 resolved predictions exist, so early-stage clusters don't
 * waste cycles on a meaningless fit.
 */
export const refitIsotonicCalibrationSchedule = schedules.task({
  id: 'scheduled-refit-isotonic-calibration',
  cron: '0 4 * * 1',
  run: async () => {
    logger.info('Scheduled: refit isotonic calibration');
    const handle = await refitIsotonicCalibrationTask.trigger(
      undefined as void,
    );
    logger.info('Triggered isotonic calibration refit task', {
      runId: handle.id,
    });
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

/**
 * Once per day at 5 AM UTC: snapshot Polymarket holders for every open
 * tracked market. Required for walk-forward backtesting of the
 * smart-money signal (the live API only returns CURRENT holders).
 */
export const polymarketHoldersSnapshotSchedule = schedules.task({
  id: 'scheduled-snapshot-polymarket-holders',
  cron: '0 5 * * *',
  run: async () => {
    logger.info('Scheduled: snapshot polymarket holders');
    const handle = await snapshotPolymarketHoldersTask.trigger(
      undefined as void,
    );
    logger.info('Triggered polymarket holder snapshot task', {
      runId: handle.id,
    });
  },
});

/**
 * Every 5 minutes: refresh volume / liquidity / outcomePrices for every
 * active Polymarket market. Powers the per-fixture market-size filter in
 * the UI — the read path only hits Postgres.
 */
export const polymarketMarketSnapshotSchedule = schedules.task({
  id: 'scheduled-polymarket-market-snapshot',
  cron: '*/5 * * * *',
  run: async () => {
    logger.info('Scheduled: polymarket market snapshot');
    const handle = await polymarketMarketSnapshotTask.trigger(
      undefined as void,
    );
    logger.info('Triggered polymarket market snapshot task', {
      runId: handle.id,
    });
  },
});

/**
 * Once per hour: opportunistically backfill CLOB /prices-history for any
 * market that was discovered but has no snapshot history yet. Idempotent
 * — the task's own query filters to markets with zero snapshot rows. So
 * newly-linked markets get a real 24h curve within an hour of landing in
 * polymarket_markets, without a dedicated on-demand trigger.
 */
export const polymarketBackfillHistorySchedule = schedules.task({
  id: 'scheduled-polymarket-backfill-history',
  cron: '0 * * * *',
  run: async () => {
    logger.info('Scheduled: polymarket history backfill');
    const handle = await polymarketBackfillHistoryTask.trigger({
      limit: 200,
    });
    logger.info('Triggered polymarket history backfill task', {
      runId: handle.id,
    });
  },
});

/**
 * Every 2 minutes: high-frequency Gamma snapshot for markets linked to
 * fixtures in the "now - 1h → now + 24h" window. Powers the live
 * probability-over-time chart on pages users are actually viewing.
 * Runs on top of the 5-min broader sweep so long-range markets still
 * get regular coverage without blowing the Gamma API's rate budget.
 */
export const polymarketTodaySnapshotSchedule = schedules.task({
  id: 'scheduled-polymarket-today-snapshot',
  cron: '*/2 * * * *',
  run: async () => {
    logger.info('Scheduled: polymarket today snapshot');
    const handle = await polymarketTodaySnapshotTask.trigger(
      undefined as void,
    );
    logger.info('Triggered polymarket today snapshot task', {
      runId: handle.id,
    });
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

/**
 * Every 5 minutes: trigger the copy-trader sync. The task itself
 * self-throttles via copy_trader_config.sync_interval_minutes — this
 * cron is the ceiling, not the floor. Admins can tune the actual
 * cadence (1-60 min) via PATCH /api/polymarket/copy-traders/config
 * without redeploying.
 */
export const copyTraderSyncSchedule = schedules.task({
  id: 'scheduled-copy-trader-sync',
  cron: '*/5 * * * *',
  run: async () => {
    logger.info('Scheduled: copy-trader sync');
    const handle = await copyTraderSyncTask.trigger(undefined as void);
    logger.info('Triggered copy-trader sync task', { runId: handle.id });
  },
});

// ─── Baseball (MLB run-totals) schedules ─────────────────────────────

/** Every 4 hours: sync MLB games + snapshot sharp market totals. */
export const baseballSyncGamesSchedule = schedules.task({
  id: 'scheduled-baseball-sync-games',
  cron: '0 */4 * * *',
  run: async () => {
    const handle = await baseballSyncGamesTask.trigger(undefined as void);
    logger.info('Triggered baseball sync-games', { runId: handle.id });
  },
});

/** Daily refresh of Statcast pitcher + team-batting caches (08:30 UTC). */
export const baseballStatcastSchedule = schedules.task({
  id: 'scheduled-baseball-statcast',
  cron: '30 8 * * *',
  run: async () => {
    const handle = await baseballRefreshStatcastTask.trigger(undefined as void);
    logger.info('Triggered baseball statcast refresh', { runId: handle.id });
  },
});

/** Daily at 9 AM UTC: generate MLB run-total predictions for the slate. */
export const baseballDailyPredictionsSchedule = schedules.task({
  id: 'scheduled-baseball-daily-predictions',
  cron: '0 9 * * *',
  run: async () => {
    const handle = await baseballGeneratePredictionsTask.trigger(
      undefined as void,
    );
    logger.info('Triggered baseball daily predictions', { runId: handle.id });
  },
});

/** Every 30 min: pre-game refresh for games starting soon (late probables). */
export const baseballPreGameRefreshSchedule = schedules.task({
  id: 'scheduled-baseball-pre-game-refresh',
  cron: '*/30 * * * *',
  run: async () => {
    const handle = await baseballPreGameRefreshTask.trigger(undefined as void);
    logger.info('Triggered baseball pre-game refresh', { runId: handle.id });
  },
});

/** Every hour: sync results + resolve MLB predictions (Brier). */
export const baseballResolveSchedule = schedules.task({
  id: 'scheduled-baseball-resolve',
  cron: '20 * * * *',
  run: async () => {
    const handle = await baseballResolvePredictionsTask.trigger(
      undefined as void,
    );
    logger.info('Triggered baseball resolve', { runId: handle.id });
  },
});

/** Weekly Tuesdays 05:00 UTC: refit MLB calibration + over/under blender. */
export const baseballRefitModelsSchedule = schedules.task({
  id: 'scheduled-baseball-refit-models',
  cron: '0 5 * * 2',
  run: async () => {
    const handle = await baseballRefitModelsTask.trigger(undefined as void);
    logger.info('Triggered baseball model refit', { runId: handle.id });
  },
});
