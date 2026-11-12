import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// The engine's own database (data/market/market.db), separate from her memory DB so market data
// never bloats it. Every call is written before its window closes and scored after; no editing the
// past. Risk state is kept here too so limits survive a restart.

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      asset TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      decided_at INTEGER NOT NULL,
      mode TEXT NOT NULL,          -- shadow (no market price), paper, live
      strike REAL, price REAL, sigma REAL,
      p_model REAL, p_market REAL,
      side TEXT,                   -- yes, no, or NULL for a skip
      contracts INTEGER DEFAULT 0, cost REAL DEFAULT 0, edge REAL,
      reason TEXT,
      close_price REAL, outcome INTEGER, pnl REAL, scored_at INTEGER,
      UNIQUE (asset, window_start)
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO calls
    (asset, window_start, decided_at, mode, strike, price, sigma, p_model, p_market, side, contracts, cost, edge, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const score = db.prepare('UPDATE calls SET close_price = ?, outcome = ?, pnl = ?, scored_at = ? WHERE asset = ? AND window_start = ? AND scored_at IS NULL');

  return {
    saveCall: (c) => insert.run(c.asset, c.window, c.decidedAt, c.mode, c.strike ?? null, c.price ?? null, c.sigma ?? null,
      c.pModel ?? null, c.pMarket ?? null, c.side ?? null, c.contracts ?? 0, c.cost ?? 0, c.edge ?? null, c.reason ?? null),
    getCall: (asset, window) => db.prepare('SELECT * FROM calls WHERE asset = ? AND window_start = ?').get(asset, window),
    scoreCall: ({ asset, window, closePrice, outcome, pnl }) => score.run(closePrice, outcome ? 1 : 0, pnl, Date.now(), asset, window),
    recent: (n = 5) => db.prepare('SELECT * FROM calls ORDER BY window_start DESC LIMIT ?').all(n),
    // Brier score (lower is better) vs the market price and vs a coin flip, hit rate, P&L.
    summary(sinceMs = 0) {
      const rows = db.prepare('SELECT * FROM calls WHERE scored_at IS NOT NULL AND p_model IS NOT NULL AND window_start >= ?').all(sinceMs);
      const brier = (get) => rows.length ? rows.reduce((s, r) => s + (get(r) - r.outcome) ** 2, 0) / rows.length : null;
      const withMarket = rows.filter((r) => r.p_market != null);
      const staked = rows.filter((r) => r.side && r.contracts > 0);
      return {
        scored: rows.length,
        hits: rows.filter((r) => (r.p_model >= 0.5) === Boolean(r.outcome)).length,
        brier: brier((r) => r.p_model),
        brierCoinFlip: brier(() => 0.5),
        brierMarket: withMarket.length ? withMarket.reduce((s, r) => s + (r.p_market - r.outcome) ** 2, 0) / withMarket.length : null,
        staked: staked.length,
        wins: staked.filter((r) => r.pnl > 0).length,
        pnl: Math.round(staked.reduce((s, r) => s + r.pnl, 0) * 100) / 100,
      };
    },
    load: (key) => {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    },
    save: (key, value) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)),
    close: () => db.close(),
  };
}
