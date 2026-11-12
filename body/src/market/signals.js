import { realizedVol, momentum, bookImbalance } from './features.js';
import { pUp, decide, kalshiFee } from './model.js';
import * as risk from './risk.js';

// The quarter-hour loop (plan sections 3-6). Every few seconds it looks at the clock:
//  - a new 15-minute window: settle the last one, take the strike (price at the open);
//  - decideAtMinutesLeft before the close: freeze one call per asset (or a logged skip);
// Calls go out through post() (a text line) and, when allowed, speak() (one short spoken line).
// No language model anywhere in here, and nothing in here can throw into Amy: each step is caught
// and logged. Only paper mode exists until phase 3; there is no order code at all.

const WINDOW_MS = 15 * 60_000;
const TICK_MS = 5000;
const STRIKE_GRACE_MS = 30_000; // joined a window later than this: no strike, sit it out

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const pct = (p) => `${Math.round(p * 100)}%`;
const cents = (p) => `${Math.round(p * 100)}¢`;
const money = (d) => `${d < 0 ? '-' : '+'}$${Math.abs(d).toFixed(2)}`;

export function createEngine({
  feed,
  store,
  assets = ['BTC'],
  mode = 'paper',
  limits = risk.DEFAULT_LIMITS,
  decideAtMinutesLeft = 8,
  marketPrice = async () => null, // (asset, windowStart) => { yesAsk, noAsk } in 0-1, from Kalshi (phase 2)
  post = async () => {},
  speak = () => {},
  voice = 'off', // off | strong | all
  log = () => {}, // (type, details): pass events.activity
  now = Date.now,
}) {
  if (mode !== 'paper') throw new Error('Only paper mode exists until phase 3 (see docs/crypto-signals-plan.md)');
  const windows = {}; // asset -> { start, strike, decided, call }
  const state = store.load('risk') ?? risk.freshState(now());
  let lastWindow = null;
  let timer = null;
  let busy = false;
  let muted = voice === 'off';

  async function tick() {
    if (busy) return; // a slow Kalshi lookup never stacks ticks
    busy = true;
    try {
      const t = now();
      risk.rollover(state, t);
      const start = Math.floor(t / WINDOW_MS) * WINDOW_MS;
      if (lastWindow !== null && start !== lastWindow) risk.windowPassed(state);
      lastWindow = start;
      for (const asset of assets) {
        try {
          await step(asset, t, start);
        } catch (err) {
          log('error', { where: 'market', message: `${asset}: ${err.message}` });
        }
      }
      store.save('risk', state);
    } catch (err) {
      log('error', { where: 'market', message: err.message });
    } finally {
      busy = false;
    }
  }

  async function step(asset, t, start) {
    const w = windows[asset];
    if (!w || w.start !== start) {
      if (w) await settle(asset, w);
      const q = feed.quote(asset);
      const strike = q && q.ageMs <= limits.staleMs && t - start <= STRIKE_GRACE_MS ? q.price : null;
      windows[asset] = { start, strike, decided: false, call: null };
      return;
    }
    if (w.decided || w.strike == null) return;
    const minutesLeft = (start + WINDOW_MS - t) / 60_000;
    if (minutesLeft > decideAtMinutesLeft) return;
    w.decided = true;
    await decideWindow(asset, w, t, minutesLeft);
  }

  async function decideWindow(asset, w, t, minutesLeft) {
    const base = { asset, window: w.start, decidedAt: t, mode, strike: w.strike };
    const q = feed.quote(asset);
    const bars = feed.bars(asset);
    if (!q || q.ageMs > limits.staleMs) return record(w, { ...base, reason: 'skipped: stale feed' });
    if (bars.length < 31) return record(w, { ...base, reason: 'skipped: warming up' });

    const sigma = realizedVol(bars, 60);
    const p = pUp({ price: q.price, strike: w.strike, sigmaPerMin: sigma, minutesLeft });
    const call = { ...base, price: q.price, sigma, pModel: Math.round(p * 1000) / 1000, why: why(asset, bars, q, w.strike) };
    const market = await marketPrice(asset, w.start).catch(() => null);
    // No Kalshi price yet (phases 1-2): the call is still frozen and scored, just never staked.
    if (!market) return record(w, { ...call, mode: 'shadow', reason: 'no market price: scored, not staked' });

    call.pMarket = Math.round(((market.yesAsk + 1 - market.noAsk) / 2) * 1000) / 1000;
    const d = decide({ pModel: p, yesAsk: market.yesAsk, noAsk: market.noAsk });
    if (!d.side) return record(w, { ...call, reason: d.reason });
    const ok = risk.check(state, { asset, window: w.start, quoteAgeMs: q.ageMs, feedGap: q.gap, spread: market.yesAsk + market.noAsk - 1 }, limits);
    if (!ok.ok) return record(w, { ...call, reason: ok.reason });
    const contracts = risk.size({ p: d.side === 'yes' ? p : 1 - p, price: d.price, limits });
    if (contracts < 1) return record(w, { ...call, reason: 'stake rounds to zero' });
    risk.opened(state, asset, w.start);
    record(w, { ...call, side: d.side, contracts, cost: contracts * d.price + kalshiFee(d.price, contracts), edge: d.edge, reason: call.why });
  }

  // The plain-words "because" for a call: distance from the strike, momentum, book pressure.
  function why(asset, bars, q, strike) {
    const dist = ((q.price - strike) / strike) * 100;
    return `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}% vs strike, 15m ${(momentum(bars, 15) * 100).toFixed(2)}%, book ${bookImbalance(q.bidQty, q.askQty).toFixed(2)}`;
  }

  function record(w, call) {
    store.saveCall(call);
    w.call = call;
    log('market-call', { asset: call.asset, window: call.window, mode: call.mode, side: call.side ?? null, p: call.pModel ?? null, reason: call.reason });
    announce(call);
  }

  function announce(c) {
    const when = `${c.asset} 15m (${hhmm(c.window)}–${hhmm(c.window + WINDOW_MS)})`;
    if (c.pModel == null) return post(`${when} · no call · ${c.reason}`).catch(() => {});
    const lean = c.pModel >= 0.5 ? `UP ${pct(c.pModel)}` : `DOWN ${pct(1 - c.pModel)}`;
    const market = c.pMarket != null ? ` vs market ${cents(c.pMarket)}` : '';
    const stake = c.contracts ? ` · ${c.side.toUpperCase()} x${c.contracts} paper ($${c.cost.toFixed(2)}) · edge +${cents(c.edge)}` : ` · no stake (${c.reason})`;
    post(`${when} ${lean}${market}${stake} · ${c.why}`).catch(() => {});
    const strong = c.contracts > 0 && c.edge >= 0.04;
    if (!muted && (voice === 'all' || (voice === 'strong' && strong))) {
      speak(`Quick call: ${c.asset === 'BTC' ? 'Bitcoin' : c.asset} ${c.pModel >= 0.5 ? 'up' : 'down'}, ${Math.round(Math.max(c.pModel, 1 - c.pModel) * 100)} percent.`);
    }
  }

  // Score the window that just closed, from the last 1-minute bar inside it.
  async function settle(asset, w) {
    const c = w.call;
    if (!c || c.pModel == null) return;
    const bar = feed.bars(asset).find((b) => b.t === w.start + WINDOW_MS - 60_000);
    const close = bar?.c;
    if (!(close > 0)) {
      log('error', { where: 'market', message: `${asset} ${hhmm(w.start)}: no closing price, left unscored` });
      if (c.contracts) risk.settled(state, { asset, window: w.start, pnl: 0 }, limits);
      return;
    }
    const up = close > c.strike;
    const won = c.side === 'yes' ? up : !up;
    const pnl = c.contracts ? Math.round(((won ? c.contracts : 0) - c.cost) * 100) / 100 : 0;
    store.scoreCall({ asset, window: w.start, closePrice: close, outcome: up, pnl });
    if (c.contracts) risk.settled(state, { asset, window: w.start, pnl }, limits);
    const right = (c.pModel >= 0.5) === up;
    post(`${asset} ${hhmm(w.start)} closed ${up ? 'UP' : 'DOWN'} ${right ? '✅' : '❌'}${c.contracts ? ` · paper ${money(pnl)}` : ''}${state.halted ? ` · paused: ${state.halted}` : ''}`).catch(() => {});
  }

  const weekAgo = () => now() - 7 * 86400_000;

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
      log('market', { message: `Signals started (${mode}, ${assets.join(', ')})` });
    },
    stop() {
      clearInterval(timer);
      timer = null;
      log('market', { message: 'Signals stopped' });
    },
    running: () => Boolean(timer),
    mute: (on = true) => { muted = on; },
    // Owner kill switch. Clearing a halt is deliberately not offered to the chat tool.
    halt: (reason) => { risk.halt(state, reason); store.save('risk', state); },
    resume: () => { state.halted = null; store.save('risk', state); },
    status: () => ({ running: Boolean(timer), mode, assets, muted, risk: { ...state }, recent: store.recent(4), week: store.summary(weekAgo()) }),
    // One line for her prompt, so she knows it's running without live ticks in every reply.
    summaryLine() {
      if (!timer) return '';
      const last = store.recent(1)[0];
      const s = store.summary(weekAgo());
      const lastText = last?.p_model != null ? ` Last: ${last.asset} ${hhmm(last.window_start)} ${last.p_model >= 0.5 ? 'up' : 'down'} ${pct(Math.max(last.p_model, 1 - last.p_model))}${last.contracts ? `, ${last.side} x${last.contracts}` : ', no stake'}.` : '';
      return `Crypto signals running (${mode}, ${assets.join('/')}).${lastText} This week ${s.hits}/${s.scored} right${s.staked ? `, paper ${money(s.pnl)}` : ''}.${state.halted ? ` Paused: ${state.halted}.` : ''}`;
    },
    tick, // for tests
  };
}
