import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDreams } from './dreams.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'champ-dreams-'));
const scene = (i) => ({ narration: `I walk through room ${i}.`, picture: `An adult woman in room ${i}.` });
const director = (calls = []) => async (messages, { json } = {}) => {
  calls.push(messages.at(-1).content);
  if (!json) return 'She wandered through rooms.';
  if (/still on your mind/.test(messages.at(-1).content)) return JSON.stringify({ people: ['Owner'], places: ['the server'], feelings: ['hurt'], threads: ['the other Amy'], images: ['a beach house'] });
  return JSON.stringify({ scenes: [1, 2, 3, 4, 5].map(scene), feeling: 'uneasy' });
};
const day = async () => ({ kept: [], talk: [], mood: 'tired' });
const painter = (seen = []) => ({ paint: async ({ prompt, file }) => { seen.push(prompt); writeFileSync(file, 'png'); return { file, seconds: 1 }; }, stop() {} });
const setup = (over = {}) => createDreams({ root: tmp(), ask: director(), day, pictures: painter(), pause: async () => {}, minutesBetween: { rem: 0, light: 0, deep: 0, stirring: 0 }, ...over });

test('a night is one dream: residue first, then scenes with realistic HD pictures', async () => {
  const seen = [];
  const dreams = setup({ pictures: painter(seen) });
  const night = await dreams.dream({ maxScenes: 3 });
  assert.equal(night.scenes.length, 3);
  assert.deepEqual(night.residue.people, ['Owner']);
  assert.equal(night.scenes[0].image, 'scene-001.png');
  assert.ok(existsSync(path.join(dreams.dirOf(night.id), 'scene-003.png')));
  assert.match(seen[0], /photorealistic/i);
  assert.doesNotMatch(seen[0], /comic/i);
});

test('the director carries the dream on from where it left off, and sums up as it goes', async () => {
  const calls = [];
  const dreams = setup({ ask: director(calls) });
  const night = await dreams.dream({ maxScenes: 12 });
  const writes = calls.filter((c) => /Write the next/.test(c));
  assert.match(writes[1], /most recent scenes/);
  assert.ok(night.summary, 'ten scenes in, the night is summarized');
  assert.match(writes[2], /The dream so far: She wandered/);
});

test('dreams stay in her own life, at both the summing-up and the directing', async () => {
  const calls = [];
  await setup({ ask: director(calls) }).dream({ maxScenes: 1 });
  assert.match(calls.find((c) => /still on your mind/.test(c)), /Her real life is the Discord server/);
  assert.match(calls.find((c) => /Write the next/.test(c)), /Her real life is the Discord server/);
  assert.doesNotMatch(calls[0], /beach|dog/i);
});

test('every stage shapes the writing', async () => {
  const calls = [];
  await setup({ ask: director(calls) }).dream({ stage: () => 'deep', maxScenes: 1 });
  assert.match(calls.find((c) => /Write the next/.test(c)), /deep sleep: sparse and abstract/);
});

test('she stops the moment she wakes, and the unfinished scene is dropped', async () => {
  let awake = false;
  const dreams = setup({ pictures: { paint: async ({ file }) => { awake = true; return { file, seconds: 1 }; }, stop() {} } });
  const night = await dreams.dream({ asleep: () => !awake });
  assert.equal(night.scenes.length, 0);
  assert.ok(night.endedAt);
  assert.equal(dreams.dreaming(), false);
});

test('a scene still counts if the picture fails', async () => {
  const night = await setup({ pictures: { paint: async () => null, stop() {} } }).dream({ maxScenes: 1 });
  assert.equal(night.scenes.length, 1);
  assert.equal(night.scenes[0].image, undefined);
});

test('a restart mid-sleep continues the same night', async () => {
  const root = tmp();
  const first = await setup({ root }).dream({ maxScenes: 2, sleptAt: Date.now() });
  const second = await setup({ root }).dream({ maxScenes: 1, sleptAt: first.startedAt });
  assert.equal(second.id, first.id);
  assert.equal(second.scenes.length, 3);
});

test('waking from REM keeps the dream vivid; no dream means nothing to remember', async () => {
  const dreams = setup();
  assert.equal(dreams.wakeNote(Date.now()), '');
  const night = await dreams.dream({ maxScenes: 2 });
  assert.match(dreams.wakeNote(night.startedAt, { fromRem: true }), /middle of a dream.*I walk through room 2/s);
  assert.match(dreams.wakeNote(night.startedAt), /fading already/);
  assert.match(dreams.wakeNote(night.startedAt), /2 pictures/);
  assert.equal(dreams.wakeNote(night.startedAt + 3_600_000), '', 'an old dream is not last night\'s dream');
});

test('a director that returns junk costs a wait, not the night', async () => {
  let pauses = 0;
  const dreams = setup({ ask: async () => 'not json', pause: async () => { pauses++; if (pauses > 2) over = true; } });
  let over = false;
  const night = await dreams.dream({ asleep: () => !over });
  assert.equal(night.scenes.length, 0);
  assert.equal(pauses, 3);
});

test('old nights lose their pictures but keep their story', async () => {
  const root = tmp();
  for (let i = 0; i < 15; i++) {
    const d = path.join(root, `2026-10-${String(i + 1).padStart(2, '0')}`);
    mkdirSync(d);
    writeFileSync(path.join(d, 'night.json'), JSON.stringify({ id: path.basename(d), startedAt: 1, scenes: [] }));
    writeFileSync(path.join(d, 'scene-001.png'), 'png');
  }
  await setup({ root }).dream({ maxScenes: 1 });
  assert.equal(existsSync(path.join(root, '2026-10-01', 'scene-001.png')), false);
  assert.ok(existsSync(path.join(root, '2026-10-01', 'night.json')));
  assert.ok(existsSync(path.join(root, '2026-10-15', 'scene-001.png')));
});
