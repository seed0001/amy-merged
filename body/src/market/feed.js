import { feedGap } from './features.js';

// Live prices from Coinbase (primary) and Kraken (backup and cross-check), over their public
// WebSockets: no keys, no packages (Node 22+ has WebSocket built in). Keeps the latest quote per
// source and a rolling window of 1-minute bars per asset; reconnects with backoff; never throws
// into the caller. Message shapes are from the providers' docs (verify if a feed goes quiet).

const COINBASE_WS = 'wss://advanced-trade-ws.coinbase.com';
const KRAKEN_WS = 'wss://ws.kraken.com/v2';
const COINBASE_REST = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const KEEP_BARS = 240; // 4 hours of 1m bars
const STALE_MS = 5000;

// Coinbase ticker: { channel: 'ticker', events: [{ tickers: [{ product_id, price, best_bid, ... }] }] }
export function parseCoinbase(msg) {
  if (msg?.channel !== 'ticker') return [];
  return (msg.events ?? []).flatMap((e) => e.tickers ?? []).map((t) => ({
    asset: String(t.product_id).split('-')[0],
    price: Number(t.price),
    bid: Number(t.best_bid),
    ask: Number(t.best_ask),
    bidQty: Number(t.best_bid_quantity),
    askQty: Number(t.best_ask_quantity),
  })).filter((q) => q.price > 0);
}

// Kraken v2 ticker: { channel: 'ticker', type: 'snapshot'|'update', data: [{ symbol: 'BTC/USD', last, bid, ... }] }
export function parseKraken(msg) {
  if (msg?.channel !== 'ticker' || !Array.isArray(msg.data)) return [];
  return msg.data.map((t) => ({
    asset: String(t.symbol).split('/')[0],
    price: Number(t.last),
    bid: Number(t.bid),
    ask: Number(t.ask),
    bidQty: Number(t.bid_qty),
    askQty: Number(t.ask_qty),
  })).filter((q) => q.price > 0);
}

// Public 1-minute candles, oldest first (max ~350 per request). Used for warm-up and backtests.
export async function fetchCandles(asset, startSec, endSec) {
  const url = `${COINBASE_REST}/${asset}-USD/candles?start=${startSec}&end=${endSec}&granularity=ONE_MINUTE`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
  const { candles = [] } = await res.json();
  return candles
    .map((c) => ({ t: Number(c.start) * 1000, o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), v: Number(c.volume) }))
    .sort((a, b) => a.t - b.t);
}

export function createFeed({ assets = ['BTC'], onError = () => {}, now = Date.now } = {}) {
  const quotes = { coinbase: {}, kraken: {} }; // source -> asset -> { price, bid, ask, bidQty, askQty, ts }
  const bars = Object.fromEntries(assets.map((a) => [a, []]));
  const sockets = {};
  let running = false;

  function addTick(asset, price, ts) {
    const list = bars[asset];
    if (!list) return;
    const t = Math.floor(ts / 60_000) * 60_000;
    const last = list[list.length - 1];
    if (last?.t === t) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
    } else if (!last || t > last.t) {
      list.push({ t, o: price, h: price, l: price, c: price, v: 0 });
      if (list.length > KEEP_BARS) list.shift();
    }
  }

  function onQuotes(source, list) {
    const ts = now();
    for (const q of list) {
      quotes[source][q.asset] = { ...q, ts };
      // Bars follow Coinbase; Kraken fills in only while Coinbase is stale.
      if (source === 'coinbase' || !(ts - (quotes.coinbase[q.asset]?.ts ?? 0) <= STALE_MS)) addTick(q.asset, q.price, ts);
    }
  }

  function connect(source, url, subscribe, parse, delay = 1000) {
    if (!running) return;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      onError(`${source}: ${err.message}`);
      setTimeout(() => connect(source, url, subscribe, parse, Math.min(delay * 2, 30_000)), delay).unref?.();
      return;
    }
    sockets[source] = ws;
    let healthy = false;
    ws.onopen = () => subscribe.forEach((m) => ws.send(JSON.stringify(m)));
    ws.onmessage = (ev) => {
      try {
        const list = parse(JSON.parse(ev.data));
        if (list.length) {
          healthy = true;
          onQuotes(source, list);
        }
      } catch {} // one bad message isn't worth a reconnect
    };
    ws.onerror = () => {}; // onclose follows and handles it
    ws.onclose = () => {
      if (!running) return;
      onError(`${source} feed closed, reconnecting`);
      const next = healthy ? 1000 : Math.min(delay * 2, 30_000);
      setTimeout(() => connect(source, url, subscribe, parse, next), next).unref?.();
    };
  }

  return {
    async start() {
      running = true;
      // Warm the bars with the last 2 hours so volatility is meaningful from the first window.
      const end = Math.floor(now() / 1000);
      for (const a of assets) {
        try {
          bars[a] = (await fetchCandles(a, end - 120 * 60, end)).slice(-KEEP_BARS);
        } catch (err) {
          onError(`warm-up ${a}: ${err.message}`);
        }
      }
      const products = assets.map((a) => `${a}-USD`);
      connect('coinbase', COINBASE_WS, [
        { type: 'subscribe', product_ids: products, channel: 'ticker' },
        { type: 'subscribe', channel: 'heartbeats' }, // keeps the socket open when a product is quiet
      ], parseCoinbase);
      connect('kraken', KRAKEN_WS, [
        { method: 'subscribe', params: { channel: 'ticker', symbol: assets.map((a) => `${a}/USD`) } },
      ], parseKraken);
    },
    stop() {
      running = false;
      for (const ws of Object.values(sockets)) try { ws.close(); } catch {}
    },
    // The price to use right now, how old it is, and how far apart the two feeds are.
    quote(asset) {
      const t = now();
      const cb = quotes.coinbase[asset];
      const kr = quotes.kraken[asset];
      const cbFresh = cb && t - cb.ts <= STALE_MS;
      const primary = cbFresh ? cb : kr ?? cb;
      if (!primary) return null;
      const bothFresh = cbFresh && kr && t - kr.ts <= STALE_MS;
      return {
        ...primary,
        source: primary === cb ? 'coinbase' : 'kraken',
        ageMs: t - primary.ts,
        gap: bothFresh ? feedGap(cb.price, kr.price) : 0,
      };
    },
    bars: (asset) => bars[asset] ?? [],
  };
}
