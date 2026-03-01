import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import {
  fixtures,
  teams,
  teamForm,
  injuries,
  fixtureStatistics,
  fixtureEvents,
} from '../database/schema';

export interface StatisticalProbability {
  homeWin: number;
  draw: number;
  awayWin: number;
  formScore: number;
  homeAwayFactor: number;
  h2hScore: number;
  goalModel: number;
  injuryImpact: number;
  positionContext: number;
}

/**
 * Form result weights (most recent first).
 * Win=3, Draw=1, Loss=0
 */
const FORM_WEIGHTS = [0.3, 0.25, 0.2, 0.15, 0.1];

/**
 * Signal component weights as defined in the prediction engine spec.
 */
const COMPONENT_WEIGHTS = {
  form: 0.25,
  homeAway: 0.15,
  h2h: 0.15,
  goals: 0.15,
  injury: 0.2,
  position: 0.1,
};

@Injectable()
export class StatisticalModelService {
  private readonly logger = new Logger(StatisticalModelService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  /**
   * Calculate probability estimates for a fixture by combining form,
   * H2H, injuries, goals, and position context.
   */
  async calculateProbability(
    fixtureId: number,
  ): Promise<StatisticalProbability | null> {
    // Load fixture with team IDs
    const [fixture] = await this.db
      .select()
      .from(fixtures)
      .where(eq(fixtures.id, fixtureId))
      .limit(1);

    if (!fixture) {
      this.logger.debug(`Fixture ${fixtureId} not found`);
      return null;
    }

    const homeTeamId = fixture.homeTeamId as number;
    const awayTeamId = fixture.awayTeamId as number;
    const leagueId = fixture.leagueId as number;

    // Calculate all sub-signals in parallel
    const [formScore, homeAwayFactor, h2hScore, injuryImpact, positionCtx] =
      await Promise.all([
        this.getFormScore(homeTeamId, awayTeamId, leagueId),
        this.getHomeAwayFactor(fixtureId, homeTeamId, awayTeamId, leagueId),
        this.getH2HScore(homeTeamId, awayTeamId),
        this.getInjuryImpact(homeTeamId, awayTeamId, fixtureId),
        this.getPositionContext(homeTeamId, awayTeamId, leagueId),
      ]);

    // Calculate goal model (expected goals approximation)
    const goalModel = await this.getGoalModel(homeTeamId, awayTeamId, leagueId);

    // Combine into raw home advantage score (0-1 range, 0.5 = even)
    const rawHomeAdvantage =
      formScore * COMPONENT_WEIGHTS.form +
      homeAwayFactor * COMPONENT_WEIGHTS.homeAway +
      h2hScore * COMPONENT_WEIGHTS.h2h +
      goalModel * COMPONENT_WEIGHTS.goals +
      injuryImpact * COMPONENT_WEIGHTS.injury +
      positionCtx * COMPONENT_WEIGHTS.position;

    // Convert to probabilities
    // rawHomeAdvantage represents how much the home team is favoured (0-1)
    // We spread across home/draw/away
    const homeWin = this.clamp(rawHomeAdvantage * 0.85 + 0.05, 0.01, 0.99);
    const awayWin = this.clamp(
      (1 - rawHomeAdvantage) * 0.75 + 0.05,
      0.01,
      0.99,
    );
    const drawRaw = 1 - homeWin - awayWin;
    const draw = this.clamp(drawRaw, 0.01, 0.99);

    // Normalize to sum to 1
    const total = homeWin + draw + awayWin;
    const normalized: StatisticalProbability = {
      homeWin: homeWin / total,
      draw: draw / total,
      awayWin: awayWin / total,
      formScore,
      homeAwayFactor,
      h2hScore,
      goalModel,
      injuryImpact,
      positionContext: positionCtx,
    };

    return normalized;
  }

  /**
   * Team form score based on last 5 results (weighted by recency).
   * Returns a value from 0 to 1 representing how much the home team's
   * form exceeds the away team's form. 0.5 = equal form.
   */
  async getFormScore(
    homeTeamId: number,
    awayTeamId: number,
    leagueId: number,
  ): Promise<number> {
    const [homeForm] = await this.db
      .select()
      .from(teamForm)
      .where(
        and(eq(teamForm.teamId, homeTeamId), eq(teamForm.leagueId, leagueId)),
      )
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const [awayForm] = await this.db
      .select()
      .from(teamForm)
      .where(
        and(eq(teamForm.teamId, awayTeamId), eq(teamForm.leagueId, leagueId)),
      )
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const homeFormScore = this.calculateFormFromRecord(homeForm);
    const awayFormScore = this.calculateFormFromRecord(awayForm);

    // Normalise difference to 0-1 range (0.5 = equal)
    // Max score difference is 1.0 (one team perfect, other all losses)
    const diff = homeFormScore - awayFormScore; // range: -1 to 1
    return this.clamp(0.5 + diff * 0.5, 0, 1);
  }

  /**
   * Home/away advantage factor.
   * Considers the team's home vs away win rates.
   * Returns 0-1 (higher = bigger home advantage).
   */
  async getHomeAwayFactor(
    fixtureId: number,
    homeTeamId: number,
    awayTeamId: number,
    leagueId: number,
  ): Promise<number> {
    const [homeForm] = await this.db
      .select()
      .from(teamForm)
      .where(
        and(eq(teamForm.teamId, homeTeamId), eq(teamForm.leagueId, leagueId)),
      )
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const [awayForm] = await this.db
      .select()
      .from(teamForm)
      .where(
        and(eq(teamForm.teamId, awayTeamId), eq(teamForm.leagueId, leagueId)),
      )
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    // Calculate home win rate for home team
    const homeWins = homeForm?.homeWins ?? 0;
    const homeDraws = homeForm?.homeDraws ?? 0;
    const homeLosses = homeForm?.homeLosses ?? 0;
    const homeTotal = homeWins + homeDraws + homeLosses;
    const homeWinRate = homeTotal > 0 ? homeWins / homeTotal : 0.4;

    // Calculate away win rate for away team
    const awayWins = awayForm?.awayWins ?? 0;
    const awayDraws = awayForm?.awayDraws ?? 0;
    const awayLosses = awayForm?.awayLosses ?? 0;
    const awayTotal = awayWins + awayDraws + awayLosses;
    const awayWinRate = awayTotal > 0 ? awayWins / awayTotal : 0.3;

    // Home advantage: typical ~15-20% boost to home win probability
    // If home team wins at home often and away team doesn't win away often,
    // this should be high
    const homeAdvantage = homeWinRate - awayWinRate;

    // Normalise: range [-1, 1] → [0, 1]
    return this.clamp(0.5 + homeAdvantage * 0.5, 0, 1);
  }

  /**
   * Head-to-head score based on historical meetings.
   * h2h_score = (h2h_wins * 3 + h2h_draws) / (h2h_total * 3)
   * Returns 0-1 from the home team's perspective.
   */
  async getH2HScore(team1Id: number, team2Id: number): Promise<number> {
    // Find past fixtures between these two teams (last 10)
    const h2hFixtures = await this.db
      .select()
      .from(fixtures)
      .where(
        and(
          sql`(
            (${fixtures.homeTeamId} = ${team1Id} AND ${fixtures.awayTeamId} = ${team2Id})
            OR
            (${fixtures.homeTeamId} = ${team2Id} AND ${fixtures.awayTeamId} = ${team1Id})
          )`,
          eq(fixtures.status, 'FT'),
        ),
      )
      .orderBy(desc(fixtures.date))
      .limit(10);

    if (h2hFixtures.length < 1) {
      // No H2H data — return neutral
      return 0.5;
    }

    let team1Wins = 0;
    let draws = 0;
    let team1Losses = 0;

    for (const f of h2hFixtures) {
      const homeGoals = f.goalsHome ?? 0;
      const awayGoals = f.goalsAway ?? 0;
      const isTeam1Home = f.homeTeamId === team1Id;

      if (homeGoals === awayGoals) {
        draws++;
      } else if (homeGoals > awayGoals) {
        if (isTeam1Home) team1Wins++;
        else team1Losses++;
      } else {
        if (isTeam1Home) team1Losses++;
        else team1Wins++;
      }
    }

    const total = h2hFixtures.length;
    const score = (team1Wins * 3 + draws) / (total * 3);

    // If fewer than 3 meetings, pull toward 0.5 (neutral)
    const confidence = Math.min(total / 3, 1);
    return score * confidence + 0.5 * (1 - confidence);
  }

  /**
   * Estimate injury impact on both teams.
   * Returns 0-1 from the home team's perspective.
   * High value = home team less affected by injuries (advantage).
   */
  async getInjuryImpact(
    homeTeamId: number,
    awayTeamId: number,
    fixtureId: number,
  ): Promise<number> {
    // Get injuries for both teams
    const [homeInjuries, awayInjuries] = await Promise.all([
      this.db.select().from(injuries).where(eq(injuries.teamId, homeTeamId)),
      this.db.select().from(injuries).where(eq(injuries.teamId, awayTeamId)),
    ]);

    const homeImpact = this.sumInjuryImpact(homeInjuries);
    const awayImpact = this.sumInjuryImpact(awayInjuries);

    // If home team has more injuries, they are disadvantaged
    // Range: if both 0 → 0.5, if home is worse → <0.5, if away is worse → >0.5
    const diff = awayImpact - homeImpact; // positive = home advantage
    return this.clamp(0.5 + diff * 2, 0, 1);
  }

  /**
   * League position context.
   * Returns 0-1 from the home team's perspective.
   * High value = home team is higher in the table.
   */
  async getPositionContext(
    team1Id: number,
    team2Id: number,
    leagueId: number,
  ): Promise<number> {
    const [team1Form] = await this.db
      .select()
      .from(teamForm)
      .where(and(eq(teamForm.teamId, team1Id), eq(teamForm.leagueId, leagueId)))
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const [team2Form] = await this.db
      .select()
      .from(teamForm)
      .where(and(eq(teamForm.teamId, team2Id), eq(teamForm.leagueId, leagueId)))
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const pos1 = team1Form?.leaguePosition ?? 10;
    const pos2 = team2Form?.leaguePosition ?? 10;

    // position_diff = away_position - home_position (positive = home higher)
    const diff = pos2 - pos1;

    // Normalize to 0-1 range. Assume max 20 teams in a league.
    // diff range: roughly -19 to 19
    return this.clamp(0.5 + diff / 40, 0, 1);
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  /**
   * Calculate form score from a teamForm record's form string.
   * Uses weighted last 5 results: W=3, D=1, L=0.
   */
  private calculateFormFromRecord(formRecord: any): number {
    if (!formRecord?.formString) {
      // Fallback: use win/draw/loss counts
      const wins = formRecord?.last5Wins ?? 0;
      const draws = formRecord?.last5Draws ?? 0;
      const total = wins + draws + (formRecord?.last5Losses ?? 0);
      if (total === 0) return 0.5;
      return (wins * 3 + draws) / (total * 3);
    }

    const form = formRecord.formString.toUpperCase().split('');
    let score = 0;
    const maxScore = 3;

    for (let i = 0; i < Math.min(form.length, FORM_WEIGHTS.length); i++) {
      let points = 0;
      if (form[i] === 'W') points = 3;
      else if (form[i] === 'D') points = 1;
      else points = 0;

      score += (points / maxScore) * FORM_WEIGHTS[i];
    }

    return score;
  }

  /**
   * Goal model: use average goals scored/conceded to estimate
   * expected goals and derive a home advantage signal.
   */
  private async getGoalModel(
    homeTeamId: number,
    awayTeamId: number,
    leagueId: number,
  ): Promise<number> {
    const [homeForm] = await this.db
      .select()
      .from(teamForm)
      .where(
        and(eq(teamForm.teamId, homeTeamId), eq(teamForm.leagueId, leagueId)),
      )
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const [awayForm] = await this.db
      .select()
      .from(teamForm)
      .where(
        and(eq(teamForm.teamId, awayTeamId), eq(teamForm.leagueId, leagueId)),
      )
      .orderBy(desc(teamForm.updatedAt))
      .limit(1);

    const homeGoalsFor = parseFloat(String(homeForm?.goalsForAvg ?? '1.3'));
    const homeGoalsAgainst = parseFloat(
      String(homeForm?.goalsAgainstAvg ?? '1.0'),
    );
    const awayGoalsFor = parseFloat(String(awayForm?.goalsForAvg ?? '1.1'));
    const awayGoalsAgainst = parseFloat(
      String(awayForm?.goalsAgainstAvg ?? '1.2'),
    );

    // Expected goals: home scoring × away conceding (and vice versa)
    const expectedGoalsHome = homeGoalsFor * (awayGoalsAgainst / 1.2);
    const expectedGoalsAway = awayGoalsFor * (homeGoalsAgainst / 1.2);

    // Normalize: if home expected > away expected, home has goal advantage
    const total = expectedGoalsHome + expectedGoalsAway;
    if (total <= 0) return 0.5;

    return this.clamp(expectedGoalsHome / total, 0, 1);
  }

  /**
   * Sum up injury impact for a team.
   * Player importance tiers:
   *   Star player:     0.15
   *   Regular starter: 0.08
   *   Rotation player: 0.03
   *   Backup/youth:    0.01
   */
  private sumInjuryImpact(injuryList: any[]): number {
    if (!injuryList || injuryList.length === 0) return 0;

    let impact = 0;
    for (const inj of injuryList) {
      // Without detailed player importance data, estimate from injury type
      const type = (inj.type || '').toLowerCase();
      const reason = (inj.reason || '').toLowerCase();

      // Heuristic: more severe or long-term injuries have bigger impact
      if (
        reason.includes('acl') ||
        reason.includes('fracture') ||
        reason.includes('surgery')
      ) {
        impact += 0.12; // likely a starter / important player with long-term injury
      } else if (
        reason.includes('muscle') ||
        reason.includes('hamstring') ||
        reason.includes('knee')
      ) {
        impact += 0.06;
      } else if (
        type === 'missing fixture' ||
        reason.includes('suspended') ||
        reason.includes('red card')
      ) {
        impact += 0.05;
      } else {
        impact += 0.03; // minor / unknown
      }
    }

    // Cap total team injury impact at 0.5
    return Math.min(impact, 0.5);
  }

  /**
   * Clamp a value between min and max.
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
