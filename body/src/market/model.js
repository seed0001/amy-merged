import { normalCdf } from './features.js';

// The prediction and the bet decision (plan section 4, steps A and C). Deterministic code, never the
// language model: Amy only reads out what this returns.

// Never claim more certainty than this, however far price is from the strike.
const P_FLOOR = 0.03;
const P_CEIL = 0.97;

// Step A: P(close > strike) from distance to the strike, time left and recent volatility.
// sigmaPerMin is realized vol of 1-minute log returns (features.realizedVol).
export function pUp({ price, strike, sigmaPerMin, minutesLeft }) {
  if (!(price > 0) || !(strike > 0)) return null;
  if (minutesLeft <= 0) return price > strike ? 1 : 0;
  const sigma = Math.max(sigmaPerMin, 1e-5); // a dead-flat hour shouldn't divide by zero
  const p = normalCdf(Math.log(price / strike) / (sigma * Math.sqrt(minutesLeft)));
  return Math.min(P_CEIL, Math.max(P_FLOOR, p));
}

// Kalshi trading fee in dollars for `contracts` at `price` (0-1): 0.07 x C x P x (1-P), rounded up
// to the cent. (verify against Kalshi's current fee schedule before trusting P&L numbers)
export function kalshiFee(price, contracts = 1, rate = 0.07) {
  return Math.ceil(rate * contracts * price * (1 - price) * 100 - 1e-9) / 100;
}

// Step C: is either side priced wrong by more than fees plus a safety margin? yesAsk/noAsk are what
// we'd pay (0-1). Returns { side: 'yes'|'no', price, edge } or { side: null, reason }.
export function decide({ pModel, yesAsk, noAsk, margin = 0.02 }) {
  if (pModel == null) return { side: null, reason: 'no model probability' };
  const options = [];
  if (yesAsk > 0 && yesAsk < 1) options.push({ side: 'yes', price: yesAsk, edge: pModel - yesAsk - kalshiFee(yesAsk) - margin });
  if (noAsk > 0 && noAsk < 1) options.push({ side: 'no', price: noAsk, edge: (1 - pModel) - noAsk - kalshiFee(noAsk) - margin });
  if (!options.length) return { side: null, reason: 'no market price' };
  const best = options.sort((a, b) => b.edge - a.edge)[0];
  if (best.edge <= 0) return { side: null, reason: `no edge (best ${best.side} ${(best.edge * 100).toFixed(1)}¢ after fees)` };
  return { ...best, edge: Math.round(best.edge * 1000) / 1000 };
}
