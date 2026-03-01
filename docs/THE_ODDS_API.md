# The Odds API Integration

## Overview

The Odds API aggregates odds from 60+ bookmakers worldwide. We use it to establish a **bookmaker consensus probability** — the "smart money" benchmark against which we compare Polymarket prices to detect mispricings.

- **Base URL:** `https://api.the-odds-api.com`
- **Authentication:** `apiKey` query parameter
- **Response format:** JSON

---

## Endpoints We Use

### 1. List Sports

```
GET /v4/sports/?apiKey={key}
```

**Cost:** 0 credits (free)

Returns all available sport keys. Soccer-specific keys we track:

| Sport Key | League |
|---|---|
| `soccer_epl` | English Premier League |
| `soccer_spain_la_liga` | La Liga |
| `soccer_germany_bundesliga` | Bundesliga |
| `soccer_italy_serie_a` | Serie A |
| `soccer_france_ligue_one` | Ligue 1 |
| `soccer_uefa_champs_league` | UEFA Champions League |
| `soccer_uefa_europa_league` | UEFA Europa League |
| `soccer_uefa_europa_conference_league` | Conference League |
| `soccer_brazil_campeonato` | Brazilian Serie A |
| `soccer_usa_mls` | MLS |
| `soccer_efl_champ` | EFL Championship |
| `soccer_netherlands_eredivisie` | Eredivisie |
| `soccer_portugal_primeira_liga` | Primeira Liga |
| `soccer_turkey_super_league` | Turkish Super Lig |
| `soccer_australia_aleague` | A-League |
| `soccer_japan_j_league` | J1 League |
| `soccer_korea_kleague1` | K League 1 |
| `soccer_mexico_ligamx` | Liga MX |
| `soccer_argentina_primera_division` | Argentine Primera |
| `soccer_fifa_world_cup` | FIFA World Cup |
| `soccer_uefa_european_championship` | UEFA Euro |
| `soccer_conmebol_copa_libertadores` | Copa Libertadores |
| `soccer_england_league1` | League One |
| `soccer_england_league2` | League Two |
| `soccer_fa_cup` | FA Cup |
| `soccer_scotland_premiership` | Scottish Premiership |
| `soccer_belgium_first_div` | Belgian Pro League |
| `soccer_switzerland_superleague` | Swiss Super League |
| `soccer_austria_bundesliga` | Austrian Bundesliga |
| `soccer_denmark_superliga` | Danish Superliga |
| `soccer_norway_eliteserien` | Norwegian Eliteserien |
| `soccer_sweden_allsvenskan` | Swedish Allsvenskan |
| `soccer_greece_super_league` | Greek Super League |
| `soccer_china_superleague` | Chinese Super League |
| `soccer_saudi_professional_league` | Saudi Pro League |

---

### 2. Get Odds for a Sport

```
GET /v4/sports/{sportKey}/odds/?apiKey={key}&regions={regions}&markets={markets}&oddsFormat=decimal
```

**Parameters:**

| Param | Value | Description |
|---|---|---|
| `regions` | `uk,eu` | Regions to include (determines which bookmakers). We use UK + EU for Pinnacle, Betfair |
| `markets` | `h2h,totals,spreads` | Market types to fetch |
| `oddsFormat` | `decimal` | Decimal odds (easiest for probability conversion) |
| `bookmakers` | `pinnacle,betfair_ex_eu` | Optional: filter to specific bookmakers |

**Cost:** `num_regions x num_markets` credits per request

**Response structure:**

```json
{
  "id": "e0f2c1b2d3e4f5a6b7c8d9e0f1a2b3c4",
  "sport_key": "soccer_epl",
  "sport_title": "EPL",
  "commence_time": "2025-03-15T15:00:00Z",
  "home_team": "Arsenal",
  "away_team": "Manchester United",
  "bookmakers": [
    {
      "key": "pinnacle",
      "title": "Pinnacle",
      "last_update": "2025-03-14T12:00:00Z",
      "markets": [
        {
          "key": "h2h",
          "last_update": "2025-03-14T12:00:00Z",
          "outcomes": [
            { "name": "Arsenal", "price": 1.65 },
            { "name": "Manchester United", "price": 5.50 },
            { "name": "Draw", "price": 4.20 }
          ]
        },
        {
          "key": "totals",
          "last_update": "2025-03-14T12:00:00Z",
          "outcomes": [
            { "name": "Over", "price": 1.85, "point": 2.5 },
            { "name": "Under", "price": 2.00, "point": 2.5 }
          ]
        }
      ]
    },
    {
      "key": "betfair_ex_eu",
      "title": "Betfair Exchange",
      "markets": [{ "key": "h2h", "outcomes": ["..."] }]
    }
  ]
}
```

---

### 3. Get Events (No Odds)

```
GET /v4/sports/{sportKey}/events/?apiKey={key}
```

**Cost:** 0 credits (free)

Returns list of upcoming events without odds. Useful for mapping events without burning credits.

---

### 4. Get Single Event Odds

```
GET /v4/sports/{sportKey}/events/{eventId}/odds/?apiKey={key}&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal
```

**Cost:** 1 credit per market per region

Useful for refreshing odds on a specific event without fetching all events.

---

### 5. Get Scores

```
GET /v4/sports/{sportKey}/scores/?apiKey={key}&daysFrom=3
```

**Cost:** 1-2 credits

Returns scores for completed and in-progress events. Used as backup/validation against API-Football live scores.

---

### 6. Historical Odds

```
GET /v4/historical/sports/{sportKey}/odds/?apiKey={key}&regions=uk,eu&markets=h2h&date={ISO8601}
```

Retrieve odds snapshots from a specific point in time. Valuable for backtesting predictions.

---

## Betting Markets We Track

### Primary Markets

| Market Key | Description | Use Case |
|---|---|---|
| `h2h` | Head-to-head / 3-way (Home, Draw, Away) | Match outcome prediction |
| `totals` | Over/Under total goals | Goals market prediction |
| `spreads` | Asian handicap / Point spread | Handicap market prediction |

### Secondary Markets (for specific Polymarket questions)

| Market Key | Description | Use Case |
|---|---|---|
| `outrights` | Futures (league winner, top 4, relegation) | Season-long markets |
| `btts` | Both Teams to Score (Yes/No) | BTTS market prediction |
| `double_chance` | Double chance (Home/Draw, Away/Draw, Home/Away) | Lower risk predictions |
| `draw_no_bet` | Draw No Bet | Specific market types |
| `h2h_h1` | First half result | Half-time markets |
| `totals_h1` | First half over/under | Half-time goals markets |

### Player Prop Markets

| Market Key | Description |
|---|---|
| `player_goal_scorer_anytime` | Anytime goalscorer |
| `player_first_goal_scorer` | First goalscorer |
| `player_shots_on_target` | Player shots on target over/under |
| `player_assists` | Player assists over/under |

---

## Key Bookmakers (Ranked by Sharpness)

We weight bookmakers differently when calculating consensus probability:

| Rank | Bookmaker Key | Name | Weight | Why |
|---|---|---|---|---|
| 1 | `pinnacle` | Pinnacle | **0.35** | Sharpest book globally. Lowest vig, accepts professional bettors. Gold standard for "true" odds. |
| 2 | `betfair_ex_eu` | Betfair Exchange | **0.25** | Exchange model (peer-to-peer). Reflects sharp money with minimal house edge. |
| 3 | `marathonbet` | Marathonbet | **0.10** | Known for sharp lines, low margins |
| 4 | `onexbet` | 1xBet | **0.10** | High limits, competitive odds |
| 5 | `unibet_eu` | Unibet | **0.05** | Major European book |
| 6 | `williamhill` | William Hill | **0.05** | Major UK book |
| 7 | All others | Various | **0.10** (split) | Recreational books (higher vig, less reliable for true probability) |

---

## Odds-to-Probability Conversion

### Step 1: Convert Decimal Odds to Implied Probability

```
implied_probability = 1 / decimal_odds
```

**Example (3-way match):**

| Outcome | Decimal Odds | Implied Probability |
|---|---|---|
| Arsenal Win | 1.65 | 1/1.65 = 0.6061 (60.61%) |
| Draw | 4.20 | 1/4.20 = 0.2381 (23.81%) |
| Man Utd Win | 5.50 | 1/5.50 = 0.1818 (18.18%) |
| **Sum** | | **1.0260 (102.60%)** |

The sum exceeds 100% because of the bookmaker's **overround (vig)** — their profit margin.

### Step 2: Remove the Vig (Normalize)

```
true_probability = implied_probability / sum_of_all_implied_probabilities
```

**Example continued:**

| Outcome | Implied | True (normalized) |
|---|---|---|
| Arsenal Win | 0.6061 | 0.6061 / 1.0260 = **0.5907 (59.07%)** |
| Draw | 0.2381 | 0.2381 / 1.0260 = **0.2320 (23.20%)** |
| Man Utd Win | 0.1818 | 0.1818 / 1.0260 = **0.1772 (17.72%)** |
| **Sum** | | **1.0000 (100.00%)** |

### Step 3: Calculate Weighted Consensus

For each outcome, compute the weighted average across all bookmakers:

```
consensus_probability = SUM(bookmaker_weight * bookmaker_true_probability) for all bookmakers
```

**This consensus probability is what we compare against the Polymarket price.**

---

## Quota Management

### Credit Cost Formula

```
credits = num_regions x num_markets
```

**Example:** Fetching `h2h` + `totals` for `uk,eu` regions = 2 x 2 = 4 credits per request

### Optimization Strategy

1. **Batch by sport key** — One request per league gets all events for that league
2. **Prioritize sharp books** — Use `bookmakers=pinnacle,betfair_ex_eu` filter to reduce payload
3. **Use /events endpoint (free)** for scheduling, only fetch odds when needed
4. **Cache aggressively** — Odds don't change drastically minute-to-minute for non-live events
5. **Fetch historical odds sparingly** — Only for backtesting, not production flow

### Estimated Monthly Usage

| Task | Frequency | Credits per call | Monthly total |
|---|---|---|---|
| Fetch EPL odds | 4x/day | 4 | 480 |
| Fetch La Liga odds | 4x/day | 4 | 480 |
| Fetch Serie A odds | 4x/day | 4 | 480 |
| Fetch Bundesliga odds | 4x/day | 4 | 480 |
| Fetch Ligue 1 odds | 4x/day | 4 | 480 |
| Fetch CL/EL odds | 2x/day | 4 | 240 |
| Fetch other leagues | 2x/day | 4 | 720 |
| Outright/futures | 1x/day | 2 | 60 |
| Single event refreshes | ~20/day | 2 | 1,200 |
| **Total estimated** | | | **~4,620 credits/month** |

This fits comfortably within the 20K plan ($30/mo) or can be squeezed into the free tier (500/mo) by reducing frequency during prototyping.

---

## Response Headers (Usage Tracking)

| Header | Description |
|---|---|
| `x-requests-remaining` | Credits remaining in current period |
| `x-requests-used` | Credits used in current period |
| `x-requests-last` | Credits used by this specific request |

Always read these headers after each request and log them. Pause syncing if remaining credits drop below a safety threshold (e.g., 10% of budget).

---

## Error Handling

| HTTP Code | Meaning | Action |
|---|---|---|
| 200 | Success | Process response |
| 401 | Invalid API key | Check configuration |
| 404 | Sport not found | Skip this sport key |
| 422 | Invalid parameters | Fix request params |
| 429 | Rate limited | Back off, check `x-requests-remaining` |
| 500 | Server error | Retry with backoff |
