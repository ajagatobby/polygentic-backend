import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { CollectedMatchData } from './data-collector.agent';
import { ResearchResult } from './research.agent';
import { PredictionOutput } from './analysis.agent';

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

export interface CriticOutput {
  verdict: 'approve' | 'revise';
  confidencePenalty: number;
  concerns: string[];
  missedFactors: string[];
}

const CRITIC_PROMPT = `You are a strict football prediction critic.

Your job is to challenge an existing prediction, identify weak assumptions,
and reduce overconfidence.

Rules:
- Do not make a fresh full prediction.
- Find concrete weaknesses in the current prediction.
- If prediction seems robust, still include at least one potential risk.
- confidencePenalty must be between 0 and 2.

Return ONLY valid JSON:
{
  "verdict": "approve" | "revise",
  "confidencePenalty": <number 0-2>,
  "concerns": [<string>, ...],
  "missedFactors": [<string>, ...]
}`;

@Injectable()
export class CriticAgent {
  private readonly logger = new Logger(CriticAgent.name);
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

  async review(
    data: CollectedMatchData,
    research: ResearchResult,
    prediction: PredictionOutput,
  ): Promise<CriticOutput | null> {
    try {
      const input = this.buildCriticInput(data, research, prediction);
      const raw = await this.callLLM(input);
      const parsed = this.parseJson(raw);

      const confidencePenalty = Math.max(
        0,
        Math.min(2, Number(parsed?.confidencePenalty ?? 0)),
      );

      const verdict =
        parsed?.verdict === 'revise' || parsed?.verdict === 'approve'
          ? parsed.verdict
          : 'approve';

      return {
        verdict,
        confidencePenalty,
        concerns: Array.isArray(parsed?.concerns)
          ? parsed.concerns.slice(0, 6).map(String)
          : [],
        missedFactors: Array.isArray(parsed?.missedFactors)
          ? parsed.missedFactors.slice(0, 6).map(String)
          : [],
      };
    } catch (error) {
      this.logger.warn(`Critic review failed: ${error.message}`);
      return null;
    }
  }

  private buildCriticInput(
    data: CollectedMatchData,
    research: ResearchResult,
    prediction: PredictionOutput,
  ): string {
    const fixture = data.fixture;
    const homeName = data.homeTeam?.team?.name ?? `Team ${fixture.homeTeamId}`;
    const awayName = data.awayTeam?.team?.name ?? `Team ${fixture.awayTeamId}`;

    return [
      `Match: ${homeName} vs ${awayName}`,
      `League: ${fixture.leagueName ?? fixture.leagueId}`,
      `Round: ${fixture.round ?? 'Unknown'}`,
      `Initial probs: H=${prediction.homeWinProb}, D=${prediction.drawProb}, A=${prediction.awayWinProb}`,
      `Initial confidence: ${prediction.confidence}/10`,
      `Injuries: ${data.injuries.length}`,
      `Has lineups: ${data.lineups.length > 0}`,
      `Recent form windows available: home=${!!data.formWindows.home}, away=${!!data.formWindows.away}`,
      `Research summary: ${research.combinedResearch?.slice(0, 1200) ?? 'none'}`,
      `Analysis text: ${prediction.detailedAnalysis.slice(0, 1800)}`,
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
            { role: 'developer', content: CRITIC_PROMPT },
            { role: 'user', content: input },
          ],
          reasoning_effort: 'high',
          max_completion_tokens: 900,
        } as any);
        return response.choices[0]?.message?.content ?? '';
      }

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: CRITIC_PROMPT },
          { role: 'user', content: input },
        ],
        temperature: 0.2,
        max_tokens: 900,
      });
      return response.choices[0]?.message?.content ?? '';
    }

    if (!this.anthropic) throw new Error('ANTHROPIC_API_KEY missing');
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 900,
      temperature: 0.2,
      system: CRITIC_PROMPT,
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
      throw new Error('Invalid JSON from critic');
    }
  }
}
