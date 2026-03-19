# Autoresearch: Prediction Engine Optimizer

This is an autonomous research loop for improving the Polygentic football prediction engine. Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch), but instead of training a neural network, we optimize the ensemble calibration parameters that determine prediction quality.

## How It Works

The prediction engine blends three signals — Claude (LLM), a Poisson statistical model, and bookmaker consensus odds — through an ensemble with ~50 tunable parameters (draw floors, dampening factors, confidence caps, result-logic thresholds, etc.). These parameters are currently hand-tuned. Your job is to find better values by running experiments.

**The metric is `brier_score` — lower is better (0 = perfect, 2 = worst).**

## The Files

- **`autoresearch/experiment-config.ts`** — THE file you modify. Contains every tunable parameter. This is your `train.py`.
- **`autoresearch/backtest.ts`** — FIXED evaluation harness. DO NOT MODIFY. Reads resolved predictions from the DB, re-applies calibration with your config, reports Brier score.
- **`autoresearch/program.md`** — These instructions. DO NOT MODIFY.
- **`src/agents/agents.service.ts`** — The production prediction pipeline. Read this to understand what each parameter does. DO NOT MODIFY during experiments.
- **`src/agents/analysis.agent.ts`** — The LLM analysis agent with system prompt. Read for context. DO NOT MODIFY during experiments.

## Setup

To set up a new experiment run, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date (e.g. `mar19`). The branch `autoresearch/<tag>` must not already exist.
2. **Create the branch**: `git checkout -b autoresearch/<tag>` from the current branch.
3. **Read the in-scope files**: Read these for full context:
   - `autoresearch/experiment-config.ts` — the parameters you'll modify
   - `autoresearch/backtest.ts` — the evaluation harness (understand the metric)
   - `src/agents/agents.service.ts` — the production ensemble logic (lines 1922-2216)
   - `src/agents/analysis.agent.ts` — the LLM system prompt (lines 138-253)
4. **Verify data exists**: Run `npx ts-node -r tsconfig-paths/register autoresearch/backtest.ts` and confirm it returns results. If it fails with DB errors, tell the human.
5. **Initialize results.tsv**: Create `autoresearch/results.tsv` with the header row.
6. **Confirm and go**: Confirm setup looks good.

Once confirmed, kick off the experimentation loop.

## Running an Experiment

Each experiment takes **seconds** (not minutes like autoresearch). The backtest replays all resolved predictions from the database with your modified parameters.

```bash
npx ts-node -r tsconfig-paths/register autoresearch/backtest.ts > autoresearch/run.log 2>&1
```

Extract the key metric:

```bash
grep "^brier_score:" autoresearch/run.log
```

## What You CAN Modify

**ONLY `autoresearch/experiment-config.ts`**. Everything in the `EXPERIMENT_CONFIG` object is fair game:

### Ensemble Weights

- `bookmakerWeight`, `poissonWeight`, `claudeWeight` — relative importance of each signal
- `poissonConfidenceFloor/Multiplier` — how much to trust low-confidence Poisson
- Fallback weights when signals are missing

### Draw Calibration

- `tier1/2Threshold` — what counts as "close match" vs "moderate favourite"
- `tier1/2/3Floor` — minimum draw probability for each tier
- `gapClosureFactor` — how aggressively to enforce the floor (0-1)

### Overconfidence Dampening

- `threshold` — when to trigger dampening (max prob above this)
- `dampeningFactor` — how much to pull toward 1/3 (0.9 = 10% pull)

### Competitive Match Dampening

- `upperThreshold` / `lowerThreshold` — range of "competitive" matches
- `dampeningFactor` — pull strength toward 1/3

### Confidence Adjustment

- Thresholds and caps for remapping confidence scores
- Agreement/disagreement penalties and bonuses

### Result Logic

- When to predict "draw" vs a win outcome
- Thresholds for "very tight" and "competitive" matches
- Minimum draw probability and leader gap to trigger draw prediction

### Claude Pre-Validation

- Draw floor, max single prob cap, dampening applied to raw Claude output
- Confidence remapping from Claude's scale to calibrated scale

### Goal Blending

- How much to weight Poisson vs Claude for expected goals

## What You CANNOT Modify

- `autoresearch/backtest.ts` — the evaluation is fixed
- `autoresearch/program.md` — these instructions are fixed
- Any file in `src/` — production code is off-limits during experiments
- No new npm packages

## Logging Results

When an experiment finishes, log it to `autoresearch/results.tsv` (tab-separated).

Header and columns:

```
commit	brier_score	accuracy	status	description
```

1. Git commit hash (short, 7 chars)
2. brier_score (e.g. 0.543210) — use 0.000000 for crashes
3. accuracy percentage (e.g. 52.30) — use 0.00 for crashes
4. status: `keep`, `discard`, or `crash`
5. Short text description of what this experiment tried

Example:

```
commit	brier_score	accuracy	status	description
a1b2c3d	0.543210	52.30	keep	baseline
b2c3d4e	0.538900	53.10	keep	increase draw floor tier1 from 0.24 to 0.26
c3d4e5f	0.549100	51.80	discard	reduce bookmaker weight to 0.30
d4e5f6g	0.000000	0.00	crash	negative weight caused NaN
```

## The Experiment Loop

LOOP FOREVER:

1. Look at git state: current branch/commit
2. Modify `autoresearch/experiment-config.ts` with an experimental idea
3. `git commit -am "experiment: <brief description>"`
4. Run: `npx ts-node -r tsconfig-paths/register autoresearch/backtest.ts > autoresearch/run.log 2>&1`
5. Read results: `grep "^brier_score:\|^accuracy:" autoresearch/run.log`
6. If grep is empty → crash. Run `tail -n 30 autoresearch/run.log` to debug.
7. Record results in `autoresearch/results.tsv` (do NOT commit this file)
8. If brier_score **improved** (lower): keep the commit, advance the branch
9. If brier_score is **equal or worse**: `git reset --hard HEAD~1` to revert
10. GOTO 1

## Experiment Ideas (Starter List)

Here are ideas roughly ordered by expected impact. Start with the high-impact ones:

### High Impact

- **Draw floor tuning**: Try tier1Floor=0.26, tier2Floor=0.24, tier3Floor=0.20 (draws are ~26% of matches)
- **Ensemble weight rebalancing**: Try 0.35/0.35/0.30 or 0.45/0.25/0.30 bookmaker/Poisson/Claude
- **Result logic thresholds**: Lower `veryTightDrawFloor` from 0.30 to 0.28, or raise `competitiveDrawFloor` from 0.32 to 0.30
- **Gap closure factor**: Try 0.80 or 0.60 instead of 0.70

### Medium Impact

- **Overconfidence threshold**: Try 0.65 (more aggressive) or 0.75 (more lenient)
- **Competitive dampening range**: Widen to 0.35-0.52 or narrow to 0.40-0.48
- **Poisson confidence scaling**: Try floor=0.3 multiplier=2.0 to trust Poisson more
- **Combined draw adjustments**: Increase both draw floors AND make result logic predict draws more

### Lower Impact / Risky

- **Remove competitive dampening entirely** (set factor=1.0)
- **Remove overconfidence dampening** (set threshold=1.0)
- **Extreme draw floors**: tier1=0.30, tier2=0.28, tier3=0.22
- **Inverted ensemble**: Claude=0.50, Poisson=0.30, Bookmaker=0.20

## Strategy Tips

- **Change ONE thing at a time** so you know what helped or hurt
- **Draw calibration is probably your biggest lever** — models systematically under-predict draws
- **The Brier score penalizes overconfidence** — being less certain but more calibrated wins
- **Look at the calibration output**: if `avg prob when draw occurs` is much lower than `actual draw rate`, your draw calibration needs work
- **Don't chase accuracy alone** — Brier score rewards well-calibrated probabilities, not just correct picks
- **If you get stuck**, try combining two previous near-misses (e.g. a draw floor change that was +0.001 with a weight change that was +0.001)

## Simplicity Criterion

Same as autoresearch: all else being equal, simpler is better. If you can get the same Brier score with fewer adjustments or more default-like parameters, that's a win. Complexity should only be added when it clearly improves the metric.

## NEVER STOP

Once the experiment loop has begun, do NOT pause to ask the human if you should continue. The human might be away from the computer. You are autonomous. If you run out of ideas, think harder — re-read the production code for new angles, try combining previous near-misses, try more radical changes. The loop runs until the human interrupts you.
