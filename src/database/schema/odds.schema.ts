import {
  pgTable,
  varchar,
  numeric,
  timestamp,
  jsonb,
  serial,
  integer,
  index,
} from 'drizzle-orm/pg-core';

// ─── bookmaker_odds ────────────────────────────────────────────────────

export const bookmakerOdds = pgTable(
  'bookmaker_odds',
  {
    id: serial('id').primaryKey(),
    oddsApiEventId: varchar('odds_api_event_id', { length: 255 }).notNull(),
    sportKey: varchar('sport_key', { length: 100 }).notNull(),
    homeTeam: varchar('home_team', { length: 255 }).notNull(),
    awayTeam: varchar('away_team', { length: 255 }).notNull(),
    commenceTime: timestamp('commence_time').notNull(),
    bookmakerKey: varchar('bookmaker_key', { length: 100 }).notNull(),
    bookmakerName: varchar('bookmaker_name', { length: 255 }),
    marketKey: varchar('market_key', { length: 100 }).notNull(),
    outcomes: jsonb('outcomes').notNull(),
    impliedProbabilities: jsonb('implied_probabilities'),
    trueProbabilities: jsonb('true_probabilities'),
    overround: numeric('overround', { precision: 8, scale: 4 }),
    lastUpdate: timestamp('last_update'),
    recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_bookmaker_odds_event').on(table.oddsApiEventId),
    index('idx_bookmaker_odds_sport').on(table.sportKey, table.commenceTime),
    index('idx_bookmaker_odds_bookmaker').on(table.bookmakerKey),
    index('idx_bookmaker_odds_recorded').on(table.recordedAt),
  ],
);

// ─── consensus_odds ────────────────────────────────────────────────────

export const consensusOdds = pgTable(
  'consensus_odds',
  {
    id: serial('id').primaryKey(),
    oddsApiEventId: varchar('odds_api_event_id', { length: 255 }).notNull(),
    sportKey: varchar('sport_key', { length: 100 }).notNull(),
    homeTeam: varchar('home_team', { length: 255 }).notNull(),
    awayTeam: varchar('away_team', { length: 255 }).notNull(),
    commenceTime: timestamp('commence_time').notNull(),
    marketKey: varchar('market_key', { length: 100 }).notNull(),
    consensusHomeWin: numeric('consensus_home_win', { precision: 8, scale: 4 }),
    consensusDraw: numeric('consensus_draw', { precision: 8, scale: 4 }),
    consensusAwayWin: numeric('consensus_away_win', { precision: 8, scale: 4 }),
    consensusOver: numeric('consensus_over', { precision: 8, scale: 4 }),
    consensusUnder: numeric('consensus_under', { precision: 8, scale: 4 }),
    consensusPoint: numeric('consensus_point', { precision: 5, scale: 2 }),
    pinnacleHomeWin: numeric('pinnacle_home_win', { precision: 8, scale: 4 }),
    pinnacleDraw: numeric('pinnacle_draw', { precision: 8, scale: 4 }),
    pinnacleAwayWin: numeric('pinnacle_away_win', { precision: 8, scale: 4 }),
    numBookmakers: integer('num_bookmakers'),
    calculatedAt: timestamp('calculated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_consensus_event_market').on(
      table.oddsApiEventId,
      table.marketKey,
    ),
    index('idx_consensus_time').on(table.calculatedAt),
  ],
);
