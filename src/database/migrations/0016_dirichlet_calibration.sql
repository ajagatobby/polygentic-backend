-- Dirichlet calibration parameters (Kull et al., NeurIPS 2019).
--
-- Native-multiclass replacement for the per-outcome isotonic mapping in
-- prediction_calibration. One row per scope (global -1 or per-league)
-- holds the 3×3 weight matrix W and 3-vector bias b of the linear layer
-- in:
--
--   z = W · ln(p) + b
--   q = softmax(z)
--
-- Storage layout:
--   weights: JSONB nested array, shape [3][3], outcome order [home, draw, away]
--   bias:    JSONB array of length 3, same outcome order
--
-- Fitter: DirichletCalibrationService — minimises NLL via Adam with ODIR
-- (off-diagonal + bias L2 regularisation) per Kull et al.
--
-- Read path mirrors prediction_calibration: look up the row whose
-- league_id matches the fixture's league; fall back to league_id = -1
-- if absent; pass through unchanged if neither exists.

CREATE TABLE IF NOT EXISTS dirichlet_calibration (
  id SERIAL PRIMARY KEY,
  -- -1 = global fallback, otherwise fixtures.league_id
  league_id INTEGER NOT NULL DEFAULT -1,
  -- 3x3 weight matrix (rows: outcomes, cols: log-input dimension)
  weights JSONB NOT NULL,
  -- 3-vector bias
  bias JSONB NOT NULL,
  -- Number of resolved predictions used to fit
  sample_size INTEGER NOT NULL,
  -- Final NLL achieved during fit (diagnostic)
  final_loss NUMERIC(10, 6),
  fitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dirichlet_calib_league
  ON dirichlet_calibration (league_id);
