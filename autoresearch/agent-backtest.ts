/**
 * Agent-Level Backtester
 * ======================
 * Re-runs the Claude prediction agent on resolved matches to measure
 * raw prediction accuracy. Unlike the calibration backtester, this
 * actually calls Claude with reconstructed match data.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register autoresearch/agent-backtest.ts [--limit N] [--offset M]
 *
 * Environment: requires DATABASE_URL, ANTHROPIC_API_KEY
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { eq, and, isNotNull, desc, sql } from 'drizzle-orm';
import OpenAI from 'openai';
import { EXPERIMENT_SYSTEM_PROMPT } from './experiment-prompt';

// ─── Database Connection ──────────────────────────────────────────────

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

const client = (postgres as any)(DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

const db = drizzle(client, { schema });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Data Reconstruction ──────────────────────────────────────────────

interface MatchResult {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  result: string; // 'W', 'D', 'L' from team's perspective
  venue: 'home' | 'away';
}

interface ReconstructedMatch {
  prediction: typeof schema.predictions.$inferSelect;
  fixture: any;
  homeTeamName: string;
  awayTeamName: string;
  homeForm: any | null;
  awayForm: any | null;
  homeRecentStats: any | null;
  awayRecentStats: any | null;
  homeMatchHistory: MatchResult[];
  awayMatchHistory: MatchResult[];
  injuries: any[];
  lineups: any[];
  odds: { consensus: any[]; bookmakers: any[] };
  researchContext: any;
  perplexityResearch: string | null;
}

async function getTeamRecentStats(
  teamId: number,
  fixtureId: number,
  leagueId: number,
  matchCount = 10,
) {
  try {
    const recentStats = await db
      .select({
        stat: schema.fixtureStatistics,
        fixture: schema.fixtures,
      })
      .from(schema.fixtureStatistics)
      .innerJoin(
        schema.fixtures,
        eq(schema.fixtureStatistics.fixtureId, schema.fixtures.id),
      )
      .where(
        and(
          eq(schema.fixtureStatistics.teamId, teamId),
          eq(schema.fixtures.status, 'FT'),
          eq(schema.fixtures.leagueId, leagueId),
          sql`${schema.fixtureStatistics.fixtureId} != ${fixtureId}`,
        ),
      )
      .orderBy(desc(schema.fixtures.date))
      .limit(matchCount);

    if (recentStats.length === 0) {
      return {
        matchCount: 0,
        averages: {
          xG: 0,
          xGA: 0,
          shotsOnGoal: 0,
          shotsOnGoalAgainst: 0,
          totalShots: 0,
          possession: 0,
          passAccuracy: 0,
          cornerKicks: 0,
        },
      };
    }

    const fixtureIds = recentStats.map((r: any) => r.stat.fixtureId);
    const opponentStats = await db
      .select()
      .from(schema.fixtureStatistics)
      .where(
        and(
          sql`${schema.fixtureStatistics.fixtureId} IN (${sql.join(
            fixtureIds.map((id: number) => sql`${id}`),
            sql`, `,
          )})`,
          sql`${schema.fixtureStatistics.teamId} != ${teamId}`,
        ),
      );

    const opponentStatsMap = new Map<number, any>();
    for (const os of opponentStats) {
      opponentStatsMap.set(os.fixtureId, os);
    }

    const stats = recentStats.map((r: any) => ({
      expectedGoals: r.stat.expectedGoals ? Number(r.stat.expectedGoals) : null,
      shotsOnGoal: r.stat.shotsOnGoal,
      totalShots: r.stat.totalShots,
      possession: r.stat.possession ? Number(r.stat.possession) : null,
      passesPct: r.stat.passesPct ? Number(r.stat.passesPct) : null,
      cornerKicks: r.stat.cornerKicks,
    }));

    const opponentXGs = fixtureIds
      .map((fid: number) => opponentStatsMap.get(fid)?.expectedGoals)
      .filter((v: any) => v != null)
      .map(Number);

    const opponentShotsOnGoal = fixtureIds
      .map((fid: number) => opponentStatsMap.get(fid)?.shotsOnGoal)
      .filter((v: any) => v != null);

    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const validXG = stats.filter((s: any) => s.expectedGoals != null);
    const validShots = stats.filter((s: any) => s.shotsOnGoal != null);
    const validTotalShots = stats.filter((s: any) => s.totalShots != null);
    const validPossession = stats.filter((s: any) => s.possession != null);
    const validPassAcc = stats.filter((s: any) => s.passesPct != null);
    const validCorners = stats.filter((s: any) => s.cornerKicks != null);

    return {
      matchCount: stats.length,
      averages: {
        xG: Number(avg(validXG.map((s: any) => s.expectedGoals)).toFixed(2)),
        xGA: Number(avg(opponentXGs).toFixed(2)),
        shotsOnGoal: Number(
          avg(validShots.map((s: any) => s.shotsOnGoal)).toFixed(1),
        ),
        shotsOnGoalAgainst: Number(avg(opponentShotsOnGoal).toFixed(1)),
        totalShots: Number(
          avg(validTotalShots.map((s: any) => s.totalShots)).toFixed(1),
        ),
        possession: Number(
          avg(validPossession.map((s: any) => s.possession)).toFixed(1),
        ),
        passAccuracy: Number(
          avg(validPassAcc.map((s: any) => s.passesPct)).toFixed(1),
        ),
        cornerKicks: Number(
          avg(validCorners.map((s: any) => s.cornerKicks)).toFixed(1),
        ),
      },
    };
  } catch {
    return {
      matchCount: 0,
      averages: {
        xG: 0,
        xGA: 0,
        shotsOnGoal: 0,
        shotsOnGoalAgainst: 0,
        totalShots: 0,
        possession: 0,
        passAccuracy: 0,
        cornerKicks: 0,
      },
    };
  }
}

// ─── Match History from DB ────────────────────────────────────────────

async function getTeamMatchHistory(
  teamId: number,
  beforeFixtureId: number,
  leagueId: number,
  limit = 10,
): Promise<MatchResult[]> {
  try {
    // Get the fixture date to filter matches before it
    const targetFixture = await db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, beforeFixtureId))
      .limit(1);
    const targetDate = targetFixture[0]?.date;
    if (!targetDate) return [];

    // Get last N finished matches for this team in this league
    const dateISO = new Date(targetDate).toISOString();
    const matches = await db
      .select({
        fixture: schema.fixtures,
        homeTeam: schema.teams,
      })
      .from(schema.fixtures)
      .innerJoin(schema.teams, eq(schema.fixtures.homeTeamId, schema.teams.id))
      .where(
        and(
          eq(schema.fixtures.leagueId, leagueId),
          eq(schema.fixtures.status, 'FT'),
          sql`${schema.fixtures.date} < ${dateISO}::timestamp`,
          sql`(${schema.fixtures.homeTeamId} = ${teamId} OR ${schema.fixtures.awayTeamId} = ${teamId})`,
        ),
      )
      .orderBy(desc(schema.fixtures.date))
      .limit(limit);

    // Also need away team names
    const results: MatchResult[] = [];
    for (const m of matches) {
      const f = m.fixture;
      const isHome = f.homeTeamId === teamId;

      // Get opponent name
      const opponentId = isHome ? f.awayTeamId : f.homeTeamId;
      const opponentRows = await db
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, opponentId))
        .limit(1);
      const opponentName = opponentRows[0]?.name ?? `Team ${opponentId}`;
      const teamName = m.homeTeam?.name ?? `Team ${teamId}`;

      const homeGoals = f.goalsHome ?? 0;
      const awayGoals = f.goalsAway ?? 0;
      const teamGoals = isHome ? homeGoals : awayGoals;
      const oppGoals = isHome ? awayGoals : homeGoals;

      let result: string;
      if (teamGoals > oppGoals) result = 'W';
      else if (teamGoals === oppGoals) result = 'D';
      else result = 'L';

      results.push({
        date: new Date(f.date).toISOString().split('T')[0],
        homeTeam: isHome
          ? (m.homeTeam?.name ?? `Team ${f.homeTeamId}`)
          : opponentName,
        awayTeam: isHome
          ? opponentName
          : (m.homeTeam?.name ?? `Team ${f.homeTeamId}`),
        homeGoals,
        awayGoals,
        result,
        venue: isHome ? 'home' : 'away',
      });
    }
    return results;
  } catch (error) {
    console.error(`Failed to get match history for team ${teamId}: ${error}`);
    return [];
  }
}

// ─── Perplexity Deep Research ─────────────────────────────────────────

async function perplexityResearch(
  homeTeam: string,
  awayTeam: string,
  matchDate: string,
  league: string,
): Promise<string | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  try {
    const query = `${homeTeam} vs ${awayTeam} ${league} ${matchDate}: Give me the last 5 match results for each team (scores), current bookmaker odds for this match, key injuries/suspensions, and head-to-head record. Include specific numbers and data.`;

    const preset = process.env.PERPLEXITY_PRESET || 'pro-search';
    const response = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        preset,
        input: query,
      }),
    });

    if (!response.ok) {
      console.error(
        `Perplexity API error: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data = await response.json();
    return data.output_text ?? data.choices?.[0]?.message?.content ?? null;
  } catch (error) {
    console.error(`Perplexity research failed: ${error}`);
    return null;
  }
}

async function reconstructMatch(
  prediction: typeof schema.predictions.$inferSelect,
): Promise<ReconstructedMatch | null> {
  try {
    // Get fixture
    const fixtureRows = await db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.id, prediction.fixtureId))
      .limit(1);
    const fixture = fixtureRows[0];
    if (!fixture) return null;

    // Get team names
    const homeTeamRows = await db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, fixture.homeTeamId))
      .limit(1);
    const awayTeamRows = await db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, fixture.awayTeamId))
      .limit(1);

    const homeTeamName = homeTeamRows[0]?.name ?? `Team ${fixture.homeTeamId}`;
    const awayTeamName = awayTeamRows[0]?.name ?? `Team ${fixture.awayTeamId}`;

    // Get team form
    const homeFormRows = await db
      .select()
      .from(schema.teamForm)
      .where(
        and(
          eq(schema.teamForm.teamId, fixture.homeTeamId),
          eq(schema.teamForm.leagueId, fixture.leagueId),
        ),
      )
      .orderBy(desc(schema.teamForm.season))
      .limit(1);

    const awayFormRows = await db
      .select()
      .from(schema.teamForm)
      .where(
        and(
          eq(schema.teamForm.teamId, fixture.awayTeamId),
          eq(schema.teamForm.leagueId, fixture.leagueId),
        ),
      )
      .orderBy(desc(schema.teamForm.season))
      .limit(1);

    // Get injuries
    const injuries = await db
      .select()
      .from(schema.injuries)
      .where(
        sql`${schema.injuries.teamId} IN (${fixture.homeTeamId}, ${fixture.awayTeamId})`,
      )
      .orderBy(desc(schema.injuries.updatedAt))
      .limit(50);

    // Get lineups
    const lineups = await db
      .select()
      .from(schema.fixtureLineups)
      .where(eq(schema.fixtureLineups.fixtureId, prediction.fixtureId));

    // Get odds
    let consensus: any[] = [];
    if (fixture.oddsApiEventId) {
      consensus = await db
        .select()
        .from(schema.consensusOdds)
        .where(eq(schema.consensusOdds.oddsApiEventId, fixture.oddsApiEventId))
        .orderBy(desc(schema.consensusOdds.calculatedAt));
    }

    // Get recent stats + match history + perplexity research in parallel
    const [
      homeRecentStats,
      awayRecentStats,
      homeMatchHistory,
      awayMatchHistory,
      pplxResearch,
    ] = await Promise.all([
      getTeamRecentStats(
        fixture.homeTeamId,
        prediction.fixtureId,
        fixture.leagueId,
      ),
      getTeamRecentStats(
        fixture.awayTeamId,
        prediction.fixtureId,
        fixture.leagueId,
      ),
      getTeamMatchHistory(
        fixture.homeTeamId,
        prediction.fixtureId,
        fixture.leagueId,
        10,
      ),
      getTeamMatchHistory(
        fixture.awayTeamId,
        prediction.fixtureId,
        fixture.leagueId,
        10,
      ),
      perplexityResearch(
        homeTeamName,
        awayTeamName,
        new Date(fixture.date).toISOString().split('T')[0],
        fixture.leagueName ?? 'Unknown League',
      ),
    ]);

    return {
      prediction,
      fixture,
      homeTeamName,
      awayTeamName,
      homeForm: homeFormRows[0] ?? null,
      awayForm: awayFormRows[0] ?? null,
      homeRecentStats,
      awayRecentStats,
      homeMatchHistory,
      awayMatchHistory,
      injuries,
      lineups,
      odds: { consensus, bookmakers: [] },
      researchContext: prediction.researchContext,
      perplexityResearch: pplxResearch,
    };
  } catch (error) {
    console.error(
      `Failed to reconstruct match for prediction ${prediction.id}: ${error}`,
    );
    return null;
  }
}

// ─── Prompt Building (mirrors AnalysisAgent.buildPrompt) ──────────────

function buildPrompt(match: ReconstructedMatch): string {
  const sections: string[] = [];
  const fixture = match.fixture;
  const homeName = match.homeTeamName;
  const awayName = match.awayTeamName;

  // Match info
  sections.push(
    `# Match: ${homeName} vs ${awayName}`,
    `- Date: ${new Date(fixture.date).toISOString()}`,
    `- League: ${fixture.leagueName ?? fixture.leagueId} (${fixture.leagueCountry ?? 'Unknown'})`,
    `- Round: ${fixture.round ?? 'Unknown'}`,
    `- Venue: ${fixture.venueName ?? 'Unknown'}, ${fixture.venueCity ?? 'Unknown'}`,
    `- Referee: ${fixture.referee ?? 'Unknown'}`,
  );

  // Home team form
  const homeForm = match.homeForm;
  if (homeForm) {
    sections.push(`\n## ${homeName} (Home)`);
    sections.push(
      `- League Position: ${homeForm.leaguePosition ?? '?'}`,
      `- Points: ${homeForm.points ?? '?'}`,
      `- Form (last 5): ${homeForm.formString ?? '?'}`,
      `- Home Record: W${homeForm.homeWins ?? '?'} D${homeForm.homeDraws ?? '?'} L${homeForm.homeLosses ?? '?'}`,
      `- Goals For Avg: ${homeForm.goalsForAvg ?? '?'}`,
      `- Goals Against Avg: ${homeForm.goalsAgainstAvg ?? '?'}`,
      `- Clean Sheets: ${homeForm.cleanSheets ?? '?'}`,
      `- Failed to Score: ${homeForm.failedToScore ?? '?'}`,
    );
  }

  // Home advanced stats
  const homeStats = match.homeRecentStats;
  if (homeStats && homeStats.matchCount > 0) {
    sections.push(
      `\n### ${homeName} — Advanced Stats (Last ${homeStats.matchCount} matches)`,
    );
    const a = homeStats.averages;
    sections.push(
      `- xG per match: ${a.xG} (expected goals FOR)`,
      `- xGA per match: ${a.xGA} (expected goals AGAINST)`,
      `- xG Difference: ${(a.xG - a.xGA).toFixed(2)} (positive = outperforming opponents)`,
      `- Shots on Goal: ${a.shotsOnGoal} per match`,
      `- Shots on Goal Against: ${a.shotsOnGoalAgainst} per match`,
      `- Total Shots: ${a.totalShots} per match`,
      `- Possession: ${a.possession}%`,
      `- Pass Accuracy: ${a.passAccuracy}%`,
      `- Corner Kicks: ${a.cornerKicks} per match`,
    );
    if (homeForm) {
      const actualGoalsAvg = Number(homeForm.goalsForAvg) || 0;
      if (a.xG > 0 && actualGoalsAvg > 0) {
        const diff = actualGoalsAvg - a.xG;
        if (Math.abs(diff) > 0.2) {
          sections.push(
            `- ** ${diff > 0 ? 'OVERPERFORMING' : 'UNDERPERFORMING'} xG by ${Math.abs(diff).toFixed(2)} goals/match — regression likely **`,
          );
        }
      }
    }
  }

  // Away team form
  const awayForm = match.awayForm;
  if (awayForm) {
    sections.push(`\n## ${awayName} (Away)`);
    sections.push(
      `- League Position: ${awayForm.leaguePosition ?? '?'}`,
      `- Points: ${awayForm.points ?? '?'}`,
      `- Form (last 5): ${awayForm.formString ?? '?'}`,
      `- Away Record: W${awayForm.awayWins ?? '?'} D${awayForm.awayDraws ?? '?'} L${awayForm.awayLosses ?? '?'}`,
      `- Goals For Avg: ${awayForm.goalsForAvg ?? '?'}`,
      `- Goals Against Avg: ${awayForm.goalsAgainstAvg ?? '?'}`,
      `- Clean Sheets: ${awayForm.cleanSheets ?? '?'}`,
      `- Failed to Score: ${awayForm.failedToScore ?? '?'}`,
    );
  }

  // Away advanced stats
  const awayStats = match.awayRecentStats;
  if (awayStats && awayStats.matchCount > 0) {
    sections.push(
      `\n### ${awayName} — Advanced Stats (Last ${awayStats.matchCount} matches)`,
    );
    const a = awayStats.averages;
    sections.push(
      `- xG per match: ${a.xG} (expected goals FOR)`,
      `- xGA per match: ${a.xGA} (expected goals AGAINST)`,
      `- xG Difference: ${(a.xG - a.xGA).toFixed(2)} (positive = outperforming opponents)`,
      `- Shots on Goal: ${a.shotsOnGoal} per match`,
      `- Shots on Goal Against: ${a.shotsOnGoalAgainst} per match`,
      `- Total Shots: ${a.totalShots} per match`,
      `- Possession: ${a.possession}%`,
      `- Pass Accuracy: ${a.passAccuracy}%`,
      `- Corner Kicks: ${a.cornerKicks} per match`,
    );
    if (awayForm) {
      const actualGoalsAvg = Number(awayForm.goalsForAvg) || 0;
      if (a.xG > 0 && actualGoalsAvg > 0) {
        const diff = actualGoalsAvg - a.xG;
        if (Math.abs(diff) > 0.2) {
          sections.push(
            `- ** ${diff > 0 ? 'OVERPERFORMING' : 'UNDERPERFORMING'} xG by ${Math.abs(diff).toFixed(2)} goals/match — regression likely **`,
          );
        }
      }
    }
  }

  // ── Match History (last 10 results per team) ──
  if (match.homeMatchHistory.length > 0) {
    sections.push(
      `\n## ${homeName} — Last ${match.homeMatchHistory.length} Match Results`,
    );
    const wins = match.homeMatchHistory.filter((m) => m.result === 'W').length;
    const draws = match.homeMatchHistory.filter((m) => m.result === 'D').length;
    const losses = match.homeMatchHistory.filter(
      (m) => m.result === 'L',
    ).length;
    const homeWins = match.homeMatchHistory.filter(
      (m) => m.venue === 'home' && m.result === 'W',
    ).length;
    const homeMatches = match.homeMatchHistory.filter(
      (m) => m.venue === 'home',
    ).length;
    const homeDraws = match.homeMatchHistory.filter(
      (m) => m.venue === 'home' && m.result === 'D',
    ).length;
    sections.push(
      `Summary: ${wins}W ${draws}D ${losses}L (Home: ${homeWins}W ${homeDraws}D ${homeMatches - homeWins - homeDraws}L)`,
    );
    for (const m of match.homeMatchHistory) {
      sections.push(
        `- ${m.date} [${m.venue.toUpperCase()}] ${m.homeTeam} ${m.homeGoals}-${m.awayGoals} ${m.awayTeam} → ${m.result}`,
      );
    }
  }

  if (match.awayMatchHistory.length > 0) {
    sections.push(
      `\n## ${awayName} — Last ${match.awayMatchHistory.length} Match Results`,
    );
    const wins = match.awayMatchHistory.filter((m) => m.result === 'W').length;
    const draws = match.awayMatchHistory.filter((m) => m.result === 'D').length;
    const losses = match.awayMatchHistory.filter(
      (m) => m.result === 'L',
    ).length;
    const awayWins = match.awayMatchHistory.filter(
      (m) => m.venue === 'away' && m.result === 'W',
    ).length;
    const awayMatches = match.awayMatchHistory.filter(
      (m) => m.venue === 'away',
    ).length;
    const awayDraws = match.awayMatchHistory.filter(
      (m) => m.venue === 'away' && m.result === 'D',
    ).length;
    sections.push(
      `Summary: ${wins}W ${draws}D ${losses}L (Away: ${awayWins}W ${awayDraws}D ${awayMatches - awayWins - awayDraws}L)`,
    );
    for (const m of match.awayMatchHistory) {
      sections.push(
        `- ${m.date} [${m.venue.toUpperCase()}] ${m.homeTeam} ${m.homeGoals}-${m.awayGoals} ${m.awayTeam} → ${m.result}`,
      );
    }
  }

  // ── Bookmaker Odds ──
  const h2hOdds = match.odds.consensus.find((c: any) => c.marketKey === 'h2h');
  if (h2hOdds) {
    sections.push(`\n## Bookmaker Consensus Odds`);
    sections.push(
      `- Home Win: ${(Number(h2hOdds.consensusHomeWin) * 100).toFixed(1)}%`,
      `- Draw: ${(Number(h2hOdds.consensusDraw) * 100).toFixed(1)}%`,
      `- Away Win: ${(Number(h2hOdds.consensusAwayWin) * 100).toFixed(1)}%`,
    );
    if (h2hOdds.pinnacleHomeWin) {
      sections.push(
        `Pinnacle (sharpest bookmaker): H=${(Number(h2hOdds.pinnacleHomeWin) * 100).toFixed(1)}% D=${(Number(h2hOdds.pinnacleDraw) * 100).toFixed(1)}% A=${(Number(h2hOdds.pinnacleAwayWin) * 100).toFixed(1)}%`,
      );
    }
    sections.push(`Number of bookmakers: ${h2hOdds.numBookmakers ?? '?'}`);
  }

  // Injuries
  if (match.injuries.length > 0) {
    sections.push(`\n## Injuries & Suspensions`);
    for (const inj of match.injuries) {
      const side = inj.teamId === fixture.homeTeamId ? homeName : awayName;
      sections.push(
        `- [${side}] ${inj.playerName}: ${inj.type ?? '?'} — ${inj.reason ?? 'Unknown'}`,
      );
    }
  }

  // Lineups
  if (match.lineups.length > 0) {
    sections.push(`\n## Confirmed Lineups`);
    for (const lineup of match.lineups) {
      const teamName = lineup.teamName ?? 'Unknown';
      const formation = lineup.formation ?? 'Unknown';
      const startXI = Array.isArray(lineup.startXI)
        ? lineup.startXI
            .map((p: any) => p.name ?? p.player?.name)
            .filter(Boolean)
            .join(', ')
        : 'Not available';
      sections.push(`### ${teamName} (${formation})`, startXI);
    }
  }

  // Perplexity Deep Research (live web research)
  if (match.perplexityResearch) {
    sections.push(`\n## Deep Research (Web)\n${match.perplexityResearch}`);
  }

  // Stored research context (from original prediction)
  if (match.researchContext && !match.perplexityResearch) {
    const rc = match.researchContext as any;
    if (rc.combinedResearch) {
      sections.push(`\n## Web Research\n${rc.combinedResearch}`);
    } else if (typeof rc === 'string') {
      sections.push(`\n## Web Research\n${rc}`);
    }
  }

  return sections.join('\n');
}

// ─── Claude API Call ──────────────────────────────────────────────────

const PREDICTION_JSON_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    homeWinProb: { type: 'number' as const },
    drawProb: { type: 'number' as const },
    awayWinProb: { type: 'number' as const },
    predictedHomeGoals: { type: 'number' as const },
    predictedAwayGoals: { type: 'number' as const },
    confidence: { type: 'integer' as const },
    keyFactors: { type: 'array' as const, items: { type: 'string' as const } },
    riskFactors: { type: 'array' as const, items: { type: 'string' as const } },
    valueBets: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          market: { type: 'string' as const },
          selection: { type: 'string' as const },
          reasoning: { type: 'string' as const },
          edgePercent: { type: 'number' as const },
        },
        required: ['market', 'selection', 'reasoning', 'edgePercent'],
      },
    },
    detailedAnalysis: { type: 'string' as const },
  },
  required: [
    'homeWinProb',
    'drawProb',
    'awayWinProb',
    'predictedHomeGoals',
    'predictedAwayGoals',
    'confidence',
    'keyFactors',
    'riskFactors',
    'valueBets',
    'detailedAnalysis',
  ],
};

function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
}

async function callLLM(userPrompt: string): Promise<any> {
  const model = process.env.BACKTEST_MODEL || 'gpt-4o';
  const reasoning = isReasoningModel(model);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: reasoning ? 'developer' : 'system',
      content: EXPERIMENT_SYSTEM_PROMPT,
    },
    { role: 'user', content: userPrompt },
  ];

  const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    max_completion_tokens: reasoning ? 16000 : 8000,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'prediction_output',
        strict: true,
        schema: PREDICTION_JSON_SCHEMA,
      },
    },
    ...(reasoning
      ? { reasoning_effort: 'high' as const }
      : { temperature: 0.7 }),
  };

  const response = await openai.chat.completions.create(params);

  const rawText = response.choices[0]?.message?.content ?? '';

  // Parse JSON
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try brace matching
    const firstBrace = rawText.indexOf('{');
    if (firstBrace !== -1) {
      let depth = 0;
      let lastBrace = -1;
      for (let i = firstBrace; i < rawText.length; i++) {
        if (rawText[i] === '{') depth++;
        else if (rawText[i] === '}') {
          depth--;
          if (depth === 0) {
            lastBrace = i;
            break;
          }
        }
      }
      if (lastBrace !== -1) {
        return JSON.parse(rawText.substring(firstBrace, lastBrace + 1));
      }
    }
    throw new Error(
      `Failed to parse LLM response as JSON: ${rawText.substring(0, 200)}`,
    );
  }
}

function getPredictedResult(
  homeProb: number,
  drawProb: number,
  awayProb: number,
): string {
  if (drawProb >= homeProb && drawProb >= awayProb) return 'draw';
  if (homeProb >= awayProb) return 'home_win';
  return 'away_win';
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const offsetArg = args.indexOf('--offset');
  const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : 12;
  const offset = offsetArg !== -1 ? parseInt(args[offsetArg + 1]) : 0;

  console.log('Agent-Level Backtester');
  console.log('=====================\n');
  console.log(`Model: ${process.env.BACKTEST_MODEL || 'gpt-4o'}`);
  console.log(`Running on ${limit} matches (offset ${offset})\n`);

  try {
    // Fetch resolved predictions
    const rows = await db
      .select()
      .from(schema.predictions)
      .where(
        and(
          isNotNull(schema.predictions.resolvedAt),
          eq(schema.predictions.predictionStatus, 'resolved'),
        ),
      )
      .orderBy(desc(schema.predictions.resolvedAt))
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) {
      console.error('No resolved predictions found.');
      process.exit(1);
    }

    console.log(`Found ${rows.length} resolved predictions to backtest.\n`);

    let correct = 0;
    let total = 0;
    let totalBrier = 0;
    const results: any[] = [];

    for (const prediction of rows) {
      const actualResult = prediction.actualResult as string;
      if (
        !actualResult ||
        !['home_win', 'draw', 'away_win'].includes(actualResult)
      ) {
        continue;
      }

      // Reconstruct match data
      const match = await reconstructMatch(prediction);
      if (!match) {
        console.log(
          `  SKIP: Could not reconstruct match for prediction ${prediction.id}`,
        );
        continue;
      }

      console.log(
        `\n[${total + 1}/${rows.length}] ${match.homeTeamName} vs ${match.awayTeamName}`,
      );
      console.log(`  Actual result: ${actualResult}`);
      console.log(
        `  Original prediction: ${prediction.predictedResult} (H=${prediction.homeWinProb} D=${prediction.drawProb} A=${prediction.awayWinProb})`,
      );

      try {
        // Build prompt and call Claude
        const userPrompt = buildPrompt(match);
        const claudeOutput = await callLLM(userPrompt);

        // Normalize probabilities
        let h = Number(claudeOutput.homeWinProb) || 0.33;
        let d = Number(claudeOutput.drawProb) || 0.34;
        let a = Number(claudeOutput.awayWinProb) || 0.33;
        const t = h + d + a;
        h /= t;
        d /= t;
        a /= t;

        const predictedResult = getPredictedResult(h, d, a);
        const wasCorrect = predictedResult === actualResult;
        if (wasCorrect) correct++;

        // Brier score
        const brier =
          Math.pow(h - (actualResult === 'home_win' ? 1 : 0), 2) +
          Math.pow(d - (actualResult === 'draw' ? 1 : 0), 2) +
          Math.pow(a - (actualResult === 'away_win' ? 1 : 0), 2);
        totalBrier += brier;

        total++;

        console.log(
          `  New prediction: ${predictedResult} (H=${h.toFixed(4)} D=${d.toFixed(4)} A=${a.toFixed(4)})`,
        );
        console.log(
          `  ${wasCorrect ? 'CORRECT' : 'WRONG'} | Brier: ${brier.toFixed(4)}`,
        );

        results.push({
          match: `${match.homeTeamName} vs ${match.awayTeamName}`,
          actual: actualResult,
          predicted: predictedResult,
          correct: wasCorrect,
          brier,
          probs: { h: h.toFixed(4), d: d.toFixed(4), a: a.toFixed(4) },
          originalPredicted: prediction.predictedResult,
        });

        // Rate limiting — wait 2 seconds between calls
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error: any) {
        console.log(`  ERROR: ${error.message}`);
        total++;
      }
    }

    // Summary
    console.log('\n\n========== SUMMARY ==========');
    console.log('---');
    console.log(`total_matches:     ${total}`);
    console.log(`correct:           ${correct}`);
    console.log(
      `accuracy:          ${total > 0 ? ((correct / total) * 100).toFixed(2) : 0}%`,
    );
    console.log(
      `avg_brier:         ${total > 0 ? (totalBrier / total).toFixed(6) : 0}`,
    );
    console.log('');

    // By result
    const byActual: Record<string, { total: number; correct: number }> = {
      home_win: { total: 0, correct: 0 },
      draw: { total: 0, correct: 0 },
      away_win: { total: 0, correct: 0 },
    };
    for (const r of results) {
      if (byActual[r.actual]) {
        byActual[r.actual].total++;
        if (r.correct) byActual[r.actual].correct++;
      }
    }
    console.log('By Actual Result:');
    for (const [key, val] of Object.entries(byActual)) {
      console.log(
        `  ${key.padEnd(10)} ${val.correct}/${val.total} correct (${val.total > 0 ? ((val.correct / val.total) * 100).toFixed(1) : 0}%)`,
      );
    }

    // Compare to original predictions
    let originalCorrect = 0;
    for (const r of results) {
      if (r.originalPredicted === r.actual) originalCorrect++;
    }
    console.log('');
    console.log(
      `Original accuracy: ${total > 0 ? ((originalCorrect / total) * 100).toFixed(2) : 0}% (${originalCorrect}/${total})`,
    );
    console.log(
      `New accuracy:      ${total > 0 ? ((correct / total) * 100).toFixed(2) : 0}% (${correct}/${total})`,
    );
    console.log(
      `Delta:             ${total > 0 ? (((correct - originalCorrect) / total) * 100).toFixed(2) : 0}pp`,
    );

    // Individual results table
    console.log('\n--- Individual Results ---');
    for (const r of results) {
      const icon = r.correct ? 'OK' : 'XX';
      console.log(
        `  [${icon}] ${r.match.padEnd(45)} actual=${r.actual.padEnd(10)} predicted=${r.predicted.padEnd(10)} H=${r.probs.h} D=${r.probs.d} A=${r.probs.a}`,
      );
    }
  } catch (error) {
    console.error('FAIL');
    console.error(error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
