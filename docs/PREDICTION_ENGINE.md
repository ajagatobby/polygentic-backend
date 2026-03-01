# Prediction Engine

## Overview

The prediction engine combines three independent signals to produce a final prediction for each Polymarket soccer market. The core goal is **not to predict soccer outcomes perfectly**, but to **detect when Polymarket prices are significantly misaligned** with bookmaker consensus and our own statistical analysis.

---

## Signal Architecture

```
Signal 1: Mispricing Detection ──────────────┐
  (Polymarket vs Bookmaker Consensus)         |
                                              |
Signal 2: Statistical Model ─────────────────+──> Prediction Combiner ──> Final Prediction
  (Form, H2H, Injuries, Team Stats)          |         |
                                              |         v
Signal 3: API-Football Prediction ───────────┘    Confidence Scorer
                                                       |
                                                       v
                                                  Alert Generator
```

---

## Signal 1: Mispricing Detection (Weight: 40%)

This is our **highest-value signal**. It compares the Polymarket price against the bookmaker consensus probability.

### How It Works

1. **Fetch bookmaker odds** from The Odds API for the matching event
2. **Convert to probabilities** and remove vig (see THE_ODDS_API.md)
3. **Calculate weighted consensus** using bookmaker sharpness weights:
   - Pinnacle: 0.35
   - Betfair Exchange: 0.25
   - Marathonbet: 0.10
   - 1xBet: 0.10
   - Others: 0.20 (split)
4. **Compare** consensus probability against Polymarket price

### Mispricing Calculation

```
mispricing_gap = bookmaker_consensus - polymarket_price
mispricing_pct = mispricing_gap / bookmaker_consensus * 100
```

### Interpretation

| Gap            | Interpretation                       | Action                  |
| -------------- | ------------------------------------ | ----------------------- |
| > +0.10 (10%+) | Polymarket significantly underpriced | Strong BUY_YES signal   |
| +0.05 to +0.10 | Moderate underpricing                | Moderate BUY_YES signal |
| -0.05 to +0.05 | Within noise range                   | No signal               |
| -0.10 to -0.05 | Moderate overpricing                 | Moderate BUY_NO signal  |
| < -0.10 (10%+) | Polymarket significantly overpriced  | Strong BUY_NO signal    |

### Edge Cases

- If fewer than 3 bookmakers have odds: reduce confidence (thin market)
- If Pinnacle doesn't have odds: use Betfair as primary reference
- If no bookmaker odds available: skip this signal entirely

---

## Signal 2: Statistical Model (Weight: 35%)

A heuristic model that combines multiple data points from API-Football to estimate match probabilities.

### Input Features

#### a) Team Form (25% of signal weight)

```
form_score = weighted_sum(last_5_results)

Where:
  Win   = 3 points
  Draw  = 1 point
  Loss  = 0 points

  Weights (most recent first): [0.30, 0.25, 0.20, 0.15, 0.10]

  Max score = 3 * (0.30 + 0.25 + 0.20 + 0.15 + 0.10) = 3.0

  form_pct = form_score / 3.0
```

Apply separately for home and away form when relevant.

#### b) Home/Away Advantage (15% of signal weight)

```
home_advantage = home_win_rate - away_win_rate (historical for this venue/league)

Typical home advantage in top 5 European leagues: ~15-20% boost to home win probability
```

#### c) Head-to-Head Record (15% of signal weight)

```
h2h_score = (h2h_wins * 3 + h2h_draws) / (h2h_total_games * 3)

Use last 10 H2H meetings, weighted by recency.
If fewer than 3 H2H meetings: reduce weight of this factor.
```

#### d) Goal-Scoring Data (15% of signal weight)

```
For match outcome:
  expected_goals_home = avg_goals_scored_home * avg_goals_conceded_away
  expected_goals_away = avg_goals_scored_away * avg_goals_conceded_home

For over/under markets:
  expected_total = expected_goals_home + expected_goals_away

  Use Poisson distribution to calculate P(over X.5) and P(under X.5)
```

#### e) Injury Impact (20% of signal weight)

```
injury_impact = sum(player_importance * injury_severity) for all injured players

Player importance tiers:
  - Star player / top scorer:     0.15 (15% impact on team strength)
  - Regular starter:              0.08
  - Rotation player:              0.03
  - Backup / youth:               0.01

Determine player importance by:
  - Is player in the starting XI consistently?
  - Is player a top scorer / top assister for the team?
  - Is player the first-choice goalkeeper?
```

#### f) League Position Context (10% of signal weight)

```
position_diff = away_position - home_position (positive = home team higher in table)

Normalize to -1.0 to 1.0 range based on league size.
Higher-positioned teams get a probability boost.
```

### Combining Features

```
statistical_probability = weighted_sum([
  form_score * 0.25,
  home_away_factor * 0.15,
  h2h_score * 0.15,
  goals_model * 0.15,
  injury_adjustment * 0.20,
  position_context * 0.10
])

Normalize to valid probability range [0.01, 0.99]
```

---

## Signal 3: API-Football Prediction (Weight: 25%)

API-Football provides its own built-in prediction via the `/predictions` endpoint.

### Data We Use

```json
{
  "percent": { "home": "65%", "draw": "20%", "away": "15%" },
  "winner": { "name": "Arsenal", "comment": "Win or draw" },
  "advice": "Double chance: Arsenal or draw and target Under 3.5",
  "comparison": {
    "form": { "home": "80%", "away": "50%" },
    "att": { "home": "85%", "away": "60%" },
    "def": { "home": "80%", "away": "55%" },
    "total": { "home": "70%", "away": "48%" }
  }
}
```

### How We Use It

- Extract `percent.home`, `percent.draw`, `percent.away` as probability estimates
- Use the `comparison` metrics as validation for our own statistical model
- The `advice` field provides qualitative context but isn't directly used in calculations
- This serves as an **independent second opinion** that can validate or challenge our statistical model

### Limitations

- API-Football predictions are available for most but not all fixtures
- Prediction quality varies — better for major leagues, less reliable for smaller ones
- Not available for non-match markets (league winner, transfers, etc.)
- For non-match markets, redistribute this signal's weight to Signal 1 and Signal 2

---

## Prediction Combiner

### For Match Outcome Markets

```
final_probability = (
  mispricing_signal * 0.40 +
  statistical_model * 0.35 +
  api_football_pred * 0.25
)
```

### For League Winner / Season Markets

API-Football predictions don't apply. Reweight:

```
final_probability = (
  mispricing_signal * 0.55 +
  statistical_model * 0.45
)
```

### For Transfer / Manager Markets

Only mispricing detection applies (no statistical model):

```
final_probability = bookmaker_consensus  (if available)
                  = polymarket_price     (if no bookmaker data — no prediction)
```

---

## Confidence Scorer

Each prediction gets a confidence score from 0-100 based on:

| Factor                  | Max Points | Criteria                                                                                     |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| **Signal agreement**    | 30         | All 3 signals within 5% of each other = 30 pts. Wider disagreement = fewer points.           |
| **Mispricing gap size** | 25         | Larger gap = higher confidence. >15% gap = 25 pts.                                           |
| **Data completeness**   | 15         | All data sources available = 15 pts. Missing injury data = -3, missing odds = -5, etc.       |
| **Market liquidity**    | 15         | Higher Polymarket liquidity = more reliable price. >$50K volume = 15 pts.                    |
| **Time to event**       | 10         | 1-7 days before event = 10 pts (optimal). Too far = less data, too close = less time to act. |
| **Historical accuracy** | 5          | If we've made similar predictions before, how accurate were they?                            |

### Confidence Thresholds

| Score  | Label     | Action                                |
| ------ | --------- | ------------------------------------- |
| 80-100 | Very High | Strong recommendation, generate alert |
| 60-79  | High      | Recommendation with caveat            |
| 40-59  | Medium    | Informational only                    |
| 20-39  | Low       | Weak signal, likely noise             |
| 0-19   | Very Low  | Insufficient data, no recommendation  |

---

## Recommendation Engine

Based on final probability, mispricing gap, and confidence:

```
IF confidence >= 60 AND mispricing_gap > 0.05:
  recommendation = "BUY_YES"

ELIF confidence >= 60 AND mispricing_gap < -0.05:
  recommendation = "BUY_NO"

ELIF confidence >= 40 AND |mispricing_gap| > 0.03:
  recommendation = "HOLD" (monitor for further movement)

ELSE:
  recommendation = "NO_SIGNAL"
```

---

## Live Match Prediction Updates

During live matches, predictions are recalculated in near real-time:

### Trigger Events

| Event                     | Source            | Action                                                         |
| ------------------------- | ----------------- | -------------------------------------------------------------- |
| Goal scored               | API-Football live | Recalculate all signals, check for delayed Polymarket reaction |
| Red card                  | API-Football live | Significant probability shift expected                         |
| Penalty awarded           | API-Football live | Major event — watch for Polymarket lag                         |
| Half-time                 | API-Football live | Update with half-time stats                                    |
| Injury / Substitution     | API-Football live | Minor adjustment if key player                                 |
| Polymarket price movement | WebSocket         | Check if movement aligns with our prediction                   |
| Bookmaker odds movement   | The Odds API      | Update consensus, check for new mispricing                     |

### Live Mispricing Detection Flow

```
1. API-Football detects: GOAL scored (Arsenal 1-0 at 23')
2. System fetches: Updated bookmaker odds (The Odds API)
3. System checks: Has Polymarket price updated?
4. IF bookmaker odds shifted significantly BUT Polymarket hasn't:
     -> Generate LIVE MISPRICING alert
     -> Estimated window: 30 seconds to 5 minutes
5. Track: How quickly Polymarket adjusts
6. Log: For future analysis of Polymarket reaction speed
```

### Live Prediction Formula Adjustments

During live matches, weight shifts toward real-time data:

```
live_probability = (
  live_bookmaker_odds * 0.50 +     // Increased from 0.40
  live_match_state * 0.30 +         // Current score, time elapsed, red cards
  pre_match_prediction * 0.20       // Our pre-match analysis (reduced weight)
)
```

---

## Backtesting & Calibration

### How We Measure Accuracy

After markets resolve, we compare:

```
For each resolved prediction:
  was_correct = (recommendation == "BUY_YES" AND outcome == "yes")
             OR (recommendation == "BUY_NO" AND outcome == "no")

  brier_score = (predicted_probability - actual_outcome)^2
  // Lower Brier score = better calibration
```

### Calibration Analysis

Group predictions by predicted probability buckets:

```
Bucket [0.50-0.60]: 120 predictions, 57% resolved Yes → well calibrated
Bucket [0.60-0.70]: 85 predictions, 72% resolved Yes → slightly over-confident
Bucket [0.70-0.80]: 45 predictions, 68% resolved Yes → over-confident, needs adjustment
```

Use this analysis to adjust model weights over time.

### Tracking Metrics

| Metric                        | Description                                             | Target           |
| ----------------------------- | ------------------------------------------------------- | ---------------- |
| **Overall accuracy**          | % of recommendations that were correct                  | > 55%            |
| **Brier score**               | Mean squared prediction error                           | < 0.20           |
| **ROI**                       | If you followed all recommendations                     | > 5%             |
| **Mispricing detection rate** | % of detected mispricings that were real                | > 60%            |
| **Average reaction time**     | How fast we detect mispricings vs Polymarket correction | < 5 min for live |

---

## Future Improvements

| Improvement                         | Impact                                                 | Complexity |
| ----------------------------------- | ------------------------------------------------------ | ---------- |
| **Machine Learning model**          | Replace heuristic statistical model with trained model | High       |
| **xG integration**                  | Add expected goals data from SportMonks/FBref          | Medium     |
| **News sentiment analysis**         | Parse Twitter/news for injury rumors, manager changes  | High       |
| **Polymarket reaction speed model** | Learn how fast Polymarket typically adjusts to events  | Medium     |
| **Kelly criterion sizing**          | Optimal position sizing based on edge and confidence   | Low        |
| **Multi-market correlation**        | Detect correlated mispricings across related markets   | Medium     |
