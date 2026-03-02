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
    detailedAnalysis: text('detailed_analysis'), // full reasoning text

    // Model versioning
    modelVersion: varchar('model_version', { length: 50 }),

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
    uniqueIndex('uq_predictions_fixture_type').on(
      table.fixtureId,
      table.predictionType,
    ),
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
