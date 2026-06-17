-- Deep-analysis additions for the prediction response.
--
-- 1. player_season_stats — cache of per-player season aggregates pulled from
--    API-Football `/players?team=&season=` (paginated). One row per
--    (player, team, season). Refreshed lazily by
--    FootballService.getSquadWithSeasonStats when missing or stale. Powers the
--    player-by-player (GK -> every outfield player) breakdown in the insights.
--    Display-only: it does NOT feed the probability model.
--
-- 2. predictions.match_insights — JSONB blob holding the display-only deep
--    analysis surfaced in the response: head-to-head history + summary +
--    streak, last-20 recent form per team with readable scorelines, team
--    streaks, and the full player-by-player roster. Computed by
--    MatchInsightsService. Does NOT influence probabilities.

CREATE TABLE IF NOT EXISTS player_season_stats (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  season INTEGER NOT NULL,
  league_id INTEGER,
  name VARCHAR(255),
  firstname VARCHAR(255),
  lastname VARCHAR(255),
  age INTEGER,
  nationality VARCHAR(100),
  height VARCHAR(20),
  weight VARCHAR(20),
  photo VARCHAR(500),
  position VARCHAR(50),
  appearances INTEGER,
  lineups INTEGER,
  minutes INTEGER,
  rating NUMERIC(4, 2),
  captain BOOLEAN,
  goals INTEGER,
  assists INTEGER,
  goals_conceded INTEGER,
  saves INTEGER,
  shots_total INTEGER,
  shots_on INTEGER,
  passes_total INTEGER,
  passes_key INTEGER,
  pass_accuracy INTEGER,
  tackles_total INTEGER,
  interceptions INTEGER,
  duels_total INTEGER,
  duels_won INTEGER,
  dribbles_attempts INTEGER,
  dribbles_success INTEGER,
  yellow_cards INTEGER,
  red_cards INTEGER,
  penalty_scored INTEGER,
  penalty_missed INTEGER,
  raw_data JSONB,
  fetched_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_season_stats_team_season
  ON player_season_stats (team_id, season);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_season_stats_player_team_season
  ON player_season_stats (player_id, team_id, season);

ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS match_insights JSONB;
