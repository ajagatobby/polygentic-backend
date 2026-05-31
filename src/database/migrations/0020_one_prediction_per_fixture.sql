-- Collapse to ONE prediction per fixture.
--
-- Previously predictions were unique per (fixture_id, prediction_type), so a
-- `daily` run and an `on_demand` run produced two rows for the same fixture.
-- We now keep a single row per fixture: the newest run overwrites the existing
-- row in place (storePrediction upserts on fixture_id, preserving the id so FK
-- references stay valid).
--
-- This migration de-duplicates existing data, then swaps the unique index.
-- Must run inside a single transaction (uses a temp mapping table).

-- 1. For every prediction, map it to the id we KEEP for its fixture (the most
--    recent one; tie-break on highest id).
CREATE TEMP TABLE _pred_keep ON COMMIT DROP AS
SELECT
  p.id AS old_id,
  FIRST_VALUE(p.id) OVER (
    PARTITION BY p.fixture_id
    ORDER BY p.created_at DESC, p.id DESC
  ) AS keep_id
FROM predictions p;

-- 2. Re-point FK references from the duplicates to the kept row.
UPDATE alerts a
  SET prediction_id = k.keep_id
  FROM _pred_keep k
  WHERE a.prediction_id = k.old_id AND k.old_id <> k.keep_id;

UPDATE polymarket_trades t
  SET prediction_id = k.keep_id
  FROM _pred_keep k
  WHERE t.prediction_id = k.old_id AND k.old_id <> k.keep_id;

UPDATE prediction_tests pt
  SET baseline_prediction_id = k.keep_id
  FROM _pred_keep k
  WHERE pt.baseline_prediction_id = k.old_id AND k.old_id <> k.keep_id;

UPDATE prediction_tests pt
  SET retest_prediction_id = k.keep_id
  FROM _pred_keep k
  WHERE pt.retest_prediction_id = k.old_id AND k.old_id <> k.keep_id;

-- 3. Delete the duplicate (older) predictions.
DELETE FROM predictions p
  USING _pred_keep k
  WHERE p.id = k.old_id AND k.old_id <> k.keep_id;

-- 4. Swap the unique index: fixture_id only.
DROP INDEX IF EXISTS uq_predictions_fixture_type;
CREATE UNIQUE INDEX IF NOT EXISTS uq_predictions_fixture ON predictions (fixture_id);
