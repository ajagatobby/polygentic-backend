/**
 * Sanity check for the Dixon-Coles fitter on synthetic data.
 *
 * Generates a fake league of 12 teams with known true attack/defense ratings,
 * simulates a season of fixtures, fits the model, and checks that recovered
 * ratings correlate strongly with the truth.
 */

import {
  fitDixonColes,
  predictDixonColes,
  type MatchObservation,
} from './dixon-coles';

function poissonSample(lambda: number, rng: () => number): number {
  // Knuth's algorithm — fine for small λ.
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const rng = mulberry32(42);
  const N = 20; // bigger league
  const SEASONS = 6; // more rounds → less Poisson noise on γ
  // True parameters
  const trueA = new Array(N).fill(0).map(() => (rng() - 0.5) * 0.8);
  const trueB = new Array(N).fill(0).map(() => (rng() - 0.5) * 0.6);
  // Centre
  const meanA = trueA.reduce((s, x) => s + x, 0) / N;
  const meanB = trueB.reduce((s, x) => s + x, 0) / N;
  for (let i = 0; i < N; i++) {
    trueA[i] -= meanA;
    trueB[i] -= meanB;
  }
  const trueGamma = 0.25; // ~28% home advantage
  const trueRho = -0.08;

  // Simulate SEASONS double round-robins (each team plays each other home & away)
  const matches: MatchObservation[] = [];
  const startDate = new Date('2024-08-01').getTime();
  let day = 0;
  let totalGH = 0;
  let totalGA = 0;
  for (let s = 0; s < SEASONS; s++) {
    for (let h = 0; h < N; h++) {
      for (let a = 0; a < N; a++) {
        if (h === a) continue;
        const lamH = Math.exp(trueA[h] + trueB[a] + trueGamma);
        const lamA = Math.exp(trueA[a] + trueB[h]);
        const gh = poissonSample(lamH, rng);
        const ga = poissonSample(lamA, rng);
        totalGH += gh;
        totalGA += ga;
        matches.push({
          homeTeamId: h + 100,
          awayTeamId: a + 100,
          homeGoals: gh,
          awayGoals: ga,
          date: new Date(startDate + day * 24 * 3600 * 1000),
        });
        day++;
      }
    }
  }
  console.log(
    `Simulated ${matches.length} matches across ${N} teams over ${SEASONS} seasons`,
  );
  console.log(
    `Empirical home/away goal ratio: log(${(totalGH / matches.length).toFixed(3)}/${(totalGA / matches.length).toFixed(3)}) = ${Math.log(totalGH / totalGA).toFixed(3)} (true γ=${trueGamma})`,
  );

  // Fit
  const fitted = fitDixonColes(
    matches,
    new Date(startDate + (day + 7) * 24 * 3600 * 1000),
    1,
    {
      halfLifeDays: 365, // long half-life — we want all data weighted equally
      maxIterations: 1000,
      learningRate: 0.05,
      tolerance: 1e-8,
      l2: 0.0,
      verbose: false,
    },
  );
  console.log(
    `Fit converged in ${fitted.iterations} iterations, NLL=${fitted.finalLoss.toFixed(2)}, γ=${fitted.gamma.toFixed(3)} (true=${trueGamma.toFixed(3)}), ρ=${fitted.rho.toFixed(3)} (true=${trueRho.toFixed(3)})`,
  );

  // Compare recovered vs true ratings via correlation.
  const recoveredA = Array.from({ length: N }, (_, i) =>
    fitted.attack.get(i + 100)!,
  );
  const recoveredB = Array.from({ length: N }, (_, i) =>
    fitted.defense.get(i + 100)!,
  );

  function corr(x: number[], y: number[]): number {
    const mx = x.reduce((s, v) => s + v, 0) / x.length;
    const my = y.reduce((s, v) => s + v, 0) / y.length;
    let num = 0,
      dx = 0,
      dy = 0;
    for (let i = 0; i < x.length; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    return num / Math.sqrt(dx * dy);
  }

  const aCorr = corr(trueA, recoveredA);
  const bCorr = corr(trueB, recoveredB);
  console.log(`attack rating correlation:  ${aCorr.toFixed(3)}`);
  console.log(`defense rating correlation: ${bCorr.toFixed(3)}`);

  // Predict — make sure outputs are sensible probabilities
  const p = predictDixonColes(fitted, 100, 105);
  console.log(
    `\nSample prediction (team 100 home vs team 105 away): H=${p.homeWinProb.toFixed(3)} D=${p.drawProb.toFixed(3)} A=${p.awayWinProb.toFixed(3)} (sum=${(p.homeWinProb + p.drawProb + p.awayWinProb).toFixed(4)})`,
  );
  console.log(
    `   λ_h=${p.expectedHomeGoals.toFixed(3)}, λ_a=${p.expectedAwayGoals.toFixed(3)}`,
  );

  // Pass criteria
  const pass = aCorr > 0.7 && bCorr > 0.5 && Math.abs(fitted.gamma - trueGamma) < 0.15;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}: model recovers true parameters`);
  if (!pass) process.exit(1);
}

main();
