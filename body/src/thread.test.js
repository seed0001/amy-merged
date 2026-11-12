import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createThreads } from './thread.js';
import { createInterests } from './interests.js';

// Stand-in meaning: lines about the same subject share a direction; each new line also carries its
// own direction (new information), while a line said "again" carries none (nothing new).
const SUBJECTS = ['engine', 'dog', 'weather'];
let n = 0;
const embedder = async (texts) => texts.map((t) => {
  const s = SUBJECTS.find((x) => t.includes(x)) ?? 'weather';
  const own = Array(32).fill(0);
  if (!t.includes('again')) own[n++ % 32] = 0.8;
  return SUBJECTS.map((x) => (x === s ? 1 : 0)).concat(own);
});

test('a real back-and-forth on one subject builds momentum; repeating itself satisfies it; moving on lets go', async () => {
  const clock = { t: 0 };
  const th = createThreads({ embedder, now: () => clock.t });
  const say = (name, text) => { clock.t += 20_000; return th.update({ conversation: 'c', name, text }); };
  await say('Owner', 'the new engine runs the game world');
  await say('friend_3', 'the engine handles lighting really well');
  await say('Amy', 'how does the engine do the shadows though');
  await say('Owner', 'the engine bakes them at night');
  await say('friend_3', 'the engine streaming is impressive too');
  assert.ok(th.momentum('c') > 0.4, `momentum ${th.momentum('c')}`);
  assert.match(th.promptSection('c'), /stay on this topic/);
  for (let i = 0; i < 10; i++) await say('Owner', 'the engine is good again');
  assert.equal(th.satisfied('c'), true, 'saying the same things again satisfies it');
  await say('friend_3', 'my dog ate my shoe'); await say('Owner', 'the dog is wild');
  assert.equal(th.current('c').turns, 1, 'the talk moved on: a new thread');
});

test('her interests grow from people close to her, deepen from reading, and hold without a clock', async () => {
  const clock = { t: Date.parse('2026-11-08T12:00:00Z') };
  const it = createInterests({ file: path.join(mkdtempSync(path.join(os.tmpdir(), 'int-')), 'i.json'), embedder: async (texts) => texts.map((t) => SUBJECTS.map((x) => (t.includes(x) ? 1 : 0)).concat([0.01])), now: () => clock.t });
  await it.notice([{ name: 'weather on the dog walk', source: 'reading' }]);
  assert.equal(it.top().length, 0, 'reading alone never starts an interest');
  await it.notice([{ name: 'the game engine', source: 'conversation', person: 'Owner', bond: 0.8 }]);
  await it.notice([{ name: 'engine rendering', source: 'reading' }]);
  const [top] = it.top();
  assert.equal(top.name, 'the game engine');
  assert.match(top.why, /came up in conversation with Owner; you read about it/);
  const before = top.interest;
  clock.t += 14 * 86_400_000;
  assert.equal(it.top()[0]?.interest, before, 'two weeks untouched: it keeps its weight');
});
