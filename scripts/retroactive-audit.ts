/**
 * Retroactive Audit Script
 *
 * Replays the new getPredictedResultFromProbs logic against historical predictions
 * to show what would have changed with the new draw-aware thresholds.
 */

import postgres from 'postgres';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres.agsbpjdhepiecefqupvc:MRalQyH6jPLaLczp@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?pgbouncer=true';

const sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });

// OLD logic: pure argmax
function oldPredictedResult(
  homeProb: number,
  drawProb: number,
  awayProb: number,
): string {
  if (drawProb >= homeProb && drawProb >= awayProb) return 'draw';
  if (homeProb >= awayProb) return 'home_win';
  return 'away_win';
}

// NEW logic: match-type aware draw thresholds (v2 - calibrated)
function newPredictedResult(
  homeProb: number,
  drawProb: number,
  awayProb: number,
): string {
  // 1. If draw is already the highest probability, always predict draw
  if (drawProb >= homeProb && drawProb >= awayProb) {
    return 'draw';
  }

  const maxWinProb = Math.max(homeProb, awayProb);
  const winSpread = Math.abs(homeProb - awayProb);

  // 2. VERY TIGHT MATCH: no clear favourite (max win prob < 0.40)
  //    AND draw is within 4pp of the leader AND draw is >= 0.30
  if (maxWinProb < 0.4 && drawProb >= 0.3 && maxWinProb - drawProb < 0.04) {
    return 'draw';
  }

  // 3. COMPETITIVE MATCH: slight favourite (max win prob 0.40-0.50)
  //    Only predict draw when both teams are essentially equal (spread < 0.05)
  //    AND draw probability is very strong (>= 0.32)
  if (maxWinProb <= 0.5 && winSpread < 0.05 && drawProb >= 0.32) {
    return 'draw';
  }

  // 3. COMPETITIVE MATCH: slight favourite (max win prob 0.42-0.50)
  //    Only predict draw when both teams are essentially equal (spread < 0.06)
  //    AND draw probability is strong (>= 0.30)
  if (maxWinProb <= 0.5 && winSpread < 0.06 && drawProb >= 0.3) {
    return 'draw';
  }

  // 4. Otherwise, pick the higher of home or away
  if (homeProb >= awayProb) return 'home_win';
  return 'away_win';
}

async function runRetroAudit() {
  const predictions = await sql`
    SELECT
      p.id,
      ht.name as home_team,
      at2.name as away_team,
      f.league_name,
      p.home_win_prob::numeric as home_prob,
      p.draw_prob::numeric as draw_prob,
      p.away_win_prob::numeric as away_prob,
      p.actual_result,
      p.actual_home_goals,
      p.actual_away_goals,
      p.confidence
    FROM predictions p
    INNER JOIN fixtures f ON p.fixture_id = f.id
    LEFT JOIN teams ht ON f.home_team_id = ht.id
    LEFT JOIN teams at2 ON f.away_team_id = at2.id
    WHERE p.resolved_at IS NOT NULL
    ORDER BY p.resolved_at DESC
  `;

  console.log('='.repeat(100));
  console.log('RETROACTIVE AUDIT: Old Logic vs New Logic');
  console.log('='.repeat(100));
  console.log('');

  let oldCorrect = 0;
  let newCorrect = 0;
  let changed = 0;

  console.log(
    'Match'.padEnd(40) +
      'H%   D%   A%   Old Pred   New Pred   Actual     Old✓  New✓  Changed',
  );
  console.log('-'.repeat(110));

  for (const p of predictions) {
    const h = Number(p.home_prob);
    const d = Number(p.draw_prob);
    const a = Number(p.away_prob);

    const oldPred = oldPredictedResult(h, d, a);
    const newPred = newPredictedResult(h, d, a);
    const actual = p.actual_result as string;

    const oldOk = oldPred === actual;
    const newOk = newPred === actual;
    const didChange = oldPred !== newPred;

    if (oldOk) oldCorrect++;
    if (newOk) newCorrect++;
    if (didChange) changed++;

    const matchName = `${(p.home_team || '').substring(0, 16)} v ${(p.away_team || '').substring(0, 16)}`;
    const score = `${p.actual_home_goals}-${p.actual_away_goals}`;

    console.log(
      `${matchName.padEnd(40)}` +
        `${(h * 100).toFixed(0).padStart(3)}  ${(d * 100).toFixed(0).padStart(3)}  ${(a * 100).toFixed(0).padStart(3)}  ` +
        `${oldPred.padEnd(10)} ${newPred.padEnd(10)} ${(actual + ' ' + score).padEnd(14)} ` +
        `${oldOk ? 'Y' : 'N'}     ${newOk ? 'Y' : 'N'}     ${didChange ? 'CHANGED' : '-'}`,
    );
  }

  console.log('');
  console.log('-'.repeat(110));
  console.log(`Total predictions: ${predictions.length}`);
  console.log(
    `OLD accuracy: ${oldCorrect}/${predictions.length} (${((oldCorrect / predictions.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `NEW accuracy: ${newCorrect}/${predictions.length} (${((newCorrect / predictions.length) * 100).toFixed(1)}%)`,
  );
  console.log(`Predictions changed: ${changed}`);
  console.log('');

  // Count prediction distributions
  let oldDraws = 0,
    newDraws = 0;
  for (const p of predictions) {
    const h = Number(p.home_prob);
    const d = Number(p.draw_prob);
    const a = Number(p.away_prob);
    if (oldPredictedResult(h, d, a) === 'draw') oldDraws++;
    if (newPredictedResult(h, d, a) === 'draw') newDraws++;
  }

  const actualDraws = predictions.filter(
    (p) => p.actual_result === 'draw',
  ).length;
  console.log('DRAW PREDICTION COMPARISON:');
  console.log(
    `Old logic predicted draws: ${oldDraws}/${predictions.length} (${((oldDraws / predictions.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `New logic predicted draws: ${newDraws}/${predictions.length} (${((newDraws / predictions.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Actual draws occurred: ${actualDraws}/${predictions.length} (${((actualDraws / predictions.length) * 100).toFixed(1)}%)`,
  );
  console.log('');

  await sql.end();
}

runRetroAudit().catch((err) => {
  console.error('Retroactive audit failed:', err);
  process.exit(1);
});
