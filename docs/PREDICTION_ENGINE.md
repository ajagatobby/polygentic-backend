# Prediction Engine

## Overview

The prediction engine uses a **3-agent AI pipeline** to generate structured match predictions for every tracked fixture. Each prediction includes win/draw/loss probabilities, expected goals, confidence rating, key factors, risk factors, value bets, and a detailed written analysis.

The pipeline runs via **Trigger.dev** for durable execution with automatic retries.

---

## Pipeline Architecture

```
           +--------------------+
           | DataCollectorAgent |
           | (Gather all data)  |
           +---------+----------+
                     |
                     v
           +--------------------+
           |  ResearchAgent     |
           | (Perplexity Sonar) |
           +---------+----------+
                     |
                     v
           +--------------------+
           |  AnalysisAgent     |
           | (Anthropic Claude) |
           +---------+----------+
                     |
                     v
           +--------------------+     +------------------+
           |  Store Prediction  +---->|  Create Alert    |
           |  (PostgreSQL)      |     |  (if high conf)  |
           +--------------------+     +------------------+
```

---

## Agent 1: DataCollectorAgent

**File:** `src/agents/data-collector.agent.ts`

Collects all available data for a fixture from multiple sources in parallel.

### Data Sources

| Source       | Data Collected                                       | Method                                 |
| ------------ | ---------------------------------------------------- | -------------------------------------- |
| Database     | Fixture details (teams, date, venue, round)          | Direct DB query                        |
| Database     | Confirmed lineups (formation, startXI, bench, coach) | `getLineupsForFixture()` — DB first    |
| API-Football | Lineups (fallback if not in DB)                      | `fetchLineups()`                       |
| API-Football | Head-to-head history (last 10 meetings)              | `/fixtures/headtohead`                 |
| API-Football | Injuries & suspensions (both teams)                  | DB query by team                       |
| API-Football | Team form (last 5, home/away records, goals)         | DB `team_form` table                   |
| API-Football | Built-in prediction (percent, advice, comparison)    | `/predictions`                         |
| The Odds API | Bookmaker odds + consensus probability               | DB `bookmaker_odds` + `consensus_odds` |

### Lineup Strategy

1. **Check database first** via `getLineupsForFixture(fixtureId)` — reads from the `fixture_lineups` table where lineups are persisted by the lineup-prediction task ~60 minutes before kickoff.
2. **Fall back to live API** only if no persisted lineups exist — calls API-Football `/fixtures/lineups`.
3. **Reshape DB format** to match the API response structure expected by downstream agents.

### Output

Returns a `CollectedMatchData` object containing all gathered data, passed to the ResearchAgent.

---

## Agent 2: ResearchAgent (Perplexity Sonar)

**File:** `src/agents/research.agent.ts`

Performs real-time web research using Perplexity Sonar to gather context that isn't available from structured APIs.

### Research Focus

- Recent team news and press conferences
- Tactical analysis and formation changes
- Transfer activity and squad changes
- Player fitness and late injury updates
- Weather and pitch conditions
- Historical matchup narrative and rivalry context
- Manager quotes and team motivation
- Referee tendencies and VAR history

### How It Works

1. Constructs a research prompt from the collected match data (teams, date, competition, key players)
2. Sends to Perplexity Sonar API for grounded web search
3. Returns structured research context with citations
4. Research results are stored in the prediction's `research_context` JSONB field

---

## Agent 3: AnalysisAgent (Anthropic Claude)

**File:** `src/agents/analysis.agent.ts`

Takes all collected data and research context, produces a structured prediction via Claude.

### Input

- Fixture details (teams, venue, date, round, competition)
- Team form (last 5 results, home/away records, goal averages)
- Head-to-head history
- Injury reports for both teams
- Confirmed lineups (if available)
- Bookmaker odds and consensus probabilities
- API-Football prediction
- Perplexity research context

### Output (Structured)

| Field                | Type    | Description                            |
| -------------------- | ------- | -------------------------------------- |
| `homeWinProb`        | decimal | Home win probability (0.0000 - 1.0000) |
| `drawProb`           | decimal | Draw probability                       |
| `awayWinProb`        | decimal | Away win probability                   |
| `predictedHomeGoals` | decimal | Expected home goals (e.g., 1.5)        |
| `predictedAwayGoals` | decimal | Expected away goals                    |
| `confidence`         | integer | 1-10 confidence scale                  |
| `keyFactors`         | json[]  | Key factors driving the prediction     |
| `riskFactors`        | json[]  | Risk factors and caveats               |
| `valueBets`          | json[]  | Identified value betting opportunities |
| `matchContext`       | json    | Contextual match information           |
| `detailedAnalysis`   | text    | Full written analysis (paragraph form) |

### Constraints

- Probabilities must sum to 1.0
- Confidence must be 1-10
- Key factors and risk factors are arrays of strings
- Value bets include market, odds, and edge percentage
- Analysis must reference specific data points

---

## Prediction Types

| Type        | Trigger                                          | Timing       | Description                                                         |
| ----------- | ------------------------------------------------ | ------------ | ------------------------------------------------------------------- |
| `daily`     | `scheduled-daily-predictions` (6 AM UTC)         | T-48h to T-0 | First prediction for upcoming fixtures. Generated without lineups.  |
| `pre_match` | `scheduled-pre-match-predictions` (every 15 min) | T-1h         | Latest data capture before kickoff. May replace `daily` prediction. |
| `on_demand` | Manual API call                                  | Anytime      | Ad-hoc prediction for a specific fixture.                           |

### Lineup-Aware Regeneration

The `scheduled-lineup-prediction` task (every 5 minutes) checks fixtures within 90 minutes for newly published lineups:

1. **Detect**: Query API-Football `/fixtures/lineups` for upcoming fixtures
2. **Persist**: Save confirmed lineups to `fixture_lineups` table (formation, startXI, bench, coach, team colors)
3. **Check**: Has this fixture already been predicted with a `pre_match` type?
4. **Regenerate**: If yes, re-run the full 3-agent pipeline with the confirmed lineup data
5. **Upsert**: Update the existing prediction row with lineup-enriched analysis
6. **Alert**: Create a `lineup_change` alert with formations for both teams

This ensures predictions always use the most accurate team sheet data available.

---

## Prediction Resolution

After a match completes (status = FT, AET, or PEN), predictions are automatically resolved.

### Resolution Flow

**Trigger:** Two paths:

1. **Immediate**: `LiveEventHandler` detects `match-end` event during live monitoring -> triggers Trigger.dev `sync-completed-fixtures-and-resolve` task
2. **Hourly backup**: `scheduled-sync-and-resolve` task runs every hour at `:00`

**Steps:**

1. `syncCompletedFixtures()` — Fetch recently completed fixtures (last 2 days) from API-Football, update DB with final status/scores
2. `resolvePredictions()` — Find all unresolved predictions where the linked fixture has status FT:

```
For each unresolved prediction:
  1. Read actual goals from fixture (goalsHome, goalsAway)
  2. Determine actual result:
     - goalsHome > goalsAway → "home_win"
     - goalsHome < goalsAway → "away_win"
     - goalsHome == goalsAway → "draw"
  3. Determine predicted result (highest probability among homeWinProb, drawProb, awayWinProb)
  4. wasCorrect = (predictedResult === actualResult)
  5. Calculate Brier score (3-outcome):
     brierScore = (homeWinProb - homeActual)^2 + (drawProb - drawActual)^2 + (awayWinProb - awayActual)^2
     where homeActual/drawActual/awayActual are 1 or 0
  6. Update prediction row:
     - actualHomeGoals, actualAwayGoals
     - actualResult
     - wasCorrect
     - probabilityAccuracy (Brier score)
     - resolvedAt
```

### Accuracy Metrics

| Metric               | Description                                                               | Target                     |
| -------------------- | ------------------------------------------------------------------------- | -------------------------- |
| **Overall accuracy** | % of predictions where wasCorrect = true                                  | > 50%                      |
| **Brier score**      | Mean Brier score across all resolved predictions (0 = perfect, 2 = worst) | < 0.60                     |
| **By type accuracy** | Accuracy broken down by daily vs pre_match                                | pre_match should be higher |

The `getAccuracyStats()` method on `AgentsService` returns these metrics.

---

## Confidence Scoring

Claude assigns a confidence score from 1-10 based on:

| Factor               | Impact | Description                                                         |
| -------------------- | ------ | ------------------------------------------------------------------- |
| Data completeness    | High   | Are lineups, form, injuries, odds all available?                    |
| Signal agreement     | High   | Do bookmaker odds, form data, and H2H all point the same direction? |
| Match predictability | Medium | Is this a clear favorite vs underdog, or a toss-up?                 |
| Competition stage    | Medium | Group stage (more predictable) vs knockout (more variable)          |
| Sample size          | Medium | Enough recent matches to assess form?                               |
| Research quality     | Low    | Did Perplexity find relevant, recent context?                       |

### Alert Thresholds

| Confidence | Alert             | Severity   |
| ---------- | ----------------- | ---------- |
| 9-10       | `high_confidence` | `critical` |
| 7-8        | `high_confidence` | `high`     |
| 5-6        | None              | —          |
| 1-4        | None              | —          |

---

## Timeline: What Happens for a Typical Match

```
T-48h    [6 AM daily cron]     daily prediction generated (without lineups)
T-24h    [standings cron]      league tables refreshed
T-2h     [injuries cron]       latest injury data synced
T-1h     [pre-match cron]      pre_match prediction generated (latest data)
T-55min  [lineup cron]         lineups detected → persisted to DB → prediction re-generated
T-0      [live polling]        match-start → fixture status updated to 1H
T+25'    [live polling]        goal → score updated in DB, alert created
T+45'    [live polling]        status-change → HT, polling slows to 60s
T+46'    [live polling]        status-change → 2H, polling returns to 30s
T+90'    [live polling]        match-end → final score persisted, immediate resolution triggered
T+90'    [Trigger.dev]         prediction resolved (wasCorrect, Brier score, actualResult)
T+1h     [hourly cron]         backup resolution for any matches missed by live monitoring
```

---

## Trigger.dev Task Architecture

All prediction tasks run via Trigger.dev for durable execution.

### Task Dependency Graph

```
scheduled-daily-predictions (6 AM UTC)
  └─> generate-daily-predictions
        └─> generate-prediction (×N, one per fixture)
              ├─> DataCollectorAgent.collect()
              ├─> ResearchAgent.research()
              └─> AnalysisAgent.analyze()

scheduled-pre-match-predictions (every 15 min)
  └─> generate-pre-match-predictions
        └─> generate-prediction (×N)

scheduled-lineup-prediction (every 5 min)
  └─> lineup-aware-prediction
        ├─> fetchAndPersistLineups()
        ├─> createLineupAlert()
        └─> generate-prediction (×N, only fixtures with new lineups)

scheduled-sync-and-resolve (every hour)
  └─> sync-completed-fixtures-and-resolve
        ├─> Step 1: syncCompletedFixtures()
        └─> Step 2: resolvePredictions()
```

### Retry Configuration

```
Max attempts: 3
Min timeout: 1,000ms
Max timeout: 10,000ms
Backoff factor: 2
Randomize: true
Max task duration: 3,600s (1 hour)
```

---

## Standalone Bootstrapping

Trigger.dev tasks run **outside NestJS DI** in separate worker processes. The `src/trigger/init.ts` file bootstraps standalone instances of the services needed by the pipeline (FootballService, AgentsService, etc.) with their own database connections.

---

## Future Improvements

| Improvement                | Impact                                                  | Complexity |
| -------------------------- | ------------------------------------------------------- | ---------- |
| **Fine-tuned model**       | Train on historical predictions for better calibration  | High       |
| **xG-weighted analysis**   | Use expected goals more prominently in prediction       | Medium     |
| **Multi-model ensemble**   | Run multiple Claude prompts and average predictions     | Medium     |
| **Lineup impact scoring**  | Quantify how much confirmed lineups change predictions  | Medium     |
| **Kelly criterion sizing** | Optimal bet sizing based on edge and confidence         | Low        |
| **Prediction caching**     | Skip re-generation if data hasn't changed significantly | Low        |
