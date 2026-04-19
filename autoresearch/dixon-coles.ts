/**
 * Dixon-Coles model — pure implementation
 * =======================================
 *
 * Fits attack/defense ratings, home advantage, and the Dixon-Coles low-score
 * correlation parameter (ρ) jointly via maximum likelihood on a league's
 * historical fixtures, with exponential time decay.
 *
 * Reference: Dixon & Coles, "Modelling association football scores and
 * inefficiencies in the football betting market" (JRSS-C, 1997).
 *
 * Parameterisation (log-linear, so all params live on R, no positivity
 * constraints needed):
 *
 *   log λ_home_match = a_home + b_away + γ
 *   log λ_away_match = a_away + b_home
 *
 *   τ(g_h, g_a, λ_h, λ_a, ρ):
 *     (0,0): 1 - λ_h·λ_a·ρ
 *     (0,1): 1 + λ_h·ρ
 *     (1,0): 1 + λ_a·ρ
 *     (1,1): 1 - ρ
 *      else: 1
 *
 *   Joint log-likelihood for a match with weight w:
 *     w · [ g_h·η_h - exp(η_h) + g_a·η_a - exp(η_a) + log τ ]
 *   (constant log(g!) terms dropped — they don't affect the optimum.)
 *
 * Gauge: a and b are unidentified up to additive constants
 * (shift a by +c, b by -c, γ unchanged → λ unchanged). After fitting we
 * centre a and b to mean zero; γ absorbs the global level.
 *
 * Optimiser: Adam with analytical gradients (parameters ≈ 2·N_teams + 2,
 * which is small enough that any reasonable optimiser works).
 */

export interface MatchObservation {
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  date: Date;
}

export interface FittedDixonColes {
  attack: Map<number, number>; // teamId → log-attack rating
  defense: Map<number, number>; // teamId → log-defense rating
  gamma: number; // log home advantage
  rho: number; // Dixon-Coles low-score correlation
  trainedOn: number; // number of matches used
  iterations: number; // optimiser iterations actually run
  finalLoss: number; // negative log-likelihood at convergence
  asOf: Date;
  leagueId: number;
}

export interface DixonColesPrediction {
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
}

export interface FitOptions {
  /** Time-decay half-life in days. Dixon & Coles found optimum ≈ 90. */
  halfLifeDays?: number;
  /** Max optimiser iterations. */
  maxIterations?: number;
  /** Convergence threshold on the relative change in NLL. */
  tolerance?: number;
  /** Adam learning rate. */
  learningRate?: number;
  /** L2 regularisation toward 0 for a, b (shrinkage to league mean). */
  l2?: number;
  /** Bounds on ρ to keep τ positive. ρ ∈ [-0.2, 0.0] is empirically standard. */
  rhoMin?: number;
  rhoMax?: number;
  /** Verbose logging during fit. */
  verbose?: boolean;
}

const DEFAULT_OPTIONS: Required<FitOptions> = {
  halfLifeDays: 90,
  maxIterations: 400,
  tolerance: 1e-6,
  learningRate: 0.05,
  l2: 0.02,
  rhoMin: -0.2,
  rhoMax: 0.0,
  verbose: false,
};

// ─── Fit ────────────────────────────────────────────────────────────────

export function fitDixonColes(
  matches: MatchObservation[],
  asOf: Date,
  leagueId: number,
  opts: FitOptions = {},
): FittedDixonColes {
  const o = { ...DEFAULT_OPTIONS, ...opts };

  // ── Build team index ──
  const teamIds = new Set<number>();
  for (const m of matches) {
    teamIds.add(m.homeTeamId);
    teamIds.add(m.awayTeamId);
  }
  const teams = Array.from(teamIds).sort((a, b) => a - b);
  const N = teams.length;
  const idx = new Map<number, number>();
  for (let i = 0; i < N; i++) idx.set(teams[i], i);

  // ── Pre-compute per-match data with time weights ──
  const decayPerDay = Math.log(2) / o.halfLifeDays;
  const matchData: Array<{
    h: number; // home team idx
    a: number; // away team idx
    gh: number;
    ga: number;
    w: number;
  }> = [];
  for (const m of matches) {
    const h = idx.get(m.homeTeamId);
    const a = idx.get(m.awayTeamId);
    if (h === undefined || a === undefined) continue;
    if (m.homeGoals == null || m.awayGoals == null) continue;
    const daysAgo = (asOf.getTime() - m.date.getTime()) / (24 * 3600 * 1000);
    if (daysAgo < 0) continue; // future fixture, skip
    const w = Math.exp(-decayPerDay * daysAgo);
    matchData.push({
      h,
      a,
      gh: Math.max(0, Math.floor(m.homeGoals)),
      ga: Math.max(0, Math.floor(m.awayGoals)),
      w,
    });
  }

  // ── Initialise parameters ──
  // Start from empirical league averages so we converge fast.
  let totalGoalsW = 0;
  let totalHomeGoalsW = 0;
  let totalAwayGoalsW = 0;
  let totalW = 0;
  for (const m of matchData) {
    totalGoalsW += m.w * (m.gh + m.ga);
    totalHomeGoalsW += m.w * m.gh;
    totalAwayGoalsW += m.w * m.ga;
    totalW += m.w;
  }
  const avgHome = totalW > 0 ? totalHomeGoalsW / totalW : 1.4;
  const avgAway = totalW > 0 ? totalAwayGoalsW / totalW : 1.1;
  const initGamma = Math.log(Math.max(0.5, avgHome / Math.max(0.5, avgAway)));

  const a: Float64Array = new Float64Array(N); // attack (log)
  const b: Float64Array = new Float64Array(N); // defense (log)
  let gamma = initGamma;
  let rho = 0; // start without DC correction

  // Adam state
  const adam = (size: number) => ({
    m: new Float64Array(size),
    v: new Float64Array(size),
  });
  const sA = adam(N);
  const sB = adam(N);
  let mG = 0,
    vG = 0;
  let mR = 0,
    vR = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;

  let prevLoss = Infinity;
  let lastIter = 0;
  let lastLoss = Infinity;

  for (let iter = 1; iter <= o.maxIterations; iter++) {
    lastIter = iter;
    // ── Compute gradient and loss in one pass ──
    const gA = new Float64Array(N);
    const gB = new Float64Array(N);
    let gG = 0;
    let gR = 0;
    let nll = 0;

    for (const md of matchData) {
      const etaH = a[md.h] + b[md.a] + gamma;
      const etaA = a[md.a] + b[md.h];
      const lamH = Math.exp(etaH);
      const lamA = Math.exp(etaA);

      // Pure Poisson part of log-likelihood (constant log(g!) dropped):
      //   ℓ_pois = g_h·η_h - λ_h + g_a·η_a - λ_a
      let llPois = md.gh * etaH - lamH + md.ga * etaA - lamA;

      // Gradient of NLL w.r.t. η_h, η_a from Poisson:
      //   ∂(-ℓ_pois)/∂η_h = λ_h - g_h
      let dEtaH = lamH - md.gh;
      let dEtaA = lamA - md.ga;
      let dRho = 0;

      // ── Dixon-Coles τ correction (only low scores) ──
      if (md.gh <= 1 && md.ga <= 1) {
        let tau = 1;
        let dTauEtaH = 0;
        let dTauEtaA = 0;
        let dTauRho = 0;
        if (md.gh === 0 && md.ga === 0) {
          tau = 1 - lamH * lamA * rho;
          // ∂τ/∂η_h = -λ_h·λ_a·ρ ; same for η_a
          dTauEtaH = -lamH * lamA * rho;
          dTauEtaA = -lamH * lamA * rho;
          dTauRho = -lamH * lamA;
        } else if (md.gh === 0 && md.ga === 1) {
          tau = 1 + lamH * rho;
          dTauEtaH = lamH * rho;
          dTauRho = lamH;
        } else if (md.gh === 1 && md.ga === 0) {
          tau = 1 + lamA * rho;
          dTauEtaA = lamA * rho;
          dTauRho = lamA;
        } else {
          // (1, 1)
          tau = 1 - rho;
          dTauRho = -1;
        }
        const safeTau = Math.max(tau, 1e-10);
        llPois += Math.log(safeTau);
        // ∂(-log τ)/∂x = -dτ/dx / τ
        dEtaH += -dTauEtaH / safeTau;
        dEtaA += -dTauEtaA / safeTau;
        dRho += -dTauRho / safeTau;
      }

      nll -= md.w * llPois;

      // Accumulate parameter gradients (chain rule on η_h = a_h + b_a + γ etc.)
      gA[md.h] += md.w * dEtaH;
      gB[md.a] += md.w * dEtaH;
      gG += md.w * dEtaH;
      gA[md.a] += md.w * dEtaA;
      gB[md.h] += md.w * dEtaA;
      gR += md.w * dRho;
    }

    // L2 regularisation on a, b (shrink unknown teams to mean strength)
    if (o.l2 > 0) {
      for (let i = 0; i < N; i++) {
        nll += 0.5 * o.l2 * (a[i] * a[i] + b[i] * b[i]);
        gA[i] += o.l2 * a[i];
        gB[i] += o.l2 * b[i];
      }
    }

    // ── Adam updates ──
    const lrT =
      o.learningRate *
      Math.sqrt(1 - Math.pow(beta2, iter)) /
      (1 - Math.pow(beta1, iter));
    for (let i = 0; i < N; i++) {
      sA.m[i] = beta1 * sA.m[i] + (1 - beta1) * gA[i];
      sA.v[i] = beta2 * sA.v[i] + (1 - beta2) * gA[i] * gA[i];
      a[i] -= (lrT * sA.m[i]) / (Math.sqrt(sA.v[i]) + eps);

      sB.m[i] = beta1 * sB.m[i] + (1 - beta1) * gB[i];
      sB.v[i] = beta2 * sB.v[i] + (1 - beta2) * gB[i] * gB[i];
      b[i] -= (lrT * sB.m[i]) / (Math.sqrt(sB.v[i]) + eps);
    }
    mG = beta1 * mG + (1 - beta1) * gG;
    vG = beta2 * vG + (1 - beta2) * gG * gG;
    gamma -= (lrT * mG) / (Math.sqrt(vG) + eps);

    mR = beta1 * mR + (1 - beta1) * gR;
    vR = beta2 * vR + (1 - beta2) * gR * gR;
    rho -= (lrT * mR) / (Math.sqrt(vR) + eps);
    // Project ρ into safe interval after each step.
    if (rho < o.rhoMin) rho = o.rhoMin;
    if (rho > o.rhoMax) rho = o.rhoMax;

    // No mid-optimisation centring. The model's only gauge symmetry is
    // (a → a+c, b → b−c, γ unchanged). Subtracting meanA from `a` and
    // meanB from `b` independently is NOT a gauge transformation — it
    // breaks λ_a = exp(a_a + b_h), since there's no γ in λ_a to absorb
    // the shift. We rely on L2 regularisation to anchor the gauge during
    // optimisation, and centre once at the end for reporting.

    lastLoss = nll;
    if (o.verbose && iter % 25 === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[DC fit] iter=${iter} nll=${nll.toFixed(4)} γ=${gamma.toFixed(3)} ρ=${rho.toFixed(3)}`,
      );
    }
    const relChange = Math.abs(prevLoss - nll) / Math.max(1, Math.abs(prevLoss));
    if (relChange < o.tolerance && iter > 30) break;
    prevLoss = nll;
  }

  // Gauge fix for reporting: enforce mean(a) = 0 using the model's actual
  // symmetry a → a − c, b → b + c (which leaves both λ_h and λ_a unchanged
  // because every λ contains exactly one a-term and one b-term that move in
  // opposite directions).
  let meanA = 0;
  for (let i = 0; i < N; i++) meanA += a[i];
  meanA /= N;
  for (let i = 0; i < N; i++) {
    a[i] -= meanA;
    b[i] += meanA;
  }

  const attack = new Map<number, number>();
  const defense = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    attack.set(teams[i], a[i]);
    defense.set(teams[i], b[i]);
  }

  return {
    attack,
    defense,
    gamma,
    rho,
    trainedOn: matchData.length,
    iterations: lastIter,
    finalLoss: lastLoss,
    asOf,
    leagueId,
  };
}

// ─── Predict ─────────────────────────────────────────────────────────────

const FACT_CACHE: number[] = [1];
function factorial(n: number): number {
  if (n < FACT_CACHE.length) return FACT_CACHE[n];
  let f = FACT_CACHE[FACT_CACHE.length - 1];
  for (let k = FACT_CACHE.length; k <= n; k++) {
    f = f * k;
    FACT_CACHE.push(f);
  }
  return FACT_CACHE[n];
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

const MAX_GOALS_GRID = 10;

export function predictDixonColes(
  model: FittedDixonColes,
  homeTeamId: number,
  awayTeamId: number,
): DixonColesPrediction {
  // For unknown teams (e.g., promoted, no history in window) fall back to
  // mean strength (a = b = 0). With L2 regularisation, this gives a neutral
  // team that's near the league average.
  const aH = model.attack.get(homeTeamId) ?? 0;
  const bH = model.defense.get(homeTeamId) ?? 0;
  const aA = model.attack.get(awayTeamId) ?? 0;
  const bA = model.defense.get(awayTeamId) ?? 0;

  const lamH = Math.exp(aH + bA + model.gamma);
  const lamA = Math.exp(aA + bH);

  // Sum over scoreline grid with τ correction for low scores.
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let totalProb = 0;
  for (let i = 0; i <= MAX_GOALS_GRID; i++) {
    const pi = poissonPmf(i, lamH);
    for (let j = 0; j <= MAX_GOALS_GRID; j++) {
      const pj = poissonPmf(j, lamA);
      let p = pi * pj;
      if (i <= 1 && j <= 1) {
        let tau = 1;
        if (i === 0 && j === 0) tau = 1 - lamH * lamA * model.rho;
        else if (i === 0 && j === 1) tau = 1 + lamH * model.rho;
        else if (i === 1 && j === 0) tau = 1 + lamA * model.rho;
        else if (i === 1 && j === 1) tau = 1 - model.rho;
        p *= Math.max(tau, 0); // numerical floor
      }
      totalProb += p;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
    }
  }

  // Normalise (the truncated grid + τ correction means total isn't exactly 1).
  const safeTotal = totalProb > 0 ? totalProb : 1;
  return {
    homeWinProb: pHome / safeTotal,
    drawProb: pDraw / safeTotal,
    awayWinProb: pAway / safeTotal,
    expectedHomeGoals: lamH,
    expectedAwayGoals: lamA,
  };
}
