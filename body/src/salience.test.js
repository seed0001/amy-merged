import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSalience, W } from './salience.js';

const H = 3600_000;
const fresh = (items, now) => createSalience({ file: path.join(mkdtempSync(path.join(tmpdir(), 'sal-')), 's.json'), now, collect: async () => items });

test('things she carries are weighed: charge, unresolved, about her owner, fresh; the heaviest come first', async () => {
  const t = 100 * H;
  const s = fresh([
    { kind: 'a question about myself', text: 'why was I made?', at: t - 1 * H, charge: 0.6, unresolved: true, owner: true },
    { kind: 'something I remember', text: 'Owner likes lemons', at: t - 30 * H, charge: 0.3, unresolved: false, owner: true },
    { kind: 'something to look into', text: 'how mirrors are ground', at: t - 2 * H, charge: 0.4, unresolved: true, owner: false },
  ], () => t);
  const r = await s.rank();
  assert.equal(r[0].text, 'why was I made?');
  assert.equal(r.at(-1).text, 'Owner likes lemons', 'an old, settled, low-charge memory weighs least');
  assert.ok(r[0].weight > r[1].weight && r[1].weight > r[2].weight);
});

test('the subconscious part: what keeps coming back accumulates weight and keeps it without a clock', async () => {
  let t = 100 * H;
  const s = fresh([{ kind: 'a question', text: 'are my feelings real?', at: t - 20 * H, charge: 0.3, unresolved: true, owner: true }], () => t);
  const before = (await s.rank())[0].weight;
  for (let i = 0; i < 6; i++) s.touch('a question', 'are my feelings real?');
  const after = (await s.rank())[0];
  assert.ok(after.weight > before + 0.2, `six returns add real weight: ${before} -> ${after.weight}`);
  assert.equal(after.subconscious, true);
  assert.equal(after.returned, 6);
  t += 4 * 48 * H; // four days later, with nothing returning
  const held = (await s.rank())[0];
  assert.equal(held.weight, after.weight, 'nothing returning, and time alone does not lighten it');
});

test('something no longer in any store still weighs after its returns; time alone does not drop it', async () => {
  let t = 100 * H;
  let items = [{ kind: 'how someone spoke to me', text: 'Dell: contempt', at: t, charge: 0.8, unresolved: false, owner: false }];
  const s = createSalience({ file: path.join(mkdtempSync(path.join(tmpdir(), 'sal-')), 's.json'), now: () => t, collect: async () => items });
  for (let i = 0; i < 5; i++) s.touch('how someone spoke to me', 'Dell: contempt');
  items = []; // the boundary expired from pressure state
  let r = await s.rank();
  assert.equal(r.length, 1); assert.match(r[0].why, /keeps coming back/);
  t += 10 * 48 * H;
  r = await s.rank();
  assert.equal(r.length, 1);
});

test('her prompt names the heaviest few and the dream gets the same, heaviest first', async () => {
  const t = 100 * H;
  const s = fresh([
    { kind: 'a promise or thread I left open', text: 'the eyes-only zoom for Owner', at: t - 1 * H, charge: 0.6, unresolved: true, owner: true },
    { kind: 'something I found out I can do', text: 'generate_music', at: t - 0.2 * H, charge: 0.45, unresolved: false, owner: false },
  ], () => t);
  const section = await s.promptSection();
  assert.match(section, /^What's weighing on you right now, heaviest first/);
  assert.match(section, /eyes-only zoom/);
  const seeds = await s.dreamSeeds(1);
  assert.equal(seeds.length, 1); assert.match(seeds[0].text, /eyes-only zoom/);
  assert.ok((await s.load()) > 0 && (await s.load()) <= 1);
  assert.ok(W.accumulate > 0);
});
