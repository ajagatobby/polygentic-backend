import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { FootballService } from '../football/football.service';
import { CollectedMatchData } from './data-collector.agent';

// ─── Types ───────────────────────────────────────────────────────────────

export interface H2HMatch {
  /** ISO date of the meeting. */
  date: string;
  competition: string | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeGoals: number | null;
  awayGoals: number | null;
  /** Readable scoreline, e.g. "PSG 2 - 0 Chelsea". */
  scoreline: string;
  /** Outcome from the perspective of the CURRENT fixture's home team. */
  result: 'home_win' | 'draw' | 'away_win' | 'unknown';
  winnerTeamId: number | null;
  winnerName: string | null;
}

export interface H2HSummary {
  meetings: number;
  homeWins: number; // wins for the CURRENT fixture's home team
  awayWins: number; // wins for the CURRENT fixture's away team
  draws: number;
  homeGoals: number;
  awayGoals: number;
  /** Avg goals per meeting for each side. */
  homeGoalsPerGame: number | null;
  awayGoalsPerGame: number | null;
  /** Plain-English dominance note. */
  summaryText: string;
  /** Current head-to-head streak (consecutive identical outcomes from the most recent meeting back). */
  streak: H2HStreak | null;
}

export interface H2HStreak {
  /** Team that currently owns the streak, or null for a run of draws. */
  teamId: number | null;
  teamName: string | null;
  type: 'win' | 'draw';
  length: number;
  description: string; // e.g. "PSG have won the last 3 meetings"
}

export interface HeadToHead {
  summary: H2HSummary;
  matches: H2HMatch[]; // most-recent first, up to 10
}

export interface RecentMatch {
  date: string;
  competition: string | null;
  venue: 'home' | 'away';
  opponentId: number | null;
  opponentName: string | null;
  goalsFor: number;
  goalsAgainst: number;
  /** Readable scoreline from this team's perspective, e.g. "PSG 3 - 1 Lyon (W)". */
  scoreline: string;
  result: 'win' | 'draw' | 'loss';
}

export interface TeamStreak {
  /** Current run of consecutive identical results, e.g. 4 wins. */
  type: 'win' | 'draw' | 'loss' | 'none';
  length: number;
  /** Unbeaten (W/D) run length. */
  unbeatenRun: number;
  /** Winless (D/L) run length. */
  winlessRun: number;
  /** "WWDLW" most-recent-LAST. */
  formString: string;
  description: string;
}

export interface TeamRecentForm {
  teamId: number;
  teamName: string | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  pointsPerGame: number | null;
  streak: TeamStreak;
  matches: RecentMatch[]; // most-recent first, up to 20
}

export interface PlayerInsight {
  playerId: number | null;
  name: string | null;
  number: number | null;
  position: string | null;
  /** "starting" | "bench" | "squad" — squad = not in the named lineup (or lineup unavailable). */
  role: 'starting' | 'bench' | 'squad';
  available: boolean;
  unavailableReason: string | null; // injury/suspension note when available === false
  age: number | null;
  nationality: string | null;
  seasonStats: {
    appearances: number | null;
    minutes: number | null;
    rating: number | null;
    goals: number | null;
    assists: number | null;
    goalsConceded: number | null;
    saves: number | null;
    yellowCards: number | null;
    redCards: number | null;
  } | null;
}

export interface TeamPlayerBreakdown {
  teamId: number;
  teamName: string | null;
  formation: string | null;
  coach: string | null;
  lineupConfirmed: boolean;
  goalkeepers: PlayerInsight[];
  defenders: PlayerInsight[];
  midfielders: PlayerInsight[];
  forwards: PlayerInsight[];
  unavailable: PlayerInsight[]; // injured / suspended
}

export interface VenueRecord {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  winPct: number | null;
  goalsForAvg: number | null;
  goalsAgainstAvg: number | null;
}

export interface GoalTimingProfile {
  /** Window (e.g. "76-90") where this team scores the largest share of its goals. */
  peakScoringWindow: string | null;
  peakScoringPct: number | null;
  /** Window where it concedes the largest share. */
  peakConcedingWindow: string | null;
  peakConcedingPct: number | null;
  /** Share of goals scored in the final 15 (76-90+) — "late surge". */
  lateGoalsForPct: number | null;
  /** Share of goals conceded in the final 15 — "vulnerable late". */
  lateGoalsAgainstPct: number | null;
  /** Share of goals scored in the opening 15 — "fast starter". */
  earlyGoalsForPct: number | null;
  tags: string[]; // e.g. "Late surge", "Slow starter", "Concedes late"
}

export interface TeamStatProfile {
  teamId: number;
  teamName: string | null;
  formString: string | null;
  overall: VenueRecord;
  home: VenueRecord;
  away: VenueRecord;
  /** Record at THIS fixture's venue for this team (home record if they're home, away if away). */
  atThisVenue: VenueRecord;
  cleanSheetPct: number | null;
  failedToScorePct: number | null;
  /** Both-teams-to-score rate proxy (share of matches where they scored AND conceded is not in the API; we expose CS% + FTS% instead). */
  over25Pct: number | null; // share of this team's matches that went over 2.5 (from under_over)
  biggestWinStreak: number | null;
  biggestLoseStreak: number | null;
  mostUsedFormation: string | null;
  formationsUsed: Array<{ formation: string; played: number }>;
  penaltyScored: number | null;
  penaltyTotal: number | null;
  goalTiming: GoalTimingProfile;
  /** One-line plain-English summary of the team's identity this season. */
  summaryText: string;
}

// ─── Tier-1 signals (Phase 2) ───────────────────────────────────────────

export interface XgPerformance {
  teamId: number;
  teamName: string | null;
  xgForPerGame: number | null;
  actualForPerGame: number | null;
  xgAgainstPerGame: number | null;
  actualAgainstPerGame: number | null;
  /** actual GF/g − xG/g. Positive = scoring more than chances merit (likely to cool). */
  attackDelta: number | null;
  /** actual GA/g − xGA/g. Negative = conceding fewer than chances merit (defence likely to regress). */
  defenceDelta: number | null;
  /** 'overperforming' (riding luck, regression down), 'underperforming' (due a bounce), or 'in_line'. */
  verdict: 'overperforming' | 'underperforming' | 'in_line' | 'unknown';
  note: string;
}

export interface StarDependency {
  teamId: number;
  teamName: string | null;
  totalGoals: number;
  topScorer: { name: string | null; goals: number; assists: number } | null;
  /** Share of team goals from the single top scorer (0..1). */
  topScorerShare: number | null;
  /** Share from the top two scorers. */
  topTwoShare: number | null;
  /** True when the top scorer is currently flagged unavailable. */
  topScorerUnavailable: boolean;
  verdict: 'heavily_reliant' | 'balanced' | 'unknown';
  note: string;
}

export interface StyleProfile {
  teamId: number;
  teamName: string | null;
  possession: number | null;
  passAccuracy: number | null;
  shotsPerGame: number | null;
  /** 'possession', 'direct', or 'balanced'. */
  style: 'possession' | 'direct' | 'balanced' | 'unknown';
  tempo: 'high' | 'medium' | 'low' | 'unknown';
  tags: string[];
}

export interface MatchSignals {
  xgPerformance: { home: XgPerformance | null; away: XgPerformance | null };
  starDependency: { home: StarDependency | null; away: StarDependency | null };
  style: { home: StyleProfile | null; away: StyleProfile | null };
  /** Plain-English read on how the two styles clash. */
  styleMatchup: string | null;
}

// ─── Market analysis (Phase 3) & context (Phase 4) are attached by
//     agents.service after the prediction + odds are available. ──────────

export interface MatchInsights {
  headToHead: HeadToHead;
  teamProfiles: {
    home: TeamStatProfile | null;
    away: TeamStatProfile | null;
  };
  signals?: MatchSignals | null;
  /** Multi-market probabilities + value + odds read (Phase 3). */
  markets?: any | null;
  /** Referee / weather / discipline / stakes context (Phase 4). */
  context?: any | null;
  recentForm: {
    home: TeamRecentForm | null;
    away: TeamRecentForm | null;
  };
  players: {
    home: TeamPlayerBreakdown | null;
    away: TeamPlayerBreakdown | null;
  };
  /** Compact human-readable digest (also injected into the analysis prompt as display-only context). */
  narrative: string;
  generatedAt: string;
}

const COMPLETED_STATUSES = ['FT', 'AET', 'PEN'];
const RECENT_FORM_LIMIT = 20;

/**
 * Builds the display-only "deep analysis" sections surfaced in every
 * prediction response: head-to-head history, last-20 recent form per team,
 * win/draw/loss streaks, and the full player-by-player roster breakdown.
 *
 * IMPORTANT: none of this feeds the probability model. Our own back-tests
 * showed H2H + streak signals hurt Brier, so these sections are purely for
 * the rich analysis the user wants to read — not for moving the numbers.
 */
@Injectable()
export class MatchInsightsService {
  private readonly logger = new Logger(MatchInsightsService.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly footballService: FootballService,
  ) {}

  async build(data: CollectedMatchData): Promise<MatchInsights> {
    const fixture = data.fixture;
    const homeTeamId: number = fixture.homeTeamId;
    const awayTeamId: number = fixture.awayTeamId;
    const homeName = data.homeTeam?.team?.name ?? `Team ${homeTeamId}`;
    const awayName = data.awayTeam?.team?.name ?? `Team ${awayTeamId}`;

    const [
      headToHead,
      homeForm,
      awayForm,
      homePlayers,
      awayPlayers,
      homeProfile,
      awayProfile,
    ] = await Promise.all([
      Promise.resolve(
        this.buildHeadToHead(data, homeTeamId, awayTeamId, homeName, awayName),
      ),
      this.buildRecentForm(homeTeamId, fixture.id, homeName),
      this.buildRecentForm(awayTeamId, fixture.id, awayName),
      this.buildPlayerBreakdown(data, homeTeamId, homeName),
      this.buildPlayerBreakdown(data, awayTeamId, awayName),
      this.buildTeamProfile(data, homeTeamId, homeName, 'home'),
      this.buildTeamProfile(data, awayTeamId, awayName, 'away'),
    ]);

    const signals = await this.buildSignals(
      data,
      homeTeamId,
      awayTeamId,
      homeName,
      awayName,
      homePlayers,
      awayPlayers,
    );

    const insights: MatchInsights = {
      headToHead,
      teamProfiles: { home: homeProfile, away: awayProfile },
      signals,
      recentForm: { home: homeForm, away: awayForm },
      players: { home: homePlayers, away: awayPlayers },
      narrative: '',
      generatedAt: new Date().toISOString(),
    };

    insights.narrative = this.buildNarrative(
      insights,
      homeName,
      awayName,
    );

    this.logger.log(
      `Insights for fixture ${fixture.id}: h2h=${headToHead.matches.length}, ` +
        `homeForm=${homeForm?.matches.length ?? 0}, awayForm=${awayForm?.matches.length ?? 0}, ` +
        `homePlayers=${this.countPlayers(homePlayers)}, awayPlayers=${this.countPlayers(awayPlayers)}`,
    );

    return insights;
  }

  // ─── Head-to-head ───────────────────────────────────────────────────────

  private buildHeadToHead(
    data: CollectedMatchData,
    homeTeamId: number,
    awayTeamId: number,
    homeName: string,
    awayName: string,
  ): HeadToHead {
    const raw = Array.isArray(data.h2h) ? data.h2h : [];

    const matches: H2HMatch[] = raw
      .map((m: any) => {
        const hg = this.toNum(m.goals?.home);
        const ag = this.toNum(m.goals?.away);
        const mHomeId = m.teams?.home?.id ?? null;
        const mAwayId = m.teams?.away?.id ?? null;
        const mHomeName = m.teams?.home?.name ?? null;
        const mAwayName = m.teams?.away?.name ?? null;

        let winnerTeamId: number | null = null;
        let winnerName: string | null = null;
        let result: H2HMatch['result'] = 'unknown';
        if (hg != null && ag != null) {
          if (hg > ag) {
            winnerTeamId = mHomeId;
            winnerName = mHomeName;
          } else if (ag > hg) {
            winnerTeamId = mAwayId;
            winnerName = mAwayName;
          }
          if (winnerTeamId == null && hg === ag) {
            result = 'draw';
          } else if (winnerTeamId === homeTeamId) {
            result = 'home_win';
          } else if (winnerTeamId === awayTeamId) {
            result = 'away_win';
          }
        }

        return {
          date: this.toIso(m.fixture?.date),
          competition: m.league?.name ?? null,
          homeTeamId: mHomeId,
          awayTeamId: mAwayId,
          homeTeamName: mHomeName,
          awayTeamName: mAwayName,
          homeGoals: hg,
          awayGoals: ag,
          scoreline: `${mHomeName ?? '?'} ${hg ?? '?'} - ${ag ?? '?'} ${mAwayName ?? '?'}`,
          result,
          winnerTeamId,
          winnerName,
        } as H2HMatch;
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 10);

    let homeWins = 0;
    let awayWins = 0;
    let draws = 0;
    let homeGoals = 0;
    let awayGoals = 0;
    for (const m of matches) {
      if (m.homeGoals == null || m.awayGoals == null) continue;
      // Map this meeting's goals back to the CURRENT fixture's home/away sides.
      const curHomeGoals =
        m.homeTeamId === homeTeamId ? m.homeGoals : m.awayGoals;
      const curAwayGoals =
        m.homeTeamId === homeTeamId ? m.awayGoals : m.homeGoals;
      homeGoals += curHomeGoals;
      awayGoals += curAwayGoals;
      if (m.result === 'home_win') homeWins++;
      else if (m.result === 'away_win') awayWins++;
      else if (m.result === 'draw') draws++;
    }

    const meetings = matches.length;
    const decided = homeWins + awayWins;
    let summaryText: string;
    if (meetings === 0) {
      summaryText = `No recent head-to-head meetings on record between ${homeName} and ${awayName}.`;
    } else if (homeWins > awayWins) {
      summaryText = `${homeName} lead the head-to-head ${homeWins}-${awayWins}-${draws} (W-L-D) over the last ${meetings} meetings.`;
    } else if (awayWins > homeWins) {
      summaryText = `${awayName} lead the head-to-head ${awayWins}-${homeWins}-${draws} (W-L-D) over the last ${meetings} meetings.`;
    } else {
      summaryText = `Honours even: ${homeName} and ${awayName} are level at ${homeWins}-${awayWins} with ${draws} draws over the last ${meetings} meetings.`;
    }

    const summary: H2HSummary = {
      meetings,
      homeWins,
      awayWins,
      draws,
      homeGoals,
      awayGoals,
      homeGoalsPerGame: meetings > 0 ? round2(homeGoals / meetings) : null,
      awayGoalsPerGame: meetings > 0 ? round2(awayGoals / meetings) : null,
      summaryText,
      streak: this.computeH2HStreak(matches, homeTeamId, awayTeamId, homeName, awayName),
    };

    void decided;
    return { summary, matches };
  }

  private computeH2HStreak(
    matches: H2HMatch[],
    homeTeamId: number,
    awayTeamId: number,
    homeName: string,
    awayName: string,
  ): H2HStreak | null {
    if (matches.length === 0) return null;
    // matches are most-recent first
    const first = matches[0];
    if (first.result === 'unknown') return null;

    if (first.result === 'draw') {
      let len = 0;
      for (const m of matches) {
        if (m.result === 'draw') len++;
        else break;
      }
      return {
        teamId: null,
        teamName: null,
        type: 'draw',
        length: len,
        description:
          len === 1
            ? `Their most recent meeting was a draw`
            : `The last ${len} meetings have been draws`,
      };
    }

    const winnerId =
      first.result === 'home_win' ? homeTeamId : awayTeamId;
    const winnerName = first.result === 'home_win' ? homeName : awayName;
    let len = 0;
    for (const m of matches) {
      if (m.winnerTeamId === winnerId) len++;
      else break;
    }
    return {
      teamId: winnerId,
      teamName: winnerName,
      type: 'win',
      length: len,
      description:
        len === 1
          ? `${winnerName} won the most recent meeting`
          : `${winnerName} have won the last ${len} meetings`,
    };
  }

  // ─── Tier-1 signals (Phase 2) ───────────────────────────────────────────

  private async buildSignals(
    data: CollectedMatchData,
    homeTeamId: number,
    awayTeamId: number,
    homeName: string,
    awayName: string,
    homePlayers: TeamPlayerBreakdown | null,
    awayPlayers: TeamPlayerBreakdown | null,
  ): Promise<MatchSignals> {
    const homeXg = this.computeXgPerformance(data, 'home', homeTeamId, homeName);
    const awayXg = this.computeXgPerformance(data, 'away', awayTeamId, awayName);
    const homeStar = this.computeStarDependency(homePlayers, homeTeamId, homeName);
    const awayStar = this.computeStarDependency(awayPlayers, awayTeamId, awayName);
    const homeStyle = this.computeStyle(data, 'home', homeTeamId, homeName);
    const awayStyle = this.computeStyle(data, 'away', awayTeamId, awayName);

    return {
      xgPerformance: { home: homeXg, away: awayXg },
      starDependency: { home: homeStar, away: awayStar },
      style: { home: homeStyle, away: awayStyle },
      styleMatchup: this.describeStyleMatchup(homeStyle, awayStyle, homeName, awayName),
    };
  }

  /** Deserved-vs-actual results: are they riding finishing/keeping luck? */
  private computeXgPerformance(
    data: CollectedMatchData,
    side: 'home' | 'away',
    teamId: number,
    teamName: string,
  ): XgPerformance | null {
    const rs = data.recentStats?.[side];
    const fw = data.formWindows?.[side]?.last10;
    if (!rs || !fw || !fw.sampleSize) return null;

    // xG of exactly 0 means "not collected for this league", not a real value —
    // treat as missing so we don't emit a bogus huge delta.
    const xgForRaw = rs.averages?.xG ?? null;
    const xgAgainstRaw = rs.averages?.xGA ?? null;
    const xgFor = xgForRaw && xgForRaw > 0 ? xgForRaw : null;
    const xgAgainst = xgAgainstRaw && xgAgainstRaw > 0 ? xgAgainstRaw : null;
    if (xgFor == null && xgAgainst == null) {
      return {
        teamId,
        teamName,
        xgForPerGame: null,
        actualForPerGame: round2(fw.goalsFor / fw.sampleSize),
        xgAgainstPerGame: null,
        actualAgainstPerGame: round2(fw.goalsAgainst / fw.sampleSize),
        attackDelta: null,
        defenceDelta: null,
        verdict: 'unknown',
        note: `${teamName}: no xG data for this league — luck signal unavailable.`,
      };
    }
    const actualFor = fw.goalsFor / fw.sampleSize;
    const actualAgainst = fw.goalsAgainst / fw.sampleSize;

    const attackDelta =
      xgFor != null ? round2(actualFor - xgFor) : null;
    const defenceDelta =
      xgAgainst != null ? round2(actualAgainst - xgAgainst) : null;

    let verdict: XgPerformance['verdict'] = 'unknown';
    const notes: string[] = [];
    if (attackDelta != null) {
      if (attackDelta >= 0.3) {
        verdict = 'overperforming';
        notes.push(
          `scoring ${attackDelta.toFixed(2)} more goals/game than xG — finishing is hot and likely to cool`,
        );
      } else if (attackDelta <= -0.3) {
        verdict = 'underperforming';
        notes.push(
          `scoring ${Math.abs(attackDelta).toFixed(2)} fewer than xG/game — attack is due a positive bounce`,
        );
      } else {
        notes.push('attack output roughly matches xG');
      }
    }
    if (defenceDelta != null) {
      if (defenceDelta <= -0.3)
        notes.push(
          `conceding ${Math.abs(defenceDelta).toFixed(2)} fewer than xGA/game — defence/keeper overperforming, regression risk`,
        );
      else if (defenceDelta >= 0.3)
        notes.push(
          `conceding ${defenceDelta.toFixed(2)} more than xGA/game — unlucky at the back, may tighten`,
        );
    }
    if (verdict === 'unknown' && attackDelta != null) verdict = 'in_line';

    return {
      teamId,
      teamName,
      xgForPerGame: xgFor != null ? round2(xgFor) : null,
      actualForPerGame: round2(actualFor),
      xgAgainstPerGame: xgAgainst != null ? round2(xgAgainst) : null,
      actualAgainstPerGame: round2(actualAgainst),
      attackDelta,
      defenceDelta,
      verdict,
      note: `${teamName}: ${notes.join('; ') || 'insufficient signal'}.`,
    };
  }

  /** How concentrated is the team's goal output on one or two players? */
  private computeStarDependency(
    pb: TeamPlayerBreakdown | null,
    teamId: number,
    teamName: string,
  ): StarDependency | null {
    if (!pb) return null;
    const all = [
      ...pb.goalkeepers,
      ...pb.defenders,
      ...pb.midfielders,
      ...pb.forwards,
      ...pb.unavailable,
    ];
    const scorers = all
      .map((p) => ({
        name: p.name,
        goals: p.seasonStats?.goals ?? 0,
        assists: p.seasonStats?.assists ?? 0,
        available: p.available,
      }))
      .filter((p) => p.goals > 0)
      .sort((a, b) => b.goals - a.goals);

    const totalGoals = scorers.reduce((s, p) => s + p.goals, 0);
    if (totalGoals === 0) {
      return {
        teamId,
        teamName,
        totalGoals: 0,
        topScorer: null,
        topScorerShare: null,
        topTwoShare: null,
        topScorerUnavailable: false,
        verdict: 'unknown',
        note: `${teamName}: no scorer data available.`,
      };
    }

    const top = scorers[0];
    const topShare = round2(top.goals / totalGoals);
    const topTwoShare =
      scorers.length > 1
        ? round2((top.goals + scorers[1].goals) / totalGoals)
        : topShare;
    const verdict: StarDependency['verdict'] =
      topShare >= 0.35 ? 'heavily_reliant' : 'balanced';

    const notes: string[] = [];
    notes.push(
      `${top.name} has ${top.goals} of ${totalGoals} goals (${Math.round(topShare * 100)}%)`,
    );
    if (verdict === 'heavily_reliant')
      notes.push('heavy single-player reliance — fragile if marked out or absent');
    if (!top.available)
      notes.push(`⚠ top scorer ${top.name} is UNAVAILABLE for this match`);

    return {
      teamId,
      teamName,
      totalGoals,
      topScorer: { name: top.name, goals: top.goals, assists: top.assists },
      topScorerShare: topShare,
      topTwoShare,
      topScorerUnavailable: !top.available,
      verdict,
      note: `${teamName}: ${notes.join('; ')}.`,
    };
  }

  /** Approximate playing style from possession / passing / shot volume. */
  private computeStyle(
    data: CollectedMatchData,
    side: 'home' | 'away',
    teamId: number,
    teamName: string,
  ): StyleProfile | null {
    const a = data.recentStats?.[side]?.averages;
    if (!a) return null;
    // 0 means the stat wasn't collected for this league — treat as missing.
    const possession = a.possession && a.possession > 0 ? a.possession : null;
    const passAccuracy = a.passAccuracy && a.passAccuracy > 0 ? a.passAccuracy : null;
    const shots = a.totalShots && a.totalShots > 0 ? a.totalShots : null;
    if (possession == null && shots == null) return null;

    let style: StyleProfile['style'] = 'unknown';
    if (possession != null) {
      if (possession >= 55 && (passAccuracy == null || passAccuracy >= 80))
        style = 'possession';
      else if (possession <= 45) style = 'direct';
      else style = 'balanced';
    }
    let tempo: StyleProfile['tempo'] = 'unknown';
    if (shots != null) tempo = shots >= 15 ? 'high' : shots >= 10 ? 'medium' : 'low';

    const tags: string[] = [];
    if (style === 'possession') tags.push('Possession-based, builds through the ball');
    if (style === 'direct') tags.push('Direct / transition-heavy, cedes the ball');
    if (tempo === 'high') tags.push('High shot volume');
    if (tempo === 'low') tags.push('Low-volume, cagey');

    return {
      teamId,
      teamName,
      possession: possession != null ? round2(possession) : null,
      passAccuracy: passAccuracy != null ? round2(passAccuracy) : null,
      shotsPerGame: shots != null ? round2(shots) : null,
      style,
      tempo,
      tags,
    };
  }

  private describeStyleMatchup(
    home: StyleProfile | null,
    away: StyleProfile | null,
    homeName: string,
    awayName: string,
  ): string | null {
    if (!home || !away || home.style === 'unknown' || away.style === 'unknown')
      return null;
    if (home.style === 'possession' && away.style === 'direct')
      return `${homeName} will dominate the ball; ${awayName} will sit deeper and look to hit on the transition — a possession-vs-counter clash. Watch for ${awayName}'s pace in behind.`;
    if (home.style === 'direct' && away.style === 'possession')
      return `${awayName} will see more of the ball; ${homeName} will cede possession and counter. Territory won't reflect chances.`;
    if (home.style === 'possession' && away.style === 'possession')
      return `Both sides want the ball — midfield control and the press will decide who dictates.`;
    if (home.style === 'direct' && away.style === 'direct')
      return `Two transition teams — expect an open, end-to-end game with chances both ways.`;
    return `${homeName} (${home.style}) vs ${awayName} (${away.style}).`;
  }

  // ─── Team season profile (/teams/statistics) ───────────────────────────

  private async buildTeamProfile(
    data: CollectedMatchData,
    teamId: number,
    teamName: string,
    side: 'home' | 'away',
  ): Promise<TeamStatProfile | null> {
    try {
      const leagueId: number | null = data.fixture?.leagueId ?? null;
      const season: number =
        data.fixture?.season ?? new Date().getFullYear();
      if (leagueId == null) return null;

      const s = await this.footballService.getTeamSeasonStatistics(
        teamId,
        leagueId,
        season,
      );
      if (!s) return null;

      const rec = (
        played: any,
        wins: any,
        draws: any,
        losses: any,
        gfAvg: any,
        gaAvg: any,
      ): VenueRecord => {
        const p = Number(played) || 0;
        const w = Number(wins) || 0;
        return {
          played: p,
          wins: w,
          draws: Number(draws) || 0,
          losses: Number(losses) || 0,
          winPct: p > 0 ? round2((w / p) * 100) : null,
          goalsForAvg: gfAvg != null ? Number(gfAvg) : null,
          goalsAgainstAvg: gaAvg != null ? Number(gaAvg) : null,
        };
      };

      const overall = rec(
        s.playedTotal,
        s.winsTotal,
        s.drawsTotal,
        s.lossesTotal,
        s.goalsForAvgTotal,
        s.goalsAgainstAvgTotal,
      );
      const home = rec(
        s.playedHome,
        s.winsHome,
        s.drawsHome,
        s.lossesHome,
        s.goalsForAvgHome,
        s.goalsAgainstAvgHome,
      );
      const away = rec(
        s.playedAway,
        s.winsAway,
        s.drawsAway,
        s.lossesAway,
        s.goalsForAvgAway,
        s.goalsAgainstAvgAway,
      );
      const atThisVenue = side === 'home' ? home : away;

      const cleanSheetPct =
        overall.played > 0
          ? round2(((Number(s.cleanSheetTotal) || 0) / overall.played) * 100)
          : null;
      const failedToScorePct =
        overall.played > 0
          ? round2(
              ((Number(s.failedToScoreTotal) || 0) / overall.played) * 100,
            )
          : null;

      const over25Pct = this.over25FromUnderOver(
        s.goalsForUnderOver,
        s.goalsAgainstUnderOver,
        overall.played,
      );

      const formations: Array<{ formation: string; played: number }> =
        Array.isArray(s.lineupsUsed)
          ? s.lineupsUsed
              .map((l: any) => ({
                formation: l.formation,
                played: Number(l.played) || 0,
              }))
              .sort((a, b) => b.played - a.played)
          : [];

      const goalTiming = this.deriveGoalTiming(
        s.goalsForByMinute,
        s.goalsAgainstByMinute,
      );

      const summaryText = this.teamProfileSummary(
        teamName,
        side,
        atThisVenue,
        overall,
        cleanSheetPct,
        failedToScorePct,
        goalTiming,
      );

      return {
        teamId,
        teamName,
        formString: s.formString ?? null,
        overall,
        home,
        away,
        atThisVenue,
        cleanSheetPct,
        failedToScorePct,
        over25Pct,
        biggestWinStreak: s.streakWins ?? null,
        biggestLoseStreak: s.streakLoses ?? null,
        mostUsedFormation: formations[0]?.formation ?? null,
        formationsUsed: formations,
        penaltyScored: s.penaltyScored ?? null,
        penaltyTotal: s.penaltyTotal ?? null,
        goalTiming,
        summaryText,
      };
    } catch (error: any) {
      this.logger.warn(
        `Team profile build failed for team ${teamId}: ${error.message}`,
      );
      return null;
    }
  }

  /** Parse "x%" or numbers to a number, else null. */
  private pct(v: any): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(String(v).replace('%', '').trim());
    return Number.isNaN(n) ? null : n;
  }

  private deriveGoalTiming(
    forByMinute: any,
    againstByMinute: any,
  ): GoalTimingProfile {
    const windows = [
      '0-15',
      '16-30',
      '31-45',
      '46-60',
      '61-75',
      '76-90',
      '91-105',
      '106-120',
    ];
    const pctOf = (blob: any, key: string): number | null =>
      this.pct(blob?.[key]?.percentage);

    let peakScoringWindow: string | null = null;
    let peakScoringPct: number | null = null;
    let peakConcedingWindow: string | null = null;
    let peakConcedingPct: number | null = null;
    for (const w of windows) {
      const sp = pctOf(forByMinute, w);
      if (sp != null && (peakScoringPct == null || sp > peakScoringPct)) {
        peakScoringPct = sp;
        peakScoringWindow = w;
      }
      const cp = pctOf(againstByMinute, w);
      if (cp != null && (peakConcedingPct == null || cp > peakConcedingPct)) {
        peakConcedingPct = cp;
        peakConcedingWindow = w;
      }
    }

    const sumWindows = (blob: any, keys: string[]): number | null => {
      const vals = keys.map((k) => pctOf(blob, k)).filter((v) => v != null);
      if (!vals.length) return null;
      return round2(vals.reduce((a, b) => a + (b as number), 0));
    };

    const lateGoalsForPct = sumWindows(forByMinute, ['76-90', '91-105']);
    const lateGoalsAgainstPct = sumWindows(againstByMinute, ['76-90', '91-105']);
    const earlyGoalsForPct = pctOf(forByMinute, '0-15');

    const tags: string[] = [];
    if (lateGoalsForPct != null && lateGoalsForPct >= 30)
      tags.push('Late surge (scores heavily after 75′)');
    if (earlyGoalsForPct != null && earlyGoalsForPct >= 20)
      tags.push('Fast starter');
    else if (earlyGoalsForPct != null && earlyGoalsForPct <= 8)
      tags.push('Slow starter');
    if (lateGoalsAgainstPct != null && lateGoalsAgainstPct >= 30)
      tags.push('Vulnerable late (concedes after 75′)');

    return {
      peakScoringWindow,
      peakScoringPct,
      peakConcedingWindow,
      peakConcedingPct,
      lateGoalsForPct,
      lateGoalsAgainstPct,
      earlyGoalsForPct,
      tags,
    };
  }

  /**
   * Share of this team's matches that went over 2.5 goals. The API's
   * under_over blob is keyed by line ("0.5".."3.5"), each with {over, under}
   * counts for that team's matches. We use the 2.5 line's `over` count.
   */
  private over25FromUnderOver(
    forUO: any,
    againstUO: any,
    played: number,
  ): number | null {
    const line = forUO?.['2.5'] ?? againstUO?.['2.5'];
    const over = Number(line?.over);
    if (!Number.isFinite(over) || played <= 0) return null;
    return round2((over / played) * 100);
  }

  private teamProfileSummary(
    teamName: string,
    side: 'home' | 'away',
    venueRec: VenueRecord,
    overall: VenueRecord,
    cleanSheetPct: number | null,
    failedToScorePct: number | null,
    timing: GoalTimingProfile,
  ): string {
    const parts: string[] = [];
    const venueLabel = side === 'home' ? 'at home' : 'on the road';
    if (venueRec.played > 0) {
      parts.push(
        `${teamName} ${venueLabel}: ${venueRec.wins}W-${venueRec.draws}D-${venueRec.losses}L` +
          `${venueRec.winPct != null ? ` (${venueRec.winPct}% win rate)` : ''}, ` +
          `${venueRec.goalsForAvg ?? '?'} scored / ${venueRec.goalsAgainstAvg ?? '?'} conceded per game`,
      );
    }
    if (cleanSheetPct != null)
      parts.push(`clean sheet in ${cleanSheetPct}% of matches`);
    if (failedToScorePct != null)
      parts.push(`blanked in ${failedToScorePct}%`);
    if (timing.tags.length) parts.push(timing.tags.join('; '));
    return parts.join('. ') + '.';
  }

  // ─── Recent form (last 20) ──────────────────────────────────────────────

  private async buildRecentForm(
    teamId: number,
    currentFixtureId: number,
    teamName: string,
  ): Promise<TeamRecentForm | null> {
    try {
      const fixtures = await this.db
        .select()
        .from(schema.fixtures)
        .where(
          and(
            inArray(schema.fixtures.status, COMPLETED_STATUSES),
            sql`${schema.fixtures.id} != ${currentFixtureId}`,
            sql`(${schema.fixtures.homeTeamId} = ${teamId} OR ${schema.fixtures.awayTeamId} = ${teamId})`,
          ),
        )
        .orderBy(desc(schema.fixtures.date))
        .limit(RECENT_FORM_LIMIT);

      if (!fixtures.length) {
        return {
          teamId,
          teamName,
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          points: 0,
          pointsPerGame: null,
          streak: {
            type: 'none',
            length: 0,
            unbeatenRun: 0,
            winlessRun: 0,
            formString: '',
            description: 'No recent matches on record.',
          },
          matches: [],
        };
      }

      const opponentIds = new Set<number>();
      for (const f of fixtures) {
        opponentIds.add(f.homeTeamId === teamId ? f.awayTeamId : f.homeTeamId);
      }
      const teamRows = await this.db
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teams)
        .where(inArray(schema.teams.id, [...opponentIds]));
      const nameById = new Map<number, string>();
      for (const t of teamRows) nameById.set(t.id, t.name);

      let wins = 0;
      let draws = 0;
      let losses = 0;
      let goalsFor = 0;
      let goalsAgainst = 0;

      const matches: RecentMatch[] = fixtures.map((f: any) => {
        const isHome = f.homeTeamId === teamId;
        const opponentId = isHome ? f.awayTeamId : f.homeTeamId;
        const gf = Number(isHome ? f.goalsHome : f.goalsAway) || 0;
        const ga = Number(isHome ? f.goalsAway : f.goalsHome) || 0;
        let result: RecentMatch['result'] = 'draw';
        if (gf > ga) result = 'win';
        else if (gf < ga) result = 'loss';

        if (result === 'win') wins++;
        else if (result === 'draw') draws++;
        else losses++;
        goalsFor += gf;
        goalsAgainst += ga;

        const opponentName = nameById.get(opponentId) ?? null;
        const tag = result === 'win' ? 'W' : result === 'draw' ? 'D' : 'L';
        const scoreline = isHome
          ? `${teamName} ${gf} - ${ga} ${opponentName ?? '?'} (${tag})`
          : `${opponentName ?? '?'} ${ga} - ${gf} ${teamName} (${tag})`;

        return {
          date: this.toIso(f.date),
          competition: f.leagueName ?? null,
          venue: isHome ? 'home' : 'away',
          opponentId,
          opponentName,
          goalsFor: gf,
          goalsAgainst: ga,
          scoreline,
          result,
        };
      });

      const played = matches.length;
      const points = wins * 3 + draws;

      return {
        teamId,
        teamName,
        played,
        wins,
        draws,
        losses,
        goalsFor,
        goalsAgainst,
        points,
        pointsPerGame: played > 0 ? round2(points / played) : null,
        streak: this.computeTeamStreak(matches),
        matches,
      };
    } catch (error: any) {
      this.logger.warn(
        `Recent form build failed for team ${teamId}: ${error.message}`,
      );
      return null;
    }
  }

  private computeTeamStreak(matches: RecentMatch[]): TeamStreak {
    // matches are most-recent first; formString shows most-recent LAST.
    const formString = matches
      .slice(0, 10)
      .map((m) => (m.result === 'win' ? 'W' : m.result === 'draw' ? 'D' : 'L'))
      .reverse()
      .join('');

    if (matches.length === 0) {
      return {
        type: 'none',
        length: 0,
        unbeatenRun: 0,
        winlessRun: 0,
        formString: '',
        description: 'No recent matches.',
      };
    }

    const latest = matches[0].result;
    let length = 0;
    for (const m of matches) {
      if (m.result === latest) length++;
      else break;
    }

    let unbeatenRun = 0;
    for (const m of matches) {
      if (m.result === 'win' || m.result === 'draw') unbeatenRun++;
      else break;
    }
    let winlessRun = 0;
    for (const m of matches) {
      if (m.result === 'draw' || m.result === 'loss') winlessRun++;
      else break;
    }

    const word =
      latest === 'win' ? 'winning' : latest === 'loss' ? 'losing' : 'drawing';
    let description: string;
    if (length >= 2) {
      description = `On a ${length}-game ${word} streak`;
    } else if (unbeatenRun >= 4) {
      description = `Unbeaten in ${unbeatenRun}`;
    } else if (winlessRun >= 4) {
      description = `Winless in ${winlessRun}`;
    } else {
      const r =
        latest === 'win' ? 'a win' : latest === 'loss' ? 'a loss' : 'a draw';
      description = `Coming off ${r}`;
    }

    return {
      type: latest,
      length,
      unbeatenRun,
      winlessRun,
      formString,
      description,
    };
  }

  // ─── Player-by-player breakdown ─────────────────────────────────────────

  private async buildPlayerBreakdown(
    data: CollectedMatchData,
    teamId: number,
    teamName: string,
  ): Promise<TeamPlayerBreakdown | null> {
    try {
      const season: number = data.fixture?.season ?? new Date().getFullYear();
      const leagueId: number | undefined = data.fixture?.leagueId ?? undefined;

      const squad = await this.footballService.getSquadWithSeasonStats(
        teamId,
        season,
        leagueId,
      );
      const statsByPlayer = new Map<number, any>();
      for (const s of squad) statsByPlayer.set(s.playerId, s);

      // Confirmed-unavailable players for this team.
      const unavailableById = new Map<number, string>();
      const unavailableByName = new Map<string, string>();
      for (const inj of data.injuries ?? []) {
        if (inj.teamId !== teamId) continue;
        const reason = [inj.type, inj.reason].filter(Boolean).join(' — ') || 'Unavailable';
        if (inj.playerId) unavailableById.set(inj.playerId, reason);
        if (inj.playerName)
          unavailableByName.set(String(inj.playerName).toLowerCase(), reason);
      }

      const lineup = (data.lineups ?? []).find(
        (l: any) => l.team?.id === teamId,
      );
      const lineupConfirmed = !!lineup && (lineup.startXI?.length ?? 0) > 0;

      const breakdown: TeamPlayerBreakdown = {
        teamId,
        teamName,
        formation: lineup?.formation ?? null,
        coach: lineup?.coach?.name ?? null,
        lineupConfirmed,
        goalkeepers: [],
        defenders: [],
        midfielders: [],
        forwards: [],
        unavailable: [],
      };

      const seen = new Set<number>();

      const makeInsight = (
        p: { id: number | null; name: string | null; number: number | null; pos: string | null },
        role: PlayerInsight['role'],
      ): PlayerInsight => {
        const stat = p.id != null ? statsByPlayer.get(p.id) : null;
        const reason =
          (p.id != null && unavailableById.get(p.id)) ||
          (p.name && unavailableByName.get(p.name.toLowerCase())) ||
          null;
        const position = p.pos ?? stat?.position ?? null;
        return {
          playerId: p.id,
          name: p.name ?? stat?.name ?? null,
          number: p.number ?? null,
          position,
          role,
          available: !reason,
          unavailableReason: reason || null,
          age: stat?.age ?? null,
          nationality: stat?.nationality ?? null,
          seasonStats: stat
            ? {
                appearances: stat.appearances ?? null,
                minutes: stat.minutes ?? null,
                rating: stat.rating != null ? Number(stat.rating) : null,
                goals: stat.goals ?? null,
                assists: stat.assists ?? null,
                goalsConceded: stat.goalsConceded ?? null,
                saves: stat.saves ?? null,
                yellowCards: stat.yellowCards ?? null,
                redCards: stat.redCards ?? null,
              }
            : null,
        };
      };

      const place = (insight: PlayerInsight) => {
        if (insight.playerId != null) {
          if (seen.has(insight.playerId)) return;
          seen.add(insight.playerId);
        }
        if (!insight.available) {
          breakdown.unavailable.push(insight);
          return;
        }
        const group = this.positionGroup(insight.position);
        breakdown[group].push(insight);
      };

      if (lineupConfirmed) {
        for (const x of lineup.startXI ?? []) {
          place(makeInsight(this.fromLineupPlayer(x), 'starting'));
        }
        for (const x of lineup.substitutes ?? []) {
          place(makeInsight(this.fromLineupPlayer(x), 'bench'));
        }
      }

      // Fold in the rest of the squad (anyone not already placed), sorted by
      // appearances so the most-used players surface first. Without a named
      // lineup this IS the roster; with one it adds the wider squad context.
      const squadSorted = [...squad].sort(
        (a, b) => (b.appearances ?? 0) - (a.appearances ?? 0),
      );
      for (const s of squadSorted) {
        if (s.playerId != null && seen.has(s.playerId)) continue;
        place(
          makeInsight(
            {
              id: s.playerId,
              name: s.name,
              number: null,
              pos: s.position,
            },
            'squad',
          ),
        );
      }

      // Any unavailable player from injuries not already captured (e.g. not in
      // squad pull) — still surface them so the absence is visible.
      for (const [pid, reason] of unavailableById) {
        if (seen.has(pid)) continue;
        const stat = statsByPlayer.get(pid);
        breakdown.unavailable.push({
          playerId: pid,
          name: stat?.name ?? null,
          number: null,
          position: stat?.position ?? null,
          role: 'squad',
          available: false,
          unavailableReason: reason,
          age: stat?.age ?? null,
          nationality: stat?.nationality ?? null,
          seasonStats: null,
        });
        seen.add(pid);
      }

      return breakdown;
    } catch (error: any) {
      this.logger.warn(
        `Player breakdown failed for team ${teamId}: ${error.message}`,
      );
      return null;
    }
  }

  private fromLineupPlayer(x: any): {
    id: number | null;
    name: string | null;
    number: number | null;
    pos: string | null;
  } {
    const p = x?.player ?? x;
    return {
      id: p?.id ?? null,
      name: p?.name ?? null,
      number: p?.number ?? null,
      pos: p?.pos ?? null,
    };
  }

  private positionGroup(
    pos: string | null,
  ): 'goalkeepers' | 'defenders' | 'midfielders' | 'forwards' {
    const p = String(pos ?? '').toUpperCase();
    if (p === 'G' || p.startsWith('GOAL')) return 'goalkeepers';
    if (p === 'D' || p.startsWith('DEF')) return 'defenders';
    if (p === 'M' || p.startsWith('MID')) return 'midfielders';
    if (p === 'F' || p.startsWith('ATT') || p.startsWith('FOR'))
      return 'forwards';
    // Unknown position — default to midfield bucket so it's still surfaced.
    return 'midfielders';
  }

  private countPlayers(b: TeamPlayerBreakdown | null): number {
    if (!b) return 0;
    return (
      b.goalkeepers.length +
      b.defenders.length +
      b.midfielders.length +
      b.forwards.length +
      b.unavailable.length
    );
  }

  // ─── Narrative digest ───────────────────────────────────────────────────

  private buildNarrative(
    insights: MatchInsights,
    homeName: string,
    awayName: string,
  ): string {
    const lines: string[] = [];

    // Team season profiles
    for (const [label, prof] of [
      [homeName, insights.teamProfiles.home],
      [awayName, insights.teamProfiles.away],
    ] as const) {
      if (!prof) continue;
      lines.push(`SEASON PROFILE — ${prof.summaryText}`);
      const t = prof.goalTiming;
      if (t.peakScoringWindow || t.peakConcedingWindow) {
        lines.push(
          `  Goal timing: scores most in ${t.peakScoringWindow ?? '?'} (${t.peakScoringPct ?? '?'}%), ` +
            `concedes most in ${t.peakConcedingWindow ?? '?'} (${t.peakConcedingPct ?? '?'}%).`,
        );
      }
      if (prof.mostUsedFormation)
        lines.push(
          `  Usual shape: ${prof.mostUsedFormation}` +
            `${prof.over25Pct != null ? `; ${prof.over25Pct}% of matches over 2.5 goals` : ''}.`,
        );
    }

    // Tier-1 signals
    const sig = insights.signals;
    if (sig) {
      const sl: string[] = [];
      for (const x of [sig.xgPerformance.home, sig.xgPerformance.away]) {
        if (x && x.verdict !== 'unknown') sl.push(`  xG: ${x.note}`);
      }
      for (const s of [sig.starDependency.home, sig.starDependency.away]) {
        if (s && s.verdict !== 'unknown') sl.push(`  Key man: ${s.note}`);
      }
      if (sig.styleMatchup) sl.push(`  Style: ${sig.styleMatchup}`);
      if (sl.length) lines.push(`\nSIGNALS\n${sl.join('\n')}`);
    }

    // H2H
    const h2h = insights.headToHead;
    lines.push(`\nHEAD-TO-HEAD: ${h2h.summary.summaryText}`);
    if (h2h.summary.streak) {
      lines.push(`  Streak: ${h2h.summary.streak.description}.`);
    }
    for (const m of h2h.matches.slice(0, 10)) {
      const date = m.date ? m.date.split('T')[0] : '?';
      lines.push(`  • ${date}: ${m.scoreline}`);
    }

    // Recent form
    for (const [label, form] of [
      [homeName, insights.recentForm.home],
      [awayName, insights.recentForm.away],
    ] as const) {
      if (!form) continue;
      lines.push(
        `\n${label.toUpperCase()} — last ${form.played}: ${form.wins}W-${form.draws}D-${form.losses}L, ` +
          `${form.goalsFor}-${form.goalsAgainst} GF-GA, ${form.streak.formString} (${form.streak.description}).`,
      );
      for (const m of form.matches.slice(0, 20)) {
        const date = m.date ? m.date.split('T')[0] : '?';
        lines.push(`  • ${date}: ${m.scoreline}`);
      }
    }

    // Player availability headline
    for (const [label, pb] of [
      [homeName, insights.players.home],
      [awayName, insights.players.away],
    ] as const) {
      if (!pb) continue;
      const out = pb.unavailable
        .map((p) => p.name)
        .filter(Boolean)
        .slice(0, 8);
      lines.push(
        `\n${label.toUpperCase()} squad: formation ${pb.formation ?? 'TBC'}` +
          `${pb.lineupConfirmed ? ' (XI confirmed)' : ' (XI not yet confirmed)'}` +
          `${out.length ? `; unavailable: ${out.join(', ')}` : '; no confirmed absences'}.`,
      );
    }

    return lines.join('\n');
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private toNum(v: any): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  private toIso(v: any): string {
    try {
      return new Date(v).toISOString();
    } catch {
      return '';
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
