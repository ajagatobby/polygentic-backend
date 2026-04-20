-- Copy-trader system: follow Polymarket wallets and auto-mirror their
-- trades. Three tables:
--
--   copied_traders             — follow list + per-wallet copy config
--   copied_trader_positions    — per-wallet position snapshots used
--                                for diff-based trade detection
--   copied_trader_trades       — every detected trade with our
--                                execution outcome

CREATE TABLE IF NOT EXISTS copied_traders (
  id SERIAL PRIMARY KEY,
  proxy_wallet VARCHAR(255) NOT NULL,
  nickname VARCHAR(255),
  active BOOLEAN NOT NULL DEFAULT true,

  -- Execution flags / sizing
  copy_enabled BOOLEAN NOT NULL DEFAULT false,          -- explicit opt-in
  sizing_mode VARCHAR(20) NOT NULL DEFAULT 'fraction',  -- 'fixed' | 'fraction' | 'kelly'
  sizing_value NUMERIC(10, 6) NOT NULL DEFAULT 0.005,   -- 0.5% of followed size
  max_position_usd NUMERIC(14, 2) NOT NULL DEFAULT 50,  -- per-trade safety cap

  -- Optional re-check at execution time: skip if wallet cooled off
  min_last_10_wins INTEGER,
  min_lifetime_pnl NUMERIC(14, 2),
  min_lifetime_roi NUMERIC(5, 4),

  notes TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copied_traders_wallet
  ON copied_traders (proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_copied_traders_active
  ON copied_traders (active);

CREATE TABLE IF NOT EXISTS copied_trader_positions (
  id SERIAL PRIMARY KEY,
  proxy_wallet VARCHAR(255) NOT NULL,
  condition_id VARCHAR(255) NOT NULL,
  outcome_index INTEGER NOT NULL,
  asset VARCHAR(255),
  market_question TEXT,
  slug VARCHAR(500),
  event_slug VARCHAR(500),

  size NUMERIC(18, 4),
  avg_price NUMERIC(10, 6),
  total_bought NUMERIC(14, 2),
  current_value NUMERIC(14, 2),
  last_size NUMERIC(18, 4),

  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copied_trader_positions_wallet_market_outcome
  ON copied_trader_positions (proxy_wallet, condition_id, outcome_index);
CREATE INDEX IF NOT EXISTS idx_copied_trader_positions_wallet
  ON copied_trader_positions (proxy_wallet);

CREATE TABLE IF NOT EXISTS copied_trader_trades (
  id SERIAL PRIMARY KEY,
  proxy_wallet VARCHAR(255) NOT NULL,
  nickname VARCHAR(255),
  condition_id VARCHAR(255) NOT NULL,
  outcome_index INTEGER NOT NULL,
  outcome_name VARCHAR(100),
  market_question TEXT,
  slug VARCHAR(500),
  event_slug VARCHAR(500),

  followed_size NUMERIC(18, 4),
  followed_avg_price NUMERIC(10, 6),
  size_delta NUMERIC(18, 4),                  -- new: full size, increased: delta
  trade_type VARCHAR(20),                      -- 'new' | 'increased'

  -- Execution outcome
  execution_status VARCHAR(20),                -- 'executed' | 'paper' | 'skipped' | 'failed'
  execution_reason TEXT,
  our_position_size_usd NUMERIC(14, 2),
  our_trade_id INTEGER,                        -- fk to polymarket_trades if executed
  our_clob_order_id VARCHAR(255),

  detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copied_trader_trades_wallet
  ON copied_trader_trades (proxy_wallet, detected_at);
CREATE INDEX IF NOT EXISTS idx_copied_trader_trades_status
  ON copied_trader_trades (execution_status);
CREATE INDEX IF NOT EXISTS idx_copied_trader_trades_detected
  ON copied_trader_trades (detected_at);
