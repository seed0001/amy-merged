import test from 'node:test';
import assert from 'node:assert/strict';

// Owner, 2026-11-11: Ollama quit at 10:51 PM and every background job (memory, recall, taste, topics, profile,
// listening) failed with "fetch failed" for 40 minutes. Thinking runs local; when the local model is unreachable
// the same calls go to a cheap cloud model until it's back, and that's said once, with why and the fix.

const { json, localFirst, localModelDown, LOCAL_FALLBACK } = await import('./llm.js');
const { config } = await import('./config.js');
const { bus } = await import('./events.js');

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) });

function harness() {
  const was = { key: config.openrouter.apiKey, provider: config.cognition.provider, fallback: config.cognition.fallbackModel, fetch: globalThis.fetch, retry: LOCAL_FALLBACK.retryMs };
  const sent = []; const logged = [];
  let ollamaUp = false;
  config.openrouter.apiKey = 'test-key'; config.cognition.provider = 'ollama'; config.cognition.fallbackModel = 'cheap/model';
  LOCAL_FALLBACK.retryMs = 0; // try the local model on every call, so the test sees each step without waiting a minute
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('openrouter')) { sent.push(JSON.parse(init.body).model); return new Response(JSON.stringify({ choices: [{ message: { content: '{"via":"cloud"}' } }], usage: { cost: 0.0001 } })); }
    if (!ollamaUp) throw refused();
    return new Response(JSON.stringify({ model: 'local', message: { role: 'assistant', content: '{"via":"local"}' }, done: true }));
  };
  const onAct = (e) => { if (e?.type === 'local-model') logged.push(e); };
  bus.on('activity', onAct);
  return { sent, logged, up: (v) => (ollamaUp = v), restore() {
    bus.off('activity', onAct); config.openrouter.apiKey = was.key; config.cognition.provider = was.provider; config.cognition.fallbackModel = was.fallback; globalThis.fetch = was.fetch; LOCAL_FALLBACK.retryMs = was.retry;
  } };
}

test('local model down: background thinking goes to the cheap cloud model, said once, and goes back local when it returns', async () => {
  const h = harness();
  try {
    assert.deepEqual(await json([{ role: 'user', content: 'read this line' }]), { via: 'cloud' });
    assert.deepEqual(await json([{ role: 'user', content: 'and this one' }]), { via: 'cloud' });
    assert.deepEqual(h.sent, ['cheap/model', 'cheap/model'], 'the fallback model, not the main cognition model');
    assert.equal(h.logged.filter((e) => e.down).length, 1, 'going down is said once, not per call');
    assert.match(h.logged[0].message, /isn't answering.*cheap\/model.*costs money.*Fix: start Ollama/s);
    assert.ok(localModelDown());
    // Ollama comes back: the next call tries local first, gets it, and says it's back.
    h.up(true);
    assert.deepEqual(await json([{ role: 'user', content: 'and now' }]), { via: 'local' });
    assert.equal(localModelDown(), null);
    assert.equal(h.logged.filter((e) => e.recovered).length, 1, 'coming back is said once');
  } finally { h.restore(); }
});

test('only an unreachable local model falls back; any other local error stays an error', async () => {
  const h = harness();
  try {
    await assert.rejects(localFirst(async () => { throw new Error('model "x" not found, try pulling it first'); }, async () => 'cloud'), /not found/);
    assert.deepEqual(h.sent, []);
  } finally { h.restore(); }
});

test('no OpenRouter key or fallback off: it fails and says why and the fix, nothing is sent', async () => {
  const h = harness();
  try {
    config.cognition.fallbackModel = 'off';
    await assert.rejects(localFirst(async () => { throw refused(); }, async () => 'cloud', 'taste'), /isn't answering.*cognitionFallback is off.*Fix: start Ollama/s);
    config.cognition.fallbackModel = 'cheap/model'; config.openrouter.apiKey = '';
    await assert.rejects(localFirst(async () => { throw refused(); }, async () => 'cloud', 'taste'), /OPENROUTER_API_KEY is empty/);
    assert.deepEqual(h.sent, []);
  } finally { h.restore(); }
});
