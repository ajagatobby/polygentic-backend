import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../../database/schema';
import {
  ParsedPolymarketEvent,
  ParsedMarket,
} from './polymarket-gamma.service';

/**
 * Result of matching a Polymarket market to an internal fixture.
 */
export interface MarketFixtureMatch {
  event: ParsedPolymarketEvent;
  market: ParsedMarket;
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName: string;
  awayTeamName: string;
  matchScore: number; // 0-1 confidence in the match
  marketType:
    | 'match_outcome'
    | 'league_winner'
    | 'top_4'
    | 'player_prop'
    | 'other';
}

/**
 * PolymarketMatcherService
 *
 * Links Polymarket events to internal fixtures using fuzzy team name matching
 * and date proximity. Same approach as the existing OddsService matcher,
 * adapted for Polymarket's event/market structure.
 */
@Injectable()
export class PolymarketMatcherService {
  private readonly logger = new Logger(PolymarketMatcherService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  /**
   * Match a batch of Polymarket events to internal fixtures.
   * Returns only events that could be confidently linked.
   */
  async matchEventsToFixtures(
    events: ParsedPolymarketEvent[],
  ): Promise<MarketFixtureMatch[]> {
    const matches: MarketFixtureMatch[] = [];

    for (const event of events) {
      const marketType = this.classifyEvent(event);

      // For Phase 1, focus on match outcome markets (most straightforward to trade)
      if (marketType !== 'match_outcome') continue;

      for (const market of event.markets) {
        const match = await this.matchMarketToFixture(
          event,
          market,
          marketType,
        );
        if (match) {
          matches.push(match);
        }
      }
    }

    this.logger.log(
      `Matched ${matches.length} Polymarket markets to fixtures (from ${events.length} events)`,
    );

    return matches;
  }

  /**
   * Match a single Polymarket market to a fixture.
   *
   * Strategy:
   * 1. Extract team names from the event title / market question
   * 2. Look up fixtures within a reasonable time window
   * 3. Fuzzy-match team names, weighted by date proximity
   */
  private async matchMarketToFixture(
    event: ParsedPolymarketEvent,
    market: ParsedMarket,
    marketType: string,
  ): Promise<MarketFixtureMatch | null> {
    // Extract team name candidates from event title and market question
    const textToSearch = `${event.title} ${market.question}`;
    const extractedTeams = this.extractTeamNamesFromText(textToSearch);

    if (extractedTeams.length < 2) return null;

    // Determine the time window for fixture search
    const windowDays = 7; // Look ±7 days from event dates
    const now = new Date();
    let searchFrom: Date;
    let searchTo: Date;

    if (event.startDate) {
      const eventStart = new Date(event.startDate);
      searchFrom = new Date(eventStart.getTime() - windowDays * 86400000);
      searchTo = new Date(eventStart.getTime() + windowDays * 86400000);
    } else {
      // No date info — search upcoming fixtures
      searchFrom = new Date(now.getTime() - 2 * 86400000);
      searchTo = new Date(now.getTime() + 14 * 86400000);
    }

    // Find candidate fixtures in the time window
    const candidates = await this.db
      .select({
        id: schema.fixtures.id,
        date: schema.fixtures.date,
        homeTeamId: schema.fixtures.homeTeamId,
        awayTeamId: schema.fixtures.awayTeamId,
        status: schema.fixtures.status,
      })
      .from(schema.fixtures)
      .where(
        and(
          gte(schema.fixtures.date, searchFrom),
          lte(schema.fixtures.date, searchTo),
        ),
      );

    if (candidates.length === 0) return null;

    // Gather all team IDs to look up names
    const teamIds = new Set<number>();
    for (const c of candidates) {
      teamIds.add(c.homeTeamId);
      teamIds.add(c.awayTeamId);
    }

    if (teamIds.size === 0) return null;

    const teamRows = await this.db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(
        sql`${schema.teams.id} IN (${sql.join(
          [...teamIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const teamNameMap = new Map<number, string>();
    for (const t of teamRows) {
      teamNameMap.set(t.id, t.name);
    }

    // Score each candidate fixture
    let bestMatch: {
      fixtureId: number;
      homeTeamId: number;
      awayTeamId: number;
      homeTeamName: string;
      awayTeamName: string;
      score: number;
    } | null = null;

    for (const c of candidates) {
      const homeName = teamNameMap.get(c.homeTeamId) ?? '';
      const awayName = teamNameMap.get(c.awayTeamId) ?? '';

      if (!homeName || !awayName) continue;

      // Try matching extracted team names against both home and away
      let bestTeamScore = 0;

      for (const teamA of extractedTeams) {
        for (const teamB of extractedTeams) {
          if (teamA === teamB) continue;

          // Try both orderings: teamA=home, teamB=away and vice versa
          const score1 =
            (this.teamNameSimilarity(teamA, homeName) +
              this.teamNameSimilarity(teamB, awayName)) /
            2;
          const score2 =
            (this.teamNameSimilarity(teamB, homeName) +
              this.teamNameSimilarity(teamA, awayName)) /
            2;

          bestTeamScore = Math.max(bestTeamScore, score1, score2);
        }
      }

      // Date proximity bonus
      if (event.startDate) {
        const eventDate = new Date(event.startDate);
        const fixtureDate = new Date(c.date);
        const timeDiff = Math.abs(eventDate.getTime() - fixtureDate.getTime());
        const maxDiff = windowDays * 86400000;
        const timeBonus = 1 - timeDiff / maxDiff;
        bestTeamScore = bestTeamScore * 0.85 + timeBonus * 0.15;
      }

      if (
        bestTeamScore > 0.5 &&
        (!bestMatch || bestTeamScore > bestMatch.score)
      ) {
        bestMatch = {
          fixtureId: c.id,
          homeTeamId: c.homeTeamId,
          awayTeamId: c.awayTeamId,
          homeTeamName: homeName,
          awayTeamName: awayName,
          score: bestTeamScore,
        };
      }
    }

    if (!bestMatch) return null;

    return {
      event,
      market,
      fixtureId: bestMatch.fixtureId,
      homeTeamId: bestMatch.homeTeamId,
      awayTeamId: bestMatch.awayTeamId,
      homeTeamName: bestMatch.homeTeamName,
      awayTeamName: bestMatch.awayTeamName,
      matchScore: bestMatch.score,
      marketType: marketType as MarketFixtureMatch['marketType'],
    };
  }

  // ─── Event classification ───────────────────────────────────────────

  /**
   * Classify a Polymarket event into a market type based on its title and tags.
   */
  private classifyEvent(
    event: ParsedPolymarketEvent,
  ): 'match_outcome' | 'league_winner' | 'top_4' | 'player_prop' | 'other' {
    const text =
      `${event.title} ${event.markets.map((m) => m.question).join(' ')}`.toLowerCase();

    // Match outcome indicators
    if (
      text.includes(' beat ') ||
      text.includes(' win against ') ||
      text.includes(' vs ') ||
      text.includes(' defeat ') ||
      /will .+ win .+ (match|game|fixture)/.test(text) ||
      /will .+ beat /.test(text)
    ) {
      return 'match_outcome';
    }

    // League winner
    if (
      text.includes('win the premier league') ||
      text.includes('win the champions league') ||
      text.includes('win la liga') ||
      text.includes('win serie a') ||
      text.includes('win the bundesliga') ||
      text.includes('win the world cup') ||
      /win the .+ league/.test(text) ||
      /win the .+ cup/.test(text)
    ) {
      return 'league_winner';
    }

    // Top 4 / relegation
    if (
      text.includes('top 4') ||
      text.includes('top four') ||
      text.includes('relegate') ||
      text.includes('finish in the')
    ) {
      return 'top_4';
    }

    // Player props
    if (
      text.includes('score') &&
      (text.includes('goals') || text.includes('hat trick')) &&
      /\d+/.test(text)
    ) {
      return 'player_prop';
    }

    return 'other';
  }

  // ─── Team name extraction ───────────────────────────────────────────

  /**
   * Extract candidate team names from Polymarket event/market text.
   *
   * Examples:
   * - "Will Arsenal beat Man United on March 15?" → ["Arsenal", "Man United"]
   * - "Arsenal vs Chelsea" → ["Arsenal", "Chelsea"]
   * - "Will Arsenal win the match against Liverpool?" → ["Arsenal", "Liverpool"]
   */
  private extractTeamNamesFromText(text: string): string[] {
    const teams: string[] = [];

    // Pattern 1: "X vs Y" or "X v Y"
    const vsMatch = text.match(
      /([A-Z][A-Za-z\s.'-]+?)\s+(?:vs?\.?|versus)\s+([A-Z][A-Za-z\s.'-]+?)(?:\s+(?:on|in|at|–|-|,|\?|$))/i,
    );
    if (vsMatch) {
      teams.push(vsMatch[1].trim(), vsMatch[2].trim());
    }

    // Pattern 2: "Will X beat Y"
    const beatMatch = text.match(
      /(?:will|can|does)\s+([A-Z][A-Za-z\s.'-]+?)\s+(?:beat|defeat|win against)\s+([A-Z][A-Za-z\s.'-]+?)(?:\s+(?:on|in|at|–|-|,|\?|$))/i,
    );
    if (beatMatch && teams.length === 0) {
      teams.push(beatMatch[1].trim(), beatMatch[2].trim());
    }

    // Pattern 3: "X - Y" (dash separated, common in market titles)
    const dashMatch = text.match(
      /([A-Z][A-Za-z\s.'-]+?)\s+[-–]\s+([A-Z][A-Za-z\s.'-]+?)(?:\s+(?:on|in|at|,|\?|$))/i,
    );
    if (dashMatch && teams.length === 0) {
      teams.push(dashMatch[1].trim(), dashMatch[2].trim());
    }

    // Clean up: remove common noise words from extracted names
    return teams
      .map((t) =>
        t
          .replace(/\b(the|will|fc|cf|sc|afc)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((t) => t.length >= 3);
  }

  // ─── Fuzzy matching (reuses patterns from OddsService) ──────────────

  private teamNameSimilarity(a: string, b: string): number {
    const normA = this.normalizeTeamName(a);
    const normB = this.normalizeTeamName(b);

    // Exact match after normalization
    if (normA === normB) return 1.0;

    // One contains the other
    if (normA.includes(normB) || normB.includes(normA)) return 0.85;

    // Check word overlap
    const wordsA = normA.split(' ');
    const wordsB = normB.split(' ');
    const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
    const longer = wordsA.length > wordsB.length ? wordsA : wordsB;
    const longerStr = longer.join(' ');

    const matchingWords = shorter.filter((w) => longerStr.includes(w));
    const wordOverlap = matchingWords.length / shorter.length;

    if (wordOverlap >= 0.8) return 0.75;
    if (wordOverlap >= 0.5) return 0.5;

    // Levenshtein-based similarity
    const lev = this.levenshteinDistance(normA, normB);
    const maxLen = Math.max(normA.length, normB.length);
    return maxLen > 0 ? 1 - lev / maxLen : 0;
  }

  private normalizeTeamName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\b(fc|cf|sc|afc|ac|as|ss|us|rc|cd|ud|rcd|sd|ca|se)\b/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }

    return dp[m][n];
  }
}
