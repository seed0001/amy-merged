import test from 'node:test';
import assert from 'node:assert/strict';
import { createListener } from './listen.js';

const setup = (reply) => {
  const asked = [], noticed = [], shown = [], logged = [];
  const listener = createListener({
    batch: 3,
    waitMs: 60_000,
    self: () => 'Amy',
    ask: async (messages) => { asked.push(messages); return typeof reply === 'function' ? reply(messages) : reply; },
    notice: async (items) => { noticed.push(...items); },
    show: (event) => shown.push(event),
    log: (type, data) => logged.push({ type, ...data }),
  });
  return { listener, asked, noticed, shown, logged };
};

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a batch of heard lines goes to the local model once and its topics grow her interests', async () => {
  const { listener, asked, noticed, shown } = setup({ topics: [{ name: 'telescope mirrors', person: 'Owner' }] });
  listener.hear({ speaker: 'Owner', text: 'did you see the telescope mirror video' });
  listener.hear({ speaker: 'friend_3', text: 'the mirror supports are wild honestly' });
  listener.hear({ speaker: 'friend_3', text: 'that cooling system is insane for a telescope' });
  await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0][1].content, /Owner: did you see/);
  assert.deepEqual(noticed.map((n) => n.name), ['telescope mirrors']);
  assert.equal(noticed[0].source, 'conversation');
  assert.equal(noticed[0].person, 'Owner');
  assert.deepEqual(shown.map((s) => s.phase), ['start', 'end']);
  assert.equal(shown[0].label, 'Listening to the chat');
});

test('her own lines and very short lines are never read', async () => {
  const { listener, asked } = setup({ topics: [] });
  listener.hear({ speaker: 'Amy', text: 'I think telescope mirrors are lovely' });
  listener.hear({ speaker: 'friend_3', text: 'ok' });
  assert.equal(listener.pending(), 0);
  await settle();
  assert.equal(asked.length, 0);
});

test('a reply that is not usable adds nothing and is logged cleanly', async () => {
  const { listener, noticed, logged } = setup(null);
  listener.hear({ speaker: 'Owner', text: 'something about birds and weather' });
  listener.hear({ speaker: 'Owner', text: 'and more about bird migration' });
  listener.hear({ speaker: 'Owner', text: 'and the weather again today' });
  await settle();
  assert.equal(noticed.length, 0);
  assert.ok(!logged.some((l) => l.type === 'error'));
});

test('a model failure is logged, and the bubble still closes', async () => {
  const { listener, logged, shown } = setup(() => { throw new Error('ollama down'); });
  listener.hear({ speaker: 'Owner', text: 'a long line about something worth knowing' });
  listener.hear({ speaker: 'Owner', text: 'another line about the same thing' });
  listener.hear({ speaker: 'Owner', text: 'and a third line to fill the batch' });
  await settle();
  assert.ok(logged.some((l) => l.type === 'error' && /ollama down/.test(l.message)));
  assert.equal(shown.at(-1).phase, 'end');
});
