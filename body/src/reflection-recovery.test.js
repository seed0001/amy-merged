import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('local synthesis retries once with its context intact and preserves both contributions on failure', async (t) => {
  const requests = []; let failRetry = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const system = body.messages[0].content;
    if (system.includes('Conclude what you worked out') || (failRetry && system.includes('Summarize the supplied private discussion'))) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'prediction aborted, token repeat limit reached' }));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ thought: system.includes('Summarize the supplied') ? 'I can hold mixed feelings without forcing a resolution.' : 'I feel uncertain about being understood.' }) } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
  const { config } = await import('./config.js');
  config.brain = 'openrouter'; config.openrouter.apiKey = 'mock-only'; config.selfDialogueProvider = 'openrouter';
  config.cognition.provider = 'ollama'; // the synthesis under test is the local one; her thinking defaults to OpenRouter now
  const { innerCore } = await import('./inner-core.js');
  const guidance = innerCore.setPrompt('inner_life', 'Be candid without forcing emotional intensity.', 'her own choice');
  const actualFetch = globalThis.fetch;
  let cloudCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://openrouter.ai/')) return actualFetch(url, init);
    cloudCalls++;
    assert.equal(JSON.parse(init.body).max_tokens, 640);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"thought":"There can be more than one interpretation of that uncertainty."}' } }] }));
  };
  t.after(() => { globalThis.fetch = actualFetch; });
  const { selfDialogue, recentDialogues } = await import('./self-dialogue.js');
  const context = 'Retain this working context: a recent emotional conversation, goals and memories.';
  const result = await selfDialogue({ topic: 'Being understood', context });
  assert.match(result.thought, /mixed feelings/);
  // The conclusion hits the repeat limit: json() itself tries once more (llm.js), then the simpler synthesis runs.
  assert.deepEqual(requests.map((r) => r.options.num_predict), [640, 640, 640, 320]);
  assert.ok(requests.every((r) => JSON.parse(r.messages[1].content).context === context));
  assert.ok(requests.every((r) => r.messages[0].content.includes(guidance)), 'every turn of her private dialogue carries her own inner-life guidance');
  assert.equal(recentDialogues(1)[0].status, 'done');
  assert.match(recentDialogues(1)[0].error, /first attempt/);
  assert.equal(recentDialogues(1)[0].transcript.length, 3);
  failRetry = true;
  await assert.rejects(selfDialogue({ topic: 'Being understood again', context }), /token repeat limit/);
  const failed = recentDialogues(1)[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.transcript.length, 2);
  assert.match(failed.error, /final local synthesis after one retry/);
  // Second run: opening, the conclusion and its json() retry, the synthesis and its json() retry = 5 more.
  assert.equal(requests.length, 9); assert.equal(cloudCalls, 2);
  const { getPrompt } = await import('./prompts.js');
  assert.match(getPrompt('self_dialogue_local').builtin, /Summarize the supplied private discussion/);
  assert.equal(getPrompt('self_dialogue_local').template, '{{original}}');
});

test('memory evidence rejects the reproduced question-to-confirmation error and accepts explicit statements', async () => {
  const { groundedFact, MEMORY_TASK } = await import('./extract.js');
  const fact = { about: 'Owner', fact: 'Owner confirmed the repetition limit originated from OpenAI.', certainty: 'asserted', evidence: "that's an open AI policy" };
  assert.equal(groundedFact(fact, [{ role: 'user', text: "Amy, that's an open AI policy, isn't it?" }]), false);
  assert.equal(groundedFact({ ...fact, evidence: 'I suspect the cloud caused the limit' }, [{ role: 'user', text: 'I suspect the cloud caused the limit.' }]), false);
  const positive = { ...fact, fact: 'Owner prefers local background research.', evidence: 'I prefer local background research' };
  assert.equal(groundedFact(positive, [{ role: 'user', text: 'I prefer local background research.' }]), true);
  assert.equal(groundedFact(positive, [{ role: 'assistant', text: positive.evidence }]), false);
  assert.equal(groundedFact({ ...positive, certainty: 'uncertain' }, [{ text: positive.evidence }]), false);
  assert.match(MEMORY_TASK(['Owner'], 'Champ'), /A question, suspicion, hypothesis/);
});
