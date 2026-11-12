import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, eventNodes, brainNodeId } from './cognitive-graph.js';

// Owner, 2026-11-11: the merged Amy "needs to have that dashboard with the Mind", fed by her own brain, keeping the
// mind network's design. Her brain is one more source of the same graph: things are nodes, facts are links.
const held = {
  self: 'Amy',
  things: [
    { key: 'e1', name: 'Amy', named: true, person: false, self: true },
    { key: 'e2', name: 'Owner', named: true, person: true, self: false, at: '2026-11-12 03:42:32' },
    { key: 'e3', name: 'Rex', named: true, person: false, self: false },
    { key: 'e4', name: 'friend_3', named: true, person: true, self: false },
    { key: 'c1', name: 'dog', named: false, person: false, self: false },
    { key: 'c2', name: 'animal', named: false, person: false, self: false },
  ],
  facts: [
    { id: 1, from: 'e3', to: 'c1', relation: 'is a', text: 'Rex is a dog', denied: false, confidence: 1, said_by: 'Owner', at: '2026-11-12 03:42:40' },
    { id: 2, from: 'c1', to: 'c2', relation: 'is a kind of', text: 'a dog is an animal', denied: false, confidence: 0.6, said_by: 'Owner', at: '2026-11-12 03:42:41' },
    { id: 3, from: 'e2', to: 'e3', relation: 'own', text: 'Owner owns Rex', denied: false, confidence: 1, said_by: 'Owner', at: '2026-11-12 03:42:42' },
    { id: 4, from: 'e4', to: null, relation: 'not: know', text: 'friend_3 does not know', denied: true, confidence: 1, said_by: 'friend_3', at: '2026-11-12 03:42:43' },
  ],
  rules: [{ id: 7, text: 'if someone owns a dog, they are a pet owner', confidence: 1, status: 'active', terms: ['c1'] }],
};
const sources = { selfName: () => 'Amy', contacts: () => [{ user_id: '550', name: 'Owner' }], brain: () => held };

test('what her brain holds becomes the mind network: things are nodes, facts are links that say who told her', () => {
  const g = assemble(sources);
  const node = (id) => g.nodes.find((n) => n.id === id);
  const edge = (from, to) => g.edges.find((e) => e.from === from && e.to === to);
  assert.equal(node('concept:brain:e3').label, 'Rex');
  assert.equal(node('concept:brain:c1').label, 'dog');
  assert.ok(node('person:self'), 'she is herself, not a second node');
  assert.ok(!node('person:brain:e2'), 'Owner is the Discord contact she already knows, not a second Owner');
  assert.equal(node('person:brain:e4').kind, 'person', 'someone with no Discord contact is still a person');
  const isA = edge('concept:brain:e3', 'concept:brain:c1');
  assert.equal(isA.type, 'is a');
  assert.equal(isA.origin.by, 'Owner');
  assert.match(isA.origin.ref, /fact 1: Rex is a dog/);
  assert.equal(edge('concept:brain:c1', 'concept:brain:c2').strength, 0.6, 'a hedged fact is a weaker link');
  assert.equal(edge('person:550', 'concept:brain:e3').type, 'own');
  // A fact about one thing alone has nothing to link to: it hangs on that thing as a memory.
  assert.equal(node('memory:brain:4').label, 'friend_3 does not know');
  assert.equal(edge('memory:brain:4', 'person:brain:e4').type, 'about');
  // A rule she learned is an insight tied to what it is about.
  assert.equal(node('insight:brain:rule:7').kind, 'insight');
  assert.ok(edge('insight:brain:rule:7', 'concept:brain:c1'));
});

test('with a language model in use there is no brain source and the graph is built as before', () => {
  const g = assemble({ ...sources, brain: () => null });
  assert.ok(!g.nodes.some((n) => n.id.includes(':brain:')));
  assert.ok(!g.unavailable.some((u) => /brain/.test(u.source)));
});

test('a brain that cannot report is listed as unavailable with the reason, not shown as an empty mind', () => {
  const g = assemble({ ...sources, brain: () => { throw new Error("her brain couldn't report what it holds: The brain stopped (exit code 1)"); } });
  assert.match(g.unavailable.find((u) => /brain/.test(u.source)).error, /The brain stopped/);
});

test('a turn lights up exactly the nodes it touched', () => {
  const g = assemble(sources);
  const graph = { byId: new Map(g.nodes.map((n) => [n.id, n])) };
  const contactByName = new Map([['owner', 'person:550']]);
  const touched = ['e3', 'c1'].map((key) => brainNodeId(held.things.find((t) => t.key === key), contactByName));
  const lit = eventNodes({ type: 'brain', nodes: ['person:550', 'person:self', ...touched] }, graph);
  assert.deepEqual(lit.nodes.sort(), ['concept:brain:c1', 'concept:brain:e3', 'person:550', 'person:self']);
  assert.deepEqual(lit.unknown, []);
});
