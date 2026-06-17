-- Baseball (MLB run-totals) Tables Migration
-- Adds support for MLB over/under predictions:
--   * API-Sports baseball games/teams (league 1 = MLB)
--   * Bridge to MLB StatsAPI (MLBAM) ids + handedness park factors
--   * Statcast/FanGraphs pitcher + team-batting true-talent snapshots
--   * Sharp market totals (The Odds API) for blend + CLV
--   * baseball_predictions (one over/under prediction per game)

-- ─── baseball_teams ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_teams" (
  "id" integer PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "short_name" varchar(50),
  "logo" varchar(500),
  "country" varchar(100),
  "league_id" integer,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_baseball_teams_name" ON "baseball_teams" ("name");

-- ─── baseball_team_map ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_team_map" (
  "id" serial PRIMARY KEY NOT NULL,
  "api_sports_team_id" integer,
  "mlbam_team_id" integer NOT NULL,
  "abbrev" varchar(8) NOT NULL,
  "canonical_name" varchar(255) NOT NULL,
  "full_name" varchar(255),
  "venue_name" varchar(255),
  "park_run_factor" numeric(5,3),
  "park_hr_factor_l" numeric(5,3),
  "park_hr_factor_r" numeric(5,3),
  "park_orientation_deg" integer,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_baseball_team_map_mlbam" ON "baseball_team_map" ("mlbam_team_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_baseball_team_map_apisports" ON "baseball_team_map" ("api_sports_team_id");
CREATE INDEX IF NOT EXISTS "idx_baseball_team_map_abbrev" ON "baseball_team_map" ("abbrev");

-- ─── baseball_games ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_games" (
  "id" integer PRIMARY KEY NOT NULL,
  "league_id" integer NOT NULL,
  "league_name" varchar(255),
  "season" integer,
  "home_team_id" integer NOT NULL REFERENCES "baseball_teams"("id"),
  "away_team_id" integer NOT NULL REFERENCES "baseball_teams"("id"),
  "date" timestamp NOT NULL,
  "timestamp" bigint,
  "venue_name" varchar(255),
  "venue_city" varchar(100),
  "status" varchar(10) NOT NULL,
  "status_long" varchar(50),
  "runs_home" integer,
  "runs_away" integer,
  "inning_scores" jsonb,
  "game_pk" integer,
  "home_probable_pitcher_id" integer,
  "away_probable_pitcher_id" integer,
  "lineups_confirmed" boolean DEFAULT false,
  "weather" jsonb,
  "raw_data" jsonb,
  "odds_api_event_id" varchar(255),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_baseball_games_date" ON "baseball_games" ("date");
CREATE INDEX IF NOT EXISTS "idx_baseball_games_league" ON "baseball_games" ("league_id","season");
CREATE INDEX IF NOT EXISTS "idx_baseball_games_teams" ON "baseball_games" ("home_team_id","away_team_id");
CREATE INDEX IF NOT EXISTS "idx_baseball_games_status" ON "baseball_games" ("status");
CREATE INDEX IF NOT EXISTS "idx_baseball_games_gamepk" ON "baseball_games" ("game_pk");

-- ─── baseball_pitchers ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_pitchers" (
  "mlbam_id" integer PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "throws" varchar(1),
  "team_mlbam_id" integer,
  "role" varchar(10),
  "ip" numeric(6,1),
  "era" numeric(5,2),
  "fip" numeric(5,2),
  "xera" numeric(5,2),
  "siera" numeric(5,2),
  "xwoba_against" numeric(5,3),
  "k_pct" numeric(5,3),
  "bb_pct" numeric(5,3),
  "barrel_pct" numeric(5,3),
  "hr_per_9" numeric(5,2),
  "proj_era" numeric(5,2),
  "proj_siera" numeric(5,2),
  "last_30" jsonb,
  "raw_statcast" jsonb,
  "raw_projection" jsonb,
  "statcast_fetched_at" timestamp,
  "projection_fetched_at" timestamp,
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_baseball_pitchers_team" ON "baseball_pitchers" ("team_mlbam_id");

-- ─── baseball_team_batting ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_team_batting" (
  "id" serial PRIMARY KEY NOT NULL,
  "team_mlbam_id" integer NOT NULL,
  "season" integer NOT NULL,
  "split" varchar(10) NOT NULL,
  "runs_per_game" numeric(5,3),
  "woba" numeric(5,3),
  "xwoba" numeric(5,3),
  "wrc_plus" integer,
  "k_pct" numeric(5,3),
  "bb_pct" numeric(5,3),
  "iso" numeric(5,3),
  "raw" jsonb,
  "fetched_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_baseball_team_batting" ON "baseball_team_batting" ("team_mlbam_id","season","split");

-- ─── baseball_market_lines ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_market_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "game_id" integer NOT NULL REFERENCES "baseball_games"("id"),
  "bookmaker" varchar(50) NOT NULL,
  "total_line" numeric(5,2) NOT NULL,
  "over_price" numeric(8,4),
  "under_price" numeric(8,4),
  "over_implied_prob" numeric(5,4),
  "is_opening" boolean DEFAULT false,
  "is_closing" boolean DEFAULT false,
  "captured_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_baseball_market_lines_game" ON "baseball_market_lines" ("game_id");
CREATE INDEX IF NOT EXISTS "idx_baseball_market_lines_book" ON "baseball_market_lines" ("bookmaker");

-- ─── baseball_predictions ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "baseball_predictions" (
  "id" serial PRIMARY KEY NOT NULL,
  "game_id" integer NOT NULL REFERENCES "baseball_games"("id"),
  "home_team_id" integer REFERENCES "baseball_teams"("id"),
  "away_team_id" integer REFERENCES "baseball_teams"("id"),
  "expected_home_runs" numeric(5,2),
  "expected_away_runs" numeric(5,2),
  "expected_total" numeric(5,2),
  "dispersion" numeric(6,3),
  "line_probs" jsonb,
  "primary_line" numeric(5,2),
  "primary_p_over" numeric(5,4),
  "predictor_probs" jsonb,
  "market_total" numeric(5,2),
  "market_p_over" numeric(5,4),
  "confidence" integer,
  "prediction_type" varchar(20) NOT NULL,
  "model_version" varchar(50),
  "key_factors" jsonb,
  "risk_factors" jsonb,
  "research_context" jsonb,
  "detailed_analysis" text,
  "prediction_status" varchar(20) DEFAULT 'pending',
  "actual_total_runs" integer,
  "per_line_results" jsonb,
  "brier" numeric(8,6),
  "resolved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_baseball_predictions_game" ON "baseball_predictions" ("game_id");
CREATE INDEX IF NOT EXISTS "idx_baseball_predictions_status" ON "baseball_predictions" ("prediction_status");
CREATE INDEX IF NOT EXISTS "idx_baseball_predictions_type" ON "baseball_predictions" ("prediction_type");
