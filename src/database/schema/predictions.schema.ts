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
import { polymarketMarkets } from './polymarket.schema';
import { fixtures, teams } from './fixtures.schema';

// ─── predictions ───────────────────────────────────────────────────────

export const predictions = pgTable(
  'predictions',
  {
    id: serial('id').primaryKey(),
    polymarketMarketId: varchar('polymarket_market_id', { length: 255 })
      .notNull()
      .references(() => polymarketMarkets.id),
    fixtureId: integer('fixture_id').references(() => fixtures.id),
    polymarketPrice: numeric('polymarket_price', { precision: 8, scale: 4 }).notNull(),
    bookmakerConsensus: numeric('bookmaker_consensus', { precision: 8, scale: 4 }),
    pinnacleProbability: numeric('pinnacle_probability', { precision: 8, scale: 4 }),
    statisticalModelProb: numeric('statistical_model_prob', { precision: 8, scale: 4 }),
    apiFootballPrediction: numeric('api_football_prediction', { precision: 8, scale: 4 }),
    predictedProbability: numeric('predicted_probability', { precision: 8, scale: 4 }).notNull(),
    mispricingGap: numeric('mispricing_gap', { precision: 8, scale: 4 }),
    mispricingPct: numeric('mispricing_pct', { precision: 8, scale: 4 }),
    confidenceScore: integer('confidence_score'),
    recommendation: varchar('recommendation', { length: 20 }),
    reasoning: text('reasoning'),
    signals: jsonb('signals'),
    isLive: boolean('is_live').default(false),
    status: varchar('status', { length: 20 }).default('active'),
    resolvedOutcome: varchar('resolved_outcome', { length: 10 }),
    wasCorrect: boolean('was_correct'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_predictions_market').on(table.polymarketMarketId),
    index('idx_predictions_confidence').on(table.confidenceScore),
    index('idx_predictions_recommendation').on(table.recommendation),
    index('idx_predictions_status').on(table.status),
    index('idx_predictions_created').on(table.createdAt),
  ],
);

// ─── alerts ────────────────────────────────────────────────────────────

export const alerts = pgTable(
  'alerts',
  {
    id: serial('id').primaryKey(),
    predictionId: integer('prediction_id')
      .notNull()
      .references(() => predictions.id),
    type: varchar('type', { length: 50 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    message: text('message').notNull(),
    data: jsonb('data'),
    acknowledged: boolean('acknowledged').default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_alerts_prediction').on(table.predictionId),
    index('idx_alerts_type').on(table.type),
    index('idx_alerts_severity').on(table.severity),
    index('idx_alerts_created').on(table.createdAt),
    index('idx_alerts_unacknowledged').on(table.acknowledged),
  ],
);

// ─── market_fixture_links ──────────────────────────────────────────────

export const marketFixtureLinks = pgTable(
  'market_fixture_links',
  {
    id: serial('id').primaryKey(),
    polymarketMarketId: varchar('polymarket_market_id', { length: 255 })
      .notNull()
      .references(() => polymarketMarkets.id),
    fixtureId: integer('fixture_id').references(() => fixtures.id),
    oddsApiEventId: varchar('odds_api_event_id', { length: 255 }),
    leagueId: integer('league_id'),
    teamId: integer('team_id').references(() => teams.id),
    matchType: varchar('match_type', { length: 50 }).notNull(),
    matchConfidence: numeric('match_confidence', { precision: 5, scale: 2 }),
    matchMethod: varchar('match_method', { length: 50 }),
    mappedOutcome: varchar('mapped_outcome', { length: 100 }),
    verified: boolean('verified').default(false),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_links_polymarket').on(table.polymarketMarketId),
    index('idx_links_fixture').on(table.fixtureId),
    index('idx_links_type').on(table.matchType),
    uniqueIndex('uq_links_market_fixture').on(table.polymarketMarketId, table.fixtureId),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const predictionsRelations = relations(predictions, ({ one, many }) => ({
  polymarketMarket: one(polymarketMarkets, {
    fields: [predictions.polymarketMarketId],
    references: [polymarketMarkets.id],
  }),
  fixture: one(fixtures, {
    fields: [predictions.fixtureId],
    references: [fixtures.id],
  }),
  alerts: many(alerts),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  prediction: one(predictions, {
    fields: [alerts.predictionId],
    references: [predictions.id],
  }),
}));

export const marketFixtureLinksRelations = relations(marketFixtureLinks, ({ one }) => ({
  polymarketMarket: one(polymarketMarkets, {
    fields: [marketFixtureLinks.polymarketMarketId],
    references: [polymarketMarkets.id],
  }),
  fixture: one(fixtures, {
    fields: [marketFixtureLinks.fixtureId],
    references: [fixtures.id],
  }),
  team: one(teams, {
    fields: [marketFixtureLinks.teamId],
    references: [teams.id],
  }),
}));
