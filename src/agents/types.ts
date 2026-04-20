/**
 * Shared types for the prediction agent pipeline.
 * Placed here to avoid circular dependencies between agents.service and analysis.agent.
 */

export type PredictionType = 'daily' | 'pre_match' | 'on_demand';

export interface PerformanceFeedback {
  totalResolved: number;
  overallAccuracy: number;
  avgBrierScore: number;
  byResult: {
    home_win: { predicted: number; correct: number; accuracy: number };
    draw: { predicted: number; correct: number; accuracy: number };
    away_win: { predicted: number; correct: number; accuracy: number };
  };
  avgProbabilities: {
    homeWinProb: number;
    drawProb: number;
    awayWinProb: number;
  };
  actualDistribution: {
    homeWinPct: number;
    drawPct: number;
    awayWinPct: number;
  };
  biasInsights: string[];
  confidenceCalibration: {
    highConfidence: { total: number; correct: number; accuracy: number };
    medConfidence: { total: number; correct: number; accuracy: number };
    lowConfidence: { total: number; correct: number; accuracy: number };
  };
  leagueBreakdown: Record<
    string,
    { total: number; correct: number; accuracy: number }
  >;
}

/**
 * Output from the Poisson statistical model.
 */
export interface PoissonModelOutput {
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  confidence: number; // 0-1 based on data quality
  dataPoints: number; // number of matches used
}
