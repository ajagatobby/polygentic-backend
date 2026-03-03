-- Migration: Fix injuries unique index + make league_id NOT NULL
-- The old index included fixtureId which is nullable. In PostgreSQL,
-- NULL != NULL in unique indexes, so onConflictDoUpdate never matched
-- rows with fixtureId = null, causing duplicate rows every sync cycle.
--
-- New index uses (playerId, teamId, leagueId, type) which are all
-- non-nullable and properly deduplicate injury records.

-- Step 1: Delete any rows with NULL league_id (shouldn't exist but safety first)
DELETE FROM injuries WHERE league_id IS NULL;

-- Step 2: Remove duplicate injury rows (keep the most recently updated one)
DELETE FROM injuries a
USING injuries b
WHERE a.id < b.id
  AND a.player_id = b.player_id
  AND a.team_id = b.team_id
  AND a.league_id = b.league_id
  AND a.type = b.type;

-- Step 3: Make league_id NOT NULL
ALTER TABLE injuries ALTER COLUMN league_id SET NOT NULL;

-- Step 4: Drop the old unique index
DROP INDEX IF EXISTS uq_injuries_player_team_fixture_type;

-- Step 5: Create the new unique index
CREATE UNIQUE INDEX uq_injuries_player_team_league_type
  ON injuries (player_id, team_id, league_id, type);
