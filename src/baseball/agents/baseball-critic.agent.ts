import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { RunModelOutput } from '../baseball-run-model.service';
import { AnalysisOutput } from './baseball-analysis.agent';
import { BaseballResearchResult } from './baseball-research.agent';

export interface CriticOutput {
  agrees: boolean;
  adjustedExpectedTotal: number;
  confidenceDelta: number; // applied to analysis confidence (-3..+1)
  critique: string;
}

/**
 * Adversarial check on the analysis agent's total. Uses a fast model to
 * challenge the lean (e.g. "you leaned over but both bullpens are gassed and
 * wind is blowing in"). Cheap insurance against confident-but-wrong calls;
 * can only pull confidence down or nudge the total modestly.
 */
@Injectable()
export class BaseballCriticAgent {
  private readonly logger = new Logger(BaseballCriticAgent.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  private static readonly SYSTEM =
    'You are a skeptical MLB totals reviewer. Given a statistical model, an ' +
    "analyst's expected total, and research, look for reasons the analyst is " +
    'WRONG (overreacting to noise, ignoring bullpen/weather, double-counting). ' +
    'Be conservative: prefer pulling extreme calls back toward the model. ' +
    'Respond ONLY with minified JSON.';

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    this.client = key ? new Anthropic({ apiKey: key }) : null;
    this.model =
      this.config.get<string>('CRITIC_MODEL') || 'claude-haiku-4-5-20251001';
  }

  async critique(
    model: RunModelOutput,
    analysis: AnalysisOutput,
    research: BaseballResearchResult,
  ): Promise<CriticOutput> {
    const passthrough: CriticOutput = {
      agrees: true,
      adjustedExpectedTotal: analysis.expectedTotal,
      confidenceDelta: 0,
      critique: '',
    };
    if (!this.client) return passthrough;

    const user = [
      `MODEL expected total: ${model.expectedTotal}`,
      `ANALYST expected total: ${analysis.expectedTotal} (lean ${analysis.lean}, conf ${analysis.confidence})`,
      `ANALYST keyFactors: ${analysis.keyFactors.join('; ') || 'none'}`,
      `RESEARCH: ${research.content?.slice(0, 1200) || '(none)'}`,
      ``,
      `Return JSON: {"agrees": boolean, "adjustedExpectedTotal": number, ` +
        `"confidenceDelta": integer (-3..1), "critique": string (<=40 words)}`,
    ].join('\n');

    try {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system: [
          {
            type: 'text',
            text: BaseballCriticAgent.SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: user }],
      });
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const o = JSON.parse(json);
      let adj = Number(o.adjustedExpectedTotal);
      if (!Number.isFinite(adj)) adj = analysis.expectedTotal;
      // Critic can nudge ≤1.5 runs back toward the model, never amplify.
      adj = Math.max(
        Math.min(analysis.expectedTotal, model.expectedTotal) - 1.5,
        Math.min(Math.max(analysis.expectedTotal, model.expectedTotal) + 1.5, adj),
      );
      const delta = Math.max(-3, Math.min(1, Math.round(Number(o.confidenceDelta) || 0)));
      return {
        agrees: !!o.agrees,
        adjustedExpectedTotal: Math.round(adj * 100) / 100,
        confidenceDelta: delta,
        critique: String(o.critique ?? '').slice(0, 400),
      };
    } catch (err) {
      this.logger.warn(`critique failed: ${(err as Error).message}`);
      return passthrough;
    }
  }
}
