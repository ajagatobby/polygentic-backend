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
    slug: varchar('slug', { length: 500 }), // Market-level slug
    eventSlug: varchar('event_slug', { length: 500 }), // Event-level slug (used for Polymarket URLs)

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

// ─── polymarket_config ─────────────────────────────────────────────────
// Runtime-configurable trading parameters. DB values override env defaults.
// Only one row per mode (paper / live).

export const polymarketConfig = pgTable(
  'polymarket_config',
  {
    id: serial('id').primaryKey(),

    mode: varchar('mode', { length: 20 }).notNull(), // 'paper' | 'live'

    // Trading gates
    liveTradingEnabled: boolean('live_trading_enabled').default(false),
    minEdge: numeric('min_edge', { precision: 5, scale: 4 }).default('0.05'), // 0.05 = 5%
    minLiquidity: numeric('min_liquidity', { precision: 14, scale: 2 }).default(
      '1000',
    ),
    minConfidence: integer('min_confidence').default(6), // 1-10

    // Position sizing
    kellyFraction: numeric('kelly_fraction', {
      precision: 5,
      scale: 4,
    }).default('0.25'), // Quarter-Kelly
    maxPositionPct: numeric('max_position_pct', {
      precision: 5,
      scale: 4,
    }).default('0.10'), // 10% of bankroll

    // Risk management
    stopLossPct: numeric('stop_loss_pct', { precision: 5, scale: 4 }).default(
      '0.30',
    ), // Stop at 30% of budget
    targetMultiplier: numeric('target_multiplier', {
      precision: 5,
      scale: 2,
    }).default('3'), // 3x return target

    // Consecutive loss stop
    maxConsecutiveLosses: integer('max_consecutive_losses').default(5),

    // Budget
    defaultBudget: numeric('default_budget', {
      precision: 14,
      scale: 2,
    }).default('500'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [uniqueIndex('uq_polymarket_config_mode').on(table.mode)],
);

// ─── smart_money_config ────────────────────────────────────────────────
// Runtime-tunable thresholds for the sharp-qualification pipeline in
// smart-money-signal.service.ts. DB values override the hard-coded
// defaults on every call. Single-row table (profile = 'default') with
// the profile column reserved for future alternates (e.g. 'whales-only').

export const smartMoneyConfig = pgTable(
  'smart_money_config',
  {
    id: serial('id').primaryKey(),
    profile: varchar('profile', { length: 50 }).notNull().default('default'),

    minLifetimePnl: numeric('min_lifetime_pnl', { precision: 14, scale: 2 }),
    minLifetimePnlWithStreak: numeric('min_lifetime_pnl_with_streak', {
      precision: 14,
      scale: 2,
    }),
    minLifetimeRoi: numeric('min_lifetime_roi', { precision: 5, scale: 4 }),
    minResolvedBets: integer('min_resolved_bets'),
    minSharpCount: integer('min_sharp_count'),
    minPositionMultiple: numeric('min_position_multiple', {
      precision: 5,
      scale: 4,
    }),
    correlationThreshold: numeric('correlation_threshold', {
      precision: 5,
      scale: 4,
    }),
    minLast10WinRate: numeric('min_last_10_win_rate', {
      precision: 5,
      scale: 4,
    }),
    minCurrentStreak: integer('min_current_streak'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [uniqueIndex('uq_smart_money_config_profile').on(table.profile)],
);

// ─── smart_money_predictions ───────────────────────────────────────────
// Standalone predictions derived only from the Polymarket smart-money
// signal (no LLM, no Poisson). Kept in a separate table from the main
// `predictions` so the two sources don't mix in aggregate queries /
// fixture response payloads. One row per fixture.

export const smartMoneyPredictions = pgTable(
  'smart_money_predictions',
  {
    id: serial('id').primaryKey(),
    fixtureId: integer('fixture_id')
      .notNull()
      .references(() => fixtures.id),
    homeTeamId: integer('home_team_id').references(() => teams.id),
    awayTeamId: integer('away_team_id').references(() => teams.id),

    homeWinProb: numeric('home_win_prob', { precision: 5, scale: 4 }).notNull(),
    drawProb: numeric('draw_prob', { precision: 5, scale: 4 }).notNull(),
    awayWinProb: numeric('away_win_prob', { precision: 5, scale: 4 }).notNull(),

    predictedResult: varchar('predicted_result', { length: 20 }),
    confidence: integer('confidence'),

    source: varchar('source', { length: 20 }),
    thresholdMode: varchar('threshold_mode', { length: 20 }),
    modelVersion: varchar('model_version', { length: 50 }),

    smartMoneySignal: jsonb('smart_money_signal'),
    marketSignal: jsonb('market_signal'),

    predictionStatus: varchar('prediction_status', { length: 20 })
      .default('pending')
      .notNull(),
    actualHomeGoals: integer('actual_home_goals'),
    actualAwayGoals: integer('actual_away_goals'),
    actualResult: varchar('actual_result', { length: 20 }),
    wasCorrect: boolean('was_correct'),
    probabilityAccuracy: numeric('probability_accuracy', {
      precision: 8,
      scale: 6,
    }),
    resolvedAt: timestamp('resolved_at'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_smart_money_predictions_fixture').on(table.fixtureId),
    index('idx_smart_money_predictions_created').on(table.createdAt),
    index('idx_smart_money_predictions_status').on(table.predictionStatus),
    index('idx_smart_money_predictions_confidence').on(table.confidence),
  ],
);

// ─── copied_traders ────────────────────────────────────────────────────
// Copy-trader system: follow Polymarket wallets and (optionally)
// auto-mirror their trades onto our CLOB account. copy_enabled is
// default-false so adding a wallet is a safe action; admin toggles
// on once they trust the detection.

export const copiedTraders = pgTable(
  'copied_traders',
  {
    id: serial('id').primaryKey(),
    proxyWallet: varchar('proxy_wallet', { length: 255 }).notNull(),
    nickname: varchar('nickname', { length: 255 }),
    active: boolean('active').default(true).notNull(),

    copyEnabled: boolean('copy_enabled').default(false).notNull(),
    sizingMode: varchar('sizing_mode', { length: 20 })
      .default('fraction')
      .notNull(),
    sizingValue: numeric('sizing_value', { precision: 10, scale: 6 })
      .default('0.005')
      .notNull(),
    maxPositionUsd: numeric('max_position_usd', { precision: 14, scale: 2 })
      .default('50')
      .notNull(),

    minLast10Wins: integer('min_last_10_wins'),
    minLifetimePnl: numeric('min_lifetime_pnl', { precision: 14, scale: 2 }),
    minLifetimeRoi: numeric('min_lifetime_roi', { precision: 5, scale: 4 }),

    notes: text('notes'),
    addedAt: timestamp('added_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_copied_traders_wallet').on(table.proxyWallet),
    index('idx_copied_traders_active').on(table.active),
  ],
);

// ─── copied_trader_positions ───────────────────────────────────────────
// Snapshot of current positions per followed wallet, updated every
// sync. Diffing against the previous snapshot is how we detect new
// trades (trade_type='new') vs position increases ('increased').

export const copiedTraderPositions = pgTable(
  'copied_trader_positions',
  {
    id: serial('id').primaryKey(),
    proxyWallet: varchar('proxy_wallet', { length: 255 }).notNull(),
    conditionId: varchar('condition_id', { length: 255 }).notNull(),
    outcomeIndex: integer('outcome_index').notNull(),
    asset: varchar('asset', { length: 255 }),
    marketQuestion: text('market_question'),
    slug: varchar('slug', { length: 500 }),
    eventSlug: varchar('event_slug', { length: 500 }),

    size: numeric('size', { precision: 18, scale: 4 }),
    avgPrice: numeric('avg_price', { precision: 10, scale: 6 }),
    totalBought: numeric('total_bought', { precision: 14, scale: 2 }),
    currentValue: numeric('current_value', { precision: 14, scale: 2 }),
    lastSize: numeric('last_size', { precision: 18, scale: 4 }),

    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    status: varchar('status', { length: 20 }).default('open').notNull(),
  },
  (table) => [
    uniqueIndex('uq_copied_trader_positions_wallet_market_outcome').on(
      table.proxyWallet,
      table.conditionId,
      table.outcomeIndex,
    ),
    index('idx_copied_trader_positions_wallet').on(table.proxyWallet),
  ],
);

// ─── copied_trader_trades ──────────────────────────────────────────────
// Every detected trade, logged regardless of whether we executed it.
// execution_status tells you what happened:
//   'executed' — real CLOB order placed
//   'paper'    — liveTradingEnabled=false, logged only
//   'skipped'  — failed a gate (wallet cooled off, bankroll, etc.)
//   'failed'   — exception during execution
//   'pending'  — not yet evaluated

export const copiedTraderTrades = pgTable(
  'copied_trader_trades',
  {
    id: serial('id').primaryKey(),
    proxyWallet: varchar('proxy_wallet', { length: 255 }).notNull(),
    nickname: varchar('nickname', { length: 255 }),
    conditionId: varchar('condition_id', { length: 255 }).notNull(),
    outcomeIndex: integer('outcome_index').notNull(),
    outcomeName: varchar('outcome_name', { length: 100 }),
    marketQuestion: text('market_question'),
    slug: varchar('slug', { length: 500 }),
    eventSlug: varchar('event_slug', { length: 500 }),

    followedSize: numeric('followed_size', { precision: 18, scale: 4 }),
    followedAvgPrice: numeric('followed_avg_price', {
      precision: 10,
      scale: 6,
    }),
    sizeDelta: numeric('size_delta', { precision: 18, scale: 4 }),
    tradeType: varchar('trade_type', { length: 20 }),

    executionStatus: varchar('execution_status', { length: 20 }),
    executionReason: text('execution_reason'),
    ourPositionSizeUsd: numeric('our_position_size_usd', {
      precision: 14,
      scale: 2,
    }),
    ourTradeId: integer('our_trade_id'),
    ourClobOrderId: varchar('our_clob_order_id', { length: 255 }),

    detectedAt: timestamp('detected_at').defaultNow().notNull(),
    executedAt: timestamp('executed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_copied_trader_trades_wallet').on(
      table.proxyWallet,
      table.detectedAt,
    ),
    index('idx_copied_trader_trades_status').on(table.executionStatus),
    index('idx_copied_trader_trades_detected').on(table.detectedAt),
  ],
);

// ─── polymarket_holder_snapshots ───────────────────────────────────────
// Daily snapshot of /holders for tracked Polymarket markets. Required for
// walk-forward backtesting of the smart-money signal — without these,
// historical holder distribution is unrecoverable from the public API.

export const polymarketHolderSnapshots = pgTable(
  'polymarket_holder_snapshots',
  {
    id: serial('id').primaryKey(),
    conditionId: varchar('condition_id', { length: 255 }).notNull(),
    snapshotAt: timestamp('snapshot_at').defaultNow().notNull(),
    payload: jsonb('payload').notNull(),
    totalHolders: integer('total_holders').default(0).notNull(),
    totalDollars: numeric('total_dollars', { precision: 18, scale: 2 })
      .default('0')
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_pm_holder_snapshots_condition').on(
      table.conditionId,
      table.snapshotAt,
    ),
    index('idx_pm_holder_snapshots_taken').on(table.snapshotAt),
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
