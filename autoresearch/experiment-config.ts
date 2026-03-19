/**
 * Autoresearch Experiment Config
 * ==============================
 * This is THE file the agent modifies. Every tunable parameter in the
 * prediction pipeline is extracted here. The backtester reads this config
 * and replays all resolved predictions through the ensemble/calibration
 * logic to compute Brier score.
 *
 * IMPORTANT: The agent ONLY modifies this file. Everything else is fixed.
 *
 * Parameters are grouped by the pipeline stage they affect:
 *   1. Ensemble weights (how we blend Claude + Poisson + Bookmaker)
 *   2. Draw calibration (floor adjustments for draw probability)
 *   3. Overconfidence dampening (caps on extreme probabilities)
 *   4. Competitive match dampening (pulls tight matches toward 1/3)
 *   5. Confidence adjustment (how we remap Claude's confidence scores)
 *   6. Predicted result logic (when to predict draw vs win)
 *   7. Goal blending (how we mix Claude + Poisson expected goals)
 *   8. Claude pre-validation (adjustments before ensemble)
 */

export interface ExperimentConfig {
  // ─── 1. Ensemble Weights ────────────────────────────────────────────
  // These three weights are the relative importance of each signal.
  // They get normalized to sum to 1.0 at runtime.
  // When a signal is missing, remaining weights are redistributed.
  ensemble: {
    bookmakerWeight: number; // default: 0.40
    poissonWeight: number; // default: 0.30
    claudeWeight: number; // default: 0.30

    // Poisson confidence scaling: how much to trust low-confidence Poisson
    // The Poisson weight is multiplied by: max(floor, min(1.0, confidence * multiplier))
    poissonConfidenceFloor: number; // default: 0.5
    poissonConfidenceMultiplier: number; // default: 1.5

    // Fallback weights when signals are missing
    // When no bookmaker data:
    claudeWeightNoBookie: number; // default: 0.35
    poissonWeightNoBookie: number; // default: 0.65
    // When no Poisson data:
    claudeWeightNoPoisson: number; // default: 0.25
    bookmakerWeightNoPoisson: number; // default: 0.75
  };

  // ─── 2. Draw Floor Calibration ──────────────────────────────────────
  // Football draws occur ~26% of the time. Models systematically under-predict.
  // Draw floor = minimum draw probability, tiered by match closeness.
  drawCalibration: {
    // Tier thresholds (based on max(homeProb, awayProb) after initial blend)
    tier1Threshold: number; // default: 0.50 (close match)
    tier2Threshold: number; // default: 0.60 (moderate favourite)
    // Tier floors
    tier1Floor: number; // default: 0.24 (close match floor)
    tier2Floor: number; // default: 0.22 (moderate favourite floor)
    tier3Floor: number; // default: 0.18 (clear favourite floor)
    // How aggressively to close the gap between actual draw and floor
    // 0.0 = no adjustment, 1.0 = fully close the gap
    gapClosureFactor: number; // default: 0.70
  };

  // ─── 3. Overconfidence Dampening ────────────────────────────────────
  // When any single outcome prob exceeds a threshold, pull toward 1/3
  overconfidence: {
    threshold: number; // default: 0.70 — trigger when maxProb > this
    dampeningFactor: number; // default: 0.90 — 10% pull toward mean
  };

  // ─── 4. Competitive Match Dampening ─────────────────────────────────
  // When the max prob is modest, pull everything toward equal probability
  competitiveDampening: {
    upperThreshold: number; // default: 0.50 — only dampen when max < this
    lowerThreshold: number; // default: 0.38 — don't dampen very flat distributions
    dampeningFactor: number; // default: 0.95 — 5% pull toward 1/3
  };

  // ─── 5. Confidence Adjustment ───────────────────────────────────────
  // Remap Claude's raw confidence to our calibrated scale
  confidence: {
    // Max prob thresholds for confidence capping
    veryTightMaxProb: number; // default: 0.40 — cap conf at veryTightCap
    tightMaxProb: number; // default: 0.48 — cap conf at tightCap
    moderateMaxProb: number; // default: 0.55 — cap conf at moderateCap
    veryTightCap: number; // default: 4
    tightCap: number; // default: 5
    moderateCap: number; // default: 6
    // Disagreement penalty
    claudeBookieDisagreePenalty: number; // default: 2
    probDivergenceThreshold: number; // default: 0.15
    probDivergencePenalty: number; // default: 1
    // Agreement bonus
    allAgreeBonus: number; // default: 1
    allAgreeBonusCap: number; // default: 8
    allAgreeMinProb: number; // default: 0.50
  };

  // ─── 6. Predicted Result Logic ──────────────────────────────────────
  // When to predict "draw" instead of a win
  resultLogic: {
    // Very tight match: maxWinProb < veryTightThreshold
    veryTightThreshold: number; // default: 0.40
    veryTightDrawFloor: number; // default: 0.30
    veryTightLeaderGap: number; // default: 0.04

    // Competitive match: maxWinProb <= competitiveThreshold
    competitiveThreshold: number; // default: 0.50
    competitiveSpreadMax: number; // default: 0.05
    competitiveDrawFloor: number; // default: 0.32
  };

  // ─── 7. Goal Blending ──────────────────────────────────────────────
  // How much to trust Poisson vs Claude for expected goals
  goalBlending: {
    poissonGoalWeight: number; // default: 0.65
  };

  // ─── 8. Claude Pre-Validation ──────────────────────────────────────
  // Adjustments applied to Claude's raw output BEFORE ensemble
  claudePreValidation: {
    drawFloor: number; // default: 0.22
    maxSingleProb: number; // default: 0.65
    maxProbDampeningFactor: number; // default: 0.85 — 15% pull toward mean

    // Confidence remapping: Claude's raw → our calibrated
    // Claude 8-10 → highMap, 6-7 → midMap, 4-5 → lowMap, 1-3 → pass-through
    confidenceHighMap: number; // default: 6
    confidenceMidMap: number; // default: 5
    confidenceLowMap: number; // default: 4
  };
}

/**
 * THE CURRENT EXPERIMENT CONFIG
 *
 * This is what the agent modifies. Change values, run backtest, keep or discard.
 */
export const EXPERIMENT_CONFIG: ExperimentConfig = {
  ensemble: {
    bookmakerWeight: 0.4,
    poissonWeight: 0.3,
    claudeWeight: 0.3,
    poissonConfidenceFloor: 0.5,
    poissonConfidenceMultiplier: 1.5,
    claudeWeightNoBookie: 0.35,
    poissonWeightNoBookie: 0.65,
    claudeWeightNoPoisson: 0.25,
    bookmakerWeightNoPoisson: 0.75,
  },

  drawCalibration: {
    tier1Threshold: 0.5,
    tier2Threshold: 0.6,
    tier1Floor: 0.4,
    tier2Floor: 0.36,
    tier3Floor: 0.2,
    gapClosureFactor: 1.0,
  },

  overconfidence: {
    threshold: 0.7,
    dampeningFactor: 0.9,
  },

  competitiveDampening: {
    upperThreshold: 0.5,
    lowerThreshold: 0.38,
    dampeningFactor: 1.0,
  },

  confidence: {
    veryTightMaxProb: 0.4,
    tightMaxProb: 0.48,
    moderateMaxProb: 0.55,
    veryTightCap: 4,
    tightCap: 5,
    moderateCap: 6,
    claudeBookieDisagreePenalty: 2,
    probDivergenceThreshold: 0.15,
    probDivergencePenalty: 1,
    allAgreeBonus: 1,
    allAgreeBonusCap: 8,
    allAgreeMinProb: 0.5,
  },

  resultLogic: {
    veryTightThreshold: 0.4,
    veryTightDrawFloor: 0.3,
    veryTightLeaderGap: 0.04,
    competitiveThreshold: 0.5,
    competitiveSpreadMax: 0.05,
    competitiveDrawFloor: 0.32,
  },

  goalBlending: {
    poissonGoalWeight: 0.65,
  },

  claudePreValidation: {
    drawFloor: 0.22,
    maxSingleProb: 0.65,
    maxProbDampeningFactor: 0.85,
    confidenceHighMap: 6,
    confidenceMidMap: 5,
    confidenceLowMap: 4,
  },
};
