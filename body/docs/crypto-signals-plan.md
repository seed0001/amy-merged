# 15-minute crypto calls: system plan (for Owner to review)

Status: **starter code written, not wired in yet.** Written by the doctor on 2026-10-29 from the voice
conversation with Owner and friend_6. Items marked *(verify)* came from memory without a live web
check, so confirm them on the provider's site before building.

- Sections 0–9: the system design (what, why, risk rules, proof gates).
- **Section 10: exactly how it plugs into Amy, with code outlines for each existing file.**
- **Section 11: running it in the background without slowing or breaking her replies.**
- **Section 12: what's already written under `src/market/` and `scripts/backtest.js`, and how to try it.**

---

## 0. The honest bit first

- In the call it sounded like "Kalshi bots for prediction trading". That points at **Kalshi's
  15-minute crypto up/down markets**: a yes/no contract on whether BTC (or ETH, SOL...) ends the
  15-minute window above where it started. This plan targets that, with spot price data from a big
  exchange as the input. If you meant plain spot or futures trading instead, sections 1, 3 and 5
  still apply. Only the "what we trade" part changes.
- On a 15-minute horizon, crypto direction is close to a coin flip. These markets are full of bots
  with faster data than a home PC. **The thing we trade is not "up or down" but "is the market's
  price wrong by more than the fees".** If the contract says 52¢ and we think 55%, that's a small
  edge. At 50¢ vs our 51%, there's nothing after fees.
- Most bots that "make real money" are market makers or speed plays, not predictors. Expect a
  model that's slightly better than the market at best. The plan below proves that with recorded
  data **before** any money goes in, and stops if the proof doesn't show up.
- **Amy's language model does not make the prediction.** LLMs are bad at numbers and can make
  things up. A small deterministic model in code makes each call. Amy reads it out, explains it,
  and keeps score. Her claim check already stops her from saying things her tools didn't return.

---

## 1. Data sources

| What | Source | Key needed? | Notes |
|---|---|---|---|
| Live spot price, trades, volume | **Coinbase Advanced Trade WebSocket** (`ticker`, `market_trades`, `candles`) | No, public market data *(verify)* | Coinbase is one of the main inputs to the CF Benchmarks index Kalshi's crypto markets settle on *(verify)*, so it tracks the settlement price closely. US-friendly. |
| Order book (depth) | Coinbase `level2` channel | No *(verify)* | Gives bid/ask imbalance. Book history isn't sold cheaply, so **we record our own from day one**. |
| Backup price feed | **Kraken WebSocket v2** (public) | No | Used when Coinbase drops. Also used to cross-check bad ticks. |
| Historical candles (for backtests) | Coinbase REST candles (1-minute) | No | Free, rate limited. Pull months of 1m BTC/ETH/SOL. |
| The contract itself: price, book, open/close times, strike | **Kalshi Trade API** (REST + WebSocket) | **Yes**, a Kalshi API key | Market price = the crowd's probability. Needed to find an edge and, later, to place orders. |
| Kalshi history of settled 15m markets | Kalshi REST (markets / trades / candlesticks) | Yes | Shows how often the market price was right, which is the baseline to beat. |
| Optional later: funding rate, open interest | Derivatives exchanges' public APIs | No | Many are geo-blocked in the US (Binance global, Bybit). Skip in v1. |

**Not recommended:** Binance.com (blocked for US residents). Polymarket's 15-minute markets
(crypto wallet, US access limits *(verify)*).

---

## 2. Accounts and keys Owner needs to set up

1. **Kalshi account** (kalshi.com): ID check (KYC), US resident, bank funding. Fund only money
   you're fine losing completely.
2. **Kalshi API key:** account settings → API keys → create. You get a **Key ID** and a
   **private key file (RSA, .pem)** that downloads once *(verify)*. Requests are signed with that key,
   and Node's built-in `crypto` can do the signing, so no new packages.
   - Put the `.pem` **outside the project**, e.g. `%LOCALAPPDATA%\NewChamp\kalshi.pem`, next to her
     other credentials. Never put it in `data/` or the repo.
   - In `.env`: `KALSHI_KEY_ID=...` and `KALSHI_KEY_PATH=...` (Owner adds these; the doctor doesn't
     touch `.env`).
3. **Kalshi demo account** (separate signup on their demo environment, fake money) *(verify)*,
   with its own API key. All paper trading (phase 2) runs here.
4. **Coinbase:** no account needed for the public feeds. You'd need a Coinbase Developer
   Platform key only if you later want to trade spot, which this plan doesn't.

---

## 3. Feeding the data to Amy continuously

The key rule: **live data does not go into every prompt.** Ticks every second would fill her
context and slow every reply. A separate engine runs alongside her, and she gets only short summaries.

```
Coinbase WS ─┐                      ┌─► data/market/market.db (1m bars, book snapshots, calls, outcomes)
Kraken WS ───┼─► src/market/feed.js ┤
Kalshi WS ───┘   (reconnect, stale   └─► in-memory rolling window (last ~2h of 1s/1m bars + top-of-book)
                  check, dedupe)                    │
                                                    ▼
                         src/market/signals.js: at each window open (:00 :15 :30 :45)
                         and again mid-window → features.js → model.js → risk.js
                                                    │
                                   call {asset, side, p_model, p_market, edge, stake, reason}
                                                    │
               ┌────────────────────┬───────────────┼──────────────────────┐
               ▼                    ▼               ▼                      ▼
     #signals text channel   one-line voice cue   'market' tool       continuity line
     (always, quiet)         (only if allowed     (she can look up    ("Signals running: last
                             and the room is      status/score when   call BTC up 57%, 31-24
                             quiet)               asked)              this week")
```

- Runs in-process, started from `index.js` like the dashboard, only if `MARKET_ENABLED=on`.
- Uses Node's built-in `WebSocket` and `crypto`, so **no new packages** (needs Node 22+; check `node -v`).
- **Stale data guard:** if the newest tick is over 5 seconds old, or the feeds disagree by more
  than a set amount, no call is made that window, and it's logged as "skipped: stale".
- Separate database file (`data/market/market.db`) so market data never bloats her memory DB.

---

## 4. Prediction logic

### How a 15-minute up/down contract works
At the window open, the strike is that moment's index price. At close, YES pays $1 if the price is
above the strike. Our job: estimate **P(close > strike)** and compare it with the YES price.

### Model, in three steps (start simple, add only what the backtest supports)

**Step A: volatility baseline (the core).** Mid-window, most of the answer is "how far is price
from the strike, and how much time is left":
`P(up) ≈ Φ( ln(price / strike) / (σ · √time_left) )`, with σ = recent realized volatility.
This is mostly a volatility estimate, and getting σ right is most of the edge.

**Step B: small learned adjustment.** A logistic regression (or small gradient-boosted trees,
trained offline and saved as a JSON of weights) that nudges Step A using:

| Feature | Why |
|---|---|
| Returns over last 1, 5, 15, 60 min | short-term momentum vs mean reversion |
| Realized vol (1m bars, 30m and 2h), vol of vol | regime: calm vs wild |
| Order book imbalance, top 10 levels, (bid size − ask size)/(total) | near-term pressure |
| Trade flow imbalance: taker buys vs sells, last 1–5 min | who's being aggressive |
| Volume vs its usual for this time of day | breakouts vs noise |
| Spread and depth | thin book = less reliable signal |
| BTC move for ETH/SOL calls (lead-lag) | BTC often moves first |
| Time of day / weekday, US market open, funding times | known busy periods |
| Kalshi YES price and its recent change | the crowd's view; we only bet when we differ |

**Step C: decision.**
`edge = p_model − p_market − fees − safety_margin`. Make a call only if `edge > 0` on one side,
otherwise **"no call"**. Most windows should be "no call", and that's expected.
Kalshi's fee depends on the price (highest near 50¢) *(verify the current fee table)*. Fees and
the spread go into every backtest.

### Timing
- First look right after open (~:00:30), using the strike and pre-window features.
- Second look mid-window (~7–10 minutes left), when Step A carries real information.
- Calls are frozen and logged **before** the outcome is known, then scored at close. No editing
  the past.

---

## 5. Delivering calls without interrupting

- **Default: text only.** Calls go to a dedicated channel (e.g. `#signals`) as one compact line:
  `BTC 15m (10:15–10:30) UP · model 57% vs market 52¢ · edge +3¢ · paper $5 · reason: book +0.31, momentum`.
  Results are edited in when the window closes (✅/❌, P&L).
- **Voice is opt-in** (`MARKET_VOICE=off | strong | all`). When on:
  - She never speaks over anyone. This reuses the guard that already gates helper progress lines
    (`taskProgress` in `src/voice/session.js` skips while she's mid-reply), with an extra wait for a
    few seconds of silence from the room.
  - One short line, no LLM round trip: "Quick call: Bitcoin up, fifty-seven percent."
  - Max one spoken call per window. A call that's stale by the time the room goes quiet gets dropped.
  - "Amy, quiet on the calls" mutes voice calls; the text channel keeps going.
- **Asking her:** a new owner-only `market` tool (same shape as `news_feeds` in `src/tools.js`) with
  actions `status`, `last`, `score` (hit rate, Brier score, P&L, by day/week), `start`, `stop`,
  `mute`, `unmute`. She talks about these numbers from the tool result, never from her own head.

---

## 6. Risk rules (enforced in code, in `risk.js`; Amy can't override them by talking)

1. **Paper first.** `MARKET_MODE=paper` is the default. `live` needs a `.env` change by Owner,
   not a voice command.
2. **Separate bankroll:** a fixed amount in the Kalshi account. The bot sizes from that, never more.
3. **Stake per call:** max 2% of bankroll, sized at ¼ Kelly from the edge, and never above the cap.
4. **Daily loss limit:** down 5% on the day → stop until tomorrow, and say so in `#signals`.
5. **Weekly loss limit:** down 10% → stop until Owner re-enables it.
6. **Losing streak cooldown:** 5 losses in a row → skip the next 4 windows.
7. **Max calls per day:** 20. One position per asset per window. Never doubling down (no martingale).
8. **No-trade conditions:** stale or disagreeing feeds, spread too wide, market too thin, or a big
   scheduled event (CPI, FOMC, jobs report) inside the window.
9. **Model health check:** if the rolling 7-day Brier score is worse than just using the market
   price, drop back to paper automatically.
10. **Kill switch:** "Amy, stop trading" (owner only) cancels open orders and switches to paper
    immediately, and that's logged.
11. **Logs:** every call, skip, order, fill and limit hit goes to `data/market/` with timestamps.

---

## 7. Backtesting and proving it

1. **Record from day one.** Run the feed recorder for 2–4 weeks before any model decisions. Book
   and trade-flow features can only be tested on data we recorded.
2. **History.** Pull months of 1-minute Coinbase candles and Kalshi's settled 15m markets with
   their prices.
3. **Walk-forward testing only.** Train on weeks 1–N, test on week N+1, slide forward. Features may
   use only data available at decision time (no peeking at the future).
4. **Realistic costs.** Fees, spread, and fills at the ask, not the midpoint.
5. **Baselines to beat:**
   - Coin flip (50%)
   - Always "up"
   - **The Kalshi price itself.** This is the one that matters. If we can't beat it, there's no edge.
6. **Metrics:** Brier score and log loss vs the market price, calibration (do our "60%" calls win
   about 60%?), hit rate with a confidence interval, P&L after fees, max drawdown, longest losing streak.
7. **Sample size.** About 96 windows a day per asset. Telling 53% apart from 50% takes roughly
   1,000+ calls, so don't trust a good week.
8. **Gates:**
   - Backtest beats the market price after fees → **paper trade 2–4 weeks on Kalshi demo**.
   - Paper still beats it → **live with a tiny bankroll**.
   - Any gate fails → stop and rethink, no "one more tweak".

---

## 8. Changes to Amy's code

New (all under `src/market/`, each with `*.test.js` next to it):

| File | What |
|---|---|
| `feed.js` | WebSocket clients (Coinbase, Kraken, Kalshi), reconnect with backoff, stale check, rolling window |
| `store.js` | `data/market/market.db`: bars, book snapshots, calls, outcomes |
| `features.js` | pure functions: returns, vol, imbalance, flow (easy to unit test) |
| `model.js` | Step A + loads trained weights from `data/market/model.json` |
| `risk.js` | every rule in section 6, plus the kill switch |
| `kalshi.js` | signed REST/WS client; orders only when `MARKET_MODE=live` |
| `signals.js` | quarter-hour scheduler, makes/logs/scores calls, sends them out |
| `scripts/backtest.js` | offline walk-forward backtest over recorded + historical data |

Changes to existing files:
- `src/index.js`: start/stop the engine when `MARKET_ENABLED=on`.
- `src/tools.js`: the owner-only `market` tool (section 5).
- `src/voice/session.js`: a `marketCall(text)` method beside `taskProgress`, with the quiet-room wait.
- `src/continuity.js`: one short line about the engine when it's running.
- `src/config.js` and README: new settings (`MARKET_ENABLED`, `MARKET_MODE`, `MARKET_ASSETS`,
  `MARKET_CHANNEL`, `MARKET_VOICE`, `KALSHI_KEY_ID`, `KALSHI_KEY_PATH`, risk limits).
- `knowledge/tools.md`: how she uses the `market` tool and what to say when it's stopped or paused.
- Dashboard: a "Signals" tab with live calls, score and a stop button (later phase).

---

## 9. Build order

1. **Phase 1, recorder (about a day of work):** feeds + store + stale checks + `#signals` heartbeat.
   No predictions. Starts collecting data.
2. **Phase 2, model + paper (after ~2 weeks of data):** features, Step A + B, backtest script,
   paper calls in `#signals`, `market` tool, opt-in voice calls.
3. **Phase 3, live (only if section 7's gates pass):** Kalshi orders with risk.js limits, kill
   switch, dashboard tab.

Decisions for Owner:
- Kalshi 15m markets, or spot trading?
- Which assets (suggest BTC only to start)?
- Voice calls on or off by default?
- Bankroll size?
- OK to start with Phase 1 only?

---

## 10. Wiring it into Amy (code outline)

The engine is a plain object made by `createEngine()` in `src/market/signals.js`. Amy never calls
into it on the reply path except through the `market` tool, and it only reaches her through three
narrow doors: a text line in `#signals`, an optional spoken line, and one sentence in her prompt.

```
                  ┌──────────── src/market/ (own loop, own DB) ─────────────┐
 Coinbase WS ─┐   │ feed.js ──► signals.js tick every 5s ──► store.js        │
 Kraken WS  ──┴──►│ (quotes,     │ features → model → risk   market.db      │
                  │  1m bars)    │                                         │
                  └──────────────┼────────────┬───────────────┬────────────┘
                                 │ post(text)  │ speak(text)    │ summaryLine() / status()
                                 ▼             ▼                ▼
                       bot.js market poster  voice session   companion.js prompt + `market` tool
                       (#signals channel)    marketCall()    (she discusses real numbers)
```

### 10.1 `src/config.js`: settings

```js
// 15-minute crypto calls (docs/crypto-signals-plan.md). Off unless MARKET_ENABLED=on.
market: {
  enabled: bool(env.MARKET_ENABLED, false),
  mode: 'paper', // live is phase 3 and needs code that doesn't exist yet, not a setting
  assets: list(env.MARKET_ASSETS || 'BTC'),
  channelId: String(env.MARKET_CHANNEL_ID || '').trim(), // #signals; blank = no posting
  voice: (env.MARKET_VOICE || 'off').toLowerCase(), // off | strong | all
  decideAtMinutesLeft: num(env.MARKET_DECIDE_AT, 8),
  limits: { bankroll: num(env.MARKET_BANKROLL, 100) }, // merged over risk.DEFAULT_LIMITS
},
```
Plus `marketEnabled` and `marketVoice` in `EDITABLE` so the dashboard can flip them. Limits stay
out of `EDITABLE` on purpose: changing them means editing `.env` and restarting.

### 10.2 `src/market/index.js` (new, small): the one place that builds the engine

```js
import path from 'node:path';
import { config, DATA_DIR } from '../config.js';
import { activity } from '../events.js';
import { createFeed } from './feed.js';
import { openStore } from './store.js';
import { createEngine } from './signals.js';
import { DEFAULT_LIMITS } from './risk.js';

let engine = null;
let poster = async () => {};
let speaker = () => {};
export const setMarketPoster = (fn) => (poster = fn);  // bot.js
export const setMarketSpeaker = (fn) => (speaker = fn); // voice/session.js
export const market = () => engine;

export async function startMarket() {
  if (!config.market.enabled || engine) return;
  const feed = createFeed({ assets: config.market.assets, onError: (m) => activity('error', { where: 'market feed', message: m }) });
  engine = createEngine({
    feed,
    store: openStore(path.join(DATA_DIR, 'market', 'market.db')),
    assets: config.market.assets,
    limits: { ...DEFAULT_LIMITS, ...config.market.limits },
    decideAtMinutesLeft: config.market.decideAtMinutesLeft,
    voice: config.market.voice,
    post: (text) => poster(text),
    speak: (text) => speaker(text),
    log: activity,
  });
  await feed.start();
  engine.start();
}
```

### 10.3 `src/index.js`: start it next to continuity

```js
import { startMarket } from './market/index.js';
// Crypto calls: their own loop and database; never on the reply path (docs/crypto-signals-plan.md).
startMarket().catch((err) => activity('error', { where: 'market', message: err.message }));
```

### 10.4 `src/bot.js`: the `#signals` poster

Same shape as the solo-thoughts `setPoster` already in `bot.js` (resolve the channel at post time,
text channels only, `allowedMentions: { parse: [] }`), pointed at `config.market.channelId`.
Market lines don't wait for the busy check: they're text in their own channel, not her talking.

### 10.5 `src/voice/session.js`: `marketCall(text)` beside `taskProgress`

```js
// A crypto call from the signals engine: one short line, never over anyone. Waits for the room to
// be quiet (no one speaking, nothing queued); if that takes longer than a minute the call is stale
// and dropped. No LLM round trip.
marketCall(text) {
  const until = Date.now() + 60_000;
  const tryNow = () => {
    if (sessions.get(this.guild.id) !== this || Date.now() > until) return;
    if (this.pending > 0 || this.speaking || Date.now() - this.lastHeard < 4000) return void setTimeout(tryNow, 2000);
    this.say(text);
  };
  tryNow();
}
```
`setMarketSpeaker((text) => [...sessions.values()][0]?.marketCall(text))` is registered once when
a session starts. `lastHeard` is the session's existing "anyone said anything" timestamp, the
same one the pressure system uses so she doesn't speak up over a conversation.

### 10.6 `src/companion.js`: one line in her prompt

Next to the Continuity section: `extraSection('Signals', character.main && market()?.summaryLine())`.
That is at most ~200 characters ("Crypto signals running (paper, BTC). Last: BTC 10:15 up 57%, no
stake. This week 31/55 right."), and empty when the engine is off. **No ticks, prices or bars ever
go into her prompt**; if she needs numbers she calls the tool.

### 10.7 `src/tools.js`: the owner-only `market` tool

```js
market: {
  enabled: (ctx) => Boolean(config.market.enabled && ctx.perms?.owner),
  definition: { type: 'function', function: {
    name: 'market',
    description: 'Owner only. Your 15-minute crypto signals engine (paper trading). status: running, mode, pause reason, today\'s calls. last: the most recent calls with their reasons. score: this week\'s hit rate, Brier score vs the market and a coin flip, paper P&L. mute/unmute: spoken calls (text in #signals keeps going). stop: the kill switch. ' +
      'Only say numbers this tool returned. Calls are probabilities, not promises; say so if someone treats one as a sure thing. You cannot turn on live trading or change risk limits.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'last', 'score', 'mute', 'unmute', 'stop'] },
      count: { type: 'number', description: 'For last: how many calls (0 = 3)' },
    }, required: ['action', 'count'] },
  } },
  run: marketTool, // thin switch over market().status() / .halt() / .mute(); returns JSON-able text
},
```
Add `'market'` to `MULTI_STEP` in `companion.js` only if she needs status + last in one turn.
There is deliberately **no resume and no live action** in the tool: resuming after a halt is a
dashboard button (phase 3), live mode is a code change.

### 10.8 `knowledge/tools.md`

A short paragraph: when someone asks "what's the call?" use `market` `last`; when it says
"no call" that's normal (most windows are); when paused, say why from `status`; never invent a
price or a probability; "stop trading" means `stop`.

---

## 11. Running it in the background safely

| Risk to Amy | How it's prevented |
|---|---|
| Slow replies | The engine does a few hundred arithmetic operations every 5 s, no model calls, no disk on the hot path except one SQLite write per decision. Voice and text replies never wait on it. |
| A crash takes her down | Every tick is wrapped in try/catch and logged as `{ where: 'market' }`; a dead WebSocket reconnects with backoff (1 s → 30 s); `startMarket()` failures are caught in `index.js`. |
| Ticks pile up | A `busy` flag skips a tick if the last one is still waiting on Kalshi. |
| Talking over people | Spoken calls only through `marketCall`: waits for silence, max one per window, dropped after a minute, off by default (`MARKET_VOICE=off`). |
| Prompt bloat | One summary line; detail only through the tool. |
| Memory DB bloat | Separate `data/market/market.db`. |
| Restart loses risk state | Risk counters (day/week P&L, streak, halt) are saved after every tick and reloaded at start. |
| Process won't exit | All timers are `unref()`'d. |

**Why in-process and not a separate process or worker thread:** the load is tiny, and in-process
lets it reuse her poster, voice session and activity log directly. If it ever grows (e.g. a heavier
model), move `feed.js` + `signals.js` into a `worker_threads` Worker and pass the same three
messages (`post`, `speak`, `summary`) over `postMessage`. The interface above doesn't change.
A Claude Code background agent or `/loop` is **not** a good fit for the live loop: it's slow, costs
tokens every 15 minutes, and the decisions must be deterministic code. Those are fine for the
weekly review ("read the backtest output and the week's calls, write a short report").

---

## 12. What's written now (starter code, not wired in)

Nothing below is imported by Amy yet, so her behaviour is unchanged until sections 10.1–10.8 are done.

| File | State |
|---|---|
| `src/market/features.js` | Done: normal CDF, log returns, realized vol, momentum, book imbalance, feed gap. |
| `src/market/model.js` | Done: Step A `pUp`, Kalshi fee *(verify rate)*, `decide` (edge after fees + 2¢ margin, probabilities capped at 3–97%). Step B (learned adjustment) waits for recorded data. |
| `src/market/risk.js` | Done: every rule in section 6 except the model health check (needs a week of scored calls) and event calendar (CPI/FOMC list, later). |
| `src/market/feed.js` | Done: Coinbase + Kraken public tickers, reconnect, 2-hour warm-up from Coinbase REST candles, 1m bars, stale and disagreement checks. Order book depth and trade flow come next. |
| `src/market/store.js` | Done: `market.db` with calls, scores, Brier vs market and coin flip, paper P&L, saved risk state. |
| `src/market/signals.js` | Done: the quarter-hour loop. Paper only (refuses any other mode). Without a Kalshi price it makes **shadow** calls: frozen, posted and scored, never staked. |
| `src/market/market.test.js` | Tests for the model, risk limits and feed parsing. |
| `scripts/backtest.js` | Done: `node scripts/backtest.js BTC 30` pulls 30 days of public 1m candles and prints Brier, log loss, hit rate and a calibration table for Step A. Writes nothing. |
| `src/market/kalshi.js` | **Not written.** Phase 2: read-only market prices for `marketPrice(asset, window)` (series ticker for 15m BTC *(verify)*). Phase 3: signed orders (RSA-PSS headers *(verify)*). |
| `src/market/index.js` + edits in 10.1–10.8 | **Not written.** That's the "wire it in" step, waiting on Owner's go-ahead. |

**Suggested next steps, in order:**
1. Run `node scripts/backtest.js BTC 30` to see how calibrated Step A is. (Beating a coin flip
   mid-window is expected and is *not* an edge; beating Kalshi's price is.)
2. Say go on sections 10.1–10.8 with `MARKET_ENABLED=on`, `MARKET_VOICE=off`, and a `#signals`
   channel. She starts making shadow calls and recording.
3. Add `kalshi.js` read-only prices and pull Kalshi's settled-market history, then run the real
   gate in section 7.
