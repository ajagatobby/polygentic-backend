import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '../database/schema';

/**
 * Quantified player impact for an injured/absent player.
 */
export interface PlayerImpact {
  playerId: number;
  playerName: string;
  teamId: number;
  /** Position: 'G' | 'D' | 'M' | 'F' | 'unknown' */
  position: string;
  /** Injury type from API-Football: "Missing Fixture", "Questionable", etc. */
  absenceType: string | null;
  /** Reason: "Knee Injury", "Suspended", etc. */
  reason: string | null;
  /**
   * Probability the player will be absent (0-1).
   * "Missing Fixture" / "Suspended" → 1.0
   * "Doubtful" → 0.75
   * "Questionable" → 0.50
   */
  absenceProbability: number;
  /**
   * Impact score (0-1) measuring how much this absence hurts the team.
   * Based on:
   * - Goal involvement rate (goals + assists / team goals)
   * - Appearances (regular starter vs squad player)
   * - Position criticality (GK > FW > MF > DF for offensive impact)
   */
  impactScore: number;
  /** Goals scored in the analysis window */
  goals: number;
  /** Assists in the analysis window */
  assists: number;
  /** Total appearances in the analysis window */
  appearances: number;
  /** Team's total matches in the analysis window */
  teamMatches: number;
  /** Whether this player started in the majority of recent matches */
  isRegularStarter: boolean;
  /** Human-readable impact label */
  impactLabel: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'MINIMAL';
}

/**
 * Aggregated impact for a team's total absences.
 */
export interface TeamAbsenceImpact {
  teamId: number;
  totalAbsences: number;
  /** Combined offensive impact (reduction in attacking capability) */
  offensiveImpact: number;
  /** Combined defensive impact (reduction in defensive capability) */
  defensiveImpact: number;
  /** xG adjustment factor: multiply team's expected xG by this (e.g. 0.92 = -8%) */
  xgMultiplier: number;
  /** xGA adjustment factor: multiply team's expected xGA by this (e.g. 1.05 = +5% more goals conceded) */
  xgaMultiplier: number;
  /** List of individual player impacts */
  players: PlayerImpact[];
}

@Injectable()
export class PlayerImpactService {
  private readonly logger = new Logger(PlayerImpactService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  /**
   * Compute player impact scores for all injured/absent players for a fixture.
   *
   * Uses fixture_events (goals, assists) and fixture_lineups (starter detection)
   * from the team's last N league matches to quantify each absent player's importance.
   */
  async computeImpactScores(
    injuries: any[],
    homeTeamId: number,
    awayTeamId: number,
    leagueId: number,
    fixtureId: number,
  ): Promise<{
    home: TeamAbsenceImpact;
    away: TeamAbsenceImpact;
  }> {
    const homeInjuries = injuries.filter(
      (inj: any) => inj.teamId === homeTeamId,
    );
    const awayInjuries = injuries.filter(
      (inj: any) => inj.teamId === awayTeamId,
    );

    const [homeImpact, awayImpact] = await Promise.all([
      this.computeTeamAbsenceImpact(
        homeInjuries,
        homeTeamId,
        leagueId,
        fixtureId,
      ),
      this.computeTeamAbsenceImpact(
        awayInjuries,
        awayTeamId,
        leagueId,
        fixtureId,
      ),
    ]);

    return { home: homeImpact, away: awayImpact };
  }

  private async computeTeamAbsenceImpact(
    injuries: any[],
    teamId: number,
    leagueId: number,
    currentFixtureId: number,
  ): Promise<TeamAbsenceImpact> {
    if (injuries.length === 0) {
      return {
        teamId,
        totalAbsences: 0,
        offensiveImpact: 0,
        defensiveImpact: 0,
        xgMultiplier: 1.0,
        xgaMultiplier: 1.0,
        players: [],
      };
    }

    // Get recent league fixtures for this team (last 15 matches)
    const recentFixtures = await this.db
      .select({ fixture: schema.fixtures })
      .from(schema.fixtures)
      .where(
        and(
          sql`(${schema.fixtures.homeTeamId} = ${teamId} OR ${schema.fixtures.awayTeamId} = ${teamId})`,
          eq(schema.fixtures.status, 'FT'),
          eq(schema.fixtures.leagueId, leagueId),
          sql`${schema.fixtures.id} != ${currentFixtureId}`,
        ),
      )
      .orderBy(desc(schema.fixtures.date))
      .limit(15);

    const teamMatchCount = recentFixtures.length;
    if (teamMatchCount === 0) {
      // No historical data — return minimal impact with basic position-based estimates
      return {
        teamId,
        totalAbsences: injuries.length,
        offensiveImpact: 0,
        defensiveImpact: 0,
        xgMultiplier: 1.0,
        xgaMultiplier: 1.0,
        players: injuries.map((inj: any) => this.fallbackPlayerImpact(inj)),
      };
    }

    const fixtureIds = recentFixtures.map((r: any) => r.fixture.id);

    // Get all goal events for the team in these fixtures
    const goalEvents = await this.db
      .select()
      .from(schema.fixtureEvents)
      .where(
        and(
          sql`${schema.fixtureEvents.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
          eq(schema.fixtureEvents.teamId, teamId),
          eq(schema.fixtureEvents.type, 'Goal'),
        ),
      );

    // Get all lineups for the team in these fixtures
    const lineups = await this.db
      .select()
      .from(schema.fixtureLineups)
      .where(
        and(
          sql`${schema.fixtureLineups.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
          eq(schema.fixtureLineups.teamId, teamId),
        ),
      );

    // Count total team goals
    const totalTeamGoals = goalEvents.filter(
      (e: any) => e.detail !== 'Own Goal',
    ).length;

    // Build player goal/assist maps
    const playerGoals = new Map<number, number>();
    const playerAssists = new Map<number, number>();

    for (const event of goalEvents) {
      if (event.detail === 'Own Goal') continue;

      if (event.playerId) {
        playerGoals.set(
          event.playerId,
          (playerGoals.get(event.playerId) || 0) + 1,
        );
      }
      if (event.assistId) {
        playerAssists.set(
          event.assistId,
          (playerAssists.get(event.assistId) || 0) + 1,
        );
      }
    }

    // Build player appearance + position maps from lineups
    const playerAppearances = new Map<number, number>();
    const playerPositions = new Map<number, string>();

    for (const lineup of lineups) {
      const startXI = (lineup.startXI as any[]) ?? [];
      for (const player of startXI) {
        const pid = player.id;
        if (pid) {
          playerAppearances.set(pid, (playerAppearances.get(pid) || 0) + 1);
          if (player.pos && !playerPositions.has(pid)) {
            playerPositions.set(pid, player.pos);
          }
        }
      }
    }

    // Compute individual impact scores
    const playerImpacts: PlayerImpact[] = [];

    for (const injury of injuries) {
      const pid = injury.playerId;
      const goals = playerGoals.get(pid) || 0;
      const assists = playerAssists.get(pid) || 0;
      const appearances = playerAppearances.get(pid) || 0;
      const position = playerPositions.get(pid) || 'unknown';
      const isRegularStarter = appearances >= teamMatchCount * 0.6;

      // Goal involvement rate: what fraction of team goals did this player contribute to?
      const goalInvolvement =
        totalTeamGoals > 0 ? (goals + assists) / totalTeamGoals : 0;

      // Starter factor: regulars are harder to replace
      const starterFactor = isRegularStarter ? 1.0 : 0.5;

      // Position criticality weight (for offensive impact)
      const positionWeight = this.getPositionWeight(position);

      // Compute impact score (0-1)
      // Formula: (goal_involvement * 0.5 + starter_factor * 0.3 + position_weight * 0.2)
      // Capped at 1.0
      let impactScore =
        goalInvolvement * 0.5 + starterFactor * 0.3 + positionWeight * 0.2;

      // Boost for high-volume goal involvement (a player with 40%+ is truly critical)
      if (goalInvolvement > 0.3) {
        impactScore = Math.min(1.0, impactScore * 1.3);
      }

      impactScore = Math.min(1.0, impactScore);

      const absenceProbability = this.getAbsenceProbability(injury.type);

      playerImpacts.push({
        playerId: pid,
        playerName: injury.playerName,
        teamId: injury.teamId,
        position,
        absenceType: injury.type,
        reason: injury.reason,
        absenceProbability,
        impactScore,
        goals,
        assists,
        appearances,
        teamMatches: teamMatchCount,
        isRegularStarter,
        impactLabel: this.getImpactLabel(impactScore * absenceProbability),
      });
    }

    // Sort by weighted impact (impact * absence probability) descending
    playerImpacts.sort(
      (a, b) =>
        b.impactScore * b.absenceProbability -
        a.impactScore * a.absenceProbability,
    );

    // Compute aggregate team impact
    let offensiveImpact = 0;
    let defensiveImpact = 0;

    for (const p of playerImpacts) {
      const weightedImpact = p.impactScore * p.absenceProbability;

      if (p.position === 'F' || p.position === 'M') {
        offensiveImpact += weightedImpact;
      }
      if (p.position === 'D' || p.position === 'G') {
        defensiveImpact += weightedImpact;
      }
      // Midfielders contribute to both
      if (p.position === 'M') {
        defensiveImpact += weightedImpact * 0.3;
      }
    }

    // Cap at reasonable values (even losing 3 star players doesn't halve your xG)
    offensiveImpact = Math.min(0.35, offensiveImpact);
    defensiveImpact = Math.min(0.25, defensiveImpact);

    // xG multiplier: 1.0 - offensive_impact (e.g. 0.15 offensive impact = 0.85x xG)
    const xgMultiplier = Math.max(0.7, 1.0 - offensiveImpact);
    // xGA multiplier: 1.0 + defensive_impact (e.g. 0.10 defensive impact = 1.10x xGA)
    const xgaMultiplier = Math.min(1.3, 1.0 + defensiveImpact);

    return {
      teamId,
      totalAbsences: injuries.length,
      offensiveImpact: Number(offensiveImpact.toFixed(3)),
      defensiveImpact: Number(defensiveImpact.toFixed(3)),
      xgMultiplier: Number(xgMultiplier.toFixed(3)),
      xgaMultiplier: Number(xgaMultiplier.toFixed(3)),
      players: playerImpacts,
    };
  }

  /**
   * Map API-Football injury type to absence probability.
   */
  private getAbsenceProbability(type: string | null): number {
    if (!type) return 0.5;
    const normalised = type.toLowerCase();
    if (normalised.includes('missing') || normalised.includes('out'))
      return 1.0;
    if (normalised.includes('suspended')) return 1.0;
    if (normalised.includes('doubtful')) return 0.75;
    if (normalised.includes('questionable')) return 0.5;
    return 0.6; // Unknown type — assume probable absence
  }

  /**
   * Position-based offensive importance weight (0-1).
   * Forwards and attacking midfielders have the most direct offensive impact.
   * Goalkeepers have defensive-only impact but can be critical (hence 0.1 offensive).
   */
  private getPositionWeight(position: string): number {
    switch (position) {
      case 'F':
        return 0.9; // Forwards are primary goal scorers
      case 'M':
        return 0.6; // Midfielders create and score
      case 'D':
        return 0.2; // Defenders rarely score but provide stability
      case 'G':
        return 0.1; // GK impact is defensive
      default:
        return 0.4; // Unknown — assume moderate
    }
  }

  /**
   * Convert impact score to human-readable label.
   */
  private getImpactLabel(
    weightedImpact: number,
  ): 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'MINIMAL' {
    if (weightedImpact >= 0.6) return 'CRITICAL';
    if (weightedImpact >= 0.4) return 'HIGH';
    if (weightedImpact >= 0.25) return 'MODERATE';
    if (weightedImpact >= 0.1) return 'LOW';
    return 'MINIMAL';
  }

  /**
   * Fallback for when there's no historical data.
   * Uses position-based heuristics only.
   */
  private fallbackPlayerImpact(injury: any): PlayerImpact {
    return {
      playerId: injury.playerId,
      playerName: injury.playerName,
      teamId: injury.teamId,
      position: 'unknown',
      absenceType: injury.type,
      reason: injury.reason,
      absenceProbability: this.getAbsenceProbability(injury.type),
      impactScore: 0.3, // Default moderate impact when we don't know
      goals: 0,
      assists: 0,
      appearances: 0,
      teamMatches: 0,
      isRegularStarter: false,
      impactLabel: 'MODERATE',
    };
  }
}
