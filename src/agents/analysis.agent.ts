import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { CollectedMatchData } from './data-collector.agent';
import { ResearchResult } from './research.agent';

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

const SYSTEM_PROMPT = `You are an elite football/soccer match prediction analyst. You combine statistical data, current form, tactical analysis, and real-time research to produce accurate match predictions.

Your task: Analyze all provided data and produce a structured prediction for the upcoming match.

CRITICAL RULES:
1. Probabilities (homeWinProb + drawProb + awayWinProb) MUST sum to exactly 1.0000
2. All probabilities must be between 0.01 and 0.98 (no certainties)
3. Confidence is 1-10 (10 = extremely confident, based on data quality and conviction)
4. Predicted goals should be realistic (typically 0.5-4.0 per team)
5. Key factors: Top 3-5 reasons driving the prediction
6. Risk factors: Top 2-4 things that could make the prediction wrong
7. Value bets: Compare your probabilities against bookmaker odds; identify edges > 3%
8. Be honest about uncertainty — low-data matches should get low confidence

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
  "detailedAnalysis": <string — 2-4 paragraphs of reasoning>
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
  ): Promise<PredictionOutput> {
    const homeName =
      data.homeTeam?.team?.name ?? `Team ${data.fixture.homeTeamId}`;
    const awayName =
      data.awayTeam?.team?.name ?? `Team ${data.fixture.awayTeamId}`;

    this.logger.log(
      `Analyzing: ${homeName} vs ${awayName} with model ${this.model}`,
    );

    const userPrompt = this.buildPrompt(data, research);

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
  ): string {
    const sections: string[] = [];
    const fixture = data.fixture;

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

    // Home team form
    if (data.homeTeam?.form?.length || data.standings.home) {
      sections.push(`\n## ${homeName} (Home)`);
      const form = data.standings.home;
      if (form) {
        sections.push(
          `- League Position: ${form.leaguePosition ?? '?'}`,
          `- Points: ${form.points ?? '?'}`,
          `- Form: ${form.formString ?? '?'}`,
          `- Home Record: W${form.homeWins ?? '?'} D${form.homeDraws ?? '?'} L${form.homeLosses ?? '?'}`,
          `- Goals For Avg: ${form.goalsForAvg ?? '?'}`,
          `- Goals Against Avg: ${form.goalsAgainstAvg ?? '?'}`,
        );
      }
      if (data.homeTeam?.team) {
        const t = data.homeTeam.team;
        sections.push(
          `- Founded: ${t.founded ?? '?'}`,
          `- Venue Capacity: ${t.venueCapacity ?? '?'}`,
        );
      }
    }

    // Away team form
    if (data.awayTeam?.form?.length || data.standings.away) {
      sections.push(`\n## ${awayName} (Away)`);
      const form = data.standings.away;
      if (form) {
        sections.push(
          `- League Position: ${form.leaguePosition ?? '?'}`,
          `- Points: ${form.points ?? '?'}`,
          `- Form: ${form.formString ?? '?'}`,
          `- Away Record: W${form.awayWins ?? '?'} D${form.awayDraws ?? '?'} L${form.awayLosses ?? '?'}`,
          `- Goals For Avg: ${form.goalsForAvg ?? '?'}`,
          `- Goals Against Avg: ${form.goalsAgainstAvg ?? '?'}`,
        );
      }
      if (data.awayTeam?.team) {
        const t = data.awayTeam.team;
        sections.push(
          `- Founded: ${t.founded ?? '?'}`,
          `- Venue Capacity: ${t.venueCapacity ?? '?'}`,
        );
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

    // Odds
    if (data.odds.consensus.length > 0) {
      sections.push(`\n## Bookmaker Consensus Odds`);
      const h2hConsensus = data.odds.consensus.find(
        (c: any) => c.marketKey === 'h2h',
      );
      if (h2hConsensus) {
        sections.push(
          `- Home Win: ${h2hConsensus.consensusHomeWin ?? '?'}`,
          `- Draw: ${h2hConsensus.consensusDraw ?? '?'}`,
          `- Away Win: ${h2hConsensus.consensusAwayWin ?? '?'}`,
          `- Bookmakers: ${h2hConsensus.numBookmakers ?? '?'}`,
        );
        if (h2hConsensus.pinnacleHomeWin) {
          sections.push(
            `- Pinnacle (sharp): Home ${h2hConsensus.pinnacleHomeWin}, Draw ${h2hConsensus.pinnacleDraw}, Away ${h2hConsensus.pinnacleAwayWin}`,
          );
        }
      }
      const totalsConsensus = data.odds.consensus.find(
        (c: any) => c.marketKey === 'totals',
      );
      if (totalsConsensus) {
        sections.push(
          `- Over ${totalsConsensus.consensusPoint ?? '2.5'}: ${totalsConsensus.consensusOver ?? '?'}`,
          `- Under ${totalsConsensus.consensusPoint ?? '2.5'}: ${totalsConsensus.consensusUnder ?? '?'}`,
        );
      }
    }

    // API-Football prediction
    if (data.apiPrediction) {
      const pred = data.apiPrediction;
      sections.push(`\n## API-Football Prediction`);
      if (pred.predictions) {
        sections.push(
          `- Winner: ${pred.predictions.winner?.name ?? '?'}`,
          `- Advice: ${pred.predictions.advice ?? '?'}`,
          `- Predicted Score: ${pred.predictions.goals?.home ?? '?'} - ${pred.predictions.goals?.away ?? '?'}`,
        );
      }
      if (pred.comparison) {
        sections.push(
          `- Form: Home ${pred.comparison.form?.home ?? '?'} vs Away ${pred.comparison.form?.away ?? '?'}`,
        );
        sections.push(
          `- Attack: Home ${pred.comparison.att?.home ?? '?'} vs Away ${pred.comparison.att?.away ?? '?'}`,
        );
        sections.push(
          `- Defense: Home ${pred.comparison.def?.home ?? '?'} vs Away ${pred.comparison.def?.away ?? '?'}`,
        );
      }
    }

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
