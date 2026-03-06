-- Polymarket Trading Agent tables
-- Phase 1: Market discovery, value detection, and paper trading

-- ─── polymarket_markets ────────────────────────────────────────────────
-- Cached Polymarket events/markets discovered via Gamma API

CREATE TABLE IF NOT EXISTS "polymarket_markets" (
  "id" serial PRIMARY KEY,
  "event_id" varchar(255) NOT NULL,
  "market_id" varchar(255) NOT NULL,
  "condition_id" varchar(255),
  "slug" varchar(500),
  "event_title" text NOT NULL,
  "market_question" text NOT NULL,
  "outcomes" jsonb NOT NULL,
  "clob_token_ids" jsonb NOT NULL,
  "market_type" varchar(50) NOT NULL,
  "tags" jsonb,
  "outcome_prices" jsonb,
  "midpoints" jsonb,
  "spreads" jsonb,
  "liquidity" numeric(14, 2),
  "volume" numeric(14, 2),
  "volume_24hr" numeric(14, 2),
  "active" boolean DEFAULT true,
  "closed" boolean DEFAULT false,
  "accepting_orders" boolean DEFAULT true,
  "start_date" timestamp,
  "end_date" timestamp,
  "fixture_id" integer REFERENCES "fixtures"("id"),
  "match_score" numeric(5, 4),
  "last_synced_at" timestamp DEFAULT now(),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_polymarket_markets_market_id" ON "polymarket_markets" ("market_id");
CREATE INDEX IF NOT EXISTS "idx_polymarket_markets_event" ON "polymarket_markets" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_polymarket_markets_fixture" ON "polymarket_markets" ("fixture_id");
CREATE INDEX IF NOT EXISTS "idx_polymarket_markets_type" ON "polymarket_markets" ("market_type");
CREATE INDEX IF NOT EXISTS "idx_polymarket_markets_active" ON "polymarket_markets" ("active", "closed");
CREATE INDEX IF NOT EXISTS "idx_polymarket_markets_synced" ON "polymarket_markets" ("last_synced_at");

-- ─── polymarket_trades ─────────────────────────────────────────────────
-- Both paper trades and real trades

CREATE TABLE IF NOT EXISTS "polymarket_trades" (
  "id" serial PRIMARY KEY,
  "polymarket_market_id" integer NOT NULL REFERENCES "polymarket_markets"("id"),
  "prediction_id" integer REFERENCES "predictions"("id"),
  "fixture_id" integer REFERENCES "fixtures"("id"),
  "mode" varchar(20) NOT NULL,
  "side" varchar(10) NOT NULL,
  "outcome_index" integer NOT NULL,
  "outcome_name" varchar(255) NOT NULL,
  "entry_price" numeric(10, 6) NOT NULL,
  "midpoint_at_entry" numeric(10, 6),
  "spread_at_entry" numeric(10, 6),
  "position_size_usd" numeric(14, 2) NOT NULL,
  "token_quantity" numeric(14, 6),
  "ensemble_probability" numeric(5, 4) NOT NULL,
  "polymarket_probability" numeric(5, 4) NOT NULL,
  "edge_percent" numeric(8, 4) NOT NULL,
  "kelly_fraction" numeric(8, 6),
  "confidence_at_entry" integer,
  "agent_reasoning" text,
  "risk_assessment" text,
  "bankroll_at_entry" numeric(14, 2),
  "open_positions_count" integer,
  "order_id" varchar(255),
  "order_status" varchar(50),
  "fill_price" numeric(10, 6),
  "fill_timestamp" timestamp,
  "exit_price" numeric(10, 6),
  "pnl_usd" numeric(14, 2),
  "pnl_percent" numeric(8, 4),
  "resolved_at" timestamp,
  "resolution_outcome" varchar(50),
  "status" varchar(20) NOT NULL DEFAULT 'open',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_market" ON "polymarket_trades" ("polymarket_market_id");
CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_prediction" ON "polymarket_trades" ("prediction_id");
CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_fixture" ON "polymarket_trades" ("fixture_id");
CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_mode" ON "polymarket_trades" ("mode");
CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_status" ON "polymarket_trades" ("status");
CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_created" ON "polymarket_trades" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_polymarket_trades_resolved" ON "polymarket_trades" ("resolved_at");

-- ─── polymarket_bankroll ───────────────────────────────────────────────
-- Tracks bankroll state over time

CREATE TABLE IF NOT EXISTS "polymarket_bankroll" (
  "id" serial PRIMARY KEY,
  "mode" varchar(20) NOT NULL,
  "initial_budget" numeric(14, 2) NOT NULL,
  "current_balance" numeric(14, 2) NOT NULL,
  "total_deposited" numeric(14, 2) NOT NULL DEFAULT 0,
  "total_withdrawn" numeric(14, 2) NOT NULL DEFAULT 0,
  "realized_pnl" numeric(14, 2) NOT NULL DEFAULT 0,
  "unrealized_pnl" numeric(14, 2) NOT NULL DEFAULT 0,
  "total_trades" integer NOT NULL DEFAULT 0,
  "winning_trades" integer NOT NULL DEFAULT 0,
  "losing_trades" integer NOT NULL DEFAULT 0,
  "win_rate" numeric(5, 4),
  "avg_edge" numeric(8, 4),
  "max_drawdown_pct" numeric(8, 4),
  "peak_balance" numeric(14, 2),
  "current_drawdown_pct" numeric(8, 4),
  "is_stopped" boolean DEFAULT false,
  "stopped_reason" text,
  "open_positions_count" integer NOT NULL DEFAULT 0,
  "open_positions_value" numeric(14, 2) NOT NULL DEFAULT 0,
  "snapshot_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_polymarket_bankroll_mode" ON "polymarket_bankroll" ("mode");
CREATE INDEX IF NOT EXISTS "idx_polymarket_bankroll_snapshot" ON "polymarket_bankroll" ("snapshot_at");
