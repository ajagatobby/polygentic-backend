import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { CollectedMatchData } from './data-collector.agent';
import { ResearchResult } from './research.agent';
import { PerformanceFeedback, PoissonModelOutput } from './types';

// ─── Provider detection ─────────────────────────────────────────────
type ModelProvider = 'anthropic' | 'openai';

/**
 * Auto-detect the LLM provider from the model name.
 * OpenAI models: o1, o3, o4-mini, gpt-4o, gpt-5, etc.
 * Everything else defaults to Anthropic (Claude).
 */
function detectProvider(model: string): ModelProvider {
  const m = model.toLowerCase();
  if (
    m.startsWith('gpt-') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m === 'chatgpt-4o-latest'
  ) {
    return 'openai';
  }
  return 'anthropic';
}

/**
 * Detect if the model is an OpenAI reasoning model (o-series).
 * Reasoning models use `reasoning_effort` instead of `temperature`,
 * and use `developer` role instead of `system` role.
 */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
}

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

## THE FUNDAMENTAL TRUTH ABOUT FOOTBALL PREDICTIONS

Football is inherently unpredictable. Even the best models in academia achieve only ~50-55% accuracy on 1X2 markets. If you are assigning high probabilities to outcomes, you are almost certainly overconfident.

Key empirical facts you MUST internalise:
- The "favourite" (by odds) wins only ~55% of the time, NOT 70-75%
- Draws occur in ~26% of all matches, but most models predict them <10% of the time
- Upsets (non-favourite winning) happen ~20% of the time
- A team at 40% probability wins just as often as you'd expect — 2 out of 5 times

## CRITICAL CALIBRATION RULES

### DRAW PROBABILITY — YOUR #1 PRIORITY
- Across ALL major football leagues, 25-28% of matches end in draws.
- You have been SYSTEMATICALLY UNDERESTIMATING draw probability.
- Your draw probability should AVERAGE 0.26-0.30 across all predictions.
- SPECIFIC RULES:
  - Teams within 3 league positions: draw >= 0.30
  - Teams within 5 league positions: draw >= 0.28
  - Mid-table teams (positions 8-15): draw >= 0.28, often 0.30-0.35
  - Teams with similar xG profiles (< 0.3 xG/match difference): draw >= 0.28
  - Both teams in poor form (W rate < 40%): draw >= 0.30
  - ONLY assign draw below 0.22 for extreme mismatches (top 3 vs bottom 3)
  - A draw probability of 0.18 or lower is almost NEVER correct

### OVERCONFIDENCE — THE TRAP YOU KEEP FALLING INTO
- You assign probabilities above 0.55 far too often.
- Realistic probability ranges:
  - 0.50-0.58: Clear favourite (top-6 at home vs bottom-half away team)
  - 0.42-0.50: Slight favourite (most matches fall here)
  - 0.35-0.42: Close match leaning one way
  - 0.58-0.65: STRONG favourite (only top-3 vs bottom-3, AND at home)
  - >0.65: ALMOST NEVER CORRECT — less than 3% of matches warrant this
- If the favourite's probability exceeds 0.55, ask yourself: "Would I bet my salary on this team winning?" If not, lower it.

### HOME ADVANTAGE — MUCH SMALLER THAN YOU THINK
- Post-COVID home advantage is ~3-5% in most leagues (NOT 8-15%).
- In some leagues (Bundesliga, Ligue 1, Serie A) it's as low as 2-3%.
- Do NOT give a team a meaningful boost just for being at home.
- Home advantage mainly manifests in draw probability shifting slightly.

### FORM IS MOSTLY NOISE
- A team's last 5 results explain less than 10% of their next result.
- A team on a 3-match winning streak is NOT significantly more likely to win.
- Regression to the mean is the strongest force in football — hot streaks end.
- Weight xG differential over actual results; lucky wins don't persist.

## ANALYTICAL PROCESS

### Step 1: Start With Base Rates (MANDATORY)
- Begin with: Home Win 44%, Draw 27%, Away Win 29%
- Write these down in your analysis. ALL adjustments are RELATIVE to these.
- State explicitly: "Base rates: H=44% D=27% A=29%"

### Step 2: Classify the Match Type
Before adjusting probabilities, classify the match:
- TIGHT (teams within 5 positions, similar xG): adjustments should be small (±5% max)
- MODERATE (clear but not extreme quality gap): adjustments up to ±10%
- MISMATCH (top 3 vs bottom 3, huge xG gap): adjustments up to ±15%
- Most matches are TIGHT or MODERATE. State your classification explicitly.

### Step 3: Adjust for Team Strength (respect the match type caps)
- Use xG differential as THE primary metric (more predictive than goals scored).
- League position is secondary — it reflects past luck as much as quality.
- A team outperforming xG by >0.3 goals/match WILL regress — factor this in.
- TIGHT matches: max total adjustment is ±5% from base rates
- MODERATE matches: max total adjustment is ±10% from base rates
- MISMATCH: max total adjustment is ±15% from base rates

### Step 4: Apply Contextual Adjustments (MAX ±5% total)
- Round/rematch context (MANDATORY):
  - You are given whether this fixture is a same-competition, same-season rematch.
  - If it is a rematch, explicitly reference the prior meeting scoreline and whether venue order is reversed.
  - Treat this as context, not destiny (usually only a small adjustment, about ±0-2%).
- **Key injuries (USE THE IMPACT SCORES)**: The injury data now includes quantified impact scores (0-1 scale) based on goal involvement, starter status, and position. Use these scores directly:
  - CRITICAL impact (0.6+): adjust by ±2-3% — this player's absence materially changes the match
  - HIGH impact (0.4-0.6): adjust by ±1-2%
  - MODERATE impact (0.25-0.4): adjust by ±0.5-1%
  - LOW/MINIMAL: ignore — these are squad players
  - Pay attention to the xG/xGA multipliers — they tell you exactly how much the team's attacking/defensive output is reduced
  - A team with xG ×0.85 (15% offensive reduction) should have their win probability reduced noticeably
- Match motivation: ±1-2% (relegation 6-pointer, title decider, dead rubber)
- Head-to-head: ±0-1% (only with 10+ match sample, and only if pattern is extreme)
- Weather/travel: ±0-1% (rarely significant)
- TOTAL contextual adjustment MUST NOT exceed ±5% in any direction.

### Step 5: Final Sanity Checks (MANDATORY)
Before outputting, verify ALL of these:
1. Draw probability is between 0.20 and 0.38 for normal league matches
2. No outcome exceeds 0.65 unless match classification is MISMATCH
3. Probabilities sum to exactly 1.0000
4. For TIGHT matches: no outcome exceeds 0.50
5. For MODERATE matches: no outcome exceeds 0.58
6. You have not been swayed by team reputation — use THIS SEASON'S data only
7. If you are predicting a win, check: "Is the draw probability at least 0.24?" If not, raise it.

## CONFIDENCE SCORING (BE BRUTALLY CONSERVATIVE)
- 3-4: Standard match with typical uncertainty (THIS IS YOUR DEFAULT — use for 70% of predictions)
- 5: Good data convergence, moderate strength differential
- 6: Clear strength differential confirmed by xG, form, AND bookmaker odds
- 7: RARE. All signals strongly converge. Clear mismatch with full data.
- 8-10: DO NOT USE. No football match warrants this level of confidence.

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
  "detailedAnalysis": <string — MUST start with "Base rates: H=44% D=27% A=29%. Match type: [TIGHT/MODERATE/MISMATCH]. Adjustments:" then include explicit factor-by-factor breakdown for: (1) team strength, (2) round/rematch context, (3) confirmed unavailable players, (4) overall form last 5, (5) overall form last 10, (6) any extra context>
}`;

@Injectable()
export class AnalysisAgent {
  private readonly logger = new Logger(AnalysisAgent.name);
  private readonly anthropic: Anthropic | null;
  private readonly openai: OpenAI | null;
  private readonly model: string;
  private readonly provider: ModelProvider;

  constructor(private readonly config: ConfigService) {
    this.model =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-opus-4-6';
    this.provider = detectProvider(this.model);

    if (this.provider === 'openai') {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) {
        throw new Error(
          `OPENAI_API_KEY is required when using OpenAI model "${this.model}"`,
        );
      }
      this.openai = new OpenAI({ apiKey });
      this.anthropic = null;
    } else {
      this.anthropic = new Anthropic({
        apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
      });
      this.openai = null;
    }
  }

  /**
   * Run LLM analysis over collected data + research to produce a structured prediction.
   * Supports both Anthropic (Claude) and OpenAI (o3, o4-mini, GPT-5) models.
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
      `Analyzing: ${homeName} vs ${awayName} with model ${this.model} (${this.provider})`,
    );

    const userPrompt = this.buildPrompt(
      data,
      research,
      feedback,
      poissonModel,
      memories,
    );

    const rawText =
      this.provider === 'openai'
        ? await this.callOpenAI(userPrompt)
        : await this.callAnthropic(userPrompt);

    // Parse JSON from response
    const prediction = this.parseResponse(rawText);

    // Validate and normalize probabilities
    return this.validatePrediction(prediction, homeName, awayName);
  }

  // ─── LLM Provider Calls ────────────────────────────────────────────

  /**
   * Call Anthropic (Claude) with extended thinking and structured output.
   */
  private async callAnthropic(userPrompt: string): Promise<string> {
    const response = await this.anthropic!.messages.create({
      model: this.model,
      max_tokens: 16000,
      temperature: 1,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      // Structured output — guarantees valid JSON
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
    return textBlock?.text ?? '';
  }

  /**
   * Call OpenAI (o3, o4-mini, GPT-5, etc.) with structured output.
   *
   * Key API differences from Anthropic:
   * - Reasoning models (o-series): use `developer` role, `reasoning_effort`,
   *   no `temperature` parameter
   * - GPT models: use `system` role, support `temperature`
   * - Both: structured output via `response_format.type = 'json_schema'`
   */
  private async callOpenAI(userPrompt: string): Promise<string> {
    const reasoning = isReasoningModel(this.model);

    // OpenAI's structured output wraps the schema in a named container
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'prediction_output',
        strict: true,
        schema: PREDICTION_JSON_SCHEMA,
      },
    };

    // Build request — reasoning models have different parameters
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        // Reasoning models use 'developer' role; GPT models use 'system'
        role: reasoning ? 'developer' : 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      max_completion_tokens: 16000,
      response_format: responseFormat,
      // Reasoning models don't support temperature — use reasoning_effort instead
      ...(reasoning
        ? { reasoning_effort: 'high' as const }
        : { temperature: 0.7 }),
    };

    const response = await this.openai!.chat.completions.create(params);

    const content = response.choices[0]?.message?.content ?? '';

    // Log reasoning token usage if available
    const usage = response.usage;
    if (usage) {
      const reasoningTokens = (usage as any).completion_tokens_details
        ?.reasoning_tokens;
      this.logger.log(
        `OpenAI usage — input: ${usage.prompt_tokens}, output: ${usage.completion_tokens}` +
          (reasoningTokens ? `, reasoning: ${reasoningTokens}` : ''),
      );
    }

    return content;
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

    const seasonRematch = data.seasonRematch;
    if (seasonRematch?.isSeasonRematch && seasonRematch.previousMeeting) {
      const prev = seasonRematch.previousMeeting;
      sections.push(`\n## Same-season rematch context`);
      sections.push(
        `- This is a same-competition, same-season rematch between these clubs.`,
        `- Previous meeting: ${prev.homeGoals ?? '?'}-${prev.awayGoals ?? '?'} (fixture ${prev.fixtureId}, round ${prev.round ?? 'Unknown'}, date ${new Date(prev.date).toISOString().split('T')[0]}).`,
        `- Venue order reversed from previous meeting: ${prev.wasReverseFixture ? 'YES' : 'NO'}.`,
      );
    } else {
      sections.push(
        `\n## Same-season rematch context`,
        `- No prior same-competition, same-season meeting found for these teams.`,
      );
    }

    // Home team form + advanced stats
    if (data.homeTeam?.form?.length || data.standings.home) {
      sections.push(`\n## ${homeName} (Home)`);
      const form = data.standings.home;
      const formWindows = data.formWindows?.home;
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
      if (formWindows) {
        sections.push(
          `- Overall Form (Last 5): W${formWindows.last5.wins} D${formWindows.last5.draws} L${formWindows.last5.losses}, PPG ${formWindows.last5.pointsPerGame}, GF ${formWindows.last5.goalsFor}, GA ${formWindows.last5.goalsAgainst}`,
          `- Overall Form (Last 10): W${formWindows.last10.wins} D${formWindows.last10.draws} L${formWindows.last10.losses}, PPG ${formWindows.last10.pointsPerGame}, GF ${formWindows.last10.goalsFor}, GA ${formWindows.last10.goalsAgainst}`,
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
      const formWindows = data.formWindows?.away;
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
      if (formWindows) {
        sections.push(
          `- Overall Form (Last 5): W${formWindows.last5.wins} D${formWindows.last5.draws} L${formWindows.last5.losses}, PPG ${formWindows.last5.pointsPerGame}, GF ${formWindows.last5.goalsFor}, GA ${formWindows.last5.goalsAgainst}`,
          `- Overall Form (Last 10): W${formWindows.last10.wins} D${formWindows.last10.draws} L${formWindows.last10.losses}, PPG ${formWindows.last10.pointsPerGame}, GF ${formWindows.last10.goalsFor}, GA ${formWindows.last10.goalsAgainst}`,
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

    // Confirmed unavailable players — with quantified player impact scores when available
    if (data.injuries.length > 0) {
      const playerImpact = (data as any).playerImpact;

      if (playerImpact) {
        sections.push(`\n## Confirmed unavailable players (Quantified Impact)`);
        sections.push(
          `Only confirmed unavailable players are included (no doubtful/questionable players).`,
          `Impact scores are data-driven (0-1 scale based on goal involvement, starter status, and position).`,
        );

        // Home team absences
        if (playerImpact.home.players.length > 0) {
          sections.push(`\n### ${homeName} Absences`);
          sections.push(
            `Combined effect: xG ×${playerImpact.home.xgMultiplier} (${((1 - playerImpact.home.xgMultiplier) * 100).toFixed(0)}% offensive reduction), xGA ×${playerImpact.home.xgaMultiplier} (${((playerImpact.home.xgaMultiplier - 1) * 100).toFixed(0)}% more vulnerable)`,
          );
          for (const p of playerImpact.home.players) {
            const posLabel =
              p.position === 'F'
                ? 'FW'
                : p.position === 'M'
                  ? 'MF'
                  : p.position === 'D'
                    ? 'DF'
                    : p.position === 'G'
                      ? 'GK'
                      : '??';
            const starterTag = p.isRegularStarter ? 'STARTER' : 'squad';
            const statsTag =
              p.goals + p.assists > 0
                ? ` (${p.goals}G ${p.assists}A in ${p.teamMatches} matches)`
                : ` (${p.appearances}/${p.teamMatches} appearances)`;
            sections.push(
              `- [${p.impactLabel}] ${p.playerName} (${posLabel}, ${starterTag})${statsTag}: ${p.absenceType ?? '?'} — ${p.reason ?? 'Unknown'} [impact=${p.impactScore.toFixed(2)}, absence_prob=${(p.absenceProbability * 100).toFixed(0)}%]`,
            );
          }
        }

        // Away team absences
        if (playerImpact.away.players.length > 0) {
          sections.push(`\n### ${awayName} Absences`);
          sections.push(
            `Combined effect: xG ×${playerImpact.away.xgMultiplier} (${((1 - playerImpact.away.xgMultiplier) * 100).toFixed(0)}% offensive reduction), xGA ×${playerImpact.away.xgaMultiplier} (${((playerImpact.away.xgaMultiplier - 1) * 100).toFixed(0)}% more vulnerable)`,
          );
          for (const p of playerImpact.away.players) {
            const posLabel =
              p.position === 'F'
                ? 'FW'
                : p.position === 'M'
                  ? 'MF'
                  : p.position === 'D'
                    ? 'DF'
                    : p.position === 'G'
                      ? 'GK'
                      : '??';
            const starterTag = p.isRegularStarter ? 'STARTER' : 'squad';
            const statsTag =
              p.goals + p.assists > 0
                ? ` (${p.goals}G ${p.assists}A in ${p.teamMatches} matches)`
                : ` (${p.appearances}/${p.teamMatches} appearances)`;
            sections.push(
              `- [${p.impactLabel}] ${p.playerName} (${posLabel}, ${starterTag})${statsTag}: ${p.absenceType ?? '?'} — ${p.reason ?? 'Unknown'} [impact=${p.impactScore.toFixed(2)}, absence_prob=${(p.absenceProbability * 100).toFixed(0)}%]`,
            );
          }
        }

        if (
          playerImpact.home.players.length === 0 &&
          playerImpact.away.players.length === 0
        ) {
          sections.push(`No significant absences for either team.`);
        }
      } else {
        // Fallback: no impact scores available, use basic format
        sections.push(`\n## Confirmed unavailable players`);
        for (const inj of data.injuries) {
          const side = inj.teamId === fixture.homeTeamId ? homeName : awayName;
          sections.push(
            `- [${side}] ${inj.playerName}: ${inj.type ?? '?'} — ${inj.reason ?? 'Unknown'}`,
          );
        }
      }
    } else {
      sections.push(
        `\n## Confirmed unavailable players`,
        `- No confirmed unavailable players reported for either team.`,
      );
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
      `Failed to parse ${this.provider} response as JSON after all extraction strategies`,
    );
    this.logger.debug(
      `Raw response (first 500 chars): ${rawText.substring(0, 500)}`,
    );
    throw new Error(
      `Analysis agent (${this.provider}/${this.model}) returned invalid JSON: could not extract JSON from response`,
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
    // If Claude outputs draw prob below 0.20, it's almost certainly wrong.
    // Raised from 0.18 to 0.22 — draws occur 26% of the time; 0.18 was
    // still allowing too many matches with unrealistically low draw probs.
    const DRAW_FLOOR = 0.22;
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

    // ── Overconfidence cap: no single outcome above 0.65 from Claude ──
    // Even heavy favourites only win ~65-70% of the time.
    // Lowered from 0.72 to 0.65 to be more conservative — the ensemble
    // can push it slightly higher if bookmakers agree.
    const MAX_SINGLE_PROB = 0.65;
    const maxProb = Math.max(homeWinProb, drawProb, awayWinProb);
    if (maxProb > MAX_SINGLE_PROB) {
      this.logger.warn(
        `Max prob ${(maxProb * 100).toFixed(1)}% exceeds cap for ${homeName} vs ${awayName}, dampening`,
      );
      // Dampen toward the mean — more aggressive dampening (15% pull)
      const dampFactor = 0.85;
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

    // Cap confidence — Claude is systematically overconfident
    // More aggressive dampening: most matches should be 3-5
    const rawConfidence = Math.max(
      1,
      Math.min(10, Math.round(Number(raw.confidence) || 4)),
    );
    // Aggressive reduction: 10→6, 9→6, 8→6, 7→5, 6→5, 5→4, 4→4, 3→3
    let confidence: number;
    if (rawConfidence >= 8) {
      confidence = 6; // Claude's 8-10 maps to 6 (our "strong signal" level)
    } else if (rawConfidence >= 6) {
      confidence = 5; // Claude's 6-7 maps to 5
    } else if (rawConfidence >= 4) {
      confidence = 4; // Claude's 4-5 maps to 4 (the default level)
    } else {
      confidence = rawConfidence; // 1-3 stay as-is
    }

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
