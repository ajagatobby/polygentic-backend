-- Fitted isotonic calibration mappings (Phase 6).
--
-- One row per (scope, outcome) where scope is either a league_id or -1
-- (sentinel) for the global fallback. Breakpoints are stored as a JSONB
-- array of {xMin, xMax, y} blocks, produced by the IsotonicCalibration
-- service running pool-adjacent violators on resolved predictions.

CREATE TABLE IF NOT EXISTS prediction_calibration (
  id SERIAL PRIMARY KEY,
  -- -1 = global fallback, otherwise fixtures.league_id
  league_id INTEGER NOT NULL DEFAULT -1,
  -- 'home_win' | 'draw' | 'away_win'
  outcome VARCHAR(20) NOT NULL,
  -- Piecewise-constant isotonic mapping: [{xMin, xMax, y}]
  breakpoints JSONB NOT NULL,
  -- Number of resolved predictions used to fit
  sample_size INTEGER NOT NULL,
  fitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pred_calib_league
  ON prediction_calibration (league_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pred_calib_scope
  ON prediction_calibration (league_id, outcome);
