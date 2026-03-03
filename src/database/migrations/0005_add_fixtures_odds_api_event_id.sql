-- Migration: Add odds_api_event_id column to fixtures table
-- Links fixtures to The Odds API events via team name + date fuzzy matching
-- during odds sync. Enables GET /api/fixtures/:id/odds endpoints.

ALTER TABLE fixtures ADD COLUMN odds_api_event_id VARCHAR(255);

CREATE INDEX idx_fixtures_odds_event ON fixtures (odds_api_event_id);
