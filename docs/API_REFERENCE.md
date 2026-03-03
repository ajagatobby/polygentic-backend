# Polygentic API Reference

**Base URL:** `http://localhost:8080`
**Swagger UI:** `http://localhost:8080/api/docs`

All endpoints are prefixed with `/api`. No authentication is currently required.

---

## Table of Contents

- [Health](#health)
- [Football (Fixtures, Teams, Leagues)](#football)
- [Predictions](#predictions)
- [Lineups](#lineups)
- [Odds (Bookmaker Odds & Consensus)](#odds)
- [Alerts](#alerts)
- [Live Scores (REST + WebSocket)](#live-scores)

---

## Health

### `GET /api/health`

System health check. Returns database connectivity, record counts, uptime, and last sync timestamps.

**Response `200`**

```json
{
  "status": "ok",
  "timestamp": "2026-03-02T08:19:00.727Z",
  "uptime_seconds": 11,
  "database": "connected",
  "counts": {
    "fixtures": 2850,
    "predictions": 180,
    "alerts": 45
  },
  "last_syncs": {
    "api_football_sync_fixtures": {
      "status": "success",
      "startedAt": "2026-03-02T08:00:00.000Z",
      "completedAt": "2026-03-02T08:01:45.000Z",
      "durationMs": 105000
    }
  }
}
```

---

## Football

Football fixtures, teams, and leagues sourced from API-Football.

### `GET /api/fixtures`

Paginated list of fixtures with rich filtering.

**Query Parameters**

| Parameter    | Type    | Default | Description                                                                                                   |
| ------------ | ------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `page`       | integer | `1`     | Page number (1-indexed)                                                                                       |
| `limit`      | integer | `20`    | Items per page (max 100)                                                                                      |
| `search`     | string  | —       | Search across league names and team names (case-insensitive, partial match). Example: `"premier"`, `"madrid"` |
| `leagueId`   | integer | —       | Filter by API-Football league ID                                                                              |
| `leagueName` | string  | —       | Filter by league name (case-insensitive, partial match). Example: `"la liga"`                                 |
| `club`       | string  | —       | Filter by club/team name (case-insensitive, partial match). Matches home or away team. Example: `"barcelona"` |
| `date`       | string  | —       | Filter by date (`YYYY-MM-DD`)                                                                                 |
| `status`     | string  | —       | Filter by exact fixture status code (see status table below)                                                  |
| `state`      | string  | —       | Filter by match state group: `upcoming`, `live`, `finished`, `cancelled`                                      |
| `teamId`     | integer | —       | Filter by team ID (home or away)                                                                              |
| `season`     | integer | —       | Filter by season year                                                                                         |

**Match State Groups**

| State       | Includes Statuses                | Description                   |
| ----------- | -------------------------------- | ----------------------------- |
| `upcoming`  | NS, TBD                          | Not yet started               |
| `live`      | 1H, HT, 2H, ET, BT, P, SUSP, INT | Currently in play             |
| `finished`  | FT, AET, PEN                     | Completed                     |
| `cancelled` | PST, CANC, ABD, WO, AWD          | Postponed/cancelled/abandoned |

**Fixture Status Values**

| Code   | Meaning                   |
| ------ | ------------------------- |
| `NS`   | Not Started               |
| `1H`   | First Half                |
| `HT`   | Halftime                  |
| `2H`   | Second Half               |
| `ET`   | Extra Time                |
| `P`    | Penalty Shootout          |
| `FT`   | Finished                  |
| `AET`  | Finished After Extra Time |
| `PEN`  | Finished After Penalties  |
| `PST`  | Postponed                 |
| `CANC` | Cancelled                 |
| `ABD`  | Abandoned                 |
| `SUSP` | Suspended                 |
| `INT`  | Interrupted               |
| `TBD`  | To Be Determined          |
| `WO`   | Walk Over                 |
| `AWD`  | Technical Loss            |
| `BT`   | Break Time                |

**Response `200`**

```json
{
  "data": [
    {
      "id": 1035012,
      "leagueId": 39,
      "leagueName": "Premier League",
      "leagueCountry": "England",
      "season": 2025,
      "round": "Regular Season - 28",
      "homeTeamId": 33,
      "awayTeamId": 42,
      "date": "2026-03-15",
      "timestamp": 1742050800,
      "venueName": "Old Trafford",
      "venueCity": "Manchester",
      "referee": "Michael Oliver",
      "status": "NS",
      "statusLong": "Not Started",
      "elapsed": null,
      "goalsHome": null,
      "goalsAway": null
    }
  ],
  "total": 2850,
  "page": 1,
  "limit": 20
}
```

---

### `GET /api/fixtures/today`

Get today's fixtures enriched with AI predictions and team details. Useful for the main "today's matches" view.

**Query Parameters**

| Parameter  | Type    | Default | Description                                                               |
| ---------- | ------- | ------- | ------------------------------------------------------------------------- |
| `leagueId` | integer | —       | Filter by league ID                                                       |
| `status`   | string  | —       | Filter by fixture status code                                             |
| `state`    | string  | —       | Filter by match state group (`upcoming`, `live`, `finished`, `cancelled`) |

**Response `200`**

```json
{
  "data": [
    {
      "fixture": {
        "id": 1035012,
        "leagueId": 39,
        "leagueName": "Premier League",
        "status": "NS",
        "date": "2026-03-15T15:00:00Z"
      },
      "homeTeam": {
        "id": 33,
        "name": "Manchester United",
        "logo": "https://media.api-sports.io/football/teams/33.png"
      },
      "awayTeam": {
        "id": 42,
        "name": "Arsenal",
        "logo": "https://media.api-sports.io/football/teams/42.png"
      },
      "prediction": {
        "homeWinProb": "0.3200",
        "drawProb": "0.2800",
        "awayWinProb": "0.4000",
        "confidence": 7,
        "predictionType": "pre_match",
        "homeTeamName": "Manchester United",
        "awayTeamName": "Arsenal"
      }
    }
  ],
  "count": 12,
  "date": "2026-03-15"
}
```

---

### `GET /api/fixtures/:id`

Get full fixture detail including statistics, events, injuries, lineups, and API-Football predictions.

**Path Parameters**

| Parameter | Type    | Description             |
| --------- | ------- | ----------------------- |
| `id`      | integer | API-Football fixture ID |

**Response `200`**

```json
{
  "fixture": {
    "id": 1035012,
    "leagueId": 39,
    "leagueName": "Premier League",
    "homeTeamId": 33,
    "awayTeamId": 42,
    "date": "2026-03-15",
    "status": "NS",
    "goalsHome": null,
    "goalsAway": null
  },
  "statistics": [...],
  "events": [...],
  "injuries": [...],
  "lineups": [...],
  "prediction": { ... }
}
```

---

### `GET /api/fixtures/:id/prediction`

Get a fixture with its AI prediction and team details. Returns the prediction generated by the 3-agent pipeline (DataCollector -> Perplexity -> Claude).

**Path Parameters**

| Parameter | Type    | Description             |
| --------- | ------- | ----------------------- |
| `id`      | integer | API-Football fixture ID |

**Response `200`**

```json
{
  "fixture": {
    "id": 1035012,
    "leagueName": "Premier League",
    "status": "NS",
    "date": "2026-03-15T15:00:00Z"
  },
  "homeTeam": {
    "id": 33,
    "name": "Manchester United",
    "logo": "https://..."
  },
  "awayTeam": {
    "id": 42,
    "name": "Arsenal",
    "logo": "https://..."
  },
  "prediction": {
    "id": 42,
    "homeWinProb": "0.3200",
    "drawProb": "0.2800",
    "awayWinProb": "0.4000",
    "predictedHomeGoals": "1.2",
    "predictedAwayGoals": "1.8",
    "confidence": 7,
    "predictionType": "pre_match",
    "keyFactors": [...],
    "riskFactors": [...],
    "valueBets": [...],
    "detailedAnalysis": "Arsenal are in excellent form...",
    "homeTeamName": "Manchester United",
    "awayTeamName": "Arsenal"
  }
}
```

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "Fixture 9999999 not found"
}
```

---

### `GET /api/fixtures/:id/lineups`

Get confirmed lineups for a fixture. Reads from DB first (persisted by the lineup-prediction task ~60min before kickoff). Falls back to a live API-Football fetch if not yet persisted.

**Path Parameters**

| Parameter | Type    | Description             |
| --------- | ------- | ----------------------- |
| `id`      | integer | API-Football fixture ID |

**Response `200`**

```json
{
  "fixtureId": 1035012,
  "lineups": [
    {
      "teamId": 42,
      "teamName": "Arsenal",
      "teamLogo": "https://...",
      "formation": "4-3-3",
      "coachName": "M. Arteta",
      "coachPhoto": "https://...",
      "startXI": [
        {
          "id": 882,
          "name": "D. Raya",
          "number": 22,
          "pos": "G",
          "grid": "1:1"
        },
        {
          "id": 1100,
          "name": "B. Saka",
          "number": 7,
          "pos": "F",
          "grid": "1:4"
        }
      ],
      "substitutes": [
        {
          "id": 900,
          "name": "K. Havertz",
          "number": 29,
          "pos": "F",
          "grid": null
        }
      ],
      "teamColors": {
        "player": {
          "primary": "#FF0000",
          "number": "#FFFFFF",
          "border": "#000000"
        },
        "goalkeeper": {
          "primary": "#00FF00",
          "number": "#000000",
          "border": "#FFFFFF"
        }
      }
    }
  ],
  "source": "database"
}
```

| Field    | Type                  | Description                                                                   |
| -------- | --------------------- | ----------------------------------------------------------------------------- |
| `source` | `"database" \| "api"` | `database` if lineups were persisted, `api` if fetched live from API-Football |

---

### `GET /api/teams/:id`

Get team details with current form data.

**Path Parameters**

| Parameter | Type    | Description          |
| --------- | ------- | -------------------- |
| `id`      | integer | API-Football team ID |

**Response `200`**

```json
{
  "team": {
    "id": 33,
    "name": "Manchester United",
    "shortName": "Man Utd",
    "logo": "https://media.api-sports.io/football/teams/33.png",
    "country": "England",
    "founded": 1878,
    "venueName": "Old Trafford",
    "venueCapacity": 76212
  },
  "form": [
    {
      "leagueId": 39,
      "season": 2025,
      "formString": "WWDLW",
      "last5Wins": 3,
      "last5Draws": 1,
      "last5Losses": 1,
      "last5GoalsFor": 8,
      "last5GoalsAgainst": 4,
      "homeWins": 8,
      "homeDraws": 3,
      "homeLosses": 2,
      "awayWins": 5,
      "awayDraws": 4,
      "awayLosses": 4,
      "goalsForAvg": 1.65,
      "goalsAgainstAvg": 0.92,
      "cleanSheets": 9,
      "failedToScore": 3,
      "attackRating": 72,
      "defenseRating": 68,
      "leaguePosition": 5,
      "points": 48
    }
  ]
}
```

---

### `GET /api/teams/:id/history`

Get a team's completed match history with results and per-match statistics. Designed for frontend graph data (goals over time, form charts, xG trends).

**Path Parameters**

| Parameter | Type    | Description          |
| --------- | ------- | -------------------- |
| `id`      | integer | API-Football team ID |

**Query Parameters**

| Parameter  | Type    | Default | Description               |
| ---------- | ------- | ------- | ------------------------- |
| `leagueId` | integer | —       | Filter by league ID       |
| `limit`    | integer | `20`    | Items per page (max 100)  |
| `offset`   | integer | `0`     | Number of records to skip |

**Response `200`**

```json
{
  "team": {
    "id": 33,
    "name": "Manchester United"
  },
  "matches": [
    {
      "fixtureId": 1035012,
      "leagueId": 39,
      "leagueName": "Premier League",
      "date": "2026-03-08T15:00:00Z",
      "homeTeamId": 33,
      "awayTeamId": 42,
      "goalsHome": 2,
      "goalsAway": 1,
      "status": "FT",
      "result": "W",
      "stats": {
        "expectedGoals": 1.85,
        "shotsOnGoal": 6,
        "totalShots": 14,
        "possession": 52.0
      }
    }
  ],
  "total": 38
}
```

| Field    | Type                | Description                                                                 |
| -------- | ------------------- | --------------------------------------------------------------------------- |
| `result` | `"W" \| "D" \| "L"` | Win/Draw/Loss from the perspective of the requested team                    |
| `stats`  | object              | Per-match statistics (xG, shots, possession). Null if stats not yet synced. |

---

### `GET /api/leagues`

Get all tracked leagues with current season info.

**Query Parameters**

| Parameter | Type    | Default | Description                        |
| --------- | ------- | ------- | ---------------------------------- |
| `country` | string  | —       | Filter by country name             |
| `current` | boolean | `true`  | Only show currently active leagues |

**Response `200`**

```json
{
  "data": [
    {
      "league": {
        "id": 39,
        "name": "Premier League",
        "type": "League",
        "logo": "https://..."
      },
      "country": {
        "name": "England",
        "code": "GB",
        "flag": "https://..."
      },
      "seasons": [
        {
          "year": 2025,
          "start": "2025-08-16",
          "end": "2026-05-24",
          "current": true
        }
      ]
    }
  ],
  "count": 30,
  "trackedIds": [
    39, 140, 141, 135, 78, 61, 88, 94, 307, 2, 3, 848, 253, 262, 71, 128, 45,
    143, 81, 1, 15, 4, 6, 9, 29, 5, 13, 32, 34, 36
  ]
}
```

**Tracked Leagues (30 total)**

| Category    | IDs                                    | Leagues                                                                                            |
| ----------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Domestic    | 39, 140, 141, 135, 78, 61, 88, 94, 307 | EPL, La Liga, La Liga 2, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira Liga, Saudi Pro League |
| Europe      | 2, 3, 848                              | UCL, UEL, UECL                                                                                     |
| Americas    | 253, 262, 71, 128                      | MLS, Liga MX, Brasileirao, Argentina Liga                                                          |
| Cups        | 45, 143, 81                            | FA Cup, Copa del Rey, DFB Pokal                                                                    |
| Tournaments | 1, 15, 4, 6, 9, 29, 5, 13              | World Cup, Club World Cup, Euros, AFCON, Copa America, AFC Asian Cup, Nations League, Gold Cup     |
| Qualifiers  | 32, 34, 36                             | WCQ Europe, WCQ South America, WCQ Africa                                                          |

---

### `POST /api/fixtures/sync`

Manually trigger a fixture and standings sync from API-Football.

**Request Body**

```json
{
  "leagueIds": [39, 140, 135]
}
```

| Field       | Type      | Required | Description                                            |
| ----------- | --------- | -------- | ------------------------------------------------------ |
| `leagueIds` | integer[] | No       | League IDs to sync. Defaults to all 30 tracked leagues |

**Response `200`**

```json
{
  "success": true,
  "fixturesSynced": 150,
  "standingsSynced": 60,
  "leaguesProcessed": 3
}
```

> **Note:** The `season` parameter was removed. Season is now auto-detected per league using `FootballService.getCurrentSeason()` and `getSeasonsForLeague()`, which correctly handles calendar-year leagues (MLS, Liga MX, Brasileirao, Argentina Liga).

---

## Predictions

AI-generated match predictions using the 3-agent pipeline (DataCollector -> Perplexity research -> Claude analysis).

### `GET /api/predictions`

Get predictions sorted by confidence score (highest first).

**Query Parameters**

| Parameter        | Type    | Default | Description                                       |
| ---------------- | ------- | ------- | ------------------------------------------------- |
| `page`           | integer | `1`     | Page number                                       |
| `limit`          | integer | `20`    | Items per page (max 100)                          |
| `predictionType` | string  | —       | Filter by type: `daily`, `pre_match`, `on_demand` |
| `minConfidence`  | integer | —       | Minimum confidence score (1-10)                   |
| `resolved`       | boolean | —       | Filter by resolution status                       |

**Response `200`**

```json
{
  "data": [
    {
      "id": 42,
      "fixtureId": 1035012,
      "homeTeamId": 33,
      "awayTeamId": 42,
      "homeWinProb": "0.3200",
      "drawProb": "0.2800",
      "awayWinProb": "0.4000",
      "predictedHomeGoals": "1.2",
      "predictedAwayGoals": "1.8",
      "confidence": 7,
      "predictionType": "pre_match",
      "keyFactors": [
        "Arsenal's dominant away form (W7 D2 L1 in last 10 away)",
        "Manchester United missing key midfielder Bruno Fernandes"
      ],
      "riskFactors": [
        "Old Trafford fortress record this season",
        "Arsenal fixture congestion from Champions League"
      ],
      "valueBets": [{ "market": "Away Win", "odds": 2.8, "edge": "12%" }],
      "detailedAnalysis": "Arsenal enter this match in outstanding form...",
      "modelVersion": "v1.0",
      "actualResult": null,
      "wasCorrect": null,
      "probabilityAccuracy": null,
      "resolvedAt": null,
      "homeTeamName": "Manchester United",
      "awayTeamName": "Arsenal",
      "createdAt": "2026-03-15T06:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20
}
```

**Prediction Types**

| Type        | When Generated    | Description                                                      |
| ----------- | ----------------- | ---------------------------------------------------------------- |
| `daily`     | 6:00 AM UTC daily | Predictions for fixtures in the next 48 hours                    |
| `pre_match` | Every 15 minutes  | Predictions for fixtures kicking off within 1 hour (latest data) |
| `on_demand` | Manual trigger    | On-demand prediction for a specific fixture                      |

**Confidence Scale (1-10)**

| Score | Label     | Description                                        |
| ----- | --------- | -------------------------------------------------- |
| 9-10  | Very High | Strong prediction, high-confidence alert generated |
| 7-8   | High      | Good prediction, high-confidence alert generated   |
| 5-6   | Medium    | Moderate confidence                                |
| 3-4   | Low       | Weak signals                                       |
| 1-2   | Very Low  | Insufficient data                                  |

**Resolution Fields (populated after match completes)**

| Field                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `actualResult`        | `home_win`, `draw`, or `away_win`                                                               |
| `wasCorrect`          | Whether the predicted highest-probability outcome matched the actual result                     |
| `probabilityAccuracy` | Brier score (0 = perfect, 2 = worst). Calculated as `sum((prob - actual)^2)` for all 3 outcomes |
| `resolvedAt`          | Timestamp when the prediction was resolved                                                      |

---

### `GET /api/predictions/accuracy`

Get prediction accuracy statistics across all resolved predictions.

**Response `200`**

```json
{
  "totalResolved": 120,
  "totalCorrect": 72,
  "accuracy": 0.6,
  "avgBrierScore": 0.42,
  "byType": {
    "daily": { "total": 80, "correct": 46, "accuracy": 0.575 },
    "pre_match": { "total": 40, "correct": 26, "accuracy": 0.65 }
  }
}
```

---

## Live Scores

Real-time live match monitoring and control.

### `POST /api/fixtures/live/start`

Start the live match monitoring system. Begins adaptive polling of API-Football for live matches across tracked leagues.

**Request Body:** None

**Response `200`**

```json
{
  "message": "Live monitoring started",
  "activeMatches": 3
}
```

---

### `POST /api/fixtures/live/stop`

Stop the live match monitoring system.

**Request Body:** None

**Response `200`**

```json
{
  "message": "Live monitoring stopped"
}
```

---

### `GET /api/fixtures/live`

Get currently live matches. Returns data from the local live monitor if active, otherwise falls back to a direct API-Football call. Only includes tracked leagues.

**Response `200`**

```json
{
  "data": [
    {
      "fixtureId": 1035012,
      "homeTeam": "Manchester United",
      "awayTeam": "Arsenal",
      "homeGoals": 1,
      "awayGoals": 0,
      "status": "2H",
      "elapsed": 67,
      "leagueId": 39,
      "leagueName": "Premier League"
    }
  ],
  "count": 1,
  "source": "live-monitor"
}
```

| Field    | Type                      | Description                                                                            |
| -------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `source` | `"live-monitor" \| "api"` | `live-monitor` if local polling is active, `api` if fetched directly from API-Football |

---

### WebSocket (Socket.IO)

Real-time live score updates via WebSocket.

**Namespace:** `/live`
**URL:** `ws://localhost:8080/live`

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:8080/live');

socket.on('connect', () => {
  console.log('Connected to live scores');
});
```

On connect, the server immediately sends the current state of all active matches.

**Events (Server -> Client)**

| Event          | Payload              | Description                                                            |
| -------------- | -------------------- | ---------------------------------------------------------------------- |
| `match-update` | `LiveFixtureState[]` | Full state of all active matches. Sent on connect and every 30 seconds |
| `goal`         | `DetectedEvent`      | A goal was scored                                                      |
| `red-card`     | `DetectedEvent`      | Red card or second yellow issued                                       |
| `match-start`  | `DetectedEvent`      | Match kicked off                                                       |
| `match-end`    | `DetectedEvent`      | Match finished (FT, AET, or PEN)                                       |

**Payload: `LiveFixtureState`**

```typescript
{
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  status: string; // "1H", "HT", "2H", "ET", "P", "FT"
  elapsed: number;
  leagueId: number;
  leagueName: string;
}
```

**Payload: `DetectedEvent`**

```typescript
{
  type: "goal" | "red-card" | "match-start" | "match-end" | "status-change";
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  data: {
    team?: string;
    player?: string;
    minute?: number;
    score?: string;      // e.g., "1-0"
    newStatus?: string;
  };
  timestamp: string;      // ISO 8601
}
```

**Adaptive Polling Rates**

| Match State              | Poll Interval | Rationale           |
| ------------------------ | ------------- | ------------------- |
| Penalty shootout         | 15 seconds    | Rapid score changes |
| Normal play (1H, 2H, ET) | 30 seconds    | Standard frequency  |
| Halftime / Break         | 60 seconds    | No scoring possible |

> **Note:** Live monitoring auto-starts on server boot via `OnModuleInit`. It can also be controlled via the `/api/fixtures/live/start` and `/api/fixtures/live/stop` endpoints.

---

## Odds

Bookmaker odds and consensus probabilities from The Odds API.

### `GET /api/odds/:eventId`

Get all bookmaker odds for a specific event.

**Path Parameters**

| Parameter | Type   | Description           |
| --------- | ------ | --------------------- |
| `eventId` | string | The Odds API event ID |

**Response `200`**

```json
{
  "eventId": "abc123def456",
  "bookmakerCount": 12,
  "odds": [
    {
      "id": 1,
      "oddsApiEventId": "abc123def456",
      "sportKey": "soccer_epl",
      "homeTeam": "Manchester United",
      "awayTeam": "Arsenal",
      "commenceTime": "2026-03-15T15:00:00.000Z",
      "bookmakerKey": "pinnacle",
      "bookmakerName": "Pinnacle",
      "marketKey": "h2h",
      "outcomes": [
        { "name": "Manchester United", "price": 2.85 },
        { "name": "Draw", "price": 3.4 },
        { "name": "Arsenal", "price": 2.55 }
      ],
      "impliedProbabilities": [0.3509, 0.2941, 0.3922],
      "trueProbabilities": [0.3382, 0.2836, 0.3782],
      "overround": 0.0372,
      "lastUpdate": "2026-03-02T08:00:00.000Z",
      "recordedAt": "2026-03-02T08:15:00.000Z"
    }
  ]
}
```

---

### `GET /api/odds/consensus/:eventId`

Get the weighted consensus probability for an event.

**Path Parameters**

| Parameter | Type   | Description           |
| --------- | ------ | --------------------- |
| `eventId` | string | The Odds API event ID |

**Response `200`**

```json
{
  "eventId": "abc123def456",
  "consensus": [
    {
      "marketKey": "h2h",
      "consensusHomeWin": 0.325,
      "consensusDraw": 0.28,
      "consensusAwayWin": 0.395,
      "pinnacleHomeWin": 0.3382,
      "pinnacleDraw": 0.2836,
      "pinnacleAwayWin": 0.3782,
      "numBookmakers": 12,
      "calculatedAt": "2026-03-02T08:15:00.000Z"
    }
  ]
}
```

---

### `POST /api/odds/sync`

Manually trigger an odds sync from The Odds API.

**Request Body**

```json
{
  "sportKeys": ["soccer_epl", "soccer_spain_la_liga"]
}
```

---

## Alerts

Alert management for high-confidence predictions, live match events, and lineup changes.

### `GET /api/alerts`

Get alerts with optional filters.

**Query Parameters**

| Parameter      | Type    | Default | Description                                                                   |
| -------------- | ------- | ------- | ----------------------------------------------------------------------------- |
| `type`         | string  | —       | Filter by type: `high_confidence`, `value_bet`, `live_event`, `lineup_change` |
| `severity`     | string  | —       | Filter by severity: `low`, `medium`, `high`, `critical`                       |
| `acknowledged` | boolean | —       | Filter by acknowledgment status                                               |
| `page`         | integer | `1`     | Page number                                                                   |
| `limit`        | integer | `50`    | Items per page                                                                |

**Response `200`**

```json
{
  "data": [
    {
      "id": 1,
      "predictionId": 42,
      "fixtureId": 1035012,
      "type": "high_confidence",
      "severity": "high",
      "title": "High confidence prediction: Man Utd vs Arsenal",
      "message": "Confidence 8/10 — Arsenal predicted to win with 40% probability",
      "data": { ... },
      "acknowledged": false,
      "createdAt": "2026-03-02T08:20:00.000Z"
    }
  ],
  "total": 45
}
```

**Alert Types**

| Type              | Trigger                                           | Severity                          |
| ----------------- | ------------------------------------------------- | --------------------------------- |
| `high_confidence` | Prediction with confidence >= 7                   | `high` (7-8) or `critical` (9-10) |
| `value_bet`       | Value betting opportunity detected                | Varies                            |
| `live_event`      | Goal or red card during live match                | `high`                            |
| `lineup_change`   | Confirmed lineups published ~60min before kickoff | `medium`                          |

---

### `GET /api/alerts/unread`

Get all unacknowledged alerts (max 100).

---

### `POST /api/alerts/:id/acknowledge`

Acknowledge a single alert.

---

### `POST /api/alerts/acknowledge-all`

Acknowledge all unread alerts at once.

---

## Automatic Sync Schedule

The backend runs cron jobs and Trigger.dev schedules to keep data fresh:

### NestJS Cron (Data Sync)

| Schedule         | Task           | Description                                                       |
| ---------------- | -------------- | ----------------------------------------------------------------- |
| Every 30 minutes | Fixture sync   | Syncs upcoming fixtures for all 30 leagues (season auto-detected) |
| Every 2 hours    | Injury sync    | Updates injury data for all leagues                               |
| Every 2 hours    | Standings sync | Updates league tables and team form                               |
| Every 6 hours    | Odds sync      | Fetches bookmaker odds                                            |

### Trigger.dev (Prediction Pipeline)

| Schedule             | Task                  | Description                                                          |
| -------------------- | --------------------- | -------------------------------------------------------------------- |
| Daily at 6:00 AM UTC | Daily predictions     | AI predictions for fixtures in next 48 hours                         |
| Every 15 minutes     | Pre-match predictions | Predictions for fixtures kicking off within 1 hour                   |
| Every 5 minutes      | Lineup predictions    | Detects new lineups, regenerates predictions with confirmed XI       |
| Every hour           | Sync + Resolve        | Fetches final scores, resolves predictions (wasCorrect, Brier score) |

### Live Monitoring

Auto-starts on server boot. Polls API-Football every 15-60 seconds (adaptive). Broadcasts to WebSocket clients every 30 seconds.

---

## Error Responses

All endpoints return standard error responses:

**400 Bad Request**

```json
{
  "statusCode": 400,
  "message": ["limit must not be greater than 100"],
  "error": "Bad Request"
}
```

**404 Not Found**

```json
{
  "statusCode": 404,
  "message": "Fixture 9999999 not found",
  "error": "Not Found"
}
```

**500 Internal Server Error**

```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

---

## Rate Limits & External API Budgets

| API              | Limit                           | Current Plan |
| ---------------- | ------------------------------- | ------------ |
| API-Football     | 7,500 requests/day, 300 req/min | Pro          |
| The Odds API     | 20,000 credits/month            | Paid         |
| Perplexity Sonar | Per-request                     | Paid         |
| Anthropic Claude | Per-token                       | Paid         |
