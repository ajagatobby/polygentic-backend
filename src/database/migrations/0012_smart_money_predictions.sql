-- Separate table for smart-money-only predictions so they don't mix
-- with the LLM ensemble predictions in the `predictions` table.
-- One row per fixture.

CREATE TABLE IF NOT EXISTS smart_money_predictions (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id),
  home_team_id INTEGER REFERENCES teams(id),
  away_team_id INTEGER REFERENCES teams(id),

  -- Probabilities (sum to 1)
  home_win_prob NUMERIC(5, 4) NOT NULL,
  draw_prob NUMERIC(5, 4) NOT NULL,
  away_win_prob NUMERIC(5, 4) NOT NULL,

  -- Prediction output
  predicted_result VARCHAR(20), -- 'home_win' | 'draw' | 'away_win'
  confidence INTEGER,           -- 1-10

  -- Signal metadata
  source VARCHAR(20),           -- 'direct' | 'market'
  threshold_mode VARCHAR(20),   -- 'strict' | 'relaxed' | NULL for market
  model_version VARCHAR(50),    -- 'smart-money-v1' | 'smart-money-v1-market'

  -- Raw signal + market fallback snapshot
  smart_money_signal JSONB,
  market_signal JSONB,

  -- Lifecycle + resolution
  prediction_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'resolved' | 'void'
  actual_home_goals INTEGER,
  actual_away_goals INTEGER,
  actual_result VARCHAR(20),
  was_correct BOOLEAN,
  probability_accuracy NUMERIC(8, 6), -- Brier score
  resolved_at TIMESTAMP,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_smart_money_predictions_fixture
  ON smart_money_predictions (fixture_id);

CREATE INDEX IF NOT EXISTS idx_smart_money_predictions_created
  ON smart_money_predictions (created_at);
CREATE INDEX IF NOT EXISTS idx_smart_money_predictions_status
  ON smart_money_predictions (prediction_status);
CREATE INDEX IF NOT EXISTS idx_smart_money_predictions_confidence
  ON smart_money_predictions (confidence);
