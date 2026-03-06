# Basketball Module — Continuation Notes

> **Status**: Paused — waiting for API-Basketball paid plan subscription.
> **Last updated**: March 6, 2026
> **Branch**: `feat/polymarket-trading-agent`

---

## What's Done

### Schema & Database

- [x] `basketball.schema.ts` — 5 tables: `basketball_teams`, `basketball_fixtures`, `basketball_fixture_statistics`, `basketball_injuries`, `basketball_team_form`
- [x] Migration `0007_basketball_tables.sql` — written and applied to database
- [x] Schema exported from `database/schema/index.ts`

### Service Layer

- [x] `BasketballService` — full service with API-Basketball integration
- [x] Daily rate limiter (`API_BASKETBALL_DAILY_LIMIT` env var, default 100)
- [x] `getRemainingRequests()` method for budget observability
- [x] Sync methods: `syncFixtures()`, `syncCompletedFixtures()`, `syncStandings()`
- [x] Query methods: `getFixtures()`, `getTodayFixtures()`, `getFixtureById()`, `getTeamById()`, `getTrackedLeagues()`, `getTeamMatchHistory()`
- [x] `fetchLiveGames()` — fetches today's games per league and filters by live statuses

### Controller (REST API at `/api/basketball/*`)

- [x] `GET /fixtures` — paginated list with filters
- [x] `GET /fixtures/today` — today's games
- [x] `GET /fixtures/upcoming` — upcoming games
- [x] `GET /fixtures/live` — live games
- [x] `GET /fixtures/:id` — game detail with stats
- [x] `GET /teams/:id` — team with form data
- [x] `GET /teams/:id/history` — match history with W/L results
- [x] `GET /leagues` — tracked leagues with fixture counts
- [x] `GET /api-budget` — remaining daily API requests
- [x] `POST /fixtures/sync` — admin manual sync (empty body = all leagues)
- [x] `POST /fixtures/live/start` — admin start live monitoring
- [x] `POST /fixtures/live/stop` — admin stop live monitoring

### Live Score System

- [x] `BasketballLiveScoreService` — polling + change detection
- [x] `BasketballLiveScoreGateway` — WebSocket at `/basketball-live`
- [x] `BasketballLiveEventHandler` — persists live score updates to DB
- [x] Live monitoring disabled by default (`BASKETBALL_LIVE_MONITORING_ENABLED=false`)

### Trigger.dev Tasks

- [x] `sync-basketball-fixtures` — every 12 hours
- [x] `sync-basketball-completed-fixtures` — once per day
- [x] `sync-basketball-standings` — once per day
- [x] Budget-aware: tasks check remaining daily requests before running

### Module Wiring

- [x] `BasketballModule` created and registered in `AppModule`
- [x] `BasketballService` added to `trigger/init.ts` for Trigger.dev tasks
- [x] Basketball schedules added to `trigger/schedules.ts`

### Tracked Leagues (10 total)

| League                      | API ID |
| --------------------------- | ------ |
| NBA                         | 12     |
| NCAAB                       | 116    |
| KBL (Korea)                 | 88     |
| Liga Endesa (Spain)         | 117    |
| LNB Pro A (France)          | 57     |
| Serie A (Italy)             | 82     |
| Basketball Champions League | 138    |
| Euroleague                  | 120    |
| NBL (Australia)             | 19     |
| Pro A (Germany)             | 40     |

---

## What's Broken / Needs Fixing

### 1. Season Format (CRITICAL)

**File**: `src/basketball/basketball.service.ts` — `getCurrentSeason()` method

API-Basketball expects season as a **string** like `"2025-2026"` for cross-year leagues (NBA, Euroleague, etc.), but our code sends the integer `2025`.

**Current behavior**:

```typescript
static getCurrentSeason(): number {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}
```

**What needs to change**:

- Return `"2025-2026"` format for cross-year leagues
- Some leagues (summer leagues) may use single-year `"2026"` format
- Need to check which of our 10 tracked leagues use which format
- Test with: `curl -H "x-apisports-key: KEY" "https://v1.basketball.api-sports.io/leagues?id=12"` to see season format

### 2. Free Plan Season Restriction

API-Basketball free plan only allows seasons **2022-2024**. The error:

```json
{
  "errors": {
    "plan": "Free plans do not have access to this season, try from 2022 to 2024."
  }
}
```

**Once subscribed**: just need to fix the season format (item 1) and it should work.

### 3. League ID Verification

The league IDs in `TRACKED_BASKETBALL_LEAGUES` were set based on known API-Basketball IDs but haven't been verified against the live API. After subscribing, run:

```bash
curl -H "x-apisports-key: KEY" "https://v1.basketball.api-sports.io/leagues"
```

And confirm all 10 league IDs are correct.

---

## Env Vars to Set After Subscribing

```env
# Update these after subscribing to paid plan:
API_BASKETBALL_KEY=your_key_here
API_BASKETBALL_DAILY_LIMIT=7500              # Mega plan = 7500, adjust to your plan
BASKETBALL_LIVE_MONITORING_ENABLED=true       # Enable live score polling

# Optional tuning:
# API_BASKETBALL_BASE_URL=https://v1.basketball.api-sports.io  (default)
# BASKETBALL_LIVE_POLLING_INTERVAL_MS=30000                     (default 30s)
# BASKETBALL_LIVE_OT_POLLING_MS=15000                           (default 15s)
```

---

## Steps to Continue After Subscribing

1. **Set env vars** — update `API_BASKETBALL_DAILY_LIMIT` and optionally enable live monitoring
2. **Verify league IDs** — `curl` the `/leagues` endpoint and confirm all 10 IDs
3. **Fix `getCurrentSeason()`** — return `"YYYY-YYYY"` string format instead of integer
4. **Update season type in schema/service** — the `season` column is `integer`, may need to also store the string format in `leagueSeason`
5. **Test sync** — `POST /api/basketball/fixtures/sync` with empty body
6. **Increase schedule frequency** — with more API budget, sync can run more often (every 2-4 hours instead of 12)
7. **Enable live monitoring** — set `BASKETBALL_LIVE_MONITORING_ENABLED=true`

---

## Files Reference

| File                                                 | Description                                   |
| ---------------------------------------------------- | --------------------------------------------- |
| `src/database/schema/basketball.schema.ts`           | Drizzle schema for all basketball tables      |
| `src/database/migrations/0007_basketball_tables.sql` | SQL migration (already applied)               |
| `src/basketball/basketball.service.ts`               | Core service — API integration, sync, queries |
| `src/basketball/basketball.controller.ts`            | REST API endpoints                            |
| `src/basketball/basketball.module.ts`                | NestJS module                                 |
| `src/basketball/dto/fixture-query.dto.ts`            | DTOs and basketball status enums              |
| `src/basketball/live/live-score.service.ts`          | Live game polling and change detection        |
| `src/basketball/live/live-score.gateway.ts`          | WebSocket gateway                             |
| `src/basketball/live/live-event-handler.ts`          | DB persistence for live events                |
| `src/trigger/basketball-sync-data.ts`                | Trigger.dev sync tasks                        |
| `src/trigger/schedules.ts`                           | Cron schedules (basketball section at bottom) |
| `src/trigger/init.ts`                                | Trigger.dev service initialization            |
