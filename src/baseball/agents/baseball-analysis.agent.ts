import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { RunModelOutput } from '../baseball-run-model.service';
import { BaseballResearchResult } from './baseball-research.agent';

export interface AnalysisInput {
  homeTeam: string;
  awayTeam: string;
  venue?: string | null;
  model: RunModelOutput;
  research: BaseballResearchResult;
  marketTotal?: number | null;
  parkRunFactor?: number;
  weather?: any;
}

export interface AnalysisOutput {
  expectedTotal: number;
  confidence: number; // 1-10
  lean: 'over' | 'under' | 'neutral';
  keyFactors: string[];
  riskFactors: string[];
  reasoning: string;
}

/**
 * Claude analysis agent for MLB totals. Given the statistical model as an
 * ANCHOR plus fresh research, it returns its own expected total + lean,
 * adjusting the anchor only with justification (it must not free-hand a
 * number). Low-dimensional output (a mean, not a probability vector) keeps
 * it robust; the orchestrator turns its expectedTotal into per-line probs
 * via the same NB used by the model.
 */
@Injectable()
export class BaseballAnalysisAgent {
  private readonly logger = new Logger(BaseballAnalysisAgent.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  private static readonly SYSTEM =
    'You are a sharp MLB run-totals analyst. You are given a statistical ' +
    "model's expected total runs (the ANCHOR) plus fresh pre-game research. " +
    'Your job: decide the true expected total, adjusting the anchor ONLY when ' +
    'the research provides a concrete, run-relevant reason (pitcher form/scratch, ' +
    'bullpen fatigue, lineup changes, wind/temperature, umpire). Do NOT invent ' +
    'numbers; small adjustments (±0.5 to ±1.5 runs) are normal, large ones need ' +
    'strong justification. Respond ONLY with minified JSON matching the schema. ' +
    'Never output prose outside the JSON.';

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    this.client = key ? new Anthropic({ apiKey: key }) : null;
    // Analysis quality matters here → use the configured prediction model.
    this.model =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-sonnet-4-6';
  }

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const anchor = input.model.expectedTotal;
    // Passthrough if no LLM configured — model anchor stands.
    if (!this.client) {
      return {
        expectedTotal: anchor,
        confidence: input.model.confidence,
        lean: 'neutral',
        keyFactors: [],
        riskFactors: ['LLM analysis unavailable; using statistical model only'],
        reasoning: 'No ANTHROPIC_API_KEY configured.',
      };
    }

    const user = this.buildPrompt(input);
    try {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: BaseballAnalysisAgent.SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: user }],
      });
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return this.parse(text, anchor, input.model.confidence);
    } catch (err) {
      this.logger.warn(`analyze failed: ${(err as Error).message}`);
      return {
        expectedTotal: anchor,
        confidence: Math.max(1, input.model.confidence - 1),
        lean: 'neutral',
        keyFactors: [],
        riskFactors: ['LLM analysis errored; fell back to model anchor'],
        reasoning: (err as Error).message,
      };
    }
  }

  private buildPrompt(input: AnalysisInput): string {
    const m = input.model;
    const lines = m.lineProbs
      .map((l) => `${l.line}: over ${(l.pOver * 100).toFixed(0)}%`)
      .join(', ');
    return [
      `GAME: ${input.awayTeam} @ ${input.homeTeam}${input.venue ? ` (${input.venue})` : ''}`,
      ``,
      `MODEL ANCHOR (statistical):`,
      `- expected total runs: ${m.expectedTotal} (home ${m.expectedHomeRuns}, away ${m.expectedAwayRuns})`,
      `- park run factor: ${input.parkRunFactor ?? 'n/a'}`,
      `- per-line P(over): ${lines}`,
      `- model confidence: ${m.confidence}/10`,
      input.marketTotal != null
        ? `- sharp market total: ${input.marketTotal}`
        : `- sharp market total: unavailable`,
      input.weather ? `- weather: ${JSON.stringify(input.weather)}` : '',
      ``,
      `RESEARCH:`,
      input.research.content || '(no research available)',
      ``,
      `Return JSON: {"expectedTotal": number, "confidence": 1-10 integer, ` +
        `"lean": "over"|"under"|"neutral", "keyFactors": string[], ` +
        `"riskFactors": string[], "reasoning": string (<= 60 words)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private parse(
    text: string,
    anchor: number,
    modelConf: number,
  ): AnalysisOutput {
    try {
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const o = JSON.parse(json);
      let expectedTotal = Number(o.expectedTotal);
      if (!Number.isFinite(expectedTotal)) expectedTotal = anchor;
      // Guardrail: cap deviation from anchor at ±3 runs.
      expectedTotal = Math.max(anchor - 3, Math.min(anchor + 3, expectedTotal));
      const conf = Math.max(
        1,
        Math.min(10, Math.round(Number(o.confidence) || modelConf)),
      );
      const lean: AnalysisOutput['lean'] =
        o.lean === 'over' || o.lean === 'under' ? o.lean : 'neutral';
      return {
        expectedTotal: Math.round(expectedTotal * 100) / 100,
        confidence: conf,
        lean,
        keyFactors: arr(o.keyFactors),
        riskFactors: arr(o.riskFactors),
        reasoning: String(o.reasoning ?? '').slice(0, 600),
      };
    } catch {
      return {
        expectedTotal: anchor,
        confidence: modelConf,
        lean: 'neutral',
        keyFactors: [],
        riskFactors: ['Failed to parse LLM JSON; used model anchor'],
        reasoning: '',
      };
    }
  }
}

function arr(x: any): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => String(v)).slice(0, 8);
}
