import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface BaseballResearchResult {
  content: string;
  citations: string[];
}

export interface ResearchGameContext {
  homeTeam: string;
  awayTeam: string;
  dateISO: string;
  venue?: string | null;
  homeStarter?: string | null;
  awayStarter?: string | null;
}

/**
 * Pre-game research for MLB totals via Perplexity Sonar — the qualitative
 * layer the statistical model can't see: confirmed lineups, bullpen
 * availability/fatigue, weather/wind at first pitch, late scratches,
 * beat-writer notes. Self-contained (own Perplexity client) to avoid a
 * cross-module dependency on the soccer AgentsModule.
 */
@Injectable()
export class BaseballResearchAgent {
  private readonly logger = new Logger(BaseballResearchAgent.name);
  private readonly client: AxiosInstance | null;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('PERPLEXITY_API_KEY');
    this.client = key
      ? axios.create({
          baseURL: 'https://api.perplexity.ai',
          timeout: 30_000,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
        })
      : null;
  }

  async research(ctx: ResearchGameContext): Promise<BaseballResearchResult> {
    if (!this.client) {
      return { content: '', citations: [] };
    }
    const date = ctx.dateISO.split('T')[0];
    const query =
      `For today's MLB game ${ctx.awayTeam} at ${ctx.homeTeam} on ${date}` +
      (ctx.venue ? ` (${ctx.venue})` : '') +
      `, report ONLY facts relevant to TOTAL RUNS (over/under): ` +
      `confirmed starting pitchers and their recent form` +
      (ctx.homeStarter || ctx.awayStarter
        ? ` (probables: ${ctx.awayStarter ?? '?'} vs ${ctx.homeStarter ?? '?'})`
        : '') +
      `; bullpen availability/fatigue (who pitched recently, closer availability); ` +
      `confirmed lineups and key hitters in/out; first-pitch weather ` +
      `(temperature, wind speed AND direction relative to the park); ` +
      `umpire run-scoring tendency if known; any late scratches. ` +
      `Be specific and concise. If something is unknown, say so.`;

    try {
      const res = await this.client.post('/chat/completions', {
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content:
              'You are an MLB research analyst specializing in run-scoring environment. ' +
              'Provide factual, dated, specific information about starting pitching, bullpens, ' +
              'lineups, and weather. Never speculate on a final score or a betting pick.',
          },
          { role: 'user', content: query },
        ],
        max_tokens: 1500,
        temperature: 0.1,
        return_citations: true,
      });
      const choice = res.data.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        citations: res.data.citations ?? [],
      };
    } catch (err) {
      this.logger.warn(`research failed: ${(err as Error).message}`);
      return { content: '', citations: [] };
    }
  }
}
