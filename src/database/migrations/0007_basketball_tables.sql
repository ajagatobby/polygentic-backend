-- Basketball Tables Migration
-- Adds support for basketball fixtures from API-Basketball (api-sports.io)
-- Tracked leagues: NBA, NCAAB, KBL, Liga Endesa, LNB, Serie A,
--                  Champions League, NBL, Pro A, Euroleague Basketball

-- ─── basketball_teams ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "basketball_teams" (
  "id" integer PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "short_name" varchar(50),
  "logo" varchar(500),
  "country" varchar(100),
  "league_id" integer,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_basketball_teams_name" ON "basketball_teams" ("name");

-- ─── basketball_fixtures ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "basketball_fixtures" (
  "id" integer PRIMARY KEY NOT NULL,
  "league_id" integer NOT NULL,
  "league_name" varchar(255),
  "league_country" varchar(100),
  "league_season" varchar(20),
  "season" integer,
  "stage" varchar(255),
  "week" varchar(100),
  "home_team_id" integer NOT NULL REFERENCES "basketball_teams"("id"),
  "away_team_id" integer NOT NULL REFERENCES "basketball_teams"("id"),
  "date" timestamp NOT NULL,
  "timestamp" bigint,
  "venue_name" varchar(255),
  "venue_city" varchar(100),
  "status" varchar(10) NOT NULL,
  "status_long" varchar(50),
  "timer" varchar(10),
  "score_home" integer,
  "score_away" integer,
  "score_q1_home" integer,
  "score_q1_away" integer,
  "score_q2_home" integer,
  "score_q2_away" integer,
  "score_q3_home" integer,
  "score_q3_away" integer,
  "score_q4_home" integer,
  "score_q4_away" integer,
  "score_ot_home" integer,
  "score_ot_away" integer,
  "score_halftime_home" integer,
  "score_halftime_away" integer,
  "raw_data" jsonb,
  "odds_api_event_id" varchar(255),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_basketball_fixtures_date" ON "basketball_fixtures" ("date");
CREATE INDEX IF NOT EXISTS "idx_basketball_fixtures_league" ON "basketball_fixtures" ("league_id", "season");
CREATE INDEX IF NOT EXISTS "idx_basketball_fixtures_teams" ON "basketball_fixtures" ("home_team_id", "away_team_id");
CREATE INDEX IF NOT EXISTS "idx_basketball_fixtures_status" ON "basketball_fixtures" ("status");
CREATE INDEX IF NOT EXISTS "idx_basketball_fixtures_odds_event" ON "basketball_fixtures" ("odds_api_event_id");

-- ─── basketball_fixture_statistics ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS "basketball_fixture_statistics" (
  "id" serial PRIMARY KEY NOT NULL,
  "fixture_id" integer NOT NULL REFERENCES "basketball_fixtures"("id"),
  "team_id" integer NOT NULL REFERENCES "basketball_teams"("id"),
  "field_goals_made" integer,
  "field_goals_attempted" integer,
  "field_goals_pct" numeric(5, 2),
  "three_point_made" integer,
  "three_point_attempted" integer,
  "three_point_pct" numeric(5, 2),
  "free_throws_made" integer,
  "free_throws_attempted" integer,
  "free_throws_pct" numeric(5, 2),
  "offensive_rebounds" integer,
  "defensive_rebounds" integer,
  "total_rebounds" integer,
  "assists" integer,
  "turnovers" integer,
  "steals" integer,
  "blocks" integer,
  "personal_fouls" integer,
  "points_in_paint" integer,
  "second_chance_points" integer,
  "fast_break_points" integer,
  "bench_points" integer,
  "recorded_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_basketball_fixture_stats_fixture" ON "basketball_fixture_statistics" ("fixture_id");
CREATE INDEX IF NOT EXISTS "idx_basketball_fixture_stats_team" ON "basketball_fixture_statistics" ("team_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_basketball_fixture_stats_fixture_team" ON "basketball_fixture_statistics" ("fixture_id", "team_id");

-- ─── basketball_injuries ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "basketball_injuries" (
  "id" serial PRIMARY KEY NOT NULL,
  "player_id" integer NOT NULL,
  "player_name" varchar(255) NOT NULL,
  "team_id" integer NOT NULL REFERENCES "basketball_teams"("id"),
  "fixture_id" integer REFERENCES "basketball_fixtures"("id"),
  "league_id" integer NOT NULL,
  "type" varchar(100),
  "reason" varchar(255),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_basketball_injuries_team" ON "basketball_injuries" ("team_id");
CREATE INDEX IF NOT EXISTS "idx_basketball_injuries_fixture" ON "basketball_injuries" ("fixture_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_basketball_injuries_player_team_league_type" ON "basketball_injuries" ("player_id", "team_id", "league_id", "type");

-- ─── basketball_team_form ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "basketball_team_form" (
  "id" serial PRIMARY KEY NOT NULL,
  "team_id" integer NOT NULL REFERENCES "basketball_teams"("id"),
  "league_id" integer NOT NULL,
  "season" integer NOT NULL,
  "form_string" varchar(20),
  "wins" integer,
  "losses" integer,
  "win_pct" numeric(5, 3),
  "home_wins" integer,
  "home_losses" integer,
  "away_wins" integer,
  "away_losses" integer,
  "streak" integer,
  "streak_type" varchar(5),
  "last_10_wins" integer,
  "last_10_losses" integer,
  "points_per_game" numeric(6, 2),
  "opponent_points_per_game" numeric(6, 2),
  "points_diff" numeric(6, 2),
  "league_position" integer,
  "conference_name" varchar(100),
  "conference_rank" integer,
  "division_name" varchar(100),
  "division_rank" integer,
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_basketball_team_form_team_league" ON "basketball_team_form" ("team_id", "league_id", "season");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_basketball_team_form_team_league_season" ON "basketball_team_form" ("team_id", "league_id", "season");
