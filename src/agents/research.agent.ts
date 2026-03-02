import { Injectable, Logger } from '@nestjs/common';
import {
  PerplexityService,
  PerplexitySearchResult,
} from './perplexity.service';
import { CollectedMatchData } from './data-collector.agent';

export interface ResearchResult {
  matchPreview: PerplexitySearchResult | null;
  teamNews: PerplexitySearchResult | null;
  tacticalAnalysis: PerplexitySearchResult | null;
  combinedResearch: string;
  citations: string[];
}

@Injectable()
export class ResearchAgent {
  private readonly logger = new Logger(ResearchAgent.name);

  constructor(private readonly perplexity: PerplexityService) {}

  /**
   * Conduct web research for a fixture using Perplexity Sonar.
   * Runs 3 targeted searches in parallel, then combines results.
   */
  async research(data: CollectedMatchData): Promise<ResearchResult> {
    const fixture = data.fixture;
    const homeName = data.homeTeam?.team?.name ?? `Team ${fixture.homeTeamId}`;
    const awayName = data.awayTeam?.team?.name ?? `Team ${fixture.awayTeamId}`;
    const matchDate = new Date(fixture.date).toISOString().split('T')[0];
    const league = fixture.leagueName ?? `League ${fixture.leagueId}`;

    this.logger.log(
      `Researching: ${homeName} vs ${awayName} (${matchDate}, ${league})`,
    );

    const queries = [
      // Match preview: form, predictions, expert opinions
      `${homeName} vs ${awayName} match preview ${matchDate} ${league}. ` +
        `Include recent form, key stats, expert predictions, and expected lineups.`,

      // Team news: injuries, suspensions, transfers, manager comments
      `${homeName} and ${awayName} team news injuries suspensions ${matchDate}. ` +
        `Include any confirmed injury updates, squad availability, manager press conference quotes, and recent transfer activity.`,

      // Tactical and contextual analysis
      `${homeName} vs ${awayName} tactical analysis betting odds weather ${matchDate}. ` +
        `Include tactical setup expectations, head-to-head trends, betting market movements, weather forecast for the match, and any special match context (rivalry, title race, relegation battle, etc).`,
    ];

    const results = await this.perplexity.searchMultiple(queries);

    const matchPreview = results[0] ?? null;
    const teamNews = results[1] ?? null;
    const tacticalAnalysis = results[2] ?? null;

    // Combine all research into a single context string
    const sections: string[] = [];
    const allCitations: string[] = [];

    if (matchPreview) {
      sections.push(`## Match Preview\n${matchPreview.content}`);
      allCitations.push(...matchPreview.citations);
    }
    if (teamNews) {
      sections.push(`## Team News & Injuries\n${teamNews.content}`);
      allCitations.push(...teamNews.citations);
    }
    if (tacticalAnalysis) {
      sections.push(
        `## Tactical & Contextual Analysis\n${tacticalAnalysis.content}`,
      );
      allCitations.push(...tacticalAnalysis.citations);
    }

    const combinedResearch =
      sections.length > 0
        ? sections.join('\n\n')
        : 'No research data available — Perplexity searches returned no results.';

    // Deduplicate citations
    const uniqueCitations = [...new Set(allCitations)];

    this.logger.log(
      `Research complete for ${homeName} vs ${awayName}: ` +
        `${sections.length} sections, ${uniqueCitations.length} citations`,
    );

    return {
      matchPreview,
      teamNews,
      tacticalAnalysis,
      combinedResearch,
      citations: uniqueCitations,
    };
  }
}
