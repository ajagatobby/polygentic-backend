import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { CollectedMatchData } from './data-collector.agent';

type ModelProvider = 'anthropic' | 'openai';

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

function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m.startsWith('gpt-5')
  );
}

export interface FirstPrinciplesOutput {
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  confidence: number;
  rationale: string[];
}

const FP_PROMPT = `You are a first-principles football prediction agent.

Predict from fundamentals only:
1) baseline football priors (home/draw/away rates)
2) team quality (xG, xGA, shot creation/prevention)
3) availability (confirmed absences, lineups)
4) schedule context (opponent strength and fatigue hints)

Do not anchor to bookmaker odds or external model outputs.

Return ONLY valid JSON:
{
  "homeWinProb": <number>,
  "drawProb": <number>,
  "awayWinProb": <number>,
  "confidence": <integer 1-10>,
  "rationale": [<string>, ...]
}

Probabilities must sum to 1.00.`;

@Injectable()
export class FirstPrinciplesAgent {
  private readonly logger = new Logger(FirstPrinciplesAgent.name);
  private readonly model: string;
  private readonly provider: ModelProvider;
  private readonly anthropic?: Anthropic;
  private readonly openai?: OpenAI;

  constructor(private readonly config: ConfigService) {
    this.model =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-opus-4-1-20250805';
    this.provider = detectProvider(this.model);

    if (this.provider === 'openai') {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (apiKey) this.openai = new OpenAI({ apiKey });
    } else {
      const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
      if (apiKey) this.anthropic = new Anthropic({ apiKey });
    }
  }

  async rethink(
    data: CollectedMatchData,
  ): Promise<FirstPrinciplesOutput | null> {
    try {
      const raw = await this.callLLM(this.buildInput(data));
      const parsed = this.parseJson(raw);

      const h = Number(parsed?.homeWinProb ?? 0.44);
      const d = Number(parsed?.drawProb ?? 0.27);
      const a = Number(parsed?.awayWinProb ?? 0.29);
      const total = h + d + a;
      const homeWinProb = total > 0 ? h / total : 0.44;
      const drawProb = total > 0 ? d / total : 0.27;
      const awayWinProb = total > 0 ? a / total : 0.29;

      return {
        homeWinProb: Number(homeWinProb.toFixed(4)),
        drawProb: Number(drawProb.toFixed(4)),
        awayWinProb: Number(awayWinProb.toFixed(4)),
        confidence: Math.max(1, Math.min(10, Number(parsed?.confidence ?? 5))),
        rationale: Array.isArray(parsed?.rationale)
          ? parsed.rationale.slice(0, 6).map(String)
          : [],
      };
    } catch (error) {
      this.logger.warn(`First-principles rethink failed: ${error.message}`);
      return null;
    }
  }

  private buildInput(data: CollectedMatchData): string {
    const fixture = data.fixture;
    const homeName = data.homeTeam?.team?.name ?? `Team ${fixture.homeTeamId}`;
    const awayName = data.awayTeam?.team?.name ?? `Team ${fixture.awayTeamId}`;

    return [
      `Match: ${homeName} vs ${awayName}`,
      `League: ${fixture.leagueName ?? fixture.leagueId}`,
      `Round: ${fixture.round ?? 'Unknown'}`,
      `Rematch: ${data.seasonRematch?.isSeasonRematch ? 'yes' : 'no'}`,
      `Home form windows: ${JSON.stringify(data.formWindows?.home ?? null)}`,
      `Away form windows: ${JSON.stringify(data.formWindows?.away ?? null)}`,
      `Home recent xG stats: ${JSON.stringify(data.recentStats?.home?.averages ?? null)}`,
      `Away recent xG stats: ${JSON.stringify(data.recentStats?.away?.averages ?? null)}`,
      `Home opponent strength: ${JSON.stringify(data.opponentStrength?.home ?? null)}`,
      `Away opponent strength: ${JSON.stringify(data.opponentStrength?.away ?? null)}`,
      `Home recent game history: ${JSON.stringify(data.recentGameHistory?.home ?? [])}`,
      `Away recent game history: ${JSON.stringify(data.recentGameHistory?.away ?? [])}`,
      `Confirmed unavailable players count: ${data.injuries.length}`,
      `Confirmed lineups available: ${data.lineups.length > 0}`,
    ].join('\n');
  }

  private async callLLM(input: string): Promise<string> {
    if (this.provider === 'openai') {
      if (!this.openai) throw new Error('OPENAI_API_KEY missing');
      const reasoning = isReasoningModel(this.model);

      if (reasoning) {
        const response = await this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'developer', content: FP_PROMPT },
            { role: 'user', content: input },
          ],
          reasoning_effort: 'high',
          max_completion_tokens: 1000,
        } as any);
        return response.choices[0]?.message?.content ?? '';
      }

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: FP_PROMPT },
          { role: 'user', content: input },
        ],
        temperature: 0.2,
        max_tokens: 1000,
      });
      return response.choices[0]?.message?.content ?? '';
    }

    if (!this.anthropic) throw new Error('ANTHROPIC_API_KEY missing');
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1000,
      temperature: 0.2,
      system: FP_PROMPT,
      messages: [{ role: 'user', content: input }],
    });

    return response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }

  private parseJson(raw: string): any {
    const cleaned = raw.trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      }
      throw new Error('Invalid JSON from first-principles agent');
    }
  }
}
