import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as pressure from './pressure.js';
import { bus } from './events.js';
import { createRewards } from './reward.js';
import { createExperiences, experiences } from './experience.js';
import { learnFromResearch } from './concepts.js';
import { createGraph } from './kg.js';
import { ignore, unignore } from './ignoring.js';

// Owner, 2026-11-09: close the feedback loops. What comes of what she does (and of who she's dealt with)
// feeds back into her pressure, as transfers only, grounded in what the harness can verify.

// Everything accounted for: what she holds, what she's stored, and what has left her (heat, work, fading). Energy
// leaves her now (owner, 2026-11-09: with nothing ever draining, every bucket sat at 1), but never untracked.
const held = () => Object.values(pressure.state.buckets).reduce((n, v) => n + v, 0) + (pressure.state.reserve ?? 0) + (pressure.state.energy_out ?? 0);
const level = (v = 0.3) => { pressure.startPressure(); for (const k of Object.keys(pressure.state.buckets)) pressure.state.buckets[k] = v; pressure.state.reserve = 0; };
const events = (type) => { const got = []; const on = (e) => { if (e.type === type) got.push(e); }; bus.on('activity', on); return { got, stop: () => bus.off('activity', on) }; };
const tmpFile = (name) => path.join(mkdtempSync(path.join(tmpdir(), 'champ-feedback-')), name);
// A stand-in embedder: texts about the same thing (same first word) point the same way.
const embedder = async (texts) => texts.map((t) => { const w = String(t).toLowerCase().split(/\s+/)[0]; const at = [...w].reduce((n, c) => n + c.charCodeAt(0), 0) % 16; return Array.from({ length: 16 }, (_, i) => (i === at ? 1 : 0.01)); });
const until = async (check, what) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`timed out waiting for ${what}`); };

test('a verified success relieves the driving channel into joy and growth, a positive surprise lifts thrill, and nothing is created', async () => {
  level(0.3);
  pressure.state.buckets.curiosity = 0.9;
  const before = held();
  const store = createExperiences({ file: tmpFile('x.jsonl'), embedder, log: () => {} });
  const log = events('reward');
  const r = createRewards({ store });
  const e = await r.expect({ act: 'research', objective: 'telescope mirrors and how they hold their shape', bucket: 'curiosity', level: 0.9 });
  assert.ok(e.expected > 0 && e.expected < 1, `expected ${e.expected}`);
  const joy = pressure.state.buckets.joy, growth = pressure.state.buckets.growth, thrill = pressure.state.buckets.thrill;
  const settled = await r.settle(e, { ok: true, outcome: 1, nodes: ['concept:mirror'] });
  log.stop();
  assert.ok(pressure.state.buckets.curiosity < 0.9, 'the want that drove it is relieved');
  assert.ok(pressure.state.buckets.joy > joy && pressure.state.buckets.growth > growth, 'into joy and growth');
  assert.ok(settled.reward > 0 && pressure.state.buckets.thrill > thrill, 'a better-than-expected outcome lifts thrill');
  assert.ok(Math.abs(held() - before) < 1e-9, `accounted for: ${before} -> ${held()}`);
  const [ev] = log.got;
  assert.deepEqual(Object.keys(ev).filter((k) => ['act', 'objective', 'expected', 'outcome', 'satisfaction', 'reward', 'nodes'].includes(k)).sort(), ['act', 'expected', 'nodes', 'objective', 'outcome', 'reward', 'satisfaction']);
  assert.equal(ev.satisfaction, 1);
  for (const id of ['act:research', 'bucket:curiosity', 'concept:mirror', `experience:${settled.id}`]) assert.ok(ev.nodes.includes(id), `nodes has ${id}: ${ev.nodes}`);
  assert.ok(ev.nodes.every((n) => /^(bucket|concept|person|goal|act|experience):/.test(n)));
});

test('a failure never drains the want that drove it: the disappointment moves into restlessness and irritation', async () => {
  level(0.3);
  pressure.state.buckets.curiosity = 0.8;
  const before = held();
  const store = createExperiences({ file: tmpFile('x.jsonl'), embedder, log: () => {} });
  const r = createRewards({ store });
  const e = await r.expect({ act: 'research', objective: 'who designed the first reflecting telescope', bucket: 'curiosity', level: 0.8 });
  const restless = pressure.state.buckets.restlessness, irritated = pressure.state.buckets.irritation;
  const settled = await r.settle(e, { ok: false, result: 'inconclusive', why: 'the results did not name anyone' });
  assert.equal(pressure.state.buckets.curiosity, 0.8, 'desire untouched');
  assert.ok(settled.reward < 0 && settled.satisfaction === 0);
  assert.ok(pressure.state.buckets.restlessness > restless && pressure.state.buckets.irritation > irritated);
  assert.ok(Math.abs(held() - before) < 1e-9, 'conserved');
  assert.equal(store.all().at(-1).why, 'the results did not name anyone');
});

test('expectation comes from her record: after failing at something similar she expects less of it', async () => {
  level(0.3);
  const store = createExperiences({ file: tmpFile('x.jsonl'), embedder, log: () => {} });
  const r = createRewards({ store, apply: () => ({}) });
  const first = await r.expect({ act: 'research', objective: 'telescope mirror coatings', bucket: 'curiosity', level: 0.5 });
  for (let i = 0; i < 3; i++) await r.settle(await r.expect({ act: 'research', objective: 'telescope mirror grinding', bucket: 'curiosity', level: 0.5 }), { ok: false, why: 'nothing found' });
  const after = await r.expect({ act: 'research', objective: 'telescope mirror coatings', bucket: 'curiosity', level: 0.5 });
  assert.ok(after.similar > 0, 'similar attempts found by meaning');
  assert.ok(after.expected < first.expected, `${first.expected} -> ${after.expected}`);
  // How hard the want pushes colours the expectation too.
  const keen = await r.expect({ act: 'research', objective: 'telescope mirror coatings', bucket: 'curiosity', level: 1 });
  assert.ok(keen.expected > after.expected);
});

test('failures are kept with how she tried and why, found again by meaning, and logged as experience events', async () => {
  const got = [];
  const store = createExperiences({ file: tmpFile('x.jsonl'), embedder, log: (type, e) => got.push({ type, ...e }) });
  await store.add({ act: 'research', objective: 'telescope mirror coatings', method: 'searching the web for "mirror coating"', spent: 0.4, result: 'failed', why: 'the search failed', person: 'u1', bucket: 'curiosity' });
  await store.add({ act: 'web_search', objective: 'telescope prices', method: 'web search', spent: 0.4, result: 'ok' });
  await store.add({ act: 'research', objective: 'bread baking', method: 'web', result: 'failed', why: 'no results' });
  const like = await store.similar('telescope mirror polishing', { act: 'research' });
  assert.equal(like.length, 1);
  assert.equal(like[0].why, 'the search failed');
  assert.equal(got.filter((e) => e.type === 'experience').length, 2, 'only failures are experience events');
  const ev = got[0];
  for (const k of ['objective', 'method', 'spent', 'result', 'why', 'nodes']) assert.ok(k in ev, k);
  assert.ok(ev.nodes.includes('person:u1') && ev.nodes.includes('act:research') && ev.nodes.some((n) => n.startsWith('experience:')));
  assert.equal(store.unresolvedFailures(5).length, 2);
  await store.add({ act: 'research', objective: 'anything', result: 'ok' });
  assert.equal(store.unresolvedFailures(5).length, 0, 'a later success at the same kind of act resolves them');
  // Embeddings down: still recorded, just not comparable by meaning.
  const blind = createExperiences({ file: tmpFile('y.jsonl'), embedder: async () => { throw new Error('down'); }, log: () => {} });
  await blind.add({ act: 'research', objective: 'x', result: 'failed', why: 'y' });
  assert.equal(blind.all().length, 1);
  assert.deepEqual(await blind.similar('x'), []);
});

test('what a research pass found is stored in her graph with where it came from; what was new becomes a lead', async () => {
  const graph = createGraph(new DatabaseSync(':memory:'), { embedder, selfName: () => 'Amy' });
  await graph.addFacts([{ name: 'Speculum metal', type: 'thing', text: 'Speculum metal is a copper-tin alloy.', saidBy: 'Owner', place: 'voice' }]);
  const findings = 'Newton built the first reflecting telescope in 1668 using a mirror of speculum metal. Silver-on-glass mirrors were introduced by Foucault in 1857.';
  const read = { subject: 'telescope optics', concepts: [
    { name: 'Speculum metal', type: 'thing', fact: 'Speculum metal was used for early telescope mirrors.', relation: 'was used in', evidence: 'using a mirror of speculum metal', question: 'Why did speculum metal tarnish so quickly?' },
    { name: 'Silver-on-glass mirror', type: 'thing', fact: 'Silver-on-glass mirrors were introduced by Foucault in 1857.', relation: 'is a technique in', evidence: 'Silver-on-glass mirrors were introduced by Foucault', question: 'How is silver deposited onto glass for telescope mirrors?' },
    { name: 'Hubble', type: 'thing', fact: 'Hubble has a 2.4 m mirror.', relation: 'uses', evidence: 'Hubble has a 2.4 m primary mirror', question: 'How was the Hubble mirror flaw fixed?' },
  ] };
  const got = [];
  const learned = await learnFromResearch({ query: 'first reflecting telescope mirror material', title: 'Early telescope mirrors', entry: 'I read about it.', findings, topic: 'What were early telescope mirrors made of?', file: 'journal/2026-11-09.md' },
    { json: async () => read, graph, now: () => 1000, log: (type, e) => got.push({ type, ...e }) });
  assert.equal(learned.subject, 'telescope optics');
  assert.deepEqual(learned.concepts.map((c) => c.name).sort(), ['Silver-on-glass mirror', 'Speculum metal'], 'only what the results state is stored');
  assert.equal(graph.resolve('Hubble'), null, 'an ungrounded concept never enters her graph');
  assert.deepEqual(learned.fresh.map((c) => c.name), ['Silver-on-glass mirror'], 'a concept she already had is not new');
  assert.equal(learned.leads.length, 1);
  assert.equal(learned.leads[0].text, 'How is silver deposited onto glass for telescope mirrors?');
  assert.equal(learned.leads[0].at, 1000);
  const about = graph.about('Silver-on-glass mirror');
  assert.match(about.facts[0].from, /while researching "first reflecting telescope mirror material" for the journal entry "Early telescope mirrors"/);
  assert.ok(about.links.some((l) => /telescope optics/.test(l.text)), 'linked to the broader subject');
  const ev = got.find((e) => e.type === 'concepts-learned');
  assert.ok(ev.nodes.includes(`concept:${graph.resolve('Silver-on-glass mirror')}`) && ev.nodes.includes(`concept:${graph.resolve('telescope optics')}`));
  // A model that's down: the entry stands, nothing is stored, and the failure says what and why.
  const down = await learnFromResearch({ query: 'q', title: 't', entry: 'e', findings }, { json: async () => { throw new Error('model offline'); }, graph, log: (type, e) => got.push({ type, ...e }) });
  assert.deepEqual(down.concepts, []);
  assert.match(got.at(-1).message, /model offline.*Check her local model/);
});

test('someone with a good record arriving moves energy toward the social channels; it happens once per arrival', () => {
  level(0.3);
  const id = 'u-friend';
  pressure.state.loneliness[id] = { name: 'Nova', bond: 0.8, value: 0, last_seen: Date.now() - 2 * 3600_000 };
  const before = held();
  const s = { ...pressure.state.buckets };
  const log = events('anticipation');
  const a = pressure.onArrival({ id, name: 'Nova' }, { via: 'voice' });
  log.stop();
  assert.ok(a.value > 0, `value ${a.value}`);
  for (const b of ['social_hunger', 'attentive', 'joy']) assert.ok(pressure.state.buckets[b] > s[b], b);
  assert.ok(Math.abs(held() - before) < 1e-9, 'a transfer, not new energy');
  assert.equal(log.got.length, 1);
  assert.equal(log.got[0].person, id);
  assert.ok('basis' in log.got[0] && log.got[0].nodes.includes(`person:${id}`));
  assert.equal(pressure.onArrival({ id, name: 'Nova' }, { via: 'text' }), null, 'their next line is not a second arrival');
});

test('someone she is ignoring arriving moves energy toward inhibition and unease', () => {
  level(0.3);
  const id = 'u-troll';
  ignore({ id, name: 'Troll' }, 'kept baiting her');
  try {
    pressure.state.loneliness[id] = { name: 'Troll', bond: 0.2, value: 0, last_seen: Date.now() - 5 * 3600_000 };
    const s = { ...pressure.state.buckets };
    const a = pressure.onArrival({ id, name: 'Troll' });
    assert.ok(a.value <= -0.6 && a.basis.ignored);
    assert.ok(pressure.state.buckets.inhibition > s.inhibition && pressure.state.buckets.unease > s.unease);
    assert.ok(pressure.state.buckets.joy <= s.joy);
  } finally { unignore({ id, name: 'Troll' }); }
  // No history at all: nothing to anticipate.
  assert.equal(pressure.onArrival({ id: 'u-nobody', name: 'New' }), null);
});

test('a requested effortful tool records an expectation and settles it with the person who asked; a caller that tracks its own outcome is not counted twice', async (t) => {
  const { runTool } = await import('./tools.js');
  const { config } = await import('./config.js');
  const realFetch = globalThis.fetch, realKey = config.tavily.apiKey;
  t.after(() => { globalThis.fetch = realFetch; config.tavily.apiKey = realKey; });
  config.tavily.apiKey = 'mock-only';
  let status = 503;
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.tavily.com/')
    ? (status === 200 ? new Response(JSON.stringify({ results: [{ title: 'Mirrors', url: 'https://example.test/m', content: 'Mirrors.' }] }), { status }) : new Response('busy', { status }))
    : realFetch(url, init);
  level(0.3);
  pressure.state.reserve = 3;
  const ctx = { perms: { search: true }, speaker: { id: 'u-asker', name: 'Asker' }, conversation: 'text:1' };
  const log = events('reward');
  let count = experiences.all().length;
  await runTool('web_search', { query: 'telescope mirror coatings history' }, ctx);
  await until(() => experiences.all().length > count, 'the failed search to settle');
  const failed = experiences.all().at(-1);
  assert.equal(failed.act, 'web_search');
  assert.equal(failed.result, 'failed');
  assert.equal(failed.person, 'u-asker');
  assert.match(failed.why, /Tavily search failed \(503\)/);
  status = 200;
  count = experiences.all().length;
  await runTool('web_search', { query: 'telescope mirror coatings history' }, ctx);
  await until(() => experiences.all().length > count, 'the search to settle');
  assert.equal(experiences.all().at(-1).result, 'ok');
  count = experiences.all().length;
  await runTool('web_search', { query: 'something else entirely' }, { ...ctx, outcomeTracked: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(experiences.all().length, count, 'outcomeTracked: the caller settles it');
  log.stop();
  assert.ok(log.got.some((e) => e.act === 'web_search' && e.nodes.includes('person:u-asker') && e.nodes.includes('act:web_search')));
});

test('her own research: a failure is kept and leaves the want; a written entry stores leads and is rewarded with the asker', async () => {
  pressure.startPressure();
  for (const set of ['setActor', 'setWonderer', 'setSelfWork', 'setOnboarding', 'setDiscoverer', 'setMessenger', 'setThinker', 'setBodyPlanner', 'setGoalWorker']) pressure[set](null);
  pressure.setInterests(() => []);
  const s = pressure.state;
  const run = async (question, result) => {
    for (const k of Object.keys(s.buckets)) s.buckets[k] = 0.2;
    s.buckets.curiosity = 1;
    s.reserve = 2;
    s.research_times = []; s.research_attempts = []; s.fired_at = {};
    s.openQuestions = [{ text: question, at: Date.now(), conversation: 'voice:1', speaker: 'Nova', speakerId: 'u-nova' }];
    s.last_message = Date.now(); s.last_tick = Date.now();
    pressure.setResearcher(async () => result);
    const count = experiences.all().length;
    const log = events('reward');
    const fired = pressure.tick('test');
    assert.equal(fired?.doing, 'research');
    const curiosityAfterFiring = s.buckets.curiosity;
    await until(() => log.got.length && experiences.all().length > count, 'the outcome to settle');
    log.stop();
    return { reward: log.got[0], experience: experiences.all().at(-1), curiosityAfterFiring };
  };
  const failed = await run('How do telescope mirrors hold their shape under temperature changes?', { decision: { id: 'd1', status: 'inconclusive', query: 'telescope mirror thermal deformation', reason: 'relevant', failure: 'The results did not state the specific fact the question asks for' } });
  assert.equal(failed.experience.result, 'inconclusive');
  assert.equal(failed.experience.person, 'u-nova');
  assert.match(failed.experience.method, /telescope mirror thermal deformation/);
  assert.match(failed.experience.why, /did not state the specific fact/);
  // (Exactly untouched is checked above with the flow held still; here her live flow keeps running, so: not emptied the way a success empties it.)
  assert.ok(s.buckets.curiosity > failed.curiosityAfterFiring - 0.01, `failing never drains the want: ${failed.curiosityAfterFiring} -> ${s.buckets.curiosity}`);
  assert.ok(failed.reward.reward < 0 && failed.reward.nodes.includes('person:u-nova'));
  assert.match(pressure.moodLine(null, { coaching: false }), /still unresolved from your own attempts/);

  const lead = { text: 'How is silver deposited onto glass for telescope mirrors?', at: Date.now(), conversation: '', speaker: null, speakerId: null, source: 'research', concept: 'silver on glass mirror' };
  const written = await run('What were the first telescope mirrors made of, and who made them?', { title: 'Early mirrors', entry: 'Speculum metal.', bringUp: '', decision: { id: 'd2', status: 'written', query: 'first telescope mirror material' },
    learned: { subject: 'telescope optics', concepts: [{ id: 'silver on glass mirror', name: 'Silver-on-glass mirror', new: true }], fresh: [{ id: 'silver on glass mirror' }], leads: [lead], nodes: ['concept:silver on glass mirror'] } });
  assert.equal(written.experience.result, 'ok');
  assert.equal(written.reward.satisfaction, 1);
  assert.ok(written.reward.nodes.includes('concept:silver on glass mirror'));
  assert.ok(s.curiosity_leads.some((l) => l.text === lead.text), 'what was new to her is a lead');
  assert.ok(pressure.curiosityLeads().questions >= 1);
  assert.ok(pressure.researchSelection().candidates.some((c) => c.text === lead.text), 'research can pick the lead up');
  pressure.setResearcher(null);
});
