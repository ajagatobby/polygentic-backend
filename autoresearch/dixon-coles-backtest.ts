/**
 * Dixon-Coles Walk-Forward Backtest
 * =================================
 *
 * Replays every resolved prediction through a freshly-fit Dixon-Coles model
 * and compares the resulting Brier score against the production ensemble's
 * stored Brier. Walk-forward validation: for each fixture we re-fit using
 * only league fixtures that completed *before* that fixture's date, so there
 * is no look-ahead leakage.
 *
 * Per-fixture refits would be too slow, so we cache fits per (league, ISO
 * week). All predictions in the same league-week reuse the same fit. Team
 * strengths don't move enough in a week to matter, and this is the cadence
 * Dixon & Coles themselves used.
 *
 * Outputs greppable metrics in the same style as backtest.ts.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register autoresearch/dixon-coles-backtest.ts
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  fitDixonColes,
  predictDixonColes,
  type FittedDixonColes,
  type MatchObservation,
} from './dixon-coles';

// ─── DB Connection ──────────────────────────────────────────────────────

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}
const client = (postgres as any)(DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});
const db = drizzle(client, { schema });

// ─── Helpers ────────────────────────────────────────────────────────────

function brier(
  homeProb: number,
  drawProb: number,
  awayProb: number,
  actual: 'home_win' | 'draw' | 'away_win',
): number {
  const h = actual === 'home_win' ? 1 : 0;
  const d = actual === 'draw' ? 1 : 0;
  const a = actual === 'away_win' ? 1 : 0;
  return (homeProb - h) ** 2 + (drawProb - d) ** 2 + (awayProb - a) ** 2;
}

function isoWeekStart(d: Date): string {
  // ISO week boundary at Monday 00:00 UTC. Used as cache key.
  const x = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dow = x.getUTCDay() || 7; // Sunday → 7
  x.setUTCDate(x.getUTCDate() - (dow - 1));
  return x.toISOString().slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────

interface ResolvedPredictionRow {
  predictionId: number;
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  fixtureDate: Date;
  leagueId: number;
  actualResult: 'home_win' | 'draw' | 'away_win';
  storedBrier: number;
  storedHomeProb: number;
  storedDrawProb: number;
  storedAwayProb: number;
}

async function loadResolvedPredictions(): Promise<ResolvedPredictionRow[]> {
  const rows = await db
    .select({
      predictionId: schema.predictions.id,
      fixtureId: schema.predictions.fixtureId,
      homeProb: schema.predictions.homeWinProb,
      drawProb: schema.predictions.drawProb,
      awayProb: schema.predictions.awayWinProb,
      actualResult: schema.predictions.actualResult,
      probabilityAccuracy: schema.predictions.probabilityAccuracy,
      fixtureDate: schema.fixtures.date,
      leagueId: schema.fixtures.leagueId,
      homeTeamId: schema.fixtures.homeTeamId,
      awayTeamId: schema.fixtures.awayTeamId,
    })
    .from(schema.predictions)
    .innerJoin(
      schema.fixtures,
      eq(schema.predictions.fixtureId, schema.fixtures.id),
    )
    .where(
      and(
        isNotNull(schema.predictions.resolvedAt),
        eq(schema.predictions.predictionStatus, 'resolved'),
        isNotNull(schema.predictions.actualResult),
      ),
    );

  const result: ResolvedPredictionRow[] = [];
  for (const r of rows) {
    if (!r.actualResult) continue;
    if (!['home_win', 'draw', 'away_win'].includes(r.actualResult)) continue;
    const sh = Number(r.homeProb);
    const sd = Number(r.drawProb);
    const sa = Number(r.awayProb);
    if (!isFinite(sh) || !isFinite(sd) || !isFinite(sa)) continue;
    const sb = Number(r.probabilityAccuracy);
    result.push({
      predictionId: r.predictionId,
      fixtureId: r.fixtureId,
      homeTeamId: r.homeTeamId,
      awayTeamId: r.awayTeamId,
      fixtureDate: r.fixtureDate,
      leagueId: r.leagueId,
      actualResult: r.actualResult as 'home_win' | 'draw' | 'away_win',
      storedBrier: isFinite(sb)
        ? sb
        : brier(sh, sd, sa, r.actualResult as any),
      storedHomeProb: sh,
      storedDrawProb: sd,
      storedAwayProb: sa,
    });
  }
  return result;
}

async function loadLeagueFixtures(
  leagueId: number,
): Promise<MatchObservation[]> {
  const rows = await db
    .select({
      homeTeamId: schema.fixtures.homeTeamId,
      awayTeamId: schema.fixtures.awayTeamId,
      goalsHome: schema.fixtures.goalsHome,
      goalsAway: schema.fixtures.goalsAway,
      date: schema.fixtures.date,
      status: schema.fixtures.status,
    })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.leagueId, leagueId));

  const out: MatchObservation[] = [];
  for (const r of rows) {
    // Only completed matches with valid goals contribute to the fit.
    if (!['FT', 'AET', 'PEN'].includes(r.status)) continue;
    if (r.goalsHome == null || r.goalsAway == null) continue;
    out.push({
      homeTeamId: r.homeTeamId,
      awayTeamId: r.awayTeamId,
      homeGoals: r.goalsHome,
      awayGoals: r.goalsAway,
      date: new Date(r.date),
    });
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

interface RunMetrics {
  total: number;
  fitCacheSize: number;
  totalFitMs: number;
  totalPredictMs: number;
  // Brier sums
  dcBrierSum: number;
  storedBrierSum: number;
  baselineBrierSum: number;
  // Pick accuracy
  dcCorrect: number;
  storedCorrect: number;
  baselineCorrect: number;
  // Per-outcome calibration: avg prob assigned when outcome actually occurred
  dcHomeProbWhenHome: number;
  dcHomeWhenHomeN: number;
  dcDrawProbWhenDraw: number;
  dcDrawWhenDrawN: number;
  dcAwayProbWhenAway: number;
  dcAwayWhenAwayN: number;
  // Stratified by league
  perLeague: Map<
    number,
    { n: number; dcSum: number; storedSum: number; dcCorrect: number; storedCorrect: number }
  >;
  // Skipped (no training data available)
  skippedNoTraining: number;
  skippedNoTeam: number;
}

const BASELINE_HOME = 0.45;
const BASELINE_DRAW = 0.26;
const BASELINE_AWAY = 0.29;

function predictedFromProbs(
  h: number,
  d: number,
  a: number,
): 'home_win' | 'draw' | 'away_win' {
  if (h >= d && h >= a) return 'home_win';
  if (a >= d && a >= h) return 'away_win';
  return 'draw';
}

async function runBacktest(): Promise<RunMetrics> {
  console.log('Loading resolved predictions...');
  const preds = await loadResolvedPredictions();
  console.log(`  → ${preds.length} resolved predictions`);

  // Group leagues we'll need fixtures for
  const leagueIds = Array.from(new Set(preds.map((p) => p.leagueId)));
  console.log(`Loading FT fixtures for ${leagueIds.length} leagues...`);
  const leagueFixtures = new Map<number, MatchObservation[]>();
  for (const lid of leagueIds) {
    leagueFixtures.set(lid, await loadLeagueFixtures(lid));
  }
  const totalTraining = Array.from(leagueFixtures.values()).reduce(
    (s, arr) => s + arr.length,
    0,
  );
  console.log(`  → ${totalTraining} total FT fixtures across leagues`);

  // Sort predictions by date so we walk forward
  preds.sort((a, b) => a.fixtureDate.getTime() - b.fixtureDate.getTime());

  // Cache: fitted model per (leagueId, isoWeekStart)
  const fitCache = new Map<string, FittedDixonColes | null>();

  const m: RunMetrics = {
    total: 0,
    fitCacheSize: 0,
    totalFitMs: 0,
    totalPredictMs: 0,
    dcBrierSum: 0,
    storedBrierSum: 0,
    baselineBrierSum: 0,
    dcCorrect: 0,
    storedCorrect: 0,
    baselineCorrect: 0,
    dcHomeProbWhenHome: 0,
    dcHomeWhenHomeN: 0,
    dcDrawProbWhenDraw: 0,
    dcDrawWhenDrawN: 0,
    dcAwayProbWhenAway: 0,
    dcAwayWhenAwayN: 0,
    perLeague: new Map(),
    skippedNoTraining: 0,
    skippedNoTeam: 0,
  };

  const baselinePred = predictedFromProbs(
    BASELINE_HOME,
    BASELINE_DRAW,
    BASELINE_AWAY,
  );

  let processed = 0;
  for (const p of preds) {
    processed++;
    if (processed % 50 === 0) {
      console.log(`  ... ${processed}/${preds.length}`);
    }

    const cacheKey = `${p.leagueId}-${isoWeekStart(p.fixtureDate)}`;
    let model = fitCache.get(cacheKey);
    if (model === undefined) {
      // Need to fit. Take all FT fixtures in this league with date strictly
      // before the start of the prediction's ISO week (no look-ahead).
      const allLeague = leagueFixtures.get(p.leagueId) ?? [];
      const cutoff = new Date(`${isoWeekStart(p.fixtureDate)}T00:00:00.000Z`);
      const training = allLeague.filter((m2) => m2.date < cutoff);
      // Need a non-trivial sample to attempt the fit.
      if (training.length < 30) {
        fitCache.set(cacheKey, null);
        model = null;
      } else {
        const t0 = Date.now();
        const fit = fitDixonColes(training, cutoff, p.leagueId, {
          halfLifeDays: 90,
          maxIterations: 300,
          tolerance: 1e-6,
          learningRate: 0.05,
          l2: 0.02,
        });
        m.totalFitMs += Date.now() - t0;
        fitCache.set(cacheKey, fit);
        model = fit;
      }
    }

    if (!model) {
      m.skippedNoTraining++;
      continue;
    }
    if (!model.attack.has(p.homeTeamId) || !model.attack.has(p.awayTeamId)) {
      // Either side has no history in the league. Skip — counting these
      // would unfairly penalise DC since it has nothing to work with, while
      // the LLM ensemble could draw on bookmaker odds.
      m.skippedNoTeam++;
      continue;
    }

    const tp0 = Date.now();
    const pred = predictDixonColes(model, p.homeTeamId, p.awayTeamId);
    m.totalPredictMs += Date.now() - tp0;

    const dcBrier = brier(
      pred.homeWinProb,
      pred.drawProb,
      pred.awayWinProb,
      p.actualResult,
    );
    const baselineBrier = brier(
      BASELINE_HOME,
      BASELINE_DRAW,
      BASELINE_AWAY,
      p.actualResult,
    );

    m.total++;
    m.dcBrierSum += dcBrier;
    m.storedBrierSum += p.storedBrier;
    m.baselineBrierSum += baselineBrier;

    const dcPred = predictedFromProbs(
      pred.homeWinProb,
      pred.drawProb,
      pred.awayWinProb,
    );
    const storedPred = predictedFromProbs(
      p.storedHomeProb,
      p.storedDrawProb,
      p.storedAwayProb,
    );
    if (dcPred === p.actualResult) m.dcCorrect++;
    if (storedPred === p.actualResult) m.storedCorrect++;
    if (baselinePred === p.actualResult) m.baselineCorrect++;

    // Calibration accumulators
    if (p.actualResult === 'home_win') {
      m.dcHomeProbWhenHome += pred.homeWinProb;
      m.dcHomeWhenHomeN++;
    } else if (p.actualResult === 'draw') {
      m.dcDrawProbWhenDraw += pred.drawProb;
      m.dcDrawWhenDrawN++;
    } else {
      m.dcAwayProbWhenAway += pred.awayWinProb;
      m.dcAwayWhenAwayN++;
    }

    // Per-league
    const lstat = m.perLeague.get(p.leagueId) ?? {
      n: 0,
      dcSum: 0,
      storedSum: 0,
      dcCorrect: 0,
      storedCorrect: 0,
    };
    lstat.n++;
    lstat.dcSum += dcBrier;
    lstat.storedSum += p.storedBrier;
    if (dcPred === p.actualResult) lstat.dcCorrect++;
    if (storedPred === p.actualResult) lstat.storedCorrect++;
    m.perLeague.set(p.leagueId, lstat);
  }

  m.fitCacheSize = fitCache.size;
  return m;
}

// ─── Fallback: score DC walk-forward on raw FT fixtures ───────────────
//
// When there aren't enough ensemble predictions for the head-to-head, this
// at least gives us DC's standalone Brier across all FT fixtures with
// sufficient prior history. Useful as a ground-truth signal of whether the
// DC model itself is producing reasonable probabilities.

interface FixtureScoreResult {
  total: number;
  dcBrierSum: number;
  baselineBrierSum: number;
  dcCorrect: number;
  baselineCorrect: number;
  dcDrawProbWhenDraw: number;
  dcDrawWhenDrawN: number;
  skipped: number;
  fitsRun: number;
}

async function fixtureBasedBacktest(): Promise<FixtureScoreResult> {
  // Pull every FT fixture across every league we have data for.
  const allLeagueIds = await db
    .selectDistinct({ leagueId: schema.fixtures.leagueId })
    .from(schema.fixtures);
  const leagueIds = allLeagueIds.map((r: any) => r.leagueId);

  const leagueFixtures = new Map<number, MatchObservation[]>();
  for (const lid of leagueIds) {
    leagueFixtures.set(lid, await loadLeagueFixtures(lid));
  }

  // Flatten into a single chronological list with league IDs attached.
  const all: Array<MatchObservation & { leagueId: number }> = [];
  for (const [lid, arr] of leagueFixtures) {
    for (const m of arr) all.push({ ...m, leagueId: lid });
  }
  all.sort((a, b) => a.date.getTime() - b.date.getTime());

  const fitCache = new Map<string, FittedDixonColes | null>();
  const out: FixtureScoreResult = {
    total: 0,
    dcBrierSum: 0,
    baselineBrierSum: 0,
    dcCorrect: 0,
    baselineCorrect: 0,
    dcDrawProbWhenDraw: 0,
    dcDrawWhenDrawN: 0,
    skipped: 0,
    fitsRun: 0,
  };

  const baselinePred = predictedFromProbs(
    BASELINE_HOME,
    BASELINE_DRAW,
    BASELINE_AWAY,
  );

  for (const m of all) {
    const cacheKey = `${m.leagueId}-${isoWeekStart(m.date)}`;
    let model = fitCache.get(cacheKey);
    if (model === undefined) {
      const allLeague = leagueFixtures.get(m.leagueId) ?? [];
      const cutoff = new Date(`${isoWeekStart(m.date)}T00:00:00.000Z`);
      const training = allLeague.filter((m2) => m2.date < cutoff);
      if (training.length < 15) {
        fitCache.set(cacheKey, null);
        model = null;
      } else {
        const fit = fitDixonColes(training, cutoff, m.leagueId, {
          halfLifeDays: 90,
          maxIterations: 300,
        });
        fitCache.set(cacheKey, fit);
        model = fit;
        out.fitsRun++;
      }
    }
    if (!model) {
      out.skipped++;
      continue;
    }
    if (!model.attack.has(m.homeTeamId) || !model.attack.has(m.awayTeamId)) {
      out.skipped++;
      continue;
    }
    const pred = predictDixonColes(model, m.homeTeamId, m.awayTeamId);
    const actual: 'home_win' | 'draw' | 'away_win' =
      m.homeGoals > m.awayGoals
        ? 'home_win'
        : m.homeGoals < m.awayGoals
          ? 'away_win'
          : 'draw';
    const dcBrier = brier(
      pred.homeWinProb,
      pred.drawProb,
      pred.awayWinProb,
      actual,
    );
    const blBrier = brier(
      BASELINE_HOME,
      BASELINE_DRAW,
      BASELINE_AWAY,
      actual,
    );
    out.total++;
    out.dcBrierSum += dcBrier;
    out.baselineBrierSum += blBrier;
    const dcPred = predictedFromProbs(
      pred.homeWinProb,
      pred.drawProb,
      pred.awayWinProb,
    );
    if (dcPred === actual) out.dcCorrect++;
    if (baselinePred === actual) out.baselineCorrect++;
    if (actual === 'draw') {
      out.dcDrawProbWhenDraw += pred.drawProb;
      out.dcDrawWhenDrawN++;
    }
  }

  return out;
}

async function main() {
  console.log('Dixon-Coles Walk-Forward Backtest');
  console.log('=================================\n');

  try {
    const m = await runBacktest();

    if (m.total === 0) {
      console.error('');
      console.error(
        'No predictions had sufficient training data for the head-to-head benchmark.',
      );
      console.error(
        `  Skipped: ${m.skippedNoTraining} (insufficient league training set), ` +
          `${m.skippedNoTeam} (team unseen in league)`,
      );
      console.error('');
      console.error(
        'Falling back to fixture-based DC scoring (no ensemble comparison)...',
      );
      console.error('');
      const fb = await fixtureBasedBacktest();
      if (fb.total === 0) {
        console.error(
          'Fixture-based backtest also has no scoreable matches. ' +
            `(${fb.skipped} skipped, ${fb.fitsRun} fits attempted.)`,
        );
        console.error(
          'Need more FT fixtures with prior league history to run any backtest.',
        );
        process.exit(1);
      }
      console.log('---');
      console.log('FIXTURE-BASED DC BACKTEST (fallback, no ensemble compare)');
      console.log(`scored_fixtures:      ${fb.total}`);
      console.log(`skipped:              ${fb.skipped}`);
      console.log(`unique_fits:          ${fb.fitsRun}`);
      console.log(
        `dc_brier:             ${(fb.dcBrierSum / fb.total).toFixed(6)}`,
      );
      console.log(
        `baseline_brier:       ${(fb.baselineBrierSum / fb.total).toFixed(6)}`,
      );
      console.log(
        `dc_minus_baseline:    ${((fb.dcBrierSum - fb.baselineBrierSum) / fb.total).toFixed(6)}`,
      );
      console.log(
        `dc_accuracy:          ${((fb.dcCorrect / fb.total) * 100).toFixed(2)}%`,
      );
      console.log(
        `baseline_accuracy:    ${((fb.baselineCorrect / fb.total) * 100).toFixed(2)}%`,
      );
      if (fb.dcDrawWhenDrawN > 0) {
        console.log(
          `dc_draw_calibration:  ${((fb.dcDrawProbWhenDraw / fb.dcDrawWhenDrawN) * 100).toFixed(1)}% avg prob when draw occurs (n=${fb.dcDrawWhenDrawN})`,
        );
      }
      return;
    }

    const dcBrier = m.dcBrierSum / m.total;
    const storedBrier = m.storedBrierSum / m.total;
    const baselineBrier = m.baselineBrierSum / m.total;
    const dcAccuracy = (m.dcCorrect / m.total) * 100;
    const storedAccuracy = (m.storedCorrect / m.total) * 100;
    const baselineAccuracy = (m.baselineCorrect / m.total) * 100;

    console.log('---');
    console.log(`scored_predictions:   ${m.total}`);
    console.log(`skipped_no_training:  ${m.skippedNoTraining}`);
    console.log(`skipped_unseen_team:  ${m.skippedNoTeam}`);
    console.log(`unique_fits:          ${m.fitCacheSize}`);
    console.log(
      `total_fit_seconds:    ${(m.totalFitMs / 1000).toFixed(2)}`,
    );
    console.log(
      `total_predict_seconds:${(m.totalPredictMs / 1000).toFixed(3)}`,
    );
    console.log('');
    console.log(`dc_brier:             ${dcBrier.toFixed(6)}`);
    console.log(`stored_brier:         ${storedBrier.toFixed(6)}`);
    console.log(`baseline_brier:       ${baselineBrier.toFixed(6)}`);
    console.log(
      `dc_minus_stored:      ${(dcBrier - storedBrier).toFixed(6)}  ` +
        `(${dcBrier < storedBrier ? 'DC WINS' : 'STORED WINS'})`,
    );
    console.log(
      `dc_minus_baseline:    ${(dcBrier - baselineBrier).toFixed(6)}  ` +
        `(${dcBrier < baselineBrier ? 'DC beats trivial' : 'DC worse than trivial'})`,
    );
    console.log('');
    console.log(`dc_accuracy:          ${dcAccuracy.toFixed(2)}%`);
    console.log(`stored_accuracy:      ${storedAccuracy.toFixed(2)}%`);
    console.log(`baseline_accuracy:    ${baselineAccuracy.toFixed(2)}%`);
    console.log('');
    console.log('DC calibration (avg prob assigned when outcome occurs):');
    console.log(
      `  home_win: ${
        m.dcHomeWhenHomeN > 0
          ? ((m.dcHomeProbWhenHome / m.dcHomeWhenHomeN) * 100).toFixed(1)
          : '—'
      }% (n=${m.dcHomeWhenHomeN})`,
    );
    console.log(
      `  draw:     ${
        m.dcDrawWhenDrawN > 0
          ? ((m.dcDrawProbWhenDraw / m.dcDrawWhenDrawN) * 100).toFixed(1)
          : '—'
      }% (n=${m.dcDrawWhenDrawN})`,
    );
    console.log(
      `  away_win: ${
        m.dcAwayWhenAwayN > 0
          ? ((m.dcAwayProbWhenAway / m.dcAwayWhenAwayN) * 100).toFixed(1)
          : '—'
      }% (n=${m.dcAwayWhenAwayN})`,
    );
    console.log('');
    console.log('Per-league breakdown (top by sample size):');
    const perLeagueArr = Array.from(m.perLeague.entries())
      .map(([lid, v]) => ({
        leagueId: lid,
        n: v.n,
        dcBrier: v.dcSum / v.n,
        storedBrier: v.storedSum / v.n,
        dcAcc: (v.dcCorrect / v.n) * 100,
        storedAcc: (v.storedCorrect / v.n) * 100,
      }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12);
    console.log(
      `  ${'leagueId'.padEnd(10)} ${'n'.padStart(5)}  ${'dc_brier'.padStart(10)}  ${'stored_brier'.padStart(13)}  ${'dc_acc'.padStart(7)}  ${'stored_acc'.padStart(11)}`,
    );
    for (const r of perLeagueArr) {
      const winner = r.dcBrier < r.storedBrier ? '◀ DC' : '  ';
      console.log(
        `  ${String(r.leagueId).padEnd(10)} ${String(r.n).padStart(5)}  ${r.dcBrier.toFixed(6).padStart(10)}  ${r.storedBrier.toFixed(6).padStart(13)}  ${r.dcAcc.toFixed(1).padStart(6)}%  ${r.storedAcc.toFixed(1).padStart(10)}% ${winner}`,
      );
    }
  } catch (err) {
    console.error('FAIL');
    console.error(err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
