import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Owner, 2026-11-11: "The grant stuff that he was researching, how do we make sure that he's on the right path and he's
// staying connected and not just pulling up random stuff?" His goal "Research programs that could provide grants,
// credits, or other support for running our scenario experiments" had lost what it was for (AI/LLM experiments). Its
// first search found the NATA Foundation (athletic-training research grants) and four more passes dug into NATA's
// eligibility and deadlines, each graded a success, until he brought Owner the NATA pre-proposal deadline.

const PURPOSE = 'Grants, cloud credits or compute programs for AI/LLM agent experiments: James\'s harness and the scenario tests with Ultra';

test('a goal keeps what it is for; every pass is held to it; drift is graded a miss and kept as the lesson; the first lead goes back to whoever asked', async (t) => {
  const seen = { planner: [], writer: [] };
  let onGoal = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    if (body.input) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ embeddings: [].concat(body.input).map(() => [1, 0, 0]) })); return; }
    const system = body.messages?.[0]?.content ?? '';
    let content = JSON.stringify({ ok: true });
    if (system.includes('Decide whether this autonomous research')) {
      const payload = JSON.parse(body.messages[1].content);
      seen.planner.push(payload);
      content = JSON.stringify({ search: true, query: onGoal ? 'AI research cloud credits programs for LLM agent experiments' : 'research grant programs eligibility deadlines', reason: 'advances the goal', evidence: payload.source.text.slice(0, 40), confidence: 0.95 });
    } else if (system.includes('writing in your private journal')) {
      seen.writer.push({ system, payload: JSON.parse(body.messages[1].content) });
      content = JSON.stringify(onGoal
        ? { title: 'Cloud credits for AI research', entry: 'Several cloud providers run research credit programs for AI work.', answered: true, fact: 'Google Cloud research credits fund AI experiments', relevant: true, on_goal: true, on_goal_why: 'compute credits for AI research', sources: ['https://example.test/credits'], bring_up: 'credits', next_question: 'Which AI credit programs accept independent researchers?' }
        : { title: 'NATA Foundation grants', entry: 'The NATA Foundation funds athletic training research.', answered: true, fact: 'Pre-proposals due September 1', relevant: true, on_goal: false, on_goal_why: 'athletic-training research grants, not AI or compute', sources: ['https://example.test/nata'], bring_up: 'NATA', next_question: 'What is the NATA pre-proposal deadline?' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
  const { config } = await import('./config.js');
  config.ollama.host = process.env.OLLAMA_HOST; config.ollama.model = 'test-local';
  config.cognition.provider = 'ollama'; config.openrouter.apiKey = ''; config.tavily.apiKey = 'mock-only';
  config.ownerIds = ['owner1']; // goal changes are the owner's, in his own conversation
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.tavily.com/')
    ? new Response(JSON.stringify({ results: [{ title: 'r', url: onGoal ? 'https://example.test/credits' : 'https://example.test/nata', content: 'result' }] }), { status: 200 })
    : realFetch(url, init);

  const { runTool, toolFailed } = await import('./tools.js');
  const { reflections } = await import('./reflections.js');
  const { selectResearch } = await import('./research-policy.js');
  const { research } = await import('./journal.js');
  (await import('./pressure.js')).state.reserve = 3;
  const body = (result) => JSON.parse(String(result).replace(/^\[[^\]]*\]\s*/, '')); // results start with a "[goal: ok]" header
  const ctx = { perms: { owner: true }, speaker: { id: 'owner1', name: 'Owner' }, userText: 'Add a goal: find grants or credits for our AI scenario experiments', turn: '1', conversation: 'voice:room' };

  // 1. A goal can't be added without what it's for, and the error says why and what to do.
  const bare = await runTool('goal', { action: 'add', text: 'Find grant programs for our scenario experiments' }, ctx);
  assert.ok(toolFailed(bare)); assert.match(bare, /purpose/); assert.match(bare, /athletic-training/);
  const added = body(await runTool('goal', { action: 'add', text: 'Find grant programs for our scenario experiments', purpose: PURPOSE, not_this: ['medical, sports or unrelated academic grants'] }, ctx));
  assert.equal(added.anchor.purpose, PURPOSE);
  assert.equal(added.anchor.from, 'Owner');
  assert.match(added.anchor.quote, /AI scenario experiments/);
  assert.match(reflections().promptBlock(), /What it's for \(Owner\): Grants, cloud credits/);

  // 2. A pass that answers the query about the wrong field: off track, graded a miss, the lesson kept, no NATA next question.
  let selected = selectResearch({ goals: reflections().list() }).selected;
  assert.match(selected.purpose, /AI\/LLM agent experiments/);
  const drift = await research(selected.text, 'curiosity', { selected });
  assert.equal(seen.planner.at(-1).goalPurpose, selected.purpose, 'the planner is told what the goal is for');
  assert.match(seen.writer.at(-1).system, /on_goal/);
  assert.equal(drift.decision.status, 'inconclusive');
  assert.match(drift.decision.failure, /went off the goal: athletic-training/);
  let goal = reflections().list().find((g) => g.id === added.id);
  assert.equal(goal.progress.at(-1).status, 'off_goal');
  assert.equal(goal.research.next_question, '', 'no drilling into the off-track finding');
  assert.equal(goal.anchor.offTrack.at(-1).query, 'research grant programs eligibility deadlines');
  assert.equal(goal.checkIn, undefined, 'an off-track pass is not a lead');
  selected = selectResearch({ goals: reflections().list() }).selected;
  assert.match(selected.purpose, /Already found off track.*athletic-training/);

  // 3. A pass that serves the purpose: progress, and the first lead goes back to Owner as "is this what you meant?".
  onGoal = true;
  const good = await research(selected.text, 'curiosity', { selected });
  assert.equal(good.decision.status, 'written');
  goal = reflections().list().find((g) => g.id === added.id);
  assert.match(goal.checkIn.lead, /Cloud credits for AI research/);
  assert.match(good.bringUp, /goal Owner gave me.*Is that the kind of thing you meant\?/);
  assert.match(reflections().promptBlock(), /First lead, not yet checked with Owner/);

  // 4. His answer steers it: the check-in is answered and what counts grows.
  const steered = body(await runTool('goal', { action: 'steer', id: added.id, answer: 'Yes, cloud credits like that', fits: ['cloud research credit programs'] }, { ...ctx, userText: 'Yes, cloud credits like that are exactly it' }));
  assert.equal(steered.checkIn.answer, 'Yes, cloud credits like that');
  assert.deepEqual(steered.anchor.fits, ['cloud research credit programs']);
  assert.doesNotMatch(reflections().promptBlock(), /First lead, not yet checked/);

  // 5. A new purpose resets the trail of next questions, so the next pass starts from the purpose.
  const repointed = body(await runTool('goal', { action: 'steer', id: added.id, purpose: 'GPU time for training small models' }, ctx));
  assert.equal(repointed.anchor.purpose, 'GPU time for training small models');
  assert.equal(repointed.research.next_question, '');
});

test('an old goal with no purpose says so in his prompt, so he asks', async () => {
  const { createReflections } = await import('./reflections.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const r = createReflections(path.join(mkdtempSync(path.join(tmpdir(), 'goals-')), 'r.json'));
  r.add('goal', 'Research programs that could provide grants, credits, or other support for running our scenario experiments');
  assert.match(r.promptBlock(), /No purpose saved for this goal: if you don't know exactly what it's for, ask/);
});
