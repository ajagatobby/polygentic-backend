import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { CollectedMatchData } from './data-collector.agent';
import { ResearchResult } from './research.agent';
import { PerformanceFeedback, PoissonModelOutput } from './types';

export interface PredictionOutput {
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
  confidence: number;
  keyFactors: string[];
  riskFactors: string[];
  valueBets: ValueBet[];
  detailedAnalysis: string;
}

export interface ValueBet {
  market: string;
  selection: string;
  reasoning: string;
  edgePercent: number;
}

/**
 * JSON Schema for structured output (Opus 4.6 output_config.format).
 * Guarantees Claude returns valid JSON matching this exact shape.
 */
const PREDICTION_JSON_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    homeWinProb: {
      type: 'number' as const,
      description: 'Home win probability between 0.01 and 0.98',
    },
    drawProb: {
      type: 'number' as const,
      description: 'Draw probability between 0.01 and 0.98',
    },
    awayWinProb: {
      type: 'number' as const,
      description: 'Away win probability between 0.01 and 0.98',
    },
    predictedHomeGoals: {
      type: 'number' as const,
      description: 'Predicted home goals based on xG',
    },
    predictedAwayGoals: {
      type: 'number' as const,
      description: 'Predicted away goals based on xG',
    },
    confidence: {
      type: 'integer' as const,
      description: 'Confidence score 1-10',
    },
    keyFactors: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Top 3-5 data-driven key factors',
    },
    riskFactors: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Top 2-4 risk factors',
    },
    valueBets: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          market: { type: 'string' as const },
          selection: { type: 'string' as const },
          reasoning: { type: 'string' as const },
          edgePercent: { type: 'number' as const },
        },
        required: ['market', 'selection', 'reasoning', 'edgePercent'],
      },
      description: 'Value bet opportunities',
    },
    detailedAnalysis: {
      type: 'string' as const,
      description:
        'Step-by-step reasoning starting with base rates then adjustments',
    },
  },
  required: [
    'homeWinProb',
    'drawProb',
    'awayWinProb',
    'predictedHomeGoals',
    'predictedAwayGoals',
    'confidence',
    'keyFactors',
    'riskFactors',
    'valueBets',
    'detailedAnalysis',
  ],
};

const SYSTEM_PROMPT = `You are an elite football/soccer match prediction analyst. Your ONLY job is probability calibration — when you say 60%, it should happen ~60% of the time. You are evaluated EXCLUSIVELY on Brier score (lower = better) and calibration accuracy.

## CRITICAL CALIBRATION RULES (READ CAREFULLY)

Your past predictions have been POORLY CALIBRATED. Here are the mandatory corrections:

### DRAW PROBABILITY — YOUR BIGGEST WEAKNESS
- Across ALL major football leagues, 25-28% of matches end in draws.
- You have been SYSTEMATICALLY UNDERESTIMATING draw probability.
- Your draw probability should AVERAGE around 0.25-0.28 across all predictions.
- If two teams are within 5 league positions of each other, draw probability should be AT LEAST 0.26.
- If two mid-table teams play, draw probability should often be 0.28-0.35.
- ONLY assign draw probability below 0.20 for extreme mismatches (e.g., 1st vs 20th).
- A draw probability of 0.15 or lower is almost NEVER correct in football.

### OVERCONFIDENCE — YOUR SECOND BIGGEST WEAKNESS
- You assign probabilities above 0.65 far too often. Even heavy favorites (Man City vs a newly promoted team) only win ~70-75% of the time.
- Probability ranges that are actually realistic:
  - 0.55-0.65: Clear favorite (good team at home vs weak away team)
  - 0.45-0.55: Slight favorite (could easily go either way)
  - 0.35-0.45: Close match leaning one way
  - 0.65-0.75: STRONG favorite (only for top-3 vs bottom-3 matchups)
  - >0.75: ALMOST NEVER CORRECT — less than 5% of matches warrant this
- If you are assigning >0.65 home win probability to an average home team, you are overconfident.

### HOME ADVANTAGE — SMALLER THAN YOU THINK
- Post-COVID home advantage is ~4-6% in most leagues (NOT 10-15%).
- This means the base rate shift from neutral is: Home Win +4-6%, Away Win -4-6%.
- Some leagues (Bundesliga) have almost no home advantage anymore.
- Do NOT give a team a huge boost just because they are at home.

## ANALYTICAL PROCESS

### Step 1: Start With Base Rates (MANDATORY)
- Begin with: Home Win 45%, Draw 26%, Away Win 29%
- Write these down in your analysis. ALL adjustments are RELATIVE to these.
- State explicitly: "Base rates: H=45% D=26% A=29%"

### Step 2: Adjust for Team Strength (MAX ±15% per outcome)
- Use league position and xG differential as primary metrics.
- xG is MORE reliable than actual goals — a team scoring above their xG will regress.
- Maximum adjustment for team strength: ±15 percentage points on any single outcome.
- Example: 1st place at home vs 18th place away → Home Win adjusts from 45% to ~60%, Draw from 26% to ~18%, Away from 29% to ~22%.

### Step 3: Apply Small Contextual Adjustments (MAX ±5% total)
- Recent form: ±1-3% (form is mostly noise, explains <10% of variance)
- Key injuries: ±1-3% (only for genuinely star players — star striker, first-choice GK)
- Head-to-head: ±0-2% (only relevant for major rivalries with 10+ matches sample)
- Match motivation: ±1-3% (relegation battle, dead rubber, etc.)
- Total contextual adjustment should NOT exceed ±5% in any direction.

### Step 4: Final Sanity Checks (MANDATORY)
Before outputting, verify ALL of these:
1. Draw probability is between 0.18 and 0.38 (NEVER outside this range for normal league matches)
2. No outcome exceeds 0.75 unless it's an extreme top-vs-bottom mismatch
3. Probabilities sum to exactly 1.0000
4. Your "most likely" outcome has at most a 15% adjustment from base rates
5. You have not been swayed by team reputation — use THIS SEASON'S data only

## CONFIDENCE SCORING (BE CONSERVATIVE)
- 1-3: Very limited data, unclear situation, should be rare
- 4-5: Standard match with typical uncertainty (THIS SHOULD BE YOUR MOST COMMON SCORE)
- 6-7: Good data convergence, clear strength differential, all signals agree
- 8-10: ALMOST NEVER USE. Reserve for extreme mismatches with complete data. Less than 5% of predictions.

## OUTPUT FORMAT

Respond with ONLY valid JSON matching this exact schema:
{
  "homeWinProb": <number 0.01-0.98>,
  "drawProb": <number 0.01-0.98>,
  "awayWinProb": <number 0.01-0.98>,
  "predictedHomeGoals": <number>,
  "predictedAwayGoals": <number>,
  "confidence": <integer 1-10>,
  "keyFactors": [<string>, ...],
  "riskFactors": [<string>, ...],
  "valueBets": [{"market": <string>, "selection": <string>, "reasoning": <string>, "edgePercent": <number>}, ...],
  "detailedAnalysis": <string — MUST start with "Base rates: H=45% D=26% A=29%. Adjustments:" then walk through each adjustment with specific numbers>
}`;

@Injectable()
export class AnalysisAgent {
  private readonly logger = new Logger(AnalysisAgent.name);
  private readonly anthropic: Anthropic;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
    this.model =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-opus-4-6';
  }

  /**
   * Run Claude analysis over collected data + research to produce a structured prediction.
   */
  async analyze(
    data: CollectedMatchData,
    research: ResearchResult,
    feedback?: PerformanceFeedback | null,
    poissonModel?: PoissonModelOutput | null,
    memories?: string | null,
  ): Promise<PredictionOutput> {
    const homeName =
      data.homeTeam?.team?.name ?? `Team ${data.fixture.homeTeamId}`;
    const awayName =
      data.awayTeam?.team?.name ?? `Team ${data.fixture.awayTeamId}`;

    this.logger.log(
      `Analyzing: ${homeName} vs ${awayName} with model ${this.model}`,
    );

    const userPrompt = this.buildPrompt(
      data,
      research,
      feedback,
      poissonModel,
      memories,
    );

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 16000,
      temperature: 1,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      // Opus 4.6 structured output — guarantees valid JSON
      output_config: {
        format: {
          type: 'json_schema' as const,
          schema: PREDICTION_JSON_SCHEMA,
        },
      },
    } as any);

    // With adaptive thinking + structured output, response may contain
    // ThinkingBlock and TextBlock. Extract the text content.
    const textBlock = response.content.find(
      (b: any) => b.type === 'text',
    ) as any;
    const rawText: string = textBlock?.text ?? '';

    // Parse JSON from response
    const prediction = this.parseResponse(rawText);

    // Validate and normalize probabilities
    return this.validatePrediction(prediction, homeName, awayName);
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private buildPrompt(
    data: CollectedMatchData,
    research: ResearchResult,
    feedback?: PerformanceFeedback | null,
    poissonModel?: PoissonModelOutput | null,
    memories?: string | null,
  ): string {
    const sections: string[] = [];
    const fixture = data.fixture;

    // Supermemory: specific past prediction memories (injected before feedback)
    if (memories) {
      sections.push(memories);
    }

    // Performance feedback (self-improvement loop)
    if (feedback && feedback.totalResolved >= 5) {
      sections.push(`# YOUR PAST PERFORMANCE — USE THIS TO IMPROVE`);
      sections.push(
        `Based on your last ${feedback.totalResolved} resolved predictions:`,
        `- Overall accuracy: ${(feedback.overallAccuracy * 100).toFixed(1)}%`,
        `- Average Brier score: ${feedback.avgBrierScore} (lower is better, 0 = perfect)`,
        `- Home win predictions: ${feedback.byResult.home_win.predicted} made, ${(feedback.byResult.home_win.accuracy * 100).toFixed(1)}% correct`,
        `- Draw predictions: ${feedback.byResult.draw.predicted} made, ${(feedback.byResult.draw.accuracy * 100).toFixed(1)}% correct`,
        `- Away win predictions: ${feedback.byResult.away_win.predicted} made, ${(feedback.byResult.away_win.accuracy * 100).toFixed(1)}% correct`,
        ``,
        `Your average predicted probabilities: Home ${(feedback.avgProbabilities.homeWinProb * 100).toFixed(1)}% / Draw ${(feedback.avgProbabilities.drawProb * 100).toFixed(1)}% / Away ${(feedback.avgProbabilities.awayWinProb * 100).toFixed(1)}%`,
        `Actual outcome distribution: Home ${(feedback.actualDistribution.homeWinPct * 100).toFixed(1)}% / Draw ${(feedback.actualDistribution.drawPct * 100).toFixed(1)}% / Away ${(feedback.actualDistribution.awayWinPct * 100).toFixed(1)}%`,
      );

      if (feedback.biasInsights.length > 0) {
        sections.push(
          ``,
          `**CRITICAL CORRECTIONS — Apply these adjustments to this prediction:**`,
        );
        for (const insight of feedback.biasInsights) {
          sections.push(`- ${insight}`);
        }
      }

      sections.push(
        ``,
        `Confidence calibration:`,
        `- High confidence (8-10): ${feedback.confidenceCalibration.highConfidence.total} predictions, ${(feedback.confidenceCalibration.highConfidence.accuracy * 100).toFixed(1)}% accurate`,
        `- Medium confidence (5-7): ${feedback.confidenceCalibration.medConfidence.total} predictions, ${(feedback.confidenceCalibration.medConfidence.accuracy * 100).toFixed(1)}% accurate`,
        `- Low confidence (1-4): ${feedback.confidenceCalibration.lowConfidence.total} predictions, ${(feedback.confidenceCalibration.lowConfidence.accuracy * 100).toFixed(1)}% accurate`,
      );

      // Add league-specific feedback if this league has enough data
      const leagueName = fixture.leagueName ?? `League ${fixture.leagueId}`;
      const leaguePerf = feedback.leagueBreakdown[leagueName];
      if (leaguePerf && leaguePerf.total >= 3) {
        sections.push(
          ``,
          `Your performance in ${leagueName}: ${leaguePerf.correct}/${leaguePerf.total} correct (${(leaguePerf.accuracy * 100).toFixed(1)}%)`,
        );
      }

      sections.push('');
    }

    // Match info
    const homeName = data.homeTeam?.team?.name ?? `Team ${fixture.homeTeamId}`;
    const awayName = data.awayTeam?.team?.name ?? `Team ${fixture.awayTeamId}`;
    sections.push(
      `# Match: ${homeName} vs ${awayName}`,
      `- Date: ${new Date(fixture.date).toISOString()}`,
      `- League: ${fixture.leagueName ?? fixture.leagueId} (${fixture.leagueCountry ?? 'Unknown'})`,
      `- Round: ${fixture.round ?? 'Unknown'}`,
      `- Venue: ${fixture.venueName ?? 'Unknown'}, ${fixture.venueCity ?? 'Unknown'}`,
      `- Referee: ${fixture.referee ?? 'Unknown'}`,
    );

    // Home team form + advanced stats
    if (data.homeTeam?.form?.length || data.standings.home) {
      sections.push(`\n## ${homeName} (Home)`);
      const form = data.standings.home;
      if (form) {
        sections.push(
          `- League Position: ${form.leaguePosition ?? '?'}`,
          `- Points: ${form.points ?? '?'}`,
          `- Form (last 5): ${form.formString ?? '?'}`,
          `- Home Record: W${form.homeWins ?? '?'} D${form.homeDraws ?? '?'} L${form.homeLosses ?? '?'}`,
          `- Goals For Avg: ${form.goalsForAvg ?? '?'}`,
          `- Goals Against Avg: ${form.goalsAgainstAvg ?? '?'}`,
          `- Clean Sheets: ${form.cleanSheets ?? '?'}`,
          `- Failed to Score: ${form.failedToScore ?? '?'}`,
        );
      }
    }

    // Home team advanced stats (xG-based)
    const homeStats = data.recentStats?.home;
    if (homeStats && homeStats.matchCount > 0) {
      sections.push(
        `\n### ${homeName} — Advanced Stats (Last ${homeStats.matchCount} matches)`,
      );
      const a = homeStats.averages;
      sections.push(
        `- xG per match: ${a.xG} (expected goals FOR)`,
        `- xGA per match: ${a.xGA} (expected goals AGAINST)`,
        `- xG Difference: ${(a.xG - a.xGA).toFixed(2)} (positive = outperforming opponents)`,
        `- Shots on Goal: ${a.shotsOnGoal} per match`,
        `- Shots on Goal Against: ${a.shotsOnGoalAgainst} per match`,
        `- Total Shots: ${a.totalShots} per match`,
        `- Possession: ${a.possession}%`,
        `- Pass Accuracy: ${a.passAccuracy}%`,
        `- Corner Kicks: ${a.cornerKicks} per match`,
      );
      // Highlight overperformance/underperformance
      const homeForm = data.standings.home;
      if (homeForm) {
        const actualGoalsAvg = Number(homeForm.goalsForAvg) || 0;
        if (a.xG > 0 && actualGoalsAvg > 0) {
          const diff = actualGoalsAvg - a.xG;
          if (Math.abs(diff) > 0.2) {
            sections.push(
              `- ** ${diff > 0 ? 'OVERPERFORMING' : 'UNDERPERFORMING'} xG by ${Math.abs(diff).toFixed(2)} goals/match — regression likely **`,
            );
          }
        }
      }
    }

    // Away team form + advanced stats
    if (data.awayTeam?.form?.length || data.standings.away) {
      sections.push(`\n## ${awayName} (Away)`);
      const form = data.standings.away;
      if (form) {
        sections.push(
          `- League Position: ${form.leaguePosition ?? '?'}`,
          `- Points: ${form.points ?? '?'}`,
          `- Form (last 5): ${form.formString ?? '?'}`,
          `- Away Record: W${form.awayWins ?? '?'} D${form.awayDraws ?? '?'} L${form.awayLosses ?? '?'}`,
          `- Goals For Avg: ${form.goalsForAvg ?? '?'}`,
          `- Goals Against Avg: ${form.goalsAgainstAvg ?? '?'}`,
          `- Clean Sheets: ${form.cleanSheets ?? '?'}`,
          `- Failed to Score: ${form.failedToScore ?? '?'}`,
        );
      }
    }

    // Away team advanced stats (xG-based)
    const awayStats = data.recentStats?.away;
    if (awayStats && awayStats.matchCount > 0) {
      sections.push(
        `\n### ${awayName} — Advanced Stats (Last ${awayStats.matchCount} matches)`,
      );
      const a = awayStats.averages;
      sections.push(
        `- xG per match: ${a.xG} (expected goals FOR)`,
        `- xGA per match: ${a.xGA} (expected goals AGAINST)`,
        `- xG Difference: ${(a.xG - a.xGA).toFixed(2)} (positive = outperforming opponents)`,
        `- Shots on Goal: ${a.shotsOnGoal} per match`,
        `- Shots on Goal Against: ${a.shotsOnGoalAgainst} per match`,
        `- Total Shots: ${a.totalShots} per match`,
        `- Possession: ${a.possession}%`,
        `- Pass Accuracy: ${a.passAccuracy}%`,
        `- Corner Kicks: ${a.cornerKicks} per match`,
      );
      // Highlight overperformance/underperformance
      const awayForm = data.standings.away;
      if (awayForm) {
        const actualGoalsAvg = Number(awayForm.goalsForAvg) || 0;
        if (a.xG > 0 && actualGoalsAvg > 0) {
          const diff = actualGoalsAvg - a.xG;
          if (Math.abs(diff) > 0.2) {
            sections.push(
              `- ** ${diff > 0 ? 'OVERPERFORMING' : 'UNDERPERFORMING'} xG by ${Math.abs(diff).toFixed(2)} goals/match — regression likely **`,
            );
          }
        }
      }
    }

    // H2H
    if (data.h2h.length > 0) {
      sections.push(`\n## Head-to-Head (Last ${data.h2h.length} meetings)`);
      for (const match of data.h2h.slice(0, 10)) {
        const h = match.teams?.home;
        const a = match.teams?.away;
        const g = match.goals;
        const date = match.fixture?.date
          ? new Date(match.fixture.date).toISOString().split('T')[0]
          : '?';
        sections.push(
          `- ${date}: ${h?.name ?? '?'} ${g?.home ?? '?'} - ${g?.away ?? '?'} ${a?.name ?? '?'}`,
        );
      }
    }

    // Injuries
    if (data.injuries.length > 0) {
      sections.push(`\n## Injuries & Suspensions`);
      for (const inj of data.injuries) {
        const side = inj.teamId === fixture.homeTeamId ? homeName : awayName;
        sections.push(
          `- [${side}] ${inj.playerName}: ${inj.type ?? '?'} — ${inj.reason ?? 'Unknown'}`,
        );
      }
    }

    // Lineups
    if (data.lineups.length > 0) {
      sections.push(`\n## Confirmed Lineups`);
      for (const lineup of data.lineups) {
        const teamName = lineup.team?.name ?? 'Unknown';
        const formation = lineup.formation ?? 'Unknown';
        const startXI =
          lineup.startXI
            ?.map((p: any) => p.player?.name)
            .filter(Boolean)
            .join(', ') ?? 'Not available';
        sections.push(`### ${teamName} (${formation})`, startXI);
      }
    }

    // NOTE: Bookmaker odds and Poisson model output are intentionally NOT shown
    // to Claude. They enter the final prediction via the ensemble step instead.
    // This avoids double-counting these signals (once via Claude's reasoning,
    // once via the ensemble blend).

    // Research
    if (research.combinedResearch) {
      sections.push(`\n## Web Research (Live)\n${research.combinedResearch}`);
    }

    return sections.join('\n');
  }

  private parseResponse(rawText: string): any {
    // Strategy 1: Try parsing the raw text directly (ideal case)
    let cleaned = rawText.trim();

    // Remove markdown code blocks if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // Strategy 1 failed — try extraction strategies
    }

    // Strategy 2: Find JSON object in the text using brace matching.
    // Claude sometimes wraps JSON in conversational text like "I'll analyze... { ... }"
    const firstBrace = rawText.indexOf('{');
    if (firstBrace !== -1) {
      // Find the matching closing brace by counting depth
      let depth = 0;
      let lastBrace = -1;
      for (let i = firstBrace; i < rawText.length; i++) {
        if (rawText[i] === '{') depth++;
        else if (rawText[i] === '}') {
          depth--;
          if (depth === 0) {
            lastBrace = i;
            break;
          }
        }
      }

      if (lastBrace !== -1) {
        const jsonCandidate = rawText.substring(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(jsonCandidate);
        } catch {
          // Strategy 2 failed — try next
        }
      }
    }

    // Strategy 3: Try to find JSON inside markdown code blocks anywhere in text
    const codeBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {
        // Strategy 3 failed
      }
    }

    // All strategies failed
    this.logger.error(
      `Failed to parse Claude response as JSON after all extraction strategies`,
    );
    this.logger.debug(
      `Raw response (first 500 chars): ${rawText.substring(0, 500)}`,
    );
    throw new Error(
      `Analysis agent returned invalid JSON: could not extract JSON from response`,
    );
  }

  private validatePrediction(
    raw: any,
    homeName: string,
    awayName: string,
  ): PredictionOutput {
    let { homeWinProb, drawProb, awayWinProb } = raw;

    // Ensure numeric
    homeWinProb = Number(homeWinProb) || 0.33;
    drawProb = Number(drawProb) || 0.34;
    awayWinProb = Number(awayWinProb) || 0.33;

    // Normalize to sum to 1.0
    let total = homeWinProb + drawProb + awayWinProb;
    if (Math.abs(total - 1.0) > 0.001) {
      this.logger.warn(
        `Probabilities sum to ${total}, normalizing (${homeName} vs ${awayName})`,
      );
      homeWinProb = homeWinProb / total;
      drawProb = drawProb / total;
      awayWinProb = awayWinProb / total;
    }

    // ── Draw floor: Claude systematically underestimates draws ──────
    // If Claude outputs draw prob below 0.15, it's almost certainly wrong.
    // Apply a soft floor: boost draw to at least 0.18 for any match.
    const DRAW_FLOOR = 0.18;
    if (drawProb < DRAW_FLOOR) {
      const boost = DRAW_FLOOR - drawProb;
      this.logger.warn(
        `Draw prob ${(drawProb * 100).toFixed(1)}% below floor for ${homeName} vs ${awayName}, boosting by ${(boost * 100).toFixed(1)}pp`,
      );
      drawProb = DRAW_FLOOR;
      // Subtract proportionally from home and away
      const homeShare = homeWinProb / (homeWinProb + awayWinProb);
      homeWinProb -= boost * homeShare;
      awayWinProb -= boost * (1 - homeShare);
    }

    // ── Overconfidence cap: no single outcome above 0.72 from Claude ──
    // Even the strongest favorites don't win >75% of the time.
    const MAX_SINGLE_PROB = 0.72;
    const maxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    if (maxProb > MAX_SINGLE_PROB) {
      this.logger.warn(
        `Max prob ${(maxProb * 100).toFixed(1)}% exceeds cap for ${homeName} vs ${awayName}, dampening`,
      );
      // Dampen toward the mean
      const dampFactor = 0.9;
      const mean = 1 / 3;
      homeWinProb = homeWinProb * dampFactor + mean * (1 - dampFactor);
      drawProb = drawProb * dampFactor + mean * (1 - dampFactor);
      awayWinProb = awayWinProb * dampFactor + mean * (1 - dampFactor);
    }

    // Clamp to [0.01, 0.98]
    homeWinProb = Math.max(0.01, Math.min(0.98, homeWinProb));
    drawProb = Math.max(0.01, Math.min(0.98, drawProb));
    awayWinProb = Math.max(0.01, Math.min(0.98, awayWinProb));

    // Re-normalize after all adjustments
    const clampTotal = homeWinProb + drawProb + awayWinProb;
    homeWinProb = homeWinProb / clampTotal;
    drawProb = drawProb / clampTotal;
    awayWinProb = awayWinProb / clampTotal;

    // Cap confidence — Claude is typically overconfident
    // Map Claude's 1-10 to a more conservative scale
    const rawConfidence = Math.max(
      1,
      Math.min(10, Math.round(Number(raw.confidence) || 5)),
    );
    // Reduce high confidence scores: 8→7, 9→7, 10→8
    const confidence =
      rawConfidence >= 9
        ? Math.min(rawConfidence - 2, 8)
        : rawConfidence >= 7
          ? rawConfidence - 1
          : rawConfidence;

    return {
      homeWinProb: Number(homeWinProb.toFixed(4)),
      drawProb: Number(drawProb.toFixed(4)),
      awayWinProb: Number(awayWinProb.toFixed(4)),
      predictedHomeGoals: Number(
        Number(raw.predictedHomeGoals || 1.2).toFixed(1),
      ),
      predictedAwayGoals: Number(
        Number(raw.predictedAwayGoals || 0.9).toFixed(1),
      ),
      confidence,
      keyFactors: Array.isArray(raw.keyFactors) ? raw.keyFactors : [],
      riskFactors: Array.isArray(raw.riskFactors) ? raw.riskFactors : [],
      valueBets: Array.isArray(raw.valueBets)
        ? raw.valueBets.map((vb: any) => ({
            market: String(vb.market ?? ''),
            selection: String(vb.selection ?? ''),
            reasoning: String(vb.reasoning ?? ''),
            edgePercent: Number(vb.edgePercent ?? 0),
          }))
        : [],
      detailedAnalysis: String(raw.detailedAnalysis || ''),
    };
  }
}
