# Polygentic API Reference

**Base URL:** `http://localhost:8080`
**Swagger UI:** `http://localhost:8080/api/docs`

All endpoints are prefixed with `/api`. No authentication is currently required.

---

## Table of Contents

- [Health](#health)
- [Markets (Polymarket)](#markets)
- [Football (Fixtures, Teams, Leagues)](#football)
- [Odds (Bookmaker Odds & Consensus)](#odds)
- [Predictions](#predictions)
- [Alerts](#alerts)
- [WebSocket (Live Scores)](#websocket)

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
    "polymarket_markets": 42,
    "fixtures": 850,
    "predictions": 18,
    "alerts": 3
  },
  "last_syncs": {
    "polymarket_sync_events_and_prices": {
      "status": "success",
      "startedAt": "2026-03-02T08:15:00.000Z",
      "completedAt": "2026-03-02T08:15:12.000Z",
      "durationMs": 12000
    },
    "api_football_sync_fixtures": {
      "status": "success",
      "startedAt": "2026-03-02T08:00:00.000Z",
      "completedAt": "2026-03-02T08:01:45.000Z",
      "durationMs": 105000
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok" \| "degraded"` | `ok` if DB connected, `degraded` otherwise |
| `timestamp` | string | ISO 8601 timestamp |
| `uptime_seconds` | number | Seconds since server started |
| `database` | `"connected" \| "disconnected"` | Database connection status |
| `counts` | object | Record counts per table |
| `last_syncs` | object | Most recent sync per source/task, keyed as `{source}_{task}` |

---

## Markets

Polymarket soccer prediction markets.

### `GET /api/markets`

Paginated list of Polymarket soccer markets.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number (1-indexed) |
| `limit` | integer | `20` | Items per page (max 100) |
| `type` | string | — | Filter by market type. One of: `match_outcome`, `league_winner`, `top_finish`, `relegation`, `transfer`, `tournament`, `player_prop`, `manager`, `other` |
| `active` | boolean | — | Filter by active status |

**Response `200`**

```json
{
  "data": [
    {
      "id": "0xabc123...",
      "question": "Will Manchester United beat Arsenal?",
      "eventId": "evt_456",
      "slug": "will-manchester-united-beat-arsenal",
      "conditionId": "0xcond...",
      "outcomes": ["Yes", "No"],
      "outcomePrices": ["0.45", "0.55"],
      "clobTokenIds": ["token_yes_123", "token_no_456"],
      "volume": "125000.50",
      "volume24hr": "8500.25",
      "liquidity": "45000.00",
      "spread": "0.02",
      "active": true,
      "closed": false,
      "marketType": "match_outcome",
      "createdAt": "2026-02-28T10:00:00.000Z",
      "updatedAt": "2026-03-02T08:15:00.000Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20,
  "totalPages": 3
}
```

---

### `GET /api/markets/search`

Full-text search across market questions and event titles.

**Query Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Search text |
| `limit` | integer | No | `20` | Max results (max 100) |

**Response `200`**

```json
{
  "data": [
    {
      "id": "0xabc123...",
      "question": "Will Liverpool win the Premier League?",
      "eventId": "evt_789",
      "outcomes": ["Yes", "No"],
      "outcomePrices": ["0.30", "0.70"],
      "marketType": "league_winner",
      "active": true
    }
  ],
  "total": 1
}
```

---

### `GET /api/markets/:id`

Get a single market with its price history and parent event data.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Polymarket market ID |

**Response `200`**

```json
{
  "id": "0xabc123...",
  "question": "Will Manchester United beat Arsenal?",
  "eventId": "evt_456",
  "slug": "will-manchester-united-beat-arsenal",
  "conditionId": "0xcond...",
  "outcomes": ["Yes", "No"],
  "outcomePrices": ["0.45", "0.55"],
  "clobTokenIds": ["token_yes_123", "token_no_456"],
  "volume": "125000.50",
  "volume24hr": "8500.25",
  "liquidity": "45000.00",
  "spread": "0.02",
  "active": true,
  "closed": false,
  "marketType": "match_outcome",
  "priceHistory": [
    {
      "id": 1,
      "marketId": "0xabc123...",
      "yesPrice": "0.4500",
      "noPrice": "0.5500",
      "midpoint": "0.4500",
      "spread": "0.0200",
      "volume24hr": "8500.25",
      "liquidity": "45000.00",
      "recordedAt": "2026-03-02T08:15:00.000Z"
    }
  ],
  "event": {
    "id": "evt_456",
    "title": "Manchester United vs Arsenal - Premier League",
    "slug": "man-utd-vs-arsenal",
    "description": "Premier League match on March 15, 2026",
    "startDate": "2026-03-15T15:00:00.000Z",
    "endDate": "2026-03-15T17:00:00.000Z",
    "active": true,
    "closed": false,
    "tags": ["soccer", "premier-league"]
  }
}
```

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "Market with id \"0xinvalid\" not found",
  "error": "Not Found"
}
```

---

### `POST /api/markets/sync`

Manually trigger a sync of soccer events and prices from Polymarket. Fetches events across 14 soccer tags from the Gamma API and current prices from the CLOB API.

**Request Body:** None

**Response `200`**

```json
{
  "eventsUpserted": 15,
  "marketsUpserted": 42,
  "pricesInserted": 38,
  "errors": ["Failed to fetch tag 'copa-america': timeout"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `eventsUpserted` | number | Events created or updated |
| `marketsUpserted` | number | Markets created or updated |
| `pricesInserted` | number | Price history snapshots recorded |
| `errors` | string[] | Optional. Non-fatal errors encountered during sync |

---

## Football

Football fixtures, teams, and leagues sourced from API-Football.

### `GET /api/fixtures`

Paginated list of fixtures with optional filters.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number (1-indexed) |
| `limit` | integer | `20` | Items per page (max 100) |
| `leagueId` | integer | — | Filter by API-Football league ID |
| `date` | string | — | Filter by date (`YYYY-MM-DD`) |
| `status` | string | — | Filter by fixture status (see below) |
| `teamId` | integer | — | Filter by team ID (home or away) |
| `season` | integer | — | Filter by season year |

**Fixture Status Values**

| Code | Meaning |
|------|---------|
| `NS` | Not Started |
| `1H` | First Half |
| `HT` | Halftime |
| `2H` | Second Half |
| `ET` | Extra Time |
| `P` | Penalty Shootout |
| `FT` | Finished |
| `AET` | Finished After Extra Time |
| `PEN` | Finished After Penalties |
| `PST` | Postponed |
| `CANC` | Cancelled |
| `ABD` | Abandoned |
| `SUSP` | Suspended |
| `INT` | Interrupted |
| `TBD` | To Be Determined |
| `WO` | Walk Over |
| `AWD` | Technical Loss |
| `BT` | Break Time |

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
  "total": 850,
  "page": 1,
  "limit": 20
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

| Field | Type | Description |
|-------|------|-------------|
| `source` | `"live-monitor" \| "api"` | `live-monitor` if local polling is active, `api` if fetched directly from API-Football |

---

### `GET /api/fixtures/:id`

Get full fixture detail including statistics, events, injuries, and API-Football predictions (for upcoming matches).

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | API-Football fixture ID |

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
  "statistics": [
    {
      "teamId": 33,
      "shotsOnGoal": 5,
      "shotsOffGoal": 3,
      "totalShots": 12,
      "possession": 58.0,
      "corners": 6,
      "expectedGoals": 1.45
    }
  ],
  "events": [
    {
      "fixtureId": 1035012,
      "teamId": 33,
      "playerName": "Bruno Fernandes",
      "type": "Goal",
      "detail": "Normal Goal",
      "elapsed": 34
    }
  ],
  "injuries": [
    {
      "teamId": 33,
      "playerName": "Lisandro Martinez",
      "type": "Missing Fixture",
      "reason": "Muscle Injury"
    }
  ],
  "prediction": {
    "winner": { "id": 33, "name": "Manchester United" },
    "win_or_draw": true,
    "under_over": "-3.5",
    "advice": "Manchester United or draw and target under 3.5 goals"
  }
}
```

> **Note:** The `prediction` field is only populated for fixtures with status `NS` (Not Started) and is fetched live from the API-Football `/predictions` endpoint.

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "Fixture 9999999 not found",
  "error": "Not Found"
}
```

---

### `GET /api/teams/:id`

Get team details with current form data.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | API-Football team ID |

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

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "Team 9999999 not found",
  "error": "Not Found"
}
```

---

### `GET /api/leagues`

Get all tracked leagues with current season info.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `country` | string | — | Filter by country name |
| `current` | boolean | `true` | Only show currently active leagues |

**Response `200`**

```json
{
  "data": [
    {
      "league": {
        "id": 39,
        "name": "Premier League",
        "type": "League",
        "logo": "https://media.api-sports.io/football/leagues/39.png"
      },
      "country": {
        "name": "England",
        "code": "GB",
        "flag": "https://media.api-sports.io/flags/gb.svg"
      },
      "seasons": [
        { "year": 2025, "start": "2025-08-16", "end": "2026-05-24", "current": true }
      ]
    }
  ],
  "count": 17,
  "trackedIds": [39, 140, 135, 78, 61, 2, 3, 848, 253, 88, 94, 71, 128, 307, 45, 143, 81]
}
```

**Tracked League IDs**

| ID | League |
|----|--------|
| 39 | Premier League (England) |
| 140 | La Liga (Spain) |
| 135 | Serie A (Italy) |
| 78 | Bundesliga (Germany) |
| 61 | Ligue 1 (France) |
| 2 | UEFA Champions League |
| 3 | UEFA Europa League |
| 848 | UEFA Conference League |
| 253 | MLS (USA) |
| 88 | Eredivisie (Netherlands) |
| 94 | Primeira Liga (Portugal) |
| 71 | Brasileirao (Brazil) |
| 128 | Argentine Primera Division |
| 307 | Saudi Pro League |
| 45 | Copa Libertadores |
| 143 | Super Lig (Turkey) |
| 81 | Belgian Pro League |

---

### `POST /api/fixtures/sync`

Manually trigger a fixture and standings sync from API-Football.

**Request Body**

```json
{
  "leagueIds": [39, 140, 135],
  "season": 2025
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `leagueIds` | integer[] | No | League IDs to sync. Defaults to all 17 tracked leagues |
| `season` | integer | No | Season year. Defaults to current season (based on July cutoff) |

**Response `200`**

```json
{
  "success": true,
  "fixturesSynced": 150,
  "standingsSynced": 60,
  "leaguesProcessed": 3,
  "season": 2025
}
```

---

## Odds

Bookmaker odds and consensus probabilities from The Odds API.

### `GET /api/odds/:eventId`

Get all bookmaker odds for a specific event. Returns raw odds, implied probabilities, vig-removed true probabilities, and overround for each bookmaker.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
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
        { "name": "Draw", "price": 3.40 },
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

**Probability Math**

1. **Implied probability** = `1 / decimal_odds` (e.g., `1/2.85 = 0.3509`)
2. **Overround** = `sum(implied_probs) - 1` (bookmaker margin, e.g., `0.0372 = 3.72%`)
3. **True probability** = `implied_prob / sum(implied_probs)` (normalized, sums to 1.0)

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "No odds found for event abc123"
}
```

---

### `GET /api/odds/consensus/:eventId`

Get the weighted consensus probability for an event. This represents the "true" market probability calculated from multiple bookmakers, weighted by sharpness.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventId` | string | The Odds API event ID |

**Response `200`**

```json
{
  "eventId": "abc123def456",
  "consensus": [
    {
      "id": 1,
      "oddsApiEventId": "abc123def456",
      "sportKey": "soccer_epl",
      "homeTeam": "Manchester United",
      "awayTeam": "Arsenal",
      "commenceTime": "2026-03-15T15:00:00.000Z",
      "marketKey": "h2h",
      "consensusHomeWin": 0.3250,
      "consensusDraw": 0.2800,
      "consensusAwayWin": 0.3950,
      "consensusOver": null,
      "consensusUnder": null,
      "consensusPoint": null,
      "pinnacleHomeWin": 0.3382,
      "pinnacleDraw": 0.2836,
      "pinnacleAwayWin": 0.3782,
      "numBookmakers": 12,
      "calculatedAt": "2026-03-02T08:15:00.000Z"
    }
  ]
}
```

**Bookmaker Sharpness Weights**

The consensus is a weighted average across bookmakers. Sharper bookmakers (those with lower margins and faster line movement) receive more weight:

| Bookmaker | Weight | Reason |
|-----------|--------|--------|
| Pinnacle | 35% | Sharpest worldwide, lowest margins |
| Betfair Exchange | 25% | Peer-to-peer, true market price |
| Marathonbet | 10% | Sharp European book |
| 1xBet | 10% | High-volume, fast lines |
| Unibet EU | 5% | Reliable European odds |
| William Hill | 5% | Long-standing, large volume |
| All others | 10% | Split equally among remaining bookmakers |

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "No consensus odds found for event abc123"
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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sportKeys` | string[] | No | Sport keys to sync. Defaults to all 10 tracked soccer sport keys |

**Available Soccer Sport Keys**

| Key | League |
|-----|--------|
| `soccer_epl` | English Premier League |
| `soccer_spain_la_liga` | Spanish La Liga |
| `soccer_germany_bundesliga` | German Bundesliga |
| `soccer_italy_serie_a` | Italian Serie A |
| `soccer_france_ligue_one` | French Ligue 1 |
| `soccer_uefa_champs_league` | UEFA Champions League |
| `soccer_uefa_europa_league` | UEFA Europa League |
| `soccer_usa_mls` | MLS |
| `soccer_brazil_campeonato` | Brasileirao |
| `soccer_netherlands_eredivisie` | Eredivisie |

**Response `201`**

```json
{
  "eventsProcessed": 45,
  "oddsRecordsInserted": 540,
  "consensusCalculated": 45,
  "creditsUsed": 10,
  "creditsRemaining": 490,
  "errors": []
}
```

---

## Predictions

The prediction engine combines 3 signals to detect mispriced Polymarket markets.

### `GET /api/predictions`

Get predictions sorted by confidence score (highest first).

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number (1-indexed) |
| `limit` | integer | `20` | Items per page (max 100) |
| `recommendation` | string | — | Filter by recommendation: `BUY_YES`, `BUY_NO`, `HOLD`, `NO_SIGNAL` |
| `minConfidence` | integer | — | Minimum confidence score (0-100) |
| `status` | string | — | Filter by status: `active`, `resolved` |

**Response `200`**

```json
{
  "data": [
    {
      "id": 1,
      "polymarketMarketId": "0xabc123...",
      "fixtureId": 1035012,
      "polymarketPrice": 0.45,
      "bookmakerConsensus": 0.3250,
      "pinnacleProbability": 0.3382,
      "statisticalModelProb": 0.3100,
      "apiFootballPrediction": null,
      "predictedProbability": 0.3175,
      "mispricingGap": -0.1250,
      "mispricingPct": -38.46,
      "confidenceScore": 72,
      "recommendation": "BUY_NO",
      "reasoning": "Polymarket prices Yes at 45.0% but bookmaker consensus is 32.5% (Pinnacle: 33.8%). Statistical model agrees at 31.0%. The market appears to overvalue Yes by 12.5 percentage points (38.5%). High confidence based on strong signal agreement and significant mispricing.",
      "signals": {
        "mispricing": {
          "gap": -0.1250,
          "gapPct": -38.46,
          "direction": "BUY_NO",
          "strength": 0.85
        },
        "statistical": {
          "homeWin": 0.3100,
          "draw": 0.2900,
          "awayWin": 0.4000,
          "components": {
            "form": 0.42,
            "homeAway": 0.48,
            "h2h": 0.55,
            "goals": 0.44,
            "injury": 0.50,
            "position": 0.38
          }
        },
        "confidence": {
          "signalAgreement": 25,
          "mispricingSize": 25,
          "dataCompleteness": 13,
          "marketLiquidity": 12,
          "timeToEvent": 10,
          "historicalAccuracy": 3
        }
      },
      "isLive": false,
      "status": "active",
      "createdAt": "2026-03-02T08:20:00.000Z",
      "updatedAt": "2026-03-02T08:20:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20
}
```

**Understanding the Prediction**

| Field | Description |
|-------|-------------|
| `polymarketPrice` | Current Polymarket "Yes" price (0-1, e.g., 0.45 = 45%) |
| `bookmakerConsensus` | Weighted consensus probability from 60+ bookmakers |
| `pinnacleProbability` | Pinnacle's vig-removed probability (sharpest single book) |
| `statisticalModelProb` | Custom model using form, H2H, injuries, goals, position |
| `predictedProbability` | Final blended probability from all available signals |
| `mispricingGap` | `consensus - polymarketPrice`. Positive = underpriced on Polymarket, negative = overpriced |
| `mispricingPct` | Gap as a percentage of consensus: `gap / consensus * 100` |
| `confidenceScore` | 0-100 score. >=80 Very High, >=60 High, >=40 Medium, >=20 Low |
| `recommendation` | Actionable signal: `BUY_YES`, `BUY_NO`, `HOLD`, or `NO_SIGNAL` |
| `reasoning` | Human-readable explanation of the prediction |
| `signals` | Full breakdown of each signal's output |

**Recommendation Rules**

| Recommendation | Condition |
|----------------|-----------|
| `BUY_YES` | Confidence >= 60 AND mispricing gap > +5% (market underpriced) |
| `BUY_NO` | Confidence >= 60 AND mispricing gap < -5% (market overpriced) |
| `HOLD` | Confidence >= 40 AND abs(gap) > 3% (weak signal) |
| `NO_SIGNAL` | Insufficient data or confidence |

---

### `GET /api/predictions/mispricings`

Get only significant mispricings — predictions where the gap between Polymarket and bookmaker consensus exceeds a threshold. Sorted by absolute gap (largest first).

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `minGap` | number | `0.05` | Minimum absolute mispricing gap (0-1). E.g., `0.05` = 5% |
| `page` | integer | `1` | Page number |
| `limit` | integer | `20` | Items per page (max 100) |

**Response `200`**

```json
{
  "data": [
    {
      "id": 1,
      "polymarketMarketId": "0xabc123...",
      "polymarketPrice": 0.45,
      "bookmakerConsensus": 0.3250,
      "mispricingGap": -0.1250,
      "mispricingPct": -38.46,
      "confidenceScore": 72,
      "recommendation": "BUY_NO",
      "reasoning": "..."
    }
  ],
  "minGap": 0.05,
  "count": 5
}
```

---

### `GET /api/predictions/:id`

Get detailed prediction including the linked Polymarket market, football fixture, and consensus odds.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | Prediction ID |

**Response `200`**

```json
{
  "id": 1,
  "polymarketMarketId": "0xabc123...",
  "fixtureId": 1035012,
  "polymarketPrice": 0.45,
  "bookmakerConsensus": 0.3250,
  "predictedProbability": 0.3175,
  "mispricingGap": -0.1250,
  "confidenceScore": 72,
  "recommendation": "BUY_NO",
  "reasoning": "...",
  "signals": { "..." },
  "market": {
    "id": "0xabc123...",
    "question": "Will Manchester United beat Arsenal?",
    "outcomes": ["Yes", "No"],
    "outcomePrices": ["0.45", "0.55"],
    "volume": "125000.50",
    "liquidity": "45000.00"
  },
  "fixture": {
    "id": 1035012,
    "leagueName": "Premier League",
    "homeTeamId": 33,
    "awayTeamId": 42,
    "date": "2026-03-15",
    "status": "NS"
  },
  "consensus": {
    "marketKey": "h2h",
    "consensusHomeWin": 0.3250,
    "consensusDraw": 0.2800,
    "consensusAwayWin": 0.3950,
    "pinnacleHomeWin": 0.3382,
    "pinnacleDraw": 0.2836,
    "pinnacleAwayWin": 0.3782,
    "numBookmakers": 12
  }
}
```

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "Prediction 9999 not found"
}
```

---

### `POST /api/predictions/generate`

Manually trigger prediction generation for all matched markets. Processes every `market_fixture_link`, runs all 3 signals, and inserts predictions.

**Request Body:** None

**Response `201`**

```json
{
  "predictionsGenerated": 28,
  "marketsProcessed": 42,
  "errors": ["Failed to generate prediction for market 0xdef456: missing price data"]
}
```

---

## Alerts

Alert management for detected mispricings and live match events.

### `GET /api/alerts`

Get alerts with optional filters.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | — | Filter by type: `mispricing`, `live_event`, `price_movement`, `lineup_change` |
| `severity` | string | — | Filter by severity: `low`, `medium`, `high`, `critical` |
| `acknowledged` | boolean | — | Filter by acknowledgment status |
| `page` | integer | `1` | Page number |
| `limit` | integer | `50` | Items per page |

**Response `200`**

```json
{
  "data": [
    {
      "id": 1,
      "predictionId": 5,
      "type": "mispricing",
      "severity": "high",
      "title": "Large mispricing detected: Man Utd vs Arsenal",
      "message": "Polymarket prices at 45% but consensus is 32.5% — a 12.5% gap",
      "data": {
        "polymarketPrice": 0.45,
        "consensusPrice": 0.325,
        "gap": 0.125,
        "marketId": "0xabc123..."
      },
      "acknowledged": false,
      "createdAt": "2026-03-02T08:20:00.000Z"
    }
  ],
  "total": 3
}
```

**Alert Severity Rules (for mispricings)**

| Severity | Condition |
|----------|-----------|
| `critical` | Absolute gap >= 15% |
| `high` | Absolute gap >= 10% |
| `medium` | Absolute gap >= 7% |
| `low` | Absolute gap < 7% |

---

### `GET /api/alerts/unread`

Get all unacknowledged alerts (max 100).

**Response `200`**

```json
{
  "data": [
    {
      "id": 1,
      "type": "mispricing",
      "severity": "high",
      "title": "Large mispricing detected: Man Utd vs Arsenal",
      "acknowledged": false,
      "createdAt": "2026-03-02T08:20:00.000Z"
    }
  ],
  "count": 1
}
```

---

### `POST /api/alerts/:id/acknowledge`

Acknowledge a single alert.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | Alert ID |

**Response `200`**

Returns the updated alert object with `acknowledged: true`.

**Response `404`**

```json
{
  "statusCode": 404,
  "message": "Alert 9999 not found",
  "error": "Not Found"
}
```

---

### `POST /api/alerts/acknowledge-all`

Acknowledge all unread alerts at once.

**Request Body:** None

**Response `200`**

```json
{
  "acknowledged": 5
}
```

---

## WebSocket

Real-time live score updates via WebSocket (Socket.IO).

### Connection

**Namespace:** `/live`
**URL:** `ws://localhost:8080/live`

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:8080/live");

socket.on("connect", () => {
  console.log("Connected to live scores");
});
```

On connect, the server immediately sends the current state of all active matches as a `match-update` event.

### Events (Server -> Client)

| Event | Payload | Description |
|-------|---------|-------------|
| `match-update` | `LiveFixtureState[]` | Full state of all active matches. Sent on connect and every 30 seconds |
| `goal` | `DetectedEvent` | A goal was scored |
| `red-card` | `DetectedEvent` | Red card or second yellow issued |
| `match-start` | `DetectedEvent` | Match kicked off |
| `match-end` | `DetectedEvent` | Match finished (FT, AET, or PEN) |

### Payload Types

**`LiveFixtureState`**

```typescript
{
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  status: string;       // "1H", "HT", "2H", "ET", "P", "FT"
  elapsed: number;
  leagueId: number;
  leagueName: string;
}
```

**`DetectedEvent`**

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

### Adaptive Polling Rates

The live score monitor adjusts its API polling frequency based on match state:

| Match State | Poll Interval | Rationale |
|-------------|---------------|-----------|
| Penalty shootout | 15 seconds | Rapid score changes |
| Normal play (1H, 2H, ET) | 30 seconds | Standard frequency |
| Halftime / Break | 60 seconds | No scoring possible |

> **Note:** Live monitoring must be explicitly started. It does not auto-start on boot.

---

## Automatic Sync Schedule

The backend runs cron jobs to keep data fresh:

| Schedule | Task | Description |
|----------|------|-------------|
| Every 10 minutes | Polymarket sync | Fetches events (14 soccer tags) and current prices |
| Every 30 minutes | Fixture sync | Syncs next 50 fixtures for all 17 leagues |
| Every 2 hours | Injury sync | Updates injury data for all leagues |
| Every 2 hours | Standings sync | Updates league tables and team form |
| Every 6 hours | Odds sync | Fetches bookmaker odds for 10 sport keys |
| Every 20 minutes | Match + Predict | Links markets to fixtures, then generates predictions |

An initial Polymarket sync runs 5 seconds after startup.

---

## Error Responses

All endpoints return standard error responses:

**400 Bad Request** — Invalid query parameters or request body

```json
{
  "statusCode": 400,
  "message": ["limit must not be greater than 100"],
  "error": "Bad Request"
}
```

**404 Not Found** — Resource does not exist

```json
{
  "statusCode": 404,
  "message": "Market with id \"0xinvalid\" not found",
  "error": "Not Found"
}
```

**500 Internal Server Error** — Server-side failure

```json
{
  "statusCode": 500,
  "message": "Failed to retrieve predictions",
  "error": "Internal Server Error"
}
```

---

## Rate Limits & External API Budgets

The backend is subject to rate limits from its external data sources:

| API | Limit | Current Plan |
|-----|-------|--------------|
| API-Football | 7,500 requests/day, 300 req/min | Pro ($19/mo) |
| The Odds API | 500 credits/month | Free tier |
| Polymarket Gamma | No auth required, no published limits | Free |
| Polymarket CLOB | No auth required, no published limits | Free |

The Odds API client automatically pauses requests when remaining credits fall below 10% of the monthly limit.
