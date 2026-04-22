-- Polymarket holder snapshots
--
-- Captures the holder distribution for tracked Polymarket markets at
-- a point in time. Required for proper walk-forward backtesting of the
-- smart-money signal — the live /holders endpoint only returns CURRENT
-- positions, so without these snapshots there is no way to know what the
-- distribution looked like before a market resolved.
--
-- The cron task `snapshot-polymarket-holders` writes a row per (market,
-- snapshotAt) once per day for every unresolved market we care about.

CREATE TABLE IF NOT EXISTS polymarket_holder_snapshots (
  id              SERIAL PRIMARY KEY,
  condition_id    VARCHAR(255) NOT NULL,
  snapshot_at     TIMESTAMP NOT NULL DEFAULT now(),
  -- Full /holders payload (array of {token, holders[]}), preserved verbatim.
  payload         JSONB NOT NULL,
  -- Cached aggregate fields for fast filtering without parsing payload:
  total_holders   INTEGER NOT NULL DEFAULT 0,
  total_dollars   NUMERIC(18, 2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_holder_snapshots_condition
  ON polymarket_holder_snapshots (condition_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_pm_holder_snapshots_taken
  ON polymarket_holder_snapshots (snapshot_at DESC);
