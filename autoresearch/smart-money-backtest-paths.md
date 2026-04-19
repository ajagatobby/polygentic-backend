# Backtest paths for the smart-money signal

## The problem

`SmartMoneySignalService` reads `/holders` which returns **current** holders.
For a meaningful backtest we need to know "who held what at the time of the
prediction" — i.e. before the market resolved. Polymarket doesn't expose a
historical-holders snapshot endpoint.

Three viable paths, ordered by effort vs. fidelity.

---

## Path A — Reconstruct historical positions from `/trades` (recommended)

For each resolved market in our DB:

1. Fetch all trades for the market via `GET /trades?market={conditionId}` (paginate).
2. Aggregate trades per `proxyWallet` to compute net position at any chosen
   timestamp T (the prediction time):
   ```
   position(wallet, T) = Σ size · (+1 if BUY else −1) for trades where timestamp ≤ T
   ```
3. Take the top-N positions at T as the "holders snapshot."
4. For each holder's lifetime stats, also reconstruct from their `/positions`
   and `/closed-positions` filtered to before T (cleaner: re-query Polymarket
   per wallet, using the closed-positions endpoint which includes timestamps).

**Pros:** Honest walk-forward reconstruction. Uses only public Polymarket data.
**Cons:** O(markets × wallets) API calls. Might hit rate limits on a large backtest.
**Effort:** ~1 day to implement + ~1 day to run on the resolved-market set.

The lifetime-PnL filter ALSO needs walk-forward treatment — using a
trader's *future* PnL to decide they were sharp at prediction time is
look-ahead leakage. Calculate `lifetimePnl_T(wallet)` using only trades
before T. The `/closed-positions` payload includes `endDate`, which we can
filter on (positions resolved before T count as lifetime PnL at T).

---

## Path B — Daily snapshot collector (clean, but slow to validate)

Add a Trigger.dev cron task `snapshot-polymarket-holders` that runs every
24h and:

1. Lists every market in `polymarket_markets` that hasn't resolved yet.
2. For each, calls `getTopHolders(conditionId)` and stores the result in
   a new `polymarket_holder_snapshots` table with `(conditionId, snapshotAt,
   payload jsonb)`.

After 2–3 weeks, we'd have enough snapshots to backtest the signal against
markets that resolved in that window.

**Pros:** Trivially correct — exactly the data the signal will see in
production. No reconstruction approximations.
**Cons:** Have to wait weeks. Doesn't help today.
**Effort:** ~2h to build the task + table + storage.

---

## Path C — Forward A/B test via the live system (no backtest)

Skip backtest entirely. Wire the signal into the live ensemble (or just log
it alongside predictions without affecting them), let it accumulate data
on real fixtures, and after N resolved predictions compare:

  Brier(predictions where leanScore agreed with ensemble's pick)
  vs Brier(predictions where leanScore disagreed)

If agreement → lower Brier, the signal is real.

**Pros:** Cheapest. Tests the actual production behaviour.
**Cons:** Sample accumulates slowly. No way to tune thresholds before launch.
**Effort:** ~30 min to add a logging pipeline. Validation takes weeks.

---

## What I'd actually do

Combination: **A + B**.

- Build A first to get a one-shot retrospective signal: "If we'd had this
  signal on the 17 EPL predictions in our DB that link to Polymarket, what
  would the Brier impact have been?" Even with thin sample, this tells us
  if the signal correlates with outcomes at all.
- Add B in parallel so we accumulate clean live data going forward.
- Don't wire the signal into the production ensemble until A shows correlation
  AND B has 3+ weeks of clean snapshots to confirm.

Path C alone is too slow and too risky — wiring an unverified signal into
predictions can degrade Brier just as easily as improve it.

---

## Caveats that apply to all three paths

1. **Polymarket football-market overlap is small.** Most of our predicted
   leagues (Botola Pro, Liga Profesional Argentina, etc.) have zero
   Polymarket activity. Effective backtest sample will be EPL/Champions
   League/marquee fixtures only — maybe 30-100 predictions, not 850.
2. **Selection bias on sharps.** The leaderboard's "SPORTS" category is
   dominated by NFL/NBA/MLS traders. Football specialists are a thin sub-
   population. Per-sport leaderboards (when Polymarket exposes them) would
   help.
3. **Endogeneity remains real.** The smart-money lean IS already in the
   Polymarket price. The signal's value is in disagreement with the LLM
   ensemble or the bookmaker line, not in agreement with the market.

The signal is most useful as a **veto / confidence multiplier** on the
existing ensemble, not as a 4th independent probability source.
