# Scheduled Jobs & Cron Tasks

All recurring jobs running in the Polygentic backend, organized by execution environment.

## Overview

The system uses three scheduling mechanisms:

| Type                 | Where it runs                       | Retry / Durability                         | Visibility                                  |
| -------------------- | ----------------------------------- | ------------------------------------------ | ------------------------------------------- |
| **NestJS @Cron**     | In-process (same Node.js server)    | None — fails silently, retries next cycle  | Server logs only                            |
| **Trigger.dev**      | Cloud (external worker)             | Automatic retries with exponential backoff | Dashboard with run history, traces, replays |
| **In-memory timers** | In-process (setTimeout/setInterval) | None — lost on server restart              | Server logs only                            |

---

## NestJS Cron Jobs (Data Sync)

Lightweight, idempotent data sync operations. Each has a re-entrancy guard to prevent overlapping runs.

**File:** `src/sync/sync.scheduler.ts`

| Schedule         | Job               | What It Does                                                                                                                                      |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every 30 minutes | `syncFixtures()`  | Fetches upcoming fixtures from API-Football for all 30 tracked leagues and upserts them into the `fixtures` table. Keeps match schedules current. |
| Every 2 hours    | `syncInjuries()`  | Fetches player injury and suspension data for all tracked leagues. Used by the prediction pipeline to assess squad availability.                  |
| Every 2 hours    | `syncStandings()` | Fetches league tables, team form strings, home/away records, and goal averages. Core data for prediction analysis.                                |
| Every 6 hours    | `syncOdds()`      | Fetches bookmaker odds from The Odds API. Computes consensus odds across bookmakers. Used for value bet detection in predictions.                 |

### Cron Expressions

```
*/30 * * * *    Fixtures      :00, :30 of every hour
0 */2 * * *     Injuries      00:00, 02:00, 04:00, ...
0 */2 * * *     Standings     00:00, 02:00, 04:00, ...
0 */6 * * *     Odds          00:00, 06:00, 12:00, 18:00
```

---

## Trigger.dev Scheduled Tasks (Prediction Pipeline)

Long-running, failure-prone workloads with durable execution. Each task has automatic retries and is observable in the Trigger.dev dashboard.

**File:** `src/trigger/schedules.ts`

| Schedule             | Task ID                           | What It Does                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daily at 6:00 AM UTC | `scheduled-daily-predictions`     | Queries all fixtures in the next 48 hours, fans out individual prediction tasks (data collection -> Perplexity research -> Claude analysis) via `batchTriggerAndWait`. Skips fixtures that already have a `daily` prediction.                                      |
| Every 15 minutes     | `scheduled-pre-match-predictions` | Generates `pre_match` predictions for fixtures kicking off within 1 hour. Captures the most recent data (latest odds, injuries, form) before a match starts.                                                                                                       |
| Every 5 minutes      | `scheduled-lineup-prediction`     | Checks fixtures within 90 minutes for newly published confirmed lineups. If a `pre_match` prediction was made without lineups, re-runs the full pipeline and upserts the prediction with the confirmed starting XI and formation.                                  |
| Every hour           | `scheduled-sync-and-resolve`      | Two-step workflow: (1) syncs recently completed fixtures from API-Football (last 2 days) to update status to FT with final scores, then (2) resolves all unresolved predictions — computing `actualResult`, `wasCorrect`, and Brier score (`probabilityAccuracy`). |

### Cron Expressions

```
0 6 * * *       Daily predictions      06:00 UTC
*/15 * * * *    Pre-match predictions   :00, :15, :30, :45
*/5 * * * *     Lineup predictions      :00, :05, :10, :15, :20, ...
0 * * * *       Sync + resolve          :00 of every hour
```

### Trigger.dev Task Dependency Graph

```
scheduled-daily-predictions
  └─> generate-daily-predictions
        └─> generate-prediction (×N, one per fixture)

scheduled-pre-match-predictions
  └─> generate-pre-match-predictions
        └─> generate-prediction (×N)

scheduled-lineup-prediction
  └─> lineup-aware-prediction
        └─> generate-prediction (×N, only fixtures with new lineups)

scheduled-sync-and-resolve
  └─> sync-completed-fixtures-and-resolve
        ├─> Step 1: syncCompletedFixtures()
        └─> Step 2: resolvePredictions()
```

---

## Live Monitoring Timers

In-memory polling and broadcasting for real-time match tracking. Auto-starts on server boot.

### Live Score Polling (Adaptive)

**File:** `src/football/live/live-score.service.ts`

Uses a recursive `setTimeout` loop that adapts its interval based on match state:

| Condition                     | Interval   | Env Variable               |
| ----------------------------- | ---------- | -------------------------- |
| Normal (any match in play)    | 30 seconds | `LIVE_POLLING_INTERVAL_MS` |
| All matches at halftime       | 60 seconds | `LIVE_HALFTIME_POLLING_MS` |
| Any match in penalty shootout | 15 seconds | `LIVE_PENALTY_POLLING_MS`  |

Each poll:

1. Calls `GET /fixtures?live=all` on API-Football
2. Filters to tracked leagues only
3. Diffs against previous state to detect events (goals, red cards, match start/end, status changes)
4. Emits detected events to the `LiveEventHandler` and `LiveScoreGateway`

### WebSocket Broadcast

**File:** `src/football/live/live-score.gateway.ts`

| Interval         | What It Does                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every 30 seconds | Broadcasts a full snapshot of all active matches to every connected WebSocket client on the `/live` namespace. Skips if no clients are connected. |

---

## Event-Driven Jobs (Not Scheduled)

These are triggered by live match events, not by cron schedules.

**File:** `src/football/live/live-event-handler.ts`

| Trigger                                   | Action                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Match ends** (detected by live polling) | Persists final score to DB immediately, triggers Trigger.dev `sync-completed-fixtures-and-resolve` task for instant prediction resolution, creates `live_event` alert |
| **Goal scored**                           | Updates score in DB, creates `live_event` alert                                                                                                                       |
| **Red card shown**                        | Creates `live_event` alert                                                                                                                                            |
| **Match starts**                          | Updates fixture status to `1H` in DB                                                                                                                                  |
| **Status change** (HT, 2H, ET, P)         | Updates fixture status in DB                                                                                                                                          |

---

## Timeline: What Happens for a Typical Match

```
T-48h    [6 AM daily cron]     daily prediction generated (without lineups)
T-24h    [standings cron]      league tables refreshed
T-2h     [injuries cron]       latest injury data synced
T-1h     [pre-match cron]      pre_match prediction generated
T-55min  [lineup cron]         lineups detected → prediction re-generated with confirmed XI
T-0      [live polling]        match-start event → fixture status updated to 1H
T+25'    [live polling]        goal event → score updated in DB, alert created
T+45'    [live polling]        status-change → HT, polling slows to 60s
T+46'    [live polling]        status-change → 2H, polling returns to 30s
T+90'    [live polling]        match-end → final score persisted, immediate resolution triggered
T+90'    [Trigger.dev task]    predictions resolved (wasCorrect, Brier score, actualResult)
T+1h     [hourly cron]         backup resolution for any matches missed by live monitoring
```

---

## API Budget Considerations

| API              | Rate                            | Daily Budget                  | Used By                                                  |
| ---------------- | ------------------------------- | ----------------------------- | -------------------------------------------------------- |
| API-Football     | ~30s per request (rate limited) | 7,500 requests/day (Pro plan) | Fixture sync, standings, injuries, live polling, lineups |
| The Odds API     | Credit-based                    | 20,000 credits/month          | Odds sync                                                |
| Perplexity Sonar | Per-request                     | Unlimited (paid)              | Research agent (prediction pipeline)                     |
| Anthropic Claude | Per-token                       | Unlimited (paid)              | Analysis agent (prediction pipeline)                     |

### Estimated Daily API-Football Usage

| Job                         | Calls per Run | Runs per Day       | Daily Total |
| --------------------------- | ------------- | ------------------ | ----------- |
| Fixture sync (30 leagues)   | 30            | 48                 | 1,440       |
| Standings sync (30 leagues) | 30            | 12                 | 360         |
| Injuries sync (30 leagues)  | 30            | 12                 | 360         |
| Live polling                | 1             | ~2,880 (every 30s) | 2,880       |
| Lineup checks               | 1-10          | ~288 (every 5 min) | ~500        |
| Completed fixture sync      | 30            | 24                 | 720         |
| **Total estimate**          |               |                    | **~6,260**  |

This is within the 7,500/day Pro plan limit but leaves limited headroom. The live polling (2,880 calls/day) is the largest consumer.
