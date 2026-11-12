import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { assemble, layout, cluster, kindClusters, eventNodes, createMind, mindRoutes, FILES } from './cognitive-graph.js';

// A small stand-in for her systems, shaped like what the owning modules return.
function fakeSources(extra = {}) {
  const cfg = {
    buckets: { boredom: { enabled: true, threshold: 0.65, fill_rate: 0.015, decay_rate: 0.04, drain: 0.55, hysteresis: 0.25 },
      curiosity: { enabled: true, threshold: 0.5, fill_rate: 0.03, decay_rate: 0.004, drain: 0.7, hysteresis: 0.15 },
      explore: { enabled: true, threshold: 0.5, fill_rate: 0.04, decay_rate: 0.02, drain: 0.6, hysteresis: 0.15 },
      loneliness: { enabled: true, threshold: 0.6, fill_rate: 0.0015, decay_rate: 0, drain: 0.4, hysteresis: 0.25 } },
    flows: [['boredom', 'curiosity', 0.12], ['curiosity', 'explore', 0.15]],
    flow: { couplings: [['curiosity', 'boredom', -0.004]] },
    seeds: { boredom: { curiosity: 0.1 } },
    feelings: { tau: { joy: 90, thrill: 25 }, impulses: { discovered: { thrill: 0.35, joy: 0.15 }, wanted: { joy: 0.25 } } },
    action_costs: { web_search: 0.4, research: 0.4, workshop: { job: 1.2 } },
    priority: { needs: 1, desires: 0.6 }, store_share: 0.4, reserve_use: 0.02, overheard_uptake: 0.15,
  };
  return {
    selfName: () => 'Amy',
    contacts: () => [{ user_id: '111', name: 'Owner', username: 'trav', tier: 'owner', first_seen: 1000, last_seen: 5000 }],
    kg: () => ({
      nodes: [{ id: '111', name: 'Owner', type: 'person', aliases: ['Trav'], mentions: 4, first_seen: 1100, last_seen: 4000 },
        { id: 'rex', name: 'Rex', type: 'pet', aliases: [], mentions: 2, first_seen: 1200, last_seen: 3000 }],
      links: [{ id: 7, from_id: '111', rel: 'owns', to_id: 'rex', said_by: 'Owner', place: '#general', count: 3, at: 1300 },
        { id: 8, from_id: 'rex', rel: 'chases', to_id: 'ghost', said_by: 'Owner', place: '', count: 1, at: 1400 }],
      facts: [{ id: 1, node_id: 'rex', said_by: 'Owner', at: 1250 }],
    }),
    personal: () => ({
      nodes: [{ id: 'experience:42', kind: 'experience', label: 'Conversation experience' }, { id: 'person:111', kind: 'person', label: 'Owner' },
        { id: 'topic:music', kind: 'topic', label: 'music' }, { id: 'feeling:joy', kind: 'feeling', label: 'joy' }, { id: 'self', kind: 'person', label: 'Amy' }],
      links: [{ experience: 42, source: 'experience:42', relation: 'with_person', target: 'person:111', strength: null },
        { experience: 42, source: 'experience:42', relation: 'about', target: 'topic:music', strength: null },
        { experience: 42, source: 'experience:42', relation: 'felt_during', target: 'feeling:joy', strength: 0.6 },
        { experience: 42, source: 'self', relation: 'affinity', target: 'person:111', strength: 30 }],
      experiences: [{ id: 42, created_at: 2000, name: 'Owner', user_id: '111', conversation: 'dm', evidence: 'we talked about music' }],
    }),
    memories: () => [{ id: 5, user_id: '111', content: 'Owner has a dog named Rex', created_at: 1500 }, { id: 6, user_id: '222', content: 'Sam likes chess', created_at: 1600 }],
    memoryNames: () => ({ 111: 'Owner', 222: 'Sam' }),
    interests: () => [{ name: 'Music', interest: 0.4, mentions: 3, last: 2100, sources: { conversation: 3 }, people: { Owner: 3 } }],
    reflections: () => ({ items: [{ id: 1, kind: 'goal', text: 'learn to make better music', at: 2200, bucket: 'curiosity', activity: 'research' }, { id: 2, kind: 'insight', text: 'I like making people laugh', at: 2300 }],
      experiences: [{ id: 'abc', goalId: 1, outcome: 'researched', summary: 'read about chords', at: 2400 }] }),
    pressure: () => ({ cfg, state: { buckets: { boredom: 0.3, curiosity: 0.2, explore: 0.1, loneliness: 0, joy: 0.2, thrill: 0 }, reserve: 0.5, loneliness: { 111: { name: 'Owner', value: 0.2 } } },
      labels: { boredom: 'bored' }, research: ['boredom', 'curiosity', 'explore'], layerOf: null, configAt: 900 }),
    body: () => ({ emotions: { joy: 'happy', calm: 'relaxed' }, feelings: { joy: 0.4 }, appearanceFields: ['hair', 'eyes'], appearance: { hair: '#111111', eyes: null } }),
    tools: () => [{ name: 'web_search', description: 'Search the web' }, { name: 'remember', description: 'Remember something' }],
    discoveries: () => ({ tried: { web_search: 1700 } }),
    resolvePerson: (name) => ({ owner: '111', trav: '111', amy: 'self' })[String(name).toLowerCase()] ?? null,
    ...extra,
  };
}

test('the graph is assembled from her systems with stable ids and provenance on every node and edge', () => {
  const g = assemble(fakeSources(), { now: () => 9999 });
  const ids = g.nodes.map((n) => n.id);
  for (const id of ['person:111', 'person:self', 'person:222', 'concept:rex', 'concept:topic:music', 'experience:42', 'memory:5', 'memory:6',
    'interest:music', 'goal:1', 'insight:2', 'experience:goal-abc', 'bucket:boredom', 'bucket:joy', 'bucket:reserve', 'act:web_search', 'act:research',
    'act:workshop', 'act:remember', 'body:feeling:joy', 'body:feeling:calm', 'body:appearance:hair', 'body:mouth', 'body:blink']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  for (const n of g.nodes) {
    assert.match(n.id, /^(person|concept|memory|experience|interest|goal|insight|bucket|act|body):/);
    assert.ok(n.provenance.source, `${n.id} has no provenance source`);
  }
  for (const e of g.edges) assert.ok(e.origin.source, `${e.from}->${e.to} has no origin`);
  // Owner is one node, seen by contacts, the knowledge graph and the personal word-net.
  const owner = g.nodes[g.byId.get('person:111')];
  assert.equal(owner.provenance.source, 'memory.js contacts');
  assert.ok(owner.alsoFrom.some((p) => p.source === 'kg.js kg_nodes'));
  // Real links with their origin: who said it, where, when.
  const owns = g.edges.find((e) => e.type === 'owns');
  assert.deepEqual([owns.from, owns.to, owns.strength], ['person:111', 'concept:rex', 3]);
  assert.deepEqual(owns.origin, { source: 'kg.js kg_links', ref: 'L7', by: 'Owner', place: '#general', at: 1300 });
  assert.equal(g.nodes[g.byId.get('concept:rex')].provenance.by, 'Owner', 'a kg node is credited to whoever told her its first fact');
  // A link to something that isn't there is dropped and counted, never filled in.
  assert.ok(!ids.includes('concept:ghost'));
  assert.equal(g.dropped.count, 1);
  assert.match(g.dropped.examples[0], /ghost/);
  // Pressure flows, couplings, seeds, costs and loneliness are edges from the config and state.
  const has = (from, to, type) => g.edges.some((e) => e.from === from && e.to === to && e.type === type);
  assert.ok(has('bucket:boredom', 'bucket:curiosity', 'flow'));
  assert.ok(has('bucket:curiosity', 'bucket:boredom', 'coupling'));
  assert.ok(has('bucket:boredom', 'bucket:curiosity', 'seeds'));
  assert.ok(has('act:web_search', 'bucket:reserve', 'costs'));
  assert.ok(has('act:workshop', 'bucket:reserve', 'costs (job)'));
  assert.ok(has('person:111', 'bucket:loneliness', 'missed'));
  assert.ok(has('interest:music', 'person:111', 'came up with'));
  assert.ok(has('interest:music', 'concept:topic:music', 'same topic'));
  assert.ok(has('experience:42', 'body:feeling:joy', 'felt_during'));
  assert.ok(has('person:self', 'person:111', 'affinity'));
  assert.ok(has('memory:5', 'person:111', 'about'));
  assert.ok(has('goal:1', 'bucket:curiosity', 'driven by'));
  // Editable values are the real config values, with the path pressure.setConfigValue takes.
  const boredom = g.nodes[g.byId.get('bucket:boredom')];
  assert.deepEqual(boredom.data.editable.find((x) => x.path === 'buckets.boredom.threshold'), { module: 'pressure', path: 'buckets.boredom.threshold', value: 0.65, type: 'number', min: 0, max: 1, label: 'threshold' });
  assert.ok(boredom.data.editable.some((x) => x.path === 'flows.0.2'));
  assert.equal(boredom.data.layer, null, 'no layer is shown while pressure.js keeps it unexported');
  assert.ok(g.nodes[g.byId.get('body:blink')].data.readOnly, 'browser-only body controls say why they are read-only');
});

test('a kg link from a contact id without its own kg row lands on that person; self-links are skipped, not reported', () => {
  const base = fakeSources();
  const g = assemble(fakeSources({ kg: () => ({ ...base.kg(), nodes: base.kg().nodes.filter((n) => n.id !== '111'),
    links: [{ id: 3, from_id: '111', rel: 'owns', to_id: 'rex', count: 1, at: 1 }, { id: 4, from_id: 'rex', rel: 'is', to_id: 'rex', count: 1, at: 1 }] }) }));
  assert.ok(g.edges.some((e) => e.from === 'person:111' && e.to === 'concept:rex' && e.type === 'owns'));
  assert.equal(g.dropped.count, 0);
});

test('a source that fails is reported with the reason, and the rest still builds', () => {
  const g = assemble(fakeSources({ kg: () => { throw new Error('no such table: kg_nodes'); } }));
  assert.equal(g.unavailable.length, 1);
  assert.match(g.unavailable[0].error, /knowledge graph \(kg\.js\) couldn't be read: no such table/);
  assert.ok(g.byId.has('person:111'));
});

test('the layout is deterministic for the same graph and seed, differs by seed, and changes as she grows', () => {
  const g = assemble(fakeSources());
  const a = layout(g, 'seed-one'), b = layout(assemble(fakeSources()), 'seed-one'), c = layout(g, 'seed-two');
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...c]);
  for (const p of a.values()) assert.ok(p.every(Number.isFinite));
  const grown = assemble(fakeSources({ memories: () => [{ id: 5, user_id: '111', content: 'Owner has a dog named Rex', created_at: 1500 }, { id: 9, user_id: '111', content: 'Owner plays guitar', created_at: 3000 }] }));
  const d = layout(grown, 'seed-one');
  assert.ok(d.has('memory:9'));
  assert.notDeepEqual(d.get('person:111'), a.get('person:111'));
});

test('a few thousand nodes lay out quickly', () => {
  const memories = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, user_id: String(100 + (i % 40)), content: `fact ${i}`, created_at: i }));
  const g = assemble(fakeSources({ memories: () => memories, contacts: () => [] }));
  const t = Date.now();
  const pos = layout(g, 'big');
  assert.equal(pos.size, g.nodes.length);
  assert.ok(Date.now() - t < 8000, `layout took ${Date.now() - t} ms`);
  const { clusters } = cluster(g, 'big', pos);
  assert.ok(clusters.length < g.nodes.length / 10, 'zoomed out, thousands of nodes fold into far fewer clusters');
});

test('clusters group nodes by kind and community, and cluster edges sum real edges', () => {
  const memories = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, user_id: i < 6 ? '111' : '222', content: `m${i}`, created_at: i }));
  const g = assemble(fakeSources({ memories: () => memories }));
  const pos = layout(g, 's');
  const { clusters, clusterOf, edges } = cluster(g, 's', pos);
  const of = (id) => clusterOf[g.byId.get(id)];
  assert.equal(of('memory:1'), of('memory:2'), "Owner's memories share a cluster");
  assert.notEqual(of('memory:1'), of('memory:7'), "Sam's memories are a different cluster");
  for (const c of clusters) assert.ok(c.id.startsWith(`cluster:${c.kind}:`));
  assert.ok(edges.every((e) => e.origin.count >= 1 && e.strength === e.origin.count));
  const kinds = kindClusters(g, pos);
  assert.equal(kinds.clusters.find((c) => c.kind === 'memory').count, 12);
  assert.equal(cluster(g, 's', pos).clusters.map((c) => c.id).join(), clusters.map((c) => c.id).join(), 'clustering is deterministic');
});

test('events map to the real nodes they touched', () => {
  const src = fakeSources();
  const g = assemble(src);
  const cfg = src.pressure().cfg;
  const map = (e) => eventNodes(e, g, { resolvePerson: src.resolvePerson, cfg }).nodes.sort();
  assert.deepEqual(map({ type: 'pressure', fired: 'boredom', person: '111' }), ['bucket:boredom', 'person:111']);
  assert.deepEqual(map({ type: 'tool-call', tool: 'web_search', ok: true }), ['act:web_search']);
  assert.deepEqual(map({ type: 'heard', speaker: 'Owner', userId: '111', text: 'hi' }), ['person:111']);
  assert.deepEqual(map({ type: 'intake', speaker: 'Trav', praise: 0.6 }), ['person:111']);
  assert.deepEqual(map({ type: 'expression', feelings: 'joy 0.5, calm 0.2' }), ['body:feeling:calm', 'body:feeling:joy']);
  assert.deepEqual(map({ type: 'pressure', discovered: 'web_search' }), ['act:web_search', 'bucket:joy', 'bucket:thrill']);
  assert.deepEqual(map({ type: 'journal', why: 'curiosity', query: 'chords' }), ['act:research', 'bucket:curiosity']);
  assert.deepEqual(map({ type: 'topic', topic: 'Music' }), ['concept:topic:music']);
  assert.deepEqual(map({ type: 'tool-call', tool: 'not_a_tool' }), [], 'nothing is lit that is not in her graph');
  // New events name their nodes; ones not in the graph yet are reported so the graph can be refreshed.
  const r = eventNodes({ type: 'reward', nodes: ['bucket:joy', 'concept:new-thing'] }, g, { cfg });
  assert.deepEqual(r.nodes, ['bucket:joy']);
  assert.deepEqual(r.unknown, ['concept:new-thing']);
});

function tmp() {
  return mkdtempSync(path.join(process.env.CHAMP_DATA_DIR ?? tmpdir(), 'mind-'));
}
// A stand-in editor that validates like the owning module: numbers 0..1 only.
function fakeEditor(store) {
  const walk = (p) => p.split('.').reduce((o, k) => o?.[k], store);
  return {
    get: (p) => walk(p),
    set: (p, value) => {
      if (typeof value !== 'number' || value < 0 || value > 1) throw Object.assign(new Error(`"${p}" must be between 0 and 1, got ${value}.`), { status: 400 });
      const keys = p.split('.');
      const parent = keys.slice(0, -1).reduce((o, k) => o[k], store);
      const before = parent[keys.at(-1)];
      parent[keys.at(-1)] = value;
      return { path: p, before, after: value };
    },
  };
}

test('her seed is made once and kept, and the change log records what grew', () => {
  const dir = tmp();
  let memories = [{ id: 5, user_id: '111', content: 'Owner has a dog named Rex', created_at: 1500 }];
  const sources = fakeSources({ memories: () => memories });
  let t = 10_000;
  const mind = createMind({ sources, dataDir: dir, now: () => t, staleMs: 0 });
  assert.ok(existsSync(path.join(dir, FILES.seed)));
  assert.equal(createMind({ sources, dataDir: dir }).seed, mind.seed, 'the same instance keeps its seed');
  assert.notEqual(createMind({ sources, dataDir: tmp() }).seed, mind.seed, 'another instance gets its own');
  mind.build();
  const first = mind.history();
  assert.ok(first.entries.every((e) => e.baseline), 'the first build records her as she was');
  assert.ok(first.entries.some((e) => e.op === 'node-added' && e.id === 'memory:5' && e.since === 1500));
  t = 20_000;
  memories = [...memories, { id: 9, user_id: '111', content: 'Owner plays guitar', created_at: 15_000 }];
  mind.build();
  const grew = mind.history({ since: 10_000 }).entries;
  assert.deepEqual(grew.map((e) => e.op).sort(), ['edge-added', 'node-added']);
  assert.equal(grew.find((e) => e.op === 'node-added').id, 'memory:9');
  t = 30_000;
  mind.build();
  assert.equal(mind.history({ since: 20_000 }).total, 0, 'nothing logged when nothing changed');
  const g1 = mind.graph();
  assert.equal(mind.graph({ since: g1.version }).unchanged, true);
});

test('node detail has provenance, neighbors with origin, pressures and activation history', () => {
  const dir = tmp();
  const log = [{ type: 'heard', time: 1, speaker: 'Owner', userId: '111', text: 'hello' }, { type: 'tool-call', time: 2, tool: 'web_search', ok: true }, { type: 'heard', time: 3, speaker: 'Owner', userId: '111', text: 'again' }];
  const mind = createMind({ sources: fakeSources({ activityLog: () => ({ key: 'k', events: log }) }), dataDir: dir });
  const d = mind.node('person:111');
  assert.equal(d.node.provenance.source, 'memory.js contacts');
  assert.ok(d.neighbors.some((x) => x.node.id === 'concept:rex' && x.edge.origin.ref === 'L7'));
  assert.deepEqual(d.pressures.map((p) => p.bucket), ['bucket:loneliness']);
  assert.deepEqual(d.activations.list.map((a) => a.time), [3, 1]);
  assert.deepEqual(d.related.memories.map((m) => m.id), ['memory:5']);
  assert.ok(d.readOnly);
  assert.throws(() => mind.node('person:nobody'), (err) => err.status === 404 && /No node "person:nobody".*Open the mind view/.test(err.message));
});

test('live edits go through the owning setter with validation, and can be undone', () => {
  const dir = tmp();
  const src = fakeSources();
  const store = src.pressure().cfg;
  src.pressure = ((p) => () => ({ ...p, cfg: store }))(src.pressure());
  const mind = createMind({ sources: src, editors: { pressure: fakeEditor(store) }, dataDir: dir });
  const done = mind.edit('bucket:boredom', { path: 'buckets.boredom.threshold', value: 0.7 });
  assert.deepEqual([done.before, done.after], [0.65, 0.7]);
  assert.equal(store.buckets.boredom.threshold, 0.7);
  assert.equal(mind.node('bucket:boredom').editable.find((x) => x.path === 'buckets.boredom.threshold').value, 0.7, 'the inspector reads the new real value');
  // Invalid values are refused by the owning module, with what, why and how to fix.
  assert.throws(() => mind.edit('bucket:boredom', { path: 'buckets.boredom.threshold', value: 3 }), (err) => err.status === 400 && /between 0 and 1/.test(err.message));
  // Paths a node doesn't expose are refused with the ones it does.
  assert.throws(() => mind.edit('bucket:boredom', { path: 'tick_seconds', value: 1 }), (err) => /Use one of: buckets\.boredom\.threshold/.test(err.message));
  assert.throws(() => mind.edit('person:111', { path: 'tier', value: 1 }), (err) => /no editable values/.test(err.message));
  // Undo puts the value back and is recorded.
  assert.equal(mind.undoList()[0].undone, false);
  const undone = mind.undo();
  assert.equal(undone.value, 0.65);
  assert.equal(store.buckets.boredom.threshold, 0.65);
  assert.equal(mind.undoList()[0].undone, true);
  assert.throws(() => mind.undo(), (err) => err.status === 404 && /Nothing to undo/.test(err.message));
  // An edit whose value has changed since can't be undone blindly.
  mind.edit('bucket:boredom', { path: 'buckets.boredom.drain', value: 0.5 });
  store.buckets.boredom.drain = 0.9;
  assert.throws(() => mind.undo(), (err) => err.status === 409 && /changed since: it is 0\.9/.test(err.message));
  assert.ok(readFileSync(path.join(dir, FILES.edits), 'utf8').includes('"path":"buckets.boredom.drain"'));
});

test('the dashboard routes serve the graph, a node, history, edits, undo and mapped events', async () => {
  const dir = tmp();
  const src = fakeSources();
  const store = src.pressure().cfg;
  src.pressure = ((p) => () => ({ ...p, cfg: store }))(src.pressure());
  const bus = new EventEmitter();
  const mind = createMind({ sources: src, editors: { pressure: fakeEditor(store) }, dataDir: dir, events: { bus, recent: [{ type: 'tool-call', tool: 'web_search', time: 1 }] } });
  const routes = mindRoutes(async () => mind);
  const call = async (method, p, { body = {}, req, res } = {}) => {
    const url = new URL(`http://x${p}`);
    for (const [m, re, handler] of routes) {
      const match = m === method && decodeURIComponent(url.pathname).match(re);
      if (match) return handler({ url, params: match.groups ?? {}, body, req, res });
    }
    throw new Error(`no route ${method} ${p}`);
  };
  const full = await call('GET', '/api/mind/graph?level=nodes');
  assert.ok(full.nodes.length > 10 && full.edges.length > 5 && full.clusters.length);
  assert.ok(full.nodes.every((n) => n.pos.length === 3 && n.cluster));
  const zoomedOut = await call('GET', '/api/mind/graph?level=kinds');
  assert.equal(zoomedOut.nodes, undefined);
  assert.ok(zoomedOut.clusters.some((c) => c.id === 'cluster:memory'));
  const one = await call('GET', `/api/mind/graph?cluster=${encodeURIComponent('cluster:memory')}`);
  assert.ok(one.nodes.every((n) => n.kind === 'memory'));
  const detail = await call('GET', '/api/mind/node/bucket%3Aboredom');
  assert.equal(detail.node.id, 'bucket:boredom');
  await assert.rejects(call('PUT', '/api/mind/node/bucket:boredom/value', { body: {} }), /No value to change.*Send \{ "path"/);
  const edited = await call('PUT', '/api/mind/node/bucket:boredom/value', { body: { path: 'buckets.boredom.hysteresis', value: 0.3 } });
  assert.equal(edited.after, 0.3);
  assert.equal((await call('GET', '/api/mind/undo'))[0].path, 'buckets.boredom.hysteresis');
  assert.equal((await call('POST', '/api/mind/undo', { body: {} })).value, 0.25);
  assert.ok((await call('GET', '/api/mind/history')).entries.length > 0);
  // The event stream: replayed history and live events, each with the real nodes it touched.
  const written = [];
  const req = new EventEmitter();
  const res = { writeHead: () => {}, write: (s) => written.push(s) };
  await call('GET', '/api/mind/events', { req, res });
  bus.emit('activity', { type: 'pressure', fired: 'curiosity', time: 2 });
  req.emit('close');
  const sent = written.filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
  assert.deepEqual(sent[0].nodes, ['act:web_search']);
  assert.equal(sent[0].replay, true);
  assert.deepEqual(sent[1].nodes, ['bucket:curiosity']);
  assert.equal(bus.listenerCount('activity'), 0, 'the stream lets go when the page closes');
});

test("pressure.setConfigValue validates, applies to cfg, saves the config file and reports before/after", async () => {
  const pressure = await import('./pressure.js');
  const was = pressure.cfg.buckets.boredom.threshold;
  const r = pressure.setConfigValue('buckets.boredom.threshold', 0.71);
  assert.deepEqual(r, { path: 'buckets.boredom.threshold', before: was, after: 0.71 });
  assert.equal(pressure.cfg.buckets.boredom.threshold, 0.71);
  const saved = JSON.parse(readFileSync(path.join(process.env.CHAMP_DATA_DIR, 'pressure-config.json'), 'utf8'));
  assert.equal(saved.buckets.boredom.threshold, 0.71);
  assert.throws(() => pressure.setConfigValue('buckets.boredom.threshold', 2), /between 0 and 1, got 2/);
  assert.throws(() => pressure.setConfigValue('buckets.boredom.threshold', 'lots'), /must be a number/);
  assert.throws(() => pressure.setConfigValue('tick_seconds', 1), /isn't a live-editable pressure setting/);
  assert.throws(() => pressure.setConfigValue('buckets.nonesuch.threshold', 0.5), (err) => err.status === 404);
  assert.throws(() => pressure.setConfigValue('action_costs.workshop', 1), /holds a set of values/);
  assert.equal(pressure.setConfigValue('action_costs.workshop.job', '1.1').after, 1.1, 'a number typed into a form is accepted');
  assert.throws(() => pressure.setConfigValue('buckets.boredom.enabled', 'yes'), /true or false/);
  pressure.setConfigValue('buckets.boredom.threshold', was);
});
