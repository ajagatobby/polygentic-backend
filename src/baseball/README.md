# Baseball — MLB Run-Totals (Over/Under)

Predicts MLB **total runs** (over/under) per game and surfaces **edge vs
Polymarket totals markets**. Read-only in v1 (no automated trading).

## Why this design

API-Sports baseball is shallow (no pitcher/lineup/box-score data), and the
probable starting pitcher is the #1 driver of run totals. So the model is
built on **best-available data** and an **ensemble**:

- **API-Sports** (`BaseballService`) — schedule, scores, resolution.
- **MLB StatsAPI** (`MlbStatsService`, free) — probable pitchers, lineups, weather.
- **Baseball Savant / FanGraphs** (`StatcastService`) — xERA / xwOBA true-talent.
- **The Odds API** (`BaseballMarketService`) — sharp closing total (strongest
  single predictor + CLV benchmark).

## Pipeline (`BaseballPredictionService.generatePrediction`)

```
enrich (probables/weather/market)
  → research  (Perplexity)              agents/baseball-research.agent
  → model     (NB run total, anchor)    baseball-run-model.service
  → analysis  (Claude, model-anchored)  agents/baseball-analysis.agent
  → critic    (fast model)              agents/baseball-critic.agent
  → blend     (log-pool model/agent/market) baseball-blender.service
  → calibrate (PAV isotonic per line)   baseball-calibration.service
  → persist   baseball_predictions
```

The statistical core models the **game total as Negative-Binomial** (runs are
overdispersed; Poisson underfits the tail O/U bets live in) → `P(over)` per line
with push handling on integer lines. The agent returns an adjusted *expected
total* (not a probability vector); the orchestrator converts it via the same NB.

The blender is **market-anchored**: fixed `0.5 market / 0.3 model / 0.2 agent`
until ≥150 resolved traces let it learn weights. **Edge is the residual** where
model+agent confidently disagree with the close.

## Schedules (registered in `src/trigger/schedules.ts`)

| Task | Cron | Purpose |
|---|---|---|
| `baseball-sync-games` | `0 */4 * * *` | games + sharp market totals |
| `baseball-refresh-statcast` | `30 8 * * *` | Statcast pitcher/team caches |
| `baseball-generate-predictions` | `0 9 * * *` | daily slate |
| `baseball-pre-game-refresh` | `*/30 * * * *` | late probables/weather |
| `baseball-resolve-predictions` | `20 * * * *` | results + Brier |
| `baseball-refit-models` | `0 5 * * 2` | calibration + blender refit |

## Endpoints (`/api/baseball`)

- `GET games/upcoming`, `GET games/:id`, `GET teams/map`, `GET budget`
- `GET edges?minEdge=0.03` — model-vs-Polymarket totals edges
- `POST predict/:gameId` (admin) — on-demand prediction
- `POST sync/{games,results,statcast,market}` (admin), `POST teams/seed` (admin)

## Backtest

```
npm run backtest:mlb          # score stored resolved predictions
npm run backtest:mlb replay   # re-run model over completed games (tuning)
```

CLV (beating the closing line), not raw accuracy, is the success metric.

## Known v1 limitations / tuning knobs

- NB dispersion `phi` (2.2), starter IP share (0.6), park factors — seeded;
  tune in the backtest replay.
- Handedness park splits + wind-vs-orientation vectoring reserved for v2.
- Statcast/FanGraphs endpoints are unofficial — adapters degrade gracefully
  (return `stale`/null → lower confidence) if they change.
- Team-map `apiSportsTeamId` is reconciled lazily during game sync.
