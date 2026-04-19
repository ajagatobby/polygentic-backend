/**
 * End-to-end smoke test for SmartMoneySignalService.
 *
 * Picks the most-traded active Polymarket market (where holder/positions
 * data actually exists) and runs the signal computation. Validates the
 * service hangs together — does NOT validate signal quality (that needs a
 * proper backtest).
 */

import 'dotenv/config';
import axios from 'axios';
import { PolymarketDataService } from '../src/polymarket/services/polymarket-data.service';
import { SmartMoneySignalService } from '../src/polymarket/services/smart-money-signal.service';

async function pickTopMarket(): Promise<{ conditionId: string; question: string } | null> {
  const r = await axios.get('https://gamma-api.polymarket.com/markets', {
    params: {
      active: 'true',
      closed: 'false',
      limit: 10,
      order: 'volume24hr',
      ascending: 'false',
    },
    timeout: 15000,
  });
  const m = (r.data ?? []).find((x: any) => x.conditionId);
  if (!m) return null;
  return { conditionId: m.conditionId, question: m.question };
}

async function main() {
  const data = new PolymarketDataService();
  const signal = new SmartMoneySignalService(data);

  const top = await pickTopMarket();
  if (!top) {
    console.error('Could not find an active high-volume Polymarket market.');
    process.exit(1);
  }
  console.log(`Test market: "${top.question}"`);
  console.log(`Condition:   ${top.conditionId}\n`);

  const t0 = Date.now();
  // Use looser thresholds for the smoke test — the ALL-time PnL of $50k can
  // exclude even legitimate sharps on smaller markets.
  const result = await signal.computeSignal(top.conditionId, {
    minLifetimePnl: 5_000,
    minLifetimeRoi: 0.05,
    minResolvedBets: 10,
    minSharpCount: 1,
    minPositionMultiple: 0.3,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Computed in ${elapsed}s\n`);

  console.log('=== Smart Money Signal ===');
  console.log(
    `leanScore:          ${result.leanScore == null ? 'null (no read)' : result.leanScore.toFixed(3)}`,
  );
  console.log(`signalConfidence:   ${result.signalConfidence.toFixed(3)}`);
  console.log(`sharpCount:         ${result.sharpCount}`);
  console.log(
    `dollars on outcome 0 (${result.outcome0Name}): $${result.sharpDollarsOutcome0.toFixed(0)}`,
  );
  console.log(
    `dollars on outcome 1 (${result.outcome1Name}): $${result.sharpDollarsOutcome1.toFixed(0)}`,
  );
  console.log('');
  if (result.topSharps.length > 0) {
    console.log('Top contributing sharps:');
    for (const s of result.topSharps) {
      console.log(
        `  ${s.name.padEnd(20)} side=${s.outcomeIndex === 0 ? 'YES' : 'NO '} ` +
          `bet=$${s.amount.toFixed(0).padStart(10)} ` +
          `lifetimePnl=$${s.lifetimePnl.toFixed(0).padStart(10)} ` +
          `ROI=${(s.lifetimeRoi * 100).toFixed(1)}% ` +
          `posMult=${s.positionMultiple.toFixed(2)}x`,
      );
    }
  } else {
    console.log(
      '(no qualifying sharps under current thresholds — try a more popular market or loosen thresholds)',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
