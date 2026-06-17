-- team_season_statistics — cache of API-Football `/teams/statistics`.
--
-- One call per (team, league, season) returns a rich season profile that we
-- otherwise can't derive cheaply: home/away W/D/L splits, goals scored &
-- conceded BY MINUTE INTERVAL, over/under distributions, clean sheets,
-- failed-to-score, biggest streaks, penalties, formations used, and cards by
-- minute. Refreshed lazily by FootballService.getTeamSeasonStatistics.
-- Powers the team-profile section of the prediction insights (display-first;
-- any signals that later move probabilities go through a backtest gate).

CREATE TABLE IF NOT EXISTS team_season_statistics (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  league_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  form_string VARCHAR(80),
  played_home INTEGER,
  played_away INTEGER,
  played_total INTEGER,
  wins_home INTEGER,
  wins_away INTEGER,
  wins_total INTEGER,
  draws_home INTEGER,
  draws_away INTEGER,
  draws_total INTEGER,
  losses_home INTEGER,
  losses_away INTEGER,
  losses_total INTEGER,
  goals_for_home INTEGER,
  goals_for_away INTEGER,
  goals_for_total INTEGER,
  goals_against_home INTEGER,
  goals_against_away INTEGER,
  goals_against_total INTEGER,
  goals_for_avg_home NUMERIC(5, 2),
  goals_for_avg_away NUMERIC(5, 2),
  goals_for_avg_total NUMERIC(5, 2),
  goals_against_avg_home NUMERIC(5, 2),
  goals_against_avg_away NUMERIC(5, 2),
  goals_against_avg_total NUMERIC(5, 2),
  clean_sheet_home INTEGER,
  clean_sheet_away INTEGER,
  clean_sheet_total INTEGER,
  failed_to_score_home INTEGER,
  failed_to_score_away INTEGER,
  failed_to_score_total INTEGER,
  streak_wins INTEGER,
  streak_draws INTEGER,
  streak_loses INTEGER,
  penalty_scored INTEGER,
  penalty_missed INTEGER,
  penalty_total INTEGER,
  goals_for_by_minute JSONB,
  goals_against_by_minute JSONB,
  goals_for_under_over JSONB,
  goals_against_under_over JSONB,
  cards_yellow_by_minute JSONB,
  cards_red_by_minute JSONB,
  biggest JSONB,
  lineups_used JSONB,
  raw_data JSONB,
  fetched_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_season_stats_team_league_season
  ON team_season_statistics (team_id, league_id, season);

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_season_stats_team_league_season
  ON team_season_statistics (team_id, league_id, season);
