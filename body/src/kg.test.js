import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGraph } from './kg.js';

// Stand-in meaning: each word that matters is a direction, so lines sharing a subject point the same way.
const WORDS = ['rex', 'dog', 'pit', 'bull', 'lyra', 'game', 'making', 'katie', 'friend_2', 'dating', 'owns', 'jump'];
const embedder = async (texts) => texts.map((t) => WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)).concat([0.05]));
function makeGraph() {
  const clock = { t: Date.parse('2026-11-08T12:00:00') };
  const g = createGraph(new DatabaseSync(':memory:'), {
    embedder, now: () => clock.t, selfName: () => 'Amy',
    contacts: () => [{ id: '111', name: 'Owner', username: 'trav_b' }],
  });
  return { g, clock };
}

test('links connect a person to their things, tagged with who said it and where', async () => {
  const { g } = makeGraph();
  assert.deepEqual(await g.addLinks([{ from: '111', rel: 'owns', to: 'Rex', toType: 'pet', saidBy: 'Owner', place: '#general' }]), ['Owner owns Rex']);
  await g.addFacts([{ name: 'Rex', type: 'pet', text: 'Rex is a white pit bull', saidBy: 'Owner', place: '#general' }]);
  assert.deepEqual(await g.addLinks([{ from: 'Owner', rel: 'owns', to: 'rex', saidBy: 'Owner' }]), [], 'the same link again counts up, by name or by id');
  const rex = g.about('Rex');
  assert.equal(rex.type, 'pet');
  assert.equal(rex.links[0].text, 'Owner owns Rex');
  assert.match(rex.facts[0].from, /Owner told you in #general, Nov 8/);
  const [line] = g.relevant((await embedder(['my dog rex']))[0], { ids: ['111'] });
  assert.match(line.line, /Rex/);
  assert.match(g.promptSection((await embedder(['is rex a pit bull']))[0], { ids: ['111'] }), /Rex is a white pit bull \(Owner told you in #general/);
});

test('people resolve by name, username or another name they go by, and her own name is herself', async () => {
  const { g } = makeGraph();
  assert.equal(g.resolve('owner'), '111');
  assert.equal(g.resolve('trav_b'), '111');
  assert.equal(g.resolve('Amy'), 'self');
  assert.equal(g.addAlias('111', 'Road Dog'), 'Road Dog');
  assert.equal(g.addAlias('111', 'Amy'), null, 'never her name');
  assert.equal(g.resolve('road dog'), '111');
  assert.match(g.promptSection(null, { ids: ['111'] }), /Owner also goes by Road Dog/);
});

test('dates that matter come up as they get close, with how old they turn', () => {
  const { g, clock } = makeGraph();
  assert.equal(g.addDate({ about: '111', what: 'birthday', date: '1990-11-10', saidBy: 'Owner', place: 'the voice call' }).date, 'November 10');
  assert.equal(g.addDate({ about: '111', what: 'birthday', date: '13-40' }), null, 'a date that isn\'t one is refused');
  const [soon] = g.upcoming(7);
  assert.equal(soon.inDays, 2);
  assert.equal(soon.turning, 36);
  assert.match(g.promptSection(null, { ids: ['111'] }), /Owner's birthday is in 2 days \(November 10, turning 36\)/);
  clock.t = Date.parse('2026-11-12T12:00:00');
  assert.equal(g.upcoming(7).length, 0, 'past it: next year');
});

test('forgetting says what went, and refuses with the reason when nothing matches', async () => {
  const { g } = makeGraph();
  await g.addLinks([{ from: 'friend_2', fromType: 'person', rel: 'is dating', to: 'Katie', toType: 'person', saidBy: 'Owner' }]);
  await g.addFacts([{ name: 'Lyra', type: 'game', text: 'Lyra is the game Owner is making', saidBy: 'Owner' }]);
  const lyra = g.about('Lyra');
  assert.deepEqual(g.forget(String(lyra.facts[0].id)), [`fact ${lyra.facts[0].id}`]);
  assert.equal(g.about('Lyra'), null, 'a thing with nothing left on it is let go');
  assert.throws(() => g.forget('L999'), /no link L999/);
  assert.throws(() => g.forget('Owner'), /person you know/);
  assert.deepEqual(g.forget('Katie'), ['Katie', 'friend_2 is dating Katie']);
  assert.equal(g.stats().links, 0);
});
