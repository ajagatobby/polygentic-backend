-- Migration: Create fixture_lineups table for storing confirmed match lineups
-- Lineups include formation, starting XI, substitutes, and coach data per team

CREATE TABLE IF NOT EXISTS fixture_lineups (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  formation VARCHAR(20),
  coach_id INTEGER,
  coach_name VARCHAR(255),
  coach_photo VARCHAR(500),
  start_xi JSONB,
  substitutes JSONB,
  team_colors JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fixture_lineups_fixture ON fixture_lineups(fixture_id);
CREATE INDEX IF NOT EXISTS idx_fixture_lineups_team ON fixture_lineups(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fixture_lineups_fixture_team ON fixture_lineups(fixture_id, team_id);
