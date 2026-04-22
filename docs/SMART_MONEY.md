# Smart Money System

Track profitable "sharp" wallets on Polymarket, turn their collective positioning into a signal, and use that signal as a standalone prediction or as a confidence modulator on the main LLM ensemble.

---

## 1. What the system does

Every Polymarket moneyline market has a public list of holders for each outcome. The vast majority are retail / hedgers / one-market specialists — noise. A small subset have track records that show genuine skill (profitable across many markets, consistent recent form, big conviction bets on specific fixtures).

The smart-money system:

1. **Finds the Polymarket market** linked to a given football fixture.
2. **Pulls every wallet** holding that market — direct holders, historical traders, and cross-checked leaderboard sharps.
3. **Filters** down to "sharps" using a four-gate qualification pipeline (track record + conviction + independence + signal-level floor).
4. **Aggregates** their positions into a `leanScore` in `[-1, +1]`, count + recent-form weighted.
5. **Translates** the lean into a home / draw / away prediction OR uses it to adjust the ensemble prediction's confidence.

---

## 2. Data sources

| Source | What it returns | Cap |
|---|---|---|
| `GET /holders?market=<conditionId>` | Top holders per outcome with current token balance | **20 per outcome** (hard Polymarket limit) |
| `GET /trades?market=<conditionId>&limit=N` | Recent trade history | Our code samples up to 5000 trades, reconstructs net positions (BUY − SELL) per wallet |
| `GET /v1/leaderboard?category=OVERALL&limit=50&offset=N` | Global top traders by PnL | 50 per page; we fetch 4 pages (top 200) |
| `GET /positions?user=<wallet>` | All current positions for a wallet | Used twice: (a) for leaderboard cross-check against the target market, (b) for per-wallet enrichment |
| `GET /closed-positions?user=<wallet>` | Wallet's settled positions | Source of realized PnL, ROI, resolved-bet count, streak data |

All calls go through `PolymarketDataService` with per-endpoint TTL caching (5 min holders/trades, 30 min positions, 1 h leaderboard).

Pool expansion is triggered via `SmartMoneyOptions.expandPool: true`. The POST `/smart-money/predict` endpoint always enables it. GET defaults to just `/holders` for speed.

---

## 3. Qualification pipeline (the "sharp" gate)

A wallet must clear **four independent gates**.

### Gate 1 — Track record

All three must pass:

| Metric | Default | Why |
|---|---|---|
| `lifetimeRoi` | `≥ 0.10` (10%) | Skill, not luck |
| `resolvedCount` | `≥ 50` | Sample-size floor — prevents "10/10 = sharp" false positives |
| `lifetimePnl` | `≥ $50,000` **OR** `≥ $20,000 + hot streak` | Credentials |

`lifetimePnl` uses **realized** PnL only — money actually collected, not unrealized open positions.

### Gate 2 — Hot-streak exception

A wallet with **$20k–$50k** PnL still qualifies if either:

- `last10WinRate ≥ 0.80` (8+ of last 10 resolved bets won), **OR**
- `currentWinStreak ≥ 7` (7+ consecutive wins from most recent resolution)

This catches up-and-coming sharps whose lifetime PnL is smaller but who are performing *right now* — stronger signal than a whale coasting on old wins.

The base ROI and resolved-bets floors (Gate 1) still apply — you can't shortcut those.

### Gate 3 — Conviction

| Metric | Default | Meaning |
|---|---|---|
| `positionMultiple` = `thisBet / typicalBetSize` | `≥ 0.5` | Bet must be at least half the wallet's median historical bet |

A whale's $1k bet on a market when they normally bet $20k = 0.05 multiple → noise. Same whale putting $15k = 0.75 multiple → conviction.

`typicalBetSize` uses the **median** (not mean) of historical bet sizes, which resists outlier skew.

### Gate 4 — Independence (correlation dedup)

If two wallets share the same side AND their position sizes are within `correlationThreshold` (default 15%) of each other → counted as one vote. Prevents a "same-Telegram-group" effect from inflating `sharpCount`.

The larger position keeps its vote; duplicates are dropped.

### Market-level floor

Even after per-wallet gates pass, the **market as a whole** needs `≥ minSharpCount` (default 3) qualifying sharps before `leanScore` is non-null. Below that threshold → return `null` signal ("no read").

### Two-pass threshold profiles

When the strict pass yields no qualifying sharps, the prediction endpoint retries with relaxed thresholds:

| Metric | Strict | Relaxed |
|---|---|---|
| `minLifetimePnl` | 50_000 | **10_000** |
| `minLifetimePnlWithStreak` | 20_000 | **5_000** |
| `minLifetimeRoi` | 0.10 | **0.05** |
| `minResolvedBets` | 50 | **20** |
| `minSharpCount` | 3 | **1** |
| `minPositionMultiple` | 0.5 | **0.3** |
| `minLast10WinRate` | 0.80 | **0.70** |
| `minCurrentStreak` | 7 | **5** |

Confidence is capped at **7/10** when the relaxed pool supplies the signal (strict caps at 10). If both passes fail, the endpoint falls back to the market's midpoint price as a final source.

---

## 4. leanScore: count + streak weighted

Each qualifying sharp gets a **weighted vote**, not a dollar-weighted contribution. A lone whale can't override a count consensus.

```
formComponent   = last10WinRate         // 0..1 (0.5 if unknown)
streakComponent = min(1, streak / 10)   // 0..1
weight          = 0.5 + avg(formComponent, streakComponent)  // 0.5..1.5
```

| Form profile | Weight |
|---|---|
| 10/10 recent + streak ≥ 10 | ~1.5 |
| Neutral / unknown | ~1.0 |
| 0/10 recent + no streak | ~0.5 |

Aggregate:
```
votes0 = Σ weight(sharp) for sharps on outcome 0
votes1 = Σ weight(sharp) for sharps on outcome 1
leanScore = (votes0 − votes1) / (votes0 + votes1)
```

Range `[-1, +1]`. `+1` = unanimous on outcome 0 (YES). `-1` = unanimous on outcome 1 (NO). Magnitude tells you consensus strength.

Signal confidence:
```
sampleConf   = min(1, sharpCount / 10)
signalConf   = sampleConf × |leanScore|
```

---

## 5. Top-sharp display order

The top 5 sharps shown in API responses are ordered by **recent form** (not bet size):

1. `last10Wins DESC` — hottest hands first
2. Tiebreak: `currentWinStreak DESC`
3. Final tiebreak: `lifetimePnl DESC`

All qualifying sharps still count toward `leanScore` and `sharpCount`; the `slice(0, 5)` cap only applies to the embedded display list. Use the `/holders` endpoint (below) if you need the full list.

---

## 6. Endpoints

### 6.1 Prediction (no write)

```http
GET /api/polymarket/smart-money/predict/:fixtureId
```

Returns a prediction derived solely from the smart-money signal. Doesn't persist anything; uses cached holder data; fast.

### 6.2 Prediction (persist + live refresh)

```http
POST /api/polymarket/smart-money/predict/:fixtureId
```

Same math, but:

- Bypasses every cache so we read the newest data from Polymarket.
- Refreshes market midpoints live via the CLOB.
- Expands the candidate pool past the 20-holder cap (target up to 10,000 per outcome; typically 100–400).
- Upserts the result into the `predictions` table with `predictionType = 'smart_money'`.

### 6.3 All holders for a market

```http
GET /api/polymarket/holders/:conditionId
```

Returns every wallet holding the market across all discovery sources (no top-N cap). Supports comprehensive query-param filters and optional `?enrich=true` to add lifetime stats.

**Query parameters:**

| Param | Type | Notes |
|---|---|---|
| `enrich` | boolean | Adds lifetime PnL, ROI, last10/20 Wins, streak per wallet |
| `outcome` | `0` / `1` | Scope to one side |
| `minAmount` / `maxAmount` | number | Bet-size range |
| `minPnl` / `maxPnl` | number | Lifetime realized PnL (USD) |
| `minRoi` / `maxRoi` | number | Lifetime ROI (fraction; 0.10 = 10%) |
| `minLast10Wins` | 0–10 | |
| `minLast20Wins` | 0–20 | |
| `minStreak` | number | Current consecutive-wins |
| `minResolved` | number | Sample-size floor |
| `sortBy` | `amount` \| `pnl` \| `roi` \| `last10Wins` \| `last20Wins` \| `streak` | Default `amount` |
| `sortOrder` | `asc` \| `desc` | Default `desc` |
| `limit` | number | Max holders per outcome after filtering |

Any filter that touches lifetime stats auto-enables enrichment — no need to pass `enrich=true` explicitly.

**Example — top-10 whales with solid recent form on the Yes side:**
```
GET /holders/0xabc...?outcome=0&minLast10Wins=7&sortBy=pnl&limit=10
```

**Example — every sharp with $100k+ PnL and 20%+ ROI, ranked by streak:**
```
GET /holders/0xabc...?minPnl=100000&minRoi=0.2&sortBy=streak
```

### 6.4 Configuration

```http
GET   /api/polymarket/smart-money/config
PATCH /api/polymarket/smart-money/config    (admin only)
```

Read or update the nine qualification thresholds at runtime without shipping code. DB overrides win on non-null values; nulls fall through to the service defaults. Changes take effect within 30s (cache TTL).

---

## 7. Tunable thresholds

Every field below has a hard-coded default in `smart-money-signal.service.ts` and can be overridden per-profile via the config endpoint.

| Field | Default | Meaning |
|---|---|---|
| `minLifetimePnl` | `50000` | Base-path lifetime PnL floor (USD) |
| `minLifetimePnlWithStreak` | `20000` | Streak-exception PnL floor |
| `minLifetimeRoi` | `0.10` | Lifetime ROI fraction, applies to both paths |
| `minResolvedBets` | `50` | Sample-size floor, applies to both paths |
| `minSharpCount` | `3` | Market-level floor — min qualifying sharps before signal is non-null |
| `minPositionMultiple` | `0.5` | Bet must be ≥ this × typical bet size |
| `correlationThreshold` | `0.15` | Dedup tolerance for correlated wallets |
| `minLast10WinRate` | `0.80` | Hot-streak path — recent form |
| `minCurrentStreak` | `7` | Hot-streak path — consecutive wins |

### Full PATCH body

```json
{
  "minLifetimePnl": 50000,
  "minLifetimePnlWithStreak": 20000,
  "minLifetimeRoi": 0.10,
  "minResolvedBets": 50,
  "minSharpCount": 3,
  "minPositionMultiple": 0.5,
  "correlationThreshold": 0.15,
  "minLast10WinRate": 0.80,
  "minCurrentStreak": 7
}
```

Partial updates work — missing fields are left unchanged. Pass `null` for a specific field to clear that override and revert to the service default.

---

## 8. Response shapes

### 8.1 `POST /smart-money/predict/:fixtureId`

```json
{
  "fixture": {
    "id": 1396501,
    "date": "2026-04-19T19:30:00.000Z",
    "homeTeamId": 212,
    "awayTeamId": 218,
    "homeName": "FC Porto",
    "awayName": "Tondela",
    "leagueId": 94,
    "leagueName": "Primeira Liga"
  },
  "prediction": {
    "id": 2711,
    "homeWinProb": 0.2192,
    "drawProb": 0.25,
    "awayWinProb": 0.5308,
    "predictedResult": "away",
    "confidence": 7,
    "source": "direct",
    "thresholdMode": "strict",
    "note": "Derived solely from Polymarket sharp-money positioning...",
    "createdAt": "2026-04-20T01:42:00.000Z"
  },
  "smartMoneySignal": {
    "source": "direct",
    "sharps": {
      "leaningTeam": "Tondela",
      "count": 11,
      "strength": "moderate",
      "dollarsFor": 63369,
      "dollarsAgainst": 29777
    },
    "topSharps": [
      {
        "wallet": "0x2759...",
        "name": "SharkbetX-com",
        "lifetimePnl": 1129140.74,
        "lifetimeRoi": 0.627,
        "last10Wins": 9,
        "last20Wins": 16,
        "currentWinStreak": 4,
        "bet": {
          "outcome": "No",
          "backs": "Tondela or Draw",
          "amount": 39113,
          "alignsWithSharps": true
        }
      }
    ]
  },
  "marketSignal": null,
  "polymarket": {
    "marketQuestion": "Will FC Porto win?",
    "marketTeam": "FC Porto",
    "conditionId": "0x...",
    "marketUrl": "https://polymarket.com/market/...",
    "eventUrl": "https://polymarket.com/event/...",
    "url": "https://polymarket.com/market/..."
  },
  "stored": true
}
```

### 8.2 Fallback — market midpoint (no qualifying sharps)

When both strict and relaxed passes fail, `source` switches to `"market"` and `marketSignal` populates:

```json
{
  "prediction": {
    "homeWinProb": 0.62,
    "drawProb": 0.25,
    "awayWinProb": 0.13,
    "predictedResult": "home",
    "confidence": 4,
    "source": "market",
    "note": "No qualifying sharps... falling back to midpoint (0.62 on \"Flamengo\")..."
  },
  "smartMoneySignal": null,
  "marketSignal": {
    "source": "polymarket-market",
    "marketTeam": "Flamengo",
    "impliedYesPrice": 0.62,
    "impliedNoPrice": 0.38,
    "liquidity": 12000,
    "volume24hr": 5000
  }
}
```

### 8.3 Enriched `/holders` entry

```json
{
  "wallet": "0x2759...",
  "name": "SharkbetX-com",
  "pseudonym": "SharkbetX-com",
  "amount": 39113,
  "outcomeIndex": 0,
  "outcomeName": "Yes",
  "lifetimePnl": 1129140.74,
  "lifetimeRoi": 0.627,
  "last10Wins": 9,
  "last10WinRate": 0.9,
  "last20Wins": 16,
  "last20WinRate": 0.8,
  "currentWinStreak": 4,
  "resolvedCount": 73
}
```

---

## 9. How the signal modulates the main prediction

When the LLM ensemble pipeline runs (`daily`, `pre_match`, `on_demand` predictions in `agents.service.ts`), the smart-money signal is computed alongside and modifies confidence **only** — probabilities are untouched.

| Situation | Confidence adjustment |
|---|---|
| Sharps **agree** with ensemble pick (direction match) | **+1** (cap 9) |
| Sharps **disagree**, `direct` signal (per-match moneyline) | **−1** (floor 1) |
| Sharps **disagree**, `backdrop` signal (season outright only) | **No change** (log only) |
| `sharpCount < 3` OR `signalConfidence < 0.2` OR `|leanScore| < 0.3` | **No change** (gate not cleared) |

The asymmetric treatment of backdrop signals (agreement-only, no penalty) is intentional: a team-season outright market doesn't directly predict a specific fixture outcome, so disagreement is too weak a signal to justify a confidence penalty. Agreement, though, is still confirmation.

---

## 10. Fixture discovery (tiered lookup)

Before any signal can be computed, the fixture must be linked to a Polymarket market. `linkFixtureOnDemand(fixtureId)` runs through four tiers:

| Tier | Method | Typical cost | Hit rate |
|---|---|---|---|
| 1 | Exact slug probe (not yet implemented) | 1 call | — |
| 2 | League-scoped `end_date` window (±6h) | 1 call | 80% for mapped leagues |
| 3 | `public-search` by team names | 1 call | +15% (unmapped leagues, cross-tagged events) |
| 4 | Global 1000-event soccer scan | 10–20 calls | Catches everything else |

A 2-hour negative cache on miss prevents hammering the API for fixtures Polymarket doesn't cover. POST predictions bypass the negative cache so user-triggered refreshes always re-check.

---

## 11. Relevant files

| File | Purpose |
|---|---|
| `src/polymarket/services/smart-money-signal.service.ts` | Core signal math — qualification, weighting, leanScore |
| `src/polymarket/services/polymarket-data.service.ts` | Data-api client — /holders, /trades, /positions, /leaderboard + expanded pool union |
| `src/polymarket/polymarket.service.ts` | Fixture linking, prediction endpoint, holders endpoint, config CRUD |
| `src/polymarket/polymarket.controller.ts` | HTTP routes |
| `src/database/schema/polymarket.schema.ts` | `polymarket_markets`, `polymarket_holder_snapshots`, `smart_money_config` tables |
| `src/database/migrations/0009_polymarket_holder_snapshots.sql` | Daily holder archive for walk-forward backtests |
| `src/database/migrations/0010_predictions_smart_money.sql` | Adds `smart_money_signal` JSONB column to predictions |
| `src/database/migrations/0011_smart_money_config.sql` | Sharp-threshold config table |
| `src/agents/agents.service.ts` | Main LLM pipeline — `computeSmartMoneySignal`, `applySmartMoneyConfidenceAdjustment` |

---

## 12. Known limits and tradeoffs

1. **Polymarket `/holders` caps at 20 per outcome.** We break this by unioning `/holders` with `/trades` reconstruction and leaderboard cross-check. Even so, the effective pool size is bounded by market activity — cold markets may yield <80 unique wallets.

2. **Leaderboard cross-check adds ~100 HTTP calls per fresh POST.** Cached 30 min per wallet, so the second call on the same market is essentially free. First call on a cold cache can take 5–15 seconds.

3. **`lifetimePnl` uses realized-only.** Excludes unrealized gains on open positions. This is intentional — realized is the cleanest skill signal and can't be inflated by paper profits.

4. **`correlationThreshold: 0.15` can under-dedup at extremes.** Two wallets betting $100 and $115 on the same side are 15% apart and get treated as one (correct). Two wallets betting $100 and $200 are 100% apart and get treated as two (also correct — meaningfully different sizes). Syndicates that vary sizes intentionally will evade dedup; this is a known limitation.

5. **Backdrop signals never adjust confidence.** The current logic requires `marketTeamId` to be populated, which backdrop signals don't set. Backdrop agreement still logs but doesn't actually bump confidence. If you want that, `agents.service.ts:applySmartMoneyConfidenceAdjustment` needs a small fix.

6. **Relaxed-mode caps at confidence 7.** Relaxed sharps have $10k+ PnL, 5%+ ROI, 20+ resolved bets — real traders, but less proven than strict-mode $50k/10%/50+ sharps. The cap ensures a relaxed signal doesn't drive a 10/10 confidence prediction.
