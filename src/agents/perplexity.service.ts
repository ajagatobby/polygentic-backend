import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface PerplexitySearchResult {
  content: string;
  citations: string[];
  model: string;
}

@Injectable()
export class PerplexityService {
  private readonly logger = new Logger(PerplexityService.name);
  private readonly client: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: 'https://api.perplexity.ai',
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${this.config.get<string>('PERPLEXITY_API_KEY')}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Search for match-specific information using Perplexity Sonar.
   * Returns a synthesized research summary with citations.
   */
  async search(query: string): Promise<PerplexitySearchResult> {
    try {
      const response = await this.client.post('/chat/completions', {
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content:
              'You are a football/soccer research analyst. Provide factual, detailed information about upcoming matches including recent news, injuries, tactical analysis, team form, weather conditions, and any other relevant context. Be specific with dates, names, and statistics.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 2048,
        temperature: 0.1,
        return_citations: true,
      });

      const choice = response.data.choices?.[0];
      const citations = response.data.citations ?? [];

      return {
        content: choice?.message?.content ?? '',
        citations,
        model: response.data.model ?? 'sonar',
      };
    } catch (error) {
      this.logger.error(`Perplexity search failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run multiple search queries in parallel and combine results.
   */
  async searchMultiple(queries: string[]): Promise<PerplexitySearchResult[]> {
    const results = await Promise.allSettled(
      queries.map((q) => this.search(q)),
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<PerplexitySearchResult> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);
  }
}
