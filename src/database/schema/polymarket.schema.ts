import {
  pgTable,
  varchar,
  text,
  boolean,
  numeric,
  timestamp,
  jsonb,
  serial,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── polymarket_events ─────────────────────────────────────────────────

export const polymarketEvents = pgTable(
  'polymarket_events',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    slug: varchar('slug', { length: 500 }).notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    startDate: timestamp('start_date'),
    endDate: timestamp('end_date'),
    active: boolean('active').default(true),
    closed: boolean('closed').default(false),
    liquidity: numeric('liquidity', { precision: 18, scale: 2 }),
    volume: numeric('volume', { precision: 18, scale: 2 }),
    volume24hr: numeric('volume_24hr', { precision: 18, scale: 2 }),
    tags: jsonb('tags'),
    rawData: jsonb('raw_data'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_polymarket_events_slug').on(table.slug),
    index('idx_polymarket_events_active').on(table.active, table.closed),
  ],
);

// ─── polymarket_markets ────────────────────────────────────────────────

export const polymarketMarkets = pgTable(
  'polymarket_markets',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    eventId: varchar('event_id', { length: 255 })
      .notNull()
      .references(() => polymarketEvents.id),
    question: text('question').notNull(),
    slug: varchar('slug', { length: 500 }),
    conditionId: varchar('condition_id', { length: 255 }).unique(),
    questionId: varchar('question_id', { length: 255 }),
    outcomes: jsonb('outcomes').notNull(),
    outcomePrices: jsonb('outcome_prices').notNull(),
    clobTokenIds: jsonb('clob_token_ids').notNull(),
    volume: numeric('volume', { precision: 18, scale: 2 }),
    volume24hr: numeric('volume_24hr', { precision: 18, scale: 2 }),
    liquidity: numeric('liquidity', { precision: 18, scale: 2 }),
    spread: numeric('spread', { precision: 8, scale: 4 }),
    active: boolean('active').default(true),
    closed: boolean('closed').default(false),
    marketType: varchar('market_type', { length: 50 }),
    rawData: jsonb('raw_data'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_polymarket_markets_event_id').on(table.eventId),
    index('idx_polymarket_markets_condition_id').on(table.conditionId),
    index('idx_polymarket_markets_active').on(table.active, table.closed),
    index('idx_polymarket_markets_type').on(table.marketType),
  ],
);

// ─── polymarket_price_history ──────────────────────────────────────────

export const polymarketPriceHistory = pgTable(
  'polymarket_price_history',
  {
    id: serial('id').primaryKey(),
    marketId: varchar('market_id', { length: 255 })
      .notNull()
      .references(() => polymarketMarkets.id),
    yesPrice: numeric('yes_price', { precision: 8, scale: 4 }).notNull(),
    noPrice: numeric('no_price', { precision: 8, scale: 4 }).notNull(),
    midpoint: numeric('midpoint', { precision: 8, scale: 4 }),
    spread: numeric('spread', { precision: 8, scale: 4 }),
    volume24hr: numeric('volume_24hr', { precision: 18, scale: 2 }),
    liquidity: numeric('liquidity', { precision: 18, scale: 2 }),
    recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_price_history_market_time').on(table.marketId, table.recordedAt),
    index('idx_price_history_recorded_at').on(table.recordedAt),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const polymarketEventsRelations = relations(
  polymarketEvents,
  ({ many }) => ({
    markets: many(polymarketMarkets),
  }),
);

export const polymarketMarketsRelations = relations(
  polymarketMarkets,
  ({ one, many }) => ({
    event: one(polymarketEvents, {
      fields: [polymarketMarkets.eventId],
      references: [polymarketEvents.id],
    }),
    priceHistory: many(polymarketPriceHistory),
  }),
);

export const polymarketPriceHistoryRelations = relations(
  polymarketPriceHistory,
  ({ one }) => ({
    market: one(polymarketMarkets, {
      fields: [polymarketPriceHistory.marketId],
      references: [polymarketMarkets.id],
    }),
  }),
);
