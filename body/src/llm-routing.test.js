import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './llm.js';

const tools = [{ type: 'function', function: { name: 'files', parameters: { type: 'object', properties: {} } } }];
const call = { message: { tool_calls: [{ function: { name: 'files', arguments: {} } }] } };

test('direct model tool selection earns the bounded multistep allowance', async () => {
  let requests = 0, executions = 0;
  const reply = await chat([], { tools, repeatable: ['files'], expandOnTools: ['files'],
    streamFactory: async function* () { yield requests++ < 5 ? call : { message: { content: 'Done.' } }; },
    runTool: async () => { executions++; return 'ok'; } });
  assert.equal(executions, 5);
  assert.equal(reply, 'Done.');
});

test('a model that keeps calling tools stops at the 25-call check-in, not at a round count', async () => {
  let executions = 0;
  await chat([], { tools, repeatable: ['files'], expandOnTools: ['files'],
    streamFactory: async function* () { yield call; }, runTool: async () => { executions++; return 'ok'; } });
  assert.equal(executions, 25);
});

test('turns with no tools cannot execute invented calls', async () => {
  await chat([], { streamFactory: async function* () { yield call; }, runTool: () => assert.fail('must not execute') });
});

test('her thinking runs on OpenRouter with the cognition model, answered in the shape the callers expect; ollama switches it back', async () => {
  // Owner, 2026-11-10: "where the local model was, we're putting OpenRouter… Grok 4.20. Make it configurable."
  const { json } = await import('./llm.js');
  const { config } = await import('./config.js');
  const was = { key: config.openrouter.apiKey, provider: config.cognition.provider, fetch: globalThis.fetch };
  const sent = [];
  config.openrouter.apiKey = 'test-key';
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes('openrouter')) return new Response(JSON.stringify({ choices: [{ message: { content: '{"keep":true}' }, finish_reason: 'stop' }], usage: { completion_tokens: 4 } }));
    throw new Error('connect ECONNREFUSED'); // the local model, blocked in tests
  };
  try {
    assert.equal(config.cognition.model, 'x-ai/grok-4.20', 'Grok 4.20 is the default');
    assert.deepEqual(await json([{ role: 'user', content: 'judge this' }], { maxTokens: 200 }), { keep: true });
    const body = sent[0].body;
    assert.match(sent[0].url, /openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.equal(body.model, 'x-ai/grok-4.20');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 200);
    assert.deepEqual(body.reasoning, { enabled: false });
    config.cognition.provider = 'ollama';
    // With no outage fallback (local-fallback.test.js covers that), switching to ollama means the local model only.
    was.fallback = config.cognition.fallbackModel; config.cognition.fallbackModel = 'off';
    sent.length = 0;
    await assert.rejects(json([{ role: 'user', content: 'judge this' }]));
    assert.equal(sent.some((s) => s.url.includes('openrouter')), false, 'back on the local model, nothing goes to OpenRouter');
  } finally {
    config.openrouter.apiKey = was.key; config.cognition.provider = was.provider; globalThis.fetch = was.fetch;
    if (was.fallback !== undefined) config.cognition.fallbackModel = was.fallback;
  }
});

// Nov 10: the reply model went silent behind OpenRouter's keep-alives and James sat mute for three minutes.
test('a reply that goes silent is dropped on its own clock, keep-alives or not, and sent once more', async () => {
  const { STALL } = await import('./llm.js');
  const { config } = await import('./config.js');
  const was = { key: config.openrouter.apiKey, brain: config.brain, failover: config.providerFailover, fetch: globalThis.fetch, stall: { ...STALL } };
  const enc = new TextEncoder();
  // A stream that only ever sends keep-alive comments, until the request is aborted.
  const silent = (signal) => new Response(new ReadableStream({ start(c) {
    const t = setInterval(() => c.enqueue(enc.encode(': OPENROUTER PROCESSING\n\n')), 5);
    signal.addEventListener('abort', () => { clearInterval(t); c.error(new DOMException('aborted', 'AbortError')); });
  } }));
  const answer = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Here.' } }] })}\n\ndata: [DONE]\n\n`);
  let requests = 0, mode = 'once';
  config.openrouter.apiKey = 'test-key'; config.brain = 'openrouter'; config.providerFailover = false;
  STALL.firstMs = 80; STALL.gapMs = 80;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('openrouter')) throw new Error('connect ECONNREFUSED');
    requests++;
    return mode === 'always' || requests === 1 ? silent(init.signal) : answer();
  };
  try {
    assert.equal(await chat([{ role: 'user', content: 'did you get that?' }]), 'Here.', 'the second try answers');
    assert.equal(requests, 2);
    mode = 'always'; requests = 0;
    await assert.rejects(chat([{ role: 'user', content: 'did you get that?' }]), /went silent: no reply came for 0 seconds.*switch to another reply model/s);
    assert.equal(requests, 2, 'tried twice, then says why');
  } finally {
    Object.assign(STALL, was.stall);
    config.openrouter.apiKey = was.key; config.brain = was.brain; config.providerFailover = was.failover; globalThis.fetch = was.fetch;
  }
});
