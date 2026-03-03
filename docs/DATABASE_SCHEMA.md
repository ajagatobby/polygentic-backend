# Database Schema

## Overview

PostgreSQL database (hosted on Supabase) managed via Drizzle ORM. The schema is organized into 5 domains:

1. **Football** — Fixtures, statistics, events, lineups, injuries, team data from API-Football
2. **Predictions** — AI-generated predictions and alerts
3. **Odds** — Bookmaker odds snapshots from The Odds API
4. **Polymarket** — Events, markets, price history from Polymarket
5. **System** — Sync logs

---

## Entity Relationship Diagram

```
                                fixtures ──1:N──> fixture_statistics
                                    |  ──1:N──> fixture_events
                                    |  ──1:N──> fixture_lineups
                                    |
                         teams ─────+─────> injuries
                                    |
                                    v
                               team_form

predictions ──N:1──> fixtures
            ──N:1──> teams (home + away)
alerts ─────N:1──> predictions
       ─────N:1──> fixtures

bookmaker_odds ──N:1──> fixtures (via event matching)
consensus_odds ──N:1──> fixtures (via event matching)

polymarket_events ──1:N──> polymarket_markets ──1:N──> polymarket_price_history
                                    |
                                    | N:1
                                    v
                           market_fixture_links ──N:1──> fixtures
```

---

## Table Definitions

### 1. teams

Soccer teams from API-Football.

| Column           | Type           | Constraints   | Description               |
| ---------------- | -------------- | ------------- | ------------------------- |
| `id`             | `integer`      | PRIMARY KEY   | API-Football team ID      |
| `name`           | `varchar(255)` | NOT NULL      | Full team name            |
| `short_name`     | `varchar(50)`  |               | Short name / abbreviation |
| `logo`           | `varchar(500)` |               | Logo URL                  |
| `country`        | `varchar(100)` |               | Country                   |
| `founded`        | `integer`      |               | Year founded              |
| `venue_name`     | `varchar(255)` |               | Home stadium              |
| `venue_capacity` | `integer`      |               | Stadium capacity          |
| `created_at`     | `timestamp`    | DEFAULT now() |                           |
| `updated_at`     | `timestamp`    | DEFAULT now() |                           |

**Indexes:**

- `idx_teams_name` on `name`

---

### 2. fixtures

Soccer matches from API-Football.

| Column                 | Type           | Constraints              | Description                          |
| ---------------------- | -------------- | ------------------------ | ------------------------------------ |
| `id`                   | `integer`      | PRIMARY KEY              | API-Football fixture ID              |
| `league_id`            | `integer`      | NOT NULL                 | API-Football league ID               |
| `league_name`          | `varchar(255)` |                          | League name                          |
| `league_country`       | `varchar(100)` |                          | Country                              |
| `season`               | `integer`      |                          | Season year                          |
| `round`                | `varchar(100)` |                          | e.g., "Regular Season - 29"          |
| `home_team_id`         | `integer`      | FK -> teams.id, NOT NULL | Home team                            |
| `away_team_id`         | `integer`      | FK -> teams.id, NOT NULL | Away team                            |
| `date`                 | `timestamp`    | NOT NULL                 | Match date/time (UTC)                |
| `timestamp`            | `bigint`       |                          | Unix timestamp                       |
| `venue_name`           | `varchar(255)` |                          | Stadium name                         |
| `venue_city`           | `varchar(100)` |                          | City                                 |
| `referee`              | `varchar(255)` |                          | Referee name                         |
| `status`               | `varchar(10)`  | NOT NULL                 | Status short code (NS, 1H, FT, etc.) |
| `status_long`          | `varchar(50)`  |                          | Status description                   |
| `elapsed`              | `integer`      |                          | Minutes elapsed (live matches)       |
| `goals_home`           | `integer`      |                          | Home team goals                      |
| `goals_away`           | `integer`      |                          | Away team goals                      |
| `score_halftime_home`  | `integer`      |                          | Half-time home goals                 |
| `score_halftime_away`  | `integer`      |                          | Half-time away goals                 |
| `score_fulltime_home`  | `integer`      |                          | Full-time home goals                 |
| `score_fulltime_away`  | `integer`      |                          | Full-time away goals                 |
| `score_extratime_home` | `integer`      |                          | Extra time home goals                |
| `score_extratime_away` | `integer`      |                          | Extra time away goals                |
| `score_penalty_home`   | `integer`      |                          | Penalty shootout home                |
| `score_penalty_away`   | `integer`      |                          | Penalty shootout away                |
| `raw_data`             | `jsonb`        |                          | Full API response                    |
| `created_at`           | `timestamp`    | DEFAULT now()            |                                      |
| `updated_at`           | `timestamp`    | DEFAULT now()            |                                      |

**Indexes:**

- `idx_fixtures_date` on `date`
- `idx_fixtures_league` on `league_id, season`
- `idx_fixtures_teams` on `home_team_id, away_team_id`
- `idx_fixtures_status` on `status`

---

### 3. fixture_statistics

Post-match or live match statistics from API-Football.

| Column              | Type           | Constraints                 | Description                |
| ------------------- | -------------- | --------------------------- | -------------------------- |
| `id`                | `serial`       | PRIMARY KEY                 |                            |
| `fixture_id`        | `integer`      | FK -> fixtures.id, NOT NULL | Match reference            |
| `team_id`           | `integer`      | FK -> teams.id, NOT NULL    | Team reference             |
| `shots_on_goal`     | `integer`      |                             |                            |
| `shots_off_goal`    | `integer`      |                             |                            |
| `total_shots`       | `integer`      |                             |                            |
| `blocked_shots`     | `integer`      |                             |                            |
| `shots_inside_box`  | `integer`      |                             |                            |
| `shots_outside_box` | `integer`      |                             |                            |
| `fouls`             | `integer`      |                             |                            |
| `corner_kicks`      | `integer`      |                             |                            |
| `offsides`          | `integer`      |                             |                            |
| `possession`        | `numeric(5,2)` |                             | Ball possession percentage |
| `yellow_cards`      | `integer`      |                             |                            |
| `red_cards`         | `integer`      |                             |                            |
| `goalkeeper_saves`  | `integer`      |                             |                            |
| `total_passes`      | `integer`      |                             |                            |
| `passes_accurate`   | `integer`      |                             |                            |
| `passes_pct`        | `numeric(5,2)` |                             | Pass accuracy percentage   |
| `expected_goals`    | `numeric(5,2)` |                             | xG                         |
| `recorded_at`       | `timestamp`    | DEFAULT now()               |                            |

**Indexes:**

- `idx_fixture_stats_fixture` on `fixture_id`
- `idx_fixture_stats_team` on `team_id`

**Unique constraint:** `(fixture_id, team_id)` — one stats row per team per match.

---

### 4. fixture_events

In-game events (goals, cards, substitutions) from API-Football.

| Column        | Type           | Constraints                 | Description                                                 |
| ------------- | -------------- | --------------------------- | ----------------------------------------------------------- |
| `id`          | `serial`       | PRIMARY KEY                 |                                                             |
| `fixture_id`  | `integer`      | FK -> fixtures.id, NOT NULL | Match reference                                             |
| `team_id`     | `integer`      | FK -> teams.id, NOT NULL    | Team reference                                              |
| `player_id`   | `integer`      |                             | Player who triggered the event                              |
| `player_name` | `varchar(255)` |                             |                                                             |
| `assist_id`   | `integer`      |                             | Assisting player (for goals)                                |
| `assist_name` | `varchar(255)` |                             |                                                             |
| `type`        | `varchar(50)`  | NOT NULL                    | Goal, Card, subst, Var                                      |
| `detail`      | `varchar(100)` |                             | Normal Goal, Own Goal, Penalty, Yellow Card, Red Card, etc. |
| `elapsed`     | `integer`      | NOT NULL                    | Minute of event                                             |
| `extra_time`  | `integer`      |                             | Extra time minutes (e.g., 90+3)                             |
| `comments`    | `text`         |                             |                                                             |
| `created_at`  | `timestamp`    | DEFAULT now()               |                                                             |

**Indexes:**

- `idx_fixture_events_fixture` on `fixture_id`
- `idx_fixture_events_type` on `type`

---

### 5. fixture_lineups

Confirmed lineups, formations, and coaching staff for each team in a fixture. Populated ~60 minutes before kickoff by the lineup-prediction Trigger.dev task.

| Column        | Type           | Constraints                 | Description                             |
| ------------- | -------------- | --------------------------- | --------------------------------------- |
| `id`          | `serial`       | PRIMARY KEY                 |                                         |
| `fixture_id`  | `integer`      | FK -> fixtures.id, NOT NULL | Match reference                         |
| `team_id`     | `integer`      | FK -> teams.id, NOT NULL    | Team reference                          |
| `formation`   | `varchar(20)`  |                             | e.g., "4-3-3", "3-5-2"                  |
| `coach_id`    | `integer`      |                             | API-Football coach ID                   |
| `coach_name`  | `varchar(255)` |                             | Coach full name                         |
| `coach_photo` | `varchar(500)` |                             | Coach photo URL                         |
| `start_xi`    | `jsonb`        |                             | Array of starting players (see below)   |
| `substitutes` | `jsonb`        |                             | Array of bench players (same structure) |
| `team_colors` | `jsonb`        |                             | Kit colors (see below)                  |
| `created_at`  | `timestamp`    | DEFAULT now()               |                                         |
| `updated_at`  | `timestamp`    | DEFAULT now()               |                                         |

**JSONB: `start_xi` / `substitutes`**

```json
[
  { "id": 882, "name": "D. Raya", "number": 22, "pos": "G", "grid": "1:1" },
  { "id": 1100, "name": "B. Saka", "number": 7, "pos": "F", "grid": "1:4" }
]
```

**JSONB: `team_colors`**

```json
{
  "player": { "primary": "#FF0000", "number": "#FFFFFF", "border": "#000000" },
  "goalkeeper": {
    "primary": "#00FF00",
    "number": "#000000",
    "border": "#FFFFFF"
  }
}
```

**Indexes:**

- `idx_fixture_lineups_fixture` on `fixture_id`
- `idx_fixture_lineups_team` on `team_id`

**Unique constraint:** `(fixture_id, team_id)` — one lineup per team per match.

**Migration:** `src/database/migrations/0003_fixture_lineups.sql`

---

### 6. injuries

Current injuries from API-Football.

| Column        | Type           | Constraints                 | Description                                                                   |
| ------------- | -------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `id`          | `serial`       | PRIMARY KEY                 |                                                                               |
| `player_id`   | `integer`      | NOT NULL                    | API-Football player ID                                                        |
| `player_name` | `varchar(255)` | NOT NULL                    |                                                                               |
| `team_id`     | `integer`      | FK -> teams.id, NOT NULL    |                                                                               |
| `fixture_id`  | `integer`      | FK -> fixtures.id, NULLABLE | Specific fixture if applicable. Set to NULL if fixture not in DB (FK safety). |
| `league_id`   | `integer`      |                             |                                                                               |
| `type`        | `varchar(100)` |                             | e.g., "Missing Fixture"                                                       |
| `reason`      | `varchar(255)` |                             | e.g., "Hamstring Injury"                                                      |
| `created_at`  | `timestamp`    | DEFAULT now()               |                                                                               |
| `updated_at`  | `timestamp`    | DEFAULT now()               |                                                                               |

**Indexes:**

- `idx_injuries_team` on `team_id`
- `idx_injuries_fixture` on `fixture_id`

> **Note:** Injuries referencing fixtures not in the local database are inserted with `fixture_id = NULL` to avoid FK constraint violations.

---

### 7. team_form

Rolling team form calculated from standings/recent results.

| Column                 | Type           | Constraints              | Description                       |
| ---------------------- | -------------- | ------------------------ | --------------------------------- |
| `id`                   | `serial`       | PRIMARY KEY              |                                   |
| `team_id`              | `integer`      | FK -> teams.id, NOT NULL |                                   |
| `league_id`            | `integer`      | NOT NULL                 |                                   |
| `season`               | `integer`      | NOT NULL                 |                                   |
| `form_string`          | `varchar(20)`  |                          | e.g., "WWDLW"                     |
| `last_5_wins`          | `integer`      |                          |                                   |
| `last_5_draws`         | `integer`      |                          |                                   |
| `last_5_losses`        | `integer`      |                          |                                   |
| `last_5_goals_for`     | `integer`      |                          |                                   |
| `last_5_goals_against` | `integer`      |                          |                                   |
| `home_wins`            | `integer`      |                          | Season total                      |
| `home_draws`           | `integer`      |                          |                                   |
| `home_losses`          | `integer`      |                          |                                   |
| `away_wins`            | `integer`      |                          |                                   |
| `away_draws`           | `integer`      |                          |                                   |
| `away_losses`          | `integer`      |                          |                                   |
| `goals_for_avg`        | `numeric(5,2)` |                          | Season average                    |
| `goals_against_avg`    | `numeric(5,2)` |                          | Season average                    |
| `clean_sheets`         | `integer`      |                          |                                   |
| `failed_to_score`      | `integer`      |                          |                                   |
| `attack_rating`        | `varchar(10)`  |                          | API-Football rating (e.g., "85%") |
| `defense_rating`       | `varchar(10)`  |                          | API-Football rating               |
| `league_position`      | `integer`      |                          | Current league position           |
| `points`               | `integer`      |                          | Current points                    |
| `updated_at`           | `timestamp`    | DEFAULT now()            |                                   |

**Indexes:**

- `idx_team_form_team_league` on `team_id, league_id, season`

**Unique constraint:** `(team_id, league_id, season)`

---

### 8. predictions

AI-generated match predictions with accuracy tracking.

| Column                 | Type           | Constraints                 | Description                                    |
| ---------------------- | -------------- | --------------------------- | ---------------------------------------------- |
| `id`                   | `serial`       | PRIMARY KEY                 |                                                |
| `fixture_id`           | `integer`      | FK -> fixtures.id, NOT NULL | Match reference                                |
| `home_team_id`         | `integer`      | FK -> teams.id              | Home team reference                            |
| `away_team_id`         | `integer`      | FK -> teams.id              | Away team reference                            |
| `home_win_prob`        | `numeric(5,4)` | NOT NULL                    | Home win probability (0.0000-1.0000)           |
| `draw_prob`            | `numeric(5,4)` | NOT NULL                    | Draw probability                               |
| `away_win_prob`        | `numeric(5,4)` | NOT NULL                    | Away win probability                           |
| `predicted_home_goals` | `numeric(3,1)` |                             | Predicted home goals (e.g., 1.5)               |
| `predicted_away_goals` | `numeric(3,1)` |                             | Predicted away goals                           |
| `confidence`           | `integer`      |                             | 1-10 confidence scale                          |
| `prediction_type`      | `varchar(20)`  | NOT NULL                    | `daily`, `pre_match`, or `on_demand`           |
| `key_factors`          | `jsonb`        |                             | Key factors driving the prediction             |
| `risk_factors`         | `jsonb`        |                             | Risk factors and caveats                       |
| `value_bets`           | `jsonb`        |                             | Identified value betting opportunities         |
| `match_context`        | `jsonb`        |                             | Contextual match information                   |
| `research_context`     | `jsonb`        |                             | Perplexity research results                    |
| `detailed_analysis`    | `text`         |                             | Full Claude analysis text                      |
| `model_version`        | `varchar(50)`  |                             | Model version identifier                       |
| `actual_home_goals`    | `integer`      |                             | Actual home goals (post-match)                 |
| `actual_away_goals`    | `integer`      |                             | Actual away goals (post-match)                 |
| `actual_result`        | `varchar(20)`  |                             | `home_win`, `draw`, or `away_win` (post-match) |
| `was_correct`          | `boolean`      |                             | Whether predicted result matched actual        |
| `probability_accuracy` | `numeric(8,6)` |                             | Brier score (lower = better, range 0-2)        |
| `resolved_at`          | `timestamp`    |                             | When prediction was resolved                   |
| `created_at`           | `timestamp`    | DEFAULT now(), NOT NULL     |                                                |
| `updated_at`           | `timestamp`    |                             |                                                |

**Indexes:**

- `idx_predictions_fixture` on `fixture_id`
- `idx_predictions_type` on `prediction_type`
- `idx_predictions_confidence` on `confidence`
- `idx_predictions_created` on `created_at`
- `idx_predictions_resolved` on `resolved_at`

**Unique constraint:** `(fixture_id, prediction_type)` — one prediction per type per match.

**Resolution flow:** After a match finishes (status = FT), the `resolvePredictions()` method:

1. Reads actual goals from the fixture
2. Determines actual result (home_win / draw / away_win)
3. Compares against predicted result (highest probability outcome)
4. Calculates 3-outcome Brier score: `sum((prob - actual)^2)` for home/draw/away
5. Updates the prediction row with all accuracy fields

---

### 9. alerts

Alerts generated for high-confidence predictions, live events, and lineup changes.

| Column          | Type           | Constraints             | Description                                                   |
| --------------- | -------------- | ----------------------- | ------------------------------------------------------------- |
| `id`            | `serial`       | PRIMARY KEY             |                                                               |
| `prediction_id` | `integer`      | FK -> predictions.id    | Source prediction (nullable)                                  |
| `fixture_id`    | `integer`      | FK -> fixtures.id       | Related fixture                                               |
| `type`          | `varchar(50)`  | NOT NULL                | `high_confidence`, `value_bet`, `live_event`, `lineup_change` |
| `severity`      | `varchar(20)`  | NOT NULL                | `low`, `medium`, `high`, `critical`                           |
| `title`         | `varchar(500)` | NOT NULL                | Alert headline                                                |
| `message`       | `text`         | NOT NULL                | Detailed alert message                                        |
| `data`          | `jsonb`        |                         | Structured alert data                                         |
| `acknowledged`  | `boolean`      | DEFAULT false           | Whether user has seen it                                      |
| `created_at`    | `timestamp`    | DEFAULT now(), NOT NULL |                                                               |

**Alert Types:**

- `high_confidence` — Prediction with confidence >= 7 (high) or >= 9 (critical)
- `value_bet` — Value betting opportunity detected
- `live_event` — Goal, red card, or match end detected during live monitoring
- `lineup_change` — Confirmed lineups published for upcoming match

**Indexes:**

- `idx_alerts_prediction` on `prediction_id`
- `idx_alerts_type` on `type`
- `idx_alerts_severity` on `severity`
- `idx_alerts_created` on `created_at DESC`
- `idx_alerts_unacknowledged` on `acknowledged` WHERE `acknowledged = false`

---

### 10. bookmaker_odds

Odds snapshots from The Odds API.

| Column                  | Type           | Constraints             | Description                                      |
| ----------------------- | -------------- | ----------------------- | ------------------------------------------------ |
| `id`                    | `serial`       | PRIMARY KEY             |                                                  |
| `odds_api_event_id`     | `varchar(255)` | NOT NULL                | The Odds API event ID                            |
| `sport_key`             | `varchar(100)` | NOT NULL                | e.g., "soccer_epl"                               |
| `home_team`             | `varchar(255)` | NOT NULL                | Home team name (as reported by Odds API)         |
| `away_team`             | `varchar(255)` | NOT NULL                | Away team name                                   |
| `commence_time`         | `timestamp`    | NOT NULL                | Match start time                                 |
| `bookmaker_key`         | `varchar(100)` | NOT NULL                | e.g., "pinnacle"                                 |
| `bookmaker_name`        | `varchar(255)` |                         | e.g., "Pinnacle"                                 |
| `market_key`            | `varchar(100)` | NOT NULL                | e.g., "h2h", "totals"                            |
| `outcomes`              | `jsonb`        | NOT NULL                | Array of outcome objects with name, price, point |
| `implied_probabilities` | `jsonb`        |                         | Calculated implied probabilities (with vig)      |
| `true_probabilities`    | `jsonb`        |                         | Normalized probabilities (vig removed)           |
| `overround`             | `numeric(8,4)` |                         | Total overround for this bookmaker/market        |
| `last_update`           | `timestamp`    |                         | Bookmaker's last update time                     |
| `recorded_at`           | `timestamp`    | DEFAULT now(), NOT NULL | When we captured this snapshot                   |

**Indexes:**

- `idx_bookmaker_odds_event` on `odds_api_event_id`
- `idx_bookmaker_odds_sport` on `sport_key, commence_time`
- `idx_bookmaker_odds_bookmaker` on `bookmaker_key`
- `idx_bookmaker_odds_recorded` on `recorded_at DESC`

---

### 11. consensus_odds

Pre-calculated weighted consensus probabilities across all bookmakers.

| Column               | Type           | Constraints             | Description                      |
| -------------------- | -------------- | ----------------------- | -------------------------------- |
| `id`                 | `serial`       | PRIMARY KEY             |                                  |
| `odds_api_event_id`  | `varchar(255)` | NOT NULL                | The Odds API event ID            |
| `sport_key`          | `varchar(100)` | NOT NULL                |                                  |
| `home_team`          | `varchar(255)` | NOT NULL                |                                  |
| `away_team`          | `varchar(255)` | NOT NULL                |                                  |
| `commence_time`      | `timestamp`    | NOT NULL                |                                  |
| `market_key`         | `varchar(100)` | NOT NULL                | e.g., "h2h"                      |
| `consensus_home_win` | `numeric(8,4)` |                         | Weighted probability of home win |
| `consensus_draw`     | `numeric(8,4)` |                         | Weighted probability of draw     |
| `consensus_away_win` | `numeric(8,4)` |                         | Weighted probability of away win |
| `consensus_over`     | `numeric(8,4)` |                         | For totals market                |
| `consensus_under`    | `numeric(8,4)` |                         | For totals market                |
| `consensus_point`    | `numeric(5,2)` |                         | e.g., 2.5 for over/under         |
| `pinnacle_home_win`  | `numeric(8,4)` |                         | Pinnacle-specific (sharpest)     |
| `pinnacle_draw`      | `numeric(8,4)` |                         |                                  |
| `pinnacle_away_win`  | `numeric(8,4)` |                         |                                  |
| `num_bookmakers`     | `integer`      |                         | How many bookmakers contributed  |
| `calculated_at`      | `timestamp`    | DEFAULT now(), NOT NULL |                                  |

**Indexes:**

- `idx_consensus_event_market` on `odds_api_event_id, market_key`
- `idx_consensus_time` on `calculated_at DESC`

---

### 12. polymarket_events

Stores Polymarket event containers (an event can have multiple markets).

| Column        | Type            | Constraints      | Description                            |
| ------------- | --------------- | ---------------- | -------------------------------------- |
| `id`          | `varchar(255)`  | PRIMARY KEY      | Polymarket event ID                    |
| `slug`        | `varchar(500)`  | NOT NULL, UNIQUE | URL slug                               |
| `title`       | `text`          | NOT NULL         | Event title                            |
| `description` | `text`          |                  | Full description / resolution criteria |
| `start_date`  | `timestamp`     |                  | Event start date                       |
| `end_date`    | `timestamp`     |                  | Event end / resolution date            |
| `active`      | `boolean`       | DEFAULT true     | Whether event is active                |
| `closed`      | `boolean`       | DEFAULT false    | Whether event has resolved             |
| `liquidity`   | `numeric(18,2)` |                  | Total liquidity across all markets     |
| `volume`      | `numeric(18,2)` |                  | Total volume traded                    |
| `volume_24hr` | `numeric(18,2)` |                  | 24-hour trading volume                 |
| `tags`        | `jsonb`         |                  | Array of tag objects                   |
| `raw_data`    | `jsonb`         |                  | Full API response for reference        |
| `created_at`  | `timestamp`     | DEFAULT now()    |                                        |
| `updated_at`  | `timestamp`     | DEFAULT now()    |                                        |

**Indexes:**

- `idx_polymarket_events_slug` on `slug`
- `idx_polymarket_events_active` on `active, closed`
- `idx_polymarket_events_tags` GIN index on `tags`

---

### 13. polymarket_markets

Individual binary markets within a Polymarket event.

| Column           | Type            | Constraints                | Description                |
| ---------------- | --------------- | -------------------------- | -------------------------- |
| `id`             | `varchar(255)`  | PRIMARY KEY                | Polymarket market ID       |
| `event_id`       | `varchar(255)`  | FK -> polymarket_events.id | Parent event               |
| `question`       | `text`          | NOT NULL                   | Market question            |
| `slug`           | `varchar(500)`  |                            | URL slug                   |
| `condition_id`   | `varchar(255)`  | UNIQUE                     | CTF condition identifier   |
| `question_id`    | `varchar(255)`  |                            | Resolution question hash   |
| `outcomes`       | `jsonb`         | NOT NULL                   | e.g., ["Yes", "No"]        |
| `outcome_prices` | `jsonb`         | NOT NULL                   | e.g., ["0.35", "0.65"]     |
| `clob_token_ids` | `jsonb`         | NOT NULL                   | Token IDs for each outcome |
| `volume`         | `numeric(18,2)` |                            | Total volume               |
| `volume_24hr`    | `numeric(18,2)` |                            | 24-hour volume             |
| `liquidity`      | `numeric(18,2)` |                            | Current liquidity          |
| `spread`         | `numeric(8,4)`  |                            | Current bid-ask spread     |
| `active`         | `boolean`       | DEFAULT true               | Accepting trades           |
| `closed`         | `boolean`       | DEFAULT false              | Resolved                   |
| `market_type`    | `varchar(50)`   |                            | Classification             |
| `raw_data`       | `jsonb`         |                            | Full API response          |
| `created_at`     | `timestamp`     | DEFAULT now()              |                            |
| `updated_at`     | `timestamp`     | DEFAULT now()              |                            |

---

### 14. polymarket_price_history

Time-series price snapshots for Polymarket probability tracking.

| Column        | Type            | Constraints                           | Description                     |
| ------------- | --------------- | ------------------------------------- | ------------------------------- |
| `id`          | `serial`        | PRIMARY KEY                           |                                 |
| `market_id`   | `varchar(255)`  | FK -> polymarket_markets.id, NOT NULL | Market reference                |
| `yes_price`   | `numeric(8,4)`  | NOT NULL                              | Yes outcome price (0.00 - 1.00) |
| `no_price`    | `numeric(8,4)`  | NOT NULL                              | No outcome price                |
| `midpoint`    | `numeric(8,4)`  |                                       | Midpoint price                  |
| `spread`      | `numeric(8,4)`  |                                       | Bid-ask spread                  |
| `volume_24hr` | `numeric(18,2)` |                                       | 24hr volume                     |
| `liquidity`   | `numeric(18,2)` |                                       | Liquidity                       |
| `recorded_at` | `timestamp`     | DEFAULT now(), NOT NULL               | Snapshot timestamp              |

---

### 15. market_fixture_links

Maps Polymarket markets to real soccer fixtures.

| Column                 | Type           | Constraints                           | Description                               |
| ---------------------- | -------------- | ------------------------------------- | ----------------------------------------- |
| `id`                   | `serial`       | PRIMARY KEY                           |                                           |
| `polymarket_market_id` | `varchar(255)` | FK -> polymarket_markets.id, NOT NULL |                                           |
| `fixture_id`           | `integer`      | FK -> fixtures.id                     | For match outcome markets                 |
| `odds_api_event_id`    | `varchar(255)` |                                       | Corresponding Odds API event              |
| `league_id`            | `integer`      |                                       | For season-long markets                   |
| `team_id`              | `integer`      | FK -> teams.id                        | For team-specific markets                 |
| `match_type`           | `varchar(50)`  | NOT NULL                              | match_outcome, league_winner, etc.        |
| `match_confidence`     | `numeric(5,2)` |                                       | How confident we are in the match (0-100) |
| `match_method`         | `varchar(50)`  |                                       | auto_fuzzy, auto_exact, manual            |
| `mapped_outcome`       | `varchar(100)` |                                       | Which outcome the Yes token maps to       |
| `verified`             | `boolean`      | DEFAULT false                         | Manually verified by operator             |
| `created_at`           | `timestamp`    | DEFAULT now()                         |                                           |
| `updated_at`           | `timestamp`    | DEFAULT now()                         |                                           |

---

### 16. sync_log

Tracks data synchronization status and history.

| Column              | Type           | Constraints | Description                         |
| ------------------- | -------------- | ----------- | ----------------------------------- |
| `id`                | `serial`       | PRIMARY KEY |                                     |
| `source`            | `varchar(50)`  | NOT NULL    | polymarket, api_football, odds_api  |
| `task`              | `varchar(100)` | NOT NULL    | e.g., sync_fixtures, sync_standings |
| `status`            | `varchar(20)`  | NOT NULL    | started, completed, failed          |
| `records_processed` | `integer`      |             | Number of records synced            |
| `error_message`     | `text`         |             | Error details if failed             |
| `api_requests_used` | `integer`      |             | API requests consumed               |
| `duration_ms`       | `integer`      |             | How long the sync took              |
| `started_at`        | `timestamp`    | NOT NULL    |                                     |
| `completed_at`      | `timestamp`    |             |                                     |

---

## Migrations Strategy

- Use Drizzle Kit for generating and running migrations
- Name migrations with timestamp prefix: `0001_create_polymarket_tables.sql`
- Always create migrations for schema changes (never modify database directly)
- Keep migration files in `src/database/migrations/`
- Use `pnpm run db:push` to push schema changes directly (development)
- Use `pnpm run db:generate` + `pnpm run db:migrate` for production migrations
