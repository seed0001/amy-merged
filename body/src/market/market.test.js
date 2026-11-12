import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pUp, decide, kalshiFee } from './model.js';
import * as risk from './risk.js';
import { parseCoinbase, parseKraken } from './feed.js';

test('pUp is 50/50 at the strike and leans with price', () => {
  assert.equal(Math.round(pUp({ price: 100, strike: 100, sigmaPerMin: 0.001, minutesLeft: 8 }) * 100), 50);
  assert.ok(pUp({ price: 100.2, strike: 100, sigmaPerMin: 0.001, minutesLeft: 8 }) > 0.7);
  assert.ok(pUp({ price: 150, strike: 100, sigmaPerMin: 0.001, minutesLeft: 8 }) <= 0.97); // never certain
});

test('decide only bets when the edge beats fees and margin', () => {
  assert.equal(kalshiFee(0.5), 0.02);
  assert.equal(decide({ pModel: 0.52, yesAsk: 0.5, noAsk: 0.51 }).side, null);
  const d = decide({ pModel: 0.62, yesAsk: 0.52, noAsk: 0.49 });
  assert.equal(d.side, 'yes');
  assert.ok(d.edge > 0);
});

test('risk: stake capped at 2% and limits stop trading', () => {
  const limits = { ...risk.DEFAULT_LIMITS, bankroll: 100 };
  assert.ok(risk.size({ p: 0.9, price: 0.5, limits }) * 0.5 <= 2);
  const s = risk.freshState(Date.UTC(2026, 9, 29));
  const ctx = { asset: 'BTC', window: 1, quoteAgeMs: 100, feedGap: 0, spread: 0.02 };
  assert.ok(risk.check(s, ctx, limits).ok);
  assert.equal(risk.check(s, { ...ctx, quoteAgeMs: 9000 }, limits).reason, 'stale price feed');
  risk.opened(s, 'BTC', 1);
  assert.equal(risk.check(s, ctx, limits).reason, 'already in this window');
  risk.settled(s, { asset: 'BTC', window: 1, pnl: -6 }, limits);
  assert.match(risk.check(s, { ...ctx, window: 2 }, limits).reason, /halted: daily/);
  risk.rollover(s, Date.UTC(2026, 9, 30));
  assert.ok(risk.check(s, { ...ctx, window: 3 }, limits).ok); // daily halt clears the next day
});

test('feeds parse Coinbase and Kraken tickers', () => {
  assert.deepEqual(parseCoinbase({ channel: 'ticker', events: [{ tickers: [{ product_id: 'BTC-USD', price: '70000', best_bid: '69999', best_ask: '70001', best_bid_quantity: '1', best_ask_quantity: '2' }] }] })[0],
    { asset: 'BTC', price: 70000, bid: 69999, ask: 70001, bidQty: 1, askQty: 2 });
  assert.equal(parseKraken({ channel: 'ticker', type: 'update', data: [{ symbol: 'BTC/USD', last: 70002, bid: 70001, ask: 70003, bid_qty: 1, ask_qty: 1 }] })[0].price, 70002);
  assert.deepEqual(parseKraken({ channel: 'heartbeat' }), []);
});
