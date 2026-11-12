import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, guardedFetch } from './model-guard.js';

// Owner, 2026-11-11: "every single model call that happens needs to be tracked", and with her own brain in charge
// no language model may be called unseen.
const rows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'model-calls.jsonl');
const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const settle = () => new Promise((r) => setTimeout(r, 20));

test('a request is recognised by where it goes: text, embedding, hearing, voice, or not a model call', () => {
  const o = { ollamaHost: 'http://127.0.0.1:11434' };
  assert.deepEqual(classify('http://127.0.0.1:11434/api/chat', o), { kind: 'text', provider: 'ollama', local: true });
  assert.deepEqual(classify('http://127.0.0.1:11434/api/embed', o), { kind: 'embedding', provider: 'ollama', local: true });
  assert.equal(classify('http://127.0.0.1:11434/api/tags', o), null, 'listing models is not a model call');
  assert.equal(classify('https://openrouter.ai/api/v1/chat/completions', o).provider, 'openrouter');
  assert.equal(classify('https://openrouter.ai/api/v1/models', o), null);
  assert.equal(classify('https://api.groq.com/openai/v1/audio/transcriptions', o).kind, 'hearing');
  assert.equal(classify('https://api.fish.audio/v1/tts', o).kind, 'voice');
  assert.equal(classify('https://example.com/anything', o), null);
});

test('every model call is written down with its model, how long it took, its tokens and price', async () => {
  const file = tmp();
  const fetch = guardedFetch(async () => okJson({ usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.0004 } }), { blockText: () => false, file: () => file, log: () => {} });
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'test/model' }) });
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.0004 } }, 'the caller still reads the answer');
  await settle();
  const [row] = rows(file);
  assert.equal(row.kind, 'text');
  assert.equal(row.provider, 'openrouter');
  assert.equal(row.model, 'test/model');
  assert.equal(row.ok, true);
  assert.equal(row.in, 12);
  assert.equal(row.out, 5);
  assert.equal(row.cost, 0.0004);
  assert.match(row.from, /model-guard\.test\.js:\d+/, 'and where in her code it came from');
});

test('a failed call is written down too, with why', async () => {
  const file = tmp();
  const fetch = guardedFetch(async () => { throw new Error('connect ECONNREFUSED'); }, { blockText: () => false, file: () => file, log: () => {}, ollamaHost: () => 'http://127.0.0.1:11434' });
  await assert.rejects(fetch('http://127.0.0.1:11434/api/chat', { body: JSON.stringify({ model: 'gemma' }) }), /ECONNREFUSED/);
  const [row] = rows(file);
  assert.equal(row.ok, false);
  assert.match(row.error, /ECONNREFUSED/);
  assert.equal(row.local, true);
});

test('with no language model in use, a text-model call is refused, never sent, and recorded with who tried', async () => {
  const file = tmp();
  let sent = 0;
  const said = [];
  const fetch = guardedFetch(async () => { sent++; return okJson({}); }, { blockText: () => true, file: () => file, log: (type, d) => said.push({ type, ...d }), ollamaHost: () => 'http://127.0.0.1:11434' });
  const call = () => fetch('https://openrouter.ai/api/v1/chat/completions', { body: JSON.stringify({ model: 'openai/gpt-6-luna' }) });
  await assert.rejects(call(), /No language model is in use \(BRAIN=amy\).*openrouter openai\/gpt-6-luna.*refused/);
  await assert.rejects(call());
  assert.equal(sent, 0, 'nothing left the machine');
  assert.equal(rows(file).length, 2, 'every refused call is in the file');
  assert.equal(rows(file)[0].blocked, true);
  assert.equal(said.filter((s) => s.type === 'model-blocked').length, 1, 'the same caller is announced once');
  // Hearing, her voice and embeddings are not a language model writing for her: they go through.
  await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {});
  await fetch('http://127.0.0.1:11434/api/embed', { body: JSON.stringify({ model: 'bge-m3' }) });
  assert.equal(sent, 2);
});

test('anything that is not a model call passes straight through, unrecorded', async () => {
  const file = tmp();
  const fetch = guardedFetch(async () => okJson({ fine: true }), { blockText: () => true, file: () => file, log: () => {} });
  assert.deepEqual(await (await fetch('https://example.com/api')).json(), { fine: true });
  assert.equal(rows(file).length, 0);
});
