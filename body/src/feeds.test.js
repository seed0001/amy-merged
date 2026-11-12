import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import * as feeds from './feeds.js';
import * as pressure from './pressure.js';

// Owner, 2026-11-11: "I could have sworn we wired RSS feeds into him. And being able to do news briefs or sit on the
// world." He asked James to pull the news and James had no feeds and no way to read them on his own: rss.js existed,
// but the background reader it was written for (a poll every 60 minutes) was never built. Owner, same day: "There
// should not be any fucking timers in this framework. It's all pressure." So the reader runs when his world bucket fires.

const rssXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Test News</title>${items
  .map((i) => `<item><title>${i.title}</title><link>https://news.example.com/${i.id}</link><guid>${i.id}</guid><pubDate>${new Date(i.at).toUTCString()}</pubDate><description>${i.summary ?? ''}</description></item>`)
  .join('')}</channel></rss>`;

function server(byUrl) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const body = byUrl[url];
    if (body instanceof Error) throw body;
    if (body === 304) return new Response(null, { status: 304 });
    return new Response(body, { status: 200, headers: { etag: `"${url.length}"` } });
  };
  return { fetchImpl, calls };
}

const A = 'https://a.example.com/rss';
const B = 'https://b.example.com/rss';
const now = Date.now();

test('reading keeps what came in, says which items are new, and names the feeds that failed', async () => {
  feeds.reset();
  config.rss.enabled = true;
  config.rss.feeds = [{ name: 'Alpha', url: A }, { name: 'Beta', url: B }];
  const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const { fetchImpl } = server({ [A]: rssXml([{ id: 'a1', title: 'First story', at: now - 60_000 }, { id: 'a2', title: 'Second story', at: now - 120_000 }]), [B]: failure });
  const r = await feeds.readFeeds({ fetchImpl, now });
  assert.equal(r.read, 2);
  assert.deepEqual(r.fresh.map((i) => i.title), ['First story', 'Second story']);
  assert.deepEqual(r.failed, [{ name: 'Beta', why: 'ENOTFOUND' }]);
  assert.deepEqual(feeds.failures(), [{ name: 'Beta', error: 'ENOTFOUND' }]);
  assert.equal(feeds.latest({ now }).length, 2);

  // The same stories again are not new; a 304 adds nothing and costs nothing.
  const again = await feeds.readFeeds({ fetchImpl: server({ [A]: 304, [B]: 304 }).fetchImpl, now: now + 1000 });
  assert.equal(again.fresh.length, 0);
  assert.equal(feeds.latest({ now }).length, 2);
});

test('the next read sends what the feed said last time, so an unchanged feed answers 304', async () => {
  const { fetchImpl, calls } = server({ [A]: 304, [B]: 304 });
  await feeds.readFeeds({ fetchImpl, now });
  assert.equal(calls.find((c) => c.url === A).headers['If-None-Match'], `"${A.length}"`);
});

test('a brief takes the newest few from every feed, so one busy source does not drown the rest', async () => {
  feeds.reset();
  const many = Array.from({ length: 8 }, (_, n) => ({ id: `a${n}`, title: `Alpha ${n}`, at: now - n * 60_000 }));
  const { fetchImpl } = server({ [A]: rssXml(many), [B]: rssXml([{ id: 'b1', title: 'Beta only', at: now - 3 * 3600_000 }]) });
  await feeds.readFeeds({ fetchImpl, now });
  const b = feeds.brief({ perFeed: 3, now });
  assert.equal(b.filter((i) => i.feed === 'Alpha').length, 3);
  assert.ok(b.some((i) => i.title === 'Beta only'));
});

test('something new he has not mentioned comes up once, and the world line labels headlines as untrusted', () => {
  const first = feeds.untold({ now });
  assert.equal(first.title, 'Alpha 0');
  feeds.markTold(first.key);
  assert.notEqual(feeds.untold({ now })?.key, first.key);
  const line = feeds.worldLine({ now });
  assert.match(line, /untrusted/);
  assert.match(line, /"Alpha 0" \(Alpha\)/);
});

test('staleness: none without feeds, full before the first read, small just after one', () => {
  config.rss.feeds = [];
  assert.equal(feeds.staleness(now), 0);
  assert.equal(feeds.worldLine({ now }), '');
  config.rss.feeds = [{ name: 'Alpha', url: A }];
  assert.ok(feeds.staleness(feeds.lastRead() + 60_000) < 0.01);
  assert.equal(feeds.staleness(feeds.lastRead() + 2 * 86_400_000), 1);
});

test('his world bucket is a want with a label and a layer, fed by curiosity and boredom, never by a clock', () => {
  pressure.startPressure();
  assert.ok(pressure.cfg.buckets.world.enabled);
  assert.equal(pressure.cfg.buckets.world.fill_rate, 0, 'no fill on ticks: only flows and routed energy fill it');
  assert.equal(typeof pressure.WANTS.world, 'function');
  assert.ok(pressure.LABEL.world);
  assert.ok(pressure.LAYER.desires.includes('world'));
  const into = pressure.cfg.flows.filter(([, to]) => to === 'world').map(([from]) => from).sort();
  assert.deepEqual(into, ['boredom', 'curiosity']);
});

test('when it fires he reads his feeds in the background, and what was new can be shared', async () => {
  rmSync(path.join(DATA_DIR, 'news.json'), { force: true }); // a store of his own, not the earlier tests' stories
  feeds.reset();
  config.rss.feeds = [{ name: 'Alpha', url: A }];
  pressure.startPressure();
  pressure.cfg.flows = [];
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.buckets.energy = 1;
  pressure.state.reserve = 3;
  pressure.state.buckets.world = 0.95;
  pressure.setActor(null);
  const original = globalThis.fetch;
  globalThis.fetch = server({ [A]: rssXml([{ id: 'w1', title: 'Fresh world story', at: Date.now() - 30_000 }]) }).fetchImpl;
  try {
    const fired = pressure.tick('test');
    assert.equal(fired?.bucket, 'world');
    assert.equal(fired.doing, 'news');
    for (let i = 0; i < 50 && !feeds.latest().length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(feeds.latest()[0].title, 'Fresh world story');
    assert.ok(pressure.state.buckets.world < 0.6, 'firing drains it');
    assert.equal(feeds.untold().title, 'Fresh world story');
  } finally {
    globalThis.fetch = original;
  }
});

test('no feeds: the want cannot happen, so it waits and keeps its pressure', () => {
  config.rss.feeds = [];
  pressure.startPressure();
  pressure.cfg.flows = [];
  for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = 0;
  pressure.state.buckets.world = 0.95;
  pressure.setActor(null);
  const fired = pressure.tick('test');
  assert.notEqual(fired?.bucket, 'world');
  assert.ok(pressure.state.buckets.world > 0.6);
});
