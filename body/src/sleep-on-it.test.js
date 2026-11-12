import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSleepOnIt } from './sleep-on-it.js';

const WORDS = ['pineapple', 'pizza', 'lyra', 'game'];
const embedder = async (texts) => texts.map((t) => WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)).concat([0.05]));
const lines = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', name: i % 2 ? null : 'Owner', content: `line ${from + i}`, created_at: from + i }));

function make({ judgment, msgs, stranger = false }) {
  const kept = [];
  let asked = 0;
  const mind = createSleepOnIt({
    file: path.join(mkdtempSync(path.join(os.tmpdir(), 'soi-')), 's.json'),
    judge: async () => { asked++; return typeof judgment === 'function' ? judgment(asked) : judgment; },
    embedder, name: () => 'Amy', now: () => 1000,
    messages: (since) => msgs.filter((m) => m.created_at >= since),
    resolve: (n) => ({ owner: '111', friend_3: '222' }[String(n).toLowerCase()] ?? null),
    canRemember: (id) => !(stranger && id === '222'),
    keepShared: async (x) => kept.push(x),
  });
  return { mind, kept, asked: () => asked };
}

test('falling asleep, she keeps shared moments, how people treat her and her opinions', async () => {
  const { mind, kept } = make({ msgs: lines(10), judgment: {
    shared: [{ person: 'Owner', kind: 'joke', text: 'the pineapple pizza feud' }],
    treats_me: [{ person: 'Owner', text: 'teases her but always has her back' }],
    opinions: [{ topic: 'pineapple pizza', stance: 'it is a crime' }],
  } });
  const done = await mind.fellAsleep();
  assert.deepEqual(done, { lines: 10, shared: 1, treats: 1, opinions: 1 });
  assert.equal(kept[0].kind, 'inside joke');
  const section = mind.promptSection((await embedder(['want pineapple pizza?']))[0], { ids: ['111'] });
  assert.match(section, /How Owner treats you: teases her/);
  assert.match(section, /You think pineapple pizza: it is a crime/);
});

test('a changed mind keeps what she used to think; the same stance again changes nothing', async () => {
  const { mind } = make({ msgs: [], judgment: {} });
  assert.equal(await mind.holdOpinion('pineapple pizza', 'it is a crime'), true);
  assert.equal(await mind.holdOpinion('Pineapple pizza', 'it is a crime'), false);
  assert.equal(await mind.holdOpinion('pineapple pizza', 'honestly it grew on me'), true);
  const [o] = mind.opinions();
  assert.equal(o.stance, 'honestly it grew on me');
  assert.equal(o.previous[0].stance, 'it is a crime');
});

test('woken partway, she stops and picks up from there the next night; strangers are not kept', async () => {
  const msgs = lines(130);
  let awake = false;
  const { mind, asked } = make({ msgs, stranger: true, judgment: (n) => { if (n === 1) awake = true; return { shared: [{ person: 'friend_3', kind: 'moment', text: 'something' }], treats_me: [], opinions: [] }; } });
  const first = await mind.fellAsleep({ asleep: () => !awake });
  assert.equal(first.lines, 60, 'one stretch, then woken');
  assert.equal(first.shared, 0, 'a stranger is not remembered');
  awake = false;
  const second = await mind.fellAsleep({ asleep: () => true });
  assert.equal(second.lines, 70, 'the rest, not the first stretch again');
  assert.equal(asked(), 3);
});

test('a model that gives nothing back fails with the reason', async () => {
  const { mind } = make({ msgs: lines(4), judgment: null });
  await assert.rejects(mind.fellAsleep(), /gave nothing back/);
});
