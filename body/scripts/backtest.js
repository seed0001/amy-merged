// Offline backtest of the volatility baseline (plan section 7) on public Coinbase 1-minute candles.
//   node scripts/backtest.js [asset=BTC] [days=30] [decideAtMinutesLeft=8]
// Walks every 15-minute window: strike = open of minute 0, decide with the price and volatility
// known at that moment (nothing from later), outcome = close of minute 14 vs strike. Prints Brier
// score vs a coin flip and a calibration table. It can't show an edge over Kalshi by itself: that
// needs Kalshi's historical prices (phase 2). Read-only; writes nothing.

import { fetchCandles } from '../src/market/feed.js';
import { realizedVol } from '../src/market/features.js';
import { pUp } from '../src/market/model.js';

const [asset = 'BTC', daysArg = '30', leftArg = '8'] = process.argv.slice(2);
const days = Math.max(1, Math.min(180, Number(daysArg) || 30));
const minutesLeft = Math.max(1, Math.min(14, Number(leftArg) || 8));
const decideMinute = 15 - minutesLeft; // decide at the close of minute (decideMinute - 1)

const end = Math.floor(Date.now() / 60_000) * 60;
const start = end - days * 86400;
const bars = [];
for (let from = start; from < end; from += 300 * 60) {
  const chunk = await fetchCandles(asset, from, Math.min(from + 300 * 60, end));
  for (const b of chunk) if (!bars.length || b.t > bars[bars.length - 1].t) bars.push(b);
  await new Promise((r) => setTimeout(r, 150)); // stay well under the public rate limit
}
console.log(`${asset}: ${bars.length} one-minute bars over ${days} days`);

const byTime = new Map(bars.map((b, i) => [b.t, i]));
const rows = [];
for (const b of bars) {
  if (b.t % (15 * 60_000) !== 0) continue;
  const i0 = byTime.get(b.t);
  const iDecide = byTime.get(b.t + (decideMinute - 1) * 60_000);
  const iClose = byTime.get(b.t + 14 * 60_000);
  if (i0 == null || iDecide == null || iClose == null || i0 < 61) continue; // gaps or no history
  const sigma = realizedVol(bars.slice(0, iDecide + 1), 60);
  const p = pUp({ price: bars[iDecide].c, strike: b.o, sigmaPerMin: sigma, minutesLeft });
  rows.push({ p, up: bars[iClose].c > b.o ? 1 : 0 });
}

const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
const brier = mean((r) => (r.p - r.up) ** 2);
const logLoss = -mean((r) => Math.log(r.up ? r.p : 1 - r.p));
console.log(`windows: ${rows.length}, up: ${(mean((r) => r.up) * 100).toFixed(1)}%`);
console.log(`Brier: model ${brier.toFixed(4)} vs coin flip 0.2500 (lower is better)`);
console.log(`log loss: ${logLoss.toFixed(4)} vs 0.6931`);
console.log(`hit rate: ${(mean((r) => ((r.p >= 0.5) === Boolean(r.up) ? 1 : 0)) * 100).toFixed(1)}%`);
console.log('\ncalibration (do our "70%" calls win ~70%?)');
for (let lo = 0; lo < 1; lo += 0.1) {
  const bucket = rows.filter((r) => r.p >= lo && r.p < lo + 0.1);
  if (!bucket.length) continue;
  const said = bucket.reduce((s, r) => s + r.p, 0) / bucket.length;
  const was = bucket.reduce((s, r) => s + r.up, 0) / bucket.length;
  console.log(`  ${(lo * 100).toFixed(0).padStart(2)}-${((lo + 0.1) * 100).toFixed(0)}%: n=${String(bucket.length).padStart(5)}  said ${(said * 100).toFixed(1)}%  happened ${(was * 100).toFixed(1)}%`);
}
console.log('\nNext gate: the same windows against Kalshi\'s own prices, after fees. Beating a coin flip is expected mid-window and is not an edge.');
