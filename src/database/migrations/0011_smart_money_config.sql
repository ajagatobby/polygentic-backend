-- Runtime-configurable sharp-qualification thresholds for the
-- smart-money signal. Single-row (profile='default') config; DB values
-- override the hard-coded defaults in smart-money-signal.service.ts.

CREATE TABLE IF NOT EXISTS smart_money_config (
  id SERIAL PRIMARY KEY,
  profile VARCHAR(50) NOT NULL DEFAULT 'default',

  -- Qualification thresholds
  min_lifetime_pnl NUMERIC(14, 2),
  min_lifetime_pnl_with_streak NUMERIC(14, 2),
  min_lifetime_roi NUMERIC(5, 4),
  min_resolved_bets INTEGER,
  min_sharp_count INTEGER,
  min_position_multiple NUMERIC(5, 4),
  correlation_threshold NUMERIC(5, 4),
  min_last_10_win_rate NUMERIC(5, 4),
  min_current_streak INTEGER,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_smart_money_config_profile
  ON smart_money_config (profile);
