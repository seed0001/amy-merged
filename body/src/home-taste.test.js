import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHomeTaste, STARTING_HOME, AREAS } from './home-taste.js';

const fresh = (opts = {}) => createHomeTaste({ file: path.join(mkdtempSync(path.join(tmpdir(), 'home-')), 'h.json'), name: () => 'Amy', ...opts });

test('she starts with opinions about her place and can change any area or ask for things', () => {
  const h = fresh();
  for (const a of AREAS) assert.equal(h.get().taste[a], STARTING_HOME[a]);
  h.set('palette', 'Deep berry red walls in the bedroom, the rest warm white.');
  assert.throws(() => h.set('roof', 'tin'), /isn't one of your home areas/);
  h.want('a dog bed for Chance by the sofa');
  h.want('a dog bed for Chance by the sofa'); // same ask once
  assert.deepEqual(h.wants(), ['a dog bed for Chance by the sofa']);
  assert.match(h.briefFor(), /berry red walls/);
  assert.match(h.briefFor(), /asked for specifically:\n- a dog bed/);
  assert.match(h.promptSection(), /say it like you'd tell a builder/);
});

test('judging a delivery records her verdict by her taste and hands it to pressure', async () => {
  const verdicts = [];
  const h = fresh({ judge: async () => ({ verdict: 'dislike', why: "That blue-grey is exactly what I said I didn't want.", wants: ['warm white walls instead of the blue-grey', 'more plants by the window'] }), onVerdict: (v) => verdicts.push(v) });
  h.want('a reading chair facing the water');
  const v = await h.judge('Repainted the living room blue-grey and added a reading chair facing the water.');
  assert.equal(v.verdict, 'dislike');
  assert.equal(verdicts.length, 1);
  assert.deepEqual(h.wants(), ['warm white walls instead of the blue-grey', 'more plants by the window'], 'what she wants changed replaces the old asks');
  assert.match(h.briefFor(), /Her verdict on the last delivery: dislike/);
});

test('a model that fails or answers nonsense records no verdict at all: no invented feeling, nothing to pressure', async () => {
  const verdicts = [];
  const h = fresh({ judge: async () => { throw new Error('offline'); }, onVerdict: (v) => verdicts.push(v) });
  h.want('a reading chair');
  assert.equal(await h.judge('Built a deck.'), null);
  assert.deepEqual(verdicts, []);
  assert.deepEqual(h.wants(), ['a reading chair'], 'her asks stay as they were');
  const h2 = fresh({ judge: async () => ({ verdict: 'whatever' }) });
  assert.equal(await h2.judge('Built a deck.'), null);
});
