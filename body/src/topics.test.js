import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTopics, CLOSE_AFTER_MS } from './topics.js';

// A clock the test moves, and a classifier that answers from a script instead of a model.
function setup(answers) {
  let t = 1_000_000;
  const seen = [];
  const store = createTopics(new DatabaseSync(':memory:'), {
    now: () => t,
    classify: async (input) => { seen.push(input); return answers.shift(); },
    summarize: async (name, rows) => `${name}: ${rows.length} line(s)`,
  });
  return { store, seen, tick: (ms) => { t += ms; } };
}
const say = (store, text) => store.tag({ conversation: 'voice:1', speaker: 'Owner', text, reply: 'ok' });

test('a new subject starts a bucket and follow-ups are tagged to it', async () => {
  const { store } = setup([{ kind: 'new', name: 'voice switching' }, { kind: 'existing', id: 1 }]);
  assert.deepEqual(await say(store, 'can you switch voices'), { id: 1, name: 'voice switching', action: 'created' });
  assert.deepEqual(await say(store, 'now the whisper one'), { id: 1, name: 'voice switching', action: 'continued' });
  assert.equal(store.get(1).line_count, 2);
  assert.deepEqual(store.lines(1).map((l) => l.text), ['can you switch voices', 'now the whisper one']);
});

test('small talk is not tagged', async () => {
  const { store } = setup([{ kind: 'none' }]);
  assert.equal(await say(store, 'good morning'), null);
  assert.equal(store.open('voice:1').length, 0);
});

test('a quiet bucket closes with a summary, and reopens with its history when it comes back', async () => {
  const { store, seen, tick } = setup([{ kind: 'new', name: 'topic buckets' }, { kind: 'new', name: 'image looks' }, { kind: 'existing', id: 1 }]);
  await say(store, 'lets track topics');
  tick(CLOSE_AFTER_MS + 1);
  await say(store, 'make me a picture');
  assert.equal(store.get(1).status, 'closed');
  assert.equal(store.get(1).summary, 'topic buckets: 1 line(s)');
  assert.deepEqual(seen[1].closed.map((c) => c.id), [1]); // the classifier is shown closed topics
  assert.deepEqual(await say(store, 'back to the topic buckets'), { id: 1, name: 'topic buckets', action: 'reopened' });
  assert.equal(store.get(1).status, 'open');
  assert.equal(store.get(1).line_count, 2);
});

test('topics that come up together are linked, and the link grows', async () => {
  const { store } = setup([
    { kind: 'new', name: 'voice switching' }, { kind: 'new', name: 'fish audio ids' },
    { kind: 'existing', id: 1 }, { kind: 'existing', id: 2 },
  ]);
  for (const text of ['switch voices', 'paste the fish ids', 'whisper now', 'the ids again']) await say(store, text);
  const rel = store.related(1);
  assert.equal(rel[0].name, 'fish audio ids');
  assert.ok(rel[0].link_count >= 2);
  assert.match(store.promptBlock('voice:1'), /voice switching.*Often comes up with: fish audio ids/);
});

test('naming an existing topic again reuses it instead of making a duplicate', async () => {
  const { store } = setup([{ kind: 'new', name: 'Topic Buckets' }, { kind: 'new', name: 'topic buckets' }]);
  await say(store, 'a');
  assert.equal((await say(store, 'b')).id, 1);
  assert.equal(store.search('bucket').length, 1);
});
