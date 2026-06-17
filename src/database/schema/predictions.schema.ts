import {
  pgTable,
  varchar,
  text,
  boolean,
  numeric,
  timestamp,
  jsonb,
  serial,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { fixtures, teams } from './fixtures.schema';

// ─── predictions ───────────────────────────────────────────────────────

export const predictions = pgTable(
  'predictions',
  {
    id: serial('id').primaryKey(),
    fixtureId: integer('fixture_id')
      .notNull()
      .references(() => fixtures.id),
    homeTeamId: integer('home_team_id').references(() => teams.id),
    awayTeamId: integer('away_team_id').references(() => teams.id),

    // Probabilities (sum to 1)
    homeWinProb: numeric('home_win_prob', { precision: 5, scale: 4 }).notNull(),
    drawProb: numeric('draw_prob', { precision: 5, scale: 4 }).notNull(),
    awayWinProb: numeric('away_win_prob', { precision: 5, scale: 4 }).notNull(),

    // Predicted scoreline
    predictedHomeGoals: numeric('predicted_home_goals', {
      precision: 3,
      scale: 1,
    }),
    predictedAwayGoals: numeric('predicted_away_goals', {
      precision: 3,
      scale: 1,
    }),

    // Confidence and type
    confidence: integer('confidence'), // 1-10
    predictionType: varchar('prediction_type', { length: 20 }).notNull(), // 'daily' | 'pre_match' | 'on_demand'

    // Analysis outputs
    keyFactors: jsonb('key_factors'), // top reasons for prediction
    riskFactors: jsonb('risk_factors'), // what could go wrong
    valueBets: jsonb('value_bets'), // odds comparison
    matchContext: jsonb('match_context'), // raw data used by agents
    researchContext: jsonb('research_context'), // raw research results
    /**
     * Display-only deep-analysis sections surfaced in the response:
     * head-to-head history + summary + streak, last-20 recent form per team
     * with scorelines, team streaks, and the full player-by-player roster
     * breakdown. Computed by MatchInsightsService. Does NOT influence the
     * probability model.
     */
    matchInsights: jsonb('match_insights'),
    detailedAnalysis: text('detailed_analysis'), // full reasoning text
    /**
     * Smart-money signal computed at prediction time from Polymarket
     * /holders + /positions data. Null when no Polymarket market exists
     * for this fixture or the signal has insufficient sharp coverage.
     */
    smartMoneySignal: jsonb('smart_money_signal'),

    // Predicted outcome (stored at prediction time — never re-derived)
    predictedResult: varchar('predicted_result', { length: 20 }), // 'home_win' | 'draw' | 'away_win'

    // Model versioning
    modelVersion: varchar('model_version', { length: 50 }),

    // Prediction lifecycle status
    //   'pending'  — match not yet played
    //   'resolved' — match finished and accuracy computed
    //   'void'     — match postponed/cancelled/abandoned
    predictionStatus: varchar('prediction_status', { length: 20 })
      .default('pending')
      .notNull(),

    // Accuracy tracking
    actualHomeGoals: integer('actual_home_goals'),
    actualAwayGoals: integer('actual_away_goals'),
    actualResult: varchar('actual_result', { length: 20 }), // 'home_win' | 'draw' | 'away_win'
    wasCorrect: boolean('was_correct'),
    probabilityAccuracy: numeric('probability_accuracy', {
      precision: 8,
      scale: 6,
    }), // Brier score
    resolvedAt: timestamp('resolved_at'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_predictions_fixture').on(table.fixtureId),
    index('idx_predictions_type').on(table.predictionType),
    index('idx_predictions_confidence').on(table.confidence),
    index('idx_predictions_created').on(table.createdAt),
    index('idx_predictions_resolved').on(table.resolvedAt),
    index('idx_predictions_status').on(table.predictionStatus),
    // One prediction per fixture. A newer run (regardless of type) replaces
    // the existing row in place via onConflictDoUpdate on fixtureId, so FK
    // references (alerts, polymarket_trades, ab_test) stay valid.
    uniqueIndex('uq_predictions_fixture').on(table.fixtureId),
  ],
);

// ─── alerts ────────────────────────────────────────────────────────────

export const alerts = pgTable(
  'alerts',
  {
    id: serial('id').primaryKey(),
    predictionId: integer('prediction_id').references(() => predictions.id),
    fixtureId: integer('fixture_id').references(() => fixtures.id),
    type: varchar('type', { length: 50 }).notNull(), // 'high_confidence' | 'value_bet' | 'live_event' | 'lineup_change'
    severity: varchar('severity', { length: 20 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    message: text('message').notNull(),
    data: jsonb('data'),
    acknowledged: boolean('acknowledged').default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_alerts_prediction').on(table.predictionId),
    index('idx_alerts_fixture').on(table.fixtureId),
    index('idx_alerts_type').on(table.type),
    index('idx_alerts_severity').on(table.severity),
    index('idx_alerts_created').on(table.createdAt),
    index('idx_alerts_unacknowledged').on(table.acknowledged),
  ],
);

// ─── prediction_calibration ──────────────────────────────────────────
//
// Fitted isotonic calibration mapping per (scope, outcome). Scope is
// either a specific league_id or -1 (sentinel) for the global fallback.
// Each row stores the full piecewise-constant mapping as a JSONB array:
//
//   breakpoints: [{ xMin: number, xMax: number, y: number }, ...]
//
// where each block represents an interval [xMin, xMax) of raw predicted
// probability mapped to a calibrated probability `y` (the empirical
// frequency of the outcome among predictions whose raw probability fell
// in that block).
//
// Fitter: IsotonicCalibrationService — runs the pool-adjacent violators
// algorithm separately per outcome.
//
// Read path: at prediction time, agents.service looks up the row whose
// (league_id, outcome) matches; if none exists for the league, it falls
// back to the global scope row (league_id = -1). When neither exists,
// the original ensemble probabilities pass through unchanged (no-op).

export const predictionCalibration = pgTable(
  'prediction_calibration',
  {
    id: serial('id').primaryKey(),
    /** -1 = global fallback, otherwise the specific fixture.leagueId. */
    leagueId: integer('league_id').notNull().default(-1),
    /** 'home_win' | 'draw' | 'away_win' */
    outcome: varchar('outcome', { length: 20 }).notNull(),
    /** Piecewise-constant isotonic mapping. */
    breakpoints: jsonb('breakpoints').notNull(),
    /** Number of resolved predictions used to fit this mapping. */
    sampleSize: integer('sample_size').notNull(),
    /** When the fit was last refreshed. */
    fittedAt: timestamp('fitted_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_pred_calib_league').on(table.leagueId),
    uniqueIndex('uq_pred_calib_scope').on(table.leagueId, table.outcome),
  ],
);

// ─── dirichlet_calibration ───────────────────────────────────────────
//
// Native-multiclass calibration via Dirichlet calibration (Kull et al.,
// NeurIPS 2019). Replaces the per-outcome isotonic mapping above. One
// row per scope stores the 3×3 linear-layer weights W and 3-vector bias
// b of:
//
//   z = W · ln(p) + b   (p = raw model probabilities)
//   q = softmax(z)      (q = calibrated probabilities)
//
// Outcome order in both `weights` (rows + cols) and `bias` is
// [home_win, draw, away_win].
//
// Apply path prefers Dirichlet over the legacy isotonic mapping. If no
// Dirichlet row is fitted for a league, we fall back to the global
// Dirichlet row (league_id = -1); if neither is fitted, the apply layer
// passes through unchanged.

export const dirichletCalibration = pgTable(
  'dirichlet_calibration',
  {
    id: serial('id').primaryKey(),
    /** -1 = global fallback, otherwise the specific fixture.leagueId. */
    leagueId: integer('league_id').notNull().default(-1),
    /** 3×3 weight matrix, JSON array of arrays. */
    weights: jsonb('weights').notNull(),
    /** 3-vector bias, JSON array. */
    bias: jsonb('bias').notNull(),
    /** Number of resolved predictions used to fit this mapping. */
    sampleSize: integer('sample_size').notNull(),
    /** Final NLL achieved (diagnostic). */
    finalLoss: numeric('final_loss', { precision: 10, scale: 6 }),
    /** When the fit was last refreshed. */
    fittedAt: timestamp('fitted_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_dirichlet_calib_league').on(table.leagueId),
  ],
);

// ─── team_pi_ratings ─────────────────────────────────────────────────
//
// Constantinou-Fenton pi-ratings (2013). Each team has a separate
// "home" and "away" rating, updated after each match by the iterative
// rule
//
//   error = actual_goal_diff − predicted_goal_diff
//   home team home rating += λ · ψ(error)
//   home team away rating += λ · γ · ψ(error)
//   away team away rating −= λ · ψ(error)
//   away team home rating −= λ · γ · ψ(error)
//
// where λ = 0.054, γ = 0.7, ψ(e) = 3·log10(1+|e|)·sign(e). The home/
// away decomposition captures the empirical fact that teams' home and
// away performance can diverge substantially.

export const teamPiRatings = pgTable(
  'team_pi_ratings',
  {
    id: serial('id').primaryKey(),
    teamId: integer('team_id').notNull().unique(),
    homeRating: numeric('home_rating', { precision: 10, scale: 4 })
      .default('0')
      .notNull(),
    awayRating: numeric('away_rating', { precision: 10, scale: 4 })
      .default('0')
      .notNull(),
    matchesUsed: integer('matches_used').default(0).notNull(),
    lastMatchDate: timestamp('last_match_date'),
    lastUpdated: timestamp('last_updated').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_team_pi_ratings_updated').on(table.lastUpdated),
  ],
);

// ─── pi_rating_mapping ───────────────────────────────────────────────
//
// Fitted ordered-logit mapping from predicted goal difference ĝ to the
// 1X2 probability triple. Three parameters:
//
//   P(away | ĝ) = σ(τ_AD − β·ĝ)
//   P(draw | ĝ) = σ(τ_DH − β·ĝ) − σ(τ_AD − β·ĝ)
//   P(home | ĝ) = 1 − σ(τ_DH − β·ĝ)
//
// with τ_AD < τ_DH (ordered constraint), β > 0 (more goal-diff →
// more likely home win).

export const piRatingMapping = pgTable(
  'pi_rating_mapping',
  {
    id: serial('id').primaryKey(),
    /** -1 = global fallback, otherwise the specific fixture.leagueId. */
    leagueId: integer('league_id').notNull().default(-1),
    /** Slope on standardised ĝ. */
    beta: numeric('beta', { precision: 10, scale: 6 }).notNull(),
    /** Threshold between away and draw. */
    tauAd: numeric('tau_ad', { precision: 10, scale: 6 }).notNull(),
    /** Threshold between draw and home. */
    tauDh: numeric('tau_dh', { precision: 10, scale: 6 }).notNull(),
    sampleSize: integer('sample_size').notNull(),
    finalLoss: numeric('final_loss', { precision: 10, scale: 6 }),
    fittedAt: timestamp('fitted_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_pi_rating_mapping_league').on(table.leagueId),
  ],
);

// ─── meta_blender_params ─────────────────────────────────────────────
//
// Learned log-pool weights blending the four base predictors (Claude /
// Poisson / Pinnacle close / Pi-rating). Replaces the flat 30/30/40
// blend in agents.service.ensemblePredictions when a fitted row exists.
//
// Model:
//   z_k = Σ_i w_i · ln(p_i^k) + b_k
//   q_k = softmax(z_k)
//
// where i indexes predictors and k indexes outcomes. weights[] is
// length 4 in the order given by predictor_order; bias[] is length 3
// for [home, draw, away].

export const metaBlenderParams = pgTable(
  'meta_blender_params',
  {
    id: serial('id').primaryKey(),
    /** -1 = global fallback. */
    leagueId: integer('league_id').notNull().default(-1),
    /** Predictor weights in slot order. */
    weights: jsonb('weights').notNull(),
    /** Outcome biases [b_H, b_D, b_A]. */
    bias: jsonb('bias').notNull(),
    /** Names of predictors in slot order; lets us add new predictors
     *  without breaking deserialisation of legacy rows. */
    predictorOrder: jsonb('predictor_order').notNull(),
    sampleSize: integer('sample_size').notNull(),
    finalLoss: numeric('final_loss', { precision: 10, scale: 6 }),
    fittedAt: timestamp('fitted_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_meta_blender_league').on(table.leagueId),
  ],
);

// ─── prediction_tests ────────────────────────────────────────────────

export const predictionTests = pgTable(
  'prediction_tests',
  {
    id: serial('id').primaryKey(),
    fixtureId: integer('fixture_id')
      .notNull()
      .references(() => fixtures.id),
    predictionType: varchar('prediction_type', { length: 20 }).notNull(),

    baselinePredictionId: integer('baseline_prediction_id').references(
      () => predictions.id,
    ),
    retestPredictionId: integer('retest_prediction_id').references(
      () => predictions.id,
    ),

    actualResult: varchar('actual_result', { length: 20 }).notNull(),

    baselinePredictedResult: varchar('baseline_predicted_result', {
      length: 20,
    }),
    baselineWasCorrect: boolean('baseline_was_correct'),
    baselineHomeWinProb: numeric('baseline_home_win_prob', {
      precision: 5,
      scale: 4,
    }),
    baselineDrawProb: numeric('baseline_draw_prob', {
      precision: 5,
      scale: 4,
    }),
    baselineAwayWinProb: numeric('baseline_away_win_prob', {
      precision: 5,
      scale: 4,
    }),
    baselineBrier: numeric('baseline_brier', {
      precision: 8,
      scale: 6,
    }),

    retestPredictedResult: varchar('retest_predicted_result', { length: 20 }),
    retestWasCorrect: boolean('retest_was_correct'),
    retestHomeWinProb: numeric('retest_home_win_prob', {
      precision: 5,
      scale: 4,
    }),
    retestDrawProb: numeric('retest_draw_prob', { precision: 5, scale: 4 }),
    retestAwayWinProb: numeric('retest_away_win_prob', {
      precision: 5,
      scale: 4,
    }),
    retestBrier: numeric('retest_brier', { precision: 8, scale: 6 }),

    improved: boolean('improved'),
    runStatus: varchar('run_status', { length: 20 }).default('completed'),
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_prediction_tests_fixture').on(table.fixtureId),
    index('idx_prediction_tests_type').on(table.predictionType),
    index('idx_prediction_tests_created').on(table.createdAt),
    index('idx_prediction_tests_status').on(table.runStatus),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const predictionsRelations = relations(predictions, ({ one, many }) => ({
  fixture: one(fixtures, {
    fields: [predictions.fixtureId],
    references: [fixtures.id],
  }),
  homeTeam: one(teams, {
    fields: [predictions.homeTeamId],
    references: [teams.id],
    relationName: 'predictionHomeTeam',
  }),
  awayTeam: one(teams, {
    fields: [predictions.awayTeamId],
    references: [teams.id],
    relationName: 'predictionAwayTeam',
  }),
  alerts: many(alerts),
  baselineTests: many(predictionTests, { relationName: 'baselinePrediction' }),
  retestTests: many(predictionTests, { relationName: 'retestPrediction' }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  prediction: one(predictions, {
    fields: [alerts.predictionId],
    references: [predictions.id],
  }),
  fixture: one(fixtures, {
    fields: [alerts.fixtureId],
    references: [fixtures.id],
  }),
}));

export const predictionTestsRelations = relations(
  predictionTests,
  ({ one }) => ({
    fixture: one(fixtures, {
      fields: [predictionTests.fixtureId],
      references: [fixtures.id],
    }),
    baselinePrediction: one(predictions, {
      fields: [predictionTests.baselinePredictionId],
      references: [predictions.id],
      relationName: 'baselinePrediction',
    }),
    retestPrediction: one(predictions, {
      fields: [predictionTests.retestPredictionId],
      references: [predictions.id],
      relationName: 'retestPrediction',
    }),
  }),
);
