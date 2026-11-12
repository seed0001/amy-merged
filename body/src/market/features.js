// Pure maths for the 15-minute crypto calls (docs/crypto-signals-plan.md, section 4). No I/O, no
// clock: everything takes 1-minute bars ({ t, o, h, l, c, v }, oldest first) or numbers and returns
// numbers, so the live engine and scripts/backtest.js compute exactly the same thing.

// Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). Plenty for probabilities.
export function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

// Log returns between consecutive closes.
export function logReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].c > 0 && bars[i].c > 0) out.push(Math.log(bars[i].c / bars[i - 1].c));
  return out;
}

// Realized volatility per minute (stdev of 1m log returns) over the last `minutes` bars. 0 if too few.
export function realizedVol(bars, minutes = 60) {
  const r = logReturns(bars.slice(-(minutes + 1)));
  if (r.length < 10) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
}

// Log return over the last `minutes` bars (momentum). 0 if there isn't that much history.
export function momentum(bars, minutes) {
  if (bars.length <= minutes) return 0;
  const then = bars[bars.length - 1 - minutes].c;
  const now = bars[bars.length - 1].c;
  return then > 0 && now > 0 ? Math.log(now / then) : 0;
}

// Top-of-book pressure in [-1, 1]: positive when more size is waiting to buy than to sell.
export function bookImbalance(bidQty, askQty) {
  const total = Number(bidQty) + Number(askQty);
  return total > 0 ? (bidQty - askQty) / total : 0;
}

// Relative gap between two feeds' prices (Coinbase vs Kraken), for the "feeds disagree" guard.
export function feedGap(a, b) {
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.abs(a - b) / Math.min(a, b);
}
