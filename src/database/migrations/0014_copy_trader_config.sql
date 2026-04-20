-- Runtime-tunable global settings for the copy-trader system.
-- Single-row table (profile='default'). Per-wallet overrides live on
-- copied_traders — this is the system-wide knobs.

CREATE TABLE IF NOT EXISTS copy_trader_config (
  id SERIAL PRIMARY KEY,
  profile VARCHAR(50) NOT NULL DEFAULT 'default',

  -- Master switch. If false, the sync task no-ops regardless of
  -- per-wallet copy_enabled flags. Kill-switch for the whole system.
  enabled BOOLEAN NOT NULL DEFAULT true,

  -- How often the sync task actually runs. Cron fires every 5 min but
  -- the task checks this interval vs last_sync_at and bails if we're
  -- within window. Tune via PATCH without redeploying.
  sync_interval_minutes INTEGER NOT NULL DEFAULT 10,

  -- Defaults used when `follow` is called without per-trader values.
  default_sizing_mode VARCHAR(20) NOT NULL DEFAULT 'fraction',
  default_sizing_value NUMERIC(10, 6) NOT NULL DEFAULT 0.005,
  default_max_position_usd NUMERIC(14, 2) NOT NULL DEFAULT 50,

  -- Daily safety caps, enforced across all followed wallets combined.
  -- Hitting either cap pauses further executions for the rest of the
  -- UTC day; detections are still logged.
  max_daily_trades INTEGER NOT NULL DEFAULT 50,
  max_daily_spend_usd NUMERIC(14, 2) NOT NULL DEFAULT 500,

  -- Skip a copy trade when the current market midpoint has moved more
  -- than this fraction from the followed wallet's avg price. 0.05 = 5%.
  -- Prevents filling at a dramatically worse price than they paid.
  price_slippage_tolerance NUMERIC(5, 4) NOT NULL DEFAULT 0.05,

  -- Circuit breaker: after N consecutive failed copy trades, auto-pause
  -- the whole system (sets enabled=false). Operator flips it back on.
  max_consecutive_losses INTEGER NOT NULL DEFAULT 5,

  -- State — updated by the sync task.
  last_sync_at TIMESTAMP,
  last_sync_run_id VARCHAR(255),

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_trader_config_profile
  ON copy_trader_config (profile);

-- Seed the default row.
INSERT INTO copy_trader_config (profile)
VALUES ('default')
ON CONFLICT (profile) DO NOTHING;
