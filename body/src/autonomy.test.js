import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('calendar survives reload, handles DST, retries failures and avoids duplicate ticks', async () => {
  const { createCalendar, nextOccurrence } = await import('./calendar.js');
  let now = Date.parse('2026-11-02T13:59:00Z');
  const db = new DatabaseSync(':memory:');
  const c = createCalendar(db, () => now);
  const event = c.save({ title: 'Morning brief', instructions: 'Astronomy news', kind: 'brief', repeat: 'weekdays', time: '08:00', timezone: 'America/Chicago' }, 'owner');
  assert.equal(new Date(event.next_at).toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(createCalendar(db, () => now).list('owner').length, 1);
  assert.throws(() => c.cancel(event.id, 'someone-else'));
  assert.equal(new Date(nextOccurrence({ repeat: 'daily', time: '08:00', timezone: 'America/Chicago' }, Date.parse('2026-10-31T14:00:00Z'))).toISOString(), '2026-11-01T14:00:00.000Z');
  assert.throws(() => nextOccurrence({ repeat: 'once', at: '2026-11-02T08:00' }, now));
  now = event.next_at;
  let generated = 0, delivered = 0;
  const generate = async () => { generated++; return 'A grounded brief'; };
  await c.tick({ generate, deliver: async () => { throw new Error('Offline'); } });
  assert.match(c.list('owner')[0].error, /Offline/);
  await c.tick({ generate, deliver: async () => { delivered++; } });
  assert.equal(delivered, 0);
  now += 5 * 60000;
  await c.tick({ generate, deliver: async () => { delivered++; } });
  await c.tick({ generate, deliver: async () => { delivered++; } });
  assert.equal(delivered, 1); assert.equal(generated, 1);
  assert.equal(c.list('owner')[0].last_sent, now);
  c.cancel(event.id, 'owner'); assert.equal(c.list('owner')[0].enabled, false);
  db.close();
});

test('project work waits for a later confirmation of the immutable brief from the same owner', async () => {
  const { createProjects } = await import('./projects.js');
  const db = new DatabaseSync(':memory:'); const p = createProjects(db);
  const ctx = { perms: { owner: true }, speaker: { id: 'owner' }, conversation: 'text:1', turn: '1', userText: 'Build an astronomy tracker' };
  const proposal = p.propose({ title: 'Tracker', brief: 'Make an offline astronomy tracker and send its zip.' }, ctx);
  let starts = 0;
  const start = (plan) => { starts++; assert.equal(plan.brief, proposal.brief); return { id: 123 }; };
  assert.throws(() => p.start(proposal.id, { ...ctx, userText: 'yes' }, start));
  for (const text of ['not yet', 'she said yes', 'yes but change the plan', 'wait']) {
    assert.throws(() => p.start(proposal.id, { ...ctx, turn: '2', userText: text }, start));
  }
  assert.throws(() => p.start(proposal.id, { ...ctx, speaker: { id: 'other' }, turn: '2', userText: 'yes' }, start));
  assert.equal(starts, 0);
  p.start(proposal.id, { ...ctx, turn: '2', userText: 'Yes, do it.' }, start);
  assert.equal(starts, 1);
  assert.throws(() => p.start(proposal.id, { ...ctx, turn: '3', userText: 'yes' }, start));
  db.close();
});

test('editable prompts and inner guidance reach the selected local model; goal research saves progress', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    // A research pass now recalls her earlier attempts by meaning (experience.js), which asks the local model for embeddings.
    if (body.input) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ embeddings: [].concat(body.input).map(() => [1, 0, 0]) })); return; }
    calls.push(body);
    const system = body.messages[0].content;
    let content = body.format === 'json' ? JSON.stringify({ ok: true }) : 'Local result.';
    if (system.includes('Both sides of this private discussion')) {
      content = JSON.stringify({ thought: system.includes('Conclude what you worked out') ? 'I can stay curious while accepting uncertainty.' : 'I feel curious about this situation.', affect: { curiosity: 0.05 } });
    } else if (system.includes('Decide whether this autonomous research')) {
      const source = JSON.parse(body.messages[1].content).source;
      content = JSON.stringify({ search: true, query: 'How do telescope mirrors hold their shape?', reason: 'Advances the selected astronomy goal', evidence: source.text, confidence: 0.95 });
    } else if (system.includes('writing in your private journal')) {
      content = JSON.stringify({ title: 'Mirror design', entry: 'Mirror supports distribute the load.', answered: true, fact: 'Mirror supports distribute the load.', relevant: true,
        sources: ['https://example.test/mirrors'], bring_up: 'Mirror support designs', next_question: 'How does active mirror support work?' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
  const { config, DATA_DIR, updateSettings } = await import('./config.js');
  config.ollama.host = process.env.OLLAMA_HOST;
  const { listPrompts, editPrompt, promptText } = await import('./prompts.js');
  const { json, localChat, agentStep } = await import('./llm.js');
  const { runTool, toolFailed } = await import('./tools.js');
  config.brain = 'openrouter'; config.openrouter.apiKey = ''; config.ollama.model = 'selected-local-test';
  config.cognition.provider = 'ollama'; // this test is about the local model; her thinking defaults to OpenRouter now
  // Her inner-life guidance is hers (owner, 2026-11-09): she writes it in her pondering; nobody edits it.
  const { innerCore } = await import('./inner-core.js');
  assert.throws(() => editPrompt('inner_life', 'Explore your own emotional response with more candor.'), /hers/);
  innerCore.setPrompt('inner_life', 'Explore your own emotional response with more candor.', 'her own choice');
  editPrompt('solo_thought', '{{original}}\nConsider how this changes your curiosity.');
  assert.ok(listPrompts().find((p) => p.id === 'solo_thought').edited);
  assert.match(promptText('solo_thought', 'Fresh live context'), /Fresh live context/);
  const messages = [{ role: 'system', content: 'Fresh live context' }, { role: 'user', content: 'Think now' }];
  await localChat(messages, { purpose: 'solo_thought' }); await json(messages); await agentStep(messages, []);
  assert.equal(calls.length, 3);
  // Her guidance rides only in her private thinking's own prompts, never stuck onto every local call.
  assert.ok(calls.every((c) => c.model === 'selected-local-test' && !c.messages[0].content.includes('more candor')));
  assert.match(calls[0].messages[0].content, /changes your curiosity/);
  config.ollama.model = 'new-local-choice'; await localChat(messages);
  assert.equal(calls.at(-1).model, 'new-local-choice');
  const ctx = { perms: { owner: true, files: true }, speaker: { id: 'dashboard' }, userText: 'Adjust the thinking prompt', turn: '1', conversation: 'dashboard' };
  assert.match(await runTool('prompts', { action: 'set', id: 'solo_thought', text: '{{original}}\nBe more reflective.' }, ctx), /Be more reflective/);
  assert.ok(toolFailed(await runTool('prompts', { action: 'set', id: 'solo_thought', text: 'replace' }, { ...ctx, perms: { owner: false } })));
  assert.ok(toolFailed(await runTool('send_project', { name: 'unapproved', files: [{ path: 'index.js', content: 'hello' }] }, { ...ctx, sendHere: () => {} })));
  const { reflections } = await import('./reflections.js');
  const { selectResearch } = await import('./research-policy.js');
  const goal = reflections().add('goal', 'Understand how telescope mirrors hold their shape');
  const selected = selectResearch({ goals: reflections().list() }).selected;
  assert.equal(selected.goalId, goal.id);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.tavily.com/')
    ? new Response(JSON.stringify({ results: [{ title: 'Mirror supports', url: 'https://example.test/mirrors', content: 'Mirror supports distribute the load.' }] }), { status: 200 })
    : realFetch(url, init);
  config.tavily.apiKey = 'mock-only';
  const { research } = await import('./journal.js');
  // Searching costs stored energy now (pressure.js action_costs, owner 2026-11-09); called directly, nothing prepaid it.
  (await import('./pressure.js')).state.reserve = 1;
  const result = await research(selected.text, 'curiosity', { selected });
  assert.equal(result.decision.status, 'written', `${result.decision.reason}: ${result.decision.failure ?? ''}`);
  const saved = reflections().list().find((g) => g.id === goal.id);
  assert.equal(saved.progress.length, 1); assert.match(saved.research.next_question, /active mirror support/);
  reflections().configureGoal(goal.id, false);
  assert.equal(selectResearch({ goals: reflections().list() }).selected, null);
  const cloudRequests = [];
  config.openrouter.apiKey = 'mock-cloud'; config.selfDialogueProvider = 'openrouter';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://openrouter.ai/')) {
      const body = JSON.parse(init.body); cloudRequests.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ thought: 'I can see another interpretation of that feeling.' }) } }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const { selfDialogue, recentDialogues } = await import('./self-dialogue.js');
  const { saveReflection, recent, reflectionContext } = await import('./thoughts.js');
  const pressure = await import('./pressure.js');
  const memory = await import('./memory.js');
  memory.addMessage('context-test', { role: 'user', userId: 'owner', name: 'Owner', content: 'The telescope discussion still worries me.' });
  const memoryDb = new DatabaseSync(path.join(DATA_DIR, 'companion.db'));
  memoryDb.prepare('INSERT INTO memories (user_id, content, embedding, created_at) VALUES (?, ?, ?, ?)')
    .run('owner', 'The telescope project matters to the owner.', '[]', Date.now());
  memoryDb.close();
  pressure.state.lastResearch = { at: Date.now(), title: 'Mirror research marker', entry: 'Load is distributed across supports.' };
  const context = reflectionContext({ conversation: 'context-test', topic: 'telescope uncertainty' });
  assert.match(context, /telescope project matters/);
  assert.match(context, /discussion still worries/);
  assert.match(context, /Mirror research marker/);
  const localBefore = calls.length;
  const reflection = await selfDialogue({ topic: 'A situation with uncertainty', context });
  assert.equal(calls.length - localBefore, 2); assert.equal(cloudRequests.length, 1);
  const discussion = recentDialogues(1)[0];
  assert.deepEqual(discussion.transcript.map((turn) => turn.side), ['local', 'cloud', 'local']);
  assert.equal(discussion.status, 'done');
  // Both sides think with her inner voice, not her outward persona.
  assert.ok(cloudRequests[0].messages[0].content.includes('more candor'));
  if (config.persona) assert.ok(!calls.at(-1).messages[0].content.includes(config.persona));
  assert.equal(cloudRequests[0].tools, undefined);
  for (const call of calls.slice(localBefore)) {
    assert.match(call.messages[0].content, /more candor/);
    assert.equal(JSON.parse(call.messages[1].content).context, context);
  }
  assert.equal(JSON.parse(cloudRequests[0].messages[1].content).context, context);
  const curiosityBefore = pressure.state.buckets.curiosity;
  saveReflection(reflection);
  assert.match(recent(1)[0].content, /stay curious/);
  assert.ok(pressure.state.buckets.curiosity > curiosityBefore);
  editPrompt('solo_thought', '', true); assert.equal(promptText('solo_thought', 'new context'), 'new context');
  // The shipped dashboard script parses and includes both editor controls.
  const html = readFileSync(new URL('./dashboard/public/index.html', import.meta.url), 'utf8');
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.match(html, /id="promptSelect"/); assert.match(html, /id="thoughtFeedbackStrength"/);
  const { startDashboard } = await import('./dashboard/server.js');
  config.dashboard.port = 0; config.dashboard.host = '127.0.0.1'; config.dashboard.password = '';
  const dashboard = startDashboard({ client: null, status: 'offline', since: Date.now() });
  t.after(() => new Promise((resolve) => dashboard.close(resolve)));
  if (!dashboard.listening) await new Promise((resolve) => dashboard.once('listening', resolve));
  const address = `http://127.0.0.1:${dashboard.address().port}`;
  const catalogResponse = await realFetch(address + '/api/prompts');
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.ok(catalog.some((item) => item.id === 'inner_life'));
  assert.ok(catalog.some((item) => item.id === 'self_dialogue_local'));
  const saveResponse = await realFetch(address + '/api/prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'inner_life', text: 'Dashboard guidance round trip' }) });
  assert.equal(saveResponse.ok, false, 'the dashboard can read her inner-life guidance, not set it');
  const listed = await (await realFetch(address + '/api/prompts')).json();
  assert.equal(listed.find((item) => item.id === 'inner_life').template, 'Explore your own emotional response with more candor.');

});
