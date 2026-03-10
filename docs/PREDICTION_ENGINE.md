# Prediction Engine

## Overview

The prediction engine uses a **multi-signal ensemble architecture** to generate calibrated match predictions for every tracked fixture. Each prediction includes win/draw/loss probabilities, expected goals, confidence rating, key factors, risk factors, value bets, and a detailed written analysis.

The system combines **four independent prediction signals** — Claude AI analysis, Dixon-Coles Poisson model, bookmaker consensus odds, and quantified player impact scoring — through a weighted ensemble with post-processing calibration layers for draw correction and overconfidence dampening.

The pipeline runs via **Trigger.dev** for durable execution with automatic retries.

---

## Pipeline Architecture

```
           +--------------------+
           | DataCollectorAgent |
           | (Gather all data)  |
           +---------+----------+
                     |
              +------+------+
              |             |
              v             v
    +------------------+  +---------------------+
    | PlayerImpact     |  | ResearchAgent       |
    | Service          |  | (Perplexity Sonar)  |
    | (Injury scoring) |  | (3 parallel searches)|
    +--------+---------+  +---------+-----------+
             |                      |
             v                      v
    +------------------+  +--------------------+
    | PoissonModel     |  |  AnalysisAgent     |
    | (Dixon-Coles)    |  | (Anthropic Claude) |
    | (xG-adjusted)    |  | (structured output)|
    +--------+---------+  +---------+----------+
             |                      |
             +----------+-----------+
                        |
                        v
             +---------------------+
             |  Ensemble Blender   |
             | (40% Odds + 30%     |
             |  Poisson + 30% AI)  |
             +----------+----------+
                        |
                        v
             +---------------------+
             |  Calibration Layer  |
             | (Draw floors, caps, |
             |  dampening, conf)   |
             +----------+----------+
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

| Source       | Data Collected                                                              | Method                                    |
| ------------ | --------------------------------------------------------------------------- | ----------------------------------------- |
| Database     | Fixture details (teams, date, venue, round)                                 | Direct DB query                           |
| Database     | Confirmed lineups (formation, startXI, bench, coach)                        | `getLineupsForFixture()` — DB first       |
| Database     | Advanced stats (last 10 matches: xG, xGA, shots, possession, pass accuracy) | `getTeamRecentStats()` — rolling averages |
| Database     | xG overperformance/underperformance flags                                   | Computed from actual goals vs xG          |
| API-Football | Lineups (fallback if not in DB)                                             | `fetchLineups()`                          |
| API-Football | Head-to-head history (last 10 meetings)                                     | `/fixtures/headtohead`                    |
| API-Football | Injuries & suspensions (both teams)                                         | DB query by team                          |
| API-Football | Team form (last 5, home/away records, goals)                                | DB `team_form` table                      |
| API-Football | Built-in prediction (percent, advice, comparison)                           | `/predictions`                            |
| The Odds API | Bookmaker odds + consensus probability                                      | DB `bookmaker_odds` + `consensus_odds`    |

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

## Player Impact Scoring

**File:** `src/agents/player-impact.service.ts`

Quantifies the importance of injured/absent players using historical match data, replacing the previous approach of just passing player names to Claude.

### How It Works

1. For each injured player, queries `fixture_events` to count goals and assists over the last 15 league matches
2. Queries `fixture_lineups` to determine if they're a regular starter (appeared in 60%+ of matches)
3. Computes an **impact score** (0-1):
   - 50% weight: goal involvement rate (player's G+A / team total goals)
   - 30% weight: starter status (regulars are harder to replace)
   - 20% weight: position criticality (FW > MF > DF > GK for offensive impact)
4. Maps absence type to probability: Missing/Suspended = 100%, Doubtful = 75%, Questionable = 50%
5. Aggregates into team-level **xG/xGA multipliers**

### Impact Labels

| Label    | Score Range | Example                                                |
| -------- | ----------- | ------------------------------------------------------ |
| CRITICAL | >= 0.60     | Top scorer with 40%+ goal involvement                  |
| HIGH     | 0.40-0.60   | Key midfielder, regular starter, 20%+ goal involvement |
| MODERATE | 0.25-0.40   | Regular starter with moderate output                   |
| LOW      | 0.10-0.25   | Rotation player or defensive specialist                |
| MINIMAL  | < 0.10      | Bench player or reserve                                |

### Team-Level Aggregation

- **xG multiplier**: `max(0.70, 1.0 - offensive_impact)` — e.g. losing a striker with 35% goal involvement = xG × 0.83
- **xGA multiplier**: `min(1.30, 1.0 + defensive_impact)` — e.g. losing first-choice GK = xGA × 1.15
- These multipliers feed directly into the Poisson model's expected goals calculation

---

## Poisson Statistical Model (Dixon-Coles)

**File:** `src/agents/poisson-model.service.ts`

An independent statistical model that runs in parallel with Claude analysis.

### Method

1. **Team strength estimation**: attack/defense ratings relative to league average using xG data (falls back to actual goals if xG unavailable)
2. **Expected goals**: `home_xG = league_avg × home_attack × away_defense × home_advantage`
3. **Player impact adjustment**: expected goals multiplied by absence-driven xG/xGA multipliers
4. **Probability matrix**: 8×8 scoreline grid using Poisson PMF
5. **Dixon-Coles correction**: low-scoring adjustment (0-0, 1-0, 0-1, 1-1 occur at different rates than independent Poisson predicts)
6. **Recency weighting**: exponential decay with half-life of 8 matches (recent form weighted heavier)

### Confidence Scoring

- xG availability: 0.35 (both teams have xG data) or 0.15 (one team)
- Match count factor: scales from 0 to 0.45 (saturates at 20 data points)
- Base: 0.2 (even basic Poisson outperforms random)

---

## Agent 3: AnalysisAgent (Multi-Provider LLM)

**File:** `src/agents/analysis.agent.ts`

Takes all collected data, research context, and quantified injury impacts, produces a structured prediction via a configurable LLM provider (Anthropic Claude or OpenAI) with adaptive thinking.

### Model Provider Support

The agent supports **auto-detection** based on the `PREDICTION_MODEL` environment variable:

| Model String      | Provider  | Type      | System Role | Temperature        | Structured Output             |
| ----------------- | --------- | --------- | ----------- | ------------------ | ----------------------------- |
| `claude-*`        | Anthropic | Standard  | `system`    | `temperature`      | `tool_use` with JSON schema   |
| `o3`, `o4-mini`   | OpenAI    | Reasoning | `developer` | `reasoning_effort` | `response_format.json_schema` |
| `gpt-5`, `gpt-4o` | OpenAI    | Standard  | `system`    | `temperature`      | `response_format.json_schema` |

**Configuration:**

```env
# In .env — set one of:
PREDICTION_MODEL=claude-sonnet-4-20250514   # Default (Anthropic)
PREDICTION_MODEL=o3                          # OpenAI reasoning model
PREDICTION_MODEL=o4-mini                     # OpenAI reasoning (cheaper)
PREDICTION_MODEL=gpt-5                       # OpenAI standard model

# Required for OpenAI models:
OPENAI_API_KEY=sk-...
```

**Key differences between providers:**

- **Anthropic**: Uses `tool_use` for structured output with `{ type: 'json', schema }` directly
- **OpenAI reasoning models** (o3, o4-mini): Use `developer` role instead of `system`, `reasoning_effort` instead of `temperature`, `max_completion_tokens` instead of `max_tokens`
- **OpenAI standard models** (gpt-5, gpt-4o): Use `system` role and `temperature` normally
- **Both OpenAI types**: Use `response_format: { type: 'json_schema', json_schema: { name, strict, schema } }` wrapper

The same system prompt, JSON schema, validation logic, and post-processing pipeline apply regardless of provider. The `polymarket-trading.agent.ts` also uses the same dual-provider pattern.

### Input

- Fixture details (teams, venue, date, round, competition)
- Team form (last 5 results, home/away records, goal averages)
- Advanced stats (10-match rolling: xG, xGA, xG differential, shots, possession, pass accuracy)
- xG overperformance/underperformance flags
- Head-to-head history (last 10 meetings)
- **Quantified injury reports** with impact scores, goal involvement stats, starter status, and position
- Confirmed lineups (if available)
- API-Football prediction
- Perplexity research context (3 parallel web searches)
- Performance feedback (self-improvement from last 500 resolved predictions)
- Prediction memories (Supermemory: past predictions for same teams/league with outcomes)

**Note:** Bookmaker odds and Poisson model output are intentionally NOT shown to Claude to avoid double-counting — they enter via the ensemble step instead.

### Analytical Process (Mandated by System Prompt)

1. **Start with base rates**: H=44% D=27% A=29%
2. **Classify match type**: TIGHT (±5% max), MODERATE (±10% max), MISMATCH (±15% max)
3. **Adjust for team strength**: xG differential as primary metric, league position secondary
4. **Apply contextual adjustments** (max ±5%): injuries (using impact scores), motivation, H2H, weather
5. **Sanity checks**: draw 0.20-0.38, no outcome > 0.65 (MISMATCH exception), probabilities sum to 1.0

### Post-Processing

- **Draw floor**: 0.22 minimum (raised from 0.18)
- **Overconfidence cap**: 0.65 maximum single probability (lowered from 0.72)
- **Dampening**: 15% pull toward mean when cap exceeded
- **Confidence compression**: Claude's 8-10 → 6, 6-7 → 5, 4-5 → 4 (addresses systematic overconfidence)

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

## Ensemble Blending

**File:** `src/agents/agents.service.ts` — `ensemblePredictions()`

Combines all three independent signals into final calibrated probabilities.

### Signal Weights (v2)

| Signal              | Weight  | Rationale                                                                                                                     |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Bookmaker consensus | **40%** | Best-calibrated signal but reduced from 50% to prevent structural favourite bias                                              |
| Poisson model       | **30%** | Mathematical, xG-based, independent from market. Weight scaled by Poisson confidence (50-100% of base)                        |
| Claude (LLM)        | **30%** | Contextual reasoning — injuries, motivation, tactical matchups. Increased from 20% to give qualitative factors more influence |

### Fallback Weights

| Available Signals | Bookmaker | Poisson     | Claude |
| ----------------- | --------- | ----------- | ------ |
| All three         | 40%       | 30% (×conf) | 30%    |
| No bookmaker      | —         | 65% (×conf) | 35%    |
| No Poisson        | 75%       | —           | 25%    |
| Only Claude       | —         | —           | 100%   |

### Post-Ensemble Calibration

Applied sequentially after blending:

1. **Tiered draw floor** — close match (max win < 0.50): floor = 0.24; moderate (< 0.60): floor = 0.22; clear favourite: floor = 0.18. Uses 70% gap closure.

2. **Competitive-match dampening** — when max probability is 0.38-0.50 (tight match), pull all probabilities 5% toward equal (1/3). Prevents false confidence in marginal favourites.

3. **Overconfidence dampening** — any single outcome > 0.70 gets pulled 10% toward the mean. Even heavy favourites lose 20-25% of the time.

4. **Confidence adjustment** — multi-factor:
   - Decisiveness cap: max prob < 0.40 → confidence capped at 4; < 0.48 → cap 5; < 0.55 → cap 6
   - Claude/bookmaker disagreement on outcome: -2 confidence
   - Large probability divergence (> 15%): -1 confidence
   - All three signals agree + max prob >= 0.50: +1 confidence bonus

### Draw Prediction Logic

**File:** `src/agents/agents.service.ts` — `getPredictedResultFromProbs()`

Pure argmax predicted draws <10% of the time (actual rate: ~26%). The new match-type aware logic:

1. Draw is highest probability → always predict draw
2. **Very tight match** (max win < 0.40, draw >= 0.30, gap < 4pp) → predict draw
3. **Competitive match** (max win <= 0.50, spread < 5pp, draw >= 0.32) → predict draw
4. Otherwise → pick the higher of home or away

This produces ~20-28% draw predictions, matching the true base rate.

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

After a match completes (status = FT, AET, or PEN), predictions are automatically resolved. Postponed, cancelled, or abandoned matches are voided.

### Prediction Lifecycle

Each prediction has a `predictionStatus` column tracking its lifecycle:

```
pending  ──→  resolved   (match completed normally: FT, AET, PEN)
pending  ──→  void       (match postponed, cancelled, or abandoned: PST, CANC, ABD, AWD, WO)
```

### Stored vs Derived Predictions

**Critical design decision:** The `predictedResult` column is written **at prediction time** and never re-derived during resolution. This prevents the "wasCorrect mismatch" bug where updated prediction logic could retroactively change what was predicted, causing correct predictions to be marked wrong.

- At prediction time: `predictedResult = getPredictedResultFromProbs(homeWinProb, drawProb, awayWinProb)`
- At resolution time: `wasCorrect = (prediction.predictedResult === actualResult)` — reads the stored value directly

### Resolution Flow

**Trigger:** Two paths:

1. **Immediate**: `LiveEventHandler` detects `match-end` event during live monitoring -> triggers Trigger.dev `sync-completed-fixtures-and-resolve` task
2. **Hourly backup**: `scheduled-sync-and-resolve` task runs every hour at `:00`

**Steps:**

1. `syncCompletedFixtures()` — Fetch recently completed fixtures (last 2 days) from API-Football, update DB with final status/scores
2. `resolvePredictions()` — Find all pending predictions where the linked fixture has a terminal status:

```
For each pending prediction:
  IF fixture.status IN ('FT', 'AET', 'PEN'):
    1. Read actual goals from fixture (goalsHome, goalsAway)
    2. Determine actual result:
       - goalsHome > goalsAway → "home_win"
       - goalsHome < goalsAway → "away_win"
       - goalsHome == goalsAway → "draw"
    3. Read stored predictedResult (set at prediction time, NOT re-derived)
    4. wasCorrect = (predictedResult === actualResult)
    5. Calculate Brier score (3-outcome):
       brierScore = (homeWinProb - homeActual)² + (drawProb - drawActual)² + (awayWinProb - awayActual)²
       where homeActual/drawActual/awayActual are 1 or 0
    6. Update prediction row:
       - actualHomeGoals, actualAwayGoals
       - actualResult, wasCorrect
       - probabilityAccuracy (Brier score)
       - predictionStatus → 'resolved'
       - resolvedAt

  ELSE IF fixture.status IN ('PST', 'CANC', 'ABD', 'AWD', 'WO'):
    1. Set predictionStatus → 'void'
    2. Set resolvedAt to current timestamp
    3. No accuracy metrics computed (voided predictions excluded from stats)
```

### Schema Changes (Migration 0008)

| Column             | Type    | Default     | Description                                               |
| ------------------ | ------- | ----------- | --------------------------------------------------------- |
| `predictedResult`  | varchar | null        | Stored at prediction time: `home_win`, `draw`, `away_win` |
| `predictionStatus` | varchar | `'pending'` | Lifecycle: `pending` → `resolved` or `void`               |

Index: `idx_predictions_status` on `predictionStatus` for efficient resolution queries.

### Accuracy Metrics

| Metric               | Description                                                               | Target                     |
| -------------------- | ------------------------------------------------------------------------- | -------------------------- |
| **Overall accuracy** | % of predictions where wasCorrect = true                                  | > 50%                      |
| **Brier score**      | Mean Brier score across all resolved predictions (0 = perfect, 2 = worst) | < 0.60                     |
| **By type accuracy** | Accuracy broken down by daily vs pre_match                                | pre_match should be higher |

The `getAccuracyStats()` method on `AgentsService` returns these metrics.

---

## Confidence Scoring

Confidence is determined through a multi-layer process, not just Claude's self-assessment:

### Layer 1: Claude's Raw Confidence (System Prompt Guidelines)

| Score | Meaning                                                     | Frequency                     |
| ----- | ----------------------------------------------------------- | ----------------------------- |
| 3-4   | Standard match with typical uncertainty                     | ~70% of predictions (default) |
| 5     | Good data convergence, moderate strength differential       | ~20%                          |
| 6     | Clear strength differential confirmed by xG, form, AND odds | ~8%                           |
| 7     | All signals strongly converge, clear mismatch               | ~2%                           |
| 8-10  | Not used — no football match warrants this                  | 0%                            |

### Layer 2: Claude Post-Processing Dampening

Claude's raw scores are compressed: 8-10 → 6, 6-7 → 5, 4-5 → 4, 1-3 → unchanged.

### Layer 3: Ensemble Confidence Adjustment

| Condition                                     | Adjustment |
| --------------------------------------------- | ---------- |
| Max ensemble probability < 0.40 (very tight)  | Cap at 4   |
| Max ensemble probability < 0.48 (competitive) | Cap at 5   |
| Max ensemble probability < 0.55 (moderate)    | Cap at 6   |
| Claude and bookmakers disagree on outcome     | -2 (min 3) |
| Probability divergence > 15%                  | -1 (min 4) |
| All 3 signals agree + max prob >= 0.50        | +1 (max 8) |

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
              ├─> PlayerImpactService.computeImpactScores()
              ├─> [parallel]:
              │     ├─> ResearchAgent.research() (3 web searches)
              │     ├─> PoissonModel.predict() (with injury adjustments)
              │     ├─> getPerformanceFeedback() (last 500 predictions)
              │     └─> PredictionMemory.recall() (Supermemory)
              ├─> AnalysisAgent.analyze() (Claude with all context)
              └─> ensemblePredictions() (blend + calibrate + store)

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

## Self-Improvement Feedback Loop

**File:** `src/agents/agents.service.ts` — `getPerformanceFeedback()`

The system learns from its own mistakes by analyzing the last 500 resolved predictions before each new prediction:

- **Probability calibration**: compares average assigned probabilities vs actual outcome distribution
- **Draw bias detection**: flags if draw prediction rate diverges from actual draw rate by >3%
- **Home/away overestimation**: detects systematic over/underestimation
- **Confidence calibration**: checks if high-confidence predictions are actually more accurate
- **League-specific biases**: identifies leagues where the model performs poorly
- **Auto-generated insights**: injected into Claude's prompt as corrective instructions

**File:** `src/agents/prediction-memory.service.ts`

Semantic memory via Supermemory stores past prediction outcomes (correct/incorrect, miss type, lessons learned) and retrieves relevant memories when predicting the same teams or leagues.

---

## Future Improvements

| Improvement                         | Impact                                                    | Complexity | Status                                                                     |
| ----------------------------------- | --------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| ~~**xG-weighted analysis**~~        | ~~Use expected goals more prominently in prediction~~     | ~~Medium~~ | **Done** — xG is now the primary metric in Poisson model and Claude prompt |
| ~~**Multi-model ensemble**~~        | ~~Run multiple models and blend predictions~~             | ~~Medium~~ | **Done** — 3-signal ensemble (Claude + Poisson + Bookmakers)               |
| ~~**Lineup impact scoring**~~       | ~~Quantify how much absences affect predictions~~         | ~~Medium~~ | **Done** — PlayerImpactService with data-driven scores                     |
| ~~**Kelly criterion sizing**~~      | ~~Optimal bet sizing based on edge and confidence~~       | ~~Low~~    | **Done** — Polymarket trading agent uses Kelly                             |
| **xT (Expected Threat)**            | Identify teams dominating territory vs lucky shot-takers  | Medium     | Planned — needs StatsBomb/Opta data source                                 |
| **Isotonic regression calibration** | Post-hoc probability calibration from historical accuracy | Medium     | Planned — needs 200+ resolved predictions                                  |
| **Gradient boosting meta-learner**  | XGBoost/LightGBM on structured features for ensemble      | High       | Planned — needs 1000+ resolved predictions                                 |
| **Prediction caching**              | Skip re-generation if data hasn't changed significantly   | Low        | Not started                                                                |
