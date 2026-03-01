import { Injectable } from '@nestjs/common';
import Fuse from 'fuse.js';

/**
 * Common patterns used to extract team names from Polymarket titles.
 *
 * Examples:
 *   "Will Arsenal beat Manchester United on March 15?"
 *   "Arsenal vs Manchester United: Who will win?"
 *   "Liverpool to win against Chelsea"
 *   "Real Madrid vs. Barcelona - La Liga Match Result"
 */
const VS_PATTERNS = [
  // "Team A vs Team B" or "Team A vs. Team B"
  /^(.+?)\s+vs\.?\s+(.+?)(?:\s*[-–:—]|\s*\?|\s+on\s|\s+in\s|$)/i,
  // "Team A versus Team B"
  /^(.+?)\s+versus\s+(.+?)(?:\s*[-–:—]|\s*\?|\s+on\s|$)/i,
  // "Will Team A beat/defeat Team B"
  /will\s+(.+?)\s+(?:beat|defeat|win\s+against)\s+(.+?)(?:\s*\?|\s+on\s|\s+in\s|$)/i,
  // "Team A to win against Team B"
  /(.+?)\s+to\s+(?:win|beat)\s+(?:against\s+)?(.+?)(?:\s*\?|\s+on\s|$)/i,
  // "Who will win Team A vs Team B"
  /who\s+will\s+win\s+(.+?)\s+vs\.?\s+(.+?)(?:\s*\?|$)/i,
  // "Team A - Team B" (common in European contexts)
  /^(.+?)\s*[-–]\s*(.+?)(?:\s*[-–:—]|\s*\?|\s+on\s|$)/i,
];

/**
 * Patterns to extract dates from text.
 *
 * Examples:
 *   "on March 15, 2025"
 *   "on 15/03/2025"
 *   "on 2025-03-15"
 *   "March 15"
 */
const DATE_PATTERNS = [
  // ISO format: 2025-03-15
  /(\d{4})-(\d{1,2})-(\d{1,2})/,
  // US format: 03/15/2025
  /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
  // "March 15, 2025" or "March 15"
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i,
  // "15 March 2025" or "15 March"
  /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?/i,
];

const MONTH_MAP: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/**
 * Keywords used to classify market types.
 */
const MARKET_TYPE_KEYWORDS: Record<string, string[]> = {
  match_outcome: [
    'win',
    'beat',
    'defeat',
    'vs',
    'versus',
    'match',
    'result',
    'who will win',
  ],
  league_winner: [
    'win the league',
    'league champion',
    'win the title',
    'premier league winner',
    'la liga winner',
    'serie a winner',
    'bundesliga winner',
    'ligue 1 winner',
    'title',
    'champion',
  ],
  top_finish: [
    'top 4',
    'top 6',
    'top four',
    'top six',
    'qualify for champions',
    'qualify for europa',
    'finish in',
    'finish inside',
  ],
  relegation: ['relegated', 'relegation', 'avoid relegation', 'drop down'],
  transfer: [
    'transfer',
    'sign',
    'signing',
    'join',
    'move to',
    'leave',
    'transfer window',
  ],
  player_prop: [
    'goals this season',
    'score',
    'assists',
    'top scorer',
    'golden boot',
    'hat trick',
    'clean sheet',
    'ballon',
    'player of',
  ],
  manager: [
    'manager',
    'coach',
    'sacked',
    'fired',
    'appointed',
    'head coach',
    'replaced as',
  ],
  tournament: [
    'world cup',
    'euro 20',
    'copa america',
    'nations league',
    'win the champions league',
    'win the europa league',
  ],
  over_under: [
    'over',
    'under',
    'total goals',
    'goals scored',
    'more than',
    'fewer than',
  ],
};

/** Noise words to strip when cleaning team name candidates. */
const NOISE_WORDS = new Set([
  'will',
  'the',
  'on',
  'in',
  'at',
  'to',
  'a',
  'an',
  'who',
  'match',
  'game',
  'result',
  'outcome',
  'winner',
  'win',
  'beat',
  'defeat',
  'against',
  'for',
  'of',
  'and',
  'or',
]);

@Injectable()
export class FuzzyMatchUtil {
  /**
   * Extract potential team names from a Polymarket market title.
   * Returns an array of 0-2 team name candidates.
   */
  static extractTeamNames(text: string): string[] {
    const cleaned = text.trim();

    for (const pattern of VS_PATTERNS) {
      const match = cleaned.match(pattern);
      if (match) {
        const team1 = FuzzyMatchUtil.cleanTeamName(match[1]);
        const team2 = FuzzyMatchUtil.cleanTeamName(match[2]);
        const results: string[] = [];
        if (team1.length > 1) results.push(team1);
        if (team2.length > 1) results.push(team2);
        if (results.length > 0) return results;
      }
    }

    // Fallback: try to find capitalized multi-word sequences
    // that look like team names (e.g., "Manchester United", "Real Madrid")
    const capitalWordGroups = cleaned.match(
      /(?:[A-Z][a-z]+(?:\s+(?:of|de|del|la|el|al|FC|SC|CF|AC|AS|SS|US|SV)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
    );

    if (capitalWordGroups && capitalWordGroups.length > 0) {
      return capitalWordGroups.slice(0, 2).map(FuzzyMatchUtil.cleanTeamName);
    }

    return [];
  }

  /**
   * Fuzzy match a query string against a list of teams.
   * Returns the best match or null if no good match is found.
   */
  static fuzzyMatchTeam(
    query: string,
    teams: Array<{ id: number; name: string }>,
  ): { id: number; name: string; score: number } | null {
    if (!query || teams.length === 0) return null;

    const fuse = new Fuse(teams, {
      keys: ['name'],
      threshold: 0.4,
      includeScore: true,
      isCaseSensitive: false,
      minMatchCharLength: 2,
    });

    const results = fuse.search(query);

    if (results.length === 0) return null;

    const best = results[0];
    // Fuse score: 0 = perfect match, 1 = no match at all
    const confidence = 1 - (best.score ?? 1);

    if (confidence < 0.3) return null;

    return {
      id: best.item.id,
      name: best.item.name,
      score: confidence,
    };
  }

  /**
   * Extract a date from free-form text.
   * Returns null if no recognisable date is found.
   */
  static extractDate(text: string): Date | null {
    // Try ISO format first: 2025-03-15
    const isoMatch = text.match(DATE_PATTERNS[0]);
    if (isoMatch) {
      const d = new Date(
        parseInt(isoMatch[1], 10),
        parseInt(isoMatch[2], 10) - 1,
        parseInt(isoMatch[3], 10),
      );
      if (!isNaN(d.getTime())) return d;
    }

    // US format: 03/15/2025
    const usMatch = text.match(DATE_PATTERNS[1]);
    if (usMatch) {
      const d = new Date(
        parseInt(usMatch[3], 10),
        parseInt(usMatch[1], 10) - 1,
        parseInt(usMatch[2], 10),
      );
      if (!isNaN(d.getTime())) return d;
    }

    // "March 15, 2025"
    const monthFirstMatch = text.match(DATE_PATTERNS[2]);
    if (monthFirstMatch) {
      const month = MONTH_MAP[monthFirstMatch[1].toLowerCase()];
      const day = parseInt(monthFirstMatch[2], 10);
      const year = monthFirstMatch[3]
        ? parseInt(monthFirstMatch[3], 10)
        : new Date().getFullYear();
      if (month !== undefined) {
        const d = new Date(year, month, day);
        if (!isNaN(d.getTime())) return d;
      }
    }

    // "15 March 2025"
    const dayFirstMatch = text.match(DATE_PATTERNS[3]);
    if (dayFirstMatch) {
      const day = parseInt(dayFirstMatch[1], 10);
      const month = MONTH_MAP[dayFirstMatch[2].toLowerCase()];
      const year = dayFirstMatch[3]
        ? parseInt(dayFirstMatch[3], 10)
        : new Date().getFullYear();
      if (month !== undefined) {
        const d = new Date(year, month, day);
        if (!isNaN(d.getTime())) return d;
      }
    }

    return null;
  }

  /**
   * Classify a Polymarket market into a type based on its title.
   */
  static determineMarketType(title: string): string {
    const lowerTitle = title.toLowerCase();

    // Check each type in order of specificity (more specific first)
    const orderedTypes = [
      'tournament',
      'transfer',
      'manager',
      'player_prop',
      'relegation',
      'top_finish',
      'league_winner',
      'over_under',
      'match_outcome',
    ];

    for (const type of orderedTypes) {
      const keywords = MARKET_TYPE_KEYWORDS[type];
      if (keywords && keywords.some((kw) => lowerTitle.includes(kw))) {
        return type;
      }
    }

    return 'other';
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private static cleanTeamName(raw: string): string {
    return raw
      .replace(/[?!.,;:'"()]/g, '')
      .split(/\s+/)
      .filter((w) => !NOISE_WORDS.has(w.toLowerCase()))
      .join(' ')
      .trim();
  }
}
