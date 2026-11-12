// Risk rules (plan section 6), enforced here in code. Nothing Amy says can change them: limits come
// from settings at startup, and the only runtime switches are halt() (stop) and resume (owner, via
// the dashboard or .env, not a voice command). State is plain JSON so store.js can persist it.

export const DEFAULT_LIMITS = {
  bankroll: 100, // dollars set aside for this, never more
  maxStakePct: 0.02, // per call
  kellyFraction: 0.25,
  dailyLossPct: 0.05,
  weeklyLossPct: 0.10,
  streakLimit: 5, // losses in a row...
  cooldownWindows: 4, // ...skip this many windows
  maxCallsPerDay: 20,
  maxSpread: 0.04, // yes ask + no ask - 1, in dollars
  staleMs: 5000,
  maxFeedGap: 0.0015, // Coinbase vs Kraken, relative
};

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekKey = (ms) => Math.floor((ms / 86400_000 + 3) / 7); // weeks starting Monday (UTC)

export function freshState(now = Date.now()) {
  return { day: dayKey(now), week: weekKey(now), dayPnl: 0, weekPnl: 0, callsToday: 0, streak: 0, cooldown: 0, halted: null, open: [] };
}

// Roll the day/week counters forward. A weekly-loss halt stays until the owner clears it.
export function rollover(state, now = Date.now()) {
  if (state.day !== dayKey(now)) {
    state.day = dayKey(now);
    state.dayPnl = 0;
    state.callsToday = 0;
    if (state.halted?.startsWith('daily')) state.halted = null;
  }
  if (state.week !== weekKey(now)) {
    state.week = weekKey(now);
    state.weekPnl = 0;
  }
  return state;
}

// May we stake on this window? ctx: { asset, window, quoteAgeMs, feedGap, spread }.
export function check(state, ctx, limits = DEFAULT_LIMITS) {
  if (state.halted) return { ok: false, reason: `halted: ${state.halted}` };
  if (state.dayPnl <= -limits.dailyLossPct * limits.bankroll) return { ok: false, reason: 'daily loss limit' };
  if (state.weekPnl <= -limits.weeklyLossPct * limits.bankroll) return { ok: false, reason: 'weekly loss limit' };
  if (state.cooldown > 0) return { ok: false, reason: `losing-streak cooldown (${state.cooldown} windows left)` };
  if (state.callsToday >= limits.maxCallsPerDay) return { ok: false, reason: 'max calls for today' };
  if (state.open.includes(`${ctx.asset}:${ctx.window}`)) return { ok: false, reason: 'already in this window' };
  if (!(ctx.quoteAgeMs <= limits.staleMs)) return { ok: false, reason: 'stale price feed' };
  if (ctx.feedGap > limits.maxFeedGap) return { ok: false, reason: 'feeds disagree' };
  if (ctx.spread != null && ctx.spread > limits.maxSpread) return { ok: false, reason: 'spread too wide' };
  return { ok: true };
}

// Contracts to buy at `price` (0-1) when we think the side wins with probability `p`: a quarter of
// Kelly, capped at maxStakePct of the bankroll. 0 means don't bother.
export function size({ p, price, limits = DEFAULT_LIMITS }) {
  if (!(price > 0 && price < 1) || !(p > price)) return 0;
  const kelly = (p - price) / (1 - price);
  const dollars = Math.min(kelly * limits.kellyFraction, limits.maxStakePct) * limits.bankroll;
  return Math.floor(dollars / price);
}

export function opened(state, asset, window) {
  state.open.push(`${asset}:${window}`);
  state.callsToday++;
}

// A staked call settled: book the P&L, track the streak, apply the limits.
export function settled(state, { asset, window, pnl }, limits = DEFAULT_LIMITS) {
  state.open = state.open.filter((k) => k !== `${asset}:${window}`);
  state.dayPnl += pnl;
  state.weekPnl += pnl;
  state.streak = pnl < 0 ? state.streak + 1 : 0;
  if (state.streak >= limits.streakLimit) {
    state.cooldown = limits.cooldownWindows;
    state.streak = 0;
  }
  if (state.weekPnl <= -limits.weeklyLossPct * limits.bankroll) state.halted ??= 'weekly loss limit, owner must re-enable';
  else if (state.dayPnl <= -limits.dailyLossPct * limits.bankroll) state.halted ??= 'daily loss limit, back tomorrow';
}

// Called once per new 15-minute window.
export function windowPassed(state) {
  if (state.cooldown > 0) state.cooldown--;
}

export function halt(state, reason) {
  state.halted = reason || 'stopped by owner';
}
