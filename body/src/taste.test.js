import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaste, STARTING_TASTE } from './taste.js';

const dir = () => mkdtempSync(path.join(os.tmpdir(), 'taste-'));
// A stand-in for her local model: returns whatever judgment the test gives it, and records the prompt.
function makeTaste(judgment, extra = {}) {
  const d = dir(), seen = [];
  const clock = { t: Date.parse('2026-11-08T12:00:00Z') };
  const t = createTaste({
    file: path.join(d, 'taste.json'), log: path.join(d, 'log.jsonl'),
    judge: async (messages) => { seen.push(messages.at(-1).content); return typeof judgment === 'function' ? judgment() : judgment; },
    embedder: async (texts) => texts.map(() => [1, 0, 0]), name: () => 'Amy', now: () => clock.t, random: () => 0, ...extra,
  });
  return { t, seen, clock, d };
}

test('what she finds funny is judged against her own taste, and a laugh plays and is kept', async () => {
  const { t, seen, d } = makeTaste({ funny: 8, moving: 0, frustrating: 0, to_her: false, sad: false, why: 'deadpan gold' });
  const played = [];
  const r = await t.hear({ speaker: 'Owner', text: 'I taught the toaster to file my taxes', bond: 0.8, play: (...a) => played.push(a) });
  assert.match(seen[0], /dry sarcasm and deadpan delivery/, 'her taste is in the judgment');
  assert.equal(r.family, 'laugh');
  assert.equal(played.length, 1);
  assert.equal(played[0][1], 'laugh');
  const [kept] = readFileSync(path.join(d, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(kept.speaker, 'Owner');
  assert.equal(kept.why, 'deadpan gold');
  assert.match(t.promptSection(), /What got to you lately[\s\S]*Owner/);
});

test('nothing that lands low is shown, and someone she is wary of gets no laugh', async () => {
  const flat = makeTaste({ funny: 2, moving: 1, frustrating: 0, to_her: false, sad: false, why: '' });
  const played = [];
  assert.equal((await flat.t.hear({ speaker: 'friend_3', text: 'what time is it there', play: () => played.push(1) })).style, null);
  const wary = makeTaste({ funny: 9, moving: 0, frustrating: 0, to_her: false, sad: false, why: '' });
  assert.equal((await wary.t.hear({ speaker: 'Troll', text: 'here is a great joke for you', wary: true, play: () => played.push(1) })).style, null);
  assert.equal(played.length, 0);
});

test('someone else\'s pain gets sympathy, her own hurt gets tears, a dig at her is never funny', () => {
  const { t } = makeTaste({});
  assert.equal(t.weigh({ funny: 0, moving: 8, frustrating: 0, toHer: false, sad: true }).family, 'sympathy');
  assert.equal(t.weigh({ funny: 0, moving: 8, frustrating: 0, toHer: true, sad: true }, { addressed: true }).family, 'cry');
  const dig = t.weigh({ funny: 9, moving: 0, frustrating: 6, toHer: true, sad: false }, { addressed: true });
  assert.equal(dig.family, 'frustrated');
  assert.equal(t.weigh({ funny: 0, moving: 0, frustrating: 9, toHer: false, sad: false }).score, 0, 'other people\'s frustration is not hers');
});

test('the same bit lands less the second time, and one line never becomes a laugh track', async () => {
  const { t, clock } = makeTaste({ funny: 6, moving: 0, frustrating: 0, to_her: false, sad: false, why: '' });
  const played = [];
  const first = await t.hear({ speaker: 'Owner', text: 'the cat is the project manager now', play: () => played.push(1) });
  const soon = await t.hear({ speaker: 'Owner', text: 'the cat is the project manager now', play: () => played.push(1) });
  assert.ok(first.style && !soon.style, 'a second laugh within seconds does not play');
  clock.t += 60_000;
  const later = await t.hear({ speaker: 'Owner', text: 'the cat is the project manager now', play: () => played.push(1) });
  assert.ok(later.score < first.score, 'heard before: it lands softer');
  assert.equal(played.length, 1, 'softer than worth showing');
});

test('her taste is hers to change, and a wrong list says what the lists are', () => {
  const { t, d } = makeTaste({});
  t.add('funny.loves', 'Owner losing to his own game');
  assert.ok(t.get().funny.loves.includes('Owner losing to his own game'));
  t.add('funny.not', 'Owner losing to his own game');
  assert.ok(!t.get().funny.loves.includes('Owner losing to his own game'), 'one place only');
  assert.ok(existsSync(path.join(d, 'taste.json')));
  assert.throws(() => t.add('funny.adores', 'x y z'), /Use one of: funny\.loves/);
  assert.throws(() => t.remove('moving.deeply', 'nothing like this'), /isn't in moving\.deeply/);
  assert.equal(STARTING_TASTE.funny.not.includes('Owner losing to his own game'), false, 'the starting taste is untouched');
});

test('a model that returns nothing fails with the reason, not a fake judgment', async () => {
  const { t } = makeTaste(null);
  await assert.rejects(t.hear({ speaker: 'Owner', text: 'this should be judged' }), /gave no judgment/);
});
