# API-Football Integration

## Overview

API-Football (via api-sports.io) is our primary source for match data, team statistics, injuries, lineups, live scores, and built-in predictions. We use the **Pro plan** (7,500 requests/day, 300 requests/minute).

- **Base URL:** `https://v3.football.api-sports.io`
- **Authentication:** `x-apisports-key` header with API key
- **Response format:** JSON

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
  "response": [{
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
      "logo": "https://...",
      "flag": "https://...",
      "season": 2024,
      "round": "Regular Season - 29"
    },
    "teams": {
      "home": { "id": 42, "name": "Arsenal", "logo": "https://...", "winner": null },
      "away": { "id": 33, "name": "Manchester United", "logo": "https://...", "winner": null }
    },
    "goals": { "home": null, "away": null },
    "score": {
      "halftime": { "home": null, "away": null },
      "fulltime": { "home": null, "away": null },
      "extratime": { "home": null, "away": null },
      "penalty": { "home": null, "away": null }
    }
  }]
}
```

**Usage:** Fetch upcoming fixtures to match against Polymarket markets and track schedules.

---

#### Get Live Fixtures

```
GET /fixtures?live=all
GET /fixtures?live=all&league={id}
```

**Status codes for live matches:**

| Status | Short | Description |
|---|---|---|
| First Half | 1H | Currently in first half |
| Halftime | HT | Halftime break |
| Second Half | 2H | Currently in second half |
| Extra Time | ET | Extra time being played |
| Penalty | P | Penalty shootout |
| Break Time | BT | Break during extra time |
| Suspended | SUSP | Match suspended |
| Interrupted | INT | Match interrupted |

**Usage:** Poll every 30 seconds during live matches to detect goals, red cards, and score changes.

---

### 2. Predictions (Built-in AI Predictions)

```
GET /predictions?fixture={fixtureId}
```

**Response structure:**

```json
{
  "response": [{
    "predictions": {
      "winner": { "id": 42, "name": "Arsenal", "comment": "Win or draw" },
      "win_or_draw": true,
      "under_over": "-3.5",
      "goals": { "home": "-2.5", "away": "-1.5" },
      "advice": "Combo Double chance: Arsenal or draw and target Under 3.5",
      "percent": { "home": "65%", "draw": "20%", "away": "15%" }
    },
    "league": { "id": 39, "name": "Premier League", "country": "England" },
    "teams": {
      "home": {
        "id": 42,
        "name": "Arsenal",
        "last_5": {
          "form": "WWDWW",
          "att": "85%",
          "def": "80%",
          "goals": {
            "for": { "total": 12, "average": "2.4" },
            "against": { "total": 3, "average": "0.6" }
          }
        }
      },
      "away": {
        "id": 33,
        "name": "Manchester United",
        "last_5": {
          "form": "WLDWL",
          "att": "60%",
          "def": "55%",
          "goals": {
            "for": { "total": 7, "average": "1.4" },
            "against": { "total": 8, "average": "1.6" }
          }
        }
      }
    },
    "comparison": {
      "form": { "home": "80%", "away": "50%" },
      "att": { "home": "85%", "away": "60%" },
      "def": { "home": "80%", "away": "55%" },
      "poisson_distribution": { "home": "...", "away": "..." },
      "h2h": { "home": "45%", "away": "30%" },
      "goals": { "home": "75%", "away": "50%" },
      "total": { "home": "70%", "away": "48%" }
    },
    "h2h": [
      {
        "fixture": { "id": 123456, "date": "2024-09-15T14:00:00+00:00" },
        "teams": { "home": { "id": 42, "winner": true }, "away": { "id": 33, "winner": false } },
        "goals": { "home": 3, "away": 1 }
      }
    ]
  }]
}
```

**Usage:** Use as one of three prediction signals. The `percent` field gives us win/draw/loss probabilities. The `comparison` object and `h2h` data feed our statistical model.

---

### 3. Fixture Statistics

```
GET /fixtures/statistics?fixture={fixtureId}
```

**Response structure:**

```json
{
  "response": [{
    "team": { "id": 42, "name": "Arsenal" },
    "statistics": [
      { "type": "Shots on Goal", "value": 7 },
      { "type": "Shots off Goal", "value": 4 },
      { "type": "Total Shots", "value": 15 },
      { "type": "Blocked Shots", "value": 4 },
      { "type": "Shots insidebox", "value": 10 },
      { "type": "Shots outsidebox", "value": 5 },
      { "type": "Fouls", "value": 12 },
      { "type": "Corner Kicks", "value": 6 },
      { "type": "Offsides", "value": 2 },
      { "type": "Ball Possession", "value": "58%" },
      { "type": "Yellow Cards", "value": 2 },
      { "type": "Red Cards", "value": 0 },
      { "type": "Goalkeeper Saves", "value": 3 },
      { "type": "Total passes", "value": 487 },
      { "type": "Passes accurate", "value": 412 },
      { "type": "Passes %", "value": "85%" },
      { "type": "expected_goals", "value": "2.35" }
    ]
  }]
}
```

**Usage:** Collect post-match statistics for building historical models. The `expected_goals` (xG) field is particularly valuable for prediction accuracy.

---

### 4. Fixture Events (Live In-Game Events)

```
GET /fixtures/events?fixture={fixtureId}
```

**Response structure:**

```json
{
  "response": [
    {
      "time": { "elapsed": 23, "extra": null },
      "team": { "id": 42, "name": "Arsenal" },
      "player": { "id": 1100, "name": "B. Saka" },
      "assist": { "id": 1101, "name": "M. Odegaard" },
      "type": "Goal",
      "detail": "Normal Goal",
      "comments": null
    },
    {
      "time": { "elapsed": 67, "extra": null },
      "team": { "id": 33, "name": "Manchester United" },
      "player": { "id": 2200, "name": "B. Fernandes" },
      "assist": { "id": null, "name": null },
      "type": "Card",
      "detail": "Red Card",
      "comments": null
    }
  ]
}
```

**Event types:** `Goal`, `Card`, `subst` (substitution), `Var`

**Goal details:** `Normal Goal`, `Own Goal`, `Penalty`, `Missed Penalty`

**Card details:** `Yellow Card`, `Red Card`, `Second Yellow card`

**Usage:** During live matches, detect significant events (goals, red cards) that should trigger price recalculation and mispricing alerts.

---

### 5. Injuries

```
GET /injuries?league={id}&season={year}
GET /injuries?fixture={fixtureId}
GET /injuries?team={id}
```

**Response structure:**

```json
{
  "response": [{
    "player": {
      "id": 1100,
      "name": "B. Saka",
      "photo": "https://...",
      "type": "Missing Fixture",
      "reason": "Hamstring Injury"
    },
    "team": { "id": 42, "name": "Arsenal", "logo": "https://..." },
    "fixture": { "id": 868324, "date": "2025-03-15", "timestamp": 1710514800 },
    "league": { "id": 39, "season": 2024, "name": "Premier League" }
  }]
}
```

**Usage:** Key injuries shift match probabilities significantly. Missing a top scorer or first-choice goalkeeper is a strong prediction signal.

---

### 6. Lineups

```
GET /fixtures/lineups?fixture={fixtureId}
```

**Response structure:**

```json
{
  "response": [{
    "team": { "id": 42, "name": "Arsenal" },
    "formation": "4-3-3",
    "startXI": [
      { "player": { "id": 882, "name": "D. Raya", "number": 22, "pos": "G", "grid": "1:1" } },
      { "player": { "id": 1100, "name": "B. Saka", "number": 7, "pos": "F", "grid": "1:4" } }
    ],
    "substitutes": [
      { "player": { "id": 900, "name": "K. Havertz", "number": 29, "pos": "F", "grid": null } }
    ],
    "coach": { "id": 1, "name": "M. Arteta" }
  }]
}
```

**Usage:** Available ~1 hour before kickoff. Confirms which players are actually starting, allowing last-minute prediction adjustments.

---

### 7. Head-to-Head

```
GET /fixtures/headtohead?h2h={team1Id}-{team2Id}&last={count}
```

**Response:** Array of past fixtures between the two teams (same structure as fixtures endpoint).

**Usage:** H2H record is a signal in our statistical model, especially for derby/rivalry matches where historical patterns persist.

---

### 8. Team Statistics (Season-long)

```
GET /teams/statistics?league={id}&season={year}&team={id}
```

**Response includes:**
- Games played, wins, draws, losses (home/away split)
- Goals for/against (home/away split, averages)
- Biggest win/loss streak
- Clean sheets, failed to score count
- Penalty success rate
- Lineups and formations used
- Cards received

**Usage:** Season-long team performance provides the baseline for our statistical model.

---

### 9. Standings

```
GET /standings?league={id}&season={year}
```

**Response:** Full league table with points, goal difference, form, home/away records.

**Usage:** League position and form string are inputs to the statistical model.

---

### 10. Leagues

```
GET /leagues?country={name}
GET /leagues?id={id}
GET /leagues?current=true
```

**Usage:** Discovery endpoint to get league IDs and current season info.

---

## Key League IDs

| League | ID | Country |
|---|---|---|
| Premier League | 39 | England |
| La Liga | 140 | Spain |
| Serie A | 135 | Italy |
| Bundesliga | 78 | Germany |
| Ligue 1 | 61 | France |
| Champions League | 2 | Europe |
| Europa League | 3 | Europe |
| Conference League | 848 | Europe |
| World Cup | 1 | World |
| Euro Championship | 4 | Europe |
| Copa America | 9 | South America |
| MLS | 253 | USA |
| Eredivisie | 88 | Netherlands |
| Primeira Liga | 94 | Portugal |
| Brazilian Serie A | 71 | Brazil |
| Argentine Primera | 128 | Argentina |
| Saudi Pro League | 307 | Saudi Arabia |
| FA Cup | 45 | England |
| Copa del Rey | 143 | Spain |
| DFB Pokal | 81 | Germany |

---

## Rate Limits (Pro Plan)

| Limit | Value |
|---|---|
| Requests per day | 7,500 |
| Requests per minute | 300 |

### Rate Limit Budget Allocation

| Purpose | Estimated Daily Usage | Notes |
|---|---|---|
| Periodic fixture sync | ~200 req | Upcoming fixtures for tracked leagues |
| Predictions fetch | ~200 req | One per fixture with Polymarket match |
| Injuries sync | ~100 req | Per tracked league |
| Team statistics | ~100 req | Seasonal stats for relevant teams |
| H2H data | ~100 req | For matched fixtures |
| Standings | ~50 req | Per tracked league |
| **Live match monitoring** | **~2,500 req** | ~30s polling for live matches (main budget consumer) |
| Lineups (pre-match) | ~50 req | Fetched ~1hr before kickoff |
| Buffer | ~4,200 req | Reserved for spikes and retries |
| **Total estimated** | **~3,300 req** | Well within 7,500 daily limit |

---

## Fixture Status Reference

| Status | Short | Description | Our Action |
|---|---|---|---|
| Time To Be Defined | TBD | Scheduled, no time yet | Track, don't poll |
| Not Started | NS | Scheduled with time | Match against Polymarket |
| First Half | 1H | Live | Poll every 30s |
| Halftime | HT | Break | Poll every 60s |
| Second Half | 2H | Live | Poll every 30s |
| Extra Time | ET | Extra time | Poll every 30s |
| Penalty | P | Penalty shootout | Poll every 15s |
| Match Finished | FT | Completed | Final sync, stop polling |
| Match Finished AET | AET | Finished after extra time | Final sync |
| Match Finished Pen | PEN | Finished after penalties | Final sync |
| Postponed | PST | Delayed | Update prediction |
| Cancelled | CANC | Cancelled | Flag for Polymarket resolution |
| Abandoned | ABD | Abandoned mid-match | Flag for review |
| Suspended | SUSP | Temporarily suspended | Keep monitoring |
| Interrupted | INT | Interrupted | Keep monitoring |
| Walk Over | WO | Walkover | Auto-resolve |
| Technical Loss | AWD | Technical loss awarded | Auto-resolve |

---

## Error Handling

| HTTP Code | Meaning | Action |
|---|---|---|
| 200 | Success | Process response |
| 204 | No content | Valid response, no data available |
| 429 | Rate limited | Back off, retry after delay |
| 499 | Time out | Retry with exponential backoff |
| 500 | Server error | Retry with exponential backoff |

Always check `response.errors` object in the JSON response for API-level errors even on 200 status codes.
