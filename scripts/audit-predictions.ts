/**
 * Prediction Audit Script
 *
 * Addresses client concerns:
 * 1. Is the model just picking favourites?
 * 2. Are draws being under-predicted?
 * 3. Is 75% accuracy realistic or cherry-picked?
 * 4. What is the actual performance breakdown?
 */

import postgres = require('postgres');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres.agsbpjdhepiecefqupvc:MRalQyH6jPLaLczp@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?pgbouncer=true';

const sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });

async function runAudit() {
  console.log('='.repeat(80));
  console.log('PREDICTION MODEL AUDIT REPORT');
  console.log('='.repeat(80));
  console.log('');

  // 1. Overall stats
  const overallStats = await sql`
    SELECT
      COUNT(*) as total_resolved,
      SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct,
      ROUND(AVG(CASE WHEN was_correct = true THEN 1.0 ELSE 0.0 END) * 100, 1) as accuracy_pct,
      ROUND(AVG(probability_accuracy::numeric), 4) as avg_brier_score,
      MIN(resolved_at) as first_resolved,
      MAX(resolved_at) as last_resolved
    FROM predictions
    WHERE resolved_at IS NOT NULL
  `;

  console.log('1. OVERALL PERFORMANCE');
  console.log('-'.repeat(40));
  console.log(`Total resolved predictions: ${overallStats[0].total_resolved}`);
  console.log(`Correct: ${overallStats[0].correct}`);
  console.log(`Accuracy: ${overallStats[0].accuracy_pct}%`);
  console.log(
    `Avg Brier Score: ${overallStats[0].avg_brier_score} (lower = better, 0.67 = random)`,
  );
  console.log(
    `Date range: ${overallStats[0].first_resolved} to ${overallStats[0].last_resolved}`,
  );
  console.log('');

  // 2. Predicted result distribution vs actual result distribution
  const predictedVsActual = await sql`
    SELECT
      -- What we predicted (argmax of probabilities)
      CASE 
        WHEN home_win_prob::numeric >= draw_prob::numeric AND home_win_prob::numeric >= away_win_prob::numeric THEN 'home_win'
        WHEN draw_prob::numeric >= home_win_prob::numeric AND draw_prob::numeric >= away_win_prob::numeric THEN 'draw'
        ELSE 'away_win'
      END as predicted_result,
      actual_result,
      COUNT(*) as count,
      SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct
    FROM predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY 
      CASE 
        WHEN home_win_prob::numeric >= draw_prob::numeric AND home_win_prob::numeric >= away_win_prob::numeric THEN 'home_win'
        WHEN draw_prob::numeric >= home_win_prob::numeric AND draw_prob::numeric >= away_win_prob::numeric THEN 'draw'
        ELSE 'away_win'
      END,
      actual_result
    ORDER BY predicted_result, actual_result
  `;

  console.log('2. PREDICTED vs ACTUAL RESULT DISTRIBUTION (Confusion Matrix)');
  console.log('-'.repeat(60));

  // Build confusion matrix
  const matrix: Record<string, Record<string, number>> = {
    home_win: { home_win: 0, draw: 0, away_win: 0 },
    draw: { home_win: 0, draw: 0, away_win: 0 },
    away_win: { home_win: 0, draw: 0, away_win: 0 },
  };

  for (const row of predictedVsActual) {
    if (matrix[row.predicted_result] && row.actual_result) {
      matrix[row.predicted_result][row.actual_result] = Number(row.count);
    }
  }

  console.log('                  ACTUAL:');
  console.log(
    'PREDICTED:     home_win    draw    away_win    TOTAL   Accuracy',
  );
  for (const pred of ['home_win', 'draw', 'away_win']) {
    const hw = matrix[pred].home_win;
    const d = matrix[pred].draw;
    const aw = matrix[pred].away_win;
    const total = hw + d + aw;
    const correct = matrix[pred][pred];
    const acc = total > 0 ? ((correct / total) * 100).toFixed(1) : 'N/A';
    console.log(
      `  ${pred.padEnd(12)} ${String(hw).padStart(8)} ${String(d).padStart(7)} ${String(aw).padStart(11)} ${String(total).padStart(8)}   ${acc}%`,
    );
  }
  console.log('');

  // 3. Prediction type breakdown
  const predictionDistribution = await sql`
    SELECT
      CASE 
        WHEN home_win_prob::numeric >= draw_prob::numeric AND home_win_prob::numeric >= away_win_prob::numeric THEN 'home_win'
        WHEN draw_prob::numeric >= home_win_prob::numeric AND draw_prob::numeric >= away_win_prob::numeric THEN 'draw'
        ELSE 'away_win'
      END as predicted_result,
      COUNT(*) as count,
      ROUND(COUNT(*)::numeric / (SELECT COUNT(*) FROM predictions WHERE resolved_at IS NOT NULL) * 100, 1) as pct
    FROM predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `;

  const actualDistribution = await sql`
    SELECT
      actual_result,
      COUNT(*) as count,
      ROUND(COUNT(*)::numeric / (SELECT COUNT(*) FROM predictions WHERE resolved_at IS NOT NULL) * 100, 1) as pct
    FROM predictions
    WHERE resolved_at IS NOT NULL AND actual_result IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `;

  console.log(
    '3. FAVOURITE-PICKING ANALYSIS (Predicted vs Actual Distribution)',
  );
  console.log('-'.repeat(60));
  console.log('Result       Predicted %    Actual %    Difference');

  const predDist: Record<string, number> = {};
  const actDist: Record<string, number> = {};
  for (const r of predictionDistribution)
    predDist[r.predicted_result] = Number(r.pct);
  for (const r of actualDistribution) actDist[r.actual_result] = Number(r.pct);

  for (const result of ['home_win', 'draw', 'away_win']) {
    const pred = predDist[result] || 0;
    const act = actDist[result] || 0;
    const diff = (pred - act).toFixed(1);
    console.log(
      `${result.padEnd(12)} ${String(pred).padStart(10)}%  ${String(act).padStart(8)}%  ${diff.padStart(10)}%`,
    );
  }
  console.log('');

  // 4. Is it just picking the favourite? Check dominant probability stats
  const favouriteBias = await sql`
    SELECT
      ROUND(GREATEST(home_win_prob::numeric, draw_prob::numeric, away_win_prob::numeric) * 100, 1) as dominant_prob_pct,
      COUNT(*) as count,
      SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct
    FROM predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `;

  console.log(
    '4. DOMINANT PROBABILITY DISTRIBUTION (How "decisive" are predictions?)',
  );
  console.log('-'.repeat(60));

  // Bucket into ranges
  const buckets: Record<string, { total: number; correct: number }> = {
    '33-40%': { total: 0, correct: 0 },
    '40-45%': { total: 0, correct: 0 },
    '45-50%': { total: 0, correct: 0 },
    '50-55%': { total: 0, correct: 0 },
    '55-60%': { total: 0, correct: 0 },
    '60-65%': { total: 0, correct: 0 },
    '65-70%': { total: 0, correct: 0 },
    '70-75%': { total: 0, correct: 0 },
    '75%+': { total: 0, correct: 0 },
  };

  for (const row of favouriteBias) {
    const p = Number(row.dominant_prob_pct);
    const c = Number(row.count);
    const cor = Number(row.correct);
    if (p < 40) {
      buckets['33-40%'].total += c;
      buckets['33-40%'].correct += cor;
    } else if (p < 45) {
      buckets['40-45%'].total += c;
      buckets['40-45%'].correct += cor;
    } else if (p < 50) {
      buckets['45-50%'].total += c;
      buckets['45-50%'].correct += cor;
    } else if (p < 55) {
      buckets['50-55%'].total += c;
      buckets['50-55%'].correct += cor;
    } else if (p < 60) {
      buckets['55-60%'].total += c;
      buckets['55-60%'].correct += cor;
    } else if (p < 65) {
      buckets['60-65%'].total += c;
      buckets['60-65%'].correct += cor;
    } else if (p < 70) {
      buckets['65-70%'].total += c;
      buckets['65-70%'].correct += cor;
    } else if (p < 75) {
      buckets['70-75%'].total += c;
      buckets['70-75%'].correct += cor;
    } else {
      buckets['75%+'].total += c;
      buckets['75%+'].correct += cor;
    }
  }

  console.log(
    'Dominant Prob    Count    Accuracy    (Higher prob = more "favourite-ish")',
  );
  for (const [range, data] of Object.entries(buckets)) {
    if (data.total > 0) {
      const acc = ((data.correct / data.total) * 100).toFixed(1);
      console.log(
        `  ${range.padEnd(12)} ${String(data.total).padStart(8)}    ${acc.padStart(7)}%`,
      );
    }
  }
  console.log('');

  // 5. Draw probability analysis - what draw probs are we assigning?
  const drawProbs = await sql`
    SELECT
      ROUND(draw_prob::numeric * 100, 0) as draw_pct,
      COUNT(*) as count,
      SUM(CASE WHEN actual_result = 'draw' THEN 1 ELSE 0 END) as actual_draws
    FROM predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `;

  console.log('5. DRAW PROBABILITY ANALYSIS');
  console.log('-'.repeat(60));
  console.log('Draw Prob %    Count    Actual Draws    Draw Rate');
  for (const row of drawProbs) {
    const drawRate =
      Number(row.count) > 0
        ? ((Number(row.actual_draws) / Number(row.count)) * 100).toFixed(1)
        : 'N/A';
    console.log(
      `  ${String(row.draw_pct).padStart(6)}%   ${String(row.count).padStart(6)}    ${String(row.actual_draws).padStart(12)}    ${drawRate.padStart(8)}%`,
    );
  }
  console.log('');

  // 6. Accuracy by confidence level
  const confidenceAccuracy = await sql`
    SELECT
      confidence,
      COUNT(*) as count,
      SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct,
      ROUND(AVG(CASE WHEN was_correct = true THEN 1.0 ELSE 0.0 END) * 100, 1) as accuracy_pct,
      ROUND(AVG(probability_accuracy::numeric), 4) as avg_brier
    FROM predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY confidence
    ORDER BY confidence
  `;

  console.log('6. CONFIDENCE CALIBRATION');
  console.log('-'.repeat(60));
  console.log('Confidence    Count    Correct    Accuracy    Avg Brier');
  for (const row of confidenceAccuracy) {
    console.log(
      `  ${String(row.confidence).padStart(6)}     ${String(row.count).padStart(5)}      ${String(row.correct).padStart(5)}      ${String(row.accuracy_pct).padStart(6)}%     ${row.avg_brier}`,
    );
  }
  console.log('');

  // 7. Accuracy over time (by week)
  const weeklyAccuracy = await sql`
    SELECT
      DATE_TRUNC('week', resolved_at) as week,
      COUNT(*) as count,
      SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct,
      ROUND(AVG(CASE WHEN was_correct = true THEN 1.0 ELSE 0.0 END) * 100, 1) as accuracy_pct
    FROM predictions
    WHERE resolved_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `;

  console.log('7. ACCURACY OVER TIME (Weekly)');
  console.log('-'.repeat(60));
  console.log('Week                  Count    Correct    Accuracy');
  for (const row of weeklyAccuracy) {
    const weekStr = new Date(row.week).toISOString().split('T')[0];
    console.log(
      `  ${weekStr}       ${String(row.count).padStart(5)}      ${String(row.correct).padStart(5)}      ${String(row.accuracy_pct).padStart(6)}%`,
    );
  }
  console.log('');

  // 8. League-level accuracy
  const leagueAccuracy = await sql`
    SELECT
      f.league_name,
      COUNT(*) as count,
      SUM(CASE WHEN p.was_correct = true THEN 1 ELSE 0 END) as correct,
      ROUND(AVG(CASE WHEN p.was_correct = true THEN 1.0 ELSE 0.0 END) * 100, 1) as accuracy_pct,
      SUM(CASE WHEN p.actual_result = 'draw' THEN 1 ELSE 0 END) as actual_draws,
      SUM(CASE WHEN 
        p.draw_prob::numeric >= p.home_win_prob::numeric AND 
        p.draw_prob::numeric >= p.away_win_prob::numeric 
        THEN 1 ELSE 0 END) as predicted_draws
    FROM predictions p
    INNER JOIN fixtures f ON p.fixture_id = f.id
    WHERE p.resolved_at IS NOT NULL
    GROUP BY f.league_name
    HAVING COUNT(*) >= 3
    ORDER BY count DESC
  `;

  console.log('8. LEAGUE-LEVEL BREAKDOWN (min 3 predictions)');
  console.log('-'.repeat(80));
  console.log(
    'League                              Count   Acc%   Actual Draws   Predicted Draws',
  );
  for (const row of leagueAccuracy) {
    const name = (row.league_name || 'Unknown').substring(0, 32).padEnd(32);
    console.log(
      `  ${name}  ${String(row.count).padStart(5)}  ${String(row.accuracy_pct).padStart(5)}%  ${String(row.actual_draws).padStart(12)}   ${String(row.predicted_draws).padStart(14)}`,
    );
  }
  console.log('');

  // 9. "Favourite" analysis: How often does the model pick the bookmaker favourite?
  const favouriteAlignment = await sql`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN 
        (home_win_prob::numeric >= draw_prob::numeric AND home_win_prob::numeric >= away_win_prob::numeric)
        THEN 1 ELSE 0 END) as predicted_home_wins,
      SUM(CASE WHEN 
        (away_win_prob::numeric >= draw_prob::numeric AND away_win_prob::numeric >= home_win_prob::numeric)
        THEN 1 ELSE 0 END) as predicted_away_wins,
      SUM(CASE WHEN 
        (draw_prob::numeric >= home_win_prob::numeric AND draw_prob::numeric >= away_win_prob::numeric)
        THEN 1 ELSE 0 END) as predicted_draws,
      ROUND(AVG(GREATEST(home_win_prob::numeric, away_win_prob::numeric)::numeric) * 100, 1) as avg_win_prob,
      ROUND(AVG(draw_prob::numeric) * 100, 1) as avg_draw_prob
    FROM predictions
    WHERE resolved_at IS NOT NULL
  `;

  console.log('9. FAVOURITE-PICKING SUMMARY');
  console.log('-'.repeat(60));
  const fa = favouriteAlignment[0];
  const totalPreds = Number(fa.total);
  console.log(`Total predictions: ${fa.total}`);
  console.log(
    `Predicted Home Wins: ${fa.predicted_home_wins} (${((Number(fa.predicted_home_wins) / totalPreds) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Predicted Away Wins: ${fa.predicted_away_wins} (${((Number(fa.predicted_away_wins) / totalPreds) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Predicted Draws: ${fa.predicted_draws} (${((Number(fa.predicted_draws) / totalPreds) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Win Predictions (H+A): ${Number(fa.predicted_home_wins) + Number(fa.predicted_away_wins)} (${(((Number(fa.predicted_home_wins) + Number(fa.predicted_away_wins)) / totalPreds) * 100).toFixed(1)}%)`,
  );
  console.log(`Avg max(home_prob, away_prob): ${fa.avg_win_prob}%`);
  console.log(`Avg draw probability: ${fa.avg_draw_prob}%`);
  console.log('');

  // 10. What happens when we predict a win but the actual result is a draw?
  const missedDraws = await sql`
    SELECT
      COUNT(*) as total_missed_draws,
      ROUND(AVG(draw_prob::numeric) * 100, 1) as avg_draw_prob_when_missed,
      ROUND(AVG(
        CASE 
          WHEN home_win_prob::numeric >= away_win_prob::numeric THEN home_win_prob::numeric
          ELSE away_win_prob::numeric
        END
      ) * 100, 1) as avg_winner_prob_when_missed
    FROM predictions
    WHERE resolved_at IS NOT NULL
      AND actual_result = 'draw'
      AND (
        (home_win_prob::numeric >= draw_prob::numeric AND home_win_prob::numeric >= away_win_prob::numeric)
        OR
        (away_win_prob::numeric >= draw_prob::numeric AND away_win_prob::numeric >= home_win_prob::numeric)
      )
  `;

  console.log('10. MISSED DRAWS ANALYSIS');
  console.log('-'.repeat(60));
  console.log(
    `Draws that occurred but we predicted a win: ${missedDraws[0].total_missed_draws}`,
  );
  console.log(
    `Avg draw probability we assigned in those games: ${missedDraws[0].avg_draw_prob_when_missed}%`,
  );
  console.log(
    `Avg winning-team probability we assigned: ${missedDraws[0].avg_winner_prob_when_missed}%`,
  );
  console.log('');

  // 11. Recent performance (last 30 predictions)
  const recentPerf = await sql`
    SELECT
      COUNT(*) as count,
      SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct,
      ROUND(AVG(CASE WHEN was_correct = true THEN 1.0 ELSE 0.0 END) * 100, 1) as accuracy_pct,
      SUM(CASE WHEN actual_result = 'draw' THEN 1 ELSE 0 END) as actual_draws,
      SUM(CASE WHEN 
        draw_prob::numeric >= home_win_prob::numeric AND 
        draw_prob::numeric >= away_win_prob::numeric 
        THEN 1 ELSE 0 END) as predicted_draws
    FROM (
      SELECT * FROM predictions
      WHERE resolved_at IS NOT NULL
      ORDER BY resolved_at DESC
      LIMIT 30
    ) recent
  `;

  console.log('11. RECENT PERFORMANCE (Last 30 predictions)');
  console.log('-'.repeat(60));
  console.log(
    `Correct: ${recentPerf[0].correct}/${recentPerf[0].count} (${recentPerf[0].accuracy_pct}%)`,
  );
  console.log(`Actual draws in sample: ${recentPerf[0].actual_draws}`);
  console.log(`Draws we predicted: ${recentPerf[0].predicted_draws}`);
  console.log('');

  // 12. Most recent 20 predictions detail
  const recentDetail = await sql`
    SELECT
      p.id,
      ht.name as home_team_name,
      at2.name as away_team_name,
      f.league_name,
      ROUND(p.home_win_prob::numeric * 100, 1) as home_pct,
      ROUND(p.draw_prob::numeric * 100, 1) as draw_pct,
      ROUND(p.away_win_prob::numeric * 100, 1) as away_pct,
      CASE 
        WHEN p.home_win_prob::numeric >= p.draw_prob::numeric AND p.home_win_prob::numeric >= p.away_win_prob::numeric THEN 'HOME'
        WHEN p.draw_prob::numeric >= p.home_win_prob::numeric AND p.draw_prob::numeric >= p.away_win_prob::numeric THEN 'DRAW'
        ELSE 'AWAY'
      END as predicted,
      UPPER(REPLACE(p.actual_result, '_win', '')) as actual,
      CASE WHEN p.was_correct THEN 'Y' ELSE 'N' END as correct,
      p.confidence,
      p.actual_home_goals,
      p.actual_away_goals,
      p.resolved_at::date as date
    FROM predictions p
    INNER JOIN fixtures f ON p.fixture_id = f.id
    LEFT JOIN teams ht ON f.home_team_id = ht.id
    LEFT JOIN teams at2 ON f.away_team_id = at2.id
    WHERE p.resolved_at IS NOT NULL
    ORDER BY p.resolved_at DESC
    LIMIT 20
  `;

  console.log('12. MOST RECENT 20 PREDICTIONS');
  console.log('-'.repeat(120));
  console.log(
    'Date        Home Team            Away Team            League              H%   D%   A%  Pred  Act   Score  OK  Conf',
  );
  for (const row of recentDetail) {
    const date = row.date
      ? new Date(row.date).toISOString().split('T')[0]
      : 'N/A';
    const home = (row.home_team_name || '').substring(0, 18).padEnd(18);
    const away = (row.away_team_name || '').substring(0, 18).padEnd(18);
    const league = (row.league_name || '').substring(0, 18).padEnd(18);
    const actual = (row.actual || '')
      .replace('HOME_', 'HOME')
      .replace('AWAY_', 'AWAY')
      .padEnd(5);
    const score = `${row.actual_home_goals ?? '?'}-${row.actual_away_goals ?? '?'}`;
    console.log(
      `${date}  ${home}  ${away}  ${league}  ${String(row.home_pct).padStart(4)} ${String(row.draw_pct).padStart(4)} ${String(row.away_pct).padStart(4)}  ${String(row.predicted).padEnd(5)} ${actual} ${score.padStart(5)}  ${row.correct}    ${row.confidence}`,
    );
  }
  console.log('');

  // Summary
  console.log('='.repeat(80));
  console.log('AUDIT SUMMARY');
  console.log('='.repeat(80));

  const drawPredPct = ((Number(fa.predicted_draws) / totalPreds) * 100).toFixed(
    1,
  );
  const actualDrawPct = actDist['draw'] || 0;

  console.log('');
  console.log('KEY FINDINGS:');
  console.log(`- Overall accuracy: ${overallStats[0].accuracy_pct}%`);
  console.log(
    `- Draw prediction rate: ${drawPredPct}% (actual draw rate: ${actualDrawPct}%)`,
  );
  console.log(
    `- Win predictions (H+A): ${(((Number(fa.predicted_home_wins) + Number(fa.predicted_away_wins)) / totalPreds) * 100).toFixed(1)}%`,
  );
  console.log(`- Avg draw probability assigned: ${fa.avg_draw_prob}%`);
  console.log(
    `- Missed draws (predicted win, got draw): ${missedDraws[0].total_missed_draws}`,
  );
  console.log(`- Recent form (last 30): ${recentPerf[0].accuracy_pct}%`);
  console.log('');

  await sql.end();
}

runAudit().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
