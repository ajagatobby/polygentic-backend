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
import { predictions } from './predictions.schema';

// ─── polymarket_markets ────────────────────────────────────────────────
// Cached Polymarket events/markets discovered via Gamma API

export const polymarketMarkets = pgTable(
  'polymarket_markets',
  {
    id: serial('id').primaryKey(),

    // Polymarket identifiers
    eventId: varchar('event_id', { length: 255 }).notNull(), // Gamma event ID
    marketId: varchar('market_id', { length: 255 }).notNull(), // Gamma market ID
    conditionId: varchar('condition_id', { length: 255 }), // CTF condition ID
    slug: varchar('slug', { length: 500 }),

    // Market metadata
    eventTitle: text('event_title').notNull(),
    marketQuestion: text('market_question').notNull(),
    outcomes: jsonb('outcomes').$type<string[]>().notNull(), // e.g. ["Yes", "No"] or ["Arsenal", "Draw", "Man Utd"]
    clobTokenIds: jsonb('clob_token_ids').$type<string[]>().notNull(), // Token IDs for each outcome

    // Classification
    marketType: varchar('market_type', { length: 50 }).notNull(), // 'match_outcome' | 'league_winner' | 'tournament_winner' | 'qualification' | 'top_4' | 'player_prop' | 'other'
    tags: jsonb('tags').$type<
      Array<{ id: string; slug: string; label: string }>
    >(),

    // Pricing (snapshot from last sync)
    outcomePrices: jsonb('outcome_prices').$type<string[]>(), // e.g. ["0.52", "0.48"]
    midpoints: jsonb('midpoints').$type<string[]>(), // CLOB midpoint prices
    spreads: jsonb('spreads').$type<string[]>(), // Bid-ask spreads

    // Liquidity & volume
    liquidity: numeric('liquidity', { precision: 14, scale: 2 }),
    volume: numeric('volume', { precision: 14, scale: 2 }),
    volume24hr: numeric('volume_24hr', { precision: 14, scale: 2 }),

    // State
    active: boolean('active').default(true),
    closed: boolean('closed').default(false),
    acceptingOrders: boolean('accepting_orders').default(true),

    // Dates
    startDate: timestamp('start_date'),
    endDate: timestamp('end_date'),

    // ── Linking to internal data ──────────────────────────────────

    // For match_outcome markets: links to a specific fixture
    fixtureId: integer('fixture_id').references(() => fixtures.id),

    // For outright markets (league_winner, tournament_winner, qualification, top_4)
    leagueId: integer('league_id'), // API-Football league ID (no FK — no leagues table)
    leagueName: varchar('league_name', { length: 255 }), // Denormalized league name
    teamId: integer('team_id').references(() => teams.id), // The team this market is about
    teamName: varchar('team_name', { length: 255 }), // Denormalized team name
    season: integer('season'), // Season year (e.g. 2025 for 2025-26)

    matchScore: numeric('match_score', { precision: 5, scale: 4 }), // Fuzzy match confidence 0-1

    lastSyncedAt: timestamp('last_synced_at').defaultNow(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_polymarket_markets_market_id').on(table.marketId),
    index('idx_polymarket_markets_event').on(table.eventId),
    index('idx_polymarket_markets_fixture').on(table.fixtureId),
    index('idx_polymarket_markets_league').on(table.leagueId, table.season),
    index('idx_polymarket_markets_team').on(table.teamId),
    index('idx_polymarket_markets_type').on(table.marketType),
    index('idx_polymarket_markets_active').on(table.active, table.closed),
    index('idx_polymarket_markets_synced').on(table.lastSyncedAt),
  ],
);

// ─── polymarket_trades ─────────────────────────────────────────────────
// Both paper trades and real trades — distinguished by `mode` column

export const polymarketTrades = pgTable(
  'polymarket_trades',
  {
    id: serial('id').primaryKey(),

    // Link to the market and prediction that triggered this trade
    polymarketMarketId: integer('polymarket_market_id')
      .notNull()
      .references(() => polymarketMarkets.id),
    predictionId: integer('prediction_id').references(() => predictions.id),
    fixtureId: integer('fixture_id').references(() => fixtures.id), // For match_outcome trades

    // For outright trades (league_winner, tournament_winner, etc.)
    leagueId: integer('league_id'), // API-Football league ID
    teamId: integer('team_id').references(() => teams.id),

    // Trade details
    mode: varchar('mode', { length: 20 }).notNull(), // 'paper' | 'live'
    side: varchar('side', { length: 10 }).notNull(), // 'buy' | 'sell'
    outcomeIndex: integer('outcome_index').notNull(), // 0 or 1 (which outcome token)
    outcomeName: varchar('outcome_name', { length: 255 }).notNull(), // e.g. "Yes", "Arsenal"

    // Pricing at decision time
    entryPrice: numeric('entry_price', { precision: 10, scale: 6 }).notNull(), // Price per token (0-1)
    midpointAtEntry: numeric('midpoint_at_entry', { precision: 10, scale: 6 }), // CLOB midpoint when decision was made
    spreadAtEntry: numeric('spread_at_entry', { precision: 10, scale: 6 }), // Bid-ask spread at entry

    // Position sizing
    positionSizeUsd: numeric('position_size_usd', {
      precision: 14,
      scale: 2,
    }).notNull(), // How much USDC to spend
    tokenQuantity: numeric('token_quantity', { precision: 14, scale: 6 }), // positionSizeUsd / entryPrice

    // Edge & reasoning
    ensembleProbability: numeric('ensemble_probability', {
      precision: 5,
      scale: 4,
    }).notNull(), // Our model's probability
    polymarketProbability: numeric('polymarket_probability', {
      precision: 5,
      scale: 4,
    }).notNull(), // Polymarket's implied probability
    edgePercent: numeric('edge_percent', { precision: 8, scale: 4 }).notNull(), // (ensemble - polymarket) * 100
    kellyFraction: numeric('kelly_fraction', { precision: 8, scale: 6 }), // Calculated Kelly fraction
    confidenceAtEntry: integer('confidence_at_entry'), // Prediction confidence 1-10

    // Agent reasoning (Claude's analysis)
    agentReasoning: text('agent_reasoning'), // Full Claude reasoning for this trade
    riskAssessment: text('risk_assessment'), // Risk factors identified by agent

    // Bankroll state at entry
    bankrollAtEntry: numeric('bankroll_at_entry', { precision: 14, scale: 2 }),
    openPositionsCount: integer('open_positions_count'),

    // Order execution (for live trades)
    orderId: varchar('order_id', { length: 255 }), // Polymarket CLOB order ID
    orderStatus: varchar('order_status', { length: 50 }), // 'pending' | 'filled' | 'partial' | 'cancelled'
    fillPrice: numeric('fill_price', { precision: 10, scale: 6 }), // Actual fill price
    fillTimestamp: timestamp('fill_timestamp'),

    // Resolution
    exitPrice: numeric('exit_price', { precision: 10, scale: 6 }), // Price at resolution ($1 or $0 for binary)
    pnlUsd: numeric('pnl_usd', { precision: 14, scale: 2 }), // Profit/loss in USDC
    pnlPercent: numeric('pnl_percent', { precision: 8, scale: 4 }), // Return on this position
    resolvedAt: timestamp('resolved_at'),
    resolutionOutcome: varchar('resolution_outcome', { length: 50 }), // 'win' | 'loss' | 'cancelled'

    // Status
    status: varchar('status', { length: 20 }).notNull().default('open'), // 'open' | 'filled' | 'resolved' | 'cancelled'

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_polymarket_trades_market').on(table.polymarketMarketId),
    index('idx_polymarket_trades_prediction').on(table.predictionId),
    index('idx_polymarket_trades_fixture').on(table.fixtureId),
    index('idx_polymarket_trades_mode').on(table.mode),
    index('idx_polymarket_trades_status').on(table.status),
    index('idx_polymarket_trades_created').on(table.createdAt),
    index('idx_polymarket_trades_resolved').on(table.resolvedAt),
  ],
);

// ─── polymarket_bankroll ───────────────────────────────────────────────
// Tracks bankroll state over time for P&L and drawdown monitoring

export const polymarketBankroll = pgTable(
  'polymarket_bankroll',
  {
    id: serial('id').primaryKey(),

    // Snapshot state
    mode: varchar('mode', { length: 20 }).notNull(), // 'paper' | 'live'
    initialBudget: numeric('initial_budget', {
      precision: 14,
      scale: 2,
    }).notNull(),
    currentBalance: numeric('current_balance', {
      precision: 14,
      scale: 2,
    }).notNull(),
    totalDeposited: numeric('total_deposited', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    totalWithdrawn: numeric('total_withdrawn', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),

    // P&L
    realizedPnl: numeric('realized_pnl', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    unrealizedPnl: numeric('unrealized_pnl', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),

    // Performance metrics
    totalTrades: integer('total_trades').notNull().default(0),
    winningTrades: integer('winning_trades').notNull().default(0),
    losingTrades: integer('losing_trades').notNull().default(0),
    winRate: numeric('win_rate', { precision: 5, scale: 4 }), // winningTrades / totalTrades
    avgEdge: numeric('avg_edge', { precision: 8, scale: 4 }), // Average edge on trades taken
    maxDrawdownPct: numeric('max_drawdown_pct', { precision: 8, scale: 4 }), // Worst peak-to-trough

    // Risk state
    peakBalance: numeric('peak_balance', { precision: 14, scale: 2 }),
    currentDrawdownPct: numeric('current_drawdown_pct', {
      precision: 8,
      scale: 4,
    }),
    isStopped: boolean('is_stopped').default(false), // True if stop-loss triggered
    stoppedReason: text('stopped_reason'),

    // Open positions
    openPositionsCount: integer('open_positions_count').notNull().default(0),
    openPositionsValue: numeric('open_positions_value', {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default('0'),

    snapshotAt: timestamp('snapshot_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_polymarket_bankroll_mode').on(table.mode),
    index('idx_polymarket_bankroll_snapshot').on(table.snapshotAt),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const polymarketMarketsRelations = relations(
  polymarketMarkets,
  ({ one, many }) => ({
    fixture: one(fixtures, {
      fields: [polymarketMarkets.fixtureId],
      references: [fixtures.id],
    }),
    team: one(teams, {
      fields: [polymarketMarkets.teamId],
      references: [teams.id],
    }),
    trades: many(polymarketTrades),
  }),
);

export const polymarketTradesRelations = relations(
  polymarketTrades,
  ({ one }) => ({
    market: one(polymarketMarkets, {
      fields: [polymarketTrades.polymarketMarketId],
      references: [polymarketMarkets.id],
    }),
    prediction: one(predictions, {
      fields: [polymarketTrades.predictionId],
      references: [predictions.id],
    }),
    fixture: one(fixtures, {
      fields: [polymarketTrades.fixtureId],
      references: [fixtures.id],
    }),
    team: one(teams, {
      fields: [polymarketTrades.teamId],
      references: [teams.id],
    }),
  }),
);
