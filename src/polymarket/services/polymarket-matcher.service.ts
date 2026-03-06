import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import * as schema from '../../database/schema';
import {
  ParsedPolymarketEvent,
  ParsedMarket,
  POLYMARKET_SOCCER_TAGS,
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
  /** Polymarket tag slugs that map to this league */
  tagSlugs?: string[];
}

const LEAGUE_MAPPINGS: LeaguePattern[] = [
  // ── Top 5 European domestic leagues ─────────────────────────────
  {
    leagueId: 39,
    leagueName: 'Premier League',
    patterns: ['premier league', 'epl', 'english premier'],
    season: 2025,
    tagSlugs: ['epl'],
  },
  {
    leagueId: 140,
    leagueName: 'La Liga',
    patterns: ['la liga', 'laliga', 'spanish league', 'primera division'],
    season: 2025,
    tagSlugs: ['la-liga'],
  },
  {
    leagueId: 135,
    leagueName: 'Serie A',
    patterns: ['serie a', 'italian league'],
    season: 2025,
    tagSlugs: ['serie-a'],
  },
  {
    leagueId: 78,
    leagueName: 'Bundesliga',
    patterns: ['bundesliga', 'german league'],
    season: 2025,
    tagSlugs: ['bundesliga'],
  },
  {
    leagueId: 61,
    leagueName: 'Ligue 1',
    patterns: ['ligue 1', 'french league'],
    season: 2025,
    tagSlugs: ['ligue-1'],
  },

  // ── Other European domestic leagues ─────────────────────────────
  {
    leagueId: 88,
    leagueName: 'Eredivisie',
    patterns: ['eredivisie', 'dutch league'],
    season: 2025,
    tagSlugs: ['eredivisie'],
  },
  {
    leagueId: 94,
    leagueName: 'Primeira Liga',
    patterns: ['primeira liga', 'portuguese league', 'liga portugal'],
    season: 2025,
    tagSlugs: ['primeira-liga'],
  },
  {
    leagueId: 203,
    leagueName: 'Turkish Super Lig',
    patterns: ['super lig', 'turkish league', 'süper lig'],
    season: 2025,
    tagSlugs: ['super-lig'],
  },
  {
    leagueId: 179,
    leagueName: 'Scottish Premiership',
    patterns: ['scottish premiership', 'scottish league', 'spfl'],
    season: 2025,
    tagSlugs: ['scottish-premiership'],
  },
  {
    leagueId: 283,
    leagueName: 'Romania SuperLiga',
    patterns: ['romania superliga', 'romanian league', 'liga 1 romania'],
    season: 2025,
    tagSlugs: ['romania-superliga'],
  },
  {
    leagueId: 345,
    leagueName: 'Czechia Fortuna Liga',
    patterns: ['fortuna liga', 'czech league', 'czech first league'],
    season: 2025,
    tagSlugs: ['czechia-fortuna-liga'],
  },
  {
    leagueId: 103,
    leagueName: 'Norway Eliteserien',
    patterns: ['eliteserien', 'norwegian league'],
    season: 2025,
    tagSlugs: ['norway-eliteserien'],
  },
  {
    leagueId: 141,
    leagueName: 'La Liga 2',
    patterns: ['la liga 2', 'segunda division'],
    season: 2025,
  },

  // ── European club competitions ──────────────────────────────────
  {
    leagueId: 2,
    leagueName: 'Champions League',
    patterns: ['champions league', 'ucl'],
    season: 2025,
    tagSlugs: ['ucl'],
  },
  {
    leagueId: 3,
    leagueName: 'Europa League',
    patterns: ['europa league', 'uel'],
    season: 2025,
    tagSlugs: ['uel'],
  },
  {
    leagueId: 848,
    leagueName: 'Conference League',
    patterns: ['conference league', 'uecl'],
    season: 2025,
    tagSlugs: ['uefa-europa-conference-league'],
  },

  // ── Americas ────────────────────────────────────────────────────
  {
    leagueId: 253,
    leagueName: 'MLS',
    patterns: ['mls', 'major league soccer'],
    season: 2025,
    tagSlugs: ['mls'],
  },
  {
    leagueId: 262,
    leagueName: 'Liga MX',
    patterns: ['liga mx'],
    season: 2025,
    tagSlugs: ['liga-mx'],
  },
  {
    leagueId: 71,
    leagueName: 'Brazil Serie A',
    patterns: ['brazil serie a', 'brasileirao', 'série a'],
    season: 2025,
    tagSlugs: ['brazil-serie-a'],
  },
  {
    leagueId: 239,
    leagueName: 'Colombia Primera A',
    patterns: ['colombia primera', 'liga betplay'],
    season: 2025,
    tagSlugs: ['colombia-primera-a'],
  },
  {
    leagueId: 13,
    leagueName: 'Copa Libertadores',
    patterns: ['copa libertadores', 'libertadores'],
    season: 2025,
    tagSlugs: ['copa-libertadores'],
  },
  {
    leagueId: 11,
    leagueName: 'Copa Sudamericana',
    patterns: ['copa sudamericana', 'sudamericana'],
    season: 2025,
    tagSlugs: ['copa-sudamericana'],
  },
  {
    leagueId: 265,
    leagueName: 'Chile Primera Division',
    patterns: ['chile primera', 'primera division chile'],
    season: 2025,
    tagSlugs: ['chile-primera'],
  },
  {
    leagueId: 281,
    leagueName: 'Peru Liga 1',
    patterns: ['peru liga 1', 'liga 1 peru'],
    season: 2025,
    tagSlugs: ['peru-liga-1'],
  },

  // ── Asia / Africa / Oceania ─────────────────────────────────────
  {
    leagueId: 307,
    leagueName: 'Saudi Professional League',
    patterns: ['saudi professional league', 'saudi league', 'spl'],
    season: 2025,
    tagSlugs: ['saudi-professional-league'],
  },
  {
    leagueId: 98,
    leagueName: 'J. League',
    patterns: ['j. league', 'j-league', 'j1 league', 'japan league'],
    season: 2025,
    tagSlugs: ['j-league'],
  },
  {
    leagueId: 99,
    leagueName: 'J2 League',
    patterns: ['j2 league', 'j2'],
    season: 2025,
    tagSlugs: ['j2-league'],
  },
  {
    leagueId: 292,
    leagueName: 'K-League',
    patterns: ['k-league', 'k league', 'korean league'],
    season: 2025,
    tagSlugs: ['k-league'],
  },
  {
    leagueId: 188,
    leagueName: 'A-League',
    patterns: ['a-league', 'a league', 'australian league'],
    season: 2025,
    tagSlugs: ['a-league'],
  },
  {
    leagueId: 233,
    leagueName: 'Egypt Premier League',
    patterns: ['egypt premier', 'egyptian league'],
    season: 2025,
    tagSlugs: ['egypt-premier-league'],
  },
  {
    leagueId: 200,
    leagueName: 'Morocco Botola Pro',
    patterns: ['botola pro', 'moroccan league'],
    season: 2025,
    tagSlugs: ['morocco-botola-pro'],
  },

  // ── International ───────────────────────────────────────────────
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
  {
    leagueId: 10,
    leagueName: 'FIFA Friendlies',
    patterns: ['friendly', 'friendlies', 'international friendly'],
    season: 2025,
    tagSlugs: ['fifa-friendlies'],
  },

  // ── World Cup qualifiers ────────────────────────────────────────
  {
    leagueId: 32,
    leagueName: 'World Cup Qualifiers - Europe',
    patterns: [
      'world cup qualif',
      'qualify for the world cup',
      'wc qualifiers',
    ],
    season: 2025,
    tagSlugs: ['europe-wc-qualifiers'],
  },

  // ── Domestic cups ───────────────────────────────────────────────
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
];

/**
 * Build a quick lookup: Polymarket tag_slug → LeaguePattern
 */
const TAG_SLUG_TO_LEAGUE = new Map<string, LeaguePattern>();
for (const mapping of LEAGUE_MAPPINGS) {
  if (mapping.tagSlugs) {
    for (const slug of mapping.tagSlugs) {
      TAG_SLUG_TO_LEAGUE.set(slug, mapping);
    }
  }
}

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
  everton: 39,
  fulham: 39,
  'crystal palace': 39,
  bournemouth: 39,
  wolves: 39,
  wolverhampton: 39,
  // La Liga (140)
  'real madrid': 140,
  barcelona: 140,
  'atletico madrid': 140,
  'athletic bilbao': 140,
  'real sociedad': 140,
  villarreal: 140,
  'real betis': 140,
  sevilla: 140,
  valencia: 140,
  girona: 140,
  osasuna: 140,
  mallorca: 140,
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
  bologna: 135,
  torino: 135,
  // Bundesliga (78)
  'bayern munich': 78,
  'bayern münchen': 78,
  bayern: 78,
  'borussia dortmund': 78,
  dortmund: 78,
  'rb leipzig': 78,
  leverkusen: 78,
  'bayer leverkusen': 78,
  'eintracht frankfurt': 78,
  stuttgart: 78,
  wolfsburg: 78,
  // Ligue 1 (61)
  psg: 61,
  'paris saint-germain': 61,
  marseille: 61,
  monaco: 61,
  lyon: 61,
  lille: 61,
  nice: 61,
  lens: 61,
  // Eredivisie (88)
  ajax: 88,
  psv: 88,
  feyenoord: 88,
  'az alkmaar': 88,
  // Primeira Liga (94)
  benfica: 94,
  porto: 94,
  sporting: 94,
  'sporting cp': 94,
  // Turkish Super Lig (203)
  galatasaray: 203,
  fenerbahce: 203,
  besiktas: 203,
  trabzonspor: 203,
  // Saudi Professional League (307)
  'al hilal': 307,
  'al ahli': 307,
  'al nassr': 307,
  'al ittihad': 307,
  // MLS (253)
  'inter miami': 253,
  'la galaxy': 253,
  lafc: 253,
  'atlanta united': 253,
  // Liga MX (262)
  'club america': 262,
  'cruz azul': 262,
  guadalajara: 262,
  chivas: 262,
  tigres: 262,
  monterrey: 262,
};

/**
 * PolymarketMatcherService
 *
 * Links Polymarket events to internal leagues, teams, and fixtures.
 * Handles both:
 * - Outright markets (league winners, tournament winners, qualification)
 * - Match outcome markets (individual fixture results — moneyline, spread, total)
 *
 * Now supports structured sports event data from Polymarket (sportsMarketType,
 * polymarketTagSlug, seriesSlug, etc.) for higher-confidence matching.
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
   * Also uses structured Polymarket sports data (sportsMarketType) when available.
   */
  classifyMarket(
    event: ParsedPolymarketEvent,
    market: ParsedMarket,
  ): MarketType {
    // ── Structured sports data: sportsMarketType ──────────────────
    // Polymarket's sports match markets have a sportsMarketType field
    // that directly tells us the market type.
    if (market.sportsMarketType) {
      const smt = market.sportsMarketType.toLowerCase();
      if (smt === 'moneyline' || smt === 'spread' || smt === 'total') {
        return 'match_outcome';
      }
    }

    const text = `${event.title} ${market.question}`.toLowerCase();

    // ── Match outcome (text-based detection) ─────────────────────
    // Check for "vs" pattern first, and also handle event slug patterns
    // like "lal-osa-mal-2026-03-06" which indicate match events
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

    // ── Detect multi-outcome match events by structure ────────────
    // If the event has negRisk=true and the market question looks like
    // a team name (e.g. "Real Madrid", "Draw"), it's a match moneyline
    if (
      event.negRisk &&
      event.markets.length >= 3 &&
      this.looksLikeMatchMoneyline(event)
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
        text.includes('carabao cup') ||
        text.includes('copa libertadores') ||
        text.includes('copa sudamericana'))
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
        text.includes('super lig') ||
        text.includes('saudi professional league') ||
        text.includes('a-league') ||
        text.includes('k-league') ||
        text.includes('j. league') ||
        text.includes('eliteserien') ||
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
            return this.isCompetitionLeague(mapping.leagueId)
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

  /**
   * Check whether a multi-outcome event looks like a match moneyline
   * (e.g. has markets like "Real Madrid", "Draw", "Osasuna").
   */
  private looksLikeMatchMoneyline(event: ParsedPolymarketEvent): boolean {
    const questions = event.markets.map((m) => m.question.toLowerCase());
    // Check for "Draw" or "draw" as one of the outcomes — strong signal
    if (questions.some((q) => q === 'draw' || q === 'the draw')) {
      return true;
    }
    // Check if event title has "vs" or similar match patterns
    const title = event.title.toLowerCase();
    if (/\bvs\.?\b/.test(title) || /\bv\s/.test(title)) {
      return true;
    }
    // Check slug pattern: league-prefix + team abbreviations + date
    // e.g. "lal-osa-mal-2026-03-06"
    if (/^\w{2,4}(-\w{2,4}){1,3}-\d{4}-\d{2}-\d{2}$/.test(event.slug)) {
      return true;
    }
    return false;
  }

  /** Check if a league ID is a cup/tournament (not a domestic league) */
  private isCompetitionLeague(leagueId: number): boolean {
    const competitions = new Set([2, 3, 848, 1, 4, 9, 10, 11, 13, 32, 45, 143]);
    return competitions.has(leagueId);
  }

  // ─── Outright matching ──────────────────────────────────────────────

  /**
   * Match an outright market (league/tournament winner, qualification) to our data.
   * Returns the league, team, and season info.
   *
   * Now also uses the event's polymarketTagSlug for higher-confidence league detection.
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
    const textLower = `${event.title} ${market.question}`.toLowerCase();
    // Keep original case for team name extraction (so "Italy" stays capitalized)
    const textOriginal = `${event.title} ${market.question}`;

    // Step 1: Identify the league/competition
    let leagueMatch: LeaguePattern | null = null;

    // First, try to identify from the polymarketTagSlug (highest confidence)
    if (event.polymarketTagSlug) {
      leagueMatch = TAG_SLUG_TO_LEAGUE.get(event.polymarketTagSlug) ?? null;
    }

    // Then, try text-based matching
    if (!leagueMatch) {
      for (const mapping of LEAGUE_MAPPINGS) {
        for (const pattern of mapping.patterns) {
          if (textLower.includes(pattern)) {
            leagueMatch = mapping;
            break;
          }
        }
        if (leagueMatch) break;
      }
    }

    // If no league found from text, try to infer from team name
    if (!leagueMatch) {
      const teamName = this.extractTeamNameFromOutright(textOriginal);
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

    // Step 2: Extract team name from the market question (using original case)
    const teamName = this.extractTeamNameFromOutright(textOriginal);

    if (!teamName) {
      this.logger.debug(
        `Could not extract team name from outright: "${market.question}"`,
      );
      return null;
    }

    // Step 3: Look up the team in our DB using fuzzy matching
    const teamResult = await this.findTeamByName(teamName);

    // Higher confidence if we resolved the league via tag slug
    const baseScore = event.polymarketTagSlug ? 0.9 : 0.8;

    return {
      event,
      market,
      marketType,
      leagueId: leagueMatch.leagueId,
      leagueName: leagueMatch.leagueName,
      teamId: teamResult?.id ?? null,
      teamName: teamResult?.name ?? teamName,
      season: leagueMatch.season,
      matchScore: teamResult ? baseScore : baseScore - 0.3,
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
    // Pattern 1: "Will X win/qualify/be relegated ..."
    const willWinMatch = text.match(
      /will\s+([A-Za-z][A-Za-z\s.'-]+?)\s+(?:win|qualify|make|reach|be\s+relegated|finish)\b/i,
    );
    if (willWinMatch) {
      return this.cleanTeamName(willWinMatch[1]);
    }

    // Pattern 2: "X to win ..."
    const toWinMatch = text.match(
      /(?:^|\?\s+)([A-Za-z][A-Za-z\s.'-]+?)\s+to\s+(?:win|qualify|make|reach)\b/i,
    );
    if (toWinMatch) {
      return this.cleanTeamName(toWinMatch[1]);
    }

    // Pattern 3: "Can X win ..."
    const canWinMatch = text.match(
      /can\s+([A-Za-z][A-Za-z\s.'-]+?)\s+(?:win|qualify|make|reach)\b/i,
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
      // Even if not in TEAM_LEAGUE_HINTS, if it's short and the event has
      // a polymarketTagSlug, it's likely a team name from a multi-outcome event
      if (trimmed.length < 30 && /^[A-Z]/.test(trimmed)) {
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

  // ─── Fixture matching ───────────────────────────────────────────────

  /**
   * Match a match_outcome market to a fixture.
   *
   * Uses multiple strategies:
   * 1. If the event has a gameStartTime, use it to narrow the fixture date window
   * 2. Extract team names from event title / market question / slug
   * 3. If event has polymarketTagSlug, narrow fixtures to that league
   * 4. Fuzzy-match team names against our fixture database
   */
  private async matchToFixture(
    event: ParsedPolymarketEvent,
    market: ParsedMarket,
  ): Promise<FixtureMarketMatch | null> {
    const textToSearch = `${event.title} ${market.question}`;
    const extractedTeams = this.extractTeamNamesFromMatchText(textToSearch);

    // For multi-outcome match events (negRisk moneylines), the team names
    // are in the individual market questions rather than the event title
    if (
      extractedTeams.length < 2 &&
      event.negRisk &&
      event.markets.length >= 3
    ) {
      // Collect team names from market questions (skip "Draw")
      for (const m of event.markets) {
        const q = m.question.trim();
        if (
          q.toLowerCase() !== 'draw' &&
          q.toLowerCase() !== 'the draw' &&
          q.length < 40
        ) {
          extractedTeams.push(this.cleanTeamName(q));
        }
      }
    }

    if (extractedTeams.length < 2) return null;

    // Time window for fixture search
    const windowDays = 7;
    const now = new Date();
    let searchFrom: Date;
    let searchTo: Date;

    // Use gameStartTime (most precise) or event startDate
    const refTime = market.gameStartTime || event.startDate;
    if (refTime) {
      const refDate = new Date(refTime);
      searchFrom = new Date(refDate.getTime() - windowDays * 86400000);
      searchTo = new Date(refDate.getTime() + windowDays * 86400000);
    } else {
      searchFrom = new Date(now.getTime() - 2 * 86400000);
      searchTo = new Date(now.getTime() + 14 * 86400000);
    }

    // Build query — optionally filter by league if we have a tag slug mapping
    let leagueFilter: number | null = null;
    if (event.polymarketTagSlug) {
      const leagueMapping = TAG_SLUG_TO_LEAGUE.get(event.polymarketTagSlug);
      if (leagueMapping) {
        leagueFilter = leagueMapping.leagueId;
      }
    }

    const conditions = [
      gte(schema.fixtures.date, searchFrom),
      lte(schema.fixtures.date, searchTo),
    ];
    if (leagueFilter) {
      conditions.push(eq(schema.fixtures.leagueId, leagueFilter));
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
      .where(and(...conditions));

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

      // Time proximity bonus
      const refTimeStr = market.gameStartTime || event.startDate;
      if (refTimeStr) {
        const eventDate = new Date(refTimeStr);
        const fixtureDate = new Date(c.date);
        const timeDiff = Math.abs(eventDate.getTime() - fixtureDate.getTime());
        const maxDiff = windowDays * 86400000;
        const timeBonus = 1 - timeDiff / maxDiff;
        bestTeamScore = bestTeamScore * 0.85 + timeBonus * 0.15;
      }

      // League match bonus
      if (leagueFilter) {
        bestTeamScore += 0.05; // Small bonus for league-filtered results
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

  /** Words that are too generic to count as meaningful matches on their own */
  private static readonly GENERIC_WORDS = new Set([
    'city',
    'united',
    'real',
    'sporting',
    'athletic',
    'atletico',
    'dynamo',
    'racing',
    'inter',
    'olympic',
    'olympique',
    'royal',
    'club',
    'sport',
    'young',
    'boys',
    'stars',
    'wanderers',
    'rovers',
    'rangers',
    'town',
    'county',
    'albion',
    'villa',
    'forest',
    'palace',
    'hotspur',
    'orient',
    'north',
    'south',
    'east',
    'west',
  ]);

  /** Common suffixes to strip from team names for matching */
  private static readonly TEAM_SUFFIXES =
    /\b(fc|sc|afc|cf|jk|sk|fk|bk|if|ssc|as|us|rc|ac|cd|ud|rcd|sd|ca|se|fbc|club|saudi club|de la unam)\b/gi;

  private teamNameSimilarity(a: string, b: string): number {
    const normA = this.normalizeTeamName(a);
    const normB = this.normalizeTeamName(b);

    if (normA === normB) return 1.0;

    // Substring match — but only if the shorter string has at least one
    // "significant" (non-generic) word. This prevents "city" from matching
    // "new york city", or "united" from matching "atlanta united".
    if (normA.includes(normB) || normB.includes(normA)) {
      const shorter = normA.length <= normB.length ? normA : normB;
      const shorterWords = shorter.split(' ').filter((w) => w.length > 1);
      const significantWords = shorterWords.filter(
        (w) => !PolymarketMatcherService.GENERIC_WORDS.has(w),
      );
      // Only allow substring match if at least one significant word exists
      // and the shorter string has at least 2 total words OR 1 significant word
      // that is specific enough (>= 4 chars and not generic)
      if (significantWords.length >= 1 && shorterWords.length >= 2) {
        return 0.85;
      }
      if (significantWords.length >= 1 && significantWords[0].length >= 4) {
        return 0.85;
      }
      // Pure generic word match (e.g., "city" alone) — very low confidence
      if (significantWords.length === 0) {
        return 0.2;
      }
    }

    // Token-based matching with significance awareness
    const wordsA = normA.split(' ').filter((w) => w.length > 1);
    const wordsB = normB.split(' ').filter((w) => w.length > 1);
    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
    const longer = wordsA.length > wordsB.length ? wordsA : wordsB;

    // Count matching tokens (including prefix matching for abbreviations)
    let matchCount = 0;
    let significantMatchCount = 0;
    for (const sw of shorter) {
      const matched = longer.some(
        (lw) => lw === sw || lw.startsWith(sw) || sw.startsWith(lw),
      );
      if (matched) {
        matchCount++;
        if (!PolymarketMatcherService.GENERIC_WORDS.has(sw)) {
          significantMatchCount++;
        }
      }
    }

    const overlapRatio = matchCount / shorter.length;

    // Require at least one significant word to match for high confidence
    if (overlapRatio >= 0.8 && significantMatchCount >= 1) return 0.75;
    if (overlapRatio >= 0.5 && significantMatchCount >= 1) return 0.55;

    // All matches are generic words — low confidence
    if (overlapRatio >= 0.8 && significantMatchCount === 0) return 0.3;

    const lev = this.levenshteinDistance(normA, normB);
    const maxLen = Math.max(normA.length, normB.length);
    return maxLen > 0 ? 1 - lev / maxLen : 0;
  }

  private normalizeTeamName(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Strip diacritics (ş→s, é→e, á→a)
      .replace(/[-.']/g, ' ') // Hyphens, dots, apostrophes → spaces
      .replace(PolymarketMatcherService.TEAM_SUFFIXES, '') // Strip common suffixes
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
