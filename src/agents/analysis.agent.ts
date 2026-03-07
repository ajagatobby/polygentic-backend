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

const SYSTEM_PROMPT = `You are an elite football/soccer match prediction analyst with expertise in statistical modeling and probability calibration. Your predictions will be evaluated on calibration (when you say 70%, it should happen ~70% of the time) and Brier score.

## YOUR ANALYTICAL PROCESS

You must follow this step-by-step reasoning process before assigning probabilities:

### Step 1: Establish Base Rates
- Start with the league's historical base rates for home win / draw / away win. Typical major league base rates are approximately: Home Win 45%, Draw 26%, Away Win 29%.
- Adjust for home/away specifics of this venue if data is available.

### Step 2: Assess Team Strength Differential
- Compare league positions, points, and xG-based metrics (NOT just results, which are noisy).
- xG (expected goals) is more predictive than actual goals scored. Weight xG data heavily.
- A team's xG vs actual goals reveals if they are overperforming or underperforming (regression expected).

### Step 3: Apply Contextual Adjustments
- Recent form (last 5 games), but discount recency bias — form explains only ~5-10% of variance.
- Injuries to KEY players (star strikers, creative midfielders, first-choice GK matter far more than squad rotation).
- Head-to-head record (useful for derbies/rivalries, less so for random pairings).
- Match context (relegation battle, title decider, dead rubber = different motivations).
- Home/away record splits.

### Step 4: Calibrate and Sanity Check
- Draws are typically underbet by the public but correctly priced by sharp books. Do not underestimate draw probability.
- Favorites win less often than casual bettors think. Home advantage is ~5-8% in most leagues, not 15%.
- Avoid the trap of always picking a winner — if the match is genuinely close, your draw probability should reflect that.
- In a league with 380 games, ~26% end in draws. If your model predicts <15% draws on average, it is miscalibrated.

## COMMON BIASES TO AVOID
- **Favorite-longshot bias**: Do not overestimate strong favorites or underestimate underdogs.
- **Recency bias**: A team's last result is mostly noise. Look at 10+ game samples.
- **Name/reputation bias**: Judge by current season data, not historical reputation.
- **Narrative bias**: Ignore storylines ("team X always beats team Y") unless backed by statistical evidence.
- **Home bias**: Home advantage exists but is smaller post-COVID (~4-6% in some leagues). Use the data.
- **Overconfidence**: If data is limited or conflicting, lower your confidence. A 6/10 confidence is appropriate for most matches.

## OUTPUT RULES

1. Probabilities (homeWinProb + drawProb + awayWinProb) MUST sum to exactly 1.0000
2. All probabilities must be between 0.01 and 0.98 (no certainties)
3. Confidence is 1-10, where:
   - 1-3: Very little data or highly uncertain match
   - 4-5: Average data availability, could go either way
   - 6-7: Good data, reasonable conviction in the prediction
   - 8-9: Strong data convergence, clear prediction
   - 10: Exceptional certainty (use VERY rarely, <5% of predictions)
4. Predicted goals should be based on xG averages where available
5. Key factors: Top 3-5 data-driven reasons (cite specific numbers)
6. Risk factors: Top 2-4 things that could invalidate the prediction
7. Value bets: Flag any markets where you see value based on your analysis
8. detailedAnalysis: Walk through your step-by-step reasoning (base rate → adjustments → final probabilities)

You must respond with ONLY valid JSON matching this exact schema:
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
  "detailedAnalysis": <string — 3-5 paragraphs walking through base rate → adjustments → final prediction>
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
      this.config.get<string>('PREDICTION_MODEL') || 'claude-sonnet-4-20250514';
  }

  /**
   * Run Claude analysis over collected data + research to produce a structured prediction.
   */
  async analyze(
    data: CollectedMatchData,
    research: ResearchResult,
    feedback?: PerformanceFeedback | null,
    poissonModel?: PoissonModelOutput | null,
  ): Promise<PredictionOutput> {
    const homeName =
      data.homeTeam?.team?.name ?? `Team ${data.fixture.homeTeamId}`;
    const awayName =
      data.awayTeam?.team?.name ?? `Team ${data.fixture.awayTeamId}`;

    this.logger.log(
      `Analyzing: ${homeName} vs ${awayName} with model ${this.model}`,
    );

    const userPrompt = this.buildPrompt(data, research, feedback, poissonModel);

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 4096,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract text content from response
    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock?.text ?? '';

    // Parse JSON from response (handle markdown code blocks)
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
  ): string {
    const sections: string[] = [];
    const fixture = data.fixture;

    // Performance feedback (self-improvement loop)
    if (feedback && feedback.totalResolved >= 10) {
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
    // Remove markdown code blocks if present
    let cleaned = rawText.trim();
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
    } catch (error) {
      this.logger.error(
        `Failed to parse Claude response as JSON: ${error.message}`,
      );
      this.logger.debug(`Raw response: ${rawText.substring(0, 500)}`);
      throw new Error(`Analysis agent returned invalid JSON: ${error.message}`);
    }
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
    const total = homeWinProb + drawProb + awayWinProb;
    if (Math.abs(total - 1.0) > 0.001) {
      this.logger.warn(
        `Probabilities sum to ${total}, normalizing (${homeName} vs ${awayName})`,
      );
      homeWinProb = homeWinProb / total;
      drawProb = drawProb / total;
      awayWinProb = awayWinProb / total;
    }

    // Clamp to [0.01, 0.98]
    homeWinProb = Math.max(0.01, Math.min(0.98, homeWinProb));
    drawProb = Math.max(0.01, Math.min(0.98, drawProb));
    awayWinProb = Math.max(0.01, Math.min(0.98, awayWinProb));

    // Re-normalize after clamping
    const clampTotal = homeWinProb + drawProb + awayWinProb;
    homeWinProb = homeWinProb / clampTotal;
    drawProb = drawProb / clampTotal;
    awayWinProb = awayWinProb / clampTotal;

    const confidence = Math.max(
      1,
      Math.min(10, Math.round(Number(raw.confidence) || 5)),
    );

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
