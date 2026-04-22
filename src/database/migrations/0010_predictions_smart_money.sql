-- Smart-money signal column on predictions
--
-- Stores the SmartMoneySignal computed at prediction time. Persisting it
-- lets us analyse the signal's value retrospectively without re-querying
-- Polymarket — and avoids any walk-forward leakage when backtesting,
-- since the value is locked in at prediction creation.

ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS smart_money_signal JSONB;
