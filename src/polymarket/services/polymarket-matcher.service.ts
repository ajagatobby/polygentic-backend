import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import * as schema from '../../database/schema';
import {
  ParsedPolymarketEvent,
  ParsedMarket,
} from './polymarket-gamma.service';

// ─── Market type classification ───────────────────────────────────────

export type MarketType =
  | 'league_winner'
  | 'tournament_winner'
  | 'qualification'
  | 'match_outcome'
  | 'top_4'
  | 'player_prop'
  | 'other';

// ─── Match results ────────────────────────────────────────────────────

/**
 * Base fields shared by all market match results.
 */
interface BaseMarketMatch {
  event: ParsedPolymarketEvent;
  market: ParsedMarket;
  marketType: MarketType;
  matchScore: number; // 0-1 confidence in the match
}

/**
 * Result of matching a Polymarket market to an outright (league/tournament winner, qualification).
 */
export interface OutrightMarketMatch extends BaseMarketMatch {
  marketType: 'league_winner' | 'tournament_winner' | 'qualification' | 'top_4';
  leagueId: number; // Our internal API-Football league ID
  leagueName: string;
  teamId: number | null; // The team this market is about (null if multi-outcome)
  teamName: string; // e.g. "Liverpool", "Barcelona"
  season: number;
}

/**
 * Result of matching a Polymarket market to an individual fixture.
 */
export interface FixtureMarketMatch extends BaseMarketMatch {
  marketType: 'match_outcome';
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName: string;
  awayTeamName: string;
}

export type MarketMatch = OutrightMarketMatch | FixtureMarketMatch;

// ─── League mapping ───────────────────────────────────────────────────

/**
 * Maps Polymarket market text patterns to internal API-Football league IDs.
 * Patterns are checked against lowercased event title + market question.
 */
interface LeaguePattern {
  leagueId: number;
  leagueName: string;
  patterns: string[]; // Lowercase substrings to match
  season: number; // Current season (API-Football uses start year)
}

const LEAGUE_MAPPINGS: LeaguePattern[] = [
  // Domestic leagues
  {
    leagueId: 39,
    leagueName: 'Premier League',
    patterns: ['premier league', 'epl', 'english premier'],
    season: 2025,
  },
  {
    leagueId: 140,
    leagueName: 'La Liga',
    patterns: ['la liga', 'laliga', 'spanish league', 'primera division'],
    season: 2025,
  },
  {
    leagueId: 135,
    leagueName: 'Serie A',
    patterns: ['serie a', 'italian league'],
    season: 2025,
  },
  {
    leagueId: 78,
    leagueName: 'Bundesliga',
    patterns: ['bundesliga', 'german league'],
    season: 2025,
  },
  {
    leagueId: 61,
    leagueName: 'Ligue 1',
    patterns: ['ligue 1', 'french league'],
    season: 2025,
  },
  {
    leagueId: 88,
    leagueName: 'Eredivisie',
    patterns: ['eredivisie', 'dutch league'],
    season: 2025,
  },
  {
    leagueId: 94,
    leagueName: 'Primeira Liga',
    patterns: ['primeira liga', 'portuguese league', 'liga portugal'],
    season: 2025,
  },
  {
    leagueId: 141,
    leagueName: 'La Liga 2',
    patterns: ['la liga 2', 'segunda division'],
    season: 2025,
  },
  // European club competitions
  {
    leagueId: 2,
    leagueName: 'Champions League',
    patterns: ['champions league', 'ucl'],
    season: 2025,
  },
  {
    leagueId: 3,
    leagueName: 'Europa League',
    patterns: ['europa league', 'uel'],
    season: 2025,
  },
  {
    leagueId: 848,
    leagueName: 'Conference League',
    patterns: ['conference league', 'uecl'],
    season: 2025,
  },
  // International
  {
    leagueId: 1,
    leagueName: 'World Cup',
    patterns: ['world cup 2026', 'fifa world cup'],
    season: 2026,
  },
  {
    leagueId: 4,
    leagueName: 'Euro Championship',
    patterns: ['euro 2028', 'european championship'],
    season: 2028,
  },
  {
    leagueId: 9,
    leagueName: 'Copa America',
    patterns: ['copa america'],
    season: 2025,
  },
  // World Cup qualifiers
  {
    leagueId: 32,
    leagueName: 'World Cup Qualifiers - Europe',
    patterns: ['world cup qualif', 'qualify for the world cup'],
    season: 2025,
  },
  // Domestic cups
  {
    leagueId: 45,
    leagueName: 'FA Cup',
    patterns: ['fa cup'],
    season: 2025,
  },
  {
    leagueId: 143,
    leagueName: 'Copa del Rey',
    patterns: ['copa del rey'],
    season: 2025,
  },
  // Americas
  {
    leagueId: 253,
    leagueName: 'MLS',
    patterns: ['mls', 'major league soccer'],
    season: 2025,
  },
  {
    leagueId: 262,
    leagueName: 'Liga MX',
    patterns: ['liga mx'],
    season: 2025,
  },
];

/**
 * Well-known teams and their typical leagues — used to infer
 * league when the market doesn't explicitly mention one.
 * Only includes top clubs that commonly appear on Polymarket.
 */
const TEAM_LEAGUE_HINTS: Record<string, number> = {
  // Premier League (39)
  arsenal: 39,
  chelsea: 39,
  liverpool: 39,
  'man city': 39,
  'manchester city': 39,
  'man united': 39,
  'manchester united': 39,
  tottenham: 39,
  newcastle: 39,
  'newcastle united': 39,
  'aston villa': 39,
  'west ham': 39,
  brighton: 39,
  'nottingham forest': 39,
  // La Liga (140)
  'real madrid': 140,
  barcelona: 140,
  'atletico madrid': 140,
  'athletic bilbao': 140,
  'real sociedad': 140,
  villarreal: 140,
  'real betis': 140,
  // Serie A (135)
  juventus: 135,
  'inter milan': 135,
  inter: 135,
  'ac milan': 135,
  milan: 135,
  napoli: 135,
  roma: 135,
  atalanta: 135,
  lazio: 135,
  fiorentina: 135,
  // Bundesliga (78)
  'bayern munich': 78,
  'bayern münchen': 78,
  bayern: 78,
  'borussia dortmund': 78,
  dortmund: 78,
  'rb leipzig': 78,
  leverkusen: 78,
  'bayer leverkusen': 78,
  // Ligue 1 (61)
  psg: 61,
  'paris saint-germain': 61,
  marseille: 61,
  monaco: 61,
  lyon: 61,
  lille: 61,
};

/**
 * PolymarketMatcherService
 *
 * Links Polymarket events to internal leagues, teams, and fixtures.
 * Handles both:
 * - Outright markets (league winners, tournament winners, qualification)
 * - Match outcome markets (individual fixture results)
 *
 * Since Polymarket currently has NO individual match outcome markets
 * for soccer, the outright path is the primary flow.
 */
@Injectable()
export class PolymarketMatcherService {
  private readonly logger = new Logger(PolymarketMatcherService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  /**
   * Match a batch of Polymarket events to internal data.
   * Returns matched markets across all types (outrights and fixtures).
   */
  async matchEvents(events: ParsedPolymarketEvent[]): Promise<MarketMatch[]> {
    const matches: MarketMatch[] = [];

    for (const event of events) {
      for (const market of event.markets) {
        const marketType = this.classifyMarket(event, market);

        if (marketType === 'other' || marketType === 'player_prop') continue;

        if (marketType === 'match_outcome') {
          const match = await this.matchToFixture(event, market);
          if (match) matches.push(match);
        } else {
          // Outright markets: league_winner, tournament_winner, qualification, top_4
          const match = await this.matchToOutright(event, market, marketType);
          if (match) matches.push(match);
        }
      }
    }

    const outrightCount = matches.filter(
      (m) => m.marketType !== 'match_outcome',
    ).length;
    const fixtureCount = matches.filter(
      (m) => m.marketType === 'match_outcome',
    ).length;

    this.logger.log(
      `Matched ${matches.length} markets (${outrightCount} outrights, ${fixtureCount} fixtures) from ${events.length} events`,
    );

    return matches;
  }

  // ─── Event / market classification ──────────────────────────────────

  /**
   * Classify a market into a type based on event title + market question.
   * Examines per-market (not per-event) since one event can have mixed types.
   */
  classifyMarket(
    event: ParsedPolymarketEvent,
    market: ParsedMarket,
  ): MarketType {
    const text = `${event.title} ${market.question}`.toLowerCase();

    // ── Match outcome ──────────────────────────────────────────────
    if (
      text.includes(' beat ') ||
      text.includes(' win against ') ||
      text.includes(' defeat ') ||
      /will .+ (beat|defeat) /.test(text) ||
      /\bvs\.?\s/.test(text) ||
      /\bv\s/.test(text)
    ) {
      return 'match_outcome';
    }

    // ── World Cup qualification ────────────────────────────────────
    if (
      text.includes('qualify') ||
      text.includes('qualification') ||
      text.includes('make the world cup') ||
      text.includes('reach the world cup')
    ) {
      return 'qualification';
    }

    // ── Tournament winner (one-off competition) ───────────────────
    if (
      (text.includes('win') || text.includes('winner')) &&
      (text.includes('champions league') ||
        text.includes('europa league') ||
        text.includes('conference league') ||
        text.includes('world cup') ||
        text.includes('copa america') ||
        text.includes('euro 20') ||
        text.includes('fa cup') ||
        text.includes('copa del rey') ||
        text.includes('carabao cup'))
    ) {
      return 'tournament_winner';
    }

    // ── League winner (domestic league title) ─────────────────────
    if (
      (text.includes('win') || text.includes('winner')) &&
      (text.includes('premier league') ||
        text.includes('la liga') ||
        text.includes('serie a') ||
        text.includes('bundesliga') ||
        text.includes('ligue 1') ||
        text.includes('eredivisie') ||
        text.includes('primeira liga') ||
        text.includes('mls') ||
        text.includes('liga mx') ||
        text.includes('league title') ||
        // Generic "win the <X> 2025-26"
        /win the .+ 20\d{2}/.test(text))
    ) {
      return 'league_winner';
    }

    // ── Top 4 / placement / relegation / promotion ─────────────
    if (
      text.includes('top 4') ||
      text.includes('top four') ||
      text.includes('relegate') ||
      text.includes('relegated') ||
      text.includes('promoted') ||
      text.includes('promotion') ||
      text.includes('finish in the') ||
      text.includes('finish in 2nd') ||
      text.includes('finish in 3rd') ||
      text.includes('finish in last') ||
      /finish in \d+(st|nd|rd|th) place/i.test(text) ||
      text.includes('last place') ||
      text.includes('champions league spot') ||
      text.includes('qualify for champions league')
    ) {
      return 'top_4';
    }

    // ── Player props (top goalscorer, etc.) ───────────────────────
    if (
      text.includes('top goal scorer') ||
      text.includes('top goalscorer') ||
      text.includes('golden boot') ||
      text.includes('top ucl goal scorer') ||
      text.includes('top scorer') ||
      ((text.includes('score') || text.includes('goals')) &&
        /\d+\s*(goals|or more|hat trick)/i.test(text))
    ) {
      return 'player_prop';
    }

    // ── Fallback: if the event title / question mentions a league
    //    and "win", it's probably an outright we missed above ──────
    for (const mapping of LEAGUE_MAPPINGS) {
      for (const pattern of mapping.patterns) {
        if (text.includes(pattern)) {
          if (text.includes('win') || text.includes('winner')) {
            return mapping.leagueId === 2 ||
              mapping.leagueId === 3 ||
              mapping.leagueId === 848 ||
              mapping.leagueId === 1 ||
              mapping.leagueId === 4 ||
              mapping.leagueId === 9
              ? 'tournament_winner'
              : 'league_winner';
          }
          // It mentions a league but not "win" — might be qualification or other
          if (text.includes('qualify') || text.includes('reach')) {
            return 'qualification';
          }
        }
      }
    }

    return 'other';
  }

  // ─── Outright matching ──────────────────────────────────────────────

  /**
   * Match an outright market (league/tournament winner, qualification) to our data.
   * Returns the league, team, and season info.
   */
  private async matchToOutright(
    event: ParsedPolymarketEvent,
    market: ParsedMarket,
    marketType:
      | 'league_winner'
      | 'tournament_winner'
      | 'qualification'
      | 'top_4',
  ): Promise<OutrightMarketMatch | null> {
    const text = `${event.title} ${market.question}`.toLowerCase();

    // Step 1: Identify the league/competition
    let leagueMatch: LeaguePattern | null = null;

    for (const mapping of LEAGUE_MAPPINGS) {
      for (const pattern of mapping.patterns) {
        if (text.includes(pattern)) {
          leagueMatch = mapping;
          break;
        }
      }
      if (leagueMatch) break;
    }

    // If no league found from text, try to infer from team name
    if (!leagueMatch) {
      const teamName = this.extractTeamNameFromOutright(text);
      if (teamName) {
        const inferredLeagueId = TEAM_LEAGUE_HINTS[teamName.toLowerCase()];
        if (inferredLeagueId) {
          leagueMatch =
            LEAGUE_MAPPINGS.find((m) => m.leagueId === inferredLeagueId) ??
            null;
        }
      }
    }

    if (!leagueMatch) {
      this.logger.debug(
        `Could not identify league for outright: "${market.question}"`,
      );
      return null;
    }

    // Step 2: Extract team name from the market question
    const teamName = this.extractTeamNameFromOutright(text);

    if (!teamName) {
      this.logger.debug(
        `Could not extract team name from outright: "${market.question}"`,
      );
      return null;
    }

    // Step 3: Look up the team in our DB using fuzzy matching
    const teamResult = await this.findTeamByName(teamName);

    return {
      event,
      market,
      marketType,
      leagueId: leagueMatch.leagueId,
      leagueName: leagueMatch.leagueName,
      teamId: teamResult?.id ?? null,
      teamName: teamResult?.name ?? teamName,
      season: leagueMatch.season,
      matchScore: teamResult ? 0.8 : 0.5, // Higher confidence if we found the team in DB
    };
  }

  /**
   * Extract a team/country name from an outright market question.
   *
   * Examples:
   * - "Will Liverpool win the Premier League 2025-26?" → "Liverpool"
   * - "Will Barcelona win the Champions League 2025-26?" → "Barcelona"
   * - "Will Italy qualify for the 2026 World Cup?" → "Italy"
   * - "PSG to win Ligue 1?" → "PSG"
   */
  private extractTeamNameFromOutright(text: string): string | null {
    // Pattern 1: "Will X win ..."
    const willWinMatch = text.match(
      /will\s+([a-z][a-z\s.'-]+?)\s+(?:win|qualify|make|reach)\b/i,
    );
    if (willWinMatch) {
      return this.cleanTeamName(willWinMatch[1]);
    }

    // Pattern 2: "X to win ..."
    const toWinMatch = text.match(
      /^([a-z][a-z\s.'-]+?)\s+to\s+(?:win|qualify|make|reach)\b/i,
    );
    if (toWinMatch) {
      return this.cleanTeamName(toWinMatch[1]);
    }

    // Pattern 3: "Can X win ..."
    const canWinMatch = text.match(
      /can\s+([a-z][a-z\s.'-]+?)\s+(?:win|qualify|make|reach)\b/i,
    );
    if (canWinMatch) {
      return this.cleanTeamName(canWinMatch[1]);
    }

    // Pattern 4: Market question is just a team name (in multi-outcome events)
    // e.g. event "Premier League 2025-26 Winner" with market questions "Liverpool", "Arsenal", etc.
    const trimmed = text.trim();
    if (trimmed.length < 40 && !trimmed.includes('?')) {
      // Could be a bare team name — check against known teams
      const lowerTrimmed = trimmed.toLowerCase();
      if (TEAM_LEAGUE_HINTS[lowerTrimmed]) {
        return this.cleanTeamName(trimmed);
      }
    }

    return null;
  }

  private cleanTeamName(name: string): string {
    return name
      .replace(/\b(the|fc|cf|sc|afc|ac|as)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Find a team in our DB by fuzzy name matching.
   */
  private async findTeamByName(
    name: string,
  ): Promise<{ id: number; name: string } | null> {
    const normalized = this.normalizeTeamName(name);

    // First try exact match on normalized name
    const exactRows = await this.db
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams);

    let bestMatch: { id: number; name: string; score: number } | null = null;

    for (const row of exactRows) {
      const score = this.teamNameSimilarity(name, row.name);
      if (score > 0.6 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { id: row.id, name: row.name, score };
      }
    }

    if (bestMatch) {
      this.logger.debug(
        `Matched "${name}" → "${bestMatch.name}" (id=${bestMatch.id}, score=${bestMatch.score.toFixed(2)})`,
      );
    }

    return bestMatch ? { id: bestMatch.id, name: bestMatch.name } : null;
  }

  // ─── Fixture matching (kept for match_outcome markets) ──────────────

  /**
   * Match a match_outcome market to a fixture.
   * Same approach as before — kept for completeness, even though
   * Polymarket currently has no individual match outcome soccer markets.
   */
  private async matchToFixture(
    event: ParsedPolymarketEvent,
    market: ParsedMarket,
  ): Promise<FixtureMarketMatch | null> {
    const textToSearch = `${event.title} ${market.question}`;
    const extractedTeams = this.extractTeamNamesFromMatchText(textToSearch);

    if (extractedTeams.length < 2) return null;

    // Time window for fixture search
    const windowDays = 7;
    const now = new Date();
    let searchFrom: Date;
    let searchTo: Date;

    if (event.startDate) {
      const eventStart = new Date(event.startDate);
      searchFrom = new Date(eventStart.getTime() - windowDays * 86400000);
      searchTo = new Date(eventStart.getTime() + windowDays * 86400000);
    } else {
      searchFrom = new Date(now.getTime() - 2 * 86400000);
      searchTo = new Date(now.getTime() + 14 * 86400000);
    }

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

    // Gather team names
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

    // Score candidates
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

      let bestTeamScore = 0;
      for (const teamA of extractedTeams) {
        for (const teamB of extractedTeams) {
          if (teamA === teamB) continue;
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
      marketType: 'match_outcome',
      fixtureId: bestMatch.fixtureId,
      homeTeamId: bestMatch.homeTeamId,
      awayTeamId: bestMatch.awayTeamId,
      homeTeamName: bestMatch.homeTeamName,
      awayTeamName: bestMatch.awayTeamName,
      matchScore: bestMatch.score,
    };
  }

  // ─── Team name extraction for match outcomes ────────────────────────

  private extractTeamNamesFromMatchText(text: string): string[] {
    const teams: string[] = [];

    // Pattern 1: "X vs Y"
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

    // Pattern 3: "X - Y"
    const dashMatch = text.match(
      /([A-Z][A-Za-z\s.'-]+?)\s+[-–]\s+([A-Z][A-Za-z\s.'-]+?)(?:\s+(?:on|in|at|,|\?|$))/i,
    );
    if (dashMatch && teams.length === 0) {
      teams.push(dashMatch[1].trim(), dashMatch[2].trim());
    }

    return teams
      .map((t) =>
        t
          .replace(/\b(the|will|fc|cf|sc|afc)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((t) => t.length >= 3);
  }

  // ─── Fuzzy matching ─────────────────────────────────────────────────

  private teamNameSimilarity(a: string, b: string): number {
    const normA = this.normalizeTeamName(a);
    const normB = this.normalizeTeamName(b);

    if (normA === normB) return 1.0;
    if (normA.includes(normB) || normB.includes(normA)) return 0.85;

    const wordsA = normA.split(' ');
    const wordsB = normB.split(' ');
    const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
    const longer = wordsA.length > wordsB.length ? wordsA : wordsB;
    const longerStr = longer.join(' ');

    const matchingWords = shorter.filter((w) => longerStr.includes(w));
    const wordOverlap = matchingWords.length / shorter.length;

    if (wordOverlap >= 0.8) return 0.75;
    if (wordOverlap >= 0.5) return 0.5;

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
