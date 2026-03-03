# API-Football Integration

## Overview

API-Football (via api-sports.io) is our primary source for match data, team statistics, injuries, lineups, live scores, and built-in predictions. We use the **Pro plan** (7,500 requests/day, 300 requests/minute).

- **Base URL:** `https://v3.football.api-sports.io`
- **Authentication:** `x-apisports-key` header with API key
- **Response format:** JSON

We track **30 leagues/competitions** across domestic leagues, European cups, Americas, cups, international tournaments, and World Cup qualifiers.

---

## Season Detection

### The Problem

Most European leagues use a cross-year season (e.g., 2025-2026 season = `2025`), but some competitions use a calendar-year format:

| League         | API ID | Season Format | Example                    |
| -------------- | ------ | ------------- | -------------------------- |
| MLS            | 253    | Calendar year | `2026` for the 2026 season |
| Liga MX        | 262    | Calendar year | `2026`                     |
| Brasileirao    | 71     | Calendar year | `2026`                     |
| Argentina Liga | 128    | Calendar year | `2026`                     |

### The Solution

`FootballService` provides two static methods as the single source of truth:

**`getCurrentSeason()`** — Returns the European season year. If the current month is July or later, returns the current year; otherwise returns previous year.

```typescript
static getCurrentSeason(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}
```

**`getSeasonsForLeague(leagueId)`** — Returns the correct season(s) to query for a given league:

- European leagues: `[europeanSeason]` (e.g., `[2025]`)
- Calendar-year leagues: `[calendarYear, europeanSeason]` (e.g., `[2026, 2025]`) — tries calendar year first

**`CALENDAR_YEAR_LEAGUES`** — Static set: `{253, 262, 71, 128}`

All sync methods (`syncFixtures`, `syncCompletedFixtures`, `syncStandings`, `syncInjuries`, `syncFixturesByDateRange`) auto-detect the correct season internally. No external callers need to pass a season parameter.

---

## Endpoints We Use

### 1. Fixtures (Core Endpoint)

#### Get Upcoming Fixtures

```
GET /fixtures?league={id}&season={year}&next={count}
GET /fixtures?date={YYYY-MM-DD}
GET /fixtures?team={id}&next={count}
```

**Response structure:**

```json
{
  "response": [
    {
      "fixture": {
        "id": 868324,
        "referee": "Michael Oliver, England",
        "timezone": "UTC",
        "date": "2025-03-15T15:00:00+00:00",
        "timestamp": 1710514800,
        "venue": { "id": 556, "name": "Emirates Stadium", "city": "London" },
        "status": { "long": "Not Started", "short": "NS", "elapsed": null }
      },
      "league": {
        "id": 39,
        "name": "Premier League",
        "country": "England",
        "season": 2024,
        "round": "Regular Season - 29"
      },
      "teams": {
        "home": {
          "id": 42,
          "name": "Arsenal",
          "logo": "https://...",
          "winner": null
        },
        "away": {
          "id": 33,
          "name": "Manchester United",
          "logo": "https://...",
          "winner": null
        }
      },
      "goals": { "home": null, "away": null },
      "score": {
        "halftime": { "home": null, "away": null },
        "fulltime": { "home": null, "away": null },
        "extratime": { "home": null, "away": null },
        "penalty": { "home": null, "away": null }
      }
    }
  ]
}
```

#### Get Fixtures by Date Range (Historical Backfill)

```
GET /fixtures?league={id}&season={year}&from={YYYY-MM-DD}&to={YYYY-MM-DD}
```

Used by `syncFixturesByDateRange()` for the historical backfill script. Fetches completed fixtures in 2-week chunks.

#### Get Live Fixtures

```
GET /fixtures?live=all
GET /fixtures?live=all&league={id}
```

**Live status codes:**

| Status      | Short | Description              |
| ----------- | ----- | ------------------------ |
| First Half  | 1H    | Currently in first half  |
| Halftime    | HT    | Halftime break           |
| Second Half | 2H    | Currently in second half |
| Extra Time  | ET    | Extra time being played  |
| Penalty     | P     | Penalty shootout         |
| Break Time  | BT    | Break during extra time  |
| Suspended   | SUSP  | Match suspended          |
| Interrupted | INT   | Match interrupted        |

---

### 2. Predictions (Built-in AI Predictions)

```
GET /predictions?fixture={fixtureId}
```

Returns API-Football's own prediction with percent probabilities, winner advice, and team comparison metrics. Used as one data point in our DataCollectorAgent.

---

### 3. Fixture Statistics

```
GET /fixtures/statistics?fixture={fixtureId}
```

Returns per-team statistics including xG, shots, possession, passes, cards. Stored in `fixture_statistics` table.

---

### 4. Fixture Events

```
GET /fixtures/events?fixture={fixtureId}
```

Returns in-game events (goals, cards, substitutions, VAR). Stored in `fixture_events` table.

---

### 5. Injuries

```
GET /injuries?league={id}&season={year}
```

Returns player injuries and suspensions. Season auto-detected per league. Injuries referencing fixtures not in DB are inserted with `fixture_id = NULL` to avoid FK constraint violations.

---

### 6. Lineups

```
GET /fixtures/lineups?fixture={fixtureId}
```

Returns confirmed lineups with formation, startXI, substitutes, coach, and team colors. Available ~60 minutes before kickoff. Persisted to `fixture_lineups` table by the lineup-prediction Trigger.dev task.

---

### 7. Head-to-Head

```
GET /fixtures/headtohead?h2h={team1Id}-{team2Id}&last={count}
```

Returns past meetings between two teams. Fetched on-demand during the prediction pipeline.

---

### 8. Standings

```
GET /standings?league={id}&season={year}
```

Returns league tables with points, form, records. Season auto-detected per league. Calendar-year leagues try both seasons (first with data wins).

---

### 9. Leagues

```
GET /leagues?id={id}
GET /leagues?current=true
```

Discovery endpoint for league IDs and season info.

---

## Key League IDs (30 Tracked)

### Domestic Leagues

| League           | ID  | Country      |
| ---------------- | --- | ------------ |
| Premier League   | 39  | England      |
| La Liga          | 140 | Spain        |
| La Liga 2        | 141 | Spain        |
| Serie A          | 135 | Italy        |
| Bundesliga       | 78  | Germany      |
| Ligue 1          | 61  | France       |
| Eredivisie       | 88  | Netherlands  |
| Primeira Liga    | 94  | Portugal     |
| Saudi Pro League | 307 | Saudi Arabia |

### European Club Competitions

| League            | ID  |
| ----------------- | --- |
| Champions League  | 2   |
| Europa League     | 3   |
| Conference League | 848 |

### Americas (Calendar-Year Seasons)

| League         | ID  | Country    |
| -------------- | --- | ---------- |
| MLS            | 253 | USA/Canada |
| Liga MX        | 262 | Mexico     |
| Brasileirao    | 71  | Brazil     |
| Argentina Liga | 128 | Argentina  |

### Domestic Cups

| Cup          | ID  | Country |
| ------------ | --- | ------- |
| FA Cup       | 45  | England |
| Copa del Rey | 143 | Spain   |
| DFB Pokal    | 81  | Germany |

### International Tournaments

| Tournament            | ID  |
| --------------------- | --- |
| FIFA World Cup        | 1   |
| FIFA Club World Cup   | 15  |
| Euro Championship     | 4   |
| Africa Cup of Nations | 6   |
| Copa America          | 9   |
| AFC Asian Cup         | 29  |
| UEFA Nations League   | 5   |
| CONCACAF Gold Cup     | 13  |

### World Cup Qualifiers

| Tournament        | ID  |
| ----------------- | --- |
| WCQ Europe        | 32  |
| WCQ South America | 34  |
| WCQ Africa        | 36  |

---

## Rate Limits (Pro Plan)

| Limit               | Value |
| ------------------- | ----- |
| Requests per day    | 7,500 |
| Requests per minute | 300   |

### Estimated Daily API Usage

| Job                         | Calls per Run | Runs per Day       | Daily Total |
| --------------------------- | ------------- | ------------------ | ----------- |
| Fixture sync (30 leagues)   | 30            | 48                 | 1,440       |
| Standings sync (30 leagues) | 30-34\*       | 12                 | ~408        |
| Injuries sync (30 leagues)  | 30-34\*       | 12                 | ~408        |
| Live polling                | 1             | ~2,880 (every 30s) | 2,880       |
| Lineup checks               | 1-10          | ~288 (every 5 min) | ~500        |
| Completed fixture sync      | 30            | 24                 | 720         |
| **Total estimate**          |               |                    | **~6,356**  |

\* Calendar-year leagues (MLS, Liga MX, Brasileirao, Argentina Liga) make 2 API calls (one per season) instead of 1.

This is within the 7,500/day Pro plan limit but leaves limited headroom. Live polling (~2,880 calls/day) is the largest consumer.

---

## Fixture Status Reference

| Status             | Short | Description               | Our Action           |
| ------------------ | ----- | ------------------------- | -------------------- |
| Time To Be Defined | TBD   | Scheduled, no time yet    | Track, don't poll    |
| Not Started        | NS    | Scheduled with time       | Generate predictions |
| First Half         | 1H    | Live                      | Poll every 30s       |
| Halftime           | HT    | Break                     | Poll every 60s       |
| Second Half        | 2H    | Live                      | Poll every 30s       |
| Extra Time         | ET    | Extra time                | Poll every 30s       |
| Penalty            | P     | Penalty shootout          | Poll every 15s       |
| Match Finished     | FT    | Completed                 | Resolve predictions  |
| Match Finished AET | AET   | Finished after extra time | Resolve predictions  |
| Match Finished Pen | PEN   | Finished after penalties  | Resolve predictions  |
| Postponed          | PST   | Delayed                   | Flag for review      |
| Cancelled          | CANC  | Cancelled                 | Flag for review      |
| Abandoned          | ABD   | Abandoned mid-match       | Flag for review      |
| Suspended          | SUSP  | Temporarily suspended     | Keep monitoring      |
| Interrupted        | INT   | Interrupted               | Keep monitoring      |
| Walk Over          | WO    | Walkover                  | Auto-resolve         |
| Technical Loss     | AWD   | Technical loss awarded    | Auto-resolve         |

---

## Error Handling

| HTTP Code | Meaning      | Action                            |
| --------- | ------------ | --------------------------------- |
| 200       | Success      | Process response                  |
| 204       | No content   | Valid response, no data available |
| 429       | Rate limited | Back off, retry after delay       |
| 499       | Time out     | Retry with exponential backoff    |
| 500       | Server error | Retry with exponential backoff    |

Always check `response.errors` object in the JSON response for API-level errors even on 200 status codes.
