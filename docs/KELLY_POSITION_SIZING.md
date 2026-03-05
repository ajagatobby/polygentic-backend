# Kelly Criterion & Position Sizing

How the Polymarket trading agent sizes bets, manages bankroll, and controls risk.

## Kelly Criterion

The Kelly Criterion is a formula that determines the **optimal fraction of your bankroll to bet** given your edge and the odds. It maximizes long-term growth rate while avoiding ruin.

### Formula

For Polymarket binary tokens (pay $1 if correct, $0 if wrong):

```
Kelly % = (our_probability - market_price) / (1 - market_price)
```

Where:

- `our_probability` — our estimated probability the outcome is correct (from ensemble model or standings data)
- `market_price` — Polymarket's current price for the token (= the market's implied probability)
- `Kelly %` — the fraction of bankroll to wager

### Example

| Input                               | Value                         |
| ----------------------------------- | ----------------------------- |
| Our probability (Liverpool wins PL) | 45%                           |
| Polymarket price                    | 0.30 ($0.30 per token)        |
| Edge                                | 0.45 - 0.30 = **15%**         |
| Kelly %                             | 0.15 / (1 - 0.30) = **21.4%** |

On a $500 bankroll, full Kelly says bet $107. That's aggressive.

### Why Full Kelly Is Dangerous

Full Kelly assumes your probability estimate is perfectly calibrated. In reality:

- Our model has estimation error
- Market conditions change
- A few consecutive losses at full Kelly can destroy a bankroll

| Kelly Fraction     | Bet ($500 bankroll) | Growth rate vs full | Drawdown risk |
| ------------------ | ------------------- | ------------------- | ------------- |
| Full (1.0)         | $107                | 100%                | Very high     |
| Half (0.5)         | $53.50              | ~75%                | High          |
| **Quarter (0.25)** | **$26.75**          | **~56%**            | **Moderate**  |
| Eighth (0.125)     | $13.38              | ~34%                | Low           |

Quarter-Kelly retains 56% of the theoretical growth rate while dramatically reducing the probability of ruin. This is the default for our agent.

## Position Sizing Pipeline

The trading agent (Claude) calculates position size through these steps:

### Step 1: Calculate Raw Edge

```
raw_edge = our_probability - polymarket_price
effective_edge = raw_edge - (spread / 2)    // Spread eats into edge
```

If `effective_edge < POLYMARKET_MIN_EDGE` (default 5%), the trade is skipped.

### Step 2: Calculate Kelly Fraction

```
raw_kelly = effective_edge / (1 - entry_price)
adjusted_kelly = raw_kelly * POLYMARKET_KELLY_FRACTION    // Default: 0.25
```

### Step 3: Apply Position Caps

```
max_position = current_balance * POLYMARKET_MAX_POSITION_PCT    // Default: 10%
position_size_usd = min(current_balance * adjusted_kelly, max_position)
```

### Step 4: Claude May Size Down Further

The trading agent may reduce the position below the Kelly-calculated amount when:

- The bankroll is below starting balance (capital preservation)
- Many open positions exist (correlation risk)
- Prediction confidence is moderate (6-7 out of 10)
- Market liquidity is thin (can't fill at displayed price)
- The edge looks suspiciously large (>15% — might mean we're wrong)

## Configuration

Set in `.env`:

| Variable                       | Default | Description                                                |
| ------------------------------ | ------- | ---------------------------------------------------------- |
| `POLYMARKET_BUDGET`            | 500     | Initial bankroll in USDC                                   |
| `POLYMARKET_KELLY_FRACTION`    | 0.25    | Kelly multiplier (0.25 = quarter-Kelly)                    |
| `POLYMARKET_MAX_POSITION_PCT`  | 0.10    | Max single bet as fraction of bankroll                     |
| `POLYMARKET_MIN_EDGE`          | 0.05    | Minimum edge (5%) to consider a trade                      |
| `POLYMARKET_MIN_LIQUIDITY`     | 1000    | Minimum market liquidity in USD                            |
| `POLYMARKET_MIN_CONFIDENCE`    | 6       | Minimum prediction confidence (1-10)                       |
| `POLYMARKET_STOP_LOSS_PCT`     | 0.30    | Stop trading if bankroll drops to this fraction of initial |
| `POLYMARKET_TARGET_MULTIPLIER` | 3       | Target return (3 = aim for 3x the initial budget)          |

## Bankroll Management

Tracked in the `polymarket_bankroll` table:

| Field                  | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `initial_budget`       | Starting bankroll                                |
| `current_balance`      | Available balance after open positions           |
| `realized_pnl`         | Cumulative profit/loss from resolved trades      |
| `open_positions_count` | Number of active trades                          |
| `open_positions_value` | Total USDC locked in active trades               |
| `peak_balance`         | Highest balance achieved                         |
| `current_drawdown_pct` | How far below peak we are                        |
| `max_drawdown_pct`     | Worst peak-to-trough drawdown ever               |
| `is_stopped`           | True if stop-loss triggered — all trading halted |

### Stop-Loss

If the bankroll drops below `POLYMARKET_STOP_LOSS_PCT` (default 30%) of the initial budget, trading stops automatically:

```
if (current_balance / initial_budget < 0.30) → STOP
```

On a $500 budget, trading stops if balance falls below $150. The agent will log `STOP-LOSS TRIGGERED` and skip all scan cycles until manually reset.

## Trade Economics

### What You Pay

`position_size_usd` — the amount in USDC you spend to buy outcome tokens.

### What You Receive

`token_quantity = position_size_usd / entry_price`

For example, $20 at entry price 0.40 buys 50 tokens.

### Possible Outcomes

| Result   | Token value | You receive           | P&L                                  |
| -------- | ----------- | --------------------- | ------------------------------------ |
| **Win**  | $1.00 each  | `token_quantity * $1` | `token_quantity * (1 - entry_price)` |
| **Lose** | $0.00 each  | $0                    | `-position_size_usd`                 |

### P&L Formulas

```
if win:   pnl_usd = token_quantity * (1.0 - entry_price)
if loss:  pnl_usd = -position_size_usd

pnl_percent = pnl_usd / position_size_usd
```

### Payout Multiplier

The lower the entry price, the higher the payout:

| Entry Price | Implied Probability | Payout if Win | $20 Bet Profit |
| ----------- | ------------------- | ------------- | -------------- |
| 0.10        | 10%                 | 10x           | $180           |
| 0.25        | 25%                 | 4x            | $60            |
| 0.40        | 40%                 | 2.5x          | $30            |
| 0.60        | 60%                 | 1.67x         | $13.33         |
| 0.80        | 80%                 | 1.25x         | $5             |

## Database Columns (polymarket_trades)

Key columns related to position sizing and P&L:

| Column                   | Type          | Description                                         |
| ------------------------ | ------------- | --------------------------------------------------- |
| `entry_price`            | numeric(10,6) | Price per token at entry (0-1)                      |
| `position_size_usd`      | numeric(14,2) | USDC wagered                                        |
| `token_quantity`         | numeric(14,6) | Tokens received (`position_size_usd / entry_price`) |
| `ensemble_probability`   | numeric(5,4)  | Our model's probability                             |
| `polymarket_probability` | numeric(5,4)  | Market's implied probability                        |
| `edge_percent`           | numeric(8,4)  | `(ensemble - polymarket) * 100`                     |
| `kelly_fraction`         | numeric(8,6)  | Calculated Kelly fraction                           |
| `exit_price`             | numeric(10,6) | 1.0 (win) or 0.0 (loss), set on resolution          |
| `pnl_usd`                | numeric(14,2) | Profit/loss in USDC, set on resolution              |
| `pnl_percent`            | numeric(8,4)  | Return on position, set on resolution               |
| `bankroll_at_entry`      | numeric(14,2) | Bankroll when trade was placed                      |
| `confidence_at_entry`    | integer       | Prediction confidence (1-10)                        |

## Risk Controls Summary

1. **Quarter-Kelly sizing** — never bet more than 25% of what full Kelly suggests
2. **Max position cap** — no single bet exceeds 10% of bankroll
3. **Minimum edge filter** — skip trades with <5% edge
4. **Minimum liquidity** — skip markets with <$1000 liquidity
5. **Minimum confidence** — skip predictions with confidence <6/10
6. **Stop-loss** — halt all trading if bankroll drops below 30% of initial
7. **Correlation awareness** — Claude considers open positions in the same league
8. **Spread adjustment** — edge is reduced by half the bid-ask spread before evaluation
9. **Claude judgment** — the agent can override Kelly and skip or size down based on qualitative factors
