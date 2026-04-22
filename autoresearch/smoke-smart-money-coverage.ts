/**
 * Measures how much the backdrop signal lifts coverage.
 *
 * Samples 20 upcoming fixtures from the DB (prefers leagues with known
 * season-long Polymarket activity — EPL, Serie A, La Liga, Bundesliga,
 * Brazil Serie A, MLS). For each fixture:
 *   1. Try the direct per-match signal path.
 *   2. If it returns null (no moneyline market or no qualifying sharps),
 *      try the backdrop path (outright markets for home/away teams).
 *
 * Reports: total fixtures × direct-hit × backdrop-hit × no-read.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from '../src/database/schema';
import { sql, and, eq, isNotNull, inArray } from 'drizzle-orm';
import { PolymarketDataService } from '../src/polymarket/services/polymarket-data.service';
import { SmartMoneySignalService } from '../src/polymarket/services/smart-money-signal.service';

const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

const client = (postgres as any)(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? 'require' : false,
  max: 5,
});
const db = drizzle(client, { schema });

const dataSvc = new PolymarketDataService();
const signalSvc = new SmartMoneySignalService(dataSvc);

const MONEYLINE_RX = /^Will\s+(.+?)\s+win\s+on\s+\d{4}-\d{2}-\d{2}\??$/i;

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|as|ss|us|rc|cd|ud|rcd|sd|ca|se)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  const overlap = [...wa].filter((w) => wb.has(w)).length;
  const denom = Math.min(wa.size, wb.size);
  return denom === 0 ? 0 : overlap / denom;
}

/** Mirror of AgentsService.computeSmartMoneySignal, simplified for offline use. */
async function tryDirectSignal(fixtureId: number) {
  const linked = await db
    .select({
      conditionId: schema.polymarketMarkets.conditionId,
      marketQuestion: schema.polymarketMarkets.marketQuestion,
    })
    .from(schema.polymarketMarkets)
    .where(
      and(
        eq(schema.polymarketMarkets.fixtureId, fixtureId),
        isNotNull(schema.polymarketMarkets.conditionId),
      ),
    );
  if (linked.length === 0) return { hit: false, reason: 'no PM market linked' };

  const [fx] = await db
    .select({
      homeTeamId: schema.fixtures.homeTeamId,
      awayTeamId: schema.fixtures.awayTeamId,
    })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.id, fixtureId))
    .limit(1);
  if (!fx) return { hit: false, reason: 'fixture missing' };

  const teamRows = await db
    .select({ id: schema.teams.id, name: schema.teams.name })
    .from(schema.teams)
    .where(inArray(schema.teams.id, [fx.homeTeamId, fx.awayTeamId]));
  const home = teamRows.find((t: any) => t.id === fx.homeTeamId);
  const away = teamRows.find((t: any) => t.id === fx.awayTeamId);

  const cands: any[] = [];
  for (const m of linked) {
    const match = (m.marketQuestion ?? '').match(MONEYLINE_RX);
    if (!match) continue;
    const team = match[1].trim();
    const hs = similarity(team, home?.name ?? '');
    const as_ = similarity(team, away?.name ?? '');
    if (Math.max(hs, as_) < 0.5) continue;
    cands.push({
      conditionId: m.conditionId,
      side: hs >= as_ ? 'home' : 'away',
      sim: Math.max(hs, as_),
    });
  }
  if (cands.length === 0) return { hit: false, reason: 'no moneyline' };

  cands.sort((a, b) =>
    a.side !== b.side ? (a.side === 'home' ? -1 : 1) : b.sim - a.sim,
  );
  const sig = await signalSvc.computeSignal(cands[0].conditionId, {
    minLifetimePnl: 5_000,
    minLifetimeRoi: 0.05,
    minResolvedBets: 10,
    minSharpCount: 2,
    minPositionMultiple: 0.3,
  });
  if (sig.leanScore == null)
    return { hit: false, reason: 'no qualifying sharps on direct' };
  return {
    hit: true,
    kind: 'direct',
    leanScore: sig.leanScore,
    sharpCount: sig.sharpCount,
    signalConfidence: sig.signalConfidence,
  };
}

async function tryBackdropSignal(homeTeamId: number, awayTeamId: number) {
  const POSITIVE_OUTRIGHT_TYPES = [
    'league_winner',
    'qualification',
    'top_4',
    'tournament_winner',
  ];
  const markets = await db
    .select({
      conditionId: schema.polymarketMarkets.conditionId,
      teamId: schema.polymarketMarkets.teamId,
      marketQuestion: schema.polymarketMarkets.marketQuestion,
    })
    .from(schema.polymarketMarkets)
    .where(
      and(
        isNotNull(schema.polymarketMarkets.conditionId),
        isNotNull(schema.polymarketMarkets.teamId),
        inArray(schema.polymarketMarkets.teamId, [homeTeamId, awayTeamId]),
        inArray(schema.polymarketMarkets.marketType, POSITIVE_OUTRIGHT_TYPES),
      ),
    );
  if (markets.length === 0)
    return { hit: false, reason: 'no outright markets for teams' };

  let homeConv = 0,
    awayConv = 0,
    homeDol = 0,
    awayDol = 0,
    totalSharps = 0,
    contributing = 0;
  for (const m of markets) {
    if ((m.marketQuestion ?? '').toLowerCase().includes('relegat')) continue;
    const sig = await signalSvc.computeSignal(m.conditionId as string, {
      minLifetimePnl: 5_000,
      minLifetimeRoi: 0.05,
      minResolvedBets: 10,
      minSharpCount: 2,
      minPositionMultiple: 0.3,
    });
    if (sig.leanScore == null) continue;
    contributing++;
    const dol = sig.sharpDollarsOutcome0 + sig.sharpDollarsOutcome1;
    const conv = sig.leanScore * dol;
    if (m.teamId === homeTeamId) {
      homeConv += conv;
      homeDol += dol;
    } else if (m.teamId === awayTeamId) {
      awayConv += conv;
      awayDol += dol;
    }
    totalSharps += sig.sharpCount;
  }
  if (contributing === 0) return { hit: false, reason: 'no qualifying sharps on outrights' };

  const nh = homeDol > 0 ? homeConv / homeDol : 0;
  const na = awayDol > 0 ? awayConv / awayDol : 0;
  const lean = Math.max(-1, Math.min(1, (nh - na) / 2));
  const conf = Math.min(1, totalSharps / 15) * Math.abs(lean);
  return {
    hit: true,
    kind: 'backdrop',
    leanScore: lean,
    sharpCount: totalSharps,
    signalConfidence: conf,
    contributingMarkets: contributing,
  };
}

async function main() {
  const TARGET_LEAGUES = [39, 135, 140, 78, 61, 71, 253, 262, 848, 2, 3]; // EPL, Serie A, La Liga, Bundesliga, Ligue 1, Brazil, MLS, LigaMX, UECL, UCL, UEL

  const sample = (await db.execute(sql`
    SELECT f.id, f.home_team_id, f.away_team_id, f.date, f.league_name,
           ht.name AS home_name, at.name AS away_name
    FROM fixtures f
    JOIN teams ht ON f.home_team_id = ht.id
    JOIN teams at ON f.away_team_id = at.id
    WHERE f.status = 'NS'
      AND f.date >= now()
      AND f.date <= now() + INTERVAL '14 days'
      AND f.league_id = ANY(${sql`ARRAY[${sql.join(TARGET_LEAGUES.map((l) => sql`${l}`), sql`, `)}]::int[]`})
    ORDER BY f.date ASC
    LIMIT 20
  `)) as any[];

  console.log(`Testing ${sample.length} upcoming fixtures from major leagues:\n`);

  let directHits = 0;
  let backdropHits = 0;
  let noRead = 0;

  for (const f of sample) {
    const direct = await tryDirectSignal(f.id);
    let signal: any = direct;
    if (!direct.hit) {
      const bd = await tryBackdropSignal(f.home_team_id, f.away_team_id);
      signal = bd;
    }

    const label = `${f.home_name} vs ${f.away_name} (${f.league_name})`.padEnd(
      60,
    );
    if (signal.hit) {
      if (signal.kind === 'direct') {
        directHits++;
        console.log(
          `  ✓ DIRECT   ${label}  lean=${signal.leanScore.toFixed(2)} sharps=${signal.sharpCount}`,
        );
      } else {
        backdropHits++;
        console.log(
          `  ◆ BACKDROP ${label}  lean=${signal.leanScore.toFixed(2)} sharps=${signal.sharpCount} mkts=${signal.contributingMarkets}`,
        );
      }
    } else {
      noRead++;
      console.log(`  ✗ no read  ${label}  (${signal.reason})`);
    }
  }

  console.log('');
  console.log('═══ Coverage summary ═══');
  console.log(`Total sampled:        ${sample.length}`);
  console.log(
    `Direct hits:          ${directHits}  (${((directHits / sample.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Backdrop hits:        ${backdropHits}  (${((backdropHits / sample.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Combined coverage:    ${directHits + backdropHits}  (${(((directHits + backdropHits) / sample.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `No read:              ${noRead}  (${((noRead / sample.length) * 100).toFixed(1)}%)`,
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
