import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { noteSpend, spendSummary, spendText, SPEND_FILE } from './spend.js';

// Owner, 2026-11-11: "I need to know how much it's costing me to run them." Every paid answer's real price is kept.

test('a paid answer is written down with what it was for; free or unpriced answers are not', () => {
  rmSync(SPEND_FILE(), { force: true });
  noteSpend('voice reply', 'deepseek/x', { cost: 0.0123, prompt_tokens: 900, completion_tokens: 40 });
  noteSpend('background', 'x-ai/grok-4.20', { cost: 0.002 });
  noteSpend('background', 'free/model', { cost: 0 });
  noteSpend('background', 'local', undefined);
  const rows = readFileSync(SPEND_FILE(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual({ purpose: rows[0].purpose, model: rows[0].model, cost: rows[0].cost, prompt: rows[0].prompt }, { purpose: 'voice reply', model: 'deepseek/x', cost: 0.0123, prompt: 900 });
});

test('totals by day, week and month, and where the week went, in words he can read', () => {
  rmSync(SPEND_FILE(), { force: true });
  const now = Date.now();
  const realNow = Date.now;
  try {
    for (const [ago, purpose, model, cost] of [[40 * 86_400_000, 'reply', 'a', 5], [3 * 86_400_000, 'reply', 'a', 1], [60_000, 'voice reply', 'b', 0.5], [30_000, 'background', 'c', 0.25]]) {
      Date.now = () => now - ago; noteSpend(purpose, model, { cost });
    }
  } finally { Date.now = realNow; }
  const s = spendSummary(now);
  assert.equal(s.total, 6.75);
  assert.equal(s.month, 1.75);
  assert.equal(s.week, 1.75);
  assert.equal(s.calls, 4);
  assert.deepEqual(s.byPurpose.map((x) => x.name), ['reply', 'voice reply', 'background']);
  const text = spendText(now);
  assert.match(text, /last 7 days \$1\.75.*all recorded \$6\.75 over 4 calls/);
  assert.match(text, /by what it was for: reply \$1\.00, voice reply \$0\.500, background \$0\.250/);
  assert.match(text, /Fish .* bill separately/);
});

test('nothing recorded yet says so instead of $0', () => {
  rmSync(SPEND_FILE(), { force: true });
  assert.match(spendText(), /No spending recorded yet/);
  assert.equal(existsSync(SPEND_FILE()), false);
});

test('a streamed reply records the real cost OpenRouter puts on its last chunk', async () => {
  rmSync(SPEND_FILE(), { force: true });
  const { chat } = await import('./llm.js');
  const { config } = await import('./config.js');
  const was = { key: config.openrouter.apiKey, brain: config.brain, failover: config.providerFailover, fetch: globalThis.fetch };
  config.openrouter.apiKey = 'test-key'; config.brain = 'openrouter'; config.providerFailover = false;
  let asked;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('openrouter')) throw new Error('connect ECONNREFUSED');
    asked = JSON.parse(init.body);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi.' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0042 } })}\n\ndata: [DONE]\n\n`);
  };
  try {
    assert.equal(await chat([{ role: 'user', content: 'hey' }]), 'Hi.');
    assert.deepEqual(asked.usage, { include: true }, 'the price is asked for');
    const s = spendSummary();
    assert.equal(s.total, 0.0042);
    assert.equal(s.byPurpose[0].name, 'reply');
  } finally {
    config.openrouter.apiKey = was.key; config.brain = was.brain; config.providerFailover = was.failover; globalThis.fetch = was.fetch;
  }
});
