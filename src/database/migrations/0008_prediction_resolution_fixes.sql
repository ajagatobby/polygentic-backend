-- Migration: Fix prediction resolution pipeline
--
-- 1. Add predicted_result column — locks in the predicted outcome at prediction
--    time so resolution never re-derives it (which could change if the prediction
--    logic is updated between prediction and resolution).
--
-- 2. Add prediction_status column — explicit lifecycle tracking:
--    'pending'  = match not yet played
--    'resolved' = match finished and accuracy computed
--    'void'     = match postponed/cancelled/abandoned
--
-- 3. Backfill existing rows:
--    - Resolved predictions (resolved_at IS NOT NULL) get status 'resolved'
--    - Unresolved predictions get status 'pending'
--    - predicted_result is backfilled from stored probabilities using argmax
--      (matches the old resolution logic that was in place when these were created)

-- Step 1: Add predicted_result column
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS predicted_result VARCHAR(20);

-- Step 2: Add prediction_status column with default 'pending'
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS prediction_status VARCHAR(20) NOT NULL DEFAULT 'pending';

-- Step 3: Create index on prediction_status
CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions (prediction_status);

-- Step 4: Backfill prediction_status for existing rows
UPDATE predictions
SET prediction_status = 'resolved'
WHERE resolved_at IS NOT NULL
  AND prediction_status = 'pending';

-- Step 5: Backfill predicted_result for existing resolved predictions
-- Uses simple argmax (the logic that was in place when these predictions were made)
UPDATE predictions
SET predicted_result = CASE
  WHEN draw_prob >= home_win_prob AND draw_prob >= away_win_prob THEN 'draw'
  WHEN home_win_prob >= away_win_prob THEN 'home_win'
  ELSE 'away_win'
END
WHERE predicted_result IS NULL
  AND home_win_prob IS NOT NULL;
