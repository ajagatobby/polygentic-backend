-- Pi-ratings (Constantinou & Fenton, 2013) and learned meta-blender.
--
-- Three tables:
--
-- 1. team_pi_ratings  — one row per team. Stores the home / away rating
--    pair that the iterative update rule maintains. Updates happen via
--    the refit job by replaying all FT-status fixtures in chronological
--    order; that keeps the math identical regardless of when the refit
--    runs.
--
-- 2. pi_rating_mapping — fitted ordered-logit (β, τ_AD, τ_DH) that maps
--    predicted goal difference ĝ = R_home^H - R_away^A to the 1X2
--    probability vector. League-scoped (with -1 = global fallback) so a
--    league with reliably high-scoring matches can have a steeper slope.
--
-- 3. meta_blender_params — log-pool weights blending the four base
--    predictors (Claude / Poisson / Pinnacle / Pi). Parameter shape:
--    4 weights (one per predictor) + 3 biases (one per outcome). Stored
--    as plain JSONB arrays for simplicity.

CREATE TABLE IF NOT EXISTS team_pi_ratings (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL UNIQUE,
  home_rating NUMERIC(10, 4) NOT NULL DEFAULT 0,
  away_rating NUMERIC(10, 4) NOT NULL DEFAULT 0,
  matches_used INTEGER NOT NULL DEFAULT 0,
  last_match_date TIMESTAMP,
  last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_pi_ratings_updated
  ON team_pi_ratings (last_updated DESC);

CREATE TABLE IF NOT EXISTS pi_rating_mapping (
  id SERIAL PRIMARY KEY,
  -- -1 = global fallback, otherwise fixtures.league_id
  league_id INTEGER NOT NULL DEFAULT -1,
  beta NUMERIC(10, 6) NOT NULL,
  tau_ad NUMERIC(10, 6) NOT NULL,  -- threshold for away vs draw/home
  tau_dh NUMERIC(10, 6) NOT NULL,  -- threshold for away/draw vs home
  sample_size INTEGER NOT NULL,
  final_loss NUMERIC(10, 6),
  fitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_rating_mapping_league
  ON pi_rating_mapping (league_id);

CREATE TABLE IF NOT EXISTS meta_blender_params (
  id SERIAL PRIMARY KEY,
  -- -1 = global fallback
  league_id INTEGER NOT NULL DEFAULT -1,
  -- JSONB array of weights in predictor_order, length 4
  weights JSONB NOT NULL,
  -- JSONB array of per-outcome biases [b_H, b_D, b_A], length 3
  bias JSONB NOT NULL,
  -- Names of predictors in slot order, e.g. ['claude','poisson','bookmaker','pi_rating']
  predictor_order JSONB NOT NULL,
  sample_size INTEGER NOT NULL,
  final_loss NUMERIC(10, 6),
  fitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_blender_league
  ON meta_blender_params (league_id);
